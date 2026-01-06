"use client";

// src/app/components/screens/MonteCarloScreen.tsx — FULL REWRITE (v10.0.0 — Modal White-Screen FIX)
// -----------------------------------------------------------------------------------------------------
// ✅ Fixes “white screen” on Model click by:
//    1) Rendering modal via React Portal to document.body (prevents stacking/overlay/layout bugs)
//    2) Using a dedicated Overlay that cannot swallow/blank the page
//    3) Hard-guards against undefined document/window access
//    4) Never throws during modal render (all derived values are guarded)
//    5) Shows an always-visible modal shell with Loading/Error states (no “nothing renders”)
// ✅ One Model button per event
// ✅ Canonical lookups everywhere (team_map/team_ratings/ncaab_stats)
// ✅ Power Rank next to team name
// ✅ Consensus lines from odds_snapshot: median of latest-per-book
//
// Tables used:
//   - public.monte_carlo_runs
//   - public.monte_carlo_results
//   - public.team_map
//   - public.team_ratings
//   - public.ncaab_stats (only for basketball_ncaab)
//   - public.odds_snapshot
// -----------------------------------------------------------------------------------------------------

import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../lib/supabaseClient";
import type { SportKey } from "../../App";

/* =========================================================
   Types
========================================================= */

type MonteCarloRun = { id: string; created_at: string; sport_key: string };

type MonteCarloResultRow = {
  run_id: string;
  sport_key: string;
  event_id: string;
  commence_time: string | null;

  home_team: string | null;
  away_team: string | null;

  projected_margin_home: number | null;
  projected_total: number | null;

  projected_home_points: number | null;
  projected_away_points: number | null;

  home_cover_prob: number | null;
  away_cover_prob: number | null;

  over_prob: number | null;
  under_prob: number | null;

  home_win_prob: number | null;
  away_win_prob: number | null;
};

type TeamMapRow = {
  canonical: string;
  Abbreviation: string | null;
  "Logo URL": string | null;
};

type TeamRatingsRow = Record<string, any> & {
  canonical?: string | null;
  sport_key?: string | null;
  power_rank?: number | null;
  engine_power?: number | null;
  engine_adj_off?: number | null;
  engine_adj_def?: number | null;
  pace?: number | null;
  true_hca?: number | null;
  sigma_margin_100?: number | null;
  sigma_total_100?: number | null;
};

type NcaabStatRow = {
  canonical: string;
  stat_key: string;
  home_score: number | null;
  away_score: number | null;
};

type OddsSnapshotRow = {
  ts: string;
  event_id: string;
  market: string;
  side: string | null;
  line: number | null;
  odds: number | null;
  bookmaker: string | null;
};

type Consensus = {
  ts: string | null;
  spread_home_line: number | null;
  spread_home_odds: number | null;
  spread_away_odds: number | null;
  total_line: number | null;
  total_over_odds: number | null;
  total_under_odds: number | null;
};

type SideKey = "AWAY" | "HOME";

type TeamRow = {
  eventId: string;
  commenceTime: string | null;

  side: SideKey;
  teamName: string; // canonical
  teamAbbr: string;
  logoUrl: string | null;

  powerRank: number | null;

  projPoints: number;

  projMarginTeam: number;
  coverProbTeam: number | null;

  projTotal: number;
  overProb: number | null;
  underProb: number | null;

  winProbTeam: number | null;

  consSpreadLineTeam: number | null;
  consSpreadOddsTeam: number | null;

  consTotalLine: number | null;
  consTotalOverOdds: number | null;
  consTotalUnderOdds: number | null;

  isProjectedWinner: boolean;
};

type EventBundle = {
  eventId: string;
  commenceTime: string | null;
  away: TeamRow;
  home: TeamRow;
  consensusTs: string | null;
};

/* =========================================================
   Helpers
========================================================= */

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function safeNum(n: any, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function american(odds: number | null) {
  if (odds == null || !Number.isFinite(odds)) return "—";
  const v = Math.round(odds);
  return v > 0 ? `+${v}` : `${v}`;
}

function pct01(p01: number | null, digits = 1) {
  if (p01 == null || !Number.isFinite(p01)) return "—";
  return `${(p01 * 100).toFixed(digits)}%`;
}

function fmtSigned1(x: number | null) {
  if (x == null || !Number.isFinite(x)) return "—";
  const v = Math.round(x * 10) / 10;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

function fmtOU(line: number | null, kind: "o" | "u") {
  if (line == null || !Number.isFinite(line)) return "—";
  const v = Math.round(line * 10) / 10;
  return `${kind}${v.toFixed(1)}`;
}

function fmtLinePlain(line: number | null) {
  if (line == null || !Number.isFinite(line)) return "—";
  const v = Math.round(line * 10) / 10;
  return v.toFixed(1);
}

function fmtDateCentral(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtTimeCentral(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTs(ts: string | null) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return ts;
  return d.toLocaleString();
}

function fmtMaybeNumber(v: any, digits = 2) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "—";
  return x.toFixed(digits);
}

function fmtMaybeInt(v: any) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "—";
  return String(Math.round(x));
}

const normKey = (s: string) =>
  (s ?? "")
    .toString()
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

const SIDE_ALIASES = {
  home: new Set(["home", "h", "team1", "t1"]),
  away: new Set(["away", "a", "team2", "t2"]),
  over: new Set(["over", "o"]),
  under: new Set(["under", "u"]),
};

function normalizeSide(raw: string | null): "home" | "away" | "over" | "under" | null {
  const s = (raw ?? "").toString().trim().toLowerCase();
  if (!s) return null;
  if (SIDE_ALIASES.home.has(s)) return "home";
  if (SIDE_ALIASES.away.has(s)) return "away";
  if (SIDE_ALIASES.over.has(s)) return "over";
  if (SIDE_ALIASES.under.has(s)) return "under";
  return null;
}

function pushMap(map: Map<string, number[]>, key: string, v: number) {
  const arr = map.get(key) ?? [];
  arr.push(v);
  map.set(key, arr);
}

function medianOrNull(nums: number[]) {
  const arr = nums.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}

/* =========================================================
   UI Atoms
========================================================= */

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-1">
      <div className="text-[11px] text-[#808080]">{label}</div>
      <div className="text-[11px] font-medium tabular-nums text-white">{value}</div>
    </div>
  );
}

function LogoBox({ team, url, size }: { team: string; url: string | null; size: number }) {
  const [ok, setOk] = useState(true);
  if (!url || !ok) {
    return (
      <div
        style={{ width: size, height: size }}
        className="rounded-md bg-white border border-[#e5e5e5]"
        aria-label={`${team} logo placeholder`}
      />
    );
  }
  return (
    <img
      src={url}
      alt={`${team} logo`}
      style={{ width: size, height: size }}
      className="rounded-md object-contain bg-white border border-[#e5e5e5] p-1"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setOk(false)}
      draggable={false}
    />
  );
}

function RankBadge({ rank }: { rank: number | null }) {
  if (rank == null || !Number.isFinite(rank)) return null;
  const r = Math.round(rank);
  const top = r <= 25;
  return (
    <span
      className={cx(
        "ml-2 inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-extrabold tabular-nums",
        top ? "border-[#d4af37] bg-[#1a1406] text-[#f5e7b7]" : "border-[#2a2a2a] bg-[#0b0b0b] text-[#d4af37]"
      )}
    >
      #{r}
    </span>
  );
}

function SoftButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      title={title}
      className="inline-flex items-center gap-2 rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-2 text-[11px] font-extrabold text-white hover:bg-[#121212] active:scale-[0.99] transition"
    >
      {children}
    </button>
  );
}

function ProbBar({ p }: { p: number | null }) {
  const w = p != null && Number.isFinite(p) ? Math.max(0, Math.min(1, p)) * 100 : 0;
  return (
    <div className="mt-1 h-[5px] w-full rounded-full bg-[#141414] overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${w}%`, background: "#d4af37" }} />
    </div>
  );
}

function RecencyDot({ ts }: { ts: string | null }) {
  if (!ts) return <span className="inline-block h-2 w-2 rounded-full bg-[#3a3a3a]" title="Consensus: unknown" />;
  const ageMs = Date.now() - new Date(ts).getTime();
  const ok = Number.isFinite(ageMs);
  const dot =
    !ok ? "#3a3a3a" : ageMs <= 5 * 60_000 ? "#22c55e" : ageMs <= 30 * 60_000 ? "#d4af37" : "#6b7280";
  const label =
    !ok
      ? "Consensus: unknown"
      : ageMs <= 5 * 60_000
      ? "Consensus: updated within 5 min"
      : ageMs <= 30 * 60_000
      ? "Consensus: updated within 30 min"
      : "Consensus: older snapshot";
  return <span className="inline-block h-2 w-2 rounded-full" style={{ background: dot }} title={label} />;
}

/* =========================================================
   Mobile details block
========================================================= */

function MobileDetailsBlock({ away, home }: { away: TeamRow; home: TeamRow }) {
  const row = (label: string, a: React.ReactNode, h: React.ReactNode) => (
    <div className="grid grid-cols-3 gap-2 items-center py-2 border-b border-[#141414] last:border-b-0">
      <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">{label}</div>
      <div className="text-[11px] text-white font-bold tabular-nums text-right">{a}</div>
      <div className="text-[11px] text-white font-bold tabular-nums text-right">{h}</div>
    </div>
  );

  const consSpreadAway =
    away.consSpreadLineTeam == null ? "—" : `${fmtSigned1(away.consSpreadLineTeam)} (${american(away.consSpreadOddsTeam)})`;
  const consSpreadHome =
    home.consSpreadLineTeam == null ? "—" : `${fmtSigned1(home.consSpreadLineTeam)} (${american(home.consSpreadOddsTeam)})`;

  const consTotalOver =
    away.consTotalLine == null ? "—" : `${fmtOU(away.consTotalLine, "o")} (${american(away.consTotalOverOdds)})`;
  const consTotalUnder =
    home.consTotalLine == null ? "—" : `${fmtOU(home.consTotalLine, "u")} (${american(home.consTotalUnderOdds)})`;

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-black/10 overflow-hidden">
      <div className="px-4 py-2 border-b border-[#141414] text-[11px] text-white font-extrabold">Details</div>
      <div className="px-4">
        {row(
          "Proj Margin",
          <>
            {fmtSigned1(away.projMarginTeam)}
            <div className="text-[10px] text-[#9a9a9a] font-semibold">Cover {pct01(away.coverProbTeam)}</div>
            <ProbBar p={away.coverProbTeam} />
          </>,
          <>
            {fmtSigned1(home.projMarginTeam)}
            <div className="text-[10px] text-[#9a9a9a] font-semibold">Cover {pct01(home.coverProbTeam)}</div>
            <ProbBar p={home.coverProbTeam} />
          </>
        )}
        {row(
          "Proj Total",
          <>
            {fmtOU(away.projTotal, "o")}
            <div className="text-[10px] text-[#9a9a9a] font-semibold">Over {pct01(away.overProb)}</div>
            <ProbBar p={away.overProb} />
          </>,
          <>
            {fmtOU(home.projTotal, "u")}
            <div className="text-[10px] text-[#9a9a9a] font-semibold">Under {pct01(home.underProb)}</div>
            <ProbBar p={home.underProb} />
          </>
        )}
        {row("Cons Spread", consSpreadAway, consSpreadHome)}
        {row("Cons Total", consTotalOver, consTotalUnder)}
      </div>
    </div>
  );
}

/* =========================================================
   Modal (Portal) — bulletproof against “white screen”
========================================================= */

type StatMode = "off" | "def";

type ModelModalProps = {
  open: boolean;
  onClose: () => void;
  sportKey: SportKey;
  event: EventBundle | null;
  logoMap: Map<string, string>;
  abbrMap: Map<string, string>;
};

type ModelModalState = {
  loading: boolean;
  error: string | null;
  awayRatings: TeamRatingsRow | null;
  homeRatings: TeamRatingsRow | null;
  awayStats: Map<string, number>;
  homeStats: Map<string, number>;
};

const TEAM_RATINGS_FIELDS: Array<{ key: string; label: string; fmt?: (v: any) => string }> = [
  { key: "power_rank", label: "Power Rank", fmt: (v) => fmtMaybeInt(v) },
  { key: "engine_power", label: "Engine Power", fmt: (v) => fmtMaybeNumber(v, 2) },
  { key: "engine_adj_off", label: "Adj Off", fmt: (v) => fmtMaybeNumber(v, 2) },
  { key: "engine_adj_def", label: "Adj Def", fmt: (v) => fmtMaybeNumber(v, 2) },
  { key: "pace", label: "Pace", fmt: (v) => fmtMaybeNumber(v, 2) },
  { key: "true_hca", label: "True HCA", fmt: (v) => fmtMaybeNumber(v, 2) },
  { key: "sigma_margin_100", label: "Sigma Margin (100)", fmt: (v) => fmtMaybeNumber(v, 2) },
  { key: "sigma_total_100", label: "Sigma Total (100)", fmt: (v) => fmtMaybeNumber(v, 2) },
];

// NCAAB % stored as .456 => render 45.6%
const NCAAB_STAT_DEFS: Array<{
  mode: StatMode;
  key: string;
  label: string;
  fmt?: (v: number) => string;
  higherIsBetter?: boolean;
}> = [
  { mode: "off", key: "possessions-per-game", label: "Pace", fmt: (v) => v.toFixed(1), higherIsBetter: true },
  { mode: "off", key: "points-per-game", label: "Points / Game", fmt: (v) => v.toFixed(1), higherIsBetter: true },
  { mode: "off", key: "average-scoring-margin", label: "Avg Margin", fmt: (v) => v.toFixed(1), higherIsBetter: true },
  { mode: "off", key: "effective-field-goal-pct", label: "eFG%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: true },
  { mode: "off", key: "three-point-pct", label: "3P%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: true },
  { mode: "off", key: "two-point-pct", label: "2P%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: true },
  { mode: "off", key: "turnover-pct", label: "TO%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: false },
  { mode: "off", key: "offensive-rebounding-pct", label: "ORB%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: true },

  { mode: "def", key: "opponent-points-per-game", label: "Opp Pts / Game", fmt: (v) => v.toFixed(1), higherIsBetter: false },
  { mode: "def", key: "opponent-effective-field-goal-pct", label: "Opp eFG%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: false },
  { mode: "def", key: "opponent-three-point-pct", label: "Opp 3P%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: false },
  { mode: "def", key: "opponent-two-point-pct", label: "Opp 2P%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: false },
  { mode: "def", key: "defensive-rebounding-pct", label: "DRB%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: true },
];

function ModelModalPortal({ open, onClose, sportKey, event, logoMap, abbrMap }: ModelModalProps) {
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<StatMode>("off");
  const [st, setSt] = useState<ModelModalState>({
    loading: false,
    error: null,
    awayRatings: null,
    homeRatings: null,
    awayStats: new Map(),
    homeStats: new Map(),
  });

  // Mount guard (prevents portal SSR weirdness)
  useEffect(() => {
    setMounted(true);
  }, []);

  // Escape closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Scroll lock that cannot crash if document undefined
  useEffect(() => {
    if (!open) return;
    if (typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Data load — never throws out of effect
  useEffect(() => {
    let alive = true;

    async function load() {
      if (!open || !event) return;

      const awayCanonical = event.away?.teamName ?? "";
      const homeCanonical = event.home?.teamName ?? "";

      if (!awayCanonical || !homeCanonical) {
        if (!alive) return;
        setSt((p) => ({ ...p, loading: false, error: "Missing canonical team names for this event." }));
        return;
      }

      if (!alive) return;
      setSt({
        loading: true,
        error: null,
        awayRatings: null,
        homeRatings: null,
        awayStats: new Map(),
        homeStats: new Map(),
      });

      try {
        // team_ratings
        const ratingsRes = await supabase
          .from("team_ratings")
          .select("*")
          .eq("sport_key", sportKey)
          .in("canonical", [awayCanonical, homeCanonical]);

        if (ratingsRes.error) throw new Error(`team_ratings: ${ratingsRes.error.message}`);

        const ratings = (ratingsRes.data ?? []) as TeamRatingsRow[];
        const awayRatings =
          ratings.find((r) => normKey(String(r.canonical ?? "")) === normKey(awayCanonical)) ?? null;
        const homeRatings =
          ratings.find((r) => normKey(String(r.canonical ?? "")) === normKey(homeCanonical)) ?? null;

        // ncaab_stats
        let awayStats = new Map<string, number>();
        let homeStats = new Map<string, number>();

        if (String(sportKey).toLowerCase() === "basketball_ncaab") {
          const statsRes = await supabase
            .from("ncaab_stats")
            .select("canonical,stat_key,home_score,away_score")
            .in("canonical", [awayCanonical, homeCanonical]);

          if (statsRes.error) throw new Error(`ncaab_stats: ${statsRes.error.message}`);

          const rows = (statsRes.data ?? []) as NcaabStatRow[];
          for (const r of rows) {
            const canon = String(r.canonical ?? "");
            const key = String(r.stat_key ?? "").trim();
            if (!key) continue;

            if (normKey(canon) === normKey(awayCanonical)) {
              const v = Number(r.away_score);
              if (Number.isFinite(v)) awayStats.set(key, v);
            } else if (normKey(canon) === normKey(homeCanonical)) {
              const v = Number(r.home_score);
              if (Number.isFinite(v)) homeStats.set(key, v);
            }
          }
        }

        if (!alive) return;
        setSt({
          loading: false,
          error: null,
          awayRatings,
          homeRatings,
          awayStats,
          homeStats,
        });
      } catch (e: any) {
        if (!alive) return;
        setSt((p) => ({
          ...p,
          loading: false,
          error: String(e?.message ?? e),
        }));
      }
    }

    load();
    return () => {
      alive = false;
    };
  }, [open, event?.eventId, sportKey]);

  if (!mounted || !open) return null;

  // Always render modal shell even if event is null (prevents “blank overlay”)
  const awayName = event?.away?.teamName ?? "—";
  const homeName = event?.home?.teamName ?? "—";
  const awayKey = normKey(awayName);
  const homeKey = normKey(homeName);

  const awayLogo = logoMap.get(awayKey) ?? event?.away?.logoUrl ?? null;
  const homeLogo = logoMap.get(homeKey) ?? event?.home?.logoUrl ?? null;

  const awayAbbr = abbrMap.get(awayKey) ?? event?.away?.teamAbbr ?? "AWAY";
  const homeAbbr = abbrMap.get(homeKey) ?? event?.home?.teamAbbr ?? "HOME";

  const awayRank = (st.awayRatings as any)?.power_rank ?? event?.away?.powerRank ?? null;
  const homeRank = (st.homeRatings as any)?.power_rank ?? event?.home?.powerRank ?? null;

  const statDefs = NCAAB_STAT_DEFS.filter((d) => d.mode === mode);

  const modal = (
    <div className="fixed inset-0 z-[9999]">
      {/* Overlay — cannot be “white”, cannot eat the app */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(1000px 400px at 20% 0%, rgba(212,175,55,0.16), transparent 60%), rgba(0,0,0,0.78)",
        }}
        onMouseDown={(e) => {
          // Close only when pressing the overlay itself
          if (e.target === e.currentTarget) onClose();
        }}
      />

      {/* Dialog */}
      <div className="absolute inset-0 flex items-center justify-center px-3">
        <div
          className="w-[min(1040px,calc(100vw-24px))] max-h-[calc(100vh-24px)] overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#0b0b0b] shadow-2xl"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          {/* Header */}
          <div className="px-5 pt-5 pb-4 border-b border-[#141414]">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-1 text-[11px] text-[#b0b0b0]">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#d4af37" }} />
                  Model View
                </div>

                <div className="mt-3 text-white font-extrabold text-[18px] leading-tight truncate">
                  {awayName} vs {homeName}
                </div>

                <div className="mt-1 text-[11px] text-[#9a9a9a]">
                  {event ? (
                    <>
                      {fmtDateCentral(event.commenceTime)} · {fmtTimeCentral(event.commenceTime)}
                    </>
                  ) : (
                    "—"
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="shrink-0 rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-2 text-[11px] font-extrabold text-white hover:bg-[#121212]"
              >
                Done
              </button>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMode("off")}
                className={cx(
                  "rounded-lg border px-3 py-2 text-[11px] font-extrabold transition",
                  mode === "off"
                    ? "border-[#d4af37] bg-[#1a1406] text-[#f5e7b7]"
                    : "border-[#2a2a2a] bg-[#0b0b0b] text-[#cfcfcf] hover:bg-[#121212]"
                )}
              >
                Offense
              </button>

              <button
                type="button"
                onClick={() => setMode("def")}
                className={cx(
                  "rounded-lg border px-3 py-2 text-[11px] font-extrabold transition",
                  mode === "def"
                    ? "border-[#d4af37] bg-[#1a1406] text-[#f5e7b7]"
                    : "border-[#2a2a2a] bg-[#0b0b0b] text-[#cfcfcf] hover:bg-[#121212]"
                )}
              >
                Defense
              </button>

              <div className="ml-auto text-[10px] text-[#808080]">
                {st.loading ? "Loading…" : st.error ? "Stats unavailable" : ""}
              </div>
            </div>
          </div>

          {/* Body */}
          <div className="bg-[#070707] max-h-[calc(100vh-240px)] overflow-y-auto px-5 py-5 space-y-3">
            {st.error ? (
              <div className="rounded-xl border border-red-900/50 bg-black/30 px-4 py-3 text-[11px] text-red-400">
                {st.error}
              </div>
            ) : null}

            {/* Ratings */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div className="rounded-xl border border-[#1f1f1f] bg-black/20 overflow-hidden">
                <div className="px-4 py-3 border-b border-[#141414] flex items-center gap-3">
                  <LogoBox team={awayName} url={awayLogo} size={36} />
                  <div className="min-w-0">
                    <div className="text-white font-extrabold text-[13px] truncate">
                      {awayName}
                      <RankBadge rank={awayRank} />
                    </div>
                    <div className="text-[10px] text-[#8a8a8a] font-bold uppercase tracking-wide">
                      AWAY · {awayAbbr}
                    </div>
                  </div>
                </div>
                <div className="px-4 py-2">
                  {TEAM_RATINGS_FIELDS.map((f) => {
                    const v = (st.awayRatings as any)?.[f.key];
                    const txt = f.fmt ? f.fmt(v) : String(v ?? "—");
                    return (
                      <div key={f.key} className="grid grid-cols-2 gap-3 py-2 border-b border-[#141414] last:border-b-0">
                        <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">{f.label}</div>
                        <div className="text-right tabular-nums text-white font-extrabold">{txt}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-xl border border-[#1f1f1f] bg-black/20 overflow-hidden">
                <div className="px-4 py-3 border-b border-[#141414] flex items-center gap-3">
                  <LogoBox team={homeName} url={homeLogo} size={36} />
                  <div className="min-w-0">
                    <div className="text-white font-extrabold text-[13px] truncate">
                      {homeName}
                      <RankBadge rank={homeRank} />
                    </div>
                    <div className="text-[10px] text-[#8a8a8a] font-bold uppercase tracking-wide">
                      HOME · {homeAbbr}
                    </div>
                  </div>
                </div>
                <div className="px-4 py-2">
                  {TEAM_RATINGS_FIELDS.map((f) => {
                    const v = (st.homeRatings as any)?.[f.key];
                    const txt = f.fmt ? f.fmt(v) : String(v ?? "—");
                    return (
                      <div key={f.key} className="grid grid-cols-2 gap-3 py-2 border-b border-[#141414] last:border-b-0">
                        <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">{f.label}</div>
                        <div className="text-right tabular-nums text-white font-extrabold">{txt}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Stat compare (only if NCAAB) */}
            <div className="rounded-xl border border-[#1f1f1f] bg-black/20 overflow-hidden">
              <div className="px-4 py-3 border-b border-[#141414] text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">
                {String(sportKey).toLowerCase() === "basketball_ncaab"
                  ? `${mode === "off" ? "Offense" : "Defense"} · NCAAB stats (stat_key)`
                  : "NCAAB stats only available for BASKETBALL_NCAAB"}
              </div>

              <div className="px-4 py-2">
                {String(sportKey).toLowerCase() !== "basketball_ncaab" ? (
                  <div className="py-6 text-[11px] text-[#b0b0b0]">Switch sport to BASKETBALL_NCAAB to view team stat comparisons.</div>
                ) : st.loading ? (
                  <div className="py-6 text-[11px] text-[#b0b0b0]">Loading stats…</div>
                ) : (
                  statDefs.map((d) => {
                    const a = st.awayStats.get(d.key);
                    const h = st.homeStats.get(d.key);

                    const aTxt = Number.isFinite(a as any) ? (d.fmt ? d.fmt(a as number) : String(a)) : "—";
                    const hTxt = Number.isFinite(h as any) ? (d.fmt ? d.fmt(h as number) : String(h)) : "—";

                    const hib = d.higherIsBetter ?? true;

                    let aGood = false;
                    let hGood = false;
                    if (Number.isFinite(a as any) && Number.isFinite(h as any) && a !== h) {
                      if (hib) {
                        aGood = (a as number) > (h as number);
                        hGood = (h as number) > (a as number);
                      } else {
                        aGood = (a as number) < (h as number);
                        hGood = (h as number) < (a as number);
                      }
                    }

                    let deltaTxt = "—";
                    if (Number.isFinite(a as any) && Number.isFinite(h as any)) {
                      const dv = (a as number) - (h as number);
                      deltaTxt = `${dv > 0 ? "+" : ""}${dv.toFixed(3)}`;
                    }

                    return (
                      <div key={d.key} className="grid grid-cols-12 gap-3 items-center py-2 border-b border-[#141414] last:border-b-0">
                        <div className="col-span-5 min-w-0">
                          <div className="text-[11px] text-white font-extrabold truncate">{d.label}</div>
                          <div className="text-[10px] text-[#808080] font-semibold truncate">{d.key}</div>
                        </div>

                        <div className={cx("col-span-3 text-right tabular-nums", aGood ? "text-green-400 font-extrabold" : "text-[#d6d6d6] font-bold")}>
                          {aTxt}
                        </div>

                        <div className={cx("col-span-3 text-right tabular-nums", hGood ? "text-green-400 font-extrabold" : "text-[#d6d6d6] font-bold")}>
                          {hTxt}
                        </div>

                        <div className="col-span-1 text-right tabular-nums text-[#a8a8a8] font-bold">{deltaTxt}</div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="px-4 py-3 border-t border-[#141414] text-[10px] text-[#7a7a7a]">
                Canonical enforced · away uses away_score · home uses home_score
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-5 py-4 border-t border-[#141414] bg-[#0b0b0b] flex items-center justify-between">
            <div className="text-[10px] text-[#7a7a7a]">Portal modal · No click-through · Always renders shell</div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] px-4 py-2 text-[11px] font-extrabold text-white hover:bg-[#121212]"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // Portal target is always document.body
  if (typeof document === "undefined") return null;
  return createPortal(modal, document.body);
}

/* =========================================================
   Premium Desktop Cards
========================================================= */

function DesktopColumnsHeader() {
  const cols = ["Proj Score", "Win%", "Proj Margin", "Proj Total", "Cons Spread", "Cons Total"];
  return (
    <div className="sticky top-0 z-30 border-b border-[#2a2a2a] bg-[#0a0a0a]">
      <div className="grid grid-cols-[minmax(380px,1fr)_repeat(6,minmax(140px,180px))]">
        <div className="p-3 text-[#808080] text-xs font-bold">Matchup</div>
        {cols.map((c) => (
          <div key={c} className="p-3 text-[#808080] text-xs font-bold text-center">
            {c}
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricCell({
  title,
  value,
  sub,
  p,
  good,
}: {
  title: string;
  value: string;
  sub?: string;
  p?: number | null;
  good?: boolean;
}) {
  return (
    <div className="px-3 py-4 text-center flex flex-col items-center justify-center">
      <div className={cx("text-[14px] font-extrabold tabular-nums leading-none", good ? "text-green-400" : "text-white")}>
        {value}
      </div>
      <div className="mt-1 text-[10px] text-[#7a7a7a] font-semibold uppercase tracking-wide">{title}</div>
      {sub ? <div className="mt-1 text-[10px] text-[#9a9a9a] font-semibold tabular-nums">{sub}</div> : null}
      {p != null ? (
        <div className="mt-2 w-full">
          <ProbBar p={p} />
        </div>
      ) : null}
    </div>
  );
}

function TeamRowLine({ row, right }: { row: TeamRow; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <LogoBox team={row.teamName} url={row.logoUrl} size={36} />
      <div className="min-w-0">
        <div className="text-white font-extrabold text-[12px] truncate" title={row.teamName}>
          {row.teamName}
          <RankBadge rank={row.powerRank} />
        </div>
        <div className="text-[10px] text-[#7a7a7a] font-semibold">
          {row.side} · {row.teamAbbr}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2 shrink-0">{right}</div>
    </div>
  );
}

function DesktopMatchupCard({ ev, onOpenModel }: { ev: EventBundle; onOpenModel: () => void }) {
  const winnerAbbr = ev.away.isProjectedWinner ? ev.away.teamAbbr : ev.home.isProjectedWinner ? ev.home.teamAbbr : null;

  const consSpreadAway =
    ev.away.consSpreadLineTeam == null ? "—" : `${fmtSigned1(ev.away.consSpreadLineTeam)} (${american(ev.away.consSpreadOddsTeam)})`;
  const consSpreadHome =
    ev.home.consSpreadLineTeam == null ? "—" : `${fmtSigned1(ev.home.consSpreadLineTeam)} (${american(ev.home.consSpreadOddsTeam)})`;

  const consTotalOver =
    ev.away.consTotalLine == null ? "—" : `${fmtOU(ev.away.consTotalLine, "o")} (${american(ev.away.consTotalOverOdds)})`;
  const consTotalUnder =
    ev.home.consTotalLine == null ? "—" : `${fmtOU(ev.home.consTotalLine, "u")} (${american(ev.home.consTotalUnderOdds)})`;

  return (
    <div className="rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden hover:border-[#3a3a3a] transition">
      <div className="px-4 py-3 border-b border-[#141414] bg-black/20">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <RecencyDot ts={ev.consensusTs} />
              <div className="text-white font-extrabold truncate">
                {ev.away.teamAbbr} @ {ev.home.teamAbbr}
                <span className="text-[#404040]"> · </span>
                <span className="text-[#b0b0b0]">{fmtDateCentral(ev.commenceTime)}</span>
                <span className="text-[#404040]"> </span>
                <span className="text-[#b0b0b0]">{fmtTimeCentral(ev.commenceTime)}</span>
              </div>

              {winnerAbbr ? (
                <span className="hidden lg:inline-flex items-center rounded-full border border-[#2a2a2a] bg-[#0b0b0b] px-2 py-0.5 text-[10px] font-extrabold text-[#d4af37]">
                  Proj Winner: {winnerAbbr}
                </span>
              ) : null}
            </div>

            {ev.consensusTs ? (
              <div className="mt-1 text-[10px] text-[#7a7a7a]">
                Consensus updated: <span className="text-[#b0b0b0]">{formatTs(ev.consensusTs)}</span>
              </div>
            ) : null}
          </div>

          <div className="shrink-0">
            <SoftButton onClick={onOpenModel} title="Open Model View">
              Model
            </SoftButton>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(380px,1fr)_repeat(6,minmax(140px,180px))]">
        <div className="p-4 border-r border-[#141414] space-y-3">
          <TeamRowLine
            row={ev.away}
            right={
              <>
                <div className={cx("text-[14px] font-extrabold tabular-nums", ev.away.isProjectedWinner ? "text-green-400" : "text-white")}>
                  {ev.away.projPoints.toFixed(1)}
                </div>
                <div className="text-[11px] text-[#bdbdbd] font-bold tabular-nums">{pct01(ev.away.winProbTeam)}</div>
              </>
            }
          />
          <TeamRowLine
            row={ev.home}
            right={
              <>
                <div className={cx("text-[14px] font-extrabold tabular-nums", ev.home.isProjectedWinner ? "text-green-400" : "text-white")}>
                  {ev.home.projPoints.toFixed(1)}
                </div>
                <div className="text-[11px] text-[#bdbdbd] font-bold tabular-nums">{pct01(ev.home.winProbTeam)}</div>
              </>
            }
          />
        </div>

        <MetricCell title="Away / Home" value={`${ev.away.projPoints.toFixed(1)} · ${ev.home.projPoints.toFixed(1)}`} sub="Proj Score" />
        <MetricCell title="Away Win%" value={pct01(ev.away.winProbTeam)} p={ev.away.winProbTeam} good={ev.away.isProjectedWinner} />
        <MetricCell title="Away Margin" value={fmtSigned1(ev.away.projMarginTeam)} sub={`Cover ${pct01(ev.away.coverProbTeam)}`} p={ev.away.coverProbTeam ?? null} />
        <MetricCell title="Proj Total" value={fmtLinePlain(ev.home.projTotal)} sub={`Over ${pct01(ev.away.overProb)} / Under ${pct01(ev.home.underProb)}`} />
        <MetricCell title="Cons Spread" value={`${consSpreadAway} / ${consSpreadHome}`} />
        <MetricCell title="Cons Total" value={`${consTotalOver} / ${consTotalUnder}`} />
      </div>
    </div>
  );
}

/* =========================================================
   Screen
========================================================= */

export const MonteCarloScreen = ({ sportKey }: { sportKey: SportKey }) => {
  const [run, setRun] = useState<MonteCarloRun | null>(null);
  const [results, setResults] = useState<MonteCarloResultRow[]>([]);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [logoMap, setLogoMap] = useState<Map<string, string>>(new Map());
  const [abbrMap, setAbbrMap] = useState<Map<string, string>>(new Map());
  const [powerRankMap, setPowerRankMap] = useState<Map<string, number>>(new Map());

  const [consensusMap, setConsensusMap] = useState<Map<string, Consensus>>(new Map());
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});

  const [loadingRun, setLoadingRun] = useState(true);
  const [loadingResults, setLoadingResults] = useState(false);
  const [loadingConsensus, setLoadingConsensus] = useState(false);

  // Modal
  const [modelOpen, setModelOpen] = useState(false);
  const [modelEvent, setModelEvent] = useState<EventBundle | null>(null);

  /* team_map */
  useEffect(() => {
    let mounted = true;
    async function loadTeamMap() {
      const { data, error } = await supabase.from("team_map").select('canonical,"Logo URL","Abbreviation"');
      if (!mounted) return;

      if (error) {
        console.warn("[MonteCarloScreen] team_map error:", error.message);
        setLogoMap(new Map());
        setAbbrMap(new Map());
        return;
      }

      const lm = new Map<string, string>();
      const am = new Map<string, string>();

      for (const r of (data ?? []) as TeamMapRow[]) {
        const k = normKey(r.canonical);
        if (!k) continue;
        const url = (r["Logo URL"] ?? "").trim();
        if (url) lm.set(k, url);
        const ab = (r.Abbreviation ?? "").trim();
        if (ab) am.set(k, ab.toUpperCase());
      }

      setLogoMap(lm);
      setAbbrMap(am);
    }

    loadTeamMap();
    return () => {
      mounted = false;
    };
  }, []);

  /* power ranks */
  useEffect(() => {
    let mounted = true;
    async function loadPowerRanks() {
      const { data, error } = await supabase
        .from("team_ratings")
        .select("canonical,power_rank,sport_key")
        .eq("sport_key", sportKey);

      if (!mounted) return;

      if (error) {
        console.warn("[MonteCarloScreen] team_ratings error (power ranks):", error.message);
        setPowerRankMap(new Map());
        return;
      }

      const pm = new Map<string, number>();
      for (const r of (data ?? []) as Array<{ canonical: string; power_rank: number | null }>) {
        const k = normKey(r.canonical);
        const pr = r.power_rank == null ? null : Number(r.power_rank);
        if (!k) continue;
        if (pr != null && Number.isFinite(pr)) pm.set(k, pr);
      }
      setPowerRankMap(pm);
    }

    loadPowerRanks();
    return () => {
      mounted = false;
    };
  }, [sportKey]);

  /* latest run */
  useEffect(() => {
    let mounted = true;
    async function loadRun() {
      setLoadingRun(true);
      setSettingsError(null);
      setRun(null);
      setResults([]);
      setConsensusMap(new Map());

      const { data, error } = await supabase
        .from("monte_carlo_runs")
        .select("id,created_at,sport_key")
        .eq("sport_key", sportKey)
        .order("created_at", { ascending: false })
        .limit(1);

      if (!mounted) return;

      if (error) {
        setSettingsError(error.message);
        setRun(null);
        setLoadingRun(false);
        return;
      }

      setRun((data?.[0] ?? null) as MonteCarloRun | null);
      setLoadingRun(false);
    }

    loadRun();
    return () => {
      mounted = false;
    };
  }, [sportKey]);

  /* results */
  useEffect(() => {
    let mounted = true;
    async function loadResults(runId: string) {
      setLoadingResults(true);
      setSettingsError(null);

      const cols = [
        "run_id",
        "sport_key",
        "event_id",
        "commence_time",
        "home_team",
        "away_team",
        "projected_margin_home",
        "projected_total",
        "projected_home_points",
        "projected_away_points",
        "home_cover_prob",
        "away_cover_prob",
        "over_prob",
        "under_prob",
        "home_win_prob",
        "away_win_prob",
      ].join(",");

      const { data, error } = await supabase
        .from("monte_carlo_results")
        .select(cols)
        .eq("run_id", runId)
        .eq("sport_key", sportKey)
        .order("commence_time", { ascending: true });

      if (!mounted) return;

      if (error) {
        setSettingsError(error.message);
        setResults([]);
        setLoadingResults(false);
        return;
      }

      setResults((data ?? []) as MonteCarloResultRow[]);
      setLoadingResults(false);
    }

    if (run?.id) loadResults(run.id);
    return () => {
      mounted = false;
    };
  }, [run?.id, sportKey]);

  /* consensus */
  useEffect(() => {
    let mounted = true;
    async function loadConsensus(eventIds: string[]) {
      if (!eventIds.length) {
        setConsensusMap(new Map());
        return;
      }

      setLoadingConsensus(true);

      const { data, error } = await supabase
        .from("odds_snapshot")
        .select("ts,event_id,market,side,line,odds,bookmaker")
        .in("event_id", eventIds)
        .in("market", ["spreads", "totals"])
        .order("ts", { ascending: false })
        .limit(8000);

      if (!mounted) return;

      if (error) {
        console.warn("[MonteCarloScreen] odds_snapshot error:", error.message);
        setConsensusMap(new Map());
        setLoadingConsensus(false);
        return;
      }

      const rows = (data ?? []) as OddsSnapshotRow[];
      const seen = new Set<string>();

      const spreadHomeLines = new Map<string, number[]>();
      const spreadHomeOdds = new Map<string, number[]>();
      const spreadAwayOdds = new Map<string, number[]>();

      const totalLines = new Map<string, number[]>();
      const totalOverOdds = new Map<string, number[]>();
      const totalUnderOdds = new Map<string, number[]>();

      const bestTsByEvent = new Map<string, string>();

      for (const r of rows) {
        const eventId = (r.event_id ?? "").trim();
        const market = (r.market ?? "").trim().toLowerCase();
        const book = (r.bookmaker ?? "").trim().toLowerCase() || "unknown";
        const side = normalizeSide(r.side);
        if (!eventId || !market || !side) continue;

        if (r.ts) {
          const prev = bestTsByEvent.get(eventId);
          if (!prev || new Date(r.ts).getTime() > new Date(prev).getTime()) bestTsByEvent.set(eventId, r.ts);
        }

        const k = `${eventId}|${market}|${book}|${side}`;
        if (seen.has(k)) continue;
        seen.add(k);

        const line = Number(r.line);
        const odds = Number(r.odds);

        if (market === "spreads") {
          if (side === "home") {
            if (Number.isFinite(line)) pushMap(spreadHomeLines, eventId, line);
            if (Number.isFinite(odds)) pushMap(spreadHomeOdds, eventId, odds);
          }
          if (side === "away") {
            if (Number.isFinite(odds)) pushMap(spreadAwayOdds, eventId, odds);
          }
        }

        if (market === "totals") {
          if (side === "over") {
            if (Number.isFinite(line)) pushMap(totalLines, eventId, line);
            if (Number.isFinite(odds)) pushMap(totalOverOdds, eventId, odds);
          }
          if (side === "under") {
            if (Number.isFinite(odds)) pushMap(totalUnderOdds, eventId, odds);
          }
        }
      }

      const m = new Map<string, Consensus>();
      for (const eventId of eventIds) {
        m.set(eventId, {
          ts: bestTsByEvent.get(eventId) ?? null,
          spread_home_line: medianOrNull(spreadHomeLines.get(eventId) ?? []),
          spread_home_odds: medianOrNull(spreadHomeOdds.get(eventId) ?? []),
          spread_away_odds: medianOrNull(spreadAwayOdds.get(eventId) ?? []),
          total_line: medianOrNull(totalLines.get(eventId) ?? []),
          total_over_odds: medianOrNull(totalOverOdds.get(eventId) ?? []),
          total_under_odds: medianOrNull(totalUnderOdds.get(eventId) ?? []),
        });
      }

      setConsensusMap(m);
      setLoadingConsensus(false);
    }

    const ids = Array.from(new Set(results.map((r) => r.event_id).filter(Boolean)));
    loadConsensus(ids);

    return () => {
      mounted = false;
    };
  }, [results]);

  /* bundle */
  const events: EventBundle[] = useMemo(() => {
    const out: EventBundle[] = [];

    for (const r of results) {
      const homeRaw = (r.home_team ?? "").trim();
      const awayRaw = (r.away_team ?? "").trim();
      if (!homeRaw || !awayRaw) continue;

      const homeKey = normKey(homeRaw);
      const awayKey = normKey(awayRaw);

      const homeAbbr = abbrMap.get(homeKey) ?? "HOME";
      const awayAbbr = abbrMap.get(awayKey) ?? "AWAY";

      const marginHome = safeNum(r.projected_margin_home, 0);
      const totalProj = safeNum(r.projected_total, 0);

      const homePtsStored = Number(r.projected_home_points);
      const awayPtsStored = Number(r.projected_away_points);

      const homePts = Number.isFinite(homePtsStored) ? homePtsStored : (totalProj + marginHome) / 2;
      const awayPts = Number.isFinite(awayPtsStored) ? awayPtsStored : (totalProj - marginHome) / 2;

      const pHomeCover = r.home_cover_prob != null ? Number(r.home_cover_prob) : null;
      const pAwayCover = r.away_cover_prob != null ? Number(r.away_cover_prob) : null;

      const pOver = r.over_prob != null ? Number(r.over_prob) : null;
      const pUnder = r.under_prob != null ? Number(r.under_prob) : null;

      const pHomeWin = r.home_win_prob != null ? Number(r.home_win_prob) : null;
      const pAwayWin = r.away_win_prob != null ? Number(r.away_win_prob) : null;

      const finalHomeWin = pHomeWin ?? (pAwayWin != null ? 1 - pAwayWin : null);
      const finalAwayWin = pAwayWin ?? (finalHomeWin != null ? 1 - finalHomeWin : null);

      const c = consensusMap.get(r.event_id) ?? null;
      const consSpreadHome = c?.spread_home_line ?? null;
      const consTotal = c?.total_line ?? null;

      const awayIsWinner = awayPts > homePts;
      const homeIsWinner = homePts > awayPts;

      const awayRow: TeamRow = {
        eventId: r.event_id,
        commenceTime: r.commence_time ?? null,
        side: "AWAY",
        teamName: awayRaw,
        teamAbbr: awayAbbr,
        logoUrl: logoMap.get(awayKey) ?? null,
        powerRank: powerRankMap.get(awayKey) ?? null,
        projPoints: Math.round(awayPts * 10) / 10,
        projMarginTeam: Math.round(-marginHome * 10) / 10,
        coverProbTeam: pAwayCover,
        projTotal: Math.round(totalProj * 10) / 10,
        overProb: pOver,
        underProb: pUnder,
        winProbTeam: finalAwayWin,
        consSpreadLineTeam: consSpreadHome == null ? null : Math.round(-consSpreadHome * 10) / 10,
        consSpreadOddsTeam: c?.spread_away_odds ?? null,
        consTotalLine: consTotal == null ? null : Math.round(consTotal * 10) / 10,
        consTotalOverOdds: c?.total_over_odds ?? null,
        consTotalUnderOdds: c?.total_under_odds ?? null,
        isProjectedWinner: awayIsWinner,
      };

      const homeRow: TeamRow = {
        eventId: r.event_id,
        commenceTime: r.commence_time ?? null,
        side: "HOME",
        teamName: homeRaw,
        teamAbbr: homeAbbr,
        logoUrl: logoMap.get(homeKey) ?? null,
        powerRank: powerRankMap.get(homeKey) ?? null,
        projPoints: Math.round(homePts * 10) / 10,
        projMarginTeam: Math.round(marginHome * 10) / 10,
        coverProbTeam: pHomeCover,
        projTotal: Math.round(totalProj * 10) / 10,
        overProb: pOver,
        underProb: pUnder,
        winProbTeam: finalHomeWin,
        consSpreadLineTeam: consSpreadHome == null ? null : Math.round(consSpreadHome * 10) / 10,
        consSpreadOddsTeam: c?.spread_home_odds ?? null,
        consTotalLine: consTotal == null ? null : Math.round(consTotal * 10) / 10,
        consTotalOverOdds: c?.total_over_odds ?? null,
        consTotalUnderOdds: c?.total_under_odds ?? null,
        isProjectedWinner: homeIsWinner,
      };

      out.push({
        eventId: r.event_id,
        commenceTime: r.commence_time ?? null,
        away: awayRow,
        home: homeRow,
        consensusTs: c?.ts ?? null,
      });
    }

    return out;
  }, [results, abbrMap, logoMap, consensusMap, powerRankMap]);

  useEffect(() => {
    setOpenMap((prev) => {
      const next: Record<string, boolean> = {};
      for (const ev of events) next[ev.eventId] = prev[ev.eventId] ?? false;
      return next;
    });
  }, [events]);

  const loading = loadingRun || loadingResults;

  const consensusStamp = useMemo(() => {
    const stamps: number[] = [];
    for (const ev of events) {
      if (ev.consensusTs) {
        const t = new Date(ev.consensusTs).getTime();
        if (Number.isFinite(t)) stamps.push(t);
      }
    }
    if (!stamps.length) return null;
    return new Date(Math.max(...stamps)).toLocaleString();
  }, [events]);

  const openModel = (ev: EventBundle) => {
    // Force-set both in same tick; never leaves the UI in overlay-only state
    setModelEvent(ev);
    setModelOpen(true);
  };

  return (
    <div className="h-[calc(100vh-120px)] md:h-[calc(100vh-140px)] overflow-y-auto pr-1 space-y-4">
      <ModelModalPortal
        open={modelOpen}
        onClose={() => setModelOpen(false)}
        sportKey={sportKey}
        event={modelEvent}
        logoMap={logoMap}
        abbrMap={abbrMap}
      />

      {/* HERO */}
      <div className="relative overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] p-4 md:p-5">
        <div
          className="pointer-events-none absolute inset-0 opacity-95"
          style={{
            background:
              "radial-gradient(900px 260px at 18% 0%, rgba(212,175,55,0.18), transparent 62%), radial-gradient(700px 240px at 85% 12%, rgba(255,255,255,0.05), transparent 60%)",
          }}
        />

        <div className="relative flex flex-col md:flex-row md:items-start md:justify-between gap-4">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-1 text-[11px] text-[#b0b0b0]">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#d4af37" }} />
              Prism Model Projections
            </div>

            <h2 className="text-lg md:text-xl text-white mt-2 tracking-tight">Monte Carlo</h2>

            <div className="text-xs text-[#a8a8a8] mt-1 leading-relaxed">
              Premium matchup cards. Click <span className="text-white font-extrabold">Model</span> for combined stats & ratings.
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <Pill label="Sport" value={String(sportKey).toUpperCase()} />
              <Pill label="Games" value={loading ? "…" : String(events.length)} />
              <Pill label="Latest Run" value={run?.created_at ? formatTs(run.created_at) : "—"} />
              <Pill label="Consensus" value={loadingConsensus ? "…" : consensusStamp ?? "—"} />
            </div>
          </div>

          <div className="w-full md:w-auto">
            {loading ? (
              <div className="relative mt-1 md:mt-0 text-xs text-[#808080] px-3 py-2 bg-[#0b0b0b] border border-[#2a2a2a] rounded-lg">
                Loading Monte Carlo…
              </div>
            ) : null}

            {settingsError ? (
              <div className="relative mt-2 text-xs text-red-400 px-3 py-2 bg-[#0b0b0b] border border-red-900/50 rounded-lg">
                Failed to load monte_carlo: {settingsError}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* DESKTOP */}
      <div className="hidden md:block bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl overflow-hidden">
        <div className="max-h-[70vh] overflow-y-auto">
          <DesktopColumnsHeader />

          <div className="p-4 space-y-3">
            {!loading && !events.length ? (
              <div className="p-10 text-center text-xs text-[#808080]">No Monte Carlo rows found for this sport/run.</div>
            ) : null}

            {events.map((ev) => (
              <DesktopMatchupCard key={ev.eventId} ev={ev} onOpenModel={() => openModel(ev)} />
            ))}
          </div>
        </div>
      </div>

      {/* MOBILE */}
      <div className="md:hidden space-y-3">
        {!loading && !events.length ? (
          <div className="text-xs text-[#808080] px-3 py-10 bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl text-center">
            No Monte Carlo rows found for this sport/run.
          </div>
        ) : null}

        {events.map((ev) => {
          const open = !!openMap[ev.eventId];

          return (
            <div key={ev.eventId} className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-white text-sm truncate">
                      {ev.away.teamAbbr} @ {ev.home.teamAbbr}
                    </div>
                    <RecencyDot ts={ev.consensusTs} />
                  </div>

                  <div className="text-[11px] text-[#808080] mt-1">
                    {fmtDateCentral(ev.commenceTime)} · {fmtTimeCentral(ev.commenceTime)}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <SoftButton onClick={() => openModel(ev)} title="Open Model View">
                    Model
                  </SoftButton>

                  <button
                    type="button"
                    onClick={() => setOpenMap((p) => ({ ...p, [ev.eventId]: !p[ev.eventId] }))}
                    className="px-3 py-2 rounded-lg bg-[#111] border border-[#2a2a2a] text-[11px] text-[#d0d0d0] hover:bg-[#141414]"
                  >
                    {open ? "Hide" : "Details"}
                  </button>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-3 min-w-0">
                <LogoBox team={ev.away.teamName} url={ev.away.logoUrl} size={34} />
                <div className="min-w-0 leading-tight">
                  <div className="text-[11px] text-white font-extrabold truncate" title={ev.away.teamName}>
                    {ev.away.teamName}
                    <RankBadge rank={ev.away.powerRank} />
                  </div>
                  <div className="text-[9px] text-[#7a7a7a] font-semibold">AWAY · {ev.away.teamAbbr}</div>
                </div>

                <div className="ml-auto text-right tabular-nums shrink-0">
                  <div className={cx("font-extrabold text-[13px]", ev.away.isProjectedWinner ? "text-green-400" : "text-white")}>
                    {ev.away.projPoints.toFixed(1)}
                  </div>
                  <div className="text-[10px] text-[#bdbdbd] font-bold">{pct01(ev.away.winProbTeam)}</div>
                  <ProbBar p={ev.away.winProbTeam} />
                </div>
              </div>

              <div className="mt-3 flex items-center gap-3 min-w-0">
                <LogoBox team={ev.home.teamName} url={ev.home.logoUrl} size={34} />
                <div className="min-w-0 leading-tight">
                  <div className="text-[11px] text-white font-extrabold truncate" title={ev.home.teamName}>
                    {ev.home.teamName}
                    <RankBadge rank={ev.home.powerRank} />
                  </div>
                  <div className="text-[9px] text-[#7a7a7a] font-semibold">HOME · {ev.home.teamAbbr}</div>
                </div>

                <div className="ml-auto text-right tabular-nums shrink-0">
                  <div className={cx("font-extrabold text-[13px]", ev.home.isProjectedWinner ? "text-green-400" : "text-white")}>
                    {ev.home.projPoints.toFixed(1)}
                  </div>
                  <div className="text-[10px] text-[#bdbdbd] font-bold">{pct01(ev.home.winProbTeam)}</div>
                  <ProbBar p={ev.home.winProbTeam} />
                </div>
              </div>

              {open ? (
                <div className="mt-3">
                  <MobileDetailsBlock away={ev.away} home={ev.home} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default MonteCarloScreen;

