import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  Anchor,
  Calculator,
  Database,
  DollarSign,
  Flame,
  RefreshCw,
  Target,
  TrendingUp,
  Trophy,
  Sparkles,
} from "lucide-react";
import { supabase } from "../../lib/supabaseClient";

/**
 * OVERVIEW / HOME (LIVE)
 *
 * ✅ Engaging home screen (Top Plays + Quick Actions + Live Health)
 * ✅ Game +EV plays from public.ev_plays
 * ✅ Player prop +EV plays from public.player_prop_ev_latest
 * ✅ Model meta from model_versions (optional)
 * ✅ Changelog from model_changelog (optional)
 * ✅ Latest MC run from monte_carlo_runs (required if MC runs)
 * ✅ Realtime soft refresh
 */

type MonteCarloRunRow = {
  id: string;
  created_at: string;
  sport_key: string;
};

type ModelVersionRow = {
  version: string;
  release_date: string | null;
  status: string | null;
  simulations: number | null;
  calib_window: string | null;
  anchor_weight_min: number | null;
  anchor_weight_max: number | null;
  min_ev_threshold: number | null; // stored as fraction (0.025)
  updated_at: string | null;
};

type ChangeLogRow = {
  version: string;
  date: string | null;
  changes: string[];
};

type EvPlayRow = {
  // we keep these loose because your schema has evolved across screens
  id?: string;
  run_id?: string;
  sport_key?: string;
  event_id?: string;
  commence_time?: string | null;
  home_team?: string | null;
  away_team?: string | null;

  market?: string | null; // h2h / spreads / totals
  side?: string | null; // home/away/over/under
  pick?: string | null; // label used on UI
  line?: number | null;
  odds?: number | null;
  bookmaker?: string | null;

  ev_pct?: number | null; // sometimes stored as 1.2 = 1.2%
  ev?: number | null; // fallback
  score?: number | null; // PrismScore / VersaScore
  bet_fraction?: number | null;
  bet_amount?: number | null;
};

type PropEvRow = {
  id?: string;
  sport_key?: string;
  event_id?: string;
  commence_time?: string | null;

  player_name?: string | null;
  team?: string | null;
  position?: string | null;
  picture_url?: string | null;

  market?: string | null; // points / rebounds / assists / threes
  side?: string | null; // over/under
  line?: number | null;
  odds?: number | null;
  bookmaker?: string | null;

  ev_pct?: number | null;
  ev?: number | null;
  score?: number | null;
};

/* =========================================================
   CONSTANTS
========================================================= */

const GOLD = "#d4af37";

type PlayTab = "all" | "game" | "props";

/* =========================================================
   SCREEN
========================================================= */

export function OverviewScreen() {
  const [loading, setLoading] = useState(true);
  const [loadingSoft, setLoadingSoft] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [latestRun, setLatestRun] = useState<MonteCarloRunRow | null>(null);
  const [latestVersion, setLatestVersion] = useState<ModelVersionRow | null>(null);
  const [changelog, setChangelog] = useState<ChangeLogRow[]>([]);

  const [evPlays, setEvPlays] = useState<EvPlayRow[]>([]);
  const [propPlays, setPropPlays] = useState<PropEvRow[]>([]);

  const [tab, setTab] = useState<PlayTab>("all");

  async function loadAll({ soft }: { soft?: boolean } = {}) {
    try {
      soft ? setLoadingSoft(true) : setLoading(true);
      setError(null);

      // Latest run (drives sport_key on the home screen)
      const runQ = supabase
        .from("monte_carlo_runs")
        .select("id,created_at,sport_key")
        .order("created_at", { ascending: false })
        .limit(1);

      // Model meta (optional)
      const versionQ = supabase
        .from("model_versions")
        .select(
          "version,release_date,status,simulations,calib_window,anchor_weight_min,anchor_weight_max,min_ev_threshold,updated_at"
        )
        .order("release_date", { ascending: false })
        .limit(1);

      // Changelog (optional)
      const changelogQ = supabase
        .from("model_changelog")
        .select("version,date,changes")
        .order("date", { ascending: false })
        .limit(5);

      // Pull a bigger slice and rank client-side because schemas vary
      const evQ = supabase
        .from("ev_plays")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(150);

      const propsQ = supabase
        .from("player_prop_ev_latest")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(150);

      const [runRes, versionRes, changelogRes, evRes, propsRes] = await Promise.all([
        runQ,
        versionQ,
        changelogQ,
        evQ,
        propsQ,
      ]);

      if (runRes.error) throw runRes.error;
      setLatestRun((runRes.data?.[0] ?? null) as any);

      if (versionRes.error) {
        console.warn("[Overview] model_versions query failed:", versionRes.error.message);
        setLatestVersion(null);
      } else {
        setLatestVersion((versionRes.data?.[0] ?? null) as any);
      }

      if (changelogRes.error) {
        console.warn("[Overview] model_changelog query failed:", changelogRes.error.message);
        setChangelog([]);
      } else {
        setChangelog((changelogRes.data ?? []) as any);
      }

      if (evRes.error) {
        console.warn("[Overview] ev_plays query failed:", evRes.error.message);
        setEvPlays([]);
      } else {
        setEvPlays((evRes.data ?? []) as any);
      }

      if (propsRes.error) {
        console.warn("[Overview] player_prop_ev_latest query failed:", propsRes.error.message);
        setPropPlays([]);
      } else {
        setPropPlays((propsRes.data ?? []) as any);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // realtime (soft refresh)
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
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ev_plays" },
        () => loadAll({ soft: true })
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "player_prop_ev_latest" },
        () => loadAll({ soft: true })
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* =========================================================
     DERIVED
  ========================================================= */

  const activeSport = latestRun?.sport_key ?? null;

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
      status: latestVersion?.status ?? "—",
      updatedAt: latestVersion?.updated_at ? formatTsShort(latestVersion.updated_at) : null,

      sims: sims != null ? formatInt(sims) : "—",
      calibWindow: latestVersion?.calib_window ?? "—",
      anchorWeight: anchorRange,
      minEv: minEvPct,
    };
  }, [latestVersion]);

  // Normalize EV field (you have ev_pct in some tables and ev in others)
  const getEvPct = (row: { ev_pct?: number | null; ev?: number | null }) => {
    const v = row.ev_pct ?? row.ev ?? null;
    if (v == null) return null;
    // if it looks like a fraction (0.04), convert to percent
    if (Math.abs(v) <= 1) return v * 100;
    return v;
  };

  const getScore = (row: { score?: number | null }) => {
    const s = row.score ?? null;
    if (s == null) return null;
    // cap for safety
    return Math.max(0, Math.min(100, s));
  };

  const isFutureish = (ts?: string | null) => {
    if (!ts) return true;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return true;
    return d.getTime() > Date.now() - 3 * 60 * 60 * 1000; // allow slight drift
  };

  // filter to active sport if we have it; otherwise show everything
  const evFiltered = useMemo(() => {
    const base = (evPlays ?? [])
      .filter((r) => (activeSport ? r.sport_key === activeSport : true))
      .filter((r) => isFutureish(r.commence_time ?? null));

    return base;
  }, [evPlays, activeSport]);

  const propsFiltered = useMemo(() => {
    const base = (propPlays ?? [])
      .filter((r) => (activeSport ? r.sport_key === activeSport : true))
      .filter((r) => isFutureish(r.commence_time ?? null));
    return base;
  }, [propPlays, activeSport]);

  // rank by Score first, then EV%
  const topGames = useMemo(() => {
    const ranked = [...evFiltered].sort((a, b) => {
      const sa = getScore(a) ?? -1;
      const sb = getScore(b) ?? -1;
      if (sb !== sa) return sb - sa;
      const ea = getEvPct(a) ?? -999;
      const eb = getEvPct(b) ?? -999;
      return eb - ea;
    });
    return ranked.slice(0, 6);
  }, [evFiltered]);

  const topProps = useMemo(() => {
    const ranked = [...propsFiltered].sort((a, b) => {
      const sa = getScore(a) ?? -1;
      const sb = getScore(b) ?? -1;
      if (sb !== sa) return sb - sa;
      const ea = getEvPct(a) ?? -999;
      const eb = getEvPct(b) ?? -999;
      return eb - ea;
    });
    return ranked.slice(0, 6);
  }, [propsFiltered]);

  const topAll = useMemo(() => {
    // merge into a unified “top” strip
    const merged: Array<
      | { kind: "game"; row: EvPlayRow }
      | { kind: "prop"; row: PropEvRow }
    > = [
      ...topGames.map((r) => ({ kind: "game" as const, row: r })),
      ...topProps.map((r) => ({ kind: "prop" as const, row: r })),
    ];

    // rank again globally
    merged.sort((a, b) => {
      const sa = getScore(a.row as any) ?? -1;
      const sb = getScore(b.row as any) ?? -1;
      if (sb !== sa) return sb - sa;
      const ea = getEvPct(a.row as any) ?? -999;
      const eb = getEvPct(b.row as any) ?? -999;
      return eb - ea;
    });

    return merged.slice(0, 8);
  }, [topGames, topProps]);

  const heroStats = useMemo(() => {
    const gameCount = evFiltered.length;
    const propCount = propsFiltered.length;

    const best = topAll[0];
    const bestScore = best ? getScore(best.row as any) : null;

    const freshness = latestRun?.created_at ? timeAgo(latestRun.created_at) : "—";

    return { gameCount, propCount, bestScore, freshness };
  }, [evFiltered.length, propsFiltered.length, topAll, latestRun?.created_at]);

  const pipeline = useMemo(() => {
    const sims = latestVersion?.simulations ?? 10000;
    return [
      { icon: Database, label: "Odds", sub: "Books + snapshots" },
      { icon: Calculator, label: "Monte Carlo", sub: `${formatInt(sims)} sims` },
      { icon: Anchor, label: "Anchor", sub: "Sharp market" },
      { icon: DollarSign, label: "No-vig", sub: "True odds" },
      { icon: Target, label: "EV", sub: "Edge scan" },
      { icon: TrendingUp, label: "Track", sub: "Results" },
    ];
  }, [latestVersion?.simulations]);

  const playsToRender = useMemo(() => {
    if (tab === "game") {
      return topGames.map((r) => ({ kind: "game" as const, row: r }));
    }
    if (tab === "props") {
      return topProps.map((r) => ({ kind: "prop" as const, row: r }));
    }
    return topAll;
  }, [tab, topAll, topGames, topProps]);

  /* =========================================================
     RENDER
  ========================================================= */

  return (
    <div className="space-y-10">
      {/* =====================================================
         HERO — MAKE IT FEEL LIKE A PRODUCT
      ====================================================== */}
      <div className="relative overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] p-6">
        <div
          className="pointer-events-none absolute inset-0 opacity-95"
          style={{
            background:
              "radial-gradient(900px 260px at 18% 0%, rgba(212,175,55,0.20), transparent 62%), radial-gradient(700px 240px at 85% 12%, rgba(255,255,255,0.05), transparent 60%)",
          }}
        />

        <div className="relative space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-1 text-[11px] text-[#b0b0b0]">
                <Sparkles className="w-3 h-3 text-[#d4af37]" />
                Prism Command Center
              </div>

              <h2 className="text-2xl text-white mt-3 mb-2 tracking-tight">
                Today’s Best Edges — Live
              </h2>

              <p className="text-sm text-[#b0b0b0] leading-relaxed max-w-3xl">
                Your top-rated +EV plays, powered by Monte Carlo simulation, sharp anchoring, and no-vig pricing.
                If it’s here, it’s because the model sees **real edge**.
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
                <StatusPill
                  label="Latest Run"
                  value={latestRun?.created_at ? `${formatTsShort(latestRun.created_at)} • ${heroStats.freshness}` : loading ? "Loading…" : "—"}
                />
                <StatusPill label="Sport" value={latestRun?.sport_key ?? "—"} />
                <StatusPill label="Game edges" value={loading ? "…" : String(heroStats.gameCount)} />
                <StatusPill label="Prop edges" value={loading ? "…" : String(heroStats.propCount)} />
                <StatusPill
                  label="Best score"
                  value={heroStats.bestScore == null ? "—" : `${heroStats.bestScore.toFixed(0)}/100`}
                />

                <div className="ml-1 inline-flex items-center gap-1 text-[#606060]">
                  <Activity className="w-3 h-3" />
                  Live
                </div>
              </div>
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

          {error ? (
            <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] p-3 text-xs text-red-300">
              Supabase error: {error}
            </div>
          ) : null}

          {/* Quick Actions */}
          <div className="mt-2 grid grid-cols-3 gap-3">
            <QuickAction
              title="Odds"
              sub="Market grid + history"
              icon={Database}
              onClick={() => (window.location.href = "/odds")}
            />
            <QuickAction
              title="Monte Carlo"
              sub="Projected scores + win%"
              icon={Calculator}
              onClick={() => (window.location.href = "/monte-carlo")}
            />
            <QuickAction
              title="Model Picks"
              sub="Best +EV plays"
              icon={Trophy}
              onClick={() => (window.location.href = "/model")}
            />
          </div>
        </div>
      </div>

      {/* =====================================================
         TOP PLAYS
      ====================================================== */}
      <section>
        <div className="flex items-end justify-between gap-3 mb-4">
          <div>
            <h3 className="text-base text-white">Top Plays Right Now</h3>
            <div className="text-xs text-[#606060]">
              Ranked by Score first, then EV%. Updates live as your pipeline runs.
            </div>
          </div>

          <Segmented value={tab} onChange={setTab} />
        </div>

        <div className="grid grid-cols-4 gap-3">
          {loading ? (
            <>
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </>
          ) : playsToRender.length === 0 ? (
            <div className="col-span-4 rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] p-5 text-sm text-[#b0b0b0]">
              No top plays found for the current filter.
              <div className="text-xs text-[#606060] mt-1">
                If this is unexpected, check that <span className="text-white">ev_plays</span> and{" "}
                <span className="text-white">player_prop_ev_latest</span> are being populated for upcoming events.
              </div>
            </div>
          ) : (
            playsToRender.map((p, idx) => {
              const ev = getEvPct(p.row as any);
              const score = getScore(p.row as any);

              const isTop3 = idx < 3;
              return (
                <TopPlayCard
                  key={`${p.kind}-${(p.row as any).id ?? idx}`}
                  kind={p.kind}
                  row={p.row as any}
                  rank={idx + 1}
                  isTop3={isTop3}
                  ev={ev}
                  score={score}
                />
              );
            })
          )}
        </div>
      </section>

      {/* =====================================================
         PIPELINE + MODEL META (FEELS PREMIUM)
      ====================================================== */}
      <section className="grid grid-cols-3 gap-4">
        {/* Pipeline */}
        <div className="col-span-2 rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-base text-white">Processing Pipeline</div>
              <div className="text-xs text-[#606060]">How an edge becomes a play.</div>
            </div>
            <div className="text-[11px] text-[#808080]">
              Model{" "}
              <span className={meta.status === "Production" ? "text-emerald-500" : "text-[#d4af37]"}>
                {meta.status}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between">
            {pipeline.map((step, i) => (
              <div key={step.label} className="flex items-center flex-1 min-w-0">
                <PipelineStep icon={step.icon} label={step.label} sublabel={step.sub} />
                {i < pipeline.length - 1 ? (
                  <ArrowRight className="w-5 h-5 text-[#505050] flex-shrink-0 mx-2" />
                ) : null}
              </div>
            ))}
          </div>
        </div>

        {/* Model meta */}
        <div className="rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="text-base text-white">Model</div>
            <div className="text-[11px] text-[#606060]">
              {meta.updatedAt ? `Updated ${meta.updatedAt}` : ""}
            </div>
          </div>

          <div className="space-y-2 text-xs">
            <MetaLine label="Version" value={meta.version} warn={meta.version === "—"} />
            <MetaLine label="Simulations" value={meta.sims} />
            <MetaLine label="Calibration" value={meta.calibWindow} />
            <MetaLine label="Anchor Weight" value={meta.anchorWeight} />
            <MetaLine label="Min EV" value={meta.minEv} />
          </div>

          {meta.version === "—" ? (
            <div className="mt-3 text-[11px] text-[#606060]">
              Add a row to <span className="text-white">model_versions</span> to populate metadata.
            </div>
          ) : null}
        </div>
      </section>

      {/* =====================================================
         WHAT CHANGED
      ====================================================== */}
      <section>
        <h3 className="text-base text-white mb-4">What Changed</h3>
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl divide-y divide-[#2a2a2a]">
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
      </section>
    </div>
  );
}

/* =========================================================
   TOP PLAY CARD
========================================================= */

function TopPlayCard({
  kind,
  row,
  rank,
  isTop3,
  ev,
  score,
}: {
  kind: "game" | "prop";
  row: any;
  rank: number;
  isTop3: boolean;
  ev: number | null;
  score: number | null;
}) {
  const book = normalizeBook(row.bookmaker);
  const evText = ev == null ? "—" : `${ev.toFixed(1)}%`;
  const scoreText = score == null ? "—" : `${score.toFixed(0)}`;

  const headerTag =
    kind === "prop"
      ? `${titleCase(row.market ?? "Prop")}`
      : `${marketLabel(row.market ?? "")}`;

  const title =
    kind === "prop"
      ? `${row.player_name ?? "Unknown Player"}`
      : `${abbr(row.away_team ?? "Away")} vs ${abbr(row.home_team ?? "Home")}`;

  const subtitle =
    kind === "prop"
      ? `${abbr(row.team ?? "")} • ${row.side?.toUpperCase?.() ?? ""} ${fmtLine(row.line)}`
      : `${headerTag} • ${pickLabel(row)}`;

  const commence = row.commence_time ? formatTsShort(row.commence_time) : null;

  return (
    <div className="relative overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] p-4">
      {/* glow for top 3 */}
      {isTop3 ? (
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background:
              "radial-gradient(520px 200px at 30% 0%, rgba(212,175,55,0.22), transparent 60%)",
          }}
        />
      ) : null}

      <div className="relative space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="inline-flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] flex items-center justify-center"
              title={`Rank #${rank}`}
            >
              {isTop3 ? (
                <Flame className="w-4 h-4 text-[#d4af37]" />
              ) : (
                <Trophy className="w-4 h-4 text-[#808080]" />
              )}
            </div>

            <div>
              <div className="text-[11px] text-[#808080]">{kind === "prop" ? "Player Prop" : "Game Line"}</div>
              <div className="text-sm text-white leading-tight">{title}</div>
            </div>
          </div>

          <div className="text-right">
            <div className="text-[10px] text-[#606060]">Score</div>
            <div className="text-sm text-white">{scoreText}</div>
          </div>
        </div>

        <div className="text-xs text-[#b0b0b0] leading-relaxed">
          {subtitle}
        </div>

        <div className="grid grid-cols-3 gap-2 text-xs">
          <MiniStat label="EV" value={evText} accent />
          <MiniStat label="Book" value={book ?? "—"} />
          <MiniStat label="Odds" value={fmtOdds(row.odds)} />
        </div>

        {commence ? (
          <div className="text-[11px] text-[#606060]">
            {commence}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* =========================================================
   UI BITS
========================================================= */

function QuickAction({
  title,
  sub,
  icon: Icon,
  onClick,
}: {
  title: string;
  sub: string;
  icon: any;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-xl border border-[#2a2a2a] bg-[#0b0b0b] p-4 hover:border-[#3a3a3a] transition-colors"
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-white">{title}</div>
          <div className="text-xs text-[#606060] mt-0.5">{sub}</div>
        </div>
        <div className="w-9 h-9 rounded-lg bg-[#141414] border border-[#d4af37]/25 flex items-center justify-center">
          <Icon className="w-4 h-4 text-[#d4af37]" />
        </div>
      </div>
    </button>
  );
}

function Segmented({ value, onChange }: { value: PlayTab; onChange: (v: PlayTab) => void }) {
  const btn = (v: PlayTab, label: string) => {
    const active = value === v;
    return (
      <button
        type="button"
        onClick={() => onChange(v)}
        className={[
          "px-3 py-1.5 rounded-lg text-xs border transition-colors",
          active ? "bg-[#141414] border-[#d4af37]/40 text-white" : "bg-[#0b0b0b] border-[#2a2a2a] text-[#b0b0b0] hover:text-white hover:border-[#3a3a3a]",
        ].join(" ")}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="inline-flex items-center gap-2">
      {btn("all", "All")}
      {btn("game", "Game Lines")}
      {btn("props", "Props")}
    </div>
  );
}

function StatusPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-1">
      <div className="text-[11px] text-[#808080]">{label}</div>
      <div className="text-[11px] font-medium text-white">{value}</div>
    </div>
  );
}

function PipelineStep({ icon: Icon, label, sublabel }: { icon: any; label: string; sublabel: string }) {
  return (
    <div className="flex flex-col items-center flex-1 min-w-0">
      <div className="w-12 h-12 bg-[#141414] border border-[#d4af37]/30 rounded-lg flex items-center justify-center mb-2">
        <Icon className="w-5 h-5 text-[#d4af37]" />
      </div>
      <div className="text-xs text-white text-center mb-0.5">{label}</div>
      <div className="text-[10px] text-[#606060] text-center">{sublabel}</div>
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] px-2 py-2">
      <div className="text-[10px] text-[#606060]">{label}</div>
      <div className={["text-xs mt-0.5", accent ? "text-[#d4af37]" : "text-white"].join(" ")}>
        {value}
      </div>
    </div>
  );
}

function MetaLine({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <div className="text-[#808080]">{label}</div>
      <div className={["text-white", warn ? "text-amber-300" : ""].join(" ")}>{value}</div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] p-4">
      <div className="animate-pulse space-y-3">
        <div className="h-4 w-2/3 bg-[#1a1a1a] rounded" />
        <div className="h-3 w-1/2 bg-[#1a1a1a] rounded" />
        <div className="grid grid-cols-3 gap-2">
          <div className="h-10 bg-[#1a1a1a] rounded" />
          <div className="h-10 bg-[#1a1a1a] rounded" />
          <div className="h-10 bg-[#1a1a1a] rounded" />
        </div>
      </div>
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

/* =========================================================
   HELPERS
========================================================= */

function normalizeBook(b?: string | null) {
  if (!b) return null;
  const x = String(b).toLowerCase();
  if (x.includes("draft")) return "DraftKings";
  if (x.includes("fanduel")) return "FanDuel";
  if (x.includes("mgm")) return "BetMGM";
  if (x.includes("pinnacle") || x === "pin") return "Pinnacle";
  if (x.includes("betonline")) return "BetOnline";
  return b;
}

function marketLabel(m?: string | null) {
  const x = (m ?? "").toLowerCase();
  if (x === "h2h" || x.includes("money")) return "Moneyline";
  if (x.includes("spread")) return "Spread";
  if (x.includes("total")) return "Total";
  return m ?? "Market";
}

function pickLabel(row: any) {
  // try "pick" first, fallback to side/team
  if (row.pick) return String(row.pick);
  const side = (row.side ?? "").toUpperCase();
  const line = fmtLine(row.line);
  return [side, line].filter(Boolean).join(" ");
}

function fmtOdds(odds?: number | null) {
  if (odds == null) return "—";
  const n = Number(odds);
  if (Number.isNaN(n)) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtLine(line?: number | null) {
  if (line == null) return "";
  const n = Number(line);
  if (Number.isNaN(n)) return "";
  return n > 0 ? `+${n}` : `${n}`;
}

function abbr(name: string) {
  const t = (name ?? "").trim();
  if (!t) return "";
  // if you already store abbreviations elsewhere, keep this as a safe fallback
  return t.length <= 3 ? t.toUpperCase() : t.slice(0, 3).toUpperCase();
}

function titleCase(s: string) {
  return String(s)
    .replace(/_/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

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

function timeAgo(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

