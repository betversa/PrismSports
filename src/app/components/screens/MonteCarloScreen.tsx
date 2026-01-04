// src/app/components/screens/MonteCarloScreen.tsx
// FULL REWRITE — adds polished side-by-side STATS panel using public.ncaab_stats (canonical -> stats)
// -----------------------------------------------------------------------------------------------------
// ✅ Keeps your current MonteCarloScreen visual parity (hero gradient + badge + chips + dark sticky table)
// ✅ Desktop: 2 rows per event + subtle divider between games
// ✅ Mobile: cards + Details collapsible (unchanged pattern)
// ✅ Logos + abbreviations via team_map (canonical, "Logo URL", Abbreviation)
// ✅ Power Rank via team_ratings (canonical -> power_rank), shown next to team name (in list + cards)
// ✅ Consensus via odds_snapshot median across books, latest ts per event
// ✅ Removes Event ID display — shows Date + Time only
//
// ✅ NEW (your ask): "STATS" panel (side-by-side) built from public.ncaab_stats
//    - Desktop: STATS button shows an inline panel row (below the matchup block)
//    - Mobile: STATS button expands a panel inside the card
//    - The panel is schema-tolerant: selects * and displays rows only when columns exist
//    - Rows are grouped into sections (Efficiency / Shooting / Four Factors / Rebounding / Pace)
//    - Highlights the better side per stat (green tint) with direction-aware logic (higher-better vs lower-better)
//
// Notes:
// - Assumes ncaab_stats has at least a `canonical` column matching team_map/team_ratings canonical naming.
// - If ncaab_stats also has season/date fields, this still works (we just take the first row per canonical).

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

type NcaabStatsRow = Record<string, any> & {
  canonical?: string;
  updated_at?: string | null;
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

  // NEW: ncaab_stats row (schema-tolerant)
  stats: NcaabStatsRow | null;
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
   ncaab_stats schema-tolerant helpers
========================================================= */

type StatKind = "number" | "percent" | "signed" | "pace" | "rank";
type BetterDirection = "higher" | "lower";

type StatDef = {
  label: string;
  keys: string[]; // try in order
  kind: StatKind;
  better: BetterDirection;
  digits?: number;
  hint?: string;
};

function firstFiniteFromKeys(obj: any, keys: string[]): number | null {
  for (const k of keys) {
    const v = Number(obj?.[k]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

function fmtStat(v: number | null, kind: StatKind, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (kind === "percent") return `${(v * 100).toFixed(1)}%`; // assumes 0-1 for percent fields; if your table stores 0-100, swap to v.toFixed(1)
  if (kind === "signed") {
    const x = Math.round(v * 10) / 10;
    return `${x > 0 ? "+" : ""}${x.toFixed(1)}`;
  }
  if (kind === "pace") return (Math.round(v * 10) / 10).toFixed(1);
  if (kind === "rank") return Math.round(v).toString();
  return (Math.round(v * Math.pow(10, digits)) / Math.pow(10, digits)).toFixed(digits);
}

function compareBetter(a: number | null, b: number | null, better: BetterDirection) {
  if (a == null || !Number.isFinite(a) || b == null || !Number.isFinite(b)) return { aBetter: false, bBetter: false };
  if (a === b) return { aBetter: false, bBetter: false };
  if (better === "higher") return { aBetter: a > b, bBetter: b > a };
  return { aBetter: a < b, bBetter: b < a };
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

function MiniButton({
  label,
  onClick,
  active,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "shrink-0 px-3 py-2 rounded-lg border text-[11px] font-extrabold tracking-wide",
        active
          ? "bg-[#141414] border-[#3a3a3a] text-white"
          : "bg-[#0b0b0b] border-[#2a2a2a] text-[#d0d0d0] hover:bg-[#141414]",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

/* =========================================================
   Mobile "Details" block (kept)
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
   NEW: STATS panel (side-by-side, from ncaab_stats)
========================================================= */

const STATS_SECTIONS: { title: string; rows: StatDef[] }[] = [
  {
    title: "Efficiency",
    rows: [
      {
        label: "Adj Off (per 100)",
        keys: ["adj_off", "adj_o", "adj_offense", "off_eff", "offense_eff", "engine_adj_off"],
        kind: "number",
        better: "higher",
      },
      {
        label: "Adj Def (per 100)",
        keys: ["adj_def", "adj_d", "adj_defense", "def_eff", "defense_eff", "engine_adj_def"],
        kind: "number",
        better: "lower",
      },
      {
        label: "Net Rating",
        keys: ["net_rating", "adj_net", "net_eff", "engine_net", "net"],
        kind: "signed",
        better: "higher",
      },
      {
        label: "Power",
        keys: ["engine_power", "power", "power_rating", "team_power"],
        kind: "number",
        better: "higher",
        digits: 2,
      },
      {
        label: "Power Rank",
        keys: ["power_rank", "rank", "rating_rank"],
        kind: "rank",
        better: "lower",
      },
    ],
  },
  {
    title: "Pace",
    rows: [
      {
        label: "Tempo",
        keys: ["tempo", "adj_tempo", "pace", "poss_per_game", "possessions_per_game"],
        kind: "pace",
        better: "higher",
      },
    ],
  },
  {
    title: "Four Factors",
    rows: [
      {
        label: "eFG%",
        keys: ["efg", "efg_pct", "efg_percent", "off_efg", "off_efg_pct"],
        kind: "percent",
        better: "higher",
      },
      {
        label: "TOV%",
        keys: ["tov_pct", "to_pct", "tov", "turnover_pct", "off_tov_pct"],
        kind: "percent",
        better: "lower",
      },
      {
        label: "ORB%",
        keys: ["orb_pct", "off_reb_pct", "o_reb_pct", "off_orb_pct"],
        kind: "percent",
        better: "higher",
      },
      {
        label: "FTR",
        keys: ["ftr", "ft_rate", "free_throw_rate", "ft_fga"],
        kind: "number",
        better: "higher",
        digits: 3,
      },
    ],
  },
  {
    title: "Shooting",
    rows: [
      {
        label: "3P%",
        keys: ["tp_pct", "3p_pct", "three_pct", "three_pt_pct", "three_point_pct"],
        kind: "percent",
        better: "higher",
      },
      {
        label: "2P%",
        keys: ["twop_pct", "2p_pct", "two_pct", "two_pt_pct", "two_point_pct"],
        kind: "percent",
        better: "higher",
      },
      {
        label: "FT%",
        keys: ["ft_pct", "free_throw_pct"],
        kind: "percent",
        better: "higher",
      },
      {
        label: "3P Rate (3PA/FGA)",
        keys: ["tpar", "3par", "three_rate", "three_pa_rate", "threepa_fga"],
        kind: "number",
        better: "higher",
        digits: 3,
      },
    ],
  },
  {
    title: "Rebounding",
    rows: [
      {
        label: "TRB%",
        keys: ["trb_pct", "reb_pct", "total_reb_pct"],
        kind: "percent",
        better: "higher",
      },
      {
        label: "DRB%",
        keys: ["drb_pct", "def_reb_pct", "d_reb_pct"],
        kind: "percent",
        better: "higher",
      },
    ],
  },
];

function StatsPanel({ away, home }: { away: TeamRow; home: TeamRow }) {
  const awayStats = away.stats;
  const homeStats = home.stats;

  const header = (
    <div className="grid grid-cols-3 gap-3 items-center pb-2 border-b border-[#1a1a1a]">
      <div className="text-[10px] font-extrabold tracking-widest uppercase text-[#8a8a8a]">Team Stats</div>
      <div className="text-right text-[11px] text-white font-extrabold">{away.teamAbbr}</div>
      <div className="text-right text-[11px] text-white font-extrabold">{home.teamAbbr}</div>
    </div>
  );

  const Row = ({ def }: { def: StatDef }) => {
    const a = firstFiniteFromKeys(awayStats, def.keys);
    const h = firstFiniteFromKeys(homeStats, def.keys);

    // Special-case: if "percent" looks like 0-100 in your table, you can normalize here.
    const aNorm = def.kind === "percent" && a != null && a > 1.5 ? a / 100 : a;
    const hNorm = def.kind === "percent" && h != null && h > 1.5 ? h / 100 : h;

    const cmp = compareBetter(aNorm, hNorm, def.better);

    const aText = fmtStat(aNorm, def.kind, def.digits ?? 2);
    const hText = fmtStat(hNorm, def.kind, def.digits ?? 2);

    const baseCell = "text-right text-[12px] font-extrabold tabular-nums rounded-md px-2 py-1";
    const betterCell = "bg-emerald-500/10 text-emerald-200 border border-emerald-900/40";
    const worseCell = "bg-rose-500/10 text-rose-200 border border-rose-900/40";
    const neutralCell = "bg-white/[0.03] text-white border border-[#222]";

    return (
      <div className="grid grid-cols-3 gap-3 items-center py-2 border-b border-[#1a1a1a] last:border-b-0">
        <div className="min-w-0">
          <div className="text-[11px] text-[#b0b0b0] font-semibold">{def.label}</div>
          {def.hint ? <div className="text-[10px] text-[#606060]">{def.hint}</div> : null}
        </div>

        <div
          className={[
            baseCell,
            cmp.aBetter ? betterCell : cmp.bBetter ? worseCell : neutralCell,
          ].join(" ")}
        >
          {aText}
        </div>

        <div
          className={[
            baseCell,
            cmp.bBetter ? betterCell : cmp.aBetter ? worseCell : neutralCell,
          ].join(" ")}
        >
          {hText}
        </div>
      </div>
    );
  };

  // Only show sections that have at least one stat present on either side
  const visibleSections = STATS_SECTIONS.map((sec) => {
    const rows = sec.rows.filter((r) => {
      const a = firstFiniteFromKeys(awayStats, r.keys);
      const h = firstFiniteFromKeys(homeStats, r.keys);
      return Number.isFinite(a) || Number.isFinite(h);
    });
    return { ...sec, rows };
  }).filter((sec) => sec.rows.length > 0);

  const metaStamp =
    (awayStats?.updated_at || homeStats?.updated_at) ? (
      <div className="mt-2 text-[10px] text-[#606060]">
        Stats updated:{" "}
        <span className="text-[#8a8a8a] font-semibold tabular-nums">
          {formatTs((awayStats?.updated_at ?? homeStats?.updated_at) as any)}
        </span>
      </div>
    ) : null;

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#0b0b0b] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-extrabold text-white">NCAAB Stats</div>
        <div className="text-[11px] text-[#808080] font-semibold">
          {away.teamAbbr} vs {home.teamAbbr}
        </div>
      </div>

      <div className="mt-3">{header}</div>

      {!visibleSections.length ? (
        <div className="mt-4 text-[12px] text-[#808080]">
          No matching columns found in <span className="text-white font-semibold">ncaab_stats</span> for these teams.
        </div>
      ) : (
        <div className="mt-2 space-y-4">
          {visibleSections.map((sec) => (
            <div key={sec.title}>
              <div className="text-[10px] font-extrabold tracking-widest uppercase text-[#8a8a8a] mt-3">
                {sec.title}
              </div>
              <div className="mt-2 rounded-lg border border-[#1f1f1f] overflow-hidden">
                <div className="px-3 py-2 bg-white/[0.02] border-b border-[#1f1f1f] text-[10px] text-[#808080] font-extrabold tracking-widest uppercase">
                  {sec.title}
                </div>
                <div className="px-3 py-1">
                  {sec.rows.map((def) => (
                    <Row key={def.label} def={def} />
                  ))}
                </div>
              </div>
            </div>
          ))}
          {metaStamp}
        </div>
      )}
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

  const [statsMap, setStatsMap] = useState<Map<string, NcaabStatsRow>>(new Map());

  const [consensusMap, setConsensusMap] = useState<Map<string, Consensus>>(new Map());
  const [openDetailsMap, setOpenDetailsMap] = useState<Record<string, boolean>>({});
  const [openStatsMap, setOpenStatsMap] = useState<Record<string, boolean>>({});

  const [loadingRun, setLoadingRun] = useState(true);
  const [loadingResults, setLoadingResults] = useState(false);
  const [loadingConsensus, setLoadingConsensus] = useState(false);
  const [loadingStats, setLoadingStats] = useState(false);

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

  /* 1) latest run for sportKey */
  useEffect(() => {
    let mounted = true;

    async function loadRun() {
      setLoadingRun(true);
      setSettingsError(null);
      setRun(null);
      setResults([]);
      setConsensusMap(new Map());
      setStatsMap(new Map());

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

  /* 2b) load ncaab_stats only for teams in this slate */
  useEffect(() => {
    let mounted = true;

    async function loadStatsForSlate(teamCanonicals: string[]) {
      if (!teamCanonicals.length) {
        setStatsMap(new Map());
        return;
      }

      setLoadingStats(true);

      // schema-tolerant: select *
      const { data, error } = await supabase.from("ncaab_stats").select("*").in("canonical", teamCanonicals);

      if (!mounted) return;

      if (error) {
        console.warn("[MonteCarloScreen] ncaab_stats error:", error.message);
        setStatsMap(new Map());
        setLoadingStats(false);
        return;
      }

      // If multiple rows per team exist, keep the one with latest updated_at if present; else first.
      const pickBest = (a: any, b: any) => {
        const ta = a?.updated_at ? new Date(a.updated_at).getTime() : -Infinity;
        const tb = b?.updated_at ? new Date(b.updated_at).getTime() : -Infinity;
        if (Number.isFinite(tb) && Number.isFinite(ta)) return tb > ta ? b : a;
        if (Number.isFinite(tb) && !Number.isFinite(ta)) return b;
        return a;
      };

      const m = new Map<string, NcaabStatsRow>();
      for (const r of (data ?? []) as NcaabStatsRow[]) {
        const k = normKey(r?.canonical ?? "");
        if (!k) continue;
        const prev = m.get(k);
        m.set(k, prev ? (pickBest(prev, r) as any) : r);
      }

      setStatsMap(m);
      setLoadingStats(false);
    }

    const canonicals = Array.from(
      new Set(
        results
          .flatMap((r) => [r.home_team, r.away_team])
          .map((x) => (x ?? "").trim())
          .filter(Boolean)
      )
    );

    // Only load stats for NCAAB
    if (sportKey !== "basketball_ncaab") {
      setStatsMap(new Map());
      return;
    }

    loadStatsForSlate(canonicals);

    return () => {
      mounted = false;
    };
  }, [results, sportKey]);

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
            if (Number.isFinite(line)) spreadHomeLines.set(eventId, [...(spreadHomeLines.get(eventId) ?? []), line]);
            if (Number.isFinite(odds)) spreadHomeOdds.set(eventId, [...(spreadHomeOdds.get(eventId) ?? []), odds]);
          }
          if (side === "away") {
            if (Number.isFinite(odds)) spreadAwayOdds.set(eventId, [...(spreadAwayOdds.get(eventId) ?? []), odds]);
          }
        }

        if (market === "totals") {
          if (side === "over") {
            if (Number.isFinite(line)) totalLines.set(eventId, [...(totalLines.get(eventId) ?? []), line]);
            if (Number.isFinite(odds)) totalOverOdds.set(eventId, [...(totalOverOdds.get(eventId) ?? []), odds]);
          }
          if (side === "under") {
            if (Number.isFinite(odds)) totalUnderOdds.set(eventId, [...(totalUnderOdds.get(eventId) ?? []), odds]);
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

        stats: statsMap.get(awayKey) ?? null,
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

        stats: statsMap.get(homeKey) ?? null,
      };

      out.push({
        eventId: r.event_id,
        commenceTime: r.commence_time ?? null,
        away: awayRow,
        home: homeRow,
      });
    }

    return out;
  }, [results, abbrMap, logoMap, consensusMap, powerRankMap, statsMap]);

  /* keep open states aligned */
  useEffect(() => {
    setOpenDetailsMap((prev) => {
      const next: Record<string, boolean> = {};
      for (const ev of events) next[ev.eventId] = prev[ev.eventId] ?? false;
      return next;
    });
    setOpenStatsMap((prev) => {
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

  /* =========================================================
     Render
  ========================================================= */

  return (
    <div className="h-[calc(100vh-120px)] md:h-[calc(100vh-140px)] overflow-y-auto pr-1 space-y-4">
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
              One block per matchup. Use <span className="text-white font-semibold">STATS</span> for side-by-side NCAAB
              team metrics from <span className="text-white font-semibold">ncaab_stats</span>.
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <Pill label="Sport" value={String(sportKey).toUpperCase()} />
              <Pill label="Games" value={loading ? "…" : String(events.length)} />
              <Pill label="Latest Run" value={run?.created_at ? formatTs(run.created_at) : "—"} />
              <Pill label="Consensus" value={loadingConsensus ? "…" : consensusStamp ?? "—"} />
              {sportKey === "basketball_ncaab" ? (
                <Pill label="Stats" value={loadingStats ? "…" : statsMap.size ? "Loaded" : "—"} />
              ) : null}
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
                    statsOpen={!!openStatsMap[ev.eventId]}
                    onToggleStats={() =>
                      setOpenStatsMap((p) => ({ ...p, [ev.eventId]: !(p?.[ev.eventId] ?? false) }))
                    }
                    showStatsButton={sportKey === "basketball_ncaab"}
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
          const detailsOpen = !!openDetailsMap[ev.eventId];
          const statsOpen = !!openStatsMap[ev.eventId];

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

                <div className="flex items-center gap-2">
                  <MiniButton
                    label={detailsOpen ? "Hide" : "Details"}
                    active={detailsOpen}
                    onClick={() => setOpenDetailsMap((p) => ({ ...p, [ev.eventId]: !detailsOpen }))}
                  />
                  {sportKey === "basketball_ncaab" ? (
                    <MiniButton
                      label="Stats"
                      active={statsOpen}
                      onClick={() => setOpenStatsMap((p) => ({ ...p, [ev.eventId]: !statsOpen }))}
                    />
                  ) : null}
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

              {detailsOpen ? (
                <div className="mt-3">
                  <MobileDetailsBlock away={ev.away} home={ev.home} />
                </div>
              ) : null}

              {statsOpen && sportKey === "basketball_ncaab" ? (
                <div className="mt-3">
                  <StatsPanel away={ev.away} home={ev.home} />
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
   Desktop rows (2 rows per event + optional Stats panel row)
========================================================= */

function DesktopEventRows({
  ev,
  showDivider,
  statsOpen,
  onToggleStats,
  showStatsButton,
}: {
  ev: EventBundle;
  showDivider: boolean;
  statsOpen: boolean;
  onToggleStats: () => void;
  showStatsButton: boolean;
}) {
  const away = ev.away;
  const home = ev.home;

  const matchupLine = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-white truncate">
          {away.teamName} vs {home.teamName}
          <span className="text-[#404040]"> · </span>
          <span className="text-[#b0b0b0]">{fmtDateCentral(ev.commenceTime)}</span>
          <span className="text-[#404040]"> </span>
          <span className="text-[#b0b0b0]">{fmtTimeCentral(ev.commenceTime)}</span>
        </div>
      </div>

      {showStatsButton ? <MiniButton label="STATS" active={statsOpen} onClick={onToggleStats} /> : null}
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

      {/* STATS panel row (desktop) */}
      {showStatsButton && statsOpen ? (
        <tr>
          <td colSpan={7} className="p-3 bg-[#0a0a0a] border-t border-[#141414]">
            <StatsPanel away={away} home={home} />
          </td>
        </tr>
      ) : null}

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

/* ✅ Default export optional (matches your ModelScreen pattern) */
export default MonteCarloScreen;

