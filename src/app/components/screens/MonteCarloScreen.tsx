"use client";

// src/app/components/screens/MonteCarloScreen.tsx — FULL REWRITE
// -----------------------------------------------------------------------------------------------------
// ✅ Visual layout matches ModelScreen (hero gradient + badge + chips + dark sticky table)
// ✅ Desktop: 2 rows per event (away/home) + subtle divider between games
// ✅ Mobile: matchup cards + Details collapsible
// ✅ ONE modal button per event (placed by matchup/team names)
// ✅ Modal: SINGLE combined "Model View" (NO tabs)
//      - Section A: Team Ratings (public.team_ratings; canonical lookup; shows engine_power + key fields)
//      - Section B: NCAAB Stats (public.ncaab_stats; row-based via stat_key; values via away_score/home_score)
//      - NCAAB Stats has Offense / Defense toggle buttons
// ✅ IMPORTANT: NCAAB "offensive-efficiency" + "defensive-efficiency" REMOVED (duplicates of Adj Off / Adj Def)
// ✅ Canonical names used for ALL stat lookups (no abbreviations in queries)
// ✅ Defensive: renders “—” when a stat is missing; never crashes

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import type { SportKey } from "../../App";

/* =========================================================
   Types
========================================================= */

type MonteCarloRun = {
  id: string;
  created_at: string;
  sport_key: string;
};

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
  Abbreviation2?: string | null;
  "Logo URL": string | null;
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

  // spreads: store HOME line; away is opposite sign
  spread_home_line: number | null;
  spread_home_odds: number | null;
  spread_away_odds: number | null;

  // totals
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

  projPoints: number;
  projMarginTeam: number; // away = -marginHome
  coverProbTeam: number | null;

  projTotal: number;
  overProb: number | null;
  underProb: number | null;

  winProbTeam: number | null;

  consSpreadLineTeam: number | null; // away = -spread_home_line
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
};

type NcaabStatRow = {
  canonical: string;
  stat_key: string;
  home_score: number | null;
  away_score: number | null;
};

type TeamRatingsAny = Record<string, any> & { canonical?: string | null; sport_key?: string | null };

/* =========================================================
   Helpers
========================================================= */

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

function medianOrNull(nums: number[]): number | null {
  const arr = nums.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
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

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/* =========================================================
   UI atoms
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
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-2 rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-2 text-[11px] font-extrabold text-white hover:bg-[#121212] active:scale-[0.99] transition"
    >
      {children}
    </button>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[#2a2a2a] bg-black/20 px-2.5 py-1 text-[10px] font-extrabold text-[#cfcfcf]">
      {children}
    </span>
  );
}

/* =========================================================
   Mobile details block
========================================================= */

function MobileDetailsBlock({ away, home }: { away: TeamRow; home: TeamRow }) {
  const headerRow = (
    <div className="grid grid-cols-3 gap-2 items-center py-2 border-b border-[#141414]">
      <div className="text-[9px] text-[#8a8a8a] font-extrabold uppercase tracking-wide"> </div>
      <div className="text-[9px] text-[#8a8a8a] font-extrabold uppercase tracking-wide text-right">
        {away.teamAbbr}
      </div>
      <div className="text-[9px] text-[#8a8a8a] font-extrabold uppercase tracking-wide text-right">
        {home.teamAbbr}
      </div>
    </div>
  );

  const row = (label: string, a: React.ReactNode, h: React.ReactNode) => (
    <div className="grid grid-cols-3 gap-2 items-center py-2 border-b border-[#141414] last:border-b-0">
      <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">{label}</div>
      <div className="text-[11px] text-white font-bold tabular-nums text-right">{a}</div>
      <div className="text-[11px] text-white font-bold tabular-nums text-right">{h}</div>
    </div>
  );

  const consSpreadAway =
    away.consSpreadLineTeam == null
      ? "—"
      : `${fmtSigned1(away.consSpreadLineTeam)} (${american(away.consSpreadOddsTeam)})`;

  const consSpreadHome =
    home.consSpreadLineTeam == null
      ? "—"
      : `${fmtSigned1(home.consSpreadLineTeam)} (${american(home.consSpreadOddsTeam)})`;

  const consTotalOver =
    away.consTotalLine == null ? "—" : `${fmtOU(away.consTotalLine, "o")} (${american(away.consTotalOverOdds)})`;

  const consTotalUnder =
    home.consTotalLine == null ? "—" : `${fmtOU(home.consTotalLine, "u")} (${american(home.consTotalUnderOdds)})`;

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-black/10 overflow-hidden">
      <div className="px-4 py-2 border-b border-[#141414] text-[11px] text-white font-extrabold">Details</div>
      <div className="px-4">
        {headerRow}
        {row(
          "Proj Margin",
          <>
            {fmtSigned1(away.projMarginTeam)}{" "}
            <span className="text-[#808080] font-semibold text-[10px]">({pct01(away.coverProbTeam)})</span>
          </>,
          <>
            {fmtSigned1(home.projMarginTeam)}{" "}
            <span className="text-[#808080] font-semibold text-[10px]">({pct01(home.coverProbTeam)})</span>
          </>
        )}
        {row(
          "Proj Total",
          <>
            {fmtOU(away.projTotal, "o")}{" "}
            <span className="text-[#808080] font-semibold text-[10px]">({pct01(away.overProb)})</span>
          </>,
          <>
            {fmtOU(home.projTotal, "u")}{" "}
            <span className="text-[#808080] font-semibold text-[10px]">({pct01(home.underProb)})</span>
          </>
        )}
        {row("Cons Spread", consSpreadAway, consSpreadHome)}
        {row("Cons Total", consTotalOver, consTotalUnder)}
      </div>
    </div>
  );
}

/* =========================================================
   Combined Model Modal (single view + Off/Def toggle)
========================================================= */

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

  awayRatings: TeamRatingsAny | null;
  homeRatings: TeamRatingsAny | null;

  awayStats: Map<string, number>;
  homeStats: Map<string, number>;

  fetchedAt: string | null;
};

type StatDef = { key: string; label: string; hint?: string; fmt?: (v: number) => string; higherIsBetter?: boolean };

const TEAM_RATINGS_FIELDS: Array<{ key: string; label: string; fmt?: (v: any) => string }> = [
  { key: "power_rank", label: "Power Rank", fmt: (v) => fmtMaybeInt(v) },
  { key: "engine_power", label: "Engine Power", fmt: (v) => fmtMaybeNumber(v, 2) },

  // ✅ We keep ONLY these for efficiency (your note)
  { key: "engine_adj_off", label: "Adj Off", fmt: (v) => fmtMaybeNumber(v, 2) },
  { key: "engine_adj_def", label: "Adj Def", fmt: (v) => fmtMaybeNumber(v, 2) },
];

// ✅ NCAAB stat_key list you provided (minus offensive-efficiency/defensive-efficiency)
const NCAAB_STATS_OFF: StatDef[] = [
  { key: "possessions-per-game", label: "Pace", hint: "Possessions / 40", fmt: (v) => v.toFixed(1) },
  { key: "points-per-game", label: "Points / Game", fmt: (v) => v.toFixed(1) },

  { key: "effective-field-goal-pct", label: "eFG%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: true },
  { key: "three-point-rate", label: "3PA Rate", hint: "3PA/FGA", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: true },
  { key: "two-point-rate", label: "2PA Rate", hint: "2PA/FGA", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: true },

  { key: "three-point-pct", label: "3P%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: true },
  { key: "two-point-pct", label: "2P%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: true },

  { key: "fta-per-fga", label: "FT Rate", hint: "FTA/FGA", fmt: (v) => v.toFixed(3), higherIsBetter: true },
  { key: "free-throw-pct", label: "FT%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: true },

  { key: "turnover-pct", label: "TO%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: false },
  { key: "offensive-rebounding-pct", label: "ORB%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: true },
  { key: "defensive-rebounding-pct", label: "DRB%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: true },

  { key: "steals-perpossession", label: "Stl / Poss", fmt: (v) => v.toFixed(3), higherIsBetter: true },

  { key: "personal-fouls-per-possession", label: "Fouls / Poss", fmt: (v) => v.toFixed(3), higherIsBetter: false },

  { key: "effective-possession-ratio", label: "EPR", hint: "Effective Poss Ratio", fmt: (v) => v.toFixed(3), higherIsBetter: true },
];

const NCAAB_STATS_DEF: StatDef[] = [
  { key: "opponent-points-per-game", label: "Opp Points / Game", fmt: (v) => v.toFixed(1), higherIsBetter: false },
  { key: "opponent-effective-field-goal-pct", label: "Opp eFG%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: false },

  { key: "opponent-three-point-rate", label: "Opp 3PA Rate", hint: "3PA/FGA", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: false },
  { key: "opponent-two-point-rate", label: "Opp 2PA Rate", hint: "2PA/FGA", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: false },

  { key: "opponent-three-point-pct", label: "Opp 3P%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: false },
  { key: "opponent-two-point-pct", label: "Opp 2P%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: false },

  { key: "opponent-fta-per-fga", label: "Opp FT Rate", hint: "FTA/FGA", fmt: (v) => v.toFixed(3), higherIsBetter: false },
  { key: "opponent-free-throw-pct", label: "Opp FT%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: false },

  { key: "opponent-turnover-pct", label: "Opp TO%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: true },

  { key: "opponent-offensive-rebounding-pct", label: "Opp ORB%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: false },
  { key: "opponent-defensive-rebounding-pct", label: "Opp DRB%", fmt: (v) => `${(v * 100).toFixed(1)}%`, higherIsBetter: false },

  { key: "opponent-steals-perpossession", label: "Opp Stl / Poss", fmt: (v) => v.toFixed(3), higherIsBetter: false },

  { key: "opponent-personal-fouls-per-possession", label: "Opp Fouls / Poss", fmt: (v) => v.toFixed(3), higherIsBetter: true },

  { key: "opponent-effective-possession-ratio", label: "Opp EPR", hint: "Opponent EPR", fmt: (v) => v.toFixed(3), higherIsBetter: false },
];

function ModelModal({ open, onClose, sportKey, event, logoMap, abbrMap }: ModelModalProps) {
  const [mode, setMode] = useState<"off" | "def">("off");
  const [st, setSt] = useState<ModelModalState>({
    loading: false,
    error: null,
    awayRatings: null,
    homeRatings: null,
    awayStats: new Map(),
    homeStats: new Map(),
    fetchedAt: null,
  });

  const isNcaab = String(sportKey).toLowerCase() === "basketball_ncaab";

  // Close on ESC
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Fetch on open/event change
  useEffect(() => {
    let mounted = true;

    async function load() {
      if (!open || !event) return;

      const awayCanonical = event.away.teamName;
      const homeCanonical = event.home.teamName;

      setSt({
        loading: true,
        error: null,
        awayRatings: null,
        homeRatings: null,
        awayStats: new Map(),
        homeStats: new Map(),
        fetchedAt: null,
      });

      try {
        // TEAM RATINGS (canonical; optionally filter by sport_key client-side)
        const ratingsRes = await supabase
          .from("team_ratings")
          .select("*")
          .in("canonical", [awayCanonical, homeCanonical]);

        if (ratingsRes.error) throw new Error(`Failed to load team_ratings: ${ratingsRes.error.message}`);

        const rawRatings = (ratingsRes.data ?? []) as TeamRatingsAny[];
        const filteredRatings = rawRatings.filter((r) => {
          const rk = (r as any)?.sport_key;
          if (rk == null) return true;
          return String(rk) === String(sportKey);
        });

        const awayRatings =
          filteredRatings.find((r) => normKey(String(r.canonical ?? "")) === normKey(awayCanonical)) ?? null;
        const homeRatings =
          filteredRatings.find((r) => normKey(String(r.canonical ?? "")) === normKey(homeCanonical)) ?? null;

        // NCAAB STATS (row-based)
        let awayStats = new Map<string, number>();
        let homeStats = new Map<string, number>();

        if (isNcaab) {
          const statsRes = await supabase
            .from("ncaab_stats")
            .select("canonical,stat_key,home_score,away_score")
            .in("canonical", [awayCanonical, homeCanonical]);

          if (statsRes.error) throw new Error(`Failed to load ncaab_stats: ${statsRes.error.message}`);

          const rows = (statsRes.data ?? []) as NcaabStatRow[];

          for (const r of rows) {
            const canon = String(r.canonical ?? "");
            const key = String(r.stat_key ?? "").trim();
            if (!key) continue;

            // IMPORTANT: stats use away_score/home_score by team side
            if (normKey(canon) === normKey(awayCanonical)) {
              const v = Number(r.away_score);
              if (Number.isFinite(v)) awayStats.set(key, v);
            } else if (normKey(canon) === normKey(homeCanonical)) {
              const v = Number(r.home_score);
              if (Number.isFinite(v)) homeStats.set(key, v);
            }
          }
        }

        if (!mounted) return;
        setSt({
          loading: false,
          error: null,
          awayRatings,
          homeRatings,
          awayStats,
          homeStats,
          fetchedAt: new Date().toLocaleString(),
        });
      } catch (e: any) {
        if (!mounted) return;
        setSt((p) => ({ ...p, loading: false, error: String(e?.message ?? e) }));
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [open, event?.eventId, sportKey, isNcaab]);

  if (!open || !event) return null;

  const awayKey = normKey(event.away.teamName);
  const homeKey = normKey(event.home.teamName);
  const awayLogo = logoMap.get(awayKey) ?? null;
  const homeLogo = logoMap.get(homeKey) ?? null;
  const awayAbbr = abbrMap.get(awayKey) ?? event.away.teamAbbr;
  const homeAbbr = abbrMap.get(homeKey) ?? event.home.teamAbbr;

  const overlay = cx(
    "fixed inset-0 z-[80]",
    open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
  );

  const modal = cx(
    "fixed left-1/2 top-1/2 z-[90] w-[min(980px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2",
    "rounded-2xl border border-[#2a2a2a] bg-[#0b0b0b] shadow-2xl",
    "max-h-[calc(100vh-24px)] overflow-hidden",
    open ? "opacity-100 scale-100" : "opacity-0 scale-[0.98] pointer-events-none"
  );

  const HeaderTeam = ({
    side,
    name,
    abbr,
    logo,
  }: {
    side: "AWAY" | "HOME";
    name: string;
    abbr: string;
    logo: string | null;
  }) => (
    <div className="flex items-center gap-3 min-w-0">
      <LogoBox team={name} url={logo} size={38} />
      <div className="min-w-0">
        <div className="text-white font-extrabold text-[13px] truncate">{name}</div>
        <div className="text-[10px] text-[#8a8a8a] font-bold uppercase tracking-wide">
          {side} · {abbr}
        </div>
      </div>
    </div>
  );

  const statsDefs = mode === "off" ? NCAAB_STATS_OFF : NCAAB_STATS_DEF;

  const compare = (a: number | undefined, h: number | undefined, higherIsBetter: boolean) => {
    if (!Number.isFinite(a as any) || !Number.isFinite(h as any)) return { aGood: false, hGood: false };
    if (a === h) return { aGood: false, hGood: false };
    if (higherIsBetter) return { aGood: (a as number) > (h as number), hGood: (h as number) > (a as number) };
    return { aGood: (a as number) < (h as number), hGood: (h as number) < (a as number) };
  };

  const RatingsPanel = () => {
    const a = st.awayRatings ?? {};
    const h = st.homeRatings ?? {};

    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Away */}
        <div className="rounded-xl border border-[#1f1f1f] bg-black/20 overflow-hidden">
          <div className="px-4 py-3 border-b border-[#141414]">
            <HeaderTeam side="AWAY" name={event.away.teamName} abbr={awayAbbr} logo={awayLogo} />
          </div>

          <div className="px-4 py-2">
            {TEAM_RATINGS_FIELDS.map((f) => {
              const v = (a as any)?.[f.key];
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

        {/* Home */}
        <div className="rounded-xl border border-[#1f1f1f] bg-black/20 overflow-hidden">
          <div className="px-4 py-3 border-b border-[#141414]">
            <HeaderTeam side="HOME" name={event.home.teamName} abbr={homeAbbr} logo={homeLogo} />
          </div>

          <div className="px-4 py-2">
            {TEAM_RATINGS_FIELDS.map((f) => {
              const v = (h as any)?.[f.key];
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
    );
  };

  const NcaabStatsPanel = () => {
    const aMap = st.awayStats;
    const hMap = st.homeStats;

    return (
      <div className="rounded-xl border border-[#1f1f1f] bg-black/20 overflow-hidden">
        {/* Header row */}
        <div className="px-4 py-3 border-b border-[#141414]">
          <div className="flex items-center gap-3">
            <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">
              NCAAB Stats · {mode === "off" ? "Offense" : "Defense"}
            </div>

            <div className="ml-auto flex items-center gap-2">
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
            </div>
          </div>

          <div className="mt-3 grid grid-cols-12 gap-3 items-center">
            <div className="col-span-5 text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">
              Metric (stat_key)
            </div>

            <div className="col-span-3 flex items-center gap-2 justify-end min-w-0">
              <LogoBox team={event.away.teamName} url={awayLogo} size={26} />
              <div className="text-[10px] text-white font-extrabold truncate">{awayAbbr}</div>
            </div>

            <div className="col-span-3 flex items-center gap-2 justify-end min-w-0">
              <LogoBox team={event.home.teamName} url={homeLogo} size={26} />
              <div className="text-[10px] text-white font-extrabold truncate">{homeAbbr}</div>
            </div>

            <div className="col-span-1 text-right text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">
              Δ
            </div>
          </div>
        </div>

        <div className="px-4 py-2">
          {statsDefs.map((d) => {
            const a = aMap.get(d.key);
            const h = hMap.get(d.key);

            const aTxt = Number.isFinite(a as any) ? (d.fmt ? d.fmt(a as number) : String(a)) : "—";
            const hTxt = Number.isFinite(h as any) ? (d.fmt ? d.fmt(h as number) : String(h)) : "—";

            const hib = d.higherIsBetter ?? true;
            const { aGood, hGood } = compare(a as any, h as any, hib);

            let deltaTxt = "—";
            if (Number.isFinite(a as any) && Number.isFinite(h as any)) {
              const dv = (a as number) - (h as number);
              deltaTxt = `${dv > 0 ? "+" : ""}${dv.toFixed(2)}`;
            }

            return (
              <div key={d.key} className="grid grid-cols-12 gap-3 items-center py-2 border-b border-[#141414] last:border-b-0">
                <div className="col-span-5 min-w-0">
                  <div className="text-[11px] text-white font-extrabold truncate">{d.label}</div>
                  <div className="text-[10px] text-[#808080] font-semibold truncate">
                    <span className="text-[#5c5c5c]">{d.key}</span>
                    {d.hint ? <span className="text-[#404040]"> · </span> : null}
                    {d.hint ? <span>{d.hint}</span> : null}
                  </div>
                </div>

                <div className="col-span-3">
                  <div className={cx("text-right tabular-nums", aGood ? "text-green-400 font-extrabold" : "text-[#d6d6d6] font-bold")}>
                    {aTxt}
                  </div>
                </div>

                <div className="col-span-3">
                  <div className={cx("text-right tabular-nums", hGood ? "text-green-400 font-extrabold" : "text-[#d6d6d6] font-bold")}>
                    {hTxt}
                  </div>
                </div>

                <div className="col-span-1">
                  <div className="text-right tabular-nums text-[#a8a8a8] font-bold">{deltaTxt}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-[#141414] text-[10px] text-[#7a7a7a]">
          Uses canonical names for lookups. Values pulled via away_score/home_score per team side.
          {` `}
          <span className="text-[#5c5c5c]">(Off/Def efficiency removed — use Adj Off/Adj Def above.)</span>
        </div>
      </div>
    );
  };

  return (
    <>
      {/* Overlay */}
      <div
        className={overlay}
        onClick={onClose}
        style={{
          background:
            "radial-gradient(1000px 400px at 20% 0%, rgba(212,175,55,0.16), transparent 60%), rgba(0,0,0,0.72)",
          transition: "opacity 160ms ease",
        }}
      />

      {/* Modal */}
      <div className={modal} style={{ transition: "opacity 160ms ease, transform 160ms ease" }}>
        {/* Header */}
        <div className="relative px-5 pt-5 pb-4 border-b border-[#141414]">
          <div
            className="pointer-events-none absolute inset-0 opacity-95"
            style={{
              background:
                "radial-gradient(900px 240px at 18% 0%, rgba(212,175,55,0.14), transparent 62%), radial-gradient(700px 220px at 85% 12%, rgba(255,255,255,0.05), transparent 60%)",
            }}
          />

          <div className="relative flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-1 text-[11px] text-[#b0b0b0]">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#d4af37" }} />
                  Model View
                </span>

                <div className="hidden sm:flex items-center gap-2">
                  <Chip>{String(sportKey).toUpperCase()}</Chip>
                  <Chip>
                    {fmtDateCentral(event.commenceTime)} · {fmtTimeCentral(event.commenceTime)}
                  </Chip>
                </div>
              </div>

              <div className="mt-3 text-white font-extrabold text-[18px] leading-tight truncate">
                {event.away.teamName} vs {event.home.teamName}
              </div>

              <div className="mt-1 text-[11px] text-[#9a9a9a]">
                Proj:{" "}
                <span className="text-white font-extrabold tabular-nums">
                  {event.away.teamAbbr} {event.away.projPoints.toFixed(1)}
                </span>
                <span className="text-[#404040]"> · </span>
                <span className="text-white font-extrabold tabular-nums">
                  {event.home.teamAbbr} {event.home.projPoints.toFixed(1)}
                </span>
                <span className="text-[#404040]"> · </span>
                <span className="text-[#d6d6d6] font-bold tabular-nums">Total {event.home.projTotal.toFixed(1)}</span>
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

          {/* Subheader status */}
          <div className="relative mt-4 flex items-center gap-2">
            <div className="text-[10px] text-[#808080]">
              {st.loading ? "Loading…" : st.error ? "Stats unavailable" : st.fetchedAt ? `Updated ${st.fetchedAt}` : ""}
            </div>
            {!isNcaab ? (
              <div className="ml-auto text-[10px] text-[#5c5c5c]">NCAAB stats hidden (sport ≠ NCAAB)</div>
            ) : null}
          </div>
        </div>

        {/* Body */}
        <div className="bg-[#070707]">
          {st.loading ? (
            <div className="px-5 py-4 border-b border-[#141414] text-[11px] text-[#b0b0b0]">Loading…</div>
          ) : null}

          {st.error ? (
            <div className="px-5 py-4 border-b border-[#141414] text-[11px] text-red-400">{st.error}</div>
          ) : null}

          <div className="px-5 py-5 max-h-[calc(100vh-220px)] overflow-y-auto space-y-4">
            <div>
              <div className="mb-2 text-[11px] font-extrabold text-white">Team Ratings</div>
              <RatingsPanel />
            </div>

            {isNcaab ? (
              <div>
                <div className="mb-2 text-[11px] font-extrabold text-white">NCAAB Stats</div>
                <NcaabStatsPanel />
              </div>
            ) : null}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-[#141414] bg-[#0b0b0b] flex items-center justify-between">
          <div className="text-[10px] text-[#7a7a7a]">Canonical matching enforced · One modal per event · Logos from team_map</div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] px-4 py-2 text-[11px] font-extrabold text-white hover:bg-[#121212]"
          >
            Close
          </button>
        </div>
      </div>
    </>
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

  const [consensusMap, setConsensusMap] = useState<Map<string, Consensus>>(new Map());
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});

  const [loadingRun, setLoadingRun] = useState(true);
  const [loadingResults, setLoadingResults] = useState(false);
  const [loadingConsensus, setLoadingConsensus] = useState(false);

  // Modal state (single per event)
  const [modelOpen, setModelOpen] = useState(false);
  const [modelEvent, setModelEvent] = useState<EventBundle | null>(null);

  /* 0) team_map logos + abbrev */
  useEffect(() => {
    let mounted = true;

    async function loadTeamMap() {
      const { data, error } = await supabase.from("team_map").select('canonical,"Logo URL","Abbreviation","Abbreviation2"');
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

        const ab1 = (r.Abbreviation ?? "").trim();
        const ab2 = ((r as any)?.Abbreviation2 ?? "").trim();
        const ab = (ab1 || ab2 || "").trim();
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

  /* 1) latest run for sportKey */
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

  /* 2) results for run */
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

  /* 3) consensus from odds_snapshot */
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

      // de-dupe per (event, market, book, side) and collect medians
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

  /* 4) bundle event rows */
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
      });
    }

    return out;
  }, [results, abbrMap, logoMap, consensusMap]);

  /* keep open state aligned */
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
      const c = consensusMap.get(ev.eventId);
      if (c?.ts) {
        const t = new Date(c.ts).getTime();
        if (Number.isFinite(t)) stamps.push(t);
      }
    }
    if (!stamps.length) return null;
    return new Date(Math.max(...stamps)).toLocaleString();
  }, [events, consensusMap]);

  const openModel = (ev: EventBundle) => {
    setModelEvent(ev);
    setModelOpen(true);
  };

  /* =========================================================
     Render
  ========================================================= */

  return (
    <div className="h-[calc(100vh-120px)] md:h-[calc(100vh-140px)] overflow-y-auto pr-1 space-y-4">
      {/* Modal */}
      <ModelModal
        open={modelOpen}
        onClose={() => setModelOpen(false)}
        sportKey={sportKey}
        event={modelEvent}
        logoMap={logoMap}
        abbrMap={abbrMap}
      />

      {/* HERO / HEADER */}
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
              One block per matchup. Tap <span className="text-white font-extrabold">Model</span> for ratings + stats (combined).
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

      {/* DESKTOP TABLE */}
      <div className="hidden md:block bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl overflow-hidden">
        <div className="max-h-[70vh] overflow-y-auto">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-20">
                <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                  <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-30 min-w-[420px]">
                    Matchup
                  </th>
                  <th className="text-center p-3 text-[#808080] min-w-[110px]">Proj Score</th>
                  <th className="text-center p-3 text-[#808080] min-w-[90px]">Win%</th>
                  <th className="text-center p-3 text-[#808080] min-w-[160px]">Proj Margin</th>
                  <th className="text-center p-3 text-[#808080] min-w-[160px]">Proj Total</th>
                  <th className="text-center p-3 text-[#808080] min-w-[170px]">Cons Spread</th>
                  <th className="text-center p-3 text-[#808080] min-w-[170px]">Cons Total</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-[#141414]">
                {events.map((ev, idx) => (
                  <DesktopEventRows
                    key={ev.eventId}
                    ev={ev}
                    showDivider={idx < events.length - 1}
                    onOpenModel={() => openModel(ev)}
                  />
                ))}

                {!loading && !events.length ? (
                  <tr>
                    <td colSpan={7} className="p-10 text-center text-xs text-[#808080]">
                      No Monte Carlo rows found for this sport/run.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* MOBILE CARDS */}
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

                    {/* ONE Model button per event */}
                    <SoftButton onClick={() => openModel(ev)} title="Open Model View">
                      Model
                    </SoftButton>
                  </div>

                  <div className="text-[11px] text-[#808080] mt-1">
                    {fmtDateCentral(ev.commenceTime)} · {fmtTimeCentral(ev.commenceTime)}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setOpenMap((p) => ({ ...p, [ev.eventId]: !p[ev.eventId] }))}
                  className="shrink-0 px-3 py-2 rounded-lg bg-[#111] border border-[#2a2a2a] text-[11px] text-[#d0d0d0] hover:bg-[#141414]"
                >
                  {open ? "Hide" : "Details"}
                </button>
              </div>

              {/* Away */}
              <div className="mt-3 flex items-center gap-3 min-w-0">
                <LogoBox team={ev.away.teamName} url={ev.away.logoUrl} size={34} />
                <div className="min-w-0 leading-tight">
                  <div className="text-[11px] text-white font-extrabold truncate" title={ev.away.teamName}>
                    {ev.away.teamName}
                  </div>
                  <div className="text-[9px] text-[#7a7a7a] font-semibold">AWAY · {ev.away.teamAbbr}</div>
                </div>
                <div className="ml-auto flex items-baseline tabular-nums gap-2 shrink-0">
                  <div className={cx("font-extrabold text-[13px]", ev.away.isProjectedWinner ? "text-green-400" : "text-white")}>
                    {ev.away.projPoints.toFixed(1)}
                  </div>
                  <div className="font-bold text-[10px] text-[#bdbdbd]">{pct01(ev.away.winProbTeam)}</div>
                </div>
              </div>

              {/* Home */}
              <div className="mt-3 flex items-center gap-3 min-w-0">
                <LogoBox team={ev.home.teamName} url={ev.home.logoUrl} size={34} />
                <div className="min-w-0 leading-tight">
                  <div className="text-[11px] text-white font-extrabold truncate" title={ev.home.teamName}>
                    {ev.home.teamName}
                  </div>
                  <div className="text-[9px] text-[#7a7a7a] font-semibold">HOME · {ev.home.teamAbbr}</div>
                </div>
                <div className="ml-auto flex items-baseline tabular-nums gap-2 shrink-0">
                  <div className={cx("font-extrabold text-[13px]", ev.home.isProjectedWinner ? "text-green-400" : "text-white")}>
                    {ev.home.projPoints.toFixed(1)}
                  </div>
                  <div className="font-bold text-[10px] text-[#bdbdbd]">{pct01(ev.home.winProbTeam)}</div>
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

/* =========================================================
   Desktop rows (2 rows per event)
========================================================= */

function DesktopEventRows({
  ev,
  showDivider,
  onOpenModel,
}: {
  ev: EventBundle;
  showDivider: boolean;
  onOpenModel: () => void;
}) {
  const away = ev.away;
  const home = ev.home;

  const matchupLine = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="text-white truncate">
            {away.teamName} vs {home.teamName}
            <span className="text-[#404040]"> · </span>
            <span className="text-[#b0b0b0]">{fmtDateCentral(ev.commenceTime)}</span>
            <span className="text-[#404040]"> </span>
            <span className="text-[#b0b0b0]">{fmtTimeCentral(ev.commenceTime)}</span>
          </div>

          {/* ONE Model button per event (by team names) */}
          <SoftButton onClick={onOpenModel} title="Open Model View">
            Model
          </SoftButton>
        </div>
      </div>
    </div>
  );

  const CellProjMargin = ({ row }: { row: TeamRow }) => (
    <div className="text-white tabular-nums">
      {fmtSigned1(row.projMarginTeam)}{" "}
      <span className="text-[#808080] text-[10px] font-semibold">({pct01(row.coverProbTeam)})</span>
    </div>
  );

  const CellProjTotal = ({ row, isAway }: { row: TeamRow; isAway: boolean }) => (
    <div className="text-white tabular-nums">
      {isAway ? fmtOU(row.projTotal, "o") : fmtOU(row.projTotal, "u")}{" "}
      <span className="text-[#808080] text-[10px] font-semibold">
        ({pct01(isAway ? row.overProb : row.underProb)})
      </span>
    </div>
  );

  const CellConsSpread = ({ row }: { row: TeamRow }) => (
    <div className="text-white tabular-nums">
      {row.consSpreadLineTeam == null ? (
        "—"
      ) : (
        <>
          {fmtSigned1(row.consSpreadLineTeam)}{" "}
          <span className="text-[#808080] text-[10px] font-semibold">({american(row.consSpreadOddsTeam)})</span>
        </>
      )}
    </div>
  );

  const CellConsTotal = ({ row, isAway }: { row: TeamRow; isAway: boolean }) => (
    <div className="text-white tabular-nums">
      {row.consTotalLine == null ? (
        "—"
      ) : (
        <>
          {isAway ? "o" : "u"}
          {fmtLinePlain(row.consTotalLine)}{" "}
          <span className="text-[#808080] text-[10px] font-semibold">
            ({american(isAway ? row.consTotalOverOdds : row.consTotalUnderOdds)})
          </span>
        </>
      )}
    </div>
  );

  const TeamBlock = ({ row }: { row: TeamRow }) => (
    <div className="flex items-center gap-3 min-w-0">
      <LogoBox team={row.teamName} url={row.logoUrl} size={34} />
      <div className="min-w-0">
        <div className="text-white truncate font-semibold" title={row.teamName}>
          {row.teamName}
        </div>
        <div className="text-[10px] text-[#606060] mt-0.5">
          {row.side} · {row.teamAbbr}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Away row */}
      <tr className="transition-colors hover:bg-white/[0.02]">
        <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10 min-w-[420px]">
          {matchupLine}
          <div className="mt-3">
            <TeamBlock row={away} />
          </div>
        </td>

        <td className="p-3 text-center">
          <div className={cx("font-extrabold tabular-nums", away.isProjectedWinner ? "text-green-400" : "text-white")}>
            {away.projPoints.toFixed(1)}
          </div>
        </td>

        <td className="p-3 text-center">
          <div className="text-[#b0b0b0] font-semibold tabular-nums">{pct01(away.winProbTeam)}</div>
        </td>

        <td className="p-3 text-center">
          <CellProjMargin row={away} />
        </td>

        <td className="p-3 text-center">
          <CellProjTotal row={away} isAway />
        </td>

        <td className="p-3 text-center">
          <CellConsSpread row={away} />
        </td>

        <td className="p-3 text-center">
          <CellConsTotal row={away} isAway />
        </td>
      </tr>

      {/* Home row */}
      <tr className="transition-colors hover:bg-white/[0.02]">
        <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10 min-w-[420px]">
          <TeamBlock row={home} />
        </td>

        <td className="p-3 text-center">
          <div className={cx("font-extrabold tabular-nums", home.isProjectedWinner ? "text-green-400" : "text-white")}>
            {home.projPoints.toFixed(1)}
          </div>
        </td>

        <td className="p-3 text-center">
          <div className="text-[#b0b0b0] font-semibold tabular-nums">{pct01(home.winProbTeam)}</div>
        </td>

        <td className="p-3 text-center">
          <CellProjMargin row={home} />
        </td>

        <td className="p-3 text-center">
          <CellProjTotal row={home} isAway={false} />
        </td>

        <td className="p-3 text-center">
          <CellConsSpread row={home} />
        </td>

        <td className="p-3 text-center">
          <CellConsTotal row={home} isAway={false} />
        </td>
      </tr>

      {/* Divider between games */}
      {showDivider ? (
        <tr>
          <td colSpan={7} className="p-0">
            <div className="h-2 bg-[#0a0a0a] border-t border-[#141414]" />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/* ✅ Default export optional */
export default MonteCarloScreen;
