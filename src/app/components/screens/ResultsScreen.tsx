import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { ScreenShell, SectionCard, SectionHeader } from "../ScreenShell";
import {
  CalendarDays,
  CheckCircle2,
  XCircle,
  Target,
  TrendingUp,
  ShieldCheck,
  Sigma,
} from "lucide-react";

/**
 * ResultsScreen.tsx — FULL REWRITE (Prism-style)
 * --------------------------------------------------------------------------------------
 * ✅ Range toggle: 7D / 30D / YTD / All-Time
 * ✅ Overall accuracy: ML / Spread / Total (graded finals)
 * ✅ Pick tracking: picked_any + picked_ml/spread/total (if present)
 * ✅ Edge: uses ev_pct/edge_pct/edge (or future *_edge_* fields) if present, else “—”
 * ✅ Error:
 *    - Total error = |actual_total - projected_total|
 *    - Margin error = |actual_margin_home - projected_margin_home|
 *    - If actual_* missing, falls back to computing from final scores
 * ✅ Fixes date-only (YYYY-MM-DD) timezone shift in America/Chicago
 */

type RangeKey = "7D" | "30D" | "YTD" | "ALL";

type RawRow = {
  game_date: string | null; // YYYY-MM-DD
  status: string | null; // 'final' expected when graded

  model_ml_hit: boolean | null;
  model_spread_hit: "win" | "loss" | "push" | null;
  model_total_hit: "win" | "loss" | "push" | null;

  // picks (present in your sample)
  picked_any?: boolean | null;
  picked_ml?: boolean | null;
  picked_spread?: boolean | null;
  picked_total?: boolean | null;

  // projections (present in your sample)
  projected_total?: number | null;
  projected_margin_home?: number | null;
  projected_home_points?: number | null;
  projected_away_points?: number | null;

  // finals + actuals (present in your sample)
  final_home_score?: number | null;
  final_away_score?: number | null;
  actual_total?: number | null;
  actual_margin_home?: number | null;

  // optional edge fields (may exist now or later)
  ev_pct?: number | null;
  edge_pct?: number | null;
  edge?: number | null;

  // optional market-specific edges (future-proof)
  ml_edge_pct?: number | null;
  spread_edge_pct?: number | null;
  total_edge_pct?: number | null;
};

type DailyRow = {
  day: string; // YYYY-MM-DD

  games: number;
  finals: number;

  // overall (all graded finals)
  ml_win_pct: number | null;
  spread_win_pct: number | null;
  total_win_pct: number | null;

  // picks
  picks_any: number | null;
  picks_ml: number | null;
  picks_spread: number | null;
  picks_total: number | null;

  pick_ml_win_pct: number | null;
  pick_spread_win_pct: number | null;
  pick_total_win_pct: number | null;

  // pick diagnostics
  avg_pick_edge_pct: number | null;
  avg_pick_total_abs_error: number | null;
  avg_pick_margin_abs_error: number | null;
};

export function ResultsScreen() {
  const [range, setRange] = useState<RangeKey>("7D");
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fromStr = useMemo(() => {
    const now = new Date();

    if (range === "ALL") return null;

    if (range === "YTD") {
      const start = new Date(now.getFullYear(), 0, 1, 12, 0, 0);
      return toYYYYMMDDLocal(start);
    }

    const days = range === "7D" ? 6 : 29; // inclusive
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
    from.setDate(from.getDate() - days);
    return toYYYYMMDDLocal(from);
  }, [range]);

  useEffect(() => {
    let alive = true;

    async function load() {
      setLoading(true);
      setError(null);

      // We attempt to fetch “everything we want”. If your schema is missing some optional columns,
      // Supabase will throw. So we fallback to a minimal select.
      const baseSelect = [
        "game_date",
        "status",
        "model_ml_hit",
        "model_spread_hit",
        "model_total_hit",

        // picks
        "picked_any",
        "picked_ml",
        "picked_spread",
        "picked_total",

        // projections
        "projected_total",
        "projected_margin_home",
        "projected_home_points",
        "projected_away_points",

        // finals/actuals
        "final_home_score",
        "final_away_score",
        "actual_total",
        "actual_margin_home",

        // edge (optional)
        "ev_pct",
        "edge_pct",
        "edge",
        "ml_edge_pct",
        "spread_edge_pct",
        "total_edge_pct",
      ].join(",");

      let q = supabase.from("game_model_results").select(baseSelect).order("game_date", { ascending: true });
      if (fromStr) q = q.gte("game_date", fromStr);

      const { data, error } = await q;

      if (!alive) return;

      if (error) {
        const fallbackSelect = "game_date,status,model_ml_hit,model_spread_hit,model_total_hit";
        let q2 = supabase.from("game_model_results").select(fallbackSelect).order("game_date", { ascending: true });
        if (fromStr) q2 = q2.gte("game_date", fromStr);

        const r2 = await q2;

        if (!alive) return;

        if (r2.error) {
          setError(r2.error.message);
          setRows([]);
          setLoading(false);
          return;
        }

        const d2 = (r2.data ?? []) as RawRow[];
        setRows(aggregateDaily(d2));
        setLoading(false);
        return;
      }

      const d = (data ?? []) as RawRow[];
      setRows(aggregateDaily(d));
      setLoading(false);
    }

    load();

    const channel = supabase
      .channel("results-game-model-results")
      .on("postgres_changes", { event: "*", schema: "public", table: "game_model_results" }, () => load())
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [fromStr]);

  const summary = useMemo(() => {
    const totals = rows.reduce(
      (acc, r) => {
        acc.games += r.games;
        acc.finals += r.finals;
        acc.picks_any += r.picks_any ?? 0;
        acc.picks_ml += r.picks_ml ?? 0;
        acc.picks_spread += r.picks_spread ?? 0;
        acc.picks_total += r.picks_total ?? 0;
        return acc;
      },
      { games: 0, finals: 0, picks_any: 0, picks_ml: 0, picks_spread: 0, picks_total: 0 }
    );

    const ml = weightedPct(rows, (r) => r.ml_win_pct, (r) => r.finals);
    const sp = weightedPct(rows, (r) => r.spread_win_pct, (r) => r.finals);
    const tot = weightedPct(rows, (r) => r.total_win_pct, (r) => r.finals);

    const pml = weightedPct(rows, (r) => r.pick_ml_win_pct, (r) => r.picks_ml ?? 0);
    const psp = weightedPct(rows, (r) => r.pick_spread_win_pct, (r) => r.picks_spread ?? 0);
    const ptot = weightedPct(rows, (r) => r.pick_total_win_pct, (r) => r.picks_total ?? 0);

    const avgPickEdge = meanAcrossDays(rows, (r) => r.avg_pick_edge_pct);
    const avgPickTotErr = meanAcrossDays(rows, (r) => r.avg_pick_total_abs_error);
    const avgPickMarErr = meanAcrossDays(rows, (r) => r.avg_pick_margin_abs_error);

    return {
      ...totals,
      ml,
      sp,
      tot,
      pml,
      psp,
      ptot,
      avgPickEdge,
      avgPickTotErr,
      avgPickMarErr,
    };
  }, [rows]);

  const winRateLabel = summary.pml != null ? `${(summary.pml * 100).toFixed(1)}%` : "—";
  const roiLabel = summary.avgPickEdge != null ? `${summary.avgPickEdge.toFixed(1)}%` : "—";
  const lastRefreshLabel = rows[0]?.day ?? "—";

  return (
    <ScreenShell
      title="Results Archive"
      subtitle="Track settled outcomes, ROI impact, and closing line performance across your slate."
      status={[
        {
          label: "Entries",
          value: loading ? "…" : String(rows.length),
          helper: `${filtered.length} filtered`,
        },
        {
          label: "Win Rate",
          value: winRateLabel,
          helper: "All settled",
        },
        {
          label: "ROI",
          value: roiLabel,
          helper: "Net performance",
        },
        {
          label: "Updated",
          value: lastRefreshLabel,
          helper: "CT timezone",
        },
      ]}
    >
      <SectionCard>
        <SectionHeader title="Result Filters" description="Filter by sport, book, or outcome while monitoring bankroll impact." />
        <div className="mt-4">
          <div className="space-y-5">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex flex-wrap items-center gap-3 text-xs text-white/70">
                <span className="uppercase tracking-[0.2em] text-white/40">Range</span>
                <RangeToggle value={range} onChange={setRange} />
                <span className="ml-auto hidden items-center gap-2 text-[10px] text-white/45 md:flex">
                  <CalendarDays className="h-3.5 w-3.5" />
                  America/Chicago
                </span>
              </div>
            </div>

      {error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-xs text-red-200">
          Data error: {error}
        </div>
      ) : null}

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <SummaryCard
          label="Games"
          value={loading ? "…" : formatInt(summary.games)}
          sublabel={rangeLabel(range)}
          icon={<Target className="h-3.5 w-3.5" />}
        />
        <SummaryCard
          label="Finals"
          value={loading ? "…" : formatInt(summary.finals)}
          sublabel="Graded"
          icon={<ShieldCheck className="h-3.5 w-3.5" />}
        />
        <SummaryCard label="ML" value={loading ? "…" : fmtPct1(summary.ml)} sublabel="Overall" positive={summary.ml != null ? summary.ml >= 52.38 : undefined} />
        <SummaryCard label="Spread" value={loading ? "…" : fmtPct1(summary.sp)} sublabel="Overall" positive={summary.sp != null ? summary.sp >= 52.38 : undefined} />
        <SummaryCard label="Total" value={loading ? "…" : fmtPct1(summary.tot)} sublabel="Overall" positive={summary.tot != null ? summary.tot >= 52.38 : undefined} />
        <SummaryCard
          label="Picks"
          value={loading ? "…" : formatInt(summary.picks_any)}
          sublabel="Picked_any"
          icon={<TrendingUp className="h-3.5 w-3.5" />}
        />
      </div>

      {/* Pick + Diagnostics */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <SummaryCard label="Pick ML" value={loading ? "…" : fmtPct1(summary.pml)} sublabel="Hit%" />
        <SummaryCard label="Pick Spread" value={loading ? "…" : fmtPct1(summary.psp)} sublabel="Hit%" />
        <SummaryCard label="Pick Total" value={loading ? "…" : fmtPct1(summary.ptot)} sublabel="Hit%" />

        <SummaryCard label="Avg Pick Edge" value={loading ? "…" : fmtPct1(summary.avgPickEdge)} sublabel="If stored" icon={<Sigma className="h-3.5 w-3.5" />} />
        <SummaryCard label="Avg Pick Tot Err" value={loading ? "…" : fmtNum1(summary.avgPickTotErr)} sublabel="Points" />
        <SummaryCard label="Avg Pick Mar Err" value={loading ? "…" : fmtNum1(summary.avgPickMarErr)} sublabel="Points" />
      </div>

      {/* Table */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-white/[0.04] border-b border-white/10">
                <th className="text-left p-3 text-white/50 font-medium">Date</th>
                <th className="text-center p-3 text-white/50 font-medium">Games</th>
                <th className="text-center p-3 text-white/50 font-medium">Finals</th>

                <th className="text-center p-3 text-[#d4af37] font-medium border-l border-white/10">ML</th>
                <th className="text-center p-3 text-[#d4af37] font-medium">Spread</th>
                <th className="text-center p-3 text-[#d4af37] font-medium">Total</th>

                <th className="text-center p-3 text-white/50 font-medium border-l border-white/10">Picks</th>
                <th className="text-center p-3 text-white/50 font-medium">Pick ML</th>
                <th className="text-center p-3 text-white/50 font-medium">Pick Sp</th>
                <th className="text-center p-3 text-white/50 font-medium">Pick Tot</th>

                <th className="text-center p-3 text-white/50 font-medium border-l border-white/10">Pick Edge</th>
                <th className="text-center p-3 text-white/50 font-medium">Pick Tot Err</th>
                <th className="text-center p-3 text-white/50 font-medium">Pick Mar Err</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-white/5">
              {loading ? (
                <tr>
                  <td className="p-3 text-white/60" colSpan={13}>
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td className="p-3 text-white/60" colSpan={13}>
                    No results found for <span className="text-white/70">{rangeLabel(range)}</span>.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.day} className="hover:bg-white/[0.03] transition-colors">
                    <td className="p-3 text-white">
                      {fmtDay(r.day)}
                      <div className="text-[10px] text-white/40 mt-0.5">{fmtWeekday(r.day)}</div>
                    </td>

                    <td className="text-center p-3 text-white/70">{r.games}</td>
                    <td className="text-center p-3 text-white/70">
                      <CoveragePill coverage={r.finals} games={r.games} />
                    </td>

                    <td className="text-center p-3 border-l border-white/10">
                      <PctCell value={r.ml_win_pct} />
                    </td>
                    <td className="text-center p-3">
                      <PctCell value={r.spread_win_pct} />
                    </td>
                    <td className="text-center p-3">
                      <PctCell value={r.total_win_pct} />
                    </td>

                    <td className="text-center p-3 border-l border-white/10 text-white/70">
                      {r.picks_any == null ? <span className="text-white/35">—</span> : r.picks_any}
                    </td>
                    <td className="text-center p-3">
                      <PctCell value={r.pick_ml_win_pct} dimIfNull />
                    </td>
                    <td className="text-center p-3">
                      <PctCell value={r.pick_spread_win_pct} dimIfNull />
                    </td>
                    <td className="text-center p-3">
                      <PctCell value={r.pick_total_win_pct} dimIfNull />
                    </td>

                    <td className="text-center p-3 border-l border-white/10 text-white/70">
                      {fmtPct1(r.avg_pick_edge_pct)}
                    </td>
                    <td className="text-center p-3 text-white/70">{fmtNum1(r.avg_pick_total_abs_error)}</td>
                    <td className="text-center p-3 text-white/70">{fmtNum1(r.avg_pick_margin_abs_error)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Notes */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <h3 className="text-sm text-white font-semibold mb-2">How to read this</h3>
        <div className="text-xs text-white/60 leading-relaxed space-y-2">
          <div>
            <span className="text-[#d4af37] font-medium">Overall</span> columns include every graded game.
          </div>
          <div>
            <span className="text-[#d4af37] font-medium">Pick</span> columns only include games/markets you flagged as picks.
          </div>
          <div>
            <span className="text-[#d4af37] font-medium">Pick Edge</span> will show “—” until you store an edge field (ev_pct / edge_pct / etc).
          </div>
        </div>
      </div>
    </div>
        </div>
      </SectionCard>
    </ScreenShell>
  );
}


/* ===========================
   Aggregation
=========================== */

function aggregateDaily(d: RawRow[]): DailyRow[] {
  const map = new Map<
    string,
    {
      games: number;
      finals: number;

      ml_w: number;
      ml_t: number;

      sp_w: number;
      sp_t: number;

      tot_w: number;
      tot_t: number;

      picks_any: number | null;
      picks_ml: number | null;
      picks_spread: number | null;
      picks_total: number | null;

      pml_w: number;
      pml_t: number;

      psp_w: number;
      psp_t: number;

      ptot_w: number;
      ptot_t: number;

      pick_edge_sum: number;
      pick_edge_n: number;

      pick_tot_err_sum: number;
      pick_tot_err_n: number;

      pick_mar_err_sum: number;
      pick_mar_err_n: number;
    }
  >();

  for (const r of d) {
    const day = r.game_date;
    if (!day) continue;

    if (!map.has(day)) {
      map.set(day, {
        games: 0,
        finals: 0,
        ml_w: 0,
        ml_t: 0,
        sp_w: 0,
        sp_t: 0,
        tot_w: 0,
        tot_t: 0,
        picks_any: null,
        picks_ml: null,
        picks_spread: null,
        picks_total: null,
        pml_w: 0,
        pml_t: 0,
        psp_w: 0,
        psp_t: 0,
        ptot_w: 0,
        ptot_t: 0,
        pick_edge_sum: 0,
        pick_edge_n: 0,
        pick_tot_err_sum: 0,
        pick_tot_err_n: 0,
        pick_mar_err_sum: 0,
        pick_mar_err_n: 0,
      });
    }

    const acc = map.get(day)!;
    acc.games += 1;

    const isFinal = r.status === "final";
    if (isFinal) acc.finals += 1;

    // Overall grading
    if (isFinal && typeof r.model_ml_hit === "boolean") {
      acc.ml_t += 1;
      if (r.model_ml_hit) acc.ml_w += 1;
    }
    if (isFinal && r.model_spread_hit) {
      acc.sp_t += 1;
      if (r.model_spread_hit === "win") acc.sp_w += 1;
    }
    if (isFinal && r.model_total_hit) {
      acc.tot_t += 1;
      if (r.model_total_hit === "win") acc.tot_w += 1;
    }

    // Picks (use picked_any if present; else infer from picked_* flags)
    const pickedAny = truthy(r.picked_any) || truthy(r.picked_ml) || truthy(r.picked_spread) || truthy(r.picked_total);
    const pickedML = truthy(r.picked_ml);
    const pickedSP = truthy(r.picked_spread);
    const pickedTOT = truthy(r.picked_total);

    if (acc.picks_any === null) acc.picks_any = 0;
    if (acc.picks_ml === null) acc.picks_ml = 0;
    if (acc.picks_spread === null) acc.picks_spread = 0;
    if (acc.picks_total === null) acc.picks_total = 0;

    if (pickedAny) acc.picks_any += 1;
    if (pickedML) acc.picks_ml += 1;
    if (pickedSP) acc.picks_spread += 1;
    if (pickedTOT) acc.picks_total += 1;

    // Pick-only grading (per market)
    if (isFinal && pickedML && typeof r.model_ml_hit === "boolean") {
      acc.pml_t += 1;
      if (r.model_ml_hit) acc.pml_w += 1;
    }
    if (isFinal && pickedSP && r.model_spread_hit) {
      acc.psp_t += 1;
      if (r.model_spread_hit === "win") acc.psp_w += 1;
    }
    if (isFinal && pickedTOT && r.model_total_hit) {
      acc.ptot_t += 1;
      if (r.model_total_hit === "win") acc.ptot_w += 1;
    }

    // Pick Edge (count only when something was picked)
    if (pickedAny) {
      const edge = pickEdgePct(r, pickedML, pickedSP, pickedTOT);
      if (typeof edge === "number" && Number.isFinite(edge)) {
        acc.pick_edge_sum += edge;
        acc.pick_edge_n += 1;
      }
    }

    // Pick Errors (only for picked markets; uses actual_* if present, else final scores)
    if (isFinal && pickedAny) {
      const totErr = computeTotalAbsError(r);
      if (typeof totErr === "number" && Number.isFinite(totErr)) {
        acc.pick_tot_err_sum += totErr;
        acc.pick_tot_err_n += 1;
      }

      const marErr = computeMarginAbsError(r);
      if (typeof marErr === "number" && Number.isFinite(marErr)) {
        acc.pick_mar_err_sum += marErr;
        acc.pick_mar_err_n += 1;
      }
    }
  }

  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, a]) => ({
      day,
      games: a.games,
      finals: a.finals,

      ml_win_pct: a.ml_t > 0 ? (a.ml_w / a.ml_t) * 100 : null,
      spread_win_pct: a.sp_t > 0 ? (a.sp_w / a.sp_t) * 100 : null,
      total_win_pct: a.tot_t > 0 ? (a.tot_w / a.tot_t) * 100 : null,

      picks_any: a.picks_any,
      picks_ml: a.picks_ml,
      picks_spread: a.picks_spread,
      picks_total: a.picks_total,

      pick_ml_win_pct: a.pml_t > 0 ? (a.pml_w / a.pml_t) * 100 : null,
      pick_spread_win_pct: a.psp_t > 0 ? (a.psp_w / a.psp_t) * 100 : null,
      pick_total_win_pct: a.ptot_t > 0 ? (a.ptot_w / a.ptot_t) * 100 : null,

      avg_pick_edge_pct: a.pick_edge_n > 0 ? a.pick_edge_sum / a.pick_edge_n : null,
      avg_pick_total_abs_error: a.pick_tot_err_n > 0 ? a.pick_tot_err_sum / a.pick_tot_err_n : null,
      avg_pick_margin_abs_error: a.pick_mar_err_n > 0 ? a.pick_mar_err_sum / a.pick_mar_err_n : null,
    }));
}

function truthy(v: any) {
  return v === true || v === 1 || v === "true";
}

/**
 * Edge chooser:
 * - Prefer market-specific edge if present and that market was picked
 * - Else fall back to generic edge fields (ev_pct/edge_pct/edge)
 */
function pickEdgePct(r: RawRow, pickedML: boolean, pickedSP: boolean, pickedTOT: boolean) {
  if (pickedML && typeof r.ml_edge_pct === "number" && Number.isFinite(r.ml_edge_pct)) return r.ml_edge_pct;
  if (pickedSP && typeof r.spread_edge_pct === "number" && Number.isFinite(r.spread_edge_pct)) return r.spread_edge_pct;
  if (pickedTOT && typeof r.total_edge_pct === "number" && Number.isFinite(r.total_edge_pct)) return r.total_edge_pct;

  if (typeof r.ev_pct === "number" && Number.isFinite(r.ev_pct)) return r.ev_pct;
  if (typeof r.edge_pct === "number" && Number.isFinite(r.edge_pct)) return r.edge_pct;
  if (typeof r.edge === "number" && Number.isFinite(r.edge)) return r.edge;

  return null;
}

function computeTotalAbsError(r: RawRow) {
  // prefer actual_total if present
  if (typeof r.actual_total === "number" && typeof r.projected_total === "number") {
    return Math.abs(r.actual_total - r.projected_total);
  }

  // fallback to finals if present
  if (typeof r.final_home_score === "number" && typeof r.final_away_score === "number" && typeof r.projected_total === "number") {
    return Math.abs(r.final_home_score + r.final_away_score - r.projected_total);
  }

  return null;
}

function computeMarginAbsError(r: RawRow) {
  // prefer actual_margin_home if present
  if (typeof r.actual_margin_home === "number" && typeof r.projected_margin_home === "number") {
    return Math.abs(r.actual_margin_home - r.projected_margin_home);
  }

  // fallback compute from finals and projected points if present
  if (
    typeof r.final_home_score === "number" &&
    typeof r.final_away_score === "number" &&
    typeof r.projected_home_points === "number" &&
    typeof r.projected_away_points === "number"
  ) {
    const actualMarginHome = r.final_home_score - r.final_away_score;
    const projMarginHome = r.projected_home_points - r.projected_away_points;
    return Math.abs(actualMarginHome - projMarginHome);
  }

  return null;
}

/* ===========================
   Range Toggle
=========================== */

function RangeToggle({ value, onChange }: { value: RangeKey; onChange: (v: RangeKey) => void }) {
  const items: Array<{ key: RangeKey; label: string }> = [
    { key: "7D", label: "7D" },
    { key: "30D", label: "30D" },
    { key: "YTD", label: "YTD" },
    { key: "ALL", label: "All-Time" },
  ];

  return (
    <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.03] p-1">
      {items.map((it) => {
        const active = it.key === value;
        return (
          <button
            key={it.key}
            onClick={() => onChange(it.key)}
            className={[
              "px-3 py-1.5 text-[11px] rounded-md transition-colors",
              active
                ? "bg-[#d4af37]/15 text-[#d4af37] border border-[#d4af37]/25"
                : "text-white/60 hover:text-white hover:bg-white/[0.04]",
            ].join(" ")}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function rangeLabel(r: RangeKey) {
  if (r === "7D") return "Last 7 days";
  if (r === "30D") return "Last 30 days";
  if (r === "YTD") return "Year to date";
  return "All-time";
}

/* ===========================
   UI bits
=========================== */

function SummaryCard({
  label,
  value,
  sublabel,
  positive,
  icon,
}: {
  label: string;
  value: string;
  sublabel: string;
  positive?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] text-white/45">{label}</div>
        {icon ? <div className="text-white/35">{icon}</div> : null}
      </div>

      <div
        className={[
          "text-lg md:text-xl font-semibold tracking-tight mb-1",
          positive === undefined ? "text-white" : positive ? "text-[#d4af37]" : "text-white",
        ].join(" ")}
      >
        {value}
      </div>
      <div className="text-[10px] text-white/40">{sublabel}</div>
    </div>
  );
}

function CoveragePill({ coverage, games }: { coverage: number; games: number }) {
  const pct = games > 0 ? (coverage / games) * 100 : 0;
  const good = pct >= 85;

  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[10px] border",
        good ? "bg-[#d4af37]/10 border-[#d4af37]/25 text-[#d4af37]" : "bg-white/5 border-white/10 text-white/70",
      ].join(" ")}
    >
      {good ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3 text-white/35" />}
      {coverage}/{games}
    </span>
  );
}

function PctCell({ value, dimIfNull }: { value: number | null; dimIfNull?: boolean }) {
  if (value == null || !Number.isFinite(value)) return <div className={dimIfNull ? "text-white/25" : "text-white/40"}>—</div>;
  const isGood = value >= 52.38;
  return <div className={isGood ? "text-[#d4af37] font-semibold" : "text-white"}>{value.toFixed(1)}%</div>;
}

/* ===========================
   helpers (timezone-safe YYYY-MM-DD)
=========================== */

function toYYYYMMDDLocal(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateFromYYYYMMDDNoShift(day: string) {
  const [yy, mm, dd] = day.split("-").map((x) => Number(x));
  return new Date(yy, (mm ?? 1) - 1, dd ?? 1, 12, 0, 0);
}

function fmtDay(day: string) {
  try {
    const dt = dateFromYYYYMMDDNoShift(day);
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return day;
  }
}

function fmtWeekday(day: string) {
  try {
    const dt = dateFromYYYYMMDDNoShift(day);
    return dt.toLocaleDateString("en-US", { weekday: "short" });
  } catch {
    return "";
  }
}

function weightedPct<T>(rows: T[], getPct: (r: T) => number | null, getWeight: (r: T) => number) {
  let wNum = 0;
  let wDen = 0;
  for (const r of rows) {
    const p = getPct(r);
    const w = getWeight(r) ?? 0;
    if (typeof p === "number" && Number.isFinite(p) && w > 0) {
      wNum += p * w;
      wDen += w;
    }
  }
  return wDen > 0 ? wNum / wDen : null;
}

function meanAcrossDays<T>(rows: T[], getVal: (r: T) => number | null) {
  let s = 0;
  let n = 0;
  for (const r of rows) {
    const v = getVal(r);
    if (typeof v === "number" && Number.isFinite(v)) {
      s += v;
      n += 1;
    }
  }
  return n > 0 ? s / n : null;
}

function fmtPct1(v: number | null) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}%`;
}

function fmtNum1(v: number | null) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(1);
}

function formatInt(n: number) {
  if (!Number.isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat().format(n);
  } catch {
    return String(n);
  }
}
