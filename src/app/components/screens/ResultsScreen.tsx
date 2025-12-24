import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type ResultsDailyMLRow = {
  day: string; // date (YYYY-MM-DD)
  games: number | null;
  ml_win_pct: number | null; // already in percent (e.g. 55.5)
  coverage: number | null; // count of graded games
};

export function ResultsScreen() {
  const [rows, setRows] = useState<ResultsDailyMLRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load last 7 days from Supabase view: results_daily_ml
  useEffect(() => {
    let alive = true;

    async function load() {
      setLoading(true);
      setError(null);

      // last 7 calendar days (inclusive)
      const from = new Date();
      from.setDate(from.getDate() - 6);
      const fromStr = from.toISOString().slice(0, 10);

      const { data, error } = await supabase
        .from("results_daily_ml")
        .select("day,games,ml_win_pct,coverage")
        .gte("day", fromStr)
        .order("day", { ascending: true });

      if (!alive) return;

      if (error) {
        setError(error.message);
        setRows([]);
      } else {
        setRows((data ?? []) as ResultsDailyMLRow[]);
      }

      setLoading(false);
    }

    load();

    // Optional: realtime refresh if you enabled realtime on the view's underlying tables
    const channel = supabase
      .channel("results-daily-ml")
      .on("postgres_changes", { event: "*", schema: "public", table: "kenpom_games" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "monte_carlo_results" }, () => load())
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, []);

  const summary = useMemo(() => {
    const totalGames = rows.reduce((sum, r) => sum + (r.games ?? 0), 0);
    const totalCoverage = rows.reduce((sum, r) => sum + (r.coverage ?? 0), 0);

    // weighted average win% by games
    let wNum = 0;
    let wDen = 0;
    for (const r of rows) {
      const g = r.games ?? 0;
      const w = r.ml_win_pct;
      if (g > 0 && typeof w === "number" && Number.isFinite(w)) {
        wNum += w * g;
        wDen += g;
      }
    }
    const avgMLWin = wDen > 0 ? wNum / wDen : null;

    return { totalGames, totalCoverage, avgMLWin };
  }, [rows]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl text-white mb-1">Historical Results</h2>
        <p className="text-xs text-[#808080]">Last 7 days · Winner prediction (Monte Carlo)</p>
      </div>

      {error ? (
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4 text-xs text-red-300">
          Supabase error: {error}
        </div>
      ) : null}

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4">
        <SummaryCard label="Total Games" value={loading ? "…" : formatInt(summary.totalGames)} sublabel="7 day period" />
        <SummaryCard
          label="ML Win Rate"
          value={loading ? "…" : fmtPct1(summary.avgMLWin)}
          sublabel="Weighted avg"
          positive={summary.avgMLWin != null ? summary.avgMLWin >= 52.38 : undefined}
        />
        <SummaryCard
          label="Coverage"
          value={loading ? "…" : formatInt(summary.totalCoverage)}
          sublabel="Games graded"
        />
      </div>

      {/* Results Table */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                <th className="text-left p-3 text-[#808080]">Date</th>
                <th className="text-center p-3 text-[#808080]">Games</th>
                <th className="text-center p-3 text-[#d4af37] border-l border-[#2a2a2a]">ML Win %</th>
                <th className="text-center p-3 text-[#d4af37]">Coverage</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#1a1a1a]">
              {loading ? (
                <tr>
                  <td className="p-3 text-[#b0b0b0]" colSpan={4}>
                    Loading results…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td className="p-3 text-[#b0b0b0]" colSpan={4}>
                    No rows found in <span className="text-white">results_daily_ml</span> for the last 7 days.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.day} className="hover:bg-[#0f0f0f]/50 transition-colors">
                    <td className="p-3 text-white">
                      {new Date(r.day).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </td>
                    <td className="text-center p-3 text-[#b0b0b0]">{r.games ?? 0}</td>

                    <td className="text-center p-3 border-l border-[#2a2a2a]">
                      <WinPct value={r.ml_win_pct} />
                    </td>

                    <td className="text-center p-3 text-white">
                      {r.coverage == null ? <span className="text-[#808080]">—</span> : formatInt(r.coverage)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Explanation */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4">
        <h3 className="text-sm text-white mb-2">What this measures</h3>
        <div className="text-xs text-[#b0b0b0] leading-relaxed">
          <span className="text-[#d4af37]">ML Win %</span> is the percentage of games where the Monte Carlo projected winner
          (based on projected margin) matched the actual winner from KenPom final scores.
          <div className="mt-2 text-[10px] text-[#606060]">
            Break-even at -110 odds = 52.38% (for context only).
          </div>
        </div>
      </div>
    </div>
  );
}

/* UI bits */

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
    <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4">
      <div className="text-[10px] text-[#606060] mb-1">{label}</div>
      <div
        className={[
          "text-xl mb-1",
          positive === undefined ? "text-white" : positive ? "text-[#d4af37]" : "text-white",
        ].join(" ")}
      >
        {value}
      </div>
      <div className="text-[10px] text-[#808080]">{sublabel}</div>
    </div>
  );
}

function WinPct({ value }: { value: number | null }) {
  if (value == null || !Number.isFinite(value)) return <div className="text-[#808080]">—</div>;
  const isGood = value >= 52.38;
  return <div className={isGood ? "text-[#d4af37]" : "text-white"}>{value.toFixed(1)}%</div>;
}

/* formatting */

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

