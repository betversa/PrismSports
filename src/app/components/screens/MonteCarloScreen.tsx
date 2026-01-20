"use client";

// src/app/components/screens/MonteCarloScreen.tsx — FULL REWRITE (v13.0.0)
// -----------------------------------------------------------------------------------------------------
// ✅ Win / Cover / Total % values are now BAR-ONLY (no more redundant text)
// ✅ Winner/loser coloring:
//    - Win bars + Cover bars: projected winner = GREEN bar, projected loser = RED bar
//    - Total bars (Over/Under): higher probability = GREEN, lower = RED
// ✅ Stacked formatting everywhere (no wrapped slash pairs)
// ✅ One Model button per matchup (portal modal, stable — avoids white-screen issues)
// ✅ Premium polish: cleaner spacing, stronger hierarchy, softer borders, better rhythm
// -----------------------------------------------------------------------------------------------------

import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../lib/supabaseClient";
import { ScreenShell, SectionCard, SectionHeader } from "../ScreenShell";
import type { SportKey } from "../../App";
import { medianOrNull, safeNumber } from "../../../lib/odds/math";
import {
  formatAmerican,
  formatLinePlain,
  formatMaybeInt,
  formatMaybeNumber,
  formatOuLine,
  formatSignedNumber,
} from "../../../lib/odds/format";

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

type MlAdjustmentRow = {
  event_id: string;
  run_id: string;
  base_home_win_prob: number | null;
  base_away_win_prob: number | null;
  adj_home_win_prob: number | null;
  adj_away_win_prob: number | null;
  base_home_cover_prob: number | null;
  base_away_cover_prob: number | null;
  adj_home_cover_prob: number | null;
  adj_away_cover_prob: number | null;
  base_over_prob: number | null;
  base_under_prob: number | null;
  adj_over_prob: number | null;
  adj_under_prob: number | null;
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
  baseCoverProbTeam: number | null;
  adjCoverProbTeam: number | null;

  projTotal: number;
  overProb: number | null;
  underProb: number | null;
  baseOverProb: number | null;
  adjOverProb: number | null;
  baseUnderProb: number | null;
  adjUnderProb: number | null;

  winProbTeam: number | null;
  baseWinProbTeam: number | null;
  adjWinProbTeam: number | null;

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

const fmtAmerican = (odds: number | null) => formatAmerican(odds ?? NaN);

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

function fmtPct01(p: number | null) {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}%`;
}

function formatBaseAdjLabel(base: number | null, adj: number | null) {
  const baseTxt = fmtPct01(base);
  if (adj == null || !Number.isFinite(adj)) return `Base ${baseTxt}`;
  return `Base ${baseTxt} • AI ${fmtPct01(adj)}`;
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


/* =========================================================
   UI atoms
========================================================= */

function GlowDot() {
  return (
    <span className="relative inline-flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: "rgba(212,175,55,0.35)" }} />
      <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: "#d4af37" }} />
    </span>
  );
}

function LogoBox({ team, url, size }: { team: string; url: string | null; size: number }) {
  const [ok, setOk] = useState(true);
  if (!url || !ok) {
    return (
      <div
        style={{ width: size, height: size }}
        className="rounded-md bg-white/90 border border-[#e5e5e5]"
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
        top ? "border-[#d4af37] bg-[#1a1406] text-[#f5e7b7]" : "border-[#252525] bg-[#0b0b0b] text-[#d4af37]"
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
      className="inline-flex items-center gap-2 rounded-xl border border-[#252525] bg-[#0b0b0b] px-3.5 py-2 text-[11px] font-black tracking-wide text-white hover:bg-[#121212] active:scale-[0.99] transition"
    >
      {children}
    </button>
  );
}

function SkeletonLine({ w = "w-full" }: { w?: string }) {
  return <div className={cx("h-3 rounded-md bg-[#151515] animate-pulse", w)} />;
}

function RecencyDot({ ts }: { ts: string | null }) {
  if (!ts) return <span className="inline-block h-2 w-2 rounded-full bg-[#3a3a3a]" title="Update: unknown" />;
  const ageMs = Date.now() - new Date(ts).getTime();
  const ok = Number.isFinite(ageMs);
  const dot =
    !ok ? "#3a3a3a" : ageMs <= 5 * 60_000 ? "#22c55e" : ageMs <= 30 * 60_000 ? "#d4af37" : "#6b7280";
  const label =
    !ok
      ? "Update: unknown"
      : ageMs <= 5 * 60_000
      ? "Updated within 5 min"
      : ageMs <= 30 * 60_000
      ? "Updated within 30 min"
      : "Older update";
  return <span className="inline-block h-2 w-2 rounded-full" style={{ background: dot }} title={label} />;
}

/* =========================================================
   Bars (bar-only % data + winner/loser colors)
========================================================= */

type BarTone = "gold" | "green" | "red" | "muted";

function barColor(tone: BarTone) {
  if (tone === "green") return "#22c55e";
  if (tone === "red") return "#ef4444";
  if (tone === "muted") return "#3a3a3a";
  return "#d4af37"; // gold
}

function ProbBar({
  p,
  tone = "gold",
}: {
  p: number | null;
  tone?: BarTone;
}) {
  const w = p != null && Number.isFinite(p) ? Math.max(0, Math.min(1, p)) * 100 : 0;
  return (
    <div className="mt-1 h-[7px] w-full rounded-full bg-[#141414] overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${w}%`, background: barColor(tone) }} />
    </div>
  );
}

function ProbBarDual({
  top,
  bottom,
  topLabel,
  bottomLabel,
  topTone,
  bottomTone,
}: {
  top: number | null;
  bottom: number | null;
  topLabel: string;
  bottomLabel: string;
  topTone: BarTone;
  bottomTone: BarTone;
}) {
  return (
    <div className="mt-2 w-full space-y-2">
      <div>
        <div className="flex items-center justify-between text-[10px] text-[#8a8a8a] font-semibold tracking-wide mb-1">
          <span>{topLabel}</span>
          <span className="tabular-nums text-[#cfcfcf]">{top == null || !Number.isFinite(top) ? "—" : `${(top * 100).toFixed(1)}%`}</span>
        </div>
        <ProbBar p={top} tone={topTone} />
      </div>
      <div>
        <div className="flex items-center justify-between text-[10px] text-[#8a8a8a] font-semibold tracking-wide mb-1">
          <span>{bottomLabel}</span>
          <span className="tabular-nums text-[#cfcfcf]">{bottom == null || !Number.isFinite(bottom) ? "—" : `${(bottom * 100).toFixed(1)}%`}</span>
        </div>
        <ProbBar p={bottom} tone={bottomTone} />
      </div>
    </div>
  );
}

/* =========================================================
   Mobile details (bar-only for % values)
========================================================= */

function MobileDetailsBlock({ away, home }: { away: TeamRow; home: TeamRow }) {
  const winnerToneAway: BarTone = away.isProjectedWinner ? "green" : "red";
  const winnerToneHome: BarTone = home.isProjectedWinner ? "green" : "red";

  const overTone: BarTone =
    (away.overProb ?? 0) >= (home.underProb ?? 0) ? "green" : "red";
  const underTone: BarTone =
    (home.underProb ?? 0) >= (away.overProb ?? 0) ? "green" : "red";

  const Row = ({
    label,
    aTop,
    aBottom,
    hTop,
    hBottom,
    aBar,
    hBar,
    aTone,
    hTone,
    aMeta,
    hMeta,
  }: {
    label: string;
    aTop: React.ReactNode;
    aBottom?: React.ReactNode;
    hTop: React.ReactNode;
    hBottom?: React.ReactNode;
    aBar?: number | null;
    hBar?: number | null;
    aTone?: BarTone;
    hTone?: BarTone;
    aMeta?: React.ReactNode;
    hMeta?: React.ReactNode;
  }) => (
    <div className="grid grid-cols-3 gap-2 py-2 border-b border-[#141414] last:border-b-0 items-start">
      <div className="text-[10px] tracking-[0.14em] uppercase text-[#8a8a8a] font-semibold pt-0.5">{label}</div>

      <div className="text-right">
        <div className="text-[11px] text-white font-extrabold tabular-nums leading-tight">{aTop}</div>
        {aBottom != null ? <div className="text-[10px] text-[#9a9a9a] font-semibold mt-1">{aBottom}</div> : null}
        {aMeta != null ? <div className="text-[10px] text-[#7a7a7a] font-semibold mt-1">{aMeta}</div> : null}
        {aBar != null ? <ProbBar p={aBar} tone={aTone ?? "gold"} /> : null}
      </div>

      <div className="text-right">
        <div className="text-[11px] text-white font-extrabold tabular-nums leading-tight">{hTop}</div>
        {hBottom != null ? <div className="text-[10px] text-[#9a9a9a] font-semibold mt-1">{hBottom}</div> : null}
        {hMeta != null ? <div className="text-[10px] text-[#7a7a7a] font-semibold mt-1">{hMeta}</div> : null}
        {hBar != null ? <ProbBar p={hBar} tone={hTone ?? "gold"} /> : null}
      </div>
    </div>
  );

  return (
    <div className="rounded-xl border border-[#252525] bg-black/18 overflow-hidden">
      <div className="px-4 py-2 border-b border-[#141414] text-[11px] text-white font-black tracking-wide">
        Details
      </div>

      <div className="px-4">
        {/* Win% is BAR-ONLY: no win% text */}
        <Row
          label="Win"
          aTop="—"
          hTop="—"
          aBar={away.winProbTeam}
          hBar={home.winProbTeam}
          aTone={winnerToneAway}
          hTone={winnerToneHome}
          aMeta={formatBaseAdjLabel(away.baseWinProbTeam, away.adjWinProbTeam)}
          hMeta={formatBaseAdjLabel(home.baseWinProbTeam, home.adjWinProbTeam)}
        />

        {/* Cover% is BAR-ONLY: no cover% text; margin stays as number */}
        <Row
          label="Margin"
          aTop={formatSignedNumber(away.projMarginTeam)}
          hTop={formatSignedNumber(home.projMarginTeam)}
          aBar={away.coverProbTeam}
          hBar={home.coverProbTeam}
          aTone={winnerToneAway}
          hTone={winnerToneHome}
          aMeta={formatBaseAdjLabel(away.baseCoverProbTeam, away.adjCoverProbTeam)}
          hMeta={formatBaseAdjLabel(home.baseCoverProbTeam, home.adjCoverProbTeam)}
        />

        {/* Total: over/under are BAR-ONLY; projected total stays as number */}
        <Row
          label="Total"
          aTop={formatLinePlain(away.projTotal)}
          aBottom="Over"
          hTop={formatLinePlain(home.projTotal)}
          hBottom="Under"
          aBar={away.overProb}
          hBar={home.underProb}
          aTone={overTone}
          hTone={underTone}
          aMeta={formatBaseAdjLabel(away.baseOverProb, away.adjOverProb)}
          hMeta={formatBaseAdjLabel(home.baseUnderProb, home.adjUnderProb)}
        />

        {/* Consensus spread */}
        <Row
          label="Spread"
          aTop={away.consSpreadLineTeam == null ? "—" : formatSignedNumber(away.consSpreadLineTeam)}
          aBottom={away.consSpreadLineTeam == null ? undefined : fmtAmerican(away.consSpreadOddsTeam)}
          hTop={home.consSpreadLineTeam == null ? "—" : formatSignedNumber(home.consSpreadLineTeam)}
          hBottom={home.consSpreadLineTeam == null ? undefined : fmtAmerican(home.consSpreadOddsTeam)}
        />

        {/* Consensus total */}
        <Row
          label="Total"
          aTop={away.consTotalLine == null ? "—" : formatOuLine(away.consTotalLine, "o")}
          aBottom={away.consTotalLine == null ? undefined : fmtAmerican(away.consTotalOverOdds)}
          hTop={home.consTotalLine == null ? "—" : formatOuLine(home.consTotalLine, "u")}
          hBottom={home.consTotalLine == null ? undefined : fmtAmerican(home.consTotalUnderOdds)}
        />
      </div>
    </div>
  );
}

/* =========================================================
   Modal (portal) — stable + keeps your existing stats logic
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
  { key: "power_rank", label: "Power Rank", fmt: (v) => formatMaybeInt(v) },
  { key: "engine_power", label: "Net Rating", fmt: (v) => formatMaybeNumber(v, 2) },
  { key: "engine_adj_off", label: "Adj Off", fmt: (v) => formatMaybeNumber(v, 2) },
  { key: "engine_adj_def", label: "Adj Def", fmt: (v) => formatMaybeNumber(v, 2) },
  { key: "pace", label: "Pace", fmt: (v) => formatMaybeNumber(v, 2) },
  { key: "true_hca", label: "True HCA", fmt: (v) => formatMaybeNumber(v, 2) },
  { key: "sigma_margin_100", label: "Sigma Margin", fmt: (v) => formatMaybeNumber(v, 2) },
  { key: "sigma_total_100", label: "Sigma Total", fmt: (v) => formatMaybeNumber(v, 2) },
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

  useEffect(() => setMounted(true), []);

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

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    let alive = true;

    async function load() {
      if (!open || !event) return;

      const awayCanonical = event.away?.teamName ?? "";
      const homeCanonical = event.home?.teamName ?? "";

      if (!awayCanonical || !homeCanonical) {
        if (!alive) return;
        setSt((p) => ({ ...p, loading: false, error: "Missing team names for this matchup." }));
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
        const ratingsRes = await supabase
          .from("team_ratings")
          .select("*")
          .eq("sport_key", sportKey)
          .in("canonical", [awayCanonical, homeCanonical]);

        if (ratingsRes.error) throw new Error(ratingsRes.error.message);

        const ratings = (ratingsRes.data ?? []) as TeamRatingsRow[];
        const awayRatings =
          ratings.find((r) => normKey(String(r.canonical ?? "")) === normKey(awayCanonical)) ?? null;
        const homeRatings =
          ratings.find((r) => normKey(String(r.canonical ?? "")) === normKey(homeCanonical)) ?? null;

        let awayStats = new Map<string, number>();
        let homeStats = new Map<string, number>();

        if (String(sportKey).toLowerCase() === "basketball_ncaab") {
          const statsRes = await supabase
            .from("ncaab_stats")
            .select("canonical,stat_key,home_score,away_score")
            .in("canonical", [awayCanonical, homeCanonical]);

          if (statsRes.error) throw new Error(statsRes.error.message);

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
        setSt((p) => ({ ...p, loading: false, error: String(e?.message ?? e) }));
      }
    }

    load();
    return () => {
      alive = false;
    };
  }, [open, event?.eventId, sportKey]);

  if (!mounted || !open) return null;

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
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(1100px 440px at 18% 0%, rgba(212,175,55,0.18), transparent 60%), rgba(0,0,0,0.82)",
        }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      />

      <div className="absolute inset-0 flex items-center justify-center px-3">
        <div
          className="w-[min(1040px,calc(100vw-24px))] max-h-[calc(100vh-24px)] overflow-hidden rounded-2xl border border-[#252525] bg-[#0b0b0b] shadow-2xl"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          {/* Header */}
          <div className="px-5 pt-5 pb-4 border-b border-[#141414]">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="inline-flex items-center gap-2 rounded-full border border-[#252525] bg-black/30 px-3 py-1 text-[10px] tracking-[0.16em] uppercase text-[#b0b0b0] font-semibold">
                  <GlowDot />
                  Matchup
                </div>

                <div className="mt-3 text-white font-black text-[18px] leading-tight truncate tracking-tight">
                  {awayName} vs {homeName}
                </div>

                <div className="mt-1 text-[11px] text-[#9a9a9a] font-semibold">
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
                className="shrink-0 rounded-xl border border-[#252525] bg-[#0b0b0b] px-3 py-2 text-[11px] font-black tracking-wide text-white hover:bg-[#121212]"
              >
                Done
              </button>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMode("off")}
                className={cx(
                  "rounded-xl border px-3 py-2 text-[10px] font-black tracking-[0.14em] uppercase transition",
                  mode === "off"
                    ? "border-[#d4af37] bg-[#1a1406] text-[#f5e7b7]"
                    : "border-[#252525] bg-[#0b0b0b] text-[#cfcfcf] hover:bg-[#121212]"
                )}
              >
                Offense
              </button>

              <button
                type="button"
                onClick={() => setMode("def")}
                className={cx(
                  "rounded-xl border px-3 py-2 text-[10px] font-black tracking-[0.14em] uppercase transition",
                  mode === "def"
                    ? "border-[#d4af37] bg-[#1a1406] text-[#f5e7b7]"
                    : "border-[#252525] bg-[#0b0b0b] text-[#cfcfcf] hover:bg-[#121212]"
                )}
              >
                Defense
              </button>

              <div className="ml-auto text-[10px] tracking-[0.14em] uppercase text-[#808080] font-semibold">
                {st.loading ? "Loading…" : st.error ? "Unavailable" : ""}
              </div>
            </div>
          </div>

          {/* Body */}
          <div className="bg-[#070707] max-h-[calc(100vh-240px)] overflow-y-auto px-5 py-5 space-y-3">
            {st.error ? (
              <div className="rounded-xl border border-red-900/50 bg-black/30 px-4 py-3 text-[11px] text-red-400 font-semibold">
                {st.error}
              </div>
            ) : null}

            {/* Ratings */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div className="rounded-xl border border-[#1f1f1f] bg-black/20 overflow-hidden">
                <div className="px-4 py-3 border-b border-[#141414] flex items-center gap-3">
                  <LogoBox team={awayName} url={awayLogo} size={36} />
                  <div className="min-w-0">
                    <div className="text-white font-black text-[13px] truncate tracking-tight">
                      {awayName}
                      <RankBadge rank={awayRank} />
                    </div>
                    <div className="text-[10px] tracking-[0.16em] uppercase text-[#8a8a8a] font-semibold">
                      Away · {awayAbbr}
                    </div>
                  </div>
                </div>
                <div className="px-4 py-2">
                  {TEAM_RATINGS_FIELDS.map((f) => {
                    const v = (st.awayRatings as any)?.[f.key];
                    const txt = f.fmt ? f.fmt(v) : String(v ?? "—");
                    return (
                      <div key={f.key} className="grid grid-cols-2 gap-3 py-2 border-b border-[#141414] last:border-b-0">
                        <div className="text-[10px] tracking-[0.14em] uppercase text-[#8a8a8a] font-semibold">{f.label}</div>
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
                    <div className="text-white font-black text-[13px] truncate tracking-tight">
                      {homeName}
                      <RankBadge rank={homeRank} />
                    </div>
                    <div className="text-[10px] tracking-[0.16em] uppercase text-[#8a8a8a] font-semibold">
                      Home · {homeAbbr}
                    </div>
                  </div>
                </div>
                <div className="px-4 py-2">
                  {TEAM_RATINGS_FIELDS.map((f) => {
                    const v = (st.homeRatings as any)?.[f.key];
                    const txt = f.fmt ? f.fmt(v) : String(v ?? "—");
                    return (
                      <div key={f.key} className="grid grid-cols-2 gap-3 py-2 border-b border-[#141414] last:border-b-0">
                        <div className="text-[10px] tracking-[0.14em] uppercase text-[#8a8a8a] font-semibold">{f.label}</div>
                        <div className="text-right tabular-nums text-white font-extrabold">{txt}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Stat compare */}
            <div className="rounded-xl border border-[#1f1f1f] bg-black/20 overflow-hidden">
              <div className="px-4 py-3 border-b border-[#141414] text-[10px] tracking-[0.16em] uppercase text-[#8a8a8a] font-semibold">
                {String(sportKey).toLowerCase() === "basketball_ncaab"
                  ? `${mode === "off" ? "Offense" : "Defense"}`
                  : "Stats"}
              </div>

              <div className="px-4 py-2">
                {String(sportKey).toLowerCase() !== "basketball_ncaab" ? (
                  <div className="py-6 text-[11px] text-[#b0b0b0] font-semibold">
                    Stat comparison is available for NCAAB.
                  </div>
                ) : st.loading ? (
                  <div className="py-6 text-[11px] text-[#b0b0b0] font-semibold">Loading…</div>
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
                          <div className="text-[11px] text-white font-black truncate tracking-tight">{d.label}</div>
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

              <div className="px-4 py-3 border-t border-[#141414] text-[10px] text-[#7a7a7a] font-semibold">
                Percent stats shown as 0.456 → 45.6%
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-5 py-4 border-t border-[#141414] bg-[#0b0b0b] flex items-center justify-between">
            <div className="text-[10px] tracking-[0.14em] uppercase text-[#7a7a7a] font-semibold">
              Tap outside to close
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-[#252525] bg-[#0b0b0b] px-4 py-2 text-[11px] font-black tracking-wide text-white hover:bg-[#121212]"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

/* =========================================================
   Desktop layout
========================================================= */

function DesktopColumnsHeader() {
  const cols = ["Score", "Win", "Margin", "Total", "Spread", "Total"];
  return (
    <div className="sticky top-0 z-30 border-b border-[#252525] bg-[#070707]">
      <div className="grid grid-cols-[minmax(420px,1fr)_repeat(6,minmax(150px,180px))]">
        <div className="p-3 text-[#808080] text-[10px] font-semibold tracking-[0.18em] uppercase">Matchup</div>
        {cols.map((c, i) => (
          <div key={`${c}-${i}`} className="p-3 text-[#808080] text-[10px] font-semibold tracking-[0.18em] uppercase text-center">
            {c}
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricStack({
  title,
  top,
  bottom,
  hintTop,
  hintBottom,
  metaTop,
  metaBottom,
  bars,
}: {
  title: string;
  top: string;
  bottom?: string;
  hintTop?: string;
  hintBottom?: string;
  metaTop?: string;
  metaBottom?: string;

  // If provided: shows bar-only % data (with labels + % inside bar block)
  bars?: {
    top: number | null;
    bottom: number | null;
    topLabel: string;
    bottomLabel: string;
    topTone: BarTone;
    bottomTone: BarTone;
  };
}) {
  return (
    <div className="px-3 py-4 text-center flex flex-col items-center justify-center">
      <div className="text-[15px] font-black tabular-nums leading-none tracking-tight text-white">{top}</div>
      {hintTop ? <div className="mt-1 text-[10px] text-[#9a9a9a] font-semibold tabular-nums">{hintTop}</div> : null}
      {metaTop ? <div className="mt-1 text-[10px] text-[#7a7a7a] font-semibold tabular-nums">{metaTop}</div> : null}

      {bottom ? (
        <>
          <div className="mt-3 h-px w-10 bg-[#202020]" />
          <div className="mt-3 text-[15px] font-black tabular-nums leading-none tracking-tight text-white">{bottom}</div>
          {hintBottom ? <div className="mt-1 text-[10px] text-[#9a9a9a] font-semibold tabular-nums">{hintBottom}</div> : null}
          {metaBottom ? <div className="mt-1 text-[10px] text-[#7a7a7a] font-semibold tabular-nums">{metaBottom}</div> : null}
        </>
      ) : null}

      <div className="mt-2 text-[10px] tracking-[0.18em] uppercase text-[#7a7a7a] font-semibold">{title}</div>

      {bars ? (
        <div className="mt-2 w-full px-1">
          <ProbBarDual
            top={bars.top}
            bottom={bars.bottom}
            topLabel={bars.topLabel}
            bottomLabel={bars.bottomLabel}
            topTone={bars.topTone}
            bottomTone={bars.bottomTone}
          />
        </div>
      ) : null}
    </div>
  );
}

function TeamLine({ row, right }: { row: TeamRow; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <LogoBox team={row.teamName} url={row.logoUrl} size={36} />
      <div className="min-w-0">
        <div className="text-white font-black text-[12px] truncate tracking-tight" title={row.teamName}>
          {row.teamName}
          <RankBadge rank={row.powerRank} />
        </div>
        <div className="text-[10px] tracking-[0.16em] uppercase text-[#7a7a7a] font-semibold">
          {row.side} · {row.teamAbbr}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-3 shrink-0">{right}</div>
    </div>
  );
}

function DesktopMatchupCard({ ev, onOpenModel }: { ev: EventBundle; onOpenModel: () => void }) {
  const winnerToneAway: BarTone = ev.away.isProjectedWinner ? "green" : "red";
  const winnerToneHome: BarTone = ev.home.isProjectedWinner ? "green" : "red";

  const overTone: BarTone = (ev.away.overProb ?? 0) >= (ev.home.underProb ?? 0) ? "green" : "red";
  const underTone: BarTone = (ev.home.underProb ?? 0) >= (ev.away.overProb ?? 0) ? "green" : "red";

  // Consensus stacks (text is fine here)
  const consSpreadAwayTop =
    ev.away.consSpreadLineTeam == null ? "—" : formatSignedNumber(ev.away.consSpreadLineTeam);
  const consSpreadAwayBottom = ev.away.consSpreadLineTeam == null ? undefined : fmtAmerican(ev.away.consSpreadOddsTeam);

  const consSpreadHomeTop =
    ev.home.consSpreadLineTeam == null ? "—" : formatSignedNumber(ev.home.consSpreadLineTeam);
  const consSpreadHomeBottom = ev.home.consSpreadLineTeam == null ? undefined : fmtAmerican(ev.home.consSpreadOddsTeam);

  const consTotalOverTop = ev.away.consTotalLine == null ? "—" : formatOuLine(ev.away.consTotalLine, "o");
  const consTotalOverBottom = ev.away.consTotalLine == null ? undefined : fmtAmerican(ev.away.consTotalOverOdds);

  const consTotalUnderTop = ev.home.consTotalLine == null ? "—" : formatOuLine(ev.home.consTotalLine, "u");
  const consTotalUnderBottom = ev.home.consTotalLine == null ? undefined : fmtAmerican(ev.home.consTotalUnderOdds);

  return (
    <div
      className="rounded-2xl border border-[#252525] bg-[#0b0b0b] overflow-hidden transition hover:border-[#3a3a3a]"
      style={{ boxShadow: "0 18px 60px rgba(0,0,0,0.35)" }}
    >
      {/* Card header */}
      <div
        className="px-4 py-3 border-b border-[#141414]"
        style={{
          background:
            "radial-gradient(800px 220px at 20% 0%, rgba(212,175,55,0.16), transparent 62%), rgba(0,0,0,0.20)",
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <RecencyDot ts={ev.consensusTs} />
              <div className="text-white font-black truncate tracking-tight">
                {ev.away.teamAbbr} @ {ev.home.teamAbbr}
                <span className="text-[#404040]"> · </span>
                <span className="text-[#b0b0b0] font-semibold">
                  {fmtDateCentral(ev.commenceTime)} · {fmtTimeCentral(ev.commenceTime)}
                </span>
              </div>
            </div>

            {ev.consensusTs ? (
              <div className="mt-1 text-[10px] text-[#7a7a7a] font-semibold">
                Updated <span className="text-[#b0b0b0]">{formatTs(ev.consensusTs)}</span>
              </div>
            ) : null}
          </div>

          <div className="shrink-0">
            <SoftButton onClick={onOpenModel} title="Open matchup view">
              Model
            </SoftButton>
          </div>
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-[minmax(420px,1fr)_repeat(6,minmax(150px,180px))]">
        {/* Left panel */}
        <div className="p-4 border-r border-[#141414] space-y-3">
          <TeamLine
            row={ev.away}
            right={
              <div className="text-right">
                <div className={cx("text-[14px] font-black tabular-nums tracking-tight", ev.away.isProjectedWinner ? "text-green-400" : "text-white")}>
                  {ev.away.projPoints.toFixed(1)}
                </div>
                <div className="text-[10px] text-[#8a8a8a] font-semibold tracking-wide">Projected</div>
              </div>
            }
          />
          <TeamLine
            row={ev.home}
            right={
              <div className="text-right">
                <div className={cx("text-[14px] font-black tabular-nums tracking-tight", ev.home.isProjectedWinner ? "text-green-400" : "text-white")}>
                  {ev.home.projPoints.toFixed(1)}
                </div>
                <div className="text-[10px] text-[#8a8a8a] font-semibold tracking-wide">Projected</div>
              </div>
            }
          />
        </div>

        {/* Score (numbers still useful) */}
        <MetricStack title="Score" top={ev.away.projPoints.toFixed(1)} bottom={ev.home.projPoints.toFixed(1)} hintTop={ev.away.teamAbbr} hintBottom={ev.home.teamAbbr} />

        {/* Win (BAR-ONLY; no win% text above) */}
        <MetricStack
          title="Win"
          top="—"
          bottom="—"
          hintTop={ev.away.teamAbbr}
          hintBottom={ev.home.teamAbbr}
          metaTop={formatBaseAdjLabel(ev.away.baseWinProbTeam, ev.away.adjWinProbTeam)}
          metaBottom={formatBaseAdjLabel(ev.home.baseWinProbTeam, ev.home.adjWinProbTeam)}
          bars={{
            top: ev.away.winProbTeam,
            bottom: ev.home.winProbTeam,
            topLabel: ev.away.teamAbbr,
            bottomLabel: ev.home.teamAbbr,
            topTone: winnerToneAway,
            bottomTone: winnerToneHome,
          }}
        />

        {/* Margin (margin numbers still useful; cover% is BAR-ONLY) */}
        <MetricStack
          title="Margin"
          top={formatSignedNumber(ev.away.projMarginTeam)}
          bottom={formatSignedNumber(ev.home.projMarginTeam)}
          hintTop={ev.away.teamAbbr}
          hintBottom={ev.home.teamAbbr}
          metaTop={formatBaseAdjLabel(ev.away.baseCoverProbTeam, ev.away.adjCoverProbTeam)}
          metaBottom={formatBaseAdjLabel(ev.home.baseCoverProbTeam, ev.home.adjCoverProbTeam)}
          bars={{
            top: ev.away.coverProbTeam,
            bottom: ev.home.coverProbTeam,
            topLabel: `${ev.away.teamAbbr} cover`,
            bottomLabel: `${ev.home.teamAbbr} cover`,
            topTone: winnerToneAway,
            bottomTone: winnerToneHome,
          }}
        />

        {/* Total (projected total stays; over/under is BAR-ONLY) */}
        <MetricStack
          title="Total"
          top={formatLinePlain(ev.home.projTotal)}
          bottom={formatLinePlain(ev.away.projTotal)}
          hintTop="Over"
          hintBottom="Under"
          metaTop={formatBaseAdjLabel(ev.away.baseOverProb, ev.away.adjOverProb)}
          metaBottom={formatBaseAdjLabel(ev.home.baseUnderProb, ev.home.adjUnderProb)}
          bars={{
            top: ev.away.overProb,
            bottom: ev.home.underProb,
            topLabel: "Over",
            bottomLabel: "Under",
            topTone: overTone,
            bottomTone: underTone,
          }}
        />

        {/* Consensus spread */}
        <MetricStack title="Spread" top={consSpreadAwayTop} bottom={consSpreadHomeTop} hintTop={consSpreadAwayBottom} hintBottom={consSpreadHomeBottom} />

        {/* Consensus total */}
        <MetricStack title="Total" top={consTotalOverTop} bottom={consTotalUnderTop} hintTop={consTotalOverBottom} hintBottom={consTotalUnderBottom} />
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
  const [errorText, setErrorText] = useState<string | null>(null);

  const [logoMap, setLogoMap] = useState<Map<string, string>>(new Map());
  const [abbrMap, setAbbrMap] = useState<Map<string, string>>(new Map());
  const [powerRankMap, setPowerRankMap] = useState<Map<string, number>>(new Map());

  const [consensusMap, setConsensusMap] = useState<Map<string, Consensus>>(new Map());
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});

  const [loadingRun, setLoadingRun] = useState(true);
  const [loadingResults, setLoadingResults] = useState(false);
  const [loadingConsensus, setLoadingConsensus] = useState(false);
  const [loadingAi, setLoadingAi] = useState(false);
  const [mlMap, setMlMap] = useState<Map<string, MlAdjustmentRow>>(new Map());
  const [useAiAdjusted, setUseAiAdjusted] = useState(false);

  // Modal
  const [modelOpen, setModelOpen] = useState(false);
  const [modelEvent, setModelEvent] = useState<EventBundle | null>(null);

  /* team map */
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
      setErrorText(null);
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
        setErrorText(error.message);
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
      setErrorText(null);

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
        setErrorText(error.message);
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

        // latest-per-book per event/market/side
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

  useEffect(() => {
    let mounted = true;

    async function loadAiAdjustments(eventIds: string[]) {
      if (!run?.id || !eventIds.length) {
        setMlMap(new Map());
        setLoadingAi(false);
        return;
      }

      setLoadingAi(true);

      const { data, error } = await supabase
        .from("model_ml_adjustments")
        .select(
          [
            "event_id",
            "run_id",
            "base_home_win_prob",
            "base_away_win_prob",
            "adj_home_win_prob",
            "adj_away_win_prob",
            "base_home_cover_prob",
            "base_away_cover_prob",
            "adj_home_cover_prob",
            "adj_away_cover_prob",
            "base_over_prob",
            "base_under_prob",
            "adj_over_prob",
            "adj_under_prob",
          ].join(",")
        )
        .eq("run_id", run.id)
        .in("event_id", eventIds);

      if (!mounted) return;

      if (error) {
        console.warn("[MonteCarloScreen] model_ml_adjustments error:", error.message);
        setMlMap(new Map());
        setLoadingAi(false);
        return;
      }

      const next = new Map<string, MlAdjustmentRow>();
      for (const row of (data ?? []) as MlAdjustmentRow[]) {
        if (!row.event_id) continue;
        next.set(row.event_id, row);
      }

      setMlMap(next);
      setLoadingAi(false);
    }

    const ids = Array.from(new Set(results.map((r) => r.event_id).filter(Boolean)));
    loadAiAdjustments(ids);

    return () => {
      mounted = false;
    };
  }, [results, run?.id]);

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

      const marginHome = safeNumber(r.projected_margin_home, 0);
      const totalProj = safeNumber(r.projected_total, 0);

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

      const mlAdj = mlMap.get(r.event_id) ?? null;
      const adjHomeCover = mlAdj?.adj_home_cover_prob ?? null;
      const adjAwayCover = mlAdj?.adj_away_cover_prob ?? null;
      const adjOver = mlAdj?.adj_over_prob ?? null;
      const adjUnder = mlAdj?.adj_under_prob ?? null;
      const adjHomeWin = mlAdj?.adj_home_win_prob ?? null;
      const adjAwayWin = mlAdj?.adj_away_win_prob ?? null;

      const finalHomeCover = useAiAdjusted ? adjHomeCover ?? pHomeCover : pHomeCover;
      const finalAwayCover = useAiAdjusted ? adjAwayCover ?? pAwayCover : pAwayCover;
      const finalOver = useAiAdjusted ? adjOver ?? pOver : pOver;
      const finalUnder = useAiAdjusted ? adjUnder ?? pUnder : pUnder;
      const finalHomeWinInput = useAiAdjusted ? adjHomeWin ?? pHomeWin : pHomeWin;
      const finalAwayWinInput = useAiAdjusted ? adjAwayWin ?? pAwayWin : pAwayWin;

      const finalHomeWin = finalHomeWinInput ?? (finalAwayWinInput != null ? 1 - finalAwayWinInput : null);
      const finalAwayWin = finalAwayWinInput ?? (finalHomeWin != null ? 1 - finalHomeWin : null);

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
        coverProbTeam: finalAwayCover,
        baseCoverProbTeam: pAwayCover,
        adjCoverProbTeam: adjAwayCover,
        projTotal: Math.round(totalProj * 10) / 10,
        overProb: finalOver,
        underProb: finalUnder,
        baseOverProb: pOver,
        adjOverProb: adjOver,
        baseUnderProb: pUnder,
        adjUnderProb: adjUnder,
        winProbTeam: finalAwayWin,
        baseWinProbTeam: pAwayWin,
        adjWinProbTeam: adjAwayWin,
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
        coverProbTeam: finalHomeCover,
        baseCoverProbTeam: pHomeCover,
        adjCoverProbTeam: adjHomeCover,
        projTotal: Math.round(totalProj * 10) / 10,
        overProb: finalOver,
        underProb: finalUnder,
        baseOverProb: pOver,
        adjOverProb: adjOver,
        baseUnderProb: pUnder,
        adjUnderProb: adjUnder,
        winProbTeam: finalHomeWin,
        baseWinProbTeam: pHomeWin,
        adjWinProbTeam: adjHomeWin,
        consSpreadLineTeam: consSpreadHome == null ? null : Math.round(consSpreadHome * 10) / 10,
        consSpreadOddsTeam: c?.spread_home_odds ?? null,
        consTotalLine: consTotal == null ? null : Math.round(consTotal * 10) / 10,
        consTotalOverOdds: c?.total_over_odds ?? null,
        consTotalTotal: undefined as any, // (ignored; keeps TS happy if you had old fields elsewhere)
        consTotalUnderOdds: c?.total_under_odds ?? null,
        isProjectedWinner: homeIsWinner,
      } as TeamRow;

      out.push({
        eventId: r.event_id,
        commenceTime: r.commence_time ?? null,
        away: awayRow,
        home: homeRow,
        consensusTs: c?.ts ?? null,
      });
    }

    return out;
  }, [results, abbrMap, logoMap, consensusMap, powerRankMap, mlMap, useAiAdjusted]);

  useEffect(() => {
    setOpenMap((prev) => {
      const next: Record<string, boolean> = {};
      for (const ev of events) next[ev.eventId] = prev[ev.eventId] ?? false;
      return next;
    });
  }, [events]);

  const loading = loadingRun || loadingResults;

  const openModel = (ev: EventBundle) => {
    setModelEvent(ev);
    setModelOpen(true);
  };

  const sportLabel = sportKey.replace(/_/g, " ").toUpperCase();
  const lastUpdateLabel = run?.created_at ? `${fmtDateCentral(run.created_at)} ${fmtTimeCentral(run.created_at)}` : "—";

  return (
    <ScreenShell
      title="Monte Carlo Projections"
      subtitle="Live win probabilities, projected scores, and confidence bands derived from simulation runs."
      status={[
        {
          label: "Simulations",
          value: run?.simulations ? run.simulations.toLocaleString() : "—",
          helper: run?.created_at ? fmtDateCentral(run.created_at) : "Awaiting run",
        },
        {
          label: "Events",
          value: String(events.length),
          helper: loading ? "Loading board" : "Live slate",
        },
        {
          label: "Sport",
          value: sportLabel,
          helper: "Active feed",
        },
        {
          label: "Updated",
          value: lastUpdateLabel,
          helper: "CT timezone",
        },
      ]}
    >
      <SectionCard>
        <SectionHeader title="Simulation Console" description="Filter projections, check confidence deltas, and export matchups." />
        <div className="mt-4 space-y-4">
      <ModelModalPortal
        open={modelOpen}
        onClose={() => setModelOpen(false)}
        sportKey={sportKey}
        event={modelEvent}
        logoMap={logoMap}
        abbrMap={abbrMap}
      />
      {errorText ? (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-200">
          {errorText}
        </div>
      ) : null}


      {/* DESKTOP */}
      <div className="hidden md:block bg-[#0b0b0b] border border-[#252525] rounded-2xl overflow-hidden">
        <div className="max-h-[72vh] overflow-y-auto">
          <DesktopColumnsHeader />

          <div className="p-4 space-y-3">
            {!loading && !events.length ? (
              <div className="p-10 text-center text-xs text-[#808080] font-semibold">No matchups found.</div>
            ) : null}

            {loading && !events.length ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="rounded-2xl border border-[#252525] bg-[#0b0b0b] p-4">
                    <SkeletonLine w="w-64" />
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <SkeletonLine />
                      <SkeletonLine />
                    </div>
                  </div>
                ))}
              </div>
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
          <div className="text-xs text-[#808080] px-3 py-10 bg-[#0b0b0b] border border-[#252525] rounded-2xl text-center font-semibold">
            No matchups found.
          </div>
        ) : null}

        {events.map((ev) => {
          const open = !!openMap[ev.eventId];

          const winnerToneAway: BarTone = ev.away.isProjectedWinner ? "green" : "red";
          const winnerToneHome: BarTone = ev.home.isProjectedWinner ? "green" : "red";

          return (
            <div
              key={ev.eventId}
              className="border border-[#252525] rounded-2xl p-4 overflow-hidden"
              style={{
                background:
                  "radial-gradient(700px 220px at 18% 0%, rgba(212,175,55,0.14), transparent 62%), rgba(11,11,11,0.92)",
                boxShadow: "0 18px 60px rgba(0,0,0,0.35)",
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-white text-[13px] truncate font-black tracking-tight">
                      {ev.away.teamAbbr} @ {ev.home.teamAbbr}
                    </div>
                    <RecencyDot ts={ev.consensusTs} />
                  </div>

                  <div className="text-[10px] tracking-[0.16em] uppercase text-[#808080] mt-1 font-semibold">
                    {fmtDateCentral(ev.commenceTime)} · {fmtTimeCentral(ev.commenceTime)}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <SoftButton onClick={() => openModel(ev)} title="Open matchup view">
                    Model
                  </SoftButton>

                  <button
                    type="button"
                    onClick={() => setOpenMap((p) => ({ ...p, [ev.eventId]: !p[ev.eventId] }))}
                    className="px-3 py-2 rounded-xl bg-black/35 border border-[#252525] text-[10px] tracking-[0.16em] uppercase text-[#d0d0d0] font-semibold hover:bg-[#141414]"
                  >
                    {open ? "Hide" : "Details"}
                  </button>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-3 min-w-0">
                <LogoBox team={ev.away.teamName} url={ev.away.logoUrl} size={34} />
                <div className="min-w-0 leading-tight">
                  <div className="text-[11px] text-white font-black truncate tracking-tight" title={ev.away.teamName}>
                    {ev.away.teamName}
                    <RankBadge rank={ev.away.powerRank} />
                  </div>
                  <div className="text-[10px] tracking-[0.16em] uppercase text-[#7a7a7a] font-semibold">
                    Away · {ev.away.teamAbbr}
                  </div>
                </div>

                <div className="ml-auto text-right tabular-nums shrink-0">
                  <div className={cx("font-black text-[13px] tracking-tight", ev.away.isProjectedWinner ? "text-green-400" : "text-white")}>
                    {ev.away.projPoints.toFixed(1)}
                  </div>
                  <div className="mt-1">
                    <ProbBar p={ev.away.winProbTeam} tone={winnerToneAway} />
                  </div>
                  <div className="mt-1 text-[9px] text-[#7a7a7a] font-semibold">
                    {formatBaseAdjLabel(ev.away.baseWinProbTeam, ev.away.adjWinProbTeam)}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-3 min-w-0">
                <LogoBox team={ev.home.teamName} url={ev.home.logoUrl} size={34} />
                <div className="min-w-0 leading-tight">
                  <div className="text-[11px] text-white font-black truncate tracking-tight" title={ev.home.teamName}>
                    {ev.home.teamName}
                    <RankBadge rank={ev.home.powerRank} />
                  </div>
                  <div className="text-[10px] tracking-[0.16em] uppercase text-[#7a7a7a] font-semibold">
                    Home · {ev.home.teamAbbr}
                  </div>
                </div>

                <div className="ml-auto text-right tabular-nums shrink-0">
                  <div className={cx("font-black text-[13px] tracking-tight", ev.home.isProjectedWinner ? "text-green-400" : "text-white")}>
                    {ev.home.projPoints.toFixed(1)}
                  </div>
                  <div className="mt-1">
                    <ProbBar p={ev.home.winProbTeam} tone={winnerToneHome} />
                  </div>
                  <div className="mt-1 text-[9px] text-[#7a7a7a] font-semibold">
                    {formatBaseAdjLabel(ev.home.baseWinProbTeam, ev.home.adjWinProbTeam)}
                  </div>
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
      </SectionCard>
    </ScreenShell>
  );
};


export default MonteCarloScreen;
