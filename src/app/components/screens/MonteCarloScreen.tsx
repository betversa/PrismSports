// src/app/components/screens/MonteCarloScreen.tsx — FULL REWRITE
// -----------------------------------------------------------------------------------------------------
// ✅ Visual layout matches ModelScreen (hero gradient + badge + chips + dark sticky table)
// ✅ Mobile: cards + Details collapsible
// ✅ Desktop: inline columns: Proj Score | Win% | Proj Margin | Proj Total | Cons Spread | Cons Total
// ✅ Logos + abbreviations via team_map (canonical, "Logo URL", Abbreviation)
// ✅ Power Rank via team_ratings (canonical -> power_rank), shown next to team name
// ✅ Consensus via odds_snapshot (spreads/totals) median across books, latest ts per event
// ✅ Removes redundant Event ID display — only shows Date + Time
// ✅ Adds subtle divider row between games on desktop
//
// ✅ NEW: “Model” buttons next to BOTH team names
// ✅ NEW: Modal shows side-by-side stats using CANONICAL team names:
//     - public.team_ratings (engine_power + more)
//     - public.ncaab_stats (uses the columns you provided; NO ha_2025)
//
// NOTE: ncaab_stats columns expected (from your CSV):
//   canonical, v_2025, last_3, last_1, home_raw, away_raw, v_2024, home_score, away_score

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
  sport_key?: string | null;
  updated_at?: string | null;
  season?: string | null;

  // core fields you care about
  engine_adj_off?: number | null;
  engine_adj_def?: number | null;
  engine_power?: number | null;
  true_hca?: number | null;
  fun_factor?: number | null;

  sigma_total_100?: number | null;
  sigma_margin_100?: number | null;

  avg_total_points?: number | null;
  avg_margin_points?: number | null;

  power_rank?: number | null;
  games_played?: number | null;

  pf_points?: number | null;
  pa_points?: number | null;
};

type NcaabStatsRow = {
  canonical: string;
  v_2025?: number | null;
  last_3?: number | null;
  last_1?: number | null;
  home_raw?: number | null;
  away_raw?: number | null;
  v_2024?: number | null;
  home_score?: number | null;
  away_score?: number | null;
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
  return (Math.round(x * 10) / 10).toFixed(1);
}

function fmt2(x: number | null) {
  if (x == null || !Number.isFinite(x)) return "—";
  return (Math.round(x * 100) / 100).toFixed(2);
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

function MiniButton({
  label,
  onClick,
  title,
}: {
  label: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="ml-2 inline-flex items-center rounded-md border border-[#2a2a2a] bg-[#0b0b0b] px-2 py-1 text-[10px] font-extrabold text-[#d0d0d0] hover:bg-[#141414]"
    >
      {label}
    </button>
  );
}

/* =========================================================
   Modal
========================================================= */

type ModelModalState = {
  open: boolean;
  awayCanonical: string | null;
  homeCanonical: string | null;
  awayAbbr: string | null;
  homeAbbr: string | null;
  commenceTime: string | null;
};

function StatCell({
  label,
  away,
  home,
  mono = true,
}: {
  label: string;
  away: React.ReactNode;
  home: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-3 gap-3 items-center py-2 border-b border-[#141414] last:border-b-0">
      <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">{label}</div>
      <div className={["text-[11px] text-white font-bold text-right", mono ? "tabular-nums" : ""].join(" ")}>
        {away}
      </div>
      <div className={["text-[11px] text-white font-bold text-right", mono ? "tabular-nums" : ""].join(" ")}>
        {home}
      </div>
    </div>
  );
}

function ModelModal({
  state,
  onClose,
  sportKey,
}: {
  state: ModelModalState;
  onClose: () => void;
  sportKey: SportKey;
}) {
  const [tab, setTab] = useState<"ratings" | "ncaab">("ratings");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [ratingsMap, setRatingsMap] = useState<Map<string, TeamRatingsRow>>(new Map());
  const [ncaabMap, setNcaabMap] = useState<Map<string, NcaabStatsRow>>(new Map());

  const isNcaab = String(sportKey) === "basketball_ncaab";
  const awayKey = normKey(state.awayCanonical ?? "");
  const homeKey = normKey(state.homeCanonical ?? "");

  useEffect(() => {
    if (!state.open) return;
    setTab(isNcaab ? "ncaab" : "ratings");
  }, [state.open, isNcaab]);

  useEffect(() => {
    if (!state.open) return;
    const a = (state.awayCanonical ?? "").trim();
    const h = (state.homeCanonical ?? "").trim();
    if (!a || !h) return;

    let mounted = true;

    async function load() {
      setLoading(true);
      setErr(null);
      setRatingsMap(new Map());
      setNcaabMap(new Map());

      try {
        // --- TEAM RATINGS (prefer sport_key filtered; keep latest row per canonical)
        const ratingsCols = [
          "canonical",
          "sport_key",
          "updated_at",
          "season",
          "engine_adj_off",
          "engine_adj_def",
          "engine_power",
          "true_hca",
          "fun_factor",
          "sigma_total_100",
          "sigma_margin_100",
          "avg_total_points",
          "avg_margin_points",
          "power_rank",
          "pf_points",
          "pa_points",
          "games_played",
        ].join(",");

        const { data: rData, error: rErr } = await supabase
          .from("team_ratings")
          .select(ratingsCols)
          .in("canonical", [a, h])
          .eq("sport_key", sportKey as any)
          .order("updated_at", { ascending: false })
          .limit(20);

        if (!mounted) return;
        if (rErr) {
          // If your team_ratings table *doesn’t* have sport_key, remove the eq above.
          throw new Error(`Failed to load team_ratings: ${rErr.message}`);
        }

        const rMap = new Map<string, TeamRatingsRow>();
        for (const row of (rData ?? []) as TeamRatingsRow[]) {
          const k = normKey(row.canonical);
          if (!k) continue;
          if (!rMap.has(k)) rMap.set(k, row); // keep first (latest)
        }

        // --- NCAAB STATS (only if sport is ncaab)
        if (isNcaab) {
          const ncaabCols = [
            "canonical",
            "v_2025",
            "last_3",
            "last_1",
            "home_raw",
            "away_raw",
            "v_2024",
            "home_score",
            "away_score",
          ].join(",");

          const { data: nData, error: nErr } = await supabase
            .from("ncaab_stats")
            .select(ncaabCols)
            .in("canonical", [a, h])
            .limit(10);

          if (!mounted) return;
          if (nErr) {
            throw new Error(`Failed to load ncaab_stats: ${nErr.message}`);
          }

          const nMap = new Map<string, NcaabStatsRow>();
          for (const row of (nData ?? []) as NcaabStatsRow[]) {
            const k = normKey(row.canonical);
            if (!k) continue;
            if (!nMap.has(k)) nMap.set(k, row);
          }
          setNcaabMap(nMap);
        }

        setRatingsMap(rMap);
      } catch (e: any) {
        setErr(e?.message ?? "Failed to load model data.");
      } finally {
        setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [state.open, state.awayCanonical, state.homeCanonical, sportKey, isNcaab]);

  const awayRatings = ratingsMap.get(awayKey) ?? null;
  const homeRatings = ratingsMap.get(homeKey) ?? null;

  const awayN = ncaabMap.get(awayKey) ?? null;
  const homeN = ncaabMap.get(homeKey) ?? null;

  if (!state.open) return null;

  return (
    <div className="fixed inset-0 z-[80]">
      {/* backdrop */}
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-black/70"
        aria-label="Close modal backdrop"
      />

      {/* sheet */}
      <div className="absolute inset-x-0 bottom-0 md:inset-0 md:flex md:items-center md:justify-center p-2 md:p-6">
        <div className="w-full md:max-w-4xl rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden shadow-2xl">
          {/* header */}
          <div
            className="relative px-4 md:px-5 py-4 border-b border-[#141414]"
            style={{
              background:
                "radial-gradient(900px 260px at 18% 0%, rgba(212,175,55,0.18), transparent 62%), radial-gradient(700px 240px at 85% 12%, rgba(255,255,255,0.05), transparent 60%)",
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-1 text-[11px] text-[#b0b0b0]">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#d4af37" }} />
                  Model View
                </div>
                <div className="text-white mt-2 font-extrabold text-[14px] md:text-[16px] truncate">
                  {state.awayCanonical ?? "—"} vs {state.homeCanonical ?? "—"}
                </div>
                <div className="text-[11px] text-[#a8a8a8] mt-1">
                  {fmtDateCentral(state.commenceTime)} · {fmtTimeCentral(state.commenceTime)}
                </div>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="shrink-0 px-3 py-2 rounded-lg bg-[#111] border border-[#2a2a2a] text-[11px] font-extrabold text-[#d0d0d0] hover:bg-[#141414]"
              >
                Done
              </button>
            </div>

            {/* tabs */}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setTab("ratings")}
                className={[
                  "px-3 py-2 rounded-lg border text-[11px] font-extrabold",
                  tab === "ratings"
                    ? "bg-[#0b0b0b] border-[#2a2a2a] text-white"
                    : "bg-transparent border-[#1f1f1f] text-[#bdbdbd] hover:bg-white/[0.03]",
                ].join(" ")}
              >
                Team Ratings
              </button>

              {isNcaab ? (
                <button
                  type="button"
                  onClick={() => setTab("ncaab")}
                  className={[
                    "px-3 py-2 rounded-lg border text-[11px] font-extrabold",
                    tab === "ncaab"
                      ? "bg-[#0b0b0b] border-[#2a2a2a] text-white"
                      : "bg-transparent border-[#1f1f1f] text-[#bdbdbd] hover:bg-white/[0.03]",
                  ].join(" ")}
                >
                  NCAAB Stats
                </button>
              ) : null}
            </div>
          </div>

          {/* body */}
          <div className="px-4 md:px-5 py-4 max-h-[70vh] overflow-y-auto">
            {loading ? (
              <div className="text-xs text-[#808080] px-3 py-10 text-center border border-[#2a2a2a] rounded-xl bg-[#0b0b0b]">
                Loading model…
              </div>
            ) : err ? (
              <div className="text-xs text-red-400 px-3 py-4 border border-red-900/50 rounded-xl bg-[#0b0b0b]">
                {err}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* left: away */}
                <div className="rounded-xl border border-[#2a2a2a] bg-black/10 overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#141414]">
                    <div className="text-[12px] font-extrabold text-white">
                      {state.awayCanonical ?? "Away"}
                      {state.awayAbbr ? <span className="text-[#808080]"> · {state.awayAbbr}</span> : null}
                    </div>
                    <div className="text-[10px] text-[#7a7a7a] font-semibold">AWAY</div>
                  </div>

                  <div className="px-4">
                    {tab === "ratings" ? (
                      <>
                        <StatCell label="Power Rank" away={fmt1(awayRatings?.power_rank ?? null)} home={"—"} />
                        <StatCell label="Engine Power" away={fmt2(awayRatings?.engine_power ?? null)} home={"—"} />
                        <StatCell label="Adj Off" away={fmt2(awayRatings?.engine_adj_off ?? null)} home={"—"} />
                        <StatCell label="Adj Def" away={fmt2(awayRatings?.engine_adj_def ?? null)} home={"—"} />
                        <StatCell label="True HCA" away={fmt2(awayRatings?.true_hca ?? null)} home={"—"} />
                        <StatCell label="Fun Factor" away={fmt2(awayRatings?.fun_factor ?? null)} home={"—"} />
                        <StatCell label="σ Total/100" away={fmt2(awayRatings?.sigma_total_100 ?? null)} home={"—"} />
                        <StatCell label="σ Margin/100" away={fmt2(awayRatings?.sigma_margin_100 ?? null)} home={"—"} />
                        <StatCell label="Avg Total" away={fmt2(awayRatings?.avg_total_points ?? null)} home={"—"} />
                        <StatCell label="Avg Margin" away={fmt2(awayRatings?.avg_margin_points ?? null)} home={"—"} />
                      </>
                    ) : (
                      <>
                        <StatCell label="v_2025" away={fmt2(awayN?.v_2025 ?? null)} home={"—"} />
                        <StatCell label="last_3" away={fmt2(awayN?.last_3 ?? null)} home={"—"} />
                        <StatCell label="last_1" away={fmt2(awayN?.last_1 ?? null)} home={"—"} />
                        <StatCell label="away_raw" away={fmt2(awayN?.away_raw ?? null)} home={"—"} />
                        <StatCell label="home_raw" away={fmt2(awayN?.home_raw ?? null)} home={"—"} />
                        <StatCell label="v_2024" away={fmt2(awayN?.v_2024 ?? null)} home={"—"} />
                        <StatCell label="away_score" away={fmt2(awayN?.away_score ?? null)} home={"—"} />
                        <StatCell label="home_score" away={fmt2(awayN?.home_score ?? null)} home={"—"} />
                      </>
                    )}
                  </div>
                </div>

                {/* right: home */}
                <div className="rounded-xl border border-[#2a2a2a] bg-black/10 overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#141414]">
                    <div className="text-[12px] font-extrabold text-white">
                      {state.homeCanonical ?? "Home"}
                      {state.homeAbbr ? <span className="text-[#808080]"> · {state.homeAbbr}</span> : null}
                    </div>
                    <div className="text-[10px] text-[#7a7a7a] font-semibold">HOME</div>
                  </div>

                  <div className="px-4">
                    {tab === "ratings" ? (
                      <>
                        <StatCell label="Power Rank" away={"—"} home={fmt1(homeRatings?.power_rank ?? null)} />
                        <StatCell label="Engine Power" away={"—"} home={fmt2(homeRatings?.engine_power ?? null)} />
                        <StatCell label="Adj Off" away={"—"} home={fmt2(homeRatings?.engine_adj_off ?? null)} />
                        <StatCell label="Adj Def" away={"—"} home={fmt2(homeRatings?.engine_adj_def ?? null)} />
                        <StatCell label="True HCA" away={"—"} home={fmt2(homeRatings?.true_hca ?? null)} />
                        <StatCell label="Fun Factor" away={"—"} home={fmt2(homeRatings?.fun_factor ?? null)} />
                        <StatCell label="σ Total/100" away={"—"} home={fmt2(homeRatings?.sigma_total_100 ?? null)} />
                        <StatCell label="σ Margin/100" away={"—"} home={fmt2(homeRatings?.sigma_margin_100 ?? null)} />
                        <StatCell label="Avg Total" away={"—"} home={fmt2(homeRatings?.avg_total_points ?? null)} />
                        <StatCell label="Avg Margin" away={"—"} home={fmt2(homeRatings?.avg_margin_points ?? null)} />
                      </>
                    ) : (
                      <>
                        <StatCell label="v_2025" away={"—"} home={fmt2(homeN?.v_2025 ?? null)} />
                        <StatCell label="last_3" away={"—"} home={fmt2(homeN?.last_3 ?? null)} />
                        <StatCell label="last_1" away={"—"} home={fmt2(homeN?.last_1 ?? null)} />
                        <StatCell label="away_raw" away={"—"} home={fmt2(homeN?.away_raw ?? null)} />
                        <StatCell label="home_raw" away={"—"} home={fmt2(homeN?.home_raw ?? null)} />
                        <StatCell label="v_2024" away={"—"} home={fmt2(homeN?.v_2024 ?? null)} />
                        <StatCell label="away_score" away={"—"} home={fmt2(homeN?.away_score ?? null)} />
                        <StatCell label="home_score" away={"—"} home={fmt2(homeN?.home_score ?? null)} />
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* footer */}
          <div className="px-4 md:px-5 py-3 border-t border-[#141414] flex items-center justify-between">
            <div className="text-[10px] text-[#808080]">
              Uses canonical names for lookups ({String(sportKey).toUpperCase()}).
            </div>
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg bg-[#111] border border-[#2a2a2a] text-[11px] font-extrabold text-[#d0d0d0] hover:bg-[#141414]"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
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

  const [modal, setModal] = useState<ModelModalState>({
    open: false,
    awayCanonical: null,
    homeCanonical: null,
    awayAbbr: null,
    homeAbbr: null,
    commenceTime: null,
  });

  function openModel(away: TeamRow, home: TeamRow, commenceTime: string | null) {
    // IMPORTANT: use CANONICAL (teamName) for lookups — not abbreviations
    setModal({
      open: true,
      awayCanonical: away.teamName,
      homeCanonical: home.teamName,
      awayAbbr: away.teamAbbr,
      homeAbbr: home.teamAbbr,
      commenceTime,
    });
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

  /* 0b) team_ratings power_rank map (used in table next to team name) */
  useEffect(() => {
    let mounted = true;

    async function loadPowerRanks() {
      const { data, error } = await supabase
        .from("team_ratings")
        .select("canonical,power_rank,sport_key,updated_at")
        .eq("sport_key", sportKey as any)
        .order("updated_at", { ascending: false })
        .limit(2000);

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
        // keep first seen (latest due to order)
        if (!pm.has(k) && pr != null && Number.isFinite(pr)) pm.set(k, pr);
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
        .eq("sport_key", sportKey as any)
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
        .eq("sport_key", sportKey as any)
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

      // IMPORTANT: in your DB, these should already be canonical (as you said)
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

  /* =========================================================
     Render
  ========================================================= */

  return (
    <div className="h-[calc(100vh-120px)] md:h-[calc(100vh-140px)] overflow-y-auto pr-1 space-y-4">
      {/* Modal */}
      <ModelModal
        state={modal}
        onClose={() =>
          setModal({
            open: false,
            awayCanonical: null,
            homeCanonical: null,
            awayAbbr: null,
            homeAbbr: null,
            commenceTime: null,
          })
        }
        sportKey={sportKey}
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
              One block per matchup. Projected score, win%, probabilities, and consensus lines.
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
                    onOpenModel={(away, home) => openModel(away, home, ev.commenceTime)}
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
                    onClick={() => openModel(ev.away, ev.home, ev.commenceTime)}
                    className="px-3 py-2 rounded-lg bg-[#111] border border-[#2a2a2a] text-[11px] font-extrabold text-[#d0d0d0] hover:bg-[#141414]"
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
  onOpenModel: (away: TeamRow, home: TeamRow) => void;
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
          {/* ✅ Model button by team name */}
          <MiniButton label="Model" title="Open model stats" onClick={() => onOpenModel(away, home)} />
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
          <div className={["font-extrabold tabular-nums", away.isProjectedWinner ? "text-green-400" : "text-white"].join(" ")}>
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
          <div className={["font-extrabold tabular-nums", home.isProjectedWinner ? "text-green-400" : "text-white"].join(" ")}>
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

/* ✅ Default export optional */
export default MonteCarloScreen;

