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
  matchup: string | null;

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
  cover_push_prob: number | null;

  total_line: number | null;
  over_prob: number | null;
  under_prob: number | null;
  total_push_prob: number | null;
};

type TeamMapLogoRow = {
  canonical: string;
  "Logo URL": string | null;
};

/**
 * Assumes normalized odds_snapshot schema:
 *  - ts (timestamptz)
 *  - event_id (text)
 *  - market (text)  e.g. "spreads" | "totals" | "h2h"
 *  - side (text)    e.g. "home"/"away" for spreads, "over"/"under" for totals
 *  - line (numeric) spread/total line
 *  - bookmaker (text)
 *
 * If your side values differ, update SIDE_ALIASES below.
 */
type OddsSnapshotRow = {
  ts: string;
  event_id: string;
  market: string;
  side: string | null;
  line: number | null;
  bookmaker: string | null;
};

type Consensus = {
  spread_home: number | null;
  total: number | null;
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

  projectedPoints: number;
  projectedMargin: number; // team-view margin (HOME=+margin_home, AWAY=-margin_home)

  mcSpreadLineTeam: number | null;
  consensusSpreadLineTeam: number | null;

  winProbTeam: number | null;
  coverProbTeam: number | null;

  mcTotalLine: number | null;
  consensusTotalLine: number | null;

  overProb: number | null;
  underProb: number | null;
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

  // 0) Load team logos from team_map."Logo URL"
  useEffect(() => {
    let alive = true;

    async function loadLogos() {
      const { data, error } = await supabase.from("team_map").select('canonical,"Logo URL"');
      if (!alive) return;

      if (error) {
        console.warn("[MonteCarloScreen] Failed to load team_map logos:", error.message);
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
    }

    loadLogos();
    return () => {
      alive = false;
    };
  }, []);

  // 1) Load latest run
  useEffect(() => {
    let alive = true;

    async function loadLatestRun() {
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
    }

    loadLatestRun();
    return () => {
      alive = false;
    };
  }, []);

  // 2) Load results for that run
  useEffect(() => {
    let alive = true;

    async function loadResults(runId: string) {
      setLoadingResults(true);
      setError(null);

      const selectCols = [
        "run_id",
        "event_id",
        "commence_time",
        "matchup",
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
        "cover_push_prob",
        "total_line",
        "over_prob",
        "under_prob",
        "total_push_prob",
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

  // 3) Load consensus spread + total for the events in this run
  useEffect(() => {
    let alive = true;

    async function loadConsensus(eventIds: string[]) {
      if (!eventIds.length) {
        setConsensusMap(new Map());
        return;
      }

      setLoadingConsensus(true);

      // Pull a bounded window of snapshot rows for these events
      // (latest per event is computed client-side)
      const { data, error } = await supabase
        .from("odds_snapshot")
        .select("ts,event_id,market,side,line,bookmaker")
        .in("event_id", eventIds)
        .in("market", ["spreads", "totals"])
        .order("ts", { ascending: false })
        .limit(5000);

      if (!alive) return;

      if (error) {
        console.warn("[MonteCarloScreen] consensus fetch failed:", error.message);
        setConsensusMap(new Map());
        setLoadingConsensus(false);
        return;
      }

      const rows = (data ?? []) as OddsSnapshotRow[];

      // Build "latest snapshot per event+market+book+side" (dedupe)
      // Then compute consensus line as median across books
      type Key = string; // `${event}|${market}|${book}|${side}`
      const seen = new Set<Key>();

      const spreadLinesByEvent: Map<string, number[]> = new Map();
      const totalLinesByEvent: Map<string, number[]> = new Map();
      const bestTsByEvent: Map<string, string> = new Map();

      for (const r of rows) {
        const eventId = (r.event_id ?? "").trim();
        const market = (r.market ?? "").trim().toLowerCase();
        const book = (r.bookmaker ?? "").trim().toLowerCase() || "unknown";
        const side = normalizeSide(r.side);
        const line = numOrNullable(r.line);

        if (!eventId || !market || side == null || line == null) continue;

        // Track the freshest ts we encountered for the event (informational)
        if (r.ts) {
          const prev = bestTsByEvent.get(eventId);
          if (!prev || new Date(r.ts).getTime() > new Date(prev).getTime()) bestTsByEvent.set(eventId, r.ts);
        }

        // We only need:
        // - spreads: HOME side line
        // - totals:  OVER side line (same as UNDER, line-wise)
        if (market === "spreads" && side !== "home") continue;
        if (market === "totals" && side !== "over") continue;

        const k = `${eventId}|${market}|${book}|${side}`;
        if (seen.has(k)) continue; // already took newest row for that (event,market,book,side)
        seen.add(k);

        if (market === "spreads") {
          const arr = spreadLinesByEvent.get(eventId) ?? [];
          arr.push(line);
          spreadLinesByEvent.set(eventId, arr);
        } else if (market === "totals") {
          const arr = totalLinesByEvent.get(eventId) ?? [];
          arr.push(line);
          totalLinesByEvent.set(eventId, arr);
        }
      }

      const m = new Map<string, Consensus>();
      for (const eventId of eventIds) {
        const spreadHome = medianOrNull(spreadLinesByEvent.get(eventId) ?? []);
        const total = medianOrNull(totalLinesByEvent.get(eventId) ?? []);
        m.set(eventId, { spread_home: spreadHome, total, ts: bestTsByEvent.get(eventId) ?? null });
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

  // 4) Build 2 rows per event (Away then Home)
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

      const mcSpreadHome = numOrNullable(r.spread_line_home);
      const mcTotalLine = numOrNullable(r.total_line);

      const pHomeWin = numOrNullable(r.home_win_prob);
      const pAwayWin = numOrNullable(r.away_win_prob);

      const pHomeCover = numOrNullable(r.home_cover_prob);
      const pAwayCover = numOrNullable(r.away_cover_prob);

      const pOver = numOrNullable(r.over_prob);
      const pUnder = numOrNullable(r.under_prob);

      const c = consensusMap.get(r.event_id) ?? { spread_home: null, total: null, ts: null };
      const consSpreadHome = numOrNullable(c.spread_home);
      const consTotal = numOrNullable(c.total);

      // AWAY row first
      out.push({
        key: `${r.event_id}-AWAY`,
        eventId: r.event_id,
        commenceTime: r.commence_time ?? null,
        side: "AWAY",
        teamName: away,
        opponentName: home,
        logoUrl: logoMap.get(away) ?? null,

        projectedPoints: awayPts,
        projectedMargin: -marginHome,

        mcSpreadLineTeam: mcSpreadHome == null ? null : -mcSpreadHome,
        consensusSpreadLineTeam: consSpreadHome == null ? null : -consSpreadHome,

        winProbTeam: pAwayWin,
        coverProbTeam: pAwayCover,

        mcTotalLine,
        consensusTotalLine: consTotal,

        overProb: pOver,
        underProb: pUnder,
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

        projectedPoints: homePts,
        projectedMargin: marginHome,

        mcSpreadLineTeam: mcSpreadHome,
        consensusSpreadLineTeam: consSpreadHome,

        winProbTeam: pHomeWin,
        coverProbTeam: pHomeCover,

        mcTotalLine,
        consensusTotalLine: consTotal,

        overProb: pOver,
        underProb: pUnder,
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
          {run?.created_at ? (
            <span className="ml-2 text-[#5a5a5a]">· Latest run: {formatTs(run.created_at)}</span>
          ) : null}
          {loadingConsensus ? (
            <span className="ml-2 text-[#5a5a5a]">· Loading consensus…</span>
          ) : null}
        </p>
      </div>

      {error ? (
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4 text-xs text-red-300">
          Supabase error: {error}
        </div>
      ) : null}

      {/* Table wrapper: fixed-height scroll like OddsScreen */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">
        <div className="max-h-[calc(100vh-220px)] overflow-y-auto overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-20">
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                {/* tighter matchup column to make room for consensus */}
                <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-30 min-w-[360px]">
                  Matchup
                </th>

                <th className="text-center p-3 text-[#d4af37] min-w-[90px]">Proj Pts</th>
                <th className="text-center p-3 text-[#d4af37] min-w-[105px]">Proj Margin</th>

                <th className="text-center p-3 text-[#d4af37] min-w-[105px]">Spread</th>
                <th className="text-center p-3 text-[#d4af37] min-w-[120px]">Consensus</th>

                <th className="text-center p-3 text-[#d4af37] min-w-[80px]">Win %</th>
                <th className="text-center p-3 text-[#d4af37] min-w-[90px]">Cover %</th>

                <th className="text-center p-3 text-[#d4af37] min-w-[120px]">Total</th>
                <th className="text-center p-3 text-[#d4af37] min-w-[120px]">Consensus</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#1a1a1a]">
              {loading ? (
                <tr>
                  <td className="p-3 text-[#b0b0b0] sticky left-0 bg-[#0f0f0f] z-10" colSpan={9}>
                    Loading Monte Carlo results…
                  </td>
                </tr>
              ) : teamRows.length === 0 ? (
                <tr>
                  <td className="p-3 text-[#b0b0b0] sticky left-0 bg-[#0f0f0f] z-10" colSpan={9}>
                    No Monte Carlo rows found for latest run.
                  </td>
                </tr>
              ) : (
                teamRows.map((row, idx) => {
                  const isAwayRow = idx % 2 === 0;

                  return (
                    <tr key={row.key} className="hover:bg-[#0f0f0f]/50 transition-colors">
                      {/* Matchup cell:
                          - NO "team1 @ team2" line
                          - show time only on away row
                          - show team block on both rows
                      */}
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
                                onError={(e) => {
                                  (e.currentTarget as HTMLImageElement).style.display = "none";
                                }}
                                alt={row.teamName}
                                className="w-8 h-8 object-contain"
                                style={{
                                  filter: "drop-shadow(0 0 6px rgba(212,175,55,0.25))",
                                }}
                              />
                            ) : (
                              <div className="w-8 h-8" />
                            )}

                            <div className="leading-tight">
                              <div className="text-sm font-bold text-white">
                                {row.teamName}
                                <span className="ml-2 text-[11px] font-semibold text-[#808080]">
                                  ({row.side})
                                </span>
                              </div>
                              <div className="text-[11px] text-[#808080]">vs {row.opponentName}</div>
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Proj Pts */}
                      <td className="text-center p-3 text-white font-semibold">
                        {row.projectedPoints.toFixed(1)}
                      </td>

                      {/* Proj Margin */}
                      <td className="text-center p-3 text-white font-semibold">
                        {row.projectedMargin > 0 ? "+" : ""}
                        {row.projectedMargin.toFixed(1)}
                      </td>

                      {/* Spread (MC) */}
                      <td className="text-center p-3 text-white font-semibold">
                        {row.mcSpreadLineTeam == null ? (
                          <span className="text-[#3a3a3a]">—</span>
                        ) : (
                          <>
                            {row.mcSpreadLineTeam > 0 ? "+" : ""}
                            {row.mcSpreadLineTeam.toFixed(1)}
                          </>
                        )}
                      </td>

                      {/* Spread (Consensus) */}
                      <td className="text-center p-3 text-white font-semibold">
                        {row.consensusSpreadLineTeam == null ? (
                          <span className="text-[#3a3a3a]">—</span>
                        ) : (
                          <>
                            {row.consensusSpreadLineTeam > 0 ? "+" : ""}
                            {row.consensusSpreadLineTeam.toFixed(1)}
                          </>
                        )}
                      </td>

                      {/* Win % */}
                      <td className="text-center p-3 text-white font-semibold">
                        {row.winProbTeam == null ? <span className="text-[#3a3a3a]">—</span> : `${(row.winProbTeam * 100).toFixed(0)}%`}
                      </td>

                      {/* Cover % */}
                      <td className="text-center p-3 text-white font-semibold">
                        {row.coverProbTeam == null ? <span className="text-[#3a3a3a]">—</span> : `${(row.coverProbTeam * 100).toFixed(0)}%`}
                      </td>

                      {/* Total (MC): line on BOTH rows, over% on away row, under% on home row */}
                      <td className="text-center p-3 text-white font-semibold">
                        {row.mcTotalLine == null ? (
                          <span className="text-[#3a3a3a]">—</span>
                        ) : (
                          <div className="leading-tight">
                            <div>{row.mcTotalLine.toFixed(1)}</div>
                            <div className="text-[11px] text-[#808080] font-semibold">
                              {isAwayRow ? (
                                <>
                                  O{" "}
                                  {row.overProb == null ? "—" : `${(row.overProb * 100).toFixed(0)}%`}
                                </>
                              ) : (
                                <>
                                  U{" "}
                                  {row.underProb == null ? "—" : `${(row.underProb * 100).toFixed(0)}%`}
                                </>
                              )}
                            </div>
                          </div>
                        )}
                      </td>

                      {/* Total (Consensus): line on BOTH rows, over/under % same as above */}
                      <td className="text-center p-3 text-white font-semibold">
                        {row.consensusTotalLine == null ? (
                          <span className="text-[#3a3a3a]">—</span>
                        ) : (
                          <div className="leading-tight">
                            <div>{row.consensusTotalLine.toFixed(1)}</div>
                            <div className="text-[11px] text-[#808080] font-semibold">
                              {isAwayRow ? (
                                <>
                                  O{" "}
                                  {row.overProb == null ? "—" : `${(row.overProb * 100).toFixed(0)}%`}
                                </>
                              ) : (
                                <>
                                  U{" "}
                                  {row.underProb == null ? "—" : `${(row.underProb * 100).toFixed(0)}%`}
                                </>
                              )}
                            </div>
                          </div>
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
  return d.toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function medianOrNull(nums: number[]): number | null {
  const arr = nums.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}
