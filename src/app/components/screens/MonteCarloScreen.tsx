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

  // probs + lines
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

type TeamRow = {
  key: string;
  eventId: string;

  matchup: string;
  commenceTime: string | null;

  side: "AWAY" | "HOME";
  teamName: string;
  opponentName: string;

  logoUrl: string | null;

  projectedPoints: number;
  projectedMargin: number; // team-view margin (HOME=+margin_home, AWAY=-margin_home)

  spreadLineTeam: number | null;
  winProbTeam: number | null;
  coverProbTeam: number | null;

  // game-level
  totalLine: number | null;
  overProb: number | null;
  underProb: number | null;
};

export function MonteCarloScreen() {
  const [run, setRun] = useState<MonteCarloRun | null>(null);
  const [results, setResults] = useState<MonteCarloResultRow[]>([]);
  const [logoMap, setLogoMap] = useState<Map<string, string>>(new Map());

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 0) Load team logos from team_map."Logo URL"
  useEffect(() => {
    let alive = true;

    async function loadLogos() {
      const { data, error } = await supabase
        .from("team_map")
        .select('canonical,"Logo URL"');

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
      setLoading(true);
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
        setLoading(false);
        return;
      }

      setRun((data?.[0] ?? null) as MonteCarloRun | null);
      setLoading(false);
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
      setLoading(true);
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
        setLoading(false);
        return;
      }

      setResults((data ?? []) as MonteCarloResultRow[]);
      setLoading(false);
    }

    if (run?.id) loadResults(run.id);
    return () => {
      alive = false;
    };
  }, [run?.id]);

  // 3) Build 2 rows per event (Away then Home)
  const teamRows: TeamRow[] = useMemo(() => {
    const out: TeamRow[] = [];

    for (const r of results) {
      const home = (r.home_team ?? "").trim();
      const away = (r.away_team ?? "").trim();
      if (!home || !away) continue;

      const matchupStr = (r.matchup && r.matchup.trim()) || `${away} @ ${home}`;

      const marginHome = numOr(r.projected_margin_home, 0);
      const totalProj = numOr(r.projected_total, 0);

      const homePtsStored = numOrNullable(r.projected_home_points);
      const awayPtsStored = numOrNullable(r.projected_away_points);

      const homePts = homePtsStored ?? safeRound1((totalProj + marginHome) / 2);
      const awayPts = awayPtsStored ?? safeRound1((totalProj - marginHome) / 2);

      const spreadHome = numOrNullable(r.spread_line_home);
      const totalLine = numOrNullable(r.total_line);

      const pHomeWin = numOrNullable(r.home_win_prob);
      const pAwayWin = numOrNullable(r.away_win_prob);

      const pHomeCover = numOrNullable(r.home_cover_prob);
      const pAwayCover = numOrNullable(r.away_cover_prob);

      const pOver = numOrNullable(r.over_prob);
      const pUnder = numOrNullable(r.under_prob);

      // AWAY row first
      out.push({
        key: `${r.event_id}-AWAY`,
        eventId: r.event_id,
        matchup: matchupStr,
        commenceTime: r.commence_time ?? null,
        side: "AWAY",
        teamName: away,
        opponentName: home,
        logoUrl: logoMap.get(away) ?? null,

        projectedPoints: awayPts,
        projectedMargin: -marginHome,

        spreadLineTeam: spreadHome == null ? null : -spreadHome,
        winProbTeam: pAwayWin,
        coverProbTeam: pAwayCover,

        totalLine,
        overProb: pOver,
        underProb: pUnder,
      });

      // HOME row
      out.push({
        key: `${r.event_id}-HOME`,
        eventId: r.event_id,
        matchup: matchupStr,
        commenceTime: r.commence_time ?? null,
        side: "HOME",
        teamName: home,
        opponentName: away,
        logoUrl: logoMap.get(home) ?? null,

        projectedPoints: homePts,
        projectedMargin: marginHome,

        spreadLineTeam: spreadHome,
        winProbTeam: pHomeWin,
        coverProbTeam: pHomeCover,

        totalLine,
        overProb: pOver,
        underProb: pUnder,
      });
    }

    return out;
  }, [results, logoMap]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl text-white mb-1">Monte Carlo</h2>
        <p className="text-xs text-[#808080]">
          Latest simulation snapshot
          {run?.created_at ? (
            <span className="ml-2 text-[#5a5a5a]">
              · Latest run: {formatTs(run.created_at)}
            </span>
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
                <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-30 min-w-[440px]">
                  Matchup
                </th>
                <th className="text-center p-3 text-[#d4af37] min-w-[90px]">
                  Proj Pts
                </th>
                <th className="text-center p-3 text-[#d4af37] min-w-[105px]">
                  Proj Margin
                </th>
                <th className="text-center p-3 text-[#d4af37] min-w-[105px]">
                  Spread
                </th>
                <th className="text-center p-3 text-[#d4af37] min-w-[80px]">
                  Win %
                </th>
                <th className="text-center p-3 text-[#d4af37] min-w-[90px]">
                  Cover %
                </th>
                <th className="text-center p-3 text-[#d4af37] min-w-[160px]">
                  Total (O/U %)
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#1a1a1a]">
              {loading ? (
                <tr>
                  <td
                    className="p-3 text-[#b0b0b0] sticky left-0 bg-[#0f0f0f] z-10"
                    colSpan={7}
                  >
                    Loading Monte Carlo results…
                  </td>
                </tr>
              ) : teamRows.length === 0 ? (
                <tr>
                  <td
                    className="p-3 text-[#b0b0b0] sticky left-0 bg-[#0f0f0f] z-10"
                    colSpan={7}
                  >
                    No Monte Carlo rows found for latest run.
                  </td>
                </tr>
              ) : (
                teamRows.map((row, idx) => {
                  const isAwayRow = idx % 2 === 0;

                  return (
                    <tr key={row.key} className="hover:bg-[#0f0f0f]/50 transition-colors">
                      {/* Matchup cell: contains start time + matchup (only on away row) + team block on both rows */}
                      <td className="p-3 text-white sticky left-0 bg-[#0f0f0f] z-10 align-top">
                        <div className="space-y-2">
                          {isAwayRow ? (
                            <div className="space-y-1">
                              <div className="text-[11px] text-[#808080]">
                                {row.commenceTime ? formatStartStamp(row.commenceTime) : "TBD"}
                              </div>
                              <div className="text-sm font-semibold text-white">
                                {row.matchup}
                              </div>
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
                              <div className="text-[11px] text-[#808080]">
                                vs {row.opponentName}
                              </div>
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

                      {/* Spread (team view) */}
                      <td className="text-center p-3 text-white font-semibold">
                        {row.spreadLineTeam == null ? (
                          <span className="text-[#3a3a3a]">—</span>
                        ) : (
                          <>
                            {row.spreadLineTeam > 0 ? "+" : ""}
                            {row.spreadLineTeam.toFixed(1)}
                          </>
                        )}
                      </td>

                      {/* Win % */}
                      <td className="text-center p-3 text-white font-semibold">
                        {row.winProbTeam == null ? (
                          <span className="text-[#3a3a3a]">—</span>
                        ) : (
                          `${(row.winProbTeam * 100).toFixed(0)}%`
                        )}
                      </td>

                      {/* Cover % */}
                      <td className="text-center p-3 text-white font-semibold">
                        {row.coverProbTeam == null ? (
                          <span className="text-[#3a3a3a]">—</span>
                        ) : (
                          `${(row.coverProbTeam * 100).toFixed(0)}%`
                        )}
                      </td>

                      {/* Total: visually merged across the 2 rows (render only on away row) */}
                      <td
                        className={[
                          "text-center p-3 text-white font-semibold",
                          !isAwayRow ? "border-t-0" : "",
                        ].join(" ")}
                      >
                        {isAwayRow ? (
                          row.totalLine == null ? (
                            <span className="text-[#3a3a3a]">—</span>
                          ) : (
                            <div className="leading-tight">
                              <div>{row.totalLine.toFixed(1)}</div>
                              <div className="text-[11px] text-[#808080] font-semibold">
                                O{" "}
                                {row.overProb == null ? "—" : `${(row.overProb * 100).toFixed(0)}%`}
                                {" · "}
                                U{" "}
                                {row.underProb == null ? "—" : `${(row.underProb * 100).toFixed(0)}%`}
                              </div>
                            </div>
                          )
                        ) : (
                          <span className="text-transparent select-none">—</span>
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
