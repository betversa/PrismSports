// src/app/components/screens/MonteCarloScreen.tsx — FULL REWRITE
// -----------------------------------------------------------------------------------------------------
// ✅ Visual layout matches ModelScreen (hero gradient + badge + chips + dark sticky table)
// ✅ Mobile: cards + Details collapsible
// ✅ Desktop: inline columns (Proj Score | Win% | Proj Margin | Proj Total | Cons Spread | Cons Total)
// ✅ Logos + abbreviations via team_map (canonical -> "Logo URL", Abbreviation)
// ✅ Power Rank via team_ratings (canonical -> power_rank) shown next to team name
// ✅ Consensus via odds_snapshot (spreads/totals) median across books, latest-per-book de-dupe
// ✅ Removes Event ID display — shows Date + Time only
// ✅ Subtle divider between games
//
// ✅ NEW: "Model" button by each team name (away + home) that opens a polished modal
// ✅ Modal shows SIDE-BY-SIDE stats pulled from:
//      1) public.ncaab_stats (long format: canonical + stat_key + v_2025/last_3/last_1/etc.)
//      2) public.team_ratings (engine_power + core model fields)
// ✅ IMPORTANT: Stat lookups use CANONICAL team names (NOT abbreviations)

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

  home_team: string | null; // canonical
  away_team: string | null; // canonical

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
  sport_key?: string | null;

  power_rank: number | null;

  // engine fields (present in your CSV)
  engine_power: number | null;
  engine_adj_off: number | null;
  engine_adj_def: number | null;
  tempo: number | null;

  sigma_margin_100: number | null;
  sigma_total_100: number | null;
  sigma_margin_game_floor: number | null;
  sigma_total_game_floor: number | null;

  true_hca: number | null;

  updated_at?: string | null;
};

type NcaabStatRow = {
  sport_key: string;
  season: string;
  canonical: string;
  stat_key: string;

  v_2025: number | null;
  last_3: number | null;
  last_1: number | null;

  v_2024: number | null;

  ha_2025: number | null;
  ha_2024: number | null;

  ha_last_3: number | null;
  ha_last_1: number | null;

  updated_at: string | null;
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

  // canonical (used for lookups)
  canonical: string;

  // display
  teamName: string;
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

function fmt1(x: number | null) {
  if (x == null || !Number.isFinite(x)) return "—";
  const v = Math.round(x * 10) / 10;
  return v.toFixed(1);
}

function fmt2(x: number | null) {
  if (x == null || !Number.isFinite(x)) return "—";
  const v = Math.round(x * 100) / 100;
  return v.toFixed(2);
}

function fmt3(x: number | null) {
  if (x == null || !Number.isFinite(x)) return "—";
  const v = Math.round(x * 1000) / 1000;
  return v.toFixed(3);
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

function SmallButton({
  onClick,
  children,
  title,
}: {
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="ml-2 inline-flex items-center rounded-md border border-[#2a2a2a] bg-[#0b0b0b] px-2 py-1 text-[10px] font-extrabold text-[#d0d0d0] hover:bg-[#111] hover:text-white"
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
   NCAAB Stats Modal (side-by-side)
========================================================= */

type StatPack = {
  season: string | null;
  updatedAt: string | null;
  byKey: Map<
    string,
    {
      v_2025: number | null;
      last_3: number | null;
      last_1: number | null;
      v_2024: number | null;

      ha_2025: number | null;
      ha_last_3: number | null;
      ha_last_1: number | null;
      ha_2024: number | null;
    }
  >;
};

function StatRowLine({
  label,
  a,
  h,
  fmt,
}: {
  label: string;
  a: number | null;
  h: number | null;
  fmt: (x: number | null) => string;
}) {
  return (
    <div className="grid grid-cols-12 gap-2 items-center py-2 border-b border-[#141414] last:border-b-0">
      <div className="col-span-6 text-[11px] text-[#9a9a9a] font-extrabold uppercase tracking-wide">{label}</div>
      <div className="col-span-3 text-right text-[12px] text-white font-bold tabular-nums">{fmt(a)}</div>
      <div className="col-span-3 text-right text-[12px] text-white font-bold tabular-nums">{fmt(h)}</div>
    </div>
  );
}

function KpiBox({
  title,
  left,
  right,
}: {
  title: string;
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#0b0b0b] overflow-hidden">
      <div className="px-4 py-2 border-b border-[#141414] text-[11px] text-white font-extrabold">{title}</div>
      <div className="grid grid-cols-2 gap-0">
        <div className="px-4 py-3 border-r border-[#141414]">{left}</div>
        <div className="px-4 py-3">{right}</div>
      </div>
    </div>
  );
}

function MiniTriplet({
  label,
  v2025,
  l3,
  l1,
  decimals = 2,
  isPct = false,
}: {
  label: string;
  v2025: number | null;
  l3: number | null;
  l1: number | null;
  decimals?: number;
  isPct?: boolean;
}) {
  const f = (x: number | null) => {
    if (x == null || !Number.isFinite(Number(x))) return "—";
    const n = Number(x);
    const v = Math.round(n * Math.pow(10, decimals)) / Math.pow(10, decimals);
    if (isPct) return `${(v * 100).toFixed(1)}%`;
    return v.toFixed(decimals);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] text-[#808080] font-extrabold uppercase tracking-wide">{label}</div>
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-2 py-1.5">
          <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">2025</div>
          <div className="text-[12px] text-white font-extrabold tabular-nums">{f(v2025)}</div>
        </div>
        <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-2 py-1.5">
          <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">L3</div>
          <div className="text-[12px] text-white font-extrabold tabular-nums">{f(l3)}</div>
        </div>
        <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-2 py-1.5">
          <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">L1</div>
          <div className="text-[12px] text-white font-extrabold tabular-nums">{f(l1)}</div>
        </div>
      </div>
    </div>
  );
}

function ModelModal({
  open,
  onClose,
  sportKey,
  away,
  home,
}: {
  open: boolean;
  onClose: () => void;
  sportKey: SportKey;

  away: TeamRow;
  home: TeamRow;
}) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [awayStats, setAwayStats] = useState<StatPack | null>(null);
  const [homeStats, setHomeStats] = useState<StatPack | null>(null);

  const [awayTR, setAwayTR] = useState<TeamRatingsRow | null>(null);
  const [homeTR, setHomeTR] = useState<TeamRatingsRow | null>(null);

  // pull data on open
  useEffect(() => {
    let mounted = true;
    async function load() {
      if (!open) return;

      setLoading(true);
      setErr(null);
      setAwayStats(null);
      setHomeStats(null);
      setAwayTR(null);
      setHomeTR(null);

      try {
        // 1) ncaab_stats (CANONICAL LOOKUP)
        // NOTE: table is long format: one row per canonical+stat_key+season
        const { data: sdata, error: serror } = await supabase
          .from("ncaab_stats")
          .select(
            "sport_key,season,canonical,stat_key,v_2025,last_3,last_1,v_2024,ha_2025,ha_2024,ha_last_3,ha_last_1,updated_at"
          )
          .eq("sport_key", "basketball_ncaab")
          .in("canonical", [away.canonical, home.canonical])
          .order("updated_at", { ascending: false })
          .limit(5000);

        if (serror) throw new Error(serror.message);

        const rows = (sdata ?? []) as NcaabStatRow[];

        const buildPack = (canonical: string): StatPack | null => {
          const r = rows.filter((x) => normKey(x.canonical) === normKey(canonical));
          if (!r.length) return null;

          // pick the newest season present for this team (usually 2025-26)
          const bySeason = new Map<string, NcaabStatRow[]>();
          for (const x of r) {
            const key = (x.season ?? "").toString().trim() || "unknown";
            const arr = bySeason.get(key) ?? [];
            arr.push(x);
            bySeason.set(key, arr);
          }

          const seasons = Array.from(bySeason.keys());
          seasons.sort((a, b) => {
            // crude sort but fine: "2025-26" > "2024-25"
            const na = parseInt(a.slice(0, 4), 10);
            const nb = parseInt(b.slice(0, 4), 10);
            if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na;
            return b.localeCompare(a);
          });

          const season = seasons[0];
          const seasonRows = bySeason.get(season) ?? r;

          const byKey = new Map<
            string,
            {
              v_2025: number | null;
              last_3: number | null;
              last_1: number | null;
              v_2024: number | null;
              ha_2025: number | null;
              ha_last_3: number | null;
              ha_last_1: number | null;
              ha_2024: number | null;
            }
          >();

          let newestTs: string | null = null;

          for (const x of seasonRows) {
            const k = (x.stat_key ?? "").toString().trim();
            if (!k) continue;

            if (x.updated_at) {
              const t = new Date(x.updated_at).getTime();
              const prev = newestTs ? new Date(newestTs).getTime() : -Infinity;
              if (Number.isFinite(t) && t > prev) newestTs = x.updated_at;
            }

            // keep first we see for each stat_key (since we ordered updated_at desc)
            if (byKey.has(k)) continue;

            byKey.set(k, {
              v_2025: x.v_2025 == null ? null : Number(x.v_2025),
              last_3: x.last_3 == null ? null : Number(x.last_3),
              last_1: x.last_1 == null ? null : Number(x.last_1),
              v_2024: x.v_2024 == null ? null : Number(x.v_2024),

              ha_2025: x.ha_2025 == null ? null : Number(x.ha_2025),
              ha_last_3: x.ha_last_3 == null ? null : Number(x.ha_last_3),
              ha_last_1: x.ha_last_1 == null ? null : Number(x.ha_last_1),
              ha_2024: x.ha_2024 == null ? null : Number(x.ha_2024),
            });
          }

          return {
            season: season ?? null,
            updatedAt: newestTs,
            byKey,
          };
        };

        const aPack = buildPack(away.canonical);
        const hPack = buildPack(home.canonical);

        // 2) team_ratings (CANONICAL LOOKUP)
        // Uses engine_power etc (yes: this still uses your engine_power)
        const { data: trdata, error: trerr } = await supabase
          .from("team_ratings")
          .select(
            "canonical,sport_key,power_rank,engine_power,engine_adj_off,engine_adj_def,tempo,sigma_margin_100,sigma_total_100,sigma_margin_game_floor,sigma_total_game_floor,true_hca,updated_at"
          )
          .eq("sport_key", sportKey)
          .in("canonical", [away.canonical, home.canonical])
          .limit(2);

        if (trerr) throw new Error(trerr.message);

        const trs = (trdata ?? []) as TeamRatingsRow[];
        const aTR = trs.find((x) => normKey(x.canonical) === normKey(away.canonical)) ?? null;
        const hTR = trs.find((x) => normKey(x.canonical) === normKey(home.canonical)) ?? null;

        if (!mounted) return;

        setAwayStats(aPack);
        setHomeStats(hPack);
        setAwayTR(aTR);
        setHomeTR(hTR);

        setLoading(false);
      } catch (e: any) {
        if (!mounted) return;
        setErr(e?.message ?? "Failed to load model stats.");
        setLoading(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, [open, sportKey, away.canonical, home.canonical]);

  if (!open) return null;

  // curated stat keys (from your ncaab_stats CSV)
  const STAT_GROUPS: Array<{
    title: string;
    keys: Array<{ key: string; label: string; kind: "num" | "pct" | "eff" }>;
  }> = [
    {
      title: "Efficiency",
      keys: [
        { key: "offensive-efficiency", label: "Off Eff", kind: "eff" },
        { key: "defensive-efficiency", label: "Def Eff", kind: "eff" },
        { key: "average-scoring-margin", label: "Avg Margin", kind: "num" },
      ],
    },
    {
      title: "Tempo",
      keys: [
        { key: "possessions-per-game", label: "Poss / Game", kind: "num" },
        { key: "average-first-half-points", label: "1H Pts Avg", kind: "num" },
        { key: "average-second-half-points", label: "2H Pts Avg", kind: "num" },
      ],
    },
    {
      title: "Shooting",
      keys: [
        { key: "field-goal-pct", label: "FG%", kind: "pct" },
        { key: "free-throw-pct", label: "FT%", kind: "pct" },
        { key: "three-point-pct", label: "3P%", kind: "pct" },
      ],
    },
    {
      title: "Rebounding",
      keys: [
        { key: "rebounds-per-game", label: "Reb / Game", kind: "num" },
        { key: "offensive-rebounds-per-game", label: "Off Reb", kind: "num" },
        { key: "defensive-rebounds-per-game", label: "Def Reb", kind: "num" },
      ],
    },
    {
      title: "Ball Security",
      keys: [
        { key: "turnovers-per-game", label: "TO / Game", kind: "num" },
        { key: "assists-per-game", label: "Ast / Game", kind: "num" },
        { key: "steals-per-game", label: "Stl / Game", kind: "num" },
        { key: "blocks-per-game", label: "Blk / Game", kind: "num" },
      ],
    },
    {
      title: "Discipline",
      keys: [
        { key: "personal-fouls-per-game", label: "PF / Game", kind: "num" },
        { key: "opponent-personal-fouls-per-game", label: "Opp PF / Game", kind: "num" },
      ],
    },
  ];

  const getTriplet = (pack: StatPack | null, key: string) => {
    const r = pack?.byKey.get(key);
    return {
      v2025: r?.v_2025 ?? null,
      l3: r?.last_3 ?? null,
      l1: r?.last_1 ?? null,
      ha2025: r?.ha_2025 ?? null,
      hal3: r?.ha_last_3 ?? null,
      hal1: r?.ha_last_1 ?? null,
    };
  };

  const fmtByKind = (kind: "num" | "pct" | "eff") => {
    if (kind === "pct") return (x: number | null) => (x == null ? "—" : `${(Number(x) * 100).toFixed(1)}%`);
    if (kind === "eff") return (x: number | null) => (x == null ? "—" : fmt3(Number(x)));
    return (x: number | null) => (x == null ? "—" : fmt2(Number(x)));
  };

  const modalBody = (
    <div className="rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden shadow-2xl">
      {/* Header */}
      <div className="relative p-4 border-b border-[#141414]">
        <div
          className="pointer-events-none absolute inset-0 opacity-90"
          style={{
            background:
              "radial-gradient(900px 260px at 18% 0%, rgba(212,175,55,0.14), transparent 62%), radial-gradient(700px 240px at 85% 12%, rgba(255,255,255,0.05), transparent 60%)",
          }}
        />
        <div className="relative flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] text-[#b0b0b0] font-extrabold uppercase tracking-wide">
              Model View · NCAAB Stats
            </div>
            <div className="text-white text-base font-extrabold mt-1 truncate">
              {away.teamAbbr} @ {home.teamAbbr}
            </div>
            <div className="text-[11px] text-[#808080] mt-1">
              {fmtDateCentral(away.commenceTime)} · {fmtTimeCentral(away.commenceTime)}{" "}
              <span className="text-[#404040]">·</span>{" "}
              <span className="text-[#b0b0b0] font-semibold">{away.canonical}</span>{" "}
              <span className="text-[#404040]">vs</span>{" "}
              <span className="text-[#b0b0b0] font-semibold">{home.canonical}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="shrink-0 px-3 py-2 rounded-lg bg-[#0b0b0b] border border-[#2a2a2a] text-[11px] font-extrabold text-[#d0d0d0] hover:bg-[#111] hover:text-white"
          >
            Done
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="p-4 space-y-4 max-h-[75vh] overflow-y-auto">
        {loading ? (
          <div className="text-xs text-[#9a9a9a] px-3 py-10 text-center border border-[#2a2a2a] rounded-xl bg-[#0b0b0b]">
            Loading model stats…
          </div>
        ) : err ? (
          <div className="text-xs text-red-300 px-3 py-10 text-center border border-red-900/40 rounded-xl bg-[#0b0b0b]">
            Failed to load stats: {err}
          </div>
        ) : (
          <>
            {/* Quick KPIs */}
            <KpiBox
              title="Model Core (team_ratings)"
              left={
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="text-[10px] text-[#808080] font-extrabold uppercase">Away</div>
                    <div className="text-white font-extrabold text-[12px] truncate">{away.teamAbbr}</div>
                    <div className="ml-auto text-[10px] text-[#808080] font-semibold truncate">
                      {awayTR?.updated_at ? `Updated ${formatTs(awayTR.updated_at)}` : ""}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-3 py-2">
                      <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">Engine Power</div>
                      <div className="text-[14px] text-white font-extrabold tabular-nums">
                        {awayTR?.engine_power == null ? "—" : fmt2(Number(awayTR.engine_power))}
                      </div>
                    </div>
                    <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-3 py-2">
                      <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">Power Rank</div>
                      <div className="text-[14px] text-white font-extrabold tabular-nums">
                        {awayTR?.power_rank == null ? "—" : `#${Math.round(Number(awayTR.power_rank))}`}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-3 py-2">
                      <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">Adj Off</div>
                      <div className="text-[12px] text-white font-extrabold tabular-nums">
                        {awayTR?.engine_adj_off == null ? "—" : fmt2(Number(awayTR.engine_adj_off))}
                      </div>
                    </div>
                    <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-3 py-2">
                      <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">Adj Def</div>
                      <div className="text-[12px] text-white font-extrabold tabular-nums">
                        {awayTR?.engine_adj_def == null ? "—" : fmt2(Number(awayTR.engine_adj_def))}
                      </div>
                    </div>
                    <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-3 py-2">
                      <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">Tempo</div>
                      <div className="text-[12px] text-white font-extrabold tabular-nums">
                        {awayTR?.tempo == null ? "—" : fmt2(Number(awayTR.tempo))}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-3 py-2">
                      <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">σ Margin 100</div>
                      <div className="text-[12px] text-white font-extrabold tabular-nums">
                        {awayTR?.sigma_margin_100 == null ? "—" : fmt2(Number(awayTR.sigma_margin_100))}
                      </div>
                    </div>
                    <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-3 py-2">
                      <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">σ Total 100</div>
                      <div className="text-[12px] text-white font-extrabold tabular-nums">
                        {awayTR?.sigma_total_100 == null ? "—" : fmt2(Number(awayTR.sigma_total_100))}
                      </div>
                    </div>
                  </div>
                </div>
              }
              right={
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="text-[10px] text-[#808080] font-extrabold uppercase">Home</div>
                    <div className="text-white font-extrabold text-[12px] truncate">{home.teamAbbr}</div>
                    <div className="ml-auto text-[10px] text-[#808080] font-semibold truncate">
                      {homeTR?.updated_at ? `Updated ${formatTs(homeTR.updated_at)}` : ""}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-3 py-2">
                      <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">Engine Power</div>
                      <div className="text-[14px] text-white font-extrabold tabular-nums">
                        {homeTR?.engine_power == null ? "—" : fmt2(Number(homeTR.engine_power))}
                      </div>
                    </div>
                    <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-3 py-2">
                      <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">Power Rank</div>
                      <div className="text-[14px] text-white font-extrabold tabular-nums">
                        {homeTR?.power_rank == null ? "—" : `#${Math.round(Number(homeTR.power_rank))}`}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-3 py-2">
                      <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">Adj Off</div>
                      <div className="text-[12px] text-white font-extrabold tabular-nums">
                        {homeTR?.engine_adj_off == null ? "—" : fmt2(Number(homeTR.engine_adj_off))}
                      </div>
                    </div>
                    <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-3 py-2">
                      <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">Adj Def</div>
                      <div className="text-[12px] text-white font-extrabold tabular-nums">
                        {homeTR?.engine_adj_def == null ? "—" : fmt2(Number(homeTR.engine_adj_def))}
                      </div>
                    </div>
                    <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-3 py-2">
                      <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">Tempo</div>
                      <div className="text-[12px] text-white font-extrabold tabular-nums">
                        {homeTR?.tempo == null ? "—" : fmt2(Number(homeTR.tempo))}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-3 py-2">
                      <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">σ Margin 100</div>
                      <div className="text-[12px] text-white font-extrabold tabular-nums">
                        {homeTR?.sigma_margin_100 == null ? "—" : fmt2(Number(homeTR.sigma_margin_100))}
                      </div>
                    </div>
                    <div className="rounded-lg border border-[#1f1f1f] bg-black/20 px-3 py-2">
                      <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase">σ Total 100</div>
                      <div className="text-[12px] text-white font-extrabold tabular-nums">
                        {homeTR?.sigma_total_100 == null ? "—" : fmt2(Number(homeTR.sigma_total_100))}
                      </div>
                    </div>
                  </div>
                </div>
              }
            />

            {/* ncaab_stats side-by-side */}
            <div className="rounded-xl border border-[#2a2a2a] bg-[#0b0b0b] overflow-hidden">
              <div className="px-4 py-2 border-b border-[#141414] flex items-center justify-between gap-3">
                <div className="text-[11px] text-white font-extrabold">Team Stats (ncaab_stats)</div>
                <div className="text-[10px] text-[#808080] font-semibold">
                  {awayStats?.season || homeStats?.season ? `Season ${awayStats?.season ?? homeStats?.season}` : ""}
                  {awayStats?.updatedAt || homeStats?.updatedAt ? (
                    <span className="ml-2 text-[#5e5e5e]">
                      Updated {formatTs(awayStats?.updatedAt ?? homeStats?.updatedAt ?? null)}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="px-4 py-3">
                <div className="grid grid-cols-12 gap-2 items-center pb-2 border-b border-[#141414]">
                  <div className="col-span-6 text-[9px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">
                    Metric (2025 / L3 / L1)
                  </div>
                  <div className="col-span-3 text-right text-[9px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">
                    {away.teamAbbr}
                  </div>
                  <div className="col-span-3 text-right text-[9px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">
                    {home.teamAbbr}
                  </div>
                </div>

                <div className="mt-3 space-y-4">
                  {STAT_GROUPS.map((g) => (
                    <div key={g.title} className="rounded-xl border border-[#1f1f1f] bg-black/15 overflow-hidden">
                      <div className="px-4 py-2 border-b border-[#141414] text-[11px] text-[#d4af37] font-extrabold">
                        {g.title}
                      </div>

                      <div className="p-4 space-y-4">
                        {g.keys.map((k) => {
                          const a = getTriplet(awayStats, k.key);
                          const h = getTriplet(homeStats, k.key);

                          // If BOTH missing, show a subtle "missing" line (helps diagnose)
                          const missingBoth =
                            a.v2025 == null && a.l3 == null && a.l1 == null && h.v2025 == null && h.l3 == null && h.l1 == null;

                          if (missingBoth) {
                            return (
                              <div key={k.key} className="flex items-center justify-between text-[11px] text-[#6f6f6f]">
                                <div className="font-extrabold uppercase tracking-wide">{k.label}</div>
                                <div className="text-[10px] text-[#4e4e4e] font-semibold">
                                  No rows for stat_key: <span className="text-[#6f6f6f]">{k.key}</span>
                                </div>
                              </div>
                            );
                          }

                          return (
                            <div key={k.key} className="grid grid-cols-12 gap-4 items-start">
                              <div className="col-span-12 md:col-span-6">
                                <MiniTriplet
                                  label={k.label}
                                  v2025={a.v2025}
                                  l3={a.l3}
                                  l1={a.l1}
                                  decimals={k.kind === "eff" ? 3 : k.kind === "pct" ? 3 : 2}
                                  isPct={k.kind === "pct"}
                                />
                              </div>
                              <div className="col-span-12 md:col-span-6">
                                <MiniTriplet
                                  label={`${k.label} (Home)`}
                                  v2025={h.v2025}
                                  l3={h.l3}
                                  l1={h.l1}
                                  decimals={k.kind === "eff" ? 3 : k.kind === "pct" ? 3 : 2}
                                  isPct={k.kind === "pct"}
                                />
                              </div>

                              {/* Optional: quick row compare values (one-line) */}
                              <div className="col-span-12">
                                <div className="rounded-lg border border-[#141414] bg-black/10 px-3 py-2">
                                  <StatRowLine
                                    label={`${k.label} (2025)`}
                                    a={a.v2025}
                                    h={h.v2025}
                                    fmt={fmtByKind(k.kind)}
                                  />
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Footer note */}
                <div className="mt-4 text-[10px] text-[#6f6f6f]">
                  Lookup keys used:{" "}
                  <span className="text-[#9a9a9a] font-semibold">{away.canonical}</span> &{" "}
                  <span className="text-[#9a9a9a] font-semibold">{home.canonical}</span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end md:items-center justify-center"
      role="dialog"
      aria-modal="true"
    >
      {/* backdrop */}
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-black/70"
        aria-label="Close modal"
      />
      {/* sheet */}
      <div className="relative w-full md:max-w-5xl mx-auto p-3 md:p-6">
        {modalBody}
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

  // modal state (selected event)
  const [modelEventId, setModelEventId] = useState<string | null>(null);

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

  /* 0b) team_ratings power_rank (canonical -> power_rank) */
  useEffect(() => {
    let mounted = true;

    async function loadPowerRanks() {
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

  /* 1) latest run */
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

      // de-dupe per (event, market, book, side) at latest timestamp ordering
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

  /* 4) bundle rows -> events */
  const events: EventBundle[] = useMemo(() => {
    const out: EventBundle[] = [];

    for (const r of results) {
      const homeCanonical = (r.home_team ?? "").trim();
      const awayCanonical = (r.away_team ?? "").trim();
      if (!homeCanonical || !awayCanonical) continue;

      const homeKey = normKey(homeCanonical);
      const awayKey = normKey(awayCanonical);

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
        canonical: awayCanonical,
        teamName: awayCanonical,
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
        canonical: homeCanonical,
        teamName: homeCanonical,
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

  const selectedEvent = useMemo(() => {
    if (!modelEventId) return null;
    return events.find((e) => e.eventId === modelEventId) ?? null;
  }, [modelEventId, events]);

  /* =========================================================
     Render
  ========================================================= */

  return (
    <div className="h-[calc(100vh-120px)] md:h-[calc(100vh-140px)] overflow-y-auto pr-1 space-y-4">
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
              One block per matchup. Shows projected score, win%, and probabilities with consensus lines.
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
                  <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-30 min-w-[380px]">
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
                    onOpenModel={() => setModelEventId(ev.eventId)}
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
                  <div className="text-white text-sm truncate">
                    {ev.away.teamAbbr} @ {ev.home.teamAbbr}
                  </div>
                  <div className="text-[11px] text-[#808080] mt-1">
                    {fmtDateCentral(ev.commenceTime)} · {fmtTimeCentral(ev.commenceTime)}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setModelEventId(ev.eventId)}
                    className="px-3 py-2 rounded-lg bg-[#0b0b0b] border border-[#2a2a2a] text-[11px] font-extrabold text-[#d0d0d0] hover:bg-[#141414]"
                  >
                    Model
                  </button>

                  <button
                    type="button"
                    onClick={() => setOpenMap((p) => ({ ...p, [ev.eventId]: !p[ev.eventId] }))}
                    className="px-3 py-2 rounded-lg bg-[#111] border border-[#2a2a2a] text-[11px] font-extrabold text-[#d0d0d0] hover:bg-[#141414]"
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

      {/* MODEL MODAL */}
      <ModelModal
        open={!!selectedEvent}
        onClose={() => setModelEventId(null)}
        sportKey={sportKey}
        away={selectedEvent?.away ?? ({} as any)}
        home={selectedEvent?.home ?? ({} as any)}
      />
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
        <div className="text-white truncate font-semibold flex items-center" title={row.teamName}>
          <span className="truncate">{row.teamName}</span>
          <RankBadge rank={row.powerRank} />
          {/* Model button by team name (opens side-by-side stats for the whole game) */}
          <SmallButton onClick={onOpenModel} title="Open model view">
            Model
          </SmallButton>
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
        <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10 min-w-[380px]">
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
      </tr>

      {/* Home row */}
      <tr className="transition-colors hover:bg-white/[0.02]">
        <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10 min-w-[380px]">
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

      {/* Divider */}
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

export default MonteCarloScreen;

