// screens/Overview/OverviewScreen.tsx — FULL REWRITE (Mobile spacing fixed: less crammed, better stacking)
// -----------------------------------------------------------------------------------------------------
// ✅ Top Plays filter: ONLY score >= 50
// ✅ Score === 100 shows 🔥
// ✅ Shows BOTH: Book odds + Quantum fair odds
// ✅ Mobile layout: single-column rhythm, bigger tap targets, stats stack 2x2, less dense text
// ✅ Desktop layout unchanged vibe

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

/* =========================================================
   TYPES
========================================================= */

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
  min_ev_threshold: number | null; // fraction (0.025) or percent (2.5)
  updated_at: string | null;
};

type ChangeLogRow = {
  version: string;
  date: string | null;
  changes: string[];
};

type EvPlayRow = {
  id?: string;
  run_id?: string;
  sport_key?: string;
  event_id?: string;
  commence_time?: string | null;

  matchup?: string | null;
  market?: string | null;
  side?: string | null;
  team?: string | null;
  line?: number | null;

  bookmaker?: string | null;
  book_odds?: number | null;
  odds?: number | null;

  quantum_fair_odds?: number | null;
  fair_odds?: number | null;
  quantum_odds?: number | null;

  ev_pct?: number | null;
  ev?: number | null;
  confidence_score?: number | null;
  score?: number | null;
};

type PropEvRow = {
  id?: string;
  sport_key?: string;
  event_id?: string;
  commence_time?: string | null;

  player_name?: string | null;
  team?: string | null;
  opponent?: string | null;
  position?: string | null;
  picture_url?: string | null;

  market?: string | null;
  side?: string | null;
  line?: number | null;

  book?: string | null;
  bookmaker?: string | null;
  odds?: number | null;

  quantum_fair_odds?: number | null;
  fair_odds?: number | null;
  quantum_odds?: number | null;

  ev_pct?: number | null;
  ev?: number | null;
  score?: number | null;
};

/* =========================================================
   CONSTANTS
========================================================= */

const GOLD = "#d4af37";
type PlayTab = "all" | "game" | "props";
const TOP_SCORE_MIN = 50;

/* =========================================================
   HELPERS
========================================================= */

function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function isFutureish(ts?: string | null) {
  if (!ts) return true;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return true;
  return d.getTime() > Date.now() - 3 * 60 * 60 * 1000;
}

function normalizeBook(b?: string | null) {
  if (!b) return "—";
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
  if (x.includes("points")) return "Points";
  if (x.includes("reb")) return "Rebounds";
  if (x.includes("ast")) return "Assists";
  if (x.includes("three")) return "3PT";
  return m ?? "Market";
}

function titleCase(s: string) {
  return String(s)
    .replace(/_/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function fmtOdds(odds?: number | null) {
  if (odds == null) return "—";
  const n = Math.trunc(Number(odds));
  if (!Number.isFinite(n) || n === 0) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtLine(line?: number | null) {
  const n = safeNum(line);
  if (n == null) return "";
  return n > 0 ? `+${n}` : `${n}`;
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

function getEvPct(row: { ev_pct?: number | null; ev?: number | null }) {
  const v = row.ev_pct ?? row.ev ?? null;
  if (v == null) return null;
  const n = safeNum(v);
  if (n == null) return null;
  if (Math.abs(n) <= 1) return n * 100;
  return n;
}

function getGameScore(row: EvPlayRow) {
  const s = row.confidence_score ?? row.score ?? null;
  const n = safeNum(s);
  if (n == null) return null;
  return clamp(n, 0, 100);
}

function getPropScore(row: PropEvRow) {
  const s = row.score ?? null;
  const n = safeNum(s);
  if (n == null) return null;
  return clamp(n, 0, 100);
}

function getGameOdds(row: EvPlayRow) {
  const o = row.book_odds ?? row.odds ?? null;
  const n = safeNum(o);
  if (n == null) return null;
  return Math.trunc(n);
}

function getPropOdds(row: PropEvRow) {
  const n = safeNum(row.odds);
  if (n == null) return null;
  return Math.trunc(n);
}

function getGameFairOdds(row: EvPlayRow) {
  const o = row.quantum_fair_odds ?? row.fair_odds ?? row.quantum_odds ?? null;
  const n = safeNum(o);
  if (n == null) return null;
  return Math.trunc(n);
}

function getPropFairOdds(row: PropEvRow) {
  const o = row.quantum_fair_odds ?? row.fair_odds ?? row.quantum_odds ?? null;
  const n = safeNum(o);
  if (n == null) return null;
  return Math.trunc(n);
}

/* =========================================================
   DEDUPE
========================================================= */

function keyGamePlay(r: EvPlayRow) {
  return [
    r.event_id ?? "",
    r.matchup ?? "",
    (r.market ?? "").toLowerCase(),
    (r.side ?? "").toLowerCase(),
    r.team ?? "",
    r.line ?? "",
  ].join("|");
}

function keyPropPlay(r: PropEvRow) {
  return [
    r.event_id ?? "",
    (r.player_name ?? "").toLowerCase(),
    (r.market ?? "").toLowerCase(),
    (r.side ?? "").toLowerCase(),
    r.line ?? "",
  ].join("|");
}

function pickBestGame(rows: EvPlayRow[]) {
  return rows
    .slice()
    .sort((a, b) => {
      const sa = getGameScore(a) ?? -999;
      const sb = getGameScore(b) ?? -999;
      if (sb !== sa) return sb - sa;

      const ea = getEvPct(a) ?? -999;
      const eb = getEvPct(b) ?? -999;
      if (eb !== ea) return eb - ea;

      const oa = getGameOdds(a) != null ? 1 : 0;
      const ob = getGameOdds(b) != null ? 1 : 0;
      if (ob !== oa) return ob - oa;

      const fa = getGameFairOdds(a) != null ? 1 : 0;
      const fb = getGameFairOdds(b) != null ? 1 : 0;
      return fb - fa;
    })[0];
}

function pickBestProp(rows: PropEvRow[]) {
  return rows
    .slice()
    .sort((a, b) => {
      const sa = getPropScore(a) ?? -999;
      const sb = getPropScore(b) ?? -999;
      if (sb !== sa) return sb - sa;

      const ea = getEvPct(a) ?? -999;
      const eb = getEvPct(b) ?? -999;
      if (eb !== ea) return eb - ea;

      const oa = getPropOdds(a) != null ? 1 : 0;
      const ob = getPropOdds(b) != null ? 1 : 0;
      if (ob !== oa) return ob - oa;

      const fa = getPropFairOdds(a) != null ? 1 : 0;
      const fb = getPropFairOdds(b) != null ? 1 : 0;
      return fb - fa;
    })[0];
}

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

      const runQ = supabase.from("monte_carlo_runs").select("id,created_at,sport_key").order("created_at", {
        ascending: false,
      }).limit(1);

      const versionQ = supabase
        .from("model_versions")
        .select(
          "version,release_date,status,simulations,calib_window,anchor_weight_min,anchor_weight_max,min_ev_threshold,updated_at"
        )
        .order("release_date", { ascending: false })
        .limit(1);

      const changelogQ = supabase.from("model_changelog").select("version,date,changes").order("date", {
        ascending: false,
      }).limit(5);

      const evQ = supabase.from("ev_plays").select("*").order("created_at", { ascending: false }).limit(250);

      const propsQ = supabase
        .from("player_prop_ev_latest")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(250);

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

  useEffect(() => {
    const channel = supabase
      .channel("overview-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "monte_carlo_runs" }, () =>
        loadAll({ soft: true })
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "model_versions" }, () =>
        loadAll({ soft: true })
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "model_changelog" }, () =>
        loadAll({ soft: true })
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "ev_plays" }, () => loadAll({ soft: true }))
      .on("postgres_changes", { event: "*", schema: "public", table: "player_prop_ev_latest" }, () =>
        loadAll({ soft: true })
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeSport = latestRun?.sport_key ?? null;

  const meta = useMemo(() => {
    const sims = latestVersion?.simulations ?? null;
    const anchorMin = latestVersion?.anchor_weight_min;
    const anchorMax = latestVersion?.anchor_weight_max;

    const minEv = latestVersion?.min_ev_threshold;
    const minEvPct =
      minEv == null ? "—" : minEv <= 1 ? `${(minEv * 100).toFixed(1)}%` : `${Number(minEv).toFixed(1)}%`;

    const anchorRange =
      anchorMin != null && anchorMax != null ? `${anchorMin.toFixed(2)}–${anchorMax.toFixed(2)}` : "—";

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

  const evFiltered = useMemo(() => {
    return (evPlays ?? [])
      .filter((r) => (activeSport ? r.sport_key === activeSport : true))
      .filter((r) => isFutureish(r.commence_time ?? null));
  }, [evPlays, activeSport]);

  const propsFiltered = useMemo(() => {
    return (propPlays ?? [])
      .filter((r) => (activeSport ? r.sport_key === activeSport : true))
      .filter((r) => isFutureish(r.commence_time ?? null));
  }, [propPlays, activeSport]);

  const topGames = useMemo(() => {
    const map = new Map<string, EvPlayRow[]>();
    for (const r of evFiltered) {
      const k = keyGamePlay(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }
    const unique = Array.from(map.values()).map(pickBestGame);

    unique.sort((a, b) => {
      const sa = getGameScore(a) ?? -999;
      const sb = getGameScore(b) ?? -999;
      if (sb !== sa) return sb - sa;
      const ea = getEvPct(a) ?? -999;
      const eb = getEvPct(b) ?? -999;
      return eb - ea;
    });

    return unique.filter((r) => (getGameScore(r) ?? -999) >= TOP_SCORE_MIN).slice(0, 6);
  }, [evFiltered]);

  const topProps = useMemo(() => {
    const map = new Map<string, PropEvRow[]>();
    for (const r of propsFiltered) {
      const k = keyPropPlay(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }
    const unique = Array.from(map.values()).map(pickBestProp);

    unique.sort((a, b) => {
      const sa = getPropScore(a) ?? -999;
      const sb = getPropScore(b) ?? -999;
      if (sb !== sa) return sb - sa;
      const ea = getEvPct(a) ?? -999;
      const eb = getEvPct(b) ?? -999;
      return eb - ea;
    });

    return unique.filter((r) => (getPropScore(r) ?? -999) >= TOP_SCORE_MIN).slice(0, 6);
  }, [propsFiltered]);

  const topAll = useMemo(() => {
    const merged: Array<{ kind: "game"; row: EvPlayRow } | { kind: "prop"; row: PropEvRow }> = [
      ...topGames.map((r) => ({ kind: "game" as const, row: r })),
      ...topProps.map((r) => ({ kind: "prop" as const, row: r })),
    ];

    merged.sort((a, b) => {
      const A = a.kind === "game" ? getGameScore(a.row) : getPropScore(a.row as any);
      const B = b.kind === "game" ? getGameScore(b.row as any) : getPropScore(b.row as any);
      if ((B ?? -999) !== (A ?? -999)) return (B ?? -999) - (A ?? -999);
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
    const bestScore =
      !best ? null : best.kind === "game" ? getGameScore(best.row as any) : getPropScore(best.row as any);
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
    if (tab === "game") return topGames.map((r) => ({ kind: "game" as const, row: r }));
    if (tab === "props") return topProps.map((r) => ({ kind: "prop" as const, row: r }));
    return topAll;
  }, [tab, topAll, topGames, topProps]);

  /* =========================================================
     RENDER
  ========================================================= */

  return (
    <div className="space-y-8 sm:space-y-10">
      {/* HERO */}
      <div className="relative overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] p-4 sm:p-6">
        <div
          className="pointer-events-none absolute inset-0 opacity-95"
          style={{
            background:
              "radial-gradient(900px 260px at 18% 0%, rgba(212,175,55,0.20), transparent 62%), radial-gradient(700px 240px at 85% 12%, rgba(255,255,255,0.05), transparent 60%)",
          }}
        />

        <div className="relative space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-1 text-[11px] text-[#b0b0b0]">
                <Sparkles className="w-3 h-3 text-[#d4af37]" />
                Prism Command Center
              </div>

              <h2 className="text-xl sm:text-2xl text-white mt-3 mb-2 tracking-tight">Today’s Best Edges — Live</h2>

              <p className="text-sm text-[#b0b0b0] leading-relaxed max-w-3xl">
                Your top-rated +EV plays, powered by Monte Carlo simulation, sharp anchoring, and no-vig pricing.
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2 sm:gap-3 text-xs">
                <StatusPill
                  label="Latest Run"
                  value={
                    latestRun?.created_at
                      ? `${formatTsShort(latestRun.created_at)} • ${heroStats.freshness}`
                      : loading
                      ? "Loading…"
                      : "—"
                  }
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

              <div className="mt-2 text-[11px] text-[#606060]">
                Top Plays only show <span className="text-white">Score ≥ {TOP_SCORE_MIN}</span>. Any play with{" "}
                <span className="text-white">Score = 100</span> shows <span style={{ color: GOLD }}>🔥</span>.
              </div>
            </div>

            <button
              type="button"
              onClick={() => loadAll({ soft: false })}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-2 text-xs text-[#cfcfcf] hover:border-[#3a3a3a] hover:text-white transition-colors w-full sm:w-auto"
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

          {/* Quick Actions — stack on mobile */}
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
            <QuickAction title="Odds" sub="Market grid + history" icon={Database} href="/odds" />
            <QuickAction title="Monte Carlo" sub="Projected scores + win%" icon={Calculator} href="/monte-carlo" />
            <QuickAction title="Model Picks" sub="Best +EV plays" icon={Trophy} href="/model" />
          </div>
        </div>
      </div>

      {/* TOP PLAYS */}
      <section>
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-3 sm:mb-4">
          <div>
            <h3 className="text-base text-white">Top Plays Right Now</h3>
            <div className="text-xs text-[#606060]">
              Ranked by Score first, then EV%. Deduped to show one card per play. (Score ≥ {TOP_SCORE_MIN})
            </div>
          </div>

          <div className="w-full sm:w-auto">
            <Segmented value={tab} onChange={setTab} />
          </div>
        </div>

        {/* Mobile: 1 column. Small tablets: 2. Desktop: 4 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {loading ? (
            <>
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </>
          ) : playsToRender.length === 0 ? (
            <div className="col-span-1 sm:col-span-2 lg:col-span-4 rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] p-5 text-sm text-[#b0b0b0]">
              No top plays found for the current filter.
              <div className="text-xs text-[#606060] mt-1">
                Check that <span className="text-white">ev_plays</span> and{" "}
                <span className="text-white">player_prop_ev_latest</span> are populated for upcoming events, and that
                some plays have <span className="text-white">score ≥ {TOP_SCORE_MIN}</span>.
              </div>
            </div>
          ) : (
            playsToRender.map((p, idx) => {
              const isTop3 = idx < 3;

              if (p.kind === "game") {
                const r = p.row as EvPlayRow;
                return (
                  <TopPlayCard
                    key={`game-${r.id ?? idx}`}
                    kind="game"
                    rank={idx + 1}
                    isTop3={isTop3}
                    title={r.matchup ?? "—"}
                    subtitle={gameSubtitle(r)}
                    score={getGameScore(r)}
                    ev={getEvPct(r)}
                    book={normalizeBook(r.bookmaker)}
                    odds={getGameOdds(r)}
                    fairOdds={getGameFairOdds(r)}
                    commence={r.commence_time ? formatTsShort(r.commence_time) : null}
                  />
                );
              }

              const r = p.row as PropEvRow;
              return (
                <TopPlayCard
                  key={`prop-${r.id ?? idx}`}
                  kind="prop"
                  rank={idx + 1}
                  isTop3={isTop3}
                  title={propTitle(r)}
                  subtitle={propSubtitle(r)}
                  score={getPropScore(r)}
                  ev={getEvPct(r)}
                  book={normalizeBook(r.book ?? r.bookmaker)}
                  odds={getPropOdds(r)}
                  fairOdds={getPropFairOdds(r)}
                  commence={r.commence_time ? formatTsShort(r.commence_time) : null}
                  pictureUrl={r.picture_url ?? null}
                />
              );
            })
          )}
        </div>
      </section>

      {/* PIPELINE + MODEL META — stacks on mobile */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
        {/* Pipeline */}
        <div className="lg:col-span-2 rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] p-4 sm:p-5">
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

          {/* Mobile: vertical list. Desktop: horizontal with arrows */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-0">
            {pipeline.map((step, i) => (
              <div key={step.label} className="flex items-center sm:flex-1 min-w-0">
                <PipelineStep icon={step.icon} label={step.label} sublabel={step.sub} />
                {i < pipeline.length - 1 ? (
                  <ArrowRight className="hidden sm:block w-5 h-5 text-[#505050] flex-shrink-0 mx-2" />
                ) : null}
              </div>
            ))}
          </div>
        </div>

        {/* Model meta */}
        <div className="rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] p-4 sm:p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="text-base text-white">Model</div>
            <div className="text-[11px] text-[#606060]">{meta.updatedAt ? `Updated ${meta.updatedAt}` : ""}</div>
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

      {/* CHANGELOG */}
      <section>
        <h3 className="text-base text-white mb-3 sm:mb-4">What Changed</h3>
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
   CARD STRING BUILDERS
========================================================= */

function gameSubtitle(r: EvPlayRow) {
  const m = marketLabel(r.market ?? "");
  const side = (r.side ?? "").toUpperCase();
  const line = fmtLine(r.line ?? null);
  const team = (r.team ?? "").trim();
  const pick = team ? `${team}${line ? ` ${line}` : ""}` : `${side}${line ? ` ${line}` : ""}`;
  return `${m} • ${pick}`;
}

function propTitle(r: PropEvRow) {
  const pn = (r.player_name ?? "Unknown Player").trim();
  const t = (r.team ?? "").trim();
  const o = (r.opponent ?? "").trim();
  const vs = t && o ? `${t} vs ${o}` : t || o ? t || o : "";
  return vs ? `${pn} (${vs})` : pn;
}

function propSubtitle(r: PropEvRow) {
  const m = titleCase(marketLabel(r.market ?? "Prop"));
  const side = (r.side ?? "").toUpperCase();
  const line = fmtLine(r.line ?? null);
  return `${m} • ${side}${line ? ` ${line}` : ""}`;
}

/* =========================================================
   UI BITS
========================================================= */

function QuickAction({
  title,
  sub,
  icon: Icon,
  href,
}: {
  title: string;
  sub: string;
  icon: any;
  href: string;
}) {
  return (
    <button
      type="button"
      onClick={() => (window.location.href = href)}
      className="text-left rounded-xl border border-[#2a2a2a] bg-[#0b0b0b] p-4 hover:border-[#3a3a3a] transition-colors"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm text-white">{title}</div>
          <div className="text-xs text-[#606060] mt-0.5">{sub}</div>
        </div>
        <div className="w-9 h-9 rounded-lg bg-[#141414] border border-[#d4af37]/25 flex items-center justify-center shrink-0">
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
          "px-3 py-2 rounded-lg text-xs border transition-colors w-full sm:w-auto",
          active
            ? "bg-[#141414] border-[#d4af37]/40 text-white"
            : "bg-[#0b0b0b] border-[#2a2a2a] text-[#b0b0b0] hover:text-white hover:border-[#3a3a3a]",
        ].join(" ")}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="grid grid-cols-3 gap-2 sm:inline-flex sm:items-center sm:gap-2">
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
    <div className="flex items-center gap-3 sm:flex-col sm:gap-0 sm:items-center flex-1 min-w-0">
      <div className="w-10 h-10 sm:w-12 sm:h-12 bg-[#141414] border border-[#d4af37]/30 rounded-lg flex items-center justify-center shrink-0 sm:mb-2">
        <Icon className="w-5 h-5 text-[#d4af37]" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-white sm:text-center mb-0.5">{label}</div>
        <div className="text-[10px] text-[#606060] sm:text-center">{sublabel}</div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] px-2.5 py-2.5">
      <div className="text-[10px] text-[#606060]">{label}</div>
      <div className={["text-xs mt-0.5 whitespace-nowrap truncate", accent ? "text-[#d4af37]" : "text-white"].join(" ")}>
        {value}
      </div>
    </div>
  );
}

function MetaLine({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="text-[#808080]">{label}</div>
      <div className={["text-white text-right", warn ? "text-amber-300" : ""].join(" ")}>{value}</div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] p-4">
      <div className="animate-pulse space-y-3">
        <div className="h-4 w-2/3 bg-[#1a1a1a] rounded" />
        <div className="h-3 w-1/2 bg-[#1a1a1a] rounded" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="h-10 bg-[#1a1a1a] rounded" />
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
   TOP PLAY CARD — mobile breathing room
========================================================= */

function TopPlayCard({
  kind,
  rank,
  isTop3,
  title,
  subtitle,
  score,
  ev,
  book,
  odds,
  fairOdds,
  commence,
  pictureUrl,
}: {
  kind: "game" | "prop";
  rank: number;
  isTop3: boolean;
  title: string;
  subtitle: string;
  score: number | null;
  ev: number | null;
  book: string;
  odds: number | null;
  fairOdds: number | null;
  commence: string | null;
  pictureUrl?: string | null;
}) {
  const scoreRounded = score == null ? null : Math.round(score);
  const scoreText = scoreRounded == null ? "—" : `${scoreRounded}`;
  const evText = ev == null ? "—" : `${ev.toFixed(1)}%`;
  const showFire = scoreRounded === 100;

  return (
    <div className="relative overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] p-4 sm:p-4">
      {isTop3 ? (
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background: "radial-gradient(520px 200px at 30% 0%, rgba(212,175,55,0.22), transparent 60%)",
          }}
        />
      ) : null}

      <div className="relative space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="w-9 h-9 rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] flex items-center justify-center shrink-0"
              title={`Rank #${rank}`}
            >
              {showFire ? (
                <Flame className="w-4 h-4 text-[#d4af37]" />
              ) : (
                <Trophy className={["w-4 h-4", isTop3 ? "text-[#d4af37]" : "text-[#808080]"].join(" ")} />
              )}
            </div>

            {kind === "prop" ? (
              <div className="w-9 h-9 rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] overflow-hidden shrink-0">
                {pictureUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={pictureUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[10px] text-[#606060]">—</div>
                )}
              </div>
            ) : null}

            <div className="min-w-0">
              <div className="text-[11px] text-[#808080]">{kind === "prop" ? "Player Prop" : "Game Line"}</div>
              <div className="text-[15px] sm:text-sm text-white leading-snug truncate">{title}</div>
            </div>
          </div>

          <div className="text-right shrink-0">
            <div className="text-[10px] text-[#606060]">Score</div>
            <div className="text-sm text-white inline-flex items-center gap-1">
              {scoreText}
              {showFire ? <span style={{ color: GOLD }}>🔥</span> : null}
            </div>
          </div>
        </div>

        {/* Slightly more line-height on mobile */}
        <div className="text-xs text-[#b0b0b0] leading-relaxed">{subtitle}</div>

        {/* Mobile: 2x2 stats. Desktop+: 4 across */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <MiniStat label="EV" value={evText} accent />
          <MiniStat label="Book" value={book} />
          <MiniStat label="Book Odds" value={fmtOdds(odds)} />
          <MiniStat label="Quantum" value={fmtOdds(fairOdds)} />
        </div>

        {commence ? <div className="text-[11px] text-[#606060] pt-0.5">{commence}</div> : null}
      </div>
    </div>
  );
}

