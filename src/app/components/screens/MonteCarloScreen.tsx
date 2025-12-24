import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type MonteCarloRun = {
  id: string;
  created_at: string;
  sport_key: string;
};

type MonteCarloResultRow = {
  run_id: string;
  event_id: string;
  commence_time: string | null;

  home_team: string | null;
  away_team: string | null;

  projected_margin_home: number | null;
  projected_total: number | null;

  projected_home_points?: number | null;
  projected_away_points?: number | null;

  home_win_prob: number | null;
  away_win_prob: number | null;

  spread_line_home: number | null;
  home_cover_prob: number | null;
  away_cover_prob: number | null;

  total_line: number | null;
  over_prob: number | null;
  under_prob: number | null;
};

type TeamMapLogoRow = {
  canonical: string;
  "Logo URL": string | null;
};

// Odds snapshot (assumes you have odds + line per side)
type OddsSnapshotRow = {
  ts: string;
  event_id: string;
  market: string; // "spreads" | "totals" | ...
  side: string | null; // "home"/"away" or "over"/"under"
  line: number | null; // spread or total line
  odds: number | null; // american odds
  bookmaker: string | null;
};

type Consensus = {
  // spreads
  spread_home_line: number | null; // e.g. -5.5
  spread_home_odds: number | null; // e.g. -110
  spread_away_odds: number | null; // e.g. -110

  // totals
  total_line: number | null; // e.g. 151.5
  total_over_odds: number | null;
  total_under_odds: number | null;

  ts: string | null;
};

type TeamRow = {
  key: string;
  eventId: string;

  commenceTime: string | null;

  side: "AWAY" | "HOME";
  teamName: string;
  opponentName: string;

  logoUrl: string | null;

  projPoints: number;
  // team-view margin
  projMargin: number;
  coverProbTeam: number | null;

  // game-view total
  projTotal: number;
  overProb: number | null;
  underProb: number | null;

  // consensus (team-view)
  consSpreadLineTeam: number | null;
  consSpreadOddsTeam: number | null;

  // consensus total (game-view)
  consTotalLine: number | null;
  consTotalOverOdds: number | null;
  consTotalUnderOdds: number | null;

  // for winner highlighting
  isProjectedWinner: boolean;
};

const SIDE_ALIASES = {
  home: new Set(["home", "h", "team1", "t1"]),
  away: new Set(["away", "a", "team2", "t2"]),
  over: new Set(["over", "o"]),
  under: new Set(["under", "u"]),
};

function normalizeSide(raw: string | null): "home" | "away" | "over" | "under" | null {
  const s = (raw ?? "").toString().trim().toLowerCase();
  if (!s) return null;
  if (SIDE_ALIASES.home.has(s)) return "home";
  if (SIDE_ALIASES.away.has(s)) return "away";
  if (SIDE_ALIASES.over.has(s)) return "over";
  if (SIDE_ALIASES.under.has(s)) return "under";
  return null;
}

export function MonteCarloScreen() {
  const [run, setRun] = useState<MonteCarloRun | null>(null);
  const [results, setResults] = useState<MonteCarloResultRow[]>([]);
  const [logoMap, setLogoMap] = useState<Map<string, string>>(new Map());
  const [consensusMap, setConsensusMap] = useState<Map<string, Consensus>>(new Map());

  const [loadingRun, setLoadingRun] = useState(true);
  const [loadingResults, setLoadingResults] = useState(false);
  const [loadingConsensus, setLoadingConsensus] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // 0) logos
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase.from("team_map").select('canonical,"Logo URL"');
      if (!alive) return;

      if (error) {
        console.warn("[MonteCarloScreen] team_map logos failed:", error.message);
        setLogoMap(new Map());
        return;
      }

      const m = new Map<string, string>();
      for (const r of (data ?? []) as TeamMapLogoRow[]) {
        const canon = (r.canonical ?? "").trim();
        const url = (r["Logo URL"] ?? "").trim();
        if (canon && url) m.set(canon, url);
      }
      setLogoMap(m);
    })();

    return () => {
      alive = false;
    };
  }, []);

  // 1) latest run
  useEffect(() => {
    let alive = true;

    (async () => {
      setLoadingRun(true);
      setError(null);

      const { data, error } = await supabase
        .from("monte_carlo_runs")
        .select("id, created_at, sport_key")
        .order("created_at", { ascending: false })
        .limit(1);

      if (!alive) return;

      if (error) {
        setError(error.message);
        setRun(null);
        setResults([]);
        setConsensusMap(new Map());
        setLoadingRun(false);
        return;
      }

      setRun((data?.[0] ?? null) as MonteCarloRun | null);
      setLoadingRun(false);
    })();

    return () => {
      alive = false;
    };
  }, []);

  // 2) run results
  useEffect(() => {
    let alive = true;

    async function loadResults(runId: string) {
      setLoadingResults(true);
      setError(null);

      const selectCols = [
        "run_id",
        "event_id",
        "commence_time",
        "home_team",
        "away_team",
        "projected_margin_home",
        "projected_total",
        "projected_home_points",
        "projected_away_points",
        "home_win_prob",
        "away_win_prob",
        "spread_line_home",
        "home_cover_prob",
        "away_cover_prob",
        "total_line",
        "over_prob",
        "under_prob",
      ].join(",");

      const { data, error } = await supabase
        .from("monte_carlo_results")
        .select(selectCols)
        .eq("run_id", runId)
        .order("commence_time", { ascending: true });

      if (!alive) return;

      if (error) {
        setError(error.message);
        setResults([]);
        setConsensusMap(new Map());
        setLoadingResults(false);
        return;
      }

      setResults((data ?? []) as MonteCarloResultRow[]);
      setLoadingResults(false);
    }

    if (run?.id) loadResults(run.id);

    return () => {
      alive = false;
    };
  }, [run?.id]);

  // 3) consensus from odds_snapshot (spreads/totals)
  useEffect(() => {
    let alive = true;

    async function loadConsensus(eventIds: string[]) {
      if (!eventIds.length) {
        setConsensusMap(new Map());
        return;
      }

      setLoadingConsensus(true);

      const { data, error } = await supabase
        .from("odds_snapshot")
        .select("ts,event_id,market,side,line,odds,bookmaker")
        .in("event_id", eventIds)
        .in("market", ["spreads", "totals"])
        .order("ts", { ascending: false })
        .limit(8000);

      if (!alive) return;

      if (error) {
        console.warn("[MonteCarloScreen] odds_snapshot consensus failed:", error.message);
        setConsensusMap(new Map());
        setLoadingConsensus(false);
        return;
      }

      const rows = (data ?? []) as OddsSnapshotRow[];

      // take latest per (event, market, bookmaker, side)
      const seen = new Set<string>();
      const spreadHomeLines: Map<string, number[]> = new Map();
      const spreadHomeOdds: Map<string, number[]> = new Map();
      const spreadAwayOdds: Map<string, number[]> = new Map();

      const totalLines: Map<string, number[]> = new Map();
      const totalOverOdds: Map<string, number[]> = new Map();
      const totalUnderOdds: Map<string, number[]> = new Map();

      const bestTsByEvent: Map<string, string> = new Map();

      for (const r of rows) {
        const eventId = (r.event_id ?? "").trim();
        const market = (r.market ?? "").trim().toLowerCase();
        const book = (r.bookmaker ?? "").trim().toLowerCase() || "unknown";
        const side = normalizeSide(r.side);
        const line = numOrNullable(r.line);
        const odds = numOrNullable(r.odds);

        if (!eventId || !market || !side) continue;

        if (r.ts) {
          const prev = bestTsByEvent.get(eventId);
          if (!prev || new Date(r.ts).getTime() > new Date(prev).getTime()) bestTsByEvent.set(eventId, r.ts);
        }

        const k = `${eventId}|${market}|${book}|${side}`;
        if (seen.has(k)) continue;
        seen.add(k);

        if (market === "spreads") {
          // store HOME line + HOME odds + AWAY odds
          if (side === "home") {
            if (line != null) pushMap(spreadHomeLines, eventId, line);
            if (odds != null) pushMap(spreadHomeOdds, eventId, odds);
          }
          if (side === "away") {
            if (odds != null) pushMap(spreadAwayOdds, eventId, odds);
          }
        } else if (market === "totals") {
          // store total line from OVER side (line is same for under)
          if (side === "over") {
            if (line != null) pushMap(totalLines, eventId, line);
            if (odds != null) pushMap(totalOverOdds, eventId, odds);
          }
          if (side === "under") {
            if (odds != null) pushMap(totalUnderOdds, eventId, odds);
          }
        }
      }

      const m = new Map<string, Consensus>();
      for (const eventId of eventIds) {
        m.set(eventId, {
          spread_home_line: medianOrNull(spreadHomeLines.get(eventId) ?? []),
          spread_home_odds: medianOrNull(spreadHomeOdds.get(eventId) ?? []),
          spread_away_odds: medianOrNull(spreadAwayOdds.get(eventId) ?? []),

          total_line: medianOrNull(totalLines.get(eventId) ?? []),
          total_over_odds: medianOrNull(totalOverOdds.get(eventId) ?? []),
          total_under_odds: medianOrNull(totalUnderOdds.get(eventId) ?? []),

          ts: bestTsByEvent.get(eventId) ?? null,
        });
      }

      setConsensusMap(m);
      setLoadingConsensus(false);
    }

    const ids = Array.from(new Set(results.map((r) => r.event_id).filter(Boolean)));
    if (ids.length) loadConsensus(ids);

    return () => {
      alive = false;
    };
  }, [results]);

  // 4) build 2 rows per event (away then home)
  const teamRows: TeamRow[] = useMemo(() => {
    const out: TeamRow[] = [];

    for (const r of results) {
      const home = (r.home_team ?? "").trim();
      const away = (r.away_team ?? "").trim();
      if (!home || !away) continue;

      const marginHome = numOr(r.projected_margin_home, 0);
      const totalProj = numOr(r.projected_total, 0);

      const homePtsStored = numOrNullable(r.projected_home_points);
      const awayPtsStored = numOrNullable(r.projected_away_points);

      const homePts = homePtsStored ?? safeRound1((totalProj + marginHome) / 2);
      const awayPts = awayPtsStored ?? safeRound1((totalProj - marginHome) / 2);

      const pHomeCover = numOrNullable(r.home_cover_prob);
      const pAwayCover = numOrNullable(r.away_cover_prob);

      const pOver = numOrNullable(r.over_prob);
      const pUnder = numOrNullable(r.under_prob);

      const c = consensusMap.get(r.event_id) ?? null;
      const consSpreadHome = numOrNullable(c?.spread_home_line);
      const consTotal = numOrNullable(c?.total_line);

      const awayIsWinner = awayPts > homePts;
      const homeIsWinner = homePts > awayPts;

      // AWAY row
      out.push({
        key: `${r.event_id}-AWAY`,
        eventId: r.event_id,
        commenceTime: r.commence_time ?? null,
        side: "AWAY",
        teamName: away,
        opponentName: home,
        logoUrl: logoMap.get(away) ?? null,

        projPoints: awayPts,
        projMargin: -marginHome,
        coverProbTeam: pAwayCover,

        projTotal: totalProj,
        overProb: pOver,
        underProb: pUnder,

        consSpreadLineTeam: consSpreadHome == null ? null : -consSpreadHome,
        consSpreadOddsTeam: numOrNullable(c?.spread_away_odds),

        consTotalLine: consTotal,
        consTotalOverOdds: numOrNullable(c?.total_over_odds),
        consTotalUnderOdds: numOrNullable(c?.total_under_odds),

        isProjectedWinner: awayIsWinner,
      });

      // HOME row
      out.push({
        key: `${r.event_id}-HOME`,
        eventId: r.event_id,
        commenceTime: r.commence_time ?? null,
        side: "HOME",
        teamName: home,
        opponentName: away,
        logoUrl: logoMap.get(home) ?? null,

        projPoints: homePts,
        projMargin: marginHome,
        coverProbTeam: pHomeCover,

        projTotal: totalProj,
        overProb: pOver,
        underProb: pUnder,

        consSpreadLineTeam: consSpreadHome,
        consSpreadOddsTeam: numOrNullable(c?.spread_home_odds),

        consTotalLine: consTotal,
        consTotalOverOdds: numOrNullable(c?.total_over_odds),
        consTotalUnderOdds: numOrNullable(c?.total_under_odds),

        isProjectedWinner: homeIsWinner,
      });
    }

    return out;
  }, [results, logoMap, consensusMap]);

  const loading = loadingRun || loadingResults;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl text-white mb-1">Monte Carlo</h2>
        <p className="text-xs text-[#808080]">
          Latest simulation snapshot
          {run?.created_at ? <span className="ml-2 text-[#5a5a5a]">· Latest run: {formatTs(run.created_at)}</span> : null}
          {loadingConsensus ? <span className="ml-2 text-[#5a5a5a]">· Loading consensus…</span> : null}
        </p>
      </div>

      {error ? (
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4 text-xs text-red-300">
          Supabase error: {error}
        </div>
      ) : null}

      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">
        <div className="max-h-[calc(100vh-220px)] overflow-y-auto overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-20">
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-30 min-w-[360px]">
                  Matchup
                </th>

                <th className="text-center p-3 text-[#d4af37] min-w-[120px]">
                  Proj Score
                </th>

                <th className="text-center p-3 text-[#d4af37] min-w-[150px]">
                  Proj Margin (Cover %)
                </th>

                <th className="text-center p-3 text-[#d4af37] min-w-[170px]">
                  Proj Total (O/U %)
                </th>

                <th className="text-center p-3 text-[#d4af37] min-w-[180px]">
                  Consensus Margin (Odds)
                </th>

                <th className="text-center p-3 text-[#d4af37] min-w-[200px]">
                  Consensus Total (Odds)
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#1a1a1a]">
              {loading ? (
                <tr>
                  <td className="p-3 text-[#b0b0b0] sticky left-0 bg-[#0f0f0f] z-10" colSpan={6}>
                    Loading Monte Carlo results…
                  </td>
                </tr>
              ) : teamRows.length === 0 ? (
                <tr>
                  <td className="p-3 text-[#b0b0b0] sticky left-0 bg-[#0f0f0f] z-10" colSpan={6}>
                    No Monte Carlo rows found for latest run.
                  </td>
                </tr>
              ) : (
                teamRows.map((row, idx) => {
                  const isAwayRow = idx % 2 === 0;

                  return (
                    <tr key={row.key} className="hover:bg-[#0f0f0f]/50 transition-colors">
                      {/* Matchup cell: time only on away row, teams per-row */}
                      <td className="p-3 text-white sticky left-0 bg-[#0f0f0f] z-10 align-top">
                        <div className="space-y-2">
                          {isAwayRow ? (
                            <div className="text-[11px] text-[#808080]">
                              {row.commenceTime ? formatStartStamp(row.commenceTime) : "TBD"}
                            </div>
                          ) : null}

                          <div className="flex items-center gap-3">
                            {row.logoUrl ? (
                              <img
                                src={row.logoUrl}
                                onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                                alt={row.teamName}
                                className="w-8 h-8 object-contain"
                                style={{ filter: "drop-shadow(0 0 6px rgba(212,175,55,0.25))" }}
                              />
                            ) : (
                              <div className="w-8 h-8" />
                            )}

                            <div className="leading-tight">
                              <div className="text-sm font-bold text-white">
                                {row.teamName}
                                <span className="ml-2 text-[11px] font-semibold text-[#808080]">({row.side})</span>
                              </div>
                              <div className="text-[11px] text-[#808080]">vs {row.opponentName}</div>
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Proj Score (winner bold green) */}
                      <td className="text-center p-3 font-semibold">
                        <span className={row.isProjectedWinner ? "text-green-400 font-extrabold" : "text-white"}>
                          {row.projPoints.toFixed(1)}
                        </span>
                      </td>

                      {/* Proj Margin (Cover %) */}
                      <td className="text-center p-3 text-white font-semibold">
                        <div className="leading-tight">
                          <div>
                            {row.projMargin > 0 ? "+" : ""}
                            {row.projMargin.toFixed(1)}
                            <span className="text-[#808080] font-semibold">
                              {" "}
                              (
                              {row.coverProbTeam == null ? "—" : `${(row.coverProbTeam * 100).toFixed(0)}%`}
                              )
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Proj Total (O% / U%) */}
                      <td className="text-center p-3 text-white font-semibold">
                        <div className="leading-tight">
                          <div>
                            {row.projTotal.toFixed(1)}
                            <span className="text-[#808080] font-semibold">
                              {" "}
                              (
                              O {row.overProb == null ? "—" : `${(row.overProb * 100).toFixed(0)}%`}
                              {" · "}
                              U {row.underProb == null ? "—" : `${(row.underProb * 100).toFixed(0)}%`}
                              )
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Consensus Margin (Odds) */}
                      <td className="text-center p-3 text-white font-semibold">
                        {row.consSpreadLineTeam == null ? (
                          <span className="text-[#3a3a3a]">—</span>
                        ) : (
                          <>
                            {row.consSpreadLineTeam > 0 ? "+" : ""}
                            {row.consSpreadLineTeam.toFixed(1)}
                            <span className="text-[#808080] font-semibold">
                              {" "}
                              (
                              {row.consSpreadOddsTeam == null ? "—" : formatAmerican(row.consSpreadOddsTeam)}
                              )
                            </span>
                          </>
                        )}
                      </td>

                      {/* Consensus Total (Odds) */}
                      <td className="text-center p-3 text-white font-semibold">
                        {row.consTotalLine == null ? (
                          <span className="text-[#3a3a3a]">—</span>
                        ) : (
                          <>
                            {row.consTotalLine.toFixed(1)}
                            <span className="text-[#808080] font-semibold">
                              {" "}
                              (
                              O {row.consTotalOverOdds == null ? "—" : formatAmerican(row.consTotalOverOdds)}
                              {" · "}
                              U {row.consTotalUnderOdds == null ? "—" : formatAmerican(row.consTotalUnderOdds)}
                              )
                            </span>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* helpers */

function pushMap(map: Map<string, number[]>, key: string, v: number) {
  const arr = map.get(key) ?? [];
  arr.push(v);
  map.set(key, arr);
}

function numOr(v: number | null | undefined, fb: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function numOrNullable(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeRound1(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10) / 10;
}

function formatTs(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function formatStartStamp(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function medianOrNull(nums: number[]): number | null {
  const arr = nums.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}

function formatAmerican(odds: number) {
  const n = Math.round(odds);
  if (!Number.isFinite(n) || n === 0) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

