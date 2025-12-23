import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient"; // adjust path if needed

type MonteCarloRow = {
  ts: string; // timestamptz
  event_id: string;
  matchup: string;
  // optional: side, canonical_team if you store them
  projected_margin_home: number | null;
  sigma_margin_game: number | null;
  projected_total: number | null;
  sigma_total_game: number | null;
  possessions: number | null;

  calib_slope_m: number | null;
  calib_int_m: number | null;
  calib_slope_t: number | null;
  calib_int_t: number | null;

  anchorw_spread: number | null; // 0..1
  anchorw_total: number | null;  // 0..1

  marketwidth_spread: number | null;
  marketwidth_total: number | null;
};

type MonteCarloGame = {
  gameId: string;
  matchup: string;
  projectedMargin: number;
  sigmaMargin: number;
  projectedTotal: number;
  sigmaTotal: number;
  possessions: number;
  calibSlope: number; // single display field
  calibIntercept: number; // single display field
  spreadAnchorWeight: number;
  totalAnchorWeight: number;
  marketWidth: number; // single display field
};

export function MonteCarloScreen() {
  const [rows, setRows] = useState<MonteCarloRow[]>([]);
  const [latestTs, setLatestTs] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // 1) Get latest snapshot timestamp
  useEffect(() => {
    let alive = true;

    async function loadLatestTs() {
      setLoading(true);
      setError(null);

      const { data, error } = await supabase
        .from("monte_carlo_snapshot")
        .select("ts")
        .order("ts", { ascending: false })
        .limit(1);

      if (!alive) return;

      if (error) {
        setError(error.message);
        setLatestTs(null);
        setRows([]);
        setLoading(false);
        return;
      }

      const ts = data?.[0]?.ts ?? null;
      setLatestTs(ts);
      setLoading(false);
    }

    loadLatestTs();
    return () => {
      alive = false;
    };
  }, []);

  // 2) Load rows for that snapshot timestamp
  useEffect(() => {
    let alive = true;

    async function loadSnapshot(ts: string) {
      setLoading(true);
      setError(null);

      const { data, error } = await supabase
        .from("monte_carlo_snapshot")
        .select(
          [
            "ts",
            "event_id",
            "matchup",
            "projected_margin_home",
            "sigma_margin_game",
            "projected_total",
            "sigma_total_game",
            "possessions",
            "calib_slope_m",
            "calib_int_m",
            "calib_slope_t",
            "calib_int_t",
            "anchorw_spread",
            "anchorw_total",
            "marketwidth_spread",
            "marketwidth_total",
          ].join(",")
        )
        .eq("ts", ts)
        .order("matchup", { ascending: true });

      if (!alive) return;

      if (error) {
        setError(error.message);
        setRows([]);
        setLoading(false);
        return;
      }

      setRows((data ?? []) as MonteCarloRow[]);
      setLoading(false);
    }

    if (latestTs) loadSnapshot(latestTs);
    return () => {
      alive = false;
    };
  }, [latestTs]);

  const games: MonteCarloGame[] = useMemo(() => {
    // If your snapshot table has two rows per game (HOME/AWAY), you probably want ONE per game.
    // This chooses the "home view" row implicitly by grouping on event_id.
    // If you store only one row per event already, this will just pass through.
    const byEvent = new Map<string, MonteCarloRow>();

    for (const r of rows) {
      if (!r.event_id) continue;
      if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, r);
      // If later you add `side`, you can prefer HOME here.
      // else byEvent.set(r.event_id, preferHome(existing, r))
    }

    return Array.from(byEvent.values()).map((r) => {
      const projectedMargin = numOr(r.projected_margin_home, 0);
      const sigmaMargin = numOr(r.sigma_margin_game, 0);
      const projectedTotal = numOr(r.projected_total, 0);
      const sigmaTotal = numOr(r.sigma_total_game, 0);
      const possessions = numOr(r.possessions, 0);

      // Your table has single “Calib Slope / Calib Int”.
      // We’ll display totals calibration by default (most intuitive), but you can swap to margin.
      const calibSlope = numOr(r.calib_slope_t ?? r.calib_slope_m, 1);
      const calibIntercept = numOr(r.calib_int_t ?? r.calib_int_m, 0);

      const spreadAnchorWeight = clamp01(numOr(r.anchorw_spread, 0));
      const totalAnchorWeight = clamp01(numOr(r.anchorw_total, 0));

      // Your table has single “Market Width”.
      // We’ll combine spread + total into one number (max), so it reflects the “widest” market.
      const mwSpread = numOr(r.marketwidth_spread, 0);
      const mwTotal = numOr(r.marketwidth_total, 0);
      const marketWidth = Math.max(mwSpread, mwTotal);

      return {
        gameId: r.event_id,
        matchup: r.matchup || "(Unknown matchup)",
        projectedMargin,
        sigmaMargin,
        projectedTotal,
        sigmaTotal,
        possessions,
        calibSlope,
        calibIntercept,
        spreadAnchorWeight,
        totalAnchorWeight,
        marketWidth,
      };
    });
  }, [rows]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl text-white mb-1">Monte Carlo Debug View</h2>
        <p className="text-xs text-[#808080]">
          Internal simulation parameters · 10,000 iterations per game
          {latestTs ? (
            <span className="ml-2 text-[#5a5a5a]">
              · Latest snapshot: {formatTs(latestTs)}
            </span>
          ) : null}
        </p>
      </div>

      {/* Status */}
      {error ? (
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4 text-xs text-red-300">
          Supabase error: {error}
        </div>
      ) : null}

      {/* Monte Carlo Table */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-10 min-w-[180px]">
                  Matchup
                </th>
                <th className="text-center p-3 text-[#d4af37]">Proj Margin</th>
                <th className="text-center p-3 text-[#d4af37]">σ Margin</th>
                <th className="text-center p-3 text-[#d4af37]">Proj Total</th>
                <th className="text-center p-3 text-[#d4af37]">σ Total</th>
                <th className="text-center p-3 text-[#d4af37]">Poss</th>
                <th className="text-center p-3 text-[#d4af37]">Calib Slope</th>
                <th className="text-center p-3 text-[#d4af37]">Calib Int</th>
                <th className="text-center p-3 text-[#d4af37]">Spread Anchor</th>
                <th className="text-center p-3 text-[#d4af37]">Total Anchor</th>
                <th className="text-center p-3 text-[#d4af37]">Market Width</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#1a1a1a]">
              {loading ? (
                <tr>
                  <td
                    className="p-3 text-[#b0b0b0] sticky left-0 bg-[#0f0f0f] z-10"
                    colSpan={11}
                  >
                    Loading Monte Carlo snapshot…
                  </td>
                </tr>
              ) : games.length === 0 ? (
                <tr>
                  <td
                    className="p-3 text-[#b0b0b0] sticky left-0 bg-[#0f0f0f] z-10"
                    colSpan={11}
                  >
                    No Monte Carlo rows found.
                  </td>
                </tr>
              ) : (
                games.map((data) => (
                  <tr
                    key={data.gameId}
                    className="hover:bg-[#0f0f0f]/50 transition-colors"
                  >
                    <td className="p-3 text-white sticky left-0 bg-[#0f0f0f] z-10">
                      {data.matchup}
                    </td>

                    <td className="text-center p-3 text-white">
                      {data.projectedMargin > 0 ? "+" : ""}
                      {data.projectedMargin.toFixed(1)}
                    </td>

                    <td className="text-center p-3 text-[#b0b0b0]">
                      {data.sigmaMargin.toFixed(1)}
                    </td>

                    <td className="text-center p-3 text-white">
                      {data.projectedTotal.toFixed(1)}
                    </td>

                    <td className="text-center p-3 text-[#b0b0b0]">
                      {data.sigmaTotal.toFixed(1)}
                    </td>

                    <td className="text-center p-3 text-[#b0b0b0]">
                      {data.possessions.toFixed(1)}
                    </td>

                    <td className="text-center p-3 text-white">
                      {data.calibSlope.toFixed(2)}
                    </td>

                    <td className="text-center p-3 text-[#b0b0b0]">
                      {data.calibIntercept.toFixed(2)}
                    </td>

                    <td className="text-center p-3 text-[#d4af37]">
                      {(data.spreadAnchorWeight * 100).toFixed(0)}%
                    </td>

                    <td className="text-center p-3 text-[#d4af37]">
                      {(data.totalAnchorWeight * 100).toFixed(0)}%
                    </td>

                    <td className="text-center p-3 text-white">
                      {data.marketWidth.toFixed(3)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Parameter Explanations */}
      <div className="grid grid-cols-2 gap-4 mt-6">
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4">
          <h3 className="text-sm text-white mb-3">Simulation Parameters</h3>
          <div className="space-y-2 text-xs">
            <ParamExplanation
              label="Projected Margin"
              description="Expected home team margin from simulations (negative = away favored)"
            />
            <ParamExplanation
              label="σ Margin"
              description="Standard deviation of margin distribution (game volatility)"
            />
            <ParamExplanation
              label="Projected Total"
              description="Expected combined score from simulations"
            />
            <ParamExplanation
              label="σ Total"
              description="Standard deviation of total distribution"
            />
            <ParamExplanation
              label="Possessions"
              description="Estimated number of possessions per team"
            />
          </div>
        </div>

        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4">
          <h3 className="text-sm text-white mb-3">Anchoring & Calibration</h3>
          <div className="space-y-2 text-xs">
            <ParamExplanation
              label="Calib Slope"
              description="Historical accuracy adjustment (1.0 = perfect calibration)"
            />
            <ParamExplanation
              label="Calib Intercept"
              description="Systematic bias correction term"
            />
            <ParamExplanation
              label="Spread Anchor"
              description="Weight given to sharp market spread (vs simulation)"
            />
            <ParamExplanation
              label="Total Anchor"
              description="Weight given to sharp market total (vs simulation)"
            />
            <ParamExplanation
              label="Market Width"
              description="Bid-ask spread proxy (liquidity/efficiency indicator)"
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

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function formatTs(ts: string) {
  // keep it lightweight and readable
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}
