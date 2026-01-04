// src/app/components/screens/MonteCarloScreen.tsx — FULL REWRITE
// -----------------------------------------------------------------------------------------------------
// ✅ Keeps existing Monte Carlo layout (hero + sticky table + mobile cards)
// ✅ Power Rank badge from team_ratings.power_rank (filtered by sport_key when available)
// ✅ Consensus from odds_snapshot (spreads/totals) median across books, latest ts per event
// ✅ NEW: “Model” button per game (desktop + mobile)
// ✅ NEW: Polished modal showing SIDE-BY-SIDE team stats from public.ncaab_stats
//     - Uses the “proper rows” you provided: stat_key + v_2025 + last_3 + last_1 (+ updated_at)
//     - Fetches stats on-demand when opening the modal
// ✅ Modal is desktop/mobile safe: fixed header/footer, body scroll, safe-area aware

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
  "Logo URL": string | null;
};

type TeamRatingsRow = {
  canonical: string;
  power_rank: number | null;
  sport_key?: string | null;
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
  teamName: string;
  teamAbbr: string;
  logoUrl: string | null;
  powerRank: number | null;

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
  sport_key: string | null;
  season: string | number | null;

  canonical: string | null;
  stat_key: string | null;

  v_2025: number | null;
  last_3: number | null;
  last_1: number | null;

  // present in your table rows; we keep optional to avoid build pain if null
  home_raw?: number | null;
  away_raw?: number | null;

  updated_at?: string | null;
};

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
  return d.toLocaleString("en-US", { timeZone: "America/Chicago" });
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

/* =========================================================
   NCAAB Stats formatting
========================================================= */

const STAT_LABELS: Record<string, string> = {
  "points-per-game": "Points / Game",
  "average-scoring-margin": "Avg Scoring Margin",
  "possessions-per-game": "Pace (Poss / Game)",
  "offensive-efficiency": "Offensive Efficiency",
  "defensive-efficiency": "Defensive Efficiency",

  "effective-field-goal-pct": "eFG%",
  "opponent-effective-field-goal-pct": "Opp eFG%",

  "two-point-pct": "2P%",
  "three-point-pct": "3P%",

  "turnovers-per-game": "Turnovers / Game",
  "opponent-turnovers-per-game": "Opp Turnovers / Game",

  "assists-per-game": "Assists / Game",
  "offensive-rebounds-per-game": "Off Reb / Game",
  "defensive-rebounds-per-game": "Def Reb / Game",

  "free-throw-rate": "FT Rate",
  "opponent-free-throw-rate": "Opp FT Rate",
};

const STAT_ORDER = [
  "points-per-game",
  "average-scoring-margin",
  "possessions-per-game",
  "offensive-efficiency",
  "defensive-efficiency",

  "effective-field-goal-pct",
  "opponent-effective-field-goal-pct",

  "two-point-pct",
  "three-point-pct",

  "turnovers-per-game",
  "opponent-turnovers-per-game",

  "assists-per-game",
  "offensive-rebounds-per-game",
  "defensive-rebounds-per-game",

  "free-throw-rate",
  "opponent-free-throw-rate",
];

function isPctStat(statKey: string) {
  return statKey.includes("pct");
}

function isRateStat(statKey: string) {
  return statKey.includes("rate");
}

function fmtStatValue(statKey: string, v: number | null) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (isPctStat(statKey)) return `${(v * 100).toFixed(1)}%`; // stored as 0-1
  if (isRateStat(statKey)) return v.toFixed(3); // usually small decimals
  // efficiencies & per-game: one decimal reads clean
  return v.toFixed(1);
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

function RankBadge({ rank }: { rank: number | null }) {
  if (rank == null || !Number.isFinite(rank)) return null;
  return (
    <span className="ml-2 inline-flex items-center rounded-md border border-[#2a2a2a] bg-[#0b0b0b] px-1.5 py-0.5 text-[10px] font-extrabold text-[#d4af37] tabular-nums">
      #{Math.round(rank)}
    </span>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!!disabled}
      className={[
        "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[11px] font-extrabold",
        "border border-[#2a2a2a] bg-[#111] text-white hover:bg-[#151515]",
        "disabled:opacity-50 disabled:hover:bg-[#111]",
      ].join(" ")}
    >
      {children}
    </button>
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
   Modal: NCAAB side-by-side stats
========================================================= */

function StatCell({
  statKey,
  main,
  l3,
  l1,
}: {
  statKey: string;
  main: number | null;
  l3: number | null;
  l1: number | null;
}) {
  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="text-white font-extrabold tabular-nums text-[12px]">{fmtStatValue(statKey, main)}</div>
      <div className="text-[10px] text-[#8a8a8a] font-semibold tabular-nums">
        L3 {fmtStatValue(statKey, l3)} <span className="text-[#2a2a2a]">•</span> L1 {fmtStatValue(statKey, l1)}
      </div>
    </div>
  );
}

function ModelModal({
  open,
  onClose,
  sportKey,
  ev,
}: {
  open: boolean;
  onClose: () => void;
  sportKey: SportKey;
  ev: EventBundle | null;
}) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [awayStats, setAwayStats] = useState<Map<string, NcaabStatRow>>(new Map());
  const [homeStats, setHomeStats] = useState<Map<string, NcaabStatRow>>(new Map());

  // lock body scroll
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    let mounted = true;

    async function loadNcaabStats() {
      if (!open || !ev) return;

      // Only meaningful for NCAAB; for other sports we still open the modal,
      // but we’ll show a gentle message.
      if (sportKey !== "basketball_ncaab") {
        setAwayStats(new Map());
        setHomeStats(new Map());
        setErr(null);
        return;
      }

      setLoading(true);
      setErr(null);
      setAwayStats(new Map());
      setHomeStats(new Map());

      const awayCanonical = (ev.away.teamName ?? "").trim();
      const homeCanonical = (ev.home.teamName ?? "").trim();

      const { data, error } = await supabase
        .from("ncaab_stats")
        .select("sport_key,season,canonical,stat_key,v_2025,last_3,last_1,home_raw,away_raw,updated_at")
        .eq("sport_key", "basketball_ncaab")
        .in("canonical", [awayCanonical, homeCanonical])
        .order("updated_at", { ascending: false })
        .limit(2000);

      if (!mounted) return;

      if (error) {
        setErr(error.message);
        setLoading(false);
        return;
      }

      const rows = (data ?? []) as NcaabStatRow[];

      // Deduplicate by (canonical, stat_key) keeping the most recently updated row (we ordered desc)
      const seen = new Set<string>();
      const aMap = new Map<string, NcaabStatRow>();
      const hMap = new Map<string, NcaabStatRow>();

      for (const r of rows) {
        const c = (r.canonical ?? "").trim();
        const k = (r.stat_key ?? "").trim();
        if (!c || !k) continue;

        const key = `${normKey(c)}|${k.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (normKey(c) === normKey(awayCanonical)) aMap.set(k, r);
        if (normKey(c) === normKey(homeCanonical)) hMap.set(k, r);
      }

      setAwayStats(aMap);
      setHomeStats(hMap);
      setLoading(false);
    }

    loadNcaabStats();
    return () => {
      mounted = false;
    };
  }, [open, ev?.eventId, sportKey]);

  const latestUpdated = useMemo(() => {
    const all = [
      ...Array.from(awayStats.values()).map((r) => r.updated_at ?? null),
      ...Array.from(homeStats.values()).map((r) => r.updated_at ?? null),
    ]
      .filter(Boolean)
      .map((s) => new Date(String(s)).getTime())
      .filter((t) => Number.isFinite(t));

    if (!all.length) return null;
    return formatTs(new Date(Math.max(...all)).toISOString());
  }, [awayStats, homeStats]);

  if (!open || !ev) return null;

  const away = ev.away;
  const home = ev.home;

  return (
    <div className="fixed inset-0 z-[80]">
      {/* overlay */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-[2px]" onClick={onClose} />

      {/* dialog */}
      <div className="absolute inset-0 flex items-end md:items-center justify-center p-2 md:p-6">
        <div
          className={[
            "relative w-full max-w-5xl rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden",
            "shadow-[0_0_0_1px_rgba(0,0,0,0.35),0_18px_70px_rgba(0,0,0,0.75)]",
          ].join(" ")}
          style={{
            // iOS safe area
            paddingBottom: "env(safe-area-inset-bottom)",
          }}
        >
          {/* header */}
          <div className="relative px-4 md:px-5 py-4 border-b border-[#1a1a1a]">
            <div
              className="pointer-events-none absolute inset-0 opacity-90"
              style={{
                background:
                  "radial-gradient(900px 240px at 18% 0%, rgba(212,175,55,0.16), transparent 60%), radial-gradient(700px 220px at 85% 10%, rgba(255,255,255,0.05), transparent 60%)",
              }}
            />
            <div className="relative flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[11px] text-[#b0b0b0] font-semibold">
                  {fmtDateCentral(ev.commenceTime)} · {fmtTimeCentral(ev.commenceTime)}
                </div>
                <div className="text-white text-base md:text-lg font-extrabold mt-1 truncate">
                  {away.teamAbbr} @ {home.teamAbbr}
                </div>
                <div className="text-[11px] text-[#8a8a8a] mt-1">
                  {away.teamName} vs {home.teamName}
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
          </div>

          {/* body */}
          <div className="max-h-[72vh] md:max-h-[70vh] overflow-y-auto">
            <div className="p-4 md:p-5 space-y-4">
              {/* top summary */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="rounded-xl border border-[#2a2a2a] bg-[#0b0b0b] p-4">
                  <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">Projected Score</div>
                  <div className="mt-2 flex items-center justify-between">
                    <div className="text-white font-extrabold tabular-nums">
                      {away.teamAbbr} {away.projPoints.toFixed(1)}
                    </div>
                    <div className="text-white font-extrabold tabular-nums">
                      {home.teamAbbr} {home.projPoints.toFixed(1)}
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] text-[#8a8a8a]">
                    Win% {away.teamAbbr} <span className="text-white font-bold">{pct01(away.winProbTeam)}</span>{" "}
                    <span className="text-[#2a2a2a]">•</span> {home.teamAbbr}{" "}
                    <span className="text-white font-bold">{pct01(home.winProbTeam)}</span>
                  </div>
                </div>

                <div className="rounded-xl border border-[#2a2a2a] bg-[#0b0b0b] p-4">
                  <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">Model Edges</div>
                  <div className="mt-2 text-[11px] text-[#bdbdbd]">
                    Margin{" "}
                    <span className="text-white font-extrabold tabular-nums">
                      {fmtSigned1(home.projMarginTeam)}
                    </span>{" "}
                    <span className="text-[#2a2a2a]">•</span> Total{" "}
                    <span className="text-white font-extrabold tabular-nums">{fmtLinePlain(home.projTotal)}</span>
                  </div>
                  <div className="mt-2 text-[11px] text-[#8a8a8a]">
                    Cover {away.teamAbbr} <span className="text-white font-bold">{pct01(away.coverProbTeam)}</span>{" "}
                    <span className="text-[#2a2a2a]">•</span> Over{" "}
                    <span className="text-white font-bold">{pct01(away.overProb)}</span>
                  </div>
                </div>

                <div className="rounded-xl border border-[#2a2a2a] bg-[#0b0b0b] p-4">
                  <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">Consensus</div>
                  <div className="mt-2 text-[11px] text-[#bdbdbd]">
                    Spread{" "}
                    <span className="text-white font-extrabold tabular-nums">
                      {away.consSpreadLineTeam == null ? "—" : fmtSigned1(away.consSpreadLineTeam)}
                    </span>{" "}
                    <span className="text-[#8a8a8a] font-semibold">
                      ({american(away.consSpreadOddsTeam)})
                    </span>
                    <span className="text-[#2a2a2a]"> • </span>
                    Total{" "}
                    <span className="text-white font-extrabold tabular-nums">
                      {away.consTotalLine == null ? "—" : fmtLinePlain(away.consTotalLine)}
                    </span>
                  </div>
                  <div className="mt-2 text-[11px] text-[#8a8a8a]">
                    Updated <span className="text-white font-semibold">{latestUpdated ?? "—"}</span>
                  </div>
                </div>
              </div>

              {/* Team row */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-xl border border-[#2a2a2a] bg-black/10 p-4">
                  <div className="flex items-center gap-3">
                    <LogoBox team={away.teamName} url={away.logoUrl} size={38} />
                    <div className="min-w-0">
                      <div className="text-white font-extrabold truncate">
                        {away.teamName}
                        <RankBadge rank={away.powerRank} />
                      </div>
                      <div className="text-[11px] text-[#8a8a8a] font-semibold">{away.teamAbbr} · AWAY</div>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-[#2a2a2a] bg-black/10 p-4">
                  <div className="flex items-center gap-3">
                    <LogoBox team={home.teamName} url={home.logoUrl} size={38} />
                    <div className="min-w-0">
                      <div className="text-white font-extrabold truncate">
                        {home.teamName}
                        <RankBadge rank={home.powerRank} />
                      </div>
                      <div className="text-[11px] text-[#8a8a8a] font-semibold">{home.teamAbbr} · HOME</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* NCAAB stats */}
              <div className="rounded-xl border border-[#2a2a2a] bg-[#0b0b0b] overflow-hidden">
                <div className="px-4 py-3 border-b border-[#1a1a1a] flex items-center justify-between gap-3">
                  <div className="text-[12px] font-extrabold text-white">Team Stats (NCAAB)</div>
                  <div className="text-[11px] text-[#8a8a8a] font-semibold">
                    Season: <span className="text-white">v_2025</span> <span className="text-[#2a2a2a]">•</span>{" "}
                    Recent: <span className="text-white">L3 / L1</span>
                  </div>
                </div>

                {sportKey !== "basketball_ncaab" ? (
                  <div className="p-6 text-[12px] text-[#a8a8a8]">
                    Stats modal is wired to <span className="text-white font-semibold">ncaab_stats</span> and will show
                    for NCAAB only.
                  </div>
                ) : err ? (
                  <div className="p-6 text-[12px] text-red-400">
                    Failed to load ncaab_stats: <span className="font-semibold">{err}</span>
                  </div>
                ) : loading ? (
                  <div className="p-6 text-[12px] text-[#a8a8a8]">Loading team stats…</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-[#0a0a0a]">
                        <tr className="border-b border-[#1a1a1a]">
                          <th className="text-left px-4 py-3 text-[#808080] min-w-[210px]">Stat</th>
                          <th className="text-right px-4 py-3 text-[#808080] min-w-[190px]">
                            {away.teamAbbr}
                          </th>
                          <th className="text-right px-4 py-3 text-[#808080] min-w-[190px]">
                            {home.teamAbbr}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#141414]">
                        {STAT_ORDER.map((k) => {
                          const a = awayStats.get(k) ?? null;
                          const h = homeStats.get(k) ?? null;

                          return (
                            <tr key={k} className="hover:bg-white/[0.02]">
                              <td className="px-4 py-3 text-[#d0d0d0] font-semibold">
                                {STAT_LABELS[k] ?? k}
                              </td>
                              <td className="px-4 py-3">
                                <StatCell
                                  statKey={k}
                                  main={a?.v_2025 ?? null}
                                  l3={a?.last_3 ?? null}
                                  l1={a?.last_1 ?? null}
                                />
                              </td>
                              <td className="px-4 py-3">
                                <StatCell
                                  statKey={k}
                                  main={h?.v_2025 ?? null}
                                  l3={h?.last_3 ?? null}
                                  l1={h?.last_1 ?? null}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* quick details panel (same as mobile) */}
              <div className="md:hidden">
                <MobileDetailsBlock away={away} home={home} />
              </div>
            </div>
          </div>

          {/* footer (desktop) */}
          <div className="hidden md:flex items-center justify-between gap-3 px-5 py-4 border-t border-[#1a1a1a] bg-[#0b0b0b]">
            <div className="text-[11px] text-[#8a8a8a] font-semibold">
              Model view: Monte Carlo + Consensus + NCAAB team stats
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-[#2a2a2a] bg-[#111] px-4 py-2 text-[12px] font-extrabold text-white hover:bg-[#151515]"
            >
              Done
            </button>
          </div>
        </div>
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

  // modal
  const [modelOpen, setModelOpen] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  /* 0) team_map logos + abbrev */
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

  /* 0b) team_ratings power_rank */
  useEffect(() => {
    let mounted = true;

    async function loadPowerRanks() {
      // If your team_ratings table lacks sport_key, remove eq() and select("canonical,power_rank").
      const { data, error } = await supabase
        .from("team_ratings")
        .select("canonical,power_rank,sport_key")
        .eq("sport_key", sportKey);

      if (!mounted) return;

      if (error) {
        console.warn("[MonteCarloScreen] team_ratings error:", error.message);
        setPowerRankMap(new Map());
        return;
      }

      const pm = new Map<string, number>();
      for (const r of (data ?? []) as TeamRatingsRow[]) {
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

  /* 1) latest run for sportKey */
  useEffect(() => {
    let mounted = true;

    async function loadRun() {
      setLoadingRun(true);
      setSettingsError(null);
      setRun(null);
      setResults([]);
      setConsensusMap(new Map());
      setSelectedEventId(null);
      setModelOpen(false);

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
      });
    }

    return out;
  }, [results, abbrMap, logoMap, consensusMap, powerRankMap]);

  /* keep open state aligned */
  useEffect(() => {
    setOpenMap((prev) => {
      const next: Record<string, boolean> = {};
      for (const ev of events) next[ev.eventId] = prev[ev.eventId] ?? false;
      return next;
    });
  }, [events]);

  const selectedEvent = useMemo(() => {
    if (!selectedEventId) return null;
    return events.find((e) => e.eventId === selectedEventId) ?? null;
  }, [selectedEventId, events]);

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
    return new Date(Math.max(...stamps)).toLocaleString("en-US", { timeZone: "America/Chicago" });
  }, [events, consensusMap]);

  function openModel(evId: string) {
    setSelectedEventId(evId);
    setModelOpen(true);
  }

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
        ev={selectedEvent}
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
              One block per matchup. Use <span className="text-white font-semibold">Model</span> to see side-by-side team
              stats + model outputs.
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
                  <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-30 min-w-[360px]">
                    Matchup
                  </th>
                  <th className="text-center p-3 text-[#808080] min-w-[110px]">Proj Score</th>
                  <th className="text-center p-3 text-[#808080] min-w-[90px]">Win%</th>
                  <th className="text-center p-3 text-[#808080] min-w-[160px]">Proj Margin</th>
                  <th className="text-center p-3 text-[#808080] min-w-[160px]">Proj Total</th>
                  <th className="text-center p-3 text-[#808080] min-w-[170px]">Cons Spread</th>
                  <th className="text-center p-3 text-[#808080] min-w-[170px]">Cons Total</th>
                  <th className="text-center p-3 text-[#808080] min-w-[110px]">Model</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-[#141414]">
                {events.map((ev, idx) => (
                  <DesktopEventRows
                    key={ev.eventId}
                    ev={ev}
                    showDivider={idx < events.length - 1}
                    onOpenModel={() => openModel(ev.eventId)}
                  />
                ))}

                {!loading && !events.length ? (
                  <tr>
                    <td colSpan={8} className="p-10 text-center text-xs text-[#808080]">
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
                  <div className="text-white text-sm truncate">
                    {ev.away.teamAbbr} @ {ev.home.teamAbbr}
                  </div>
                  <div className="text-[11px] text-[#808080] mt-1">
                    {fmtDateCentral(ev.commenceTime)} · {fmtTimeCentral(ev.commenceTime)}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <PrimaryButton onClick={() => openModel(ev.eventId)}>Model</PrimaryButton>
                  <button
                    type="button"
                    onClick={() => setOpenMap((p) => ({ ...p, [ev.eventId]: !p[ev.eventId] }))}
                    className="shrink-0 px-3 py-2 rounded-lg bg-[#111] border border-[#2a2a2a] text-[11px] font-extrabold text-[#d0d0d0] hover:bg-[#141414]"
                  >
                    {open ? "Hide" : "Details"}
                  </button>
                </div>
              </div>

              {/* Away */}
              <div className="mt-3 flex items-center gap-3 min-w-0">
                <LogoBox team={ev.away.teamName} url={ev.away.logoUrl} size={34} />
                <div className="min-w-0 leading-tight">
                  <div className="text-[11px] text-white font-extrabold truncate" title={ev.away.teamName}>
                    {ev.away.teamName}
                    <RankBadge rank={ev.away.powerRank} />
                  </div>
                  <div className="text-[9px] text-[#7a7a7a] font-semibold">AWAY · {ev.away.teamAbbr}</div>
                </div>
                <div className="ml-auto flex items-baseline tabular-nums gap-2 shrink-0">
                  <div
                    className={[
                      "font-extrabold text-[13px]",
                      ev.away.isProjectedWinner ? "text-green-400" : "text-white",
                    ].join(" ")}
                  >
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
                    <RankBadge rank={ev.home.powerRank} />
                  </div>
                  <div className="text-[9px] text-[#7a7a7a] font-semibold">HOME · {ev.home.teamAbbr}</div>
                </div>
                <div className="ml-auto flex items-baseline tabular-nums gap-2 shrink-0">
                  <div
                    className={[
                      "font-extrabold text-[13px]",
                      ev.home.isProjectedWinner ? "text-green-400" : "text-white",
                    ].join(" ")}
                  >
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
   Desktop rows
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
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="text-white truncate">
          {away.teamName} vs {home.teamName}
          <span className="text-[#404040]"> · </span>
          <span className="text-[#b0b0b0]">{fmtDateCentral(ev.commenceTime)}</span>
          <span className="text-[#404040]"> </span>
          <span className="text-[#b0b0b0]">{fmtTimeCentral(ev.commenceTime)}</span>
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
          <RankBadge rank={row.powerRank} />
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
        <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10 min-w-[360px]">
          {matchupLine}
          <div className="mt-3">
            <TeamBlock row={away} />
          </div>
        </td>

        <td className="p-3 text-center">
          <div
            className={[
              "font-extrabold tabular-nums",
              away.isProjectedWinner ? "text-green-400" : "text-white",
            ].join(" ")}
          >
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

        <td className="p-3 text-center align-middle" rowSpan={2}>
          <PrimaryButton onClick={onOpenModel}>Model</PrimaryButton>
        </td>
      </tr>

      {/* Home row */}
      <tr className="transition-colors hover:bg-white/[0.02]">
        <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10 min-w-[360px]">
          <TeamBlock row={home} />
        </td>

        <td className="p-3 text-center">
          <div
            className={[
              "font-extrabold tabular-nums",
              home.isProjectedWinner ? "text-green-400" : "text-white",
            ].join(" ")}
          >
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
          <td colSpan={8} className="p-0">
            <div className="h-2 bg-[#0a0a0a] border-t border-[#141414]" />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/* ✅ Default export optional (matches your pattern) */
export default MonteCarloScreen;

