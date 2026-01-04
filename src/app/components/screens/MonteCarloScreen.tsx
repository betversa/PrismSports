// src/app/components/screens/MonteCarloScreen.tsx — FULL REWRITE (Model modal + ncaab_stats side-by-side)
// -----------------------------------------------------------------------------------------------------
// ✅ Visual layout matches ModelScreen (hero gradient + badge + chips + dark sticky table)
// ✅ Mobile: cards + Details collapsible + NEW "Model" button
// ✅ Desktop: inline columns + NEW "Model" column (rowSpan per game)
// ✅ Logos + abbreviations via team_map (canonical, "Logo URL", Abbreviation)
// ✅ Power Rank via team_ratings (canonical -> power_rank), shown next to team name
// ✅ Consensus via odds_snapshot (spreads/totals) median across books, latest ts per event
// ✅ Removes redundant Event ID display — only shows Date + Time for each matchup
// ✅ NEW: Polished Model modal showing side-by-side ncaab_stats rows (away vs home)
//    - Uses the "proper rows" you uploaded by selecting * and mapping common aliases safely
//    - If your ncaab_stats has sport_key, it filters by it; if not, it gracefully falls back

import React, { useEffect, useMemo, useRef, useState } from "react";
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
};

type EventBundle = {
  eventId: string;
  commenceTime: string | null;
  away: TeamRow;
  home: TeamRow;
};

type NcaabStatsRow = Record<string, any> & {
  canonical?: string | null;
  sport_key?: string | null;
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

function pct100(x: any, digits = 1) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  // If data already stored as % (e.g., 52.3), show as 52.3%
  // If data stored as fraction (e.g., 0.523), show as 52.3%
  const asPct = v > 1.5 ? v : v * 100;
  return `${asPct.toFixed(digits)}%`;
}

function num1(x: any) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  return (Math.round(v * 10) / 10).toFixed(1);
}

function num2(x: any) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  return (Math.round(v * 100) / 100).toFixed(2);
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

function PrimaryBtn({
  children,
  onClick,
  className = "",
}: {
  children: React.ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex items-center justify-center rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-2 text-[11px] font-extrabold text-white hover:bg-[#141414] active:scale-[0.99]",
        className,
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
   MODEL MODAL (ncaab_stats side-by-side)
========================================================= */

function pickFirst(row: any, keys: string[]) {
  if (!row) return null;
  for (const k of keys) {
    if (row[k] != null && row[k] !== "") return row[k];
  }
  return null;
}

function metric(row: any, keys: string[]) {
  const v = pickFirst(row, keys);
  return v;
}

function StatRow({
  label,
  away,
  home,
  fmt,
}: {
  label: string;
  away: any;
  home: any;
  fmt?: (x: any) => string;
}) {
  const f = fmt ?? ((x: any) => (x == null || x === "" ? "—" : String(x)));
  return (
    <div className="grid grid-cols-3 gap-3 items-center py-2 border-b border-[#141414] last:border-b-0">
      <div className="text-[11px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">{label}</div>
      <div className="text-[12px] text-white font-bold tabular-nums text-right">{f(away)}</div>
      <div className="text-[12px] text-white font-bold tabular-nums text-right">{f(home)}</div>
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
  const [awayStats, setAwayStats] = useState<NcaabStatsRow | null>(null);
  const [homeStats, setHomeStats] = useState<NcaabStatsRow | null>(null);

  // prevent body scroll behind modal (nice polish)
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

    async function load() {
      if (!open || !ev) return;

      setLoading(true);
      setErr(null);
      setAwayStats(null);
      setHomeStats(null);

      const awayCanonical = ev.away.teamName;
      const homeCanonical = ev.home.teamName;

      // Try with sport_key filter first (recommended)
      let data: any[] | null = null;
      let errorMsg: string | null = null;

      const q1 = await supabase
        .from("ncaab_stats")
        .select("*")
        .eq("sport_key", sportKey)
        .in("canonical", [awayCanonical, homeCanonical])
        .limit(2);

      if (!q1.error) {
        data = q1.data ?? [];
      } else {
        // Fallback if ncaab_stats doesn't have sport_key
        const q2 = await supabase
          .from("ncaab_stats")
          .select("*")
          .in("canonical", [awayCanonical, homeCanonical])
          .limit(2);

        if (q2.error) errorMsg = q2.error.message;
        data = q2.data ?? [];
      }

      if (!mounted) return;

      if (errorMsg) {
        setErr(errorMsg);
        setLoading(false);
        return;
      }

      const rows = data ?? [];
      const a = rows.find((r: any) => normKey(r.canonical) === normKey(awayCanonical)) ?? null;
      const h = rows.find((r: any) => normKey(r.canonical) === normKey(homeCanonical)) ?? null;

      setAwayStats(a);
      setHomeStats(h);
      setLoading(false);
    }

    load();
    return () => {
      mounted = false;
    };
  }, [open, ev?.eventId, sportKey]);

  if (!open) return null;

  const title = ev ? `${ev.away.teamAbbr} @ ${ev.home.teamAbbr}` : "Model";
  const subtitle = ev ? `${fmtDateCentral(ev.commenceTime)} · ${fmtTimeCentral(ev.commenceTime)}` : "";

  // Common alias mapping so your “proper rows” still work even if column names differ slightly.
  // If a key exists, it will be used; otherwise the next alias is tried.
  const A = awayStats;
  const H = homeStats;

  const away_engine_power = metric(A, ["engine_power", "power", "power_rating", "enginePower"]);
  const home_engine_power = metric(H, ["engine_power", "power", "power_rating", "enginePower"]);

  const away_adj_off = metric(A, ["adj_off", "off_eff", "offeff", "off_eff_adj", "adj_offense"]);
  const home_adj_off = metric(H, ["adj_off", "off_eff", "offeff", "off_eff_adj", "adj_offense"]);

  const away_adj_def = metric(A, ["adj_def", "def_eff", "defeff", "def_eff_adj", "adj_defense"]);
  const home_adj_def = metric(H, ["adj_def", "def_eff", "defeff", "def_eff_adj", "adj_defense"]);

  const away_tempo = metric(A, ["tempo", "pace", "adj_tempo", "adj_pace"]);
  const home_tempo = metric(H, ["tempo", "pace", "adj_tempo", "adj_pace"]);

  // extra common “picture” stats — will show — if not present
  const away_efg = metric(A, ["efg", "efg_pct", "eFG%", "efg_percent"]);
  const home_efg = metric(H, ["efg", "efg_pct", "eFG%", "efg_percent"]);

  const away_tov = metric(A, ["tov", "tov_pct", "to_pct", "turnover_pct"]);
  const home_tov = metric(H, ["tov", "tov_pct", "to_pct", "turnover_pct"]);

  const away_orb = metric(A, ["orb", "orb_pct", "or_pct", "off_reb_pct"]);
  const home_orb = metric(H, ["orb", "orb_pct", "or_pct", "off_reb_pct"]);

  const away_ftr = metric(A, ["ftr", "ft_rate", "fta_rate", "free_throw_rate"]);
  const home_ftr = metric(H, ["ftr", "ft_rate", "fta_rate", "free_throw_rate"]);

  // If you added more in ncaab_stats (you mentioned “a little more”), these will auto-fill if present:
  const away_3p = metric(A, ["three_pt_pct", "3p_pct", "tp_pct", "fg3_pct"]);
  const home_3p = metric(H, ["three_pt_pct", "3p_pct", "tp_pct", "fg3_pct"]);

  const away_2p = metric(A, ["two_pt_pct", "2p_pct", "fg2_pct"]);
  const home_2p = metric(H, ["two_pt_pct", "2p_pct", "fg2_pct"]);

  const away_ft = metric(A, ["ft_pct", "ftp", "free_throw_pct"]);
  const home_ft = metric(H, ["ft_pct", "ftp", "free_throw_pct"]);

  const away_reb = metric(A, ["reb_rate", "reb_pct", "trb_pct", "rebound_pct"]);
  const home_reb = metric(H, ["reb_rate", "reb_pct", "trb_pct", "rebound_pct"]);

  return (
    <div className="fixed inset-0 z-[999]">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close model modal"
        onClick={onClose}
        className="absolute inset-0 bg-black/70"
      />

      {/* Panel */}
      <div className="absolute left-1/2 top-1/2 w-[min(980px,92vw)] -translate-x-1/2 -translate-y-1/2">
        <div className="relative overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f]">
          {/* subtle Prism glow */}
          <div
            className="pointer-events-none absolute inset-0 opacity-95"
            style={{
              background:
                "radial-gradient(900px 260px at 18% 0%, rgba(212,175,55,0.18), transparent 62%), radial-gradient(700px 240px at 85% 12%, rgba(255,255,255,0.05), transparent 60%)",
            }}
          />

          {/* Header */}
          <div className="relative flex items-start justify-between gap-3 px-5 py-4 border-b border-[#141414]">
            <div className="min-w-0">
              <div className="text-white text-sm font-extrabold truncate">{title}</div>
              <div className="text-[11px] text-[#a8a8a8] mt-1">{subtitle}</div>
            </div>

            <PrimaryBtn onClick={onClose} className="shrink-0">
              Done
            </PrimaryBtn>
          </div>

          {/* Body */}
          <div className="relative px-5 py-4 max-h-[72vh] overflow-y-auto">
            {loading ? (
              <div className="text-xs text-[#a8a8a8] py-10 text-center">Loading model stats…</div>
            ) : err ? (
              <div className="text-xs text-red-400 py-10 text-center">{err}</div>
            ) : !ev ? (
              <div className="text-xs text-[#a8a8a8] py-10 text-center">No game selected.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* side-by-side stats */}
                <div className="rounded-xl border border-[#2a2a2a] bg-black/10 overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#141414]">
                    <div className="grid grid-cols-3 gap-3 items-center">
                      <div className="text-[11px] text-[#808080] font-extrabold uppercase tracking-wide">
                        Team Stats
                      </div>
                      <div className="text-[11px] text-white font-extrabold text-right">{ev.away.teamAbbr}</div>
                      <div className="text-[11px] text-white font-extrabold text-right">{ev.home.teamAbbr}</div>
                    </div>
                  </div>

                  <div className="px-4 py-2">
                    <StatRow label="Engine Power" away={away_engine_power} home={home_engine_power} fmt={num2} />
                    <StatRow label="Adj Off" away={away_adj_off} home={home_adj_off} fmt={num1} />
                    <StatRow label="Adj Def" away={away_adj_def} home={home_adj_def} fmt={num1} />
                    <StatRow label="Tempo" away={away_tempo} home={home_tempo} fmt={num1} />

                    <div className="h-2" />

                    <StatRow label="eFG%" away={away_efg} home={home_efg} fmt={pct100} />
                    <StatRow label="TO%" away={away_tov} home={home_tov} fmt={pct100} />
                    <StatRow label="OR%" away={away_orb} home={home_orb} fmt={pct100} />
                    <StatRow label="FT Rate" away={away_ftr} home={home_ftr} fmt={num2} />

                    <div className="h-2" />

                    <StatRow label="3P%" away={away_3p} home={home_3p} fmt={pct100} />
                    <StatRow label="2P%" away={away_2p} home={home_2p} fmt={pct100} />
                    <StatRow label="FT%" away={away_ft} home={home_ft} fmt={pct100} />
                    <StatRow label="REB%" away={away_reb} home={home_reb} fmt={pct100} />
                  </div>

                  <div className="px-4 py-3 border-t border-[#141414] text-[11px] text-[#a8a8a8]">
                    Pulls directly from <span className="text-white">ncaab_stats</span> (side-by-side).
                    Missing fields show as —.
                  </div>
                </div>

                {/* projection snapshot */}
                <div className="rounded-xl border border-[#2a2a2a] bg-black/10 overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#141414] text-[11px] text-white font-extrabold">
                    Projection Snapshot
                  </div>

                  <div className="px-4 py-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] p-3">
                        <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">
                          Proj Score
                        </div>
                        <div className="mt-1 text-white font-extrabold tabular-nums text-[14px]">
                          {ev.away.projPoints.toFixed(1)} - {ev.home.projPoints.toFixed(1)}
                        </div>
                      </div>

                      <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] p-3">
                        <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">Win%</div>
                        <div className="mt-1 text-white font-extrabold tabular-nums text-[14px]">
                          {pct01(ev.away.winProbTeam)} / {pct01(ev.home.winProbTeam)}
                        </div>
                      </div>

                      <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] p-3">
                        <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">
                          Proj Margin (Home)
                        </div>
                        <div className="mt-1 text-white font-extrabold tabular-nums text-[14px]">
                          {fmtSigned1(ev.home.projMarginTeam)}
                        </div>
                        <div className="mt-1 text-[11px] text-[#a8a8a8]">
                          Cover probs: {pct01(ev.away.coverProbTeam)} / {pct01(ev.home.coverProbTeam)}
                        </div>
                      </div>

                      <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] p-3">
                        <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">
                          Proj Total
                        </div>
                        <div className="mt-1 text-white font-extrabold tabular-nums text-[14px]">
                          {fmtLinePlain(ev.home.projTotal)}
                        </div>
                        <div className="mt-1 text-[11px] text-[#a8a8a8]">
                          O/U probs: {pct01(ev.away.overProb)} / {pct01(ev.home.underProb)}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] p-3">
                      <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">
                        Consensus (Median)
                      </div>
                      <div className="mt-2 text-[12px] text-white font-bold tabular-nums">
                        Spread:{" "}
                        {ev.home.consSpreadLineTeam == null
                          ? "—"
                          : `${fmtSigned1(ev.home.consSpreadLineTeam)} (${american(ev.home.consSpreadOddsTeam)})`}{" "}
                        /{" "}
                        {ev.away.consSpreadLineTeam == null
                          ? "—"
                          : `${fmtSigned1(ev.away.consSpreadLineTeam)} (${american(ev.away.consSpreadOddsTeam)})`}
                      </div>
                      <div className="mt-1 text-[12px] text-white font-bold tabular-nums">
                        Total:{" "}
                        {ev.home.consTotalLine == null
                          ? "—"
                          : `o${fmtLinePlain(ev.home.consTotalLine)} (${american(ev.home.consTotalOverOdds)})`}{" "}
                        /{" "}
                        {ev.home.consTotalLine == null
                          ? "—"
                          : `u${fmtLinePlain(ev.home.consTotalLine)} (${american(ev.home.consTotalUnderOdds)})`}
                      </div>
                    </div>

                    <div className="mt-3 text-[11px] text-[#a8a8a8]">
                      Tip: if you want to show **more fields**, just add new <span className="text-white">StatRow</span>{" "}
                      lines above—this modal already handles missing columns gracefully.
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="relative px-5 py-4 border-t border-[#141414] flex items-center justify-end">
            <PrimaryBtn onClick={onClose}>Done</PrimaryBtn>
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

  // ✅ NEW: model modal state
  const [modelOpen, setModelOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<EventBundle | null>(null);

  function openModel(ev: EventBundle) {
    setSelectedEvent(ev);
    setModelOpen(true);
  }

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
        // fallback if no sport_key in table
        const fb = await supabase.from("team_ratings").select("canonical,power_rank").limit(5000);
        if (fb.error) {
          console.warn("[MonteCarloScreen] team_ratings error:", error.message);
          setPowerRankMap(new Map());
          return;
        }

        const pm = new Map<string, number>();
        for (const r of (fb.data ?? []) as any[]) {
          const k = normKey(r.canonical);
          const pr = r.power_rank == null ? null : Number(r.power_rank);
          if (!k) continue;
          if (pr != null && Number.isFinite(pr)) pm.set(k, pr);
        }
        setPowerRankMap(pm);
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

      // de-dupe per (event, market, book, side)
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
              One block per matchup. Projected score, win%, probabilities, consensus lines, and a Model modal with stats.
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
                    onModel={openModel}
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

                <div className="shrink-0 flex items-center gap-2">
                  <PrimaryBtn onClick={() => openModel(ev)}>Model</PrimaryBtn>

                  <button
                    type="button"
                    onClick={() => setOpenMap((p) => ({ ...p, [ev.eventId]: !p[ev.eventId] }))}
                    className="px-3 py-2 rounded-lg bg-[#111] border border-[#2a2a2a] text-[11px] text-[#d0d0d0] hover:bg-[#141414]"
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

      {/* ✅ Model modal (mounted once) */}
      <ModelModal open={modelOpen} onClose={() => setModelOpen(false)} sportKey={sportKey} ev={selectedEvent} />
    </div>
  );
};

/* =========================================================
   Desktop rows
========================================================= */

function DesktopEventRows({
  ev,
  showDivider,
  onModel,
}: {
  ev: EventBundle;
  showDivider: boolean;
  onModel: (ev: EventBundle) => void;
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

        {/* ✅ Model button spans both team rows */}
        <td className="p-3 text-center align-middle" rowSpan={2}>
          <PrimaryBtn onClick={() => onModel(ev)}>Model</PrimaryBtn>
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

      {/* Divider */}
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

/* ✅ Default export optional */
export default MonteCarloScreen;
