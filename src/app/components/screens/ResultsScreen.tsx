import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { Activity, CalendarDays, CheckCircle2, XCircle } from "lucide-react";

/**
 * ResultsScreen.tsx — FULL REWRITE (Uses public.game_model_results + Prism visual style)
 * ------------------------------------------------------------------------------------
 * ✅ Pulls last 7 days DIRECTLY from public.game_model_results (no view needed)
 * ✅ Uses model_ml_hit (already computed in DB) + coverage = graded finals
 * ✅ Shows ML / Spread / Total daily hit rates (all from game_model_results)
 * ✅ Matches app vibe: dark glass panels, gold accents, subtle gradient header, tighter type
 */

type DailyRow = {
  day: string; // YYYY-MM-DD
  games: number;
  coverage: number; // graded finals count
  ml_win_pct: number | null; // percent (0-100)
  spread_win_pct: number | null;
  total_win_pct: number | null;
};

export function ResultsScreen() {
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    async function load() {
      setLoading(true);
      setError(null);

      // last 7 calendar days (inclusive)
      const from = new Date();
      from.setDate(from.getDate() - 6);
      const fromStr = from.toISOString().slice(0, 10);

      // Pull only needed fields for the last 7 days.
      // We compute daily aggregation client-side for simplicity + speed (small dataset).
      const { data, error } = await supabase
        .from("game_model_results")
        .select(
          "game_date,status,model_ml_hit,model_spread_hit,model_total_hit"
        )
        .gte("game_date", fromStr)
        .order("game_date", { ascending: true });

      if (!alive) return;

      if (error) {
        setError(error.message);
        setRows([]);
        setLoading(false);
        return;
      }

      const d = (data ?? []) as Array<{
        game_date: string | null;
        status: string | null;
        model_ml_hit: boolean | null;
        model_spread_hit: "win" | "loss" | "push" | null;
        model_total_hit: "win" | "loss" | "push" | null;
      }>;

      // Aggregate by day
      const map = new Map<
        string,
        {
          games: number;
          coverage: number;

          ml_w: number;
          ml_t: number;

          sp_w: number;
          sp_t: number;

          tot_w: number;
          tot_t: number;
        }
      >();

      for (const r of d) {
        const day = r.game_date;
        if (!day) continue;

        const key = day;
        if (!map.has(key)) {
          map.set(key, {
            games: 0,
            coverage: 0,
            ml_w: 0,
            ml_t: 0,
            sp_w: 0,
            sp_t: 0,
            tot_w: 0,
            tot_t: 0,
          });
        }

        const acc = map.get(key)!;
        acc.games += 1;

        const isFinal = r.status === "final";
        if (isFinal) acc.coverage += 1;

        // ML (only count rows where model_ml_hit is non-null AND final)
        if (isFinal && typeof r.model_ml_hit === "boolean") {
          acc.ml_t += 1;
          if (r.model_ml_hit) acc.ml_w += 1;
        }

        // Spread (count only final rows with win/loss/push; include push in denom)
        if (isFinal && r.model_spread_hit) {
          acc.sp_t += 1;
          if (r.model_spread_hit === "win") acc.sp_w += 1;
        }

        // Total
        if (isFinal && r.model_total_hit) {
          acc.tot_t += 1;
          if (r.model_total_hit === "win") acc.tot_w += 1;
        }
      }

      const out: DailyRow[] = Array.from(map.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, a]) => ({
          day,
          games: a.games,
          coverage: a.coverage,
          ml_win_pct: a.ml_t > 0 ? (a.ml_w / a.ml_t) * 100 : null,
          spread_win_pct: a.sp_t > 0 ? (a.sp_w / a.sp_t) * 100 : null,
          total_win_pct: a.tot_t > 0 ? (a.tot_w / a.tot_t) * 100 : null,
        }));

      setRows(out);
      setLoading(false);
    }

    load();

    // Realtime refresh (underlying tables; views won't trigger reliably)
    const channel = supabase
      .channel("results-game-model-results")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "game_model_results" },
        () => load()
      )
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, []);

  const summary = useMemo(() => {
    const totalGames = rows.reduce((sum, r) => sum + (r.games ?? 0), 0);
    const totalCoverage = rows.reduce((sum, r) => sum + (r.coverage ?? 0), 0);

    // Weighted averages by graded sample size (coverage-like denominators)
    const ml = weightedPct(rows, (r) => r.ml_win_pct, (r) => r.coverage);
    const sp = weightedPct(rows, (r) => r.spread_win_pct, (r) => r.coverage);
    const tot = weightedPct(rows, (r) => r.total_win_pct, (r) => r.coverage);

    return { totalGames, totalCoverage, ml, sp, tot };
  }, [rows]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="rounded-xl border border-white/10 bg-gradient-to-b from-white/[0.08] to-white/[0.03] p-4 md:p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <div className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/5 border border-white/10">
                <Activity className="h-4 w-4 text-[#d4af37]" />
              </div>
              <h2 className="text-white text-lg md:text-xl font-semibold tracking-tight">
                Results
              </h2>
            </div>
            <p className="mt-1 text-xs text-white/50">
              Last 7 days · Model hit rate (ML / Spread / Total) from{" "}
              <span className="text-white/70">game_model_results</span>
            </p>
          </div>

          <div className="hidden md:flex items-center gap-2 text-[10px] text-white/45">
            <CalendarDays className="h-3.5 w-3.5" />
            <span>America/Chicago</span>
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-xs text-red-200">
          Supabase error: {error}
        </div>
      ) : null}

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <SummaryCard
          label="Games"
          value={loading ? "…" : formatInt(summary.totalGames)}
          sublabel="7-day rows"
        />
        <SummaryCard
          label="Coverage"
          value={loading ? "…" : formatInt(summary.totalCoverage)}
          sublabel="Finals graded"
        />
        <SummaryCard
          label="ML"
          value={loading ? "…" : fmtPct1(summary.ml)}
          sublabel="Winner hit%"
          positive={summary.ml != null ? summary.ml >= 52.38 : undefined}
        />
        <SummaryCard
          label="Spread"
          value={loading ? "…" : fmtPct1(summary.sp)}
          sublabel="ATS hit%"
          positive={summary.sp != null ? summary.sp >= 52.38 : undefined}
        />
        <SummaryCard
          label="Total"
          value={loading ? "…" : fmtPct1(summary.tot)}
          sublabel="O/U hit%"
          positive={summary.tot != null ? summary.tot >= 52.38 : undefined}
        />
      </div>

      {/* Table */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-white/[0.04] border-b border-white/10">
                <th className="text-left p-3 text-white/50 font-medium">
                  Date
                </th>
                <th className="text-center p-3 text-white/50 font-medium">
                  Games
                </th>
                <th className="text-center p-3 text-white/50 font-medium">
                  Coverage
                </th>
                <th className="text-center p-3 text-[#d4af37] font-medium border-l border-white/10">
                  ML
                </th>
                <th className="text-center p-3 text-[#d4af37] font-medium">
                  Spread
                </th>
                <th className="text-center p-3 text-[#d4af37] font-medium">
                  Total
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-white/5">
              {loading ? (
                <tr>
                  <td className="p-3 text-white/60" colSpan={6}>
                    Loading results…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td className="p-3 text-white/60" colSpan={6}>
                    No rows found in{" "}
                    <span className="text-white">game_model_results</span> for
                    the last 7 days.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.day}
                    className="hover:bg-white/[0.03] transition-colors"
                  >
                    <td className="p-3 text-white">
                      {fmtDay(r.day)}
                      <div className="text-[10px] text-white/40 mt-0.5">
                        {new Date(r.day).toLocaleDateString("en-US", {
                          weekday: "short",
                        })}
                      </div>
                    </td>

                    <td className="text-center p-3 text-white/70">
                      {r.games ?? 0}
                    </td>

                    <td className="text-center p-3 text-white/70">
                      {r.coverage == null ? (
                        <span className="text-white/40">—</span>
                      ) : (
                        <CoveragePill
                          coverage={r.coverage}
                          games={r.games ?? 0}
                        />
                      )}
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
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Explanation */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <h3 className="text-sm text-white font-semibold mb-2">
          What this measures
        </h3>

        <div className="text-xs text-white/60 leading-relaxed space-y-2">
          <div>
            <span className="text-[#d4af37] font-medium">ML</span> grades whether
            the model’s projected winner (based on projected home vs away points)
            matched the actual winner.
          </div>
          <div>
            <span className="text-[#d4af37] font-medium">Spread</span> grades the
            model’s implied ATS side using the close line{" "}
            <span className="text-white/70">spread_line_home</span>.
          </div>
          <div>
            <span className="text-[#d4af37] font-medium">Total</span> grades the
            model’s implied over/under using{" "}
            <span className="text-white/70">total_line</span>.
          </div>
          <div className="text-[10px] text-white/35 pt-1">
            Context: break-even at -110 ≈ 52.38%
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------
   UI bits
--------------------------- */

function SummaryCard({
  label,
  value,
  sublabel,
  positive,
}: {
  label: string;
  value: string;
  sublabel: string;
  positive?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="text-[10px] text-white/45 mb-1">{label}</div>
      <div
        className={[
          "text-lg md:text-xl font-semibold tracking-tight mb-1",
          positive === undefined
            ? "text-white"
            : positive
            ? "text-[#d4af37]"
            : "text-white",
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
        good
          ? "bg-[#d4af37]/10 border-[#d4af37]/25 text-[#d4af37]"
          : "bg-white/5 border-white/10 text-white/70",
      ].join(" ")}
    >
      {good ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <XCircle className="h-3 w-3 text-white/35" />
      )}
      {coverage}/{games}
    </span>
  );
}

function PctCell({ value }: { value: number | null }) {
  if (value == null || !Number.isFinite(value)) {
    return <div className="text-white/40">—</div>;
  }

  const isGood = value >= 52.38;
  return (
    <div className={isGood ? "text-[#d4af37] font-semibold" : "text-white"}>
      {value.toFixed(1)}%
    </div>
  );
}

/* ---------------------------
   helpers
--------------------------- */

function weightedPct<T>(
  rows: T[],
  getPct: (r: T) => number | null,
  getWeight: (r: T) => number
) {
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

function fmtPct1(v: number | null) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}%`;
}

function formatInt(n: number) {
  if (!Number.isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat().format(n);
  } catch {
    return String(n);
  }
}

function fmtDay(day: string) {
  try {
    return new Date(day).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return day;
  }
}

