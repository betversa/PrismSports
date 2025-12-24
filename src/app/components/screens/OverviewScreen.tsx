import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Database,
  Calculator,
  Anchor,
  DollarSign,
  Target,
  TrendingUp,
  RefreshCw,
} from "lucide-react";
import { supabase } from "../../lib/supabaseClient";

/**
 * OVERVIEW (LIVE, NOT MOCK)
 *
 * Data sources:
 * - monte_carlo_runs: latest run timestamp (always exists if MC runs)
 * - model_versions: latest model meta + params (optional but recommended)
 * - model_changelog: latest change entries (optional but recommended)
 *
 * Live updates:
 * - Realtime subscriptions on all 3 tables (falls back to manual refresh button)
 */

type ModelVersionRow = {
  version: string;
  release_date: string | null; // date/timestamptz
  status: string | null; // "Production"
  simulations: number | null;
  calib_window: string | null; // "Rolling 14d"
  anchor_weight_min: number | null;
  anchor_weight_max: number | null;
  min_ev_threshold: number | null; // recommend storing as fraction (0.025)
  updated_at: string | null;
};

type ChangeLogRow = {
  version: string;
  date: string | null;
  changes: string[]; // text[]
  created_at?: string | null;
};

type MonteCarloRunRow = {
  id: string;
  created_at: string;
  sport_key: string;
};

const GOLD = "#d4af37";

export function OverviewScreen() {
  const [loading, setLoading] = useState(true);
  const [loadingSoft, setLoadingSoft] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [latestRun, setLatestRun] = useState<MonteCarloRunRow | null>(null);
  const [latestVersion, setLatestVersion] = useState<ModelVersionRow | null>(null);
  const [changelog, setChangelog] = useState<ChangeLogRow[]>([]);

  async function loadAll({ soft }: { soft?: boolean } = {}) {
    try {
      if (soft) setLoadingSoft(true);
      else setLoading(true);

      setError(null);

      const runQ = supabase
        .from("monte_carlo_runs")
        .select("id,created_at,sport_key")
        .order("created_at", { ascending: false })
        .limit(1);

      const versionQ = supabase
        .from("model_versions")
        .select(
          "version,release_date,status,simulations,calib_window,anchor_weight_min,anchor_weight_max,min_ev_threshold,updated_at"
        )
        .order("release_date", { ascending: false })
        .limit(1);

      const changelogQ = supabase
        .from("model_changelog")
        .select("version,date,changes,created_at")
        .order("date", { ascending: false })
        .limit(6);

      const [runRes, versionRes, changelogRes] = await Promise.all([runQ, versionQ, changelogQ]);

      if (runRes.error) throw runRes.error;
      setLatestRun((runRes.data?.[0] ?? null) as MonteCarloRunRow | null);

      // model_versions is optional; don't hard-fail the whole page if missing
      if (versionRes.error) {
        console.warn("[Overview] model_versions query failed:", versionRes.error.message);
        setLatestVersion(null);
      } else {
        setLatestVersion((versionRes.data?.[0] ?? null) as ModelVersionRow | null);
      }

      // model_changelog is optional
      if (changelogRes.error) {
        console.warn("[Overview] model_changelog query failed:", changelogRes.error.message);
        setChangelog([]);
      } else {
        setChangelog((changelogRes.data ?? []) as ChangeLogRow[]);
      }
    } catch (e: any) {
      setError(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
      setLoadingSoft(false);
    }
  }

  // initial load
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!alive) return;
      await loadAll();
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // realtime subscriptions: when tables change, soft refresh
  useEffect(() => {
    const channel = supabase
      .channel("overview-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "monte_carlo_runs" },
        () => loadAll({ soft: true })
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "model_versions" },
        () => loadAll({ soft: true })
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "model_changelog" },
        () => loadAll({ soft: true })
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const meta = useMemo(() => {
    const sims = latestVersion?.simulations ?? null;

    const anchorMin = latestVersion?.anchor_weight_min;
    const anchorMax = latestVersion?.anchor_weight_max;

    const minEv = latestVersion?.min_ev_threshold;
    const minEvPct =
      minEv == null
        ? "—"
        : minEv <= 1
        ? `${(minEv * 100).toFixed(1)}%`
        : `${Number(minEv).toFixed(1)}%`;

    const anchorRange =
      anchorMin != null && anchorMax != null
        ? `${anchorMin.toFixed(2)}–${anchorMax.toFixed(2)}`
        : "—";

    return {
      version: latestVersion?.version ?? "—",
      releaseDate: latestVersion?.release_date ? formatDate(latestVersion.release_date) : "—",
      status: latestVersion?.status ?? "—",
      updatedAt: latestVersion?.updated_at ? formatTsShort(latestVersion.updated_at) : null,

      sims: sims != null ? formatInt(sims) : "—",
      calibWindow: latestVersion?.calib_window ?? "—",
      anchorWeight: anchorRange,
      minEv: minEvPct,
    };
  }, [latestVersion]);

  const pipeline = useMemo(() => {
    const sims = latestVersion?.simulations ?? 10000;
    return [
      { icon: Database, label: "Odds Ingestion", sub: "5 Sportsbooks" },
      { icon: Calculator, label: "Monte Carlo", sub: `${formatInt(sims)} Simulations` },
      { icon: Anchor, label: "Market Anchoring", sub: "Sharp Lines" },
      { icon: DollarSign, label: "No-Vig Pricing", sub: "True Probability" },
      { icon: Target, label: "EV Calculation", sub: "Edge Detection" },
      { icon: TrendingUp, label: "Results Tracking", sub: "Performance" },
    ];
  }, [latestVersion?.simulations]);

  return (
    <div className="space-y-8">
      {/* Header / Hero */}
      <div className="relative overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] p-6">
        {/* subtle glow */}
        <div
          className="pointer-events-none absolute inset-0 opacity-90"
          style={{
            background:
              "radial-gradient(900px 220px at 18% 0%, rgba(212,175,55,0.14), transparent 60%), radial-gradient(700px 200px at 82% 10%, rgba(255,255,255,0.05), transparent 60%)",
          }}
        />
        <div className="relative">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl text-white mb-2">PrismSports Overview</h2>
              <p className="text-sm text-[#b0b0b0] leading-relaxed max-w-3xl">
                PrismSports is a quantitative sports betting analytics platform for NCAAB that combines Monte Carlo simulation,
                sharp market anchoring, and no-vig pricing to identify positive expected value (EV) opportunities across moneyline,
                spread, and total markets.
              </p>
            </div>

            <button
              type="button"
              onClick={() => loadAll({ soft: false })}
              className="shrink-0 inline-flex items-center gap-2 rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-2 text-xs text-[#cfcfcf] hover:border-[#3a3a3a] hover:text-white transition-colors"
              title="Refresh"
            >
              <RefreshCw className={["w-4 h-4", loadingSoft ? "animate-spin" : ""].join(" ")} />
              Refresh
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
            <StatusPill
              label="Latest Run"
              value={latestRun?.created_at ? formatTsShort(latestRun.created_at) : loading ? "Loading…" : "—"}
            />
            <StatusPill label="Sport" value={latestRun?.sport_key ?? "N/A"} />
            <StatusPill
              label="Model"
              value={meta.version === "—" ? "No model_versions row" : meta.version}
              warn={meta.version === "—"}
            />
            <div className="text-[#606060]">
              {meta.updatedAt ? `Model updated ${meta.updatedAt}` : ""}
            </div>
          </div>

          {error ? (
            <div className="mt-4 rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] p-3 text-xs text-red-300">
              Supabase error: {error}
            </div>
          ) : null}
        </div>
      </div>

      {/* Pipeline Diagram */}
      <div>
        <h3 className="text-base text-white mb-4">Processing Pipeline</h3>
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
          <div className="flex items-center justify-between">
            {pipeline.map((step, i) => (
              <div key={step.label} className="flex items-center flex-1 min-w-0">
                <PipelineStep icon={step.icon} label={step.label} sublabel={step.sub} />
                {i < pipeline.length - 1 ? (
                  <ArrowRight className="w-5 h-5 text-[#606060] flex-shrink-0 mx-2" />
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Latest Model Version */}
      <div>
        <div className="flex items-end justify-between gap-4">
          <div>
            <h3 className="text-base text-white mb-1">Latest Model Version</h3>
            <div className="text-xs text-[#606060]">
              {loading ? "Loading…" : meta.updatedAt ? `Updated ${meta.updatedAt}` : ""}
            </div>
          </div>

          <div className="text-xs text-[#808080]">
            Status{" "}
            <span className={meta.status === "Production" ? "text-emerald-500" : "text-[#d4af37]"}>
              {meta.status}
            </span>
          </div>
        </div>

        <div className="mt-4 bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
          <div className="grid grid-cols-3 gap-6">
            <MetaStat label="Version" value={meta.version} />
            <MetaStat label="Release Date" value={meta.releaseDate} />
            <MetaStat label="Status" value={meta.status} accent />
          </div>

          <div className="mt-6 pt-6 border-t border-[#2a2a2a]">
            <div className="text-xs text-[#808080] mb-2">Core Parameters</div>
            <div className="grid grid-cols-4 gap-4 text-xs">
              <CoreParam label="Simulations" value={meta.sims} />
              <CoreParam label="Calibration Window" value={meta.calibWindow} />
              <CoreParam label="Anchor Weight" value={meta.anchorWeight} />
              <CoreParam label="Min EV Threshold" value={meta.minEv} />
            </div>

            {meta.version === "—" ? (
              <div className="mt-4 text-[11px] text-[#606060]">
                Add a row to <span className="text-white">model_versions</span> to populate Version/Params automatically.
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* What Changed */}
      <div>
        <h3 className="text-base text-white mb-4">What Changed</h3>
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg divide-y divide-[#2a2a2a]">
          {loading ? (
            <div className="p-4 text-xs text-[#b0b0b0]">Loading changelog…</div>
          ) : changelog.length === 0 ? (
            <div className="p-4 text-xs text-[#b0b0b0]">
              No changelog entries yet. Add rows to <span className="text-white">model_changelog</span>.
            </div>
          ) : (
            changelog.map((entry, idx) => (
              <ChangeLogEntry
                key={`${entry.version}-${idx}`}
                version={entry.version}
                date={entry.date ? formatDate(entry.date) : "—"}
                changes={Array.isArray(entry.changes) ? entry.changes : []}
              />
            ))
          )}
        </div>
      </div>

      {/* Sportsbook Coverage (static for now; make dynamic later if you want) */}
      <div>
        <h3 className="text-base text-white mb-4">Sportsbook Coverage</h3>
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
          <div className="grid grid-cols-5 gap-4 text-center">
            <BookCard name="DraftKings" tag="Primary" />
            <BookCard name="FanDuel" tag="Primary" />
            <BookCard name="BetMGM" tag="Primary" />
            <BookCard name="Pinnacle" tag="Sharp" />
            <BookCard name="BetOnline" tag="Secondary" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* UI bits */

function StatusPill({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-1">
      <div className="text-[11px] text-[#808080]">{label}</div>
      <div className={["text-[11px] font-medium", warn ? "text-amber-300" : "text-white"].join(" ")}>
        {value}
      </div>
    </div>
  );
}

function PipelineStep({ icon: Icon, label, sublabel }: { icon: any; label: string; sublabel: string }) {
  return (
    <div className="flex flex-col items-center flex-1 min-w-0">
      <div className="w-12 h-12 bg-[#1a1a1a] border border-[#d4af37]/30 rounded-lg flex items-center justify-center mb-2">
        <Icon className="w-5 h-5 text-[#d4af37]" />
      </div>
      <div className="text-xs text-white text-center mb-0.5">{label}</div>
      <div className="text-[10px] text-[#606060] text-center">{sublabel}</div>
    </div>
  );
}

function MetaStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-xs text-[#808080] mb-1">{label}</div>
      <div className={["text-sm", accent && value === "Production" ? "text-emerald-500" : "text-white"].join(" ")}>
        {value}
      </div>
    </div>
  );
}

function CoreParam({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-[#606060]">{label}:</span>{" "}
      <span className="text-white">{value}</span>
    </div>
  );
}

function BookCard({ name, tag }: { name: string; tag: string }) {
  return (
    <div className="p-3 bg-[#1a1a1a] rounded">
      <div className="text-xs text-[#d4af37]">{name}</div>
      <div className="text-[10px] text-[#606060] mt-1">{tag}</div>
    </div>
  );
}

function ChangeLogEntry({ version, date, changes }: { version: string; date: string; changes: string[] }) {
  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm text-white">{version}</div>
        <div className="text-xs text-[#606060]">{date}</div>
      </div>
      <ul className="space-y-1.5">
        {changes.map((change, idx) => (
          <li
            key={idx}
            className="text-xs text-[#b0b0b0] pl-4 relative before:content-['•'] before:absolute before:left-0 before:text-[#d4af37]"
          >
            {change}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* helpers */

function formatInt(n: number) {
  try {
    return new Intl.NumberFormat().format(n);
  } catch {
    return String(n);
  }
}

function formatDate(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
}

function formatTsShort(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

