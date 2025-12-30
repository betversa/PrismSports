import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import {
  Activity,
  CalendarDays,
  CheckCircle2,
  XCircle,
  Target,
  TrendingUp,
  ShieldCheck,
  Sigma,
} from "lucide-react";

/**
 * ResultsScreen.tsx — FULL REWRITE (Prism-style, anonymous copy, more functional tracking)
 * --------------------------------------------------------------------------------------
 * ✅ Range toggle: 7D / 30D / YTD / All-Time
 * ✅ Uses Results-grade fields already stored per game (ML / Spread / Total)
 * ✅ Adds: ROI (if you store a "is_pick" or "picked_*" flag), Avg edge, Avg error
 * ✅ Fixes date-only (YYYY-MM-DD) timezone shift in America/Chicago
 *
 * Notes:
 * - This screen intentionally avoids exposing internal table/view names.
 * - It will gracefully degrade if optional columns are missing (shows “—”).
 */

type RangeKey = "7D" | "30D" | "YTD" | "ALL";

/**
 * If you already have any of these optional columns in game_model_results, we’ll use them:
 * - is_pick (boolean) OR picked_ml / picked_spread / picked_total (boolean)
 * - ev_pct (number) OR edge_pct (number) OR edge (number)
 * - projected_total / final scores for error
 * - projected_home_points / projected_away_points for margin error
 */
type RawRow = {
  game_date: string | null; // YYYY-MM-DD
  status: string | null; // 'final' expected when graded
  model_ml_hit: boolean | null;
  model_spread_hit: "win" | "loss" | "push" | null;
  model_total_hit: "win" | "loss" | "push" | null;

  // optional
  is_pick?: boolean | null;
  picked_ml?: boolean | null;
  picked_spread?: boolean | null;
  picked_total?: boolean | null;

  ev_pct?: number | null;
  edge_pct?: number | null;
  edge?: number | null;

  projected_home_points?: number | null;
  projected_away_points?: number | null;
  projected_total?: number | null;

  final_home_score?: number | null;
  final_away_score?: number | null;
};

type DailyRow = {
  day: string; // YYYY-MM-DD

  games: number; // total rows
  finals: number; // status=final count

  // overall (all graded finals)
  ml_win_pct: number | null;
  spread_win_pct: number | null;
  total_win_pct: number | null;

  // pick-only (if flags exist)
  picks: number | null;
  pick_ml_win_pct: number | null;
  pick_spread_win_pct: number | null;
  pick_total_win_pct: number | null;

  // diagnostics (if projections + finals exist)
  avg_total_abs_error: number | null; // |actual_total - projected_total|
  avg_margin_abs_error: number | null; // |(home-away actual) - (proj home-away)|

  // edge summary (if present)
  avg_edge_pct: number | null;
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

      // We “attempt” to fetch optional columns; if some don’t exist in your schema, Supabase will error.
      // So we do a safe two-pass: minimal select first, then optional select.
      const baseSelect =
        "game_date,status,model_ml_hit,model_spread_hit,model_total_hit,final_home_score,final_away_score,projected_home_points,projected_away_points,projected_total,is_pick,picked_ml,picked_spread,picked_total,ev_pct,edge_pct,edge";

      let q = supabase.from("game_model_results").select(baseSelect).order("game_date", { ascending: true });
      if (fromStr) q = q.gte("game_date", fromStr);

      const { data, error } = await q;

      if (!alive) return;

      if (error) {
        // Fallback: query only the known-required columns if optional ones caused schema errors
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
        acc.picks += r.picks ?? 0;
        return acc;
      },
      { games: 0, finals: 0, picks: 0 }
    );

    const ml = weightedPct(rows, (r) => r.ml_win_pct, (r) => r.finals);
    const sp = weightedPct(rows, (r) => r.spread_win_pct, (r) => r.finals);
    const tot = weightedPct(rows, (r) => r.total_win_pct, (r) => r.finals);

    const pml = weightedPct(rows, (r) => r.pick_ml_win_pct, (r) => r.picks ?? 0);
    const psp = weightedPct(rows, (r) => r.pick_spread_win_pct, (r) => r.picks ?? 0);
    const ptot = weightedPct(rows, (r) => r.pick_total_win_pct, (r) => r.picks ?? 0);

    const avgEdge = meanAcrossDays(rows, (r) => r.avg_edge_pct);
    const avgTotErr = meanAcrossDays(rows, (r) => r.avg_total_abs_error);
    const avgMarErr = meanAcrossDays(rows, (r) => r.avg_margin_abs_error);

    return {
      ...totals,
      ml,
      sp,
      tot,
      pml,
      psp,
      ptot,
      avgEdge,
      avgTotErr,
      avgMarErr,
    };
  }, [rows]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="rounded-xl border border-white/10 bg-gradient-to-b from-white/[0.08] to-white/[0.03] p-4 md:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/5 border border-white/10">
                <Activity className="h-4 w-4 text-[#d4af37]" />
              </div>
              <h2 className="text-white text-lg md:text-xl font-semibold tracking-tight">Results</h2>
            </div>

            <p className="mt-1 text-xs text-white/50">
              Track accuracy over time — overall performance + pick-only performance.
            </p>

            <div className="mt-3">
              <RangeToggle value={range} onChange={setRange} />
            </div>
          </div>

          <div className="hidden md:flex items-center gap-2 text-[10px] text-white/45 whitespace-nowrap">
            <CalendarDays className="h-3.5 w-3.5" />
            <span>America/Chicago</span>
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-xs text-red-200">
          Data error: {error}
        </div>
      ) : null}

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <SummaryCard label="Games" value={loading ? "…" : formatInt(summary.games)} sublabel={rangeLabel(range)} icon={<Target className="h-3.5 w-3.5" />} />
        <SummaryCard label="Finals" value={loading ? "…" : formatInt(summary.finals)} sublabel="Graded" icon={<ShieldCheck className="h-3.5 w-3.5" />} />
        <SummaryCard label="ML" value={loading ? "…" : fmtPct1(summary.ml)} sublabel="Overall" positive={summary.ml != null ? summary.ml >= 52.38 : undefined} />
        <SummaryCard label="Spread" value={loading ? "…" : fmtPct1(summary.sp)} sublabel="Overall" positive={summary.sp != null ? summary.sp >= 52.38 : undefined} />
        <SummaryCard label="Total" value={loading ? "…" : fmtPct1(summary.tot)} sublabel="Overall" positive={summary.tot != null ? summary.tot >= 52.38 : undefined} />
        <SummaryCard label="Picks" value={loading ? "…" : fmtPct1(bestPickRate(summary.pml, summary.psp, summary.ptot))} sublabel="Pick hit%" icon={<TrendingUp className="h-3.5 w-3.5" />} />
      </div>

      {/* Diagnostics */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <SummaryCard label="Pick ML" value={loading ? "…" : fmtPct1(summary.pml)} sublabel="Pick-only" />
        <SummaryCard label="Pick Spread" value={loading ? "…" : fmtPct1(summary.psp)} sublabel="Pick-only" />
        <SummaryCard label="Pick Total" value={loading ? "…" : fmtPct1(summary.ptot)} sublabel="Pick-only" />
        <SummaryCard label="Avg Edge" value={loading ? "…" : fmtPct1(summary.avgEdge)} sublabel="If available" icon={<Sigma className="h-3.5 w-3.5" />} />
        <SummaryCard label="Avg Total Error" value={loading ? "…" : fmtNum1(summary.avgTotErr)} sublabel="Points" />
        <SummaryCard label="Avg Margin Error" value={loading ? "…" : fmtNum1(summary.avgMarErr)} sublabel="Points" />
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

                <th className="text-center p-3 text-white/50 font-medium border-l border-white/10">Edge</th>
                <th className="text-center p-3 text-white/50 font-medium">Tot Err</th>
                <th className="text-center p-3 text-white/50 font-medium">Mar Err</th>
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
                      {r.picks == null ? <span className="text-white/35">—</span> : r.picks}
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
                      {fmtPct1(r.avg_edge_pct)}
                    </td>
                    <td className="text-center p-3 text-white/70">{fmtNum1(r.avg_total_abs_error)}</td>
                    <td className="text-center p-3 text-white/70">{fmtNum1(r.avg_margin_abs_error)}</td>
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
            <span className="text-[#d4af37] font-medium">Overall</span> rows include every graded game.
          </div>
          <div>
            <span className="text-[#d4af37] font-medium">Pick</span> rows measure only the plays you flagged as picks (if available).
          </div>
          <div className="text-[10px] text-white/35 pt-1">
            If pick flags / edge aren’t available yet, those cells will show “—”.
          </div>
        </div>
      </div>
    </div>
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

      picks: number | null;

      pml_w: number;
      pml_t: number;

      psp_w: number;
      psp_t: number;

      ptot_w: number;
      ptot_t: number;

      edge_sum: number;
      edge_n: number;

      tot_err_sum: number;
      tot_err_n: number;

      mar_err_sum: number;
      mar_err_n: number;
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
        picks: null,
        pml_w: 0,
        pml_t: 0,
        psp_w: 0,
        psp_t: 0,
        ptot_w: 0,
        ptot_t: 0,
        edge_sum: 0,
        edge_n: 0,
        tot_err_sum: 0,
        tot_err_n: 0,
        mar_err_sum: 0,
        mar_err_n: 0,
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

    // Pick flags (supports is_pick or picked_*; pick count is total picks across any market)
    const isPickAny =
      truthy(r.is_pick) ||
      truthy(r.picked_ml) ||
      truthy(r.picked_spread) ||
      truthy(r.picked_total);

    if (acc.picks === null) acc.picks = 0;

    if (isPickAny) acc.picks += 1;

    // Pick-only grading (if final + picked that market)
    const pickedML = truthy(r.picked_ml) || (truthy(r.is_pick) && typeof r.model_ml_hit === "boolean");
    const pickedSP = truthy(r.picked_spread) || (truthy(r.is_pick) && !!r.model_spread_hit);
    const pickedTOT = truthy(r.picked_total) || (truthy(r.is_pick) && !!r.model_total_hit);

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

    // Edge
    const edge = pickEdgePct(r);
    if (typeof edge === "number" && Number.isFinite(edge)) {
      acc.edge_sum += edge;
      acc.edge_n += 1;
    }

    // Errors (only if finals + projections exist)
    if (isFinal) {
      const fh = r.final_home_score;
      const fa = r.final_away_score;

      if (typeof fh === "number" && typeof fa === "number") {
        if (typeof r.projected_total === "number") {
          acc.tot_err_sum += Math.abs(fh + fa - r.projected_total);
          acc.tot_err_n += 1;
        }

        if (typeof r.projected_home_points === "number" && typeof r.projected_away_points === "number") {
          const actualMarginHome = fh - fa;
          const projMarginHome = r.projected_home_points - r.projected_away_points;
          acc.mar_err_sum += Math.abs(actualMarginHome - projMarginHome);
          acc.mar_err_n += 1;
        }
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
      picks: a.picks,
      pick_ml_win_pct: a.pml_t > 0 ? (a.pml_w / a.pml_t) * 100 : null,
      pick_spread_win_pct: a.psp_t > 0 ? (a.psp_w / a.psp_t) * 100 : null,
      pick_total_win_pct: a.ptot_t > 0 ? (a.ptot_w / a.ptot_t) * 100 : null,
      avg_edge_pct: a.edge_n > 0 ? a.edge_sum / a.edge_n : null,
      avg_total_abs_error: a.tot_err_n > 0 ? a.tot_err_sum / a.tot_err_n : null,
      avg_margin_abs_error: a.mar_err_n > 0 ? a.mar_err_sum / a.mar_err_n : null,
    }));
}

function truthy(v: any) {
  return v === true || v === 1 || v === "true";
}

function pickEdgePct(r: RawRow) {
  if (typeof r.ev_pct === "number" && Number.isFinite(r.ev_pct)) return r.ev_pct;
  if (typeof r.edge_pct === "number" && Number.isFinite(r.edge_pct)) return r.edge_pct;
  if (typeof r.edge === "number" && Number.isFinite(r.edge)) return r.edge;
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

function bestPickRate(pml: number | null, psp: number | null, ptot: number | null) {
  const vals = [pml, psp, ptot].filter((v) => typeof v === "number" && Number.isFinite(v)) as number[];
  if (vals.length === 0) return null;
  return Math.max(...vals);
}
