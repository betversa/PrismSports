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
  sigma_margin_game: number | null;

  projected_total: number | null;
  sigma_total_game: number | null;

  // NEW (optional in DB): if not present, we derive from total + margin
  projected_home_points?: number | null;
  projected_away_points?: number | null;
};

type TeamRow = {
  key: string;
  eventId: string;

  matchup: string;
  commenceTime: string | null;

  side: "AWAY" | "HOME";
  teamName: string;
  opponentName: string;

  projectedPoints: number;
  projectedMargin: number; // team-view margin (HOME = +margin_home, AWAY = -margin_home)

  sigmaMargin: number;
  projectedTotal: number;
  sigmaTotal: number;
};

export function MonteCarloScreen() {
  const [run, setRun] = useState<MonteCarloRun | null>(null);
  const [results, setResults] = useState<MonteCarloResultRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

      const latest = (data?.[0] ?? null) as MonteCarloRun | null;
      setRun(latest);
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

      // NOTE: select projected_points_* even if they don't exist yet.
      // If your table truly doesn't have them, Supabase will error.
      // In that case: remove them from this select OR add the columns.
      const selectCols = [
        "run_id",
        "event_id",
        "commence_time",
        "matchup",
        "home_team",
        "away_team",
        "projected_margin_home",
        "sigma_margin_game",
        "projected_total",
        "sigma_total_game",
        "projected_points_home",
        "projected_points_away",
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

  const teamRows: TeamRow[] = useMemo(() => {
    const out: TeamRow[] = [];

    for (const r of results) {
      const home = (r.home_team ?? "").trim();
      const away = (r.away_team ?? "").trim();
      if (!home || !away) continue;

      const matchup =
        (r.matchup && r.matchup.trim()) || `${away} @ ${home}`;

      const marginHome = numOr(r.projected_margin_home, 0);
      const total = numOr(r.projected_total, 0);

      // Prefer stored projected points if present, else derive from total/margin
      // homePts = (total + marginHome)/2
      // awayPts = (total - marginHome)/2
      const homePtsStored = numOrNullable(r.projected_points_home);
      const awayPtsStored = numOrNullable(r.projected_points_away);

      const homePts =
        homePtsStored ?? safeRound1((total + marginHome) / 2);
      const awayPts =
        awayPtsStored ?? safeRound1((total - marginHome) / 2);

      const sigmaMargin = numOr(r.sigma_margin_game, 0);
      const sigmaTotal = numOr(r.sigma_total_game, 0);

      // AWAY row first (OddsScreen style)
      out.push({
        key: `${r.event_id}-AWAY`,
        eventId: r.event_id,
        matchup,
        commenceTime: r.commence_time ?? null,
        side: "AWAY",
        teamName: away,
        opponentName: home,
        projectedPoints: awayPts,
        projectedMargin: -marginHome,
        sigmaMargin,
        projectedTotal: total,
        sigmaTotal,
      });

      // HOME row
      out.push({
        key: `${r.event_id}-HOME`,
        eventId: r.event_id,
        matchup,
        commenceTime: r.commence_time ?? null,
        side: "HOME",
        teamName: home,
        opponentName: away,
        projectedPoints: homePts,
        projectedMargin: marginHome,
        sigmaMargin,
        projectedTotal: total,
        sigmaTotal,
      });
    }

    return out;
  }, [results]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl text-white mb-1">Monte Carlo Debug View</h2>
        <p className="text-xs text-[#808080]">
          Internal simulation parameters · 10,000 iterations per game
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
                <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-30 min-w-[320px]">
                  Matchup
                </th>
                <th className="text-left p-3 text-[#808080] min-w-[240px]">
                  Team
                </th>
                <th className="text-center p-3 text-[#d4af37] min-w-[110px]">
                  Proj Pts
                </th>
                <th className="text-center p-3 text-[#d4af37] min-w-[110px]">
                  Proj Margin
                </th>
                <th className="text-center p-3 text-[#d4af37] min-w-[90px]">
                  σ Margin
                </th>
                <th className="text-center p-3 text-[#d4af37] min-w-[110px]">
                  Proj Total
                </th>
                <th className="text-center p-3 text-[#d4af37] min-w-[90px]">
                  σ Total
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
                  const isTopRowOfEvent = idx % 2 === 0; // AWAY row
                  return (
                    <tr
                      key={row.key}
                      className="hover:bg-[#0f0f0f]/50 transition-colors"
                    >
                      {/* Matchup cell only on first of the 2 rows */}
                      <td className="p-3 text-white sticky left-0 bg-[#0f0f0f] z-10 align-top">
                        {isTopRowOfEvent ? (
                          <div className="space-y-1">
                            <div className="text-sm font-semibold text-white">
                              {row.matchup}
                            </div>
                            {row.commenceTime ? (
                              <div className="text-[11px] text-[#808080]">
                                {formatTimeOnly(row.commenceTime)}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <div className="opacity-0 select-none">.</div>
                        )}
                      </td>

                      {/* Team */}
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <img
                            src={teamLogoSrc(row.teamName)}
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.display =
                                "none";
                            }}
                            alt={row.teamName}
                            className="w-6 h-6 object-contain"
                            style={{
                              filter:
                                "drop-shadow(0 0 6px rgba(212,175,55,0.25))",
                            }}
                          />
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
                      </td>

                      {/* Proj Pts */}
                      <td className="text-center p-3 text-white font-semibold">
                        {row.projectedPoints.toFixed(1)}
                      </td>

                      {/* Proj Margin (team view) */}
                      <td className="text-center p-3 text-white font-semibold">
                        {row.projectedMargin > 0 ? "+" : ""}
                        {row.projectedMargin.toFixed(1)}
                      </td>

                      {/* σ Margin */}
                      <td className="text-center p-3 text-[#b0b0b0]">
                        {row.sigmaMargin.toFixed(1)}
                      </td>

                      {/* Proj Total */}
                      <td className="text-center p-3 text-white font-semibold">
                        {row.projectedTotal.toFixed(1)}
                      </td>

                      {/* σ Total */}
                      <td className="text-center p-3 text-[#b0b0b0]">
                        {row.sigmaTotal.toFixed(1)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Parameter Explanations */}
      <div className="grid grid-cols-2 gap-4 mt-6">
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4">
          <h3 className="text-sm text-white mb-3">Simulation Outputs</h3>
          <div className="space-y-2 text-xs">
            <ParamExplanation
              label="Proj Pts"
              description="Projected points for that team (derived from total + margin if not stored)"
            />
            <ParamExplanation
              label="Proj Margin"
              description="Projected margin from that team’s perspective (HOME positive = home favored)"
            />
            <ParamExplanation
              label="Proj Total"
              description="Projected combined score"
            />
          </div>
        </div>

        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4">
          <h3 className="text-sm text-white mb-3">Volatility</h3>
          <div className="space-y-2 text-xs">
            <ParamExplanation
              label="σ Margin"
              description="Standard deviation of margin distribution (game volatility)"
            />
            <ParamExplanation
              label="σ Total"
              description="Standard deviation of total distribution"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ParamExplanation({ label, description }: { label: string; description: string }) {
  return (
    <div>
      <div className="text-[#d4af37]">{label}</div>
      <div className="text-[#808080] mt-0.5">{description}</div>
    </div>
  );
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

function formatTimeOnly(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Logo resolver:
 * Swap this to match however OddsScreen resolves logos.
 *
 * Common options:
 *  - `/logos/<slug>.png`
 *  - `/team-logos/<slug>.png`
 *  - a full URL stored in a table
 */
function teamLogoSrc(teamName: string) {
  const slug = String(teamName || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  // CHANGE THIS PATH to match your app’s logo folder
  return `/team-logos/${slug}.png`;
}
