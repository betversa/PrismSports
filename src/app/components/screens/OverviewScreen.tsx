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
  Activity,
} from "lucide-react";
import { supabase } from "../../lib/supabaseClient";

/* =========================================================
   TYPES
========================================================= */

type ModelVersionRow = {
  version: string;
  release_date: string | null;
  status: string | null;
  simulations: number | null;
  calib_window: string | null;
  anchor_weight_min: number | null;
  anchor_weight_max: number | null;
  min_ev_threshold: number | null;
  updated_at: string | null;
};

type ChangeLogRow = {
  version: string;
  date: string | null;
  changes: string[];
};

type MonteCarloRunRow = {
  id: string;
  created_at: string;
  sport_key: string;
};

/* =========================================================
   OVERVIEW SCREEN
========================================================= */

export function OverviewScreen() {
  const [loading, setLoading] = useState(true);
  const [loadingSoft, setLoadingSoft] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [latestRun, setLatestRun] = useState<MonteCarloRunRow | null>(null);
  const [latestVersion, setLatestVersion] = useState<ModelVersionRow | null>(null);
  const [changelog, setChangelog] = useState<ChangeLogRow[]>([]);

  async function loadAll({ soft }: { soft?: boolean } = {}) {
    try {
      soft ? setLoadingSoft(true) : setLoading(true);
      setError(null);

      const runQ = supabase
        .from("monte_carlo_runs")
        .select("id,created_at,sport_key")
        .order("created_at", { ascending: false })
        .limit(1);

      const versionQ = supabase
        .from("model_versions")
        .select("*")
        .order("release_date", { ascending: false })
        .limit(1);

      const changelogQ = supabase
        .from("model_changelog")
        .select("version,date,changes")
        .order("date", { ascending: false })
        .limit(6);

      const [runRes, versionRes, changelogRes] = await Promise.all([
        runQ,
        versionQ,
        changelogQ,
      ]);

      if (runRes.error) throw runRes.error;
      setLatestRun(runRes.data?.[0] ?? null);

      if (!versionRes.error) {
        setLatestVersion(versionRes.data?.[0] ?? null);
      }

      if (!changelogRes.error) {
        setChangelog(changelogRes.data ?? []);
      }
    } catch (e: any) {
      setError(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
      setLoadingSoft(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("overview-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "*" }, () =>
        loadAll({ soft: true })
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  /* =========================================================
     DERIVED META
  ========================================================= */

  const meta = useMemo(() => {
    const minEv = latestVersion?.min_ev_threshold;
    const minEvPct =
      minEv == null ? "—" : `${(minEv * 100).toFixed(1)}%`;

    return {
      version: latestVersion?.version ?? "—",
      status: latestVersion?.status ?? "—",
      sims: latestVersion?.simulations
        ? formatInt(latestVersion.simulations)
        : "—",
      calib: latestVersion?.calib_window ?? "—",
      anchor:
        latestVersion?.anchor_weight_min != null &&
        latestVersion?.anchor_weight_max != null
          ? `${latestVersion.anchor_weight_min.toFixed(
              2
            )}–${latestVersion.anchor_weight_max.toFixed(2)}`
          : "—",
      minEv: minEvPct,
      updated: latestVersion?.updated_at
        ? formatTsShort(latestVersion.updated_at)
        : null,
    };
  }, [latestVersion]);

  const pipeline = [
    { icon: Database, label: "Odds Ingestion", sub: "Multi-book feeds" },
    {
      icon: Calculator,
      label: "Monte Carlo",
      sub: `${meta.sims} simulations`,
    },
    { icon: Anchor, label: "Market Anchoring", sub: "Sharp books" },
    { icon: DollarSign, label: "No-Vig Pricing", sub: "True probabilities" },
    { icon: Target, label: "EV Detection", sub: "Edge discovery" },
    { icon: TrendingUp, label: "Tracking", sub: "Results & ROI" },
  ];

  /* =========================================================
     RENDER
  ========================================================= */

  return (
    <div className="space-y-10">
      {/* =====================================================
         HERO / SYSTEM STATUS
      ====================================================== */}
      <div className="relative overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] p-6">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(800px 240px at 20% 0%, rgba(212,175,55,0.14), transparent 60%)",
          }}
        />

        <div className="relative space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-2xl text-white mb-2">
                Prism Sports Analytics
              </h2>
              <p className="text-sm text-[#b0b0b0] max-w-3xl">
                A live quantitative betting engine combining Monte Carlo
                simulation, sharp-market anchoring, and no-vig pricing to
                surface true expected value across moneyline, spread, and
                totals.
              </p>
            </div>

            <button
              onClick={() => loadAll({ soft: false })}
              className="inline-flex items-center gap-2 rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-2 text-xs text-[#cfcfcf] hover:text-white"
            >
              <RefreshCw
                className={`w-4 h-4 ${loadingSoft ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <StatusPill
              label="Latest Run"
              value={
                latestRun?.created_at
                  ? formatTsShort(latestRun.created_at)
                  : "—"
              }
            />
            <StatusPill
              label="Sport"
              value={latestRun?.sport_key ?? "—"}
            />
            <StatusPill
              label="Model"
              value={meta.version}
              warn={meta.version === "—"}
            />
            <div className="flex items-center gap-1 text-[#606060]">
              <Activity className="w-3 h-3" />
              Live
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] p-3 text-xs text-red-300">
              Supabase error: {error}
            </div>
          )}
        </div>
      </div>

      {/* =====================================================
         PIPELINE
      ====================================================== */}
      <section>
        <h3 className="text-base text-white mb-4">
          How Prism Generates Edges
        </h3>
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
          <div className="flex items-center justify-between">
            {pipeline.map((p, i) => (
              <div key={p.label} className="flex items-center flex-1">
                <PipelineStep {...p} />
                {i < pipeline.length - 1 && (
                  <ArrowRight className="w-5 h-5 mx-2 text-[#505050]" />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* =====================================================
         MODEL PARAMETERS
      ====================================================== */}
      <section>
        <h3 className="text-base text-white mb-4">
          Active Model Parameters
        </h3>
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
          <div className="grid grid-cols-4 gap-4 text-xs">
            <CoreParam label="Version" value={meta.version} />
            <CoreParam label="Status" value={meta.status} />
            <CoreParam label="Simulations" value={meta.sims} />
            <CoreParam label="Min EV" value={meta.minEv} />
            <CoreParam label="Calibration" value={meta.calib} />
            <CoreParam label="Anchor Weight" value={meta.anchor} />
            <CoreParam label="Last Updated" value={meta.updated ?? "—"} />
          </div>
        </div>
      </section>

      {/* =====================================================
         CHANGELOG
      ====================================================== */}
      <section>
        <h3 className="text-base text-white mb-4">What Changed</h3>
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg divide-y divide-[#2a2a2a]">
          {changelog.length === 0 ? (
            <div className="p-4 text-xs text-[#808080]">
              No changelog entries yet.
            </div>
          ) : (
            changelog.map((c, i) => (
              <ChangeLogEntry key={i} {...c} />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

/* =========================================================
   UI PARTS
========================================================= */

function StatusPill({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-1">
      <span className="text-[11px] text-[#808080]">{label}</span>
      <span
        className={`text-[11px] ${
          warn ? "text-amber-300" : "text-white"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function PipelineStep({
  icon: Icon,
  label,
  sub,
}: {
  icon: any;
  label: string;
  sub: string;
}) {
  return (
    <div className="flex flex-col items-center flex-1 min-w-0">
      <div className="w-12 h-12 rounded-lg bg-[#1a1a1a] border border-[#d4af37]/30 flex items-center justify-center mb-2">
        <Icon className="w-5 h-5 text-[#d4af37]" />
      </div>
      <div className="text-xs text-white text-center">{label}</div>
      <div className="text-[10px] text-[#606060] text-center">{sub}</div>
    </div>
  );
}

function CoreParam({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[#606060] mb-0.5">{label}</div>
      <div className="text-white">{value}</div>
    </div>
  );
}

function ChangeLogEntry({
  version,
  date,
  changes,
}: {
  version: string;
  date: string | null;
  changes: string[];
}) {
  return (
    <div className="p-4">
      <div className="flex justify-between mb-2">
        <div className="text-sm text-white">{version}</div>
        <div className="text-xs text-[#606060]">
          {date ? formatDate(date) : "—"}
        </div>
      </div>
      <ul className="space-y-1.5">
        {changes.map((c, i) => (
          <li
            key={i}
            className="text-xs text-[#b0b0b0] pl-4 relative before:content-['•'] before:absolute before:left-0 before:text-[#d4af37]"
          >
            {c}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* =========================================================
   HELPERS
========================================================= */

function formatInt(n: number) {
  return new Intl.NumberFormat().format(n);
}

function formatDate(ts: string) {
  const d = new Date(ts);
  return d.toLocaleDateString([], {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatTsShort(ts: string) {
  const d = new Date(ts);
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}


