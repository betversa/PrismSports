// screens/MonteCarlo/MonteCarloScreen.tsx — FULL REWRITE (v4.2)
// ✅ Filters by selected sport (sportKey prop) using monte_carlo_runs.sport_key + monte_carlo_results.sport_key
// ✅ Desktop: NO details toggle — projection + margin/total + consensus are IN THE SAME BLOCK (fills dead space)
// ✅ Mobile: cards + collapsible details (kept), but Away/Home headers use TEAM ABBREVIATIONS from team_map
// ✅ Logos + abbreviations pulled from team_map (canonical match)
// ✅ Consensus derived from odds_snapshot (spreads/totals) for displayed event_ids

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import type { SportKey } from "../../App";

/** ---------------- Types ---------------- */
type MonteCarloRun = {
  id: string;
  created_at: string;
  sport_key: string;
};

type MonteCarloResultRow = {
  run_id: string;
  sport_key?: string | null;

  event_id: string;
  commence_time: string | null;

  home_team: string | null; // canonical
  away_team: string | null; // canonical

  projected_margin_home: number | null; // stored convention in DB
  projected_total: number | null;

  projected_home_points?: number | null;
  projected_away_points?: number | null;

  home_cover_prob: number | null;
  away_cover_prob: number | null;

  over_prob: number | null;
  under_prob: number | null;

  home_win_prob?: number | null;
  away_win_prob?: number | null;
};

type TeamMapRow = {
  canonical: string;
  abbreviation?: string | null;
  Abbreviation?: string | null; // just in case column is capitalized differently
  "Logo URL": string | null;
};

type OddsSnapshotRow = {
  ts: string;
  event_id: string;
  market: string; // spreads | totals
  side: string | null; // home/away | over/under
  line: number | null;
  odds: number | null;
  bookmaker: string | null;
};

type Consensus = {
  spread_home_line: number | null;
  spread_home_odds: number | null;
  spread_away_odds: number | null;

  total_line: number | null;
  total_over_odds: number | null;
  total_under_odds: number | null;

  ts: string | null;
};

type SideKey = "AWAY" | "HOME";

type TeamRow = {
  key: string;
  eventId: string;
  commenceTime: string | null;

  side: SideKey;
  teamName: string; // canonical
  abbr: string; // from team_map, fallback to side label
  logoUrl: string | null;

  projPoints: number;
  projMarginTeam: number; // team perspective
  coverProbTeam: number | null;

  projTotal: number;
  overProb: number | null;
  underProb: number | null;

  winProbTeam: number | null;

  consSpreadLineTeam: number | null; // team perspective
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

/** ---------------- Side normalization ---------------- */
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

/** ---------------- Formatters ---------------- */
function formatTs(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function formatStartStamp(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function formatAmerican(odds: number) {
  const n = Math.round(Number(odds));
  if (!Number.isFinite(n) || n === 0) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

function formatPct(prob01: number | null) {
  const p = Number(prob01);
  if (!Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}%`;
}

/** ---------------- Numeric helpers ---------------- */
function pushMap(map: Map<string, number[]>, key: string, v: number) {
  const arr = map.get(key) ?? [];
  arr.push(v);
  map.set(key, arr);
}
function numOr(v: number | null | undefined, fb: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}
function numOrNullable(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function safeRound1(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10) / 10;
}
function medianOrNull(nums: number[]): number | null {
  const arr = nums
    .filter((n) => Number.isFinite(n))
    .slice()
    .sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}

/** ---------------- UI bits ---------------- */
function LogoBox({ team, url, size }: { team: string; url: string | null; size: number }) {
  if (!url) {
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
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

const SCORE_COL_W = 64;
const WIN_COL_W = 58;
const RIGHT_GAP_PX = 10;

/** ---------------- Header Row ---------------- */
function EventMiniHeader({
  timeLabel,
  variant,
}: {
  timeLabel: string;
  variant: "mobile" | "desktop";
}) {
  const isMobile = variant === "mobile";
  const labelText = isMobile ? "text-[9px]" : "text-[10px]";
  const timeText = isMobile ? "text-[10px]" : "text-[11px]";

  return (
    <div className="flex items-end min-w-0">
      <div className="min-w-0">
        <div className={["font-extrabold uppercase tracking-wide text-[#8a8a8a]", labelText].join(" ")}>
          Matchup
        </div>
        <div className={["text-[#cfcfcf] font-extrabold truncate", timeText].join(" ")}>{timeLabel}</div>
      </div>

      <div className="ml-auto flex items-end tabular-nums shrink-0" style={{ gap: RIGHT_GAP_PX }}>
        <div
          className={["font-extrabold uppercase tracking-wide text-[#8a8a8a] text-right", labelText].join(" ")}
          style={{ width: SCORE_COL_W }}
        >
          Proj
        </div>
        <div
          className={["font-extrabold uppercase tracking-wide text-[#8a8a8a] text-right", labelText].join(" ")}
          style={{ width: WIN_COL_W }}
        >
          Win%
        </div>
      </div>
    </div>
  );
}

/** ---------------- Team row (top line) ---------------- */
function SummaryLine({
  team,
  sideLabel,
  logoUrl,
  score,
  winProb,
  isWinner,
  variant,
}: {
  team: string;
  sideLabel: string; // we’ll pass abbreviation here for mobile headers too
  logoUrl: string | null;
  score: number;
  winProb: number | null;
  isWinner: boolean;
  variant: "mobile" | "desktop";
}) {
  const isMobile = variant === "mobile";
  const logoSize = isMobile ? 34 : 42;

  const teamText = isMobile ? "text-[11px]" : "text-[13px]";
  const sideText = isMobile ? "text-[9px]" : "text-[10px]";
  const scoreText = isMobile ? "text-[13px]" : "text-[16px]";
  const winText = isMobile ? "text-[10px]" : "text-[12px]";

  return (
    <div className="flex items-center gap-3 min-w-0">
      <div className="shrink-0">
        <LogoBox team={team} url={logoUrl} size={logoSize} />
      </div>

      <div className="min-w-0 leading-tight pr-1">
        <div className={["text-white font-extrabold truncate", teamText].join(" ")} title={team}>
          {team}
        </div>
        <div className={["text-[#7a7a7a] font-semibold uppercase tracking-wide", sideText].join(" ")}>
          {sideLabel}
        </div>
      </div>

      <div className="ml-auto flex items-baseline tabular-nums shrink-0" style={{ gap: RIGHT_GAP_PX }}>
        <div
          className={["font-extrabold text-right", scoreText, isWinner ? "text-green-400" : "text-white"].join(" ")}
          style={{ width: SCORE_COL_W }}
        >
          {score.toFixed(1)}
        </div>
        <div className={["font-bold text-[#bdbdbd] text-right", winText].join(" ")} style={{ width: WIN_COL_W }}>
          {formatPct(winProb)}
        </div>
      </div>
    </div>
  );
}

/** ---------------- Desktop “inline details” grid ---------------- */
function DesktopInlineDetails({ away, home }: { away: TeamRow; home: TeamRow }) {
  const fmtSigned = (x: number) => `${x > 0 ? "+" : ""}${x.toFixed(1)}`;

  const awayProjMargin = (
    <div className="text-right tabular-nums text-white font-extrabold text-[12px]">
      {fmtSigned(away.projMarginTeam)}{" "}
      <span className="text-[#8a8a8a] font-semibold text-[11px]">({formatPct(away.coverProbTeam)})</span>
    </div>
  );
  const homeProjMargin = (
    <div className="text-right tabular-nums text-white font-extrabold text-[12px]">
      {fmtSigned(home.projMarginTeam)}{" "}
      <span className="text-[#8a8a8a] font-semibold text-[11px]">({formatPct(home.coverProbTeam)})</span>
    </div>
  );

  const awayProjTotal = (
    <div className="text-right tabular-nums text-white font-extrabold text-[12px]">
      o{away.projTotal.toFixed(1)}{" "}
      <span className="text-[#8a8a8a] font-semibold text-[11px]">({formatPct(away.overProb)})</span>
    </div>
  );
  const homeProjTotal = (
    <div className="text-right tabular-nums text-white font-extrabold text-[12px]">
      u{home.projTotal.toFixed(1)}{" "}
      <span className="text-[#8a8a8a] font-semibold text-[11px]">({formatPct(home.underProb)})</span>
    </div>
  );

  const consSpreadAway =
    away.consSpreadLineTeam == null
      ? <span className="text-[#8a8a8a]">—</span>
      : (
        <span className="tabular-nums text-white font-extrabold text-[12px]">
          {fmtSigned(away.consSpreadLineTeam)}{" "}
          <span className="text-[#8a8a8a] font-semibold text-[11px]">
            ({away.consSpreadOddsTeam == null ? "—" : formatAmerican(away.consSpreadOddsTeam)})
          </span>
        </span>
      );

  const consSpreadHome =
    home.consSpreadLineTeam == null
      ? <span className="text-[#8a8a8a]">—</span>
      : (
        <span className="tabular-nums text-white font-extrabold text-[12px]">
          {fmtSigned(home.consSpreadLineTeam)}{" "}
          <span className="text-[#8a8a8a] font-semibold text-[11px]">
            ({home.consSpreadOddsTeam == null ? "—" : formatAmerican(home.consSpreadOddsTeam)})
          </span>
        </span>
      );

  const consTotalOver =
    away.consTotalLine == null
      ? <span className="text-[#8a8a8a]">—</span>
      : (
        <span className="tabular-nums text-white font-extrabold text-[12px]">
          o{away.consTotalLine.toFixed(1)}{" "}
          <span className="text-[#8a8a8a] font-semibold text-[11px]">
            ({away.consTotalOverOdds == null ? "—" : formatAmerican(away.consTotalOverOdds)})
          </span>
        </span>
      );

  const consTotalUnder =
    home.consTotalLine == null
      ? <span className="text-[#8a8a8a]">—</span>
      : (
        <span className="tabular-nums text-white font-extrabold text-[12px]">
          u{home.consTotalLine.toFixed(1)}{" "}
          <span className="text-[#8a8a8a] font-semibold text-[11px]">
            ({home.consTotalUnderOdds == null ? "—" : formatAmerican(home.consTotalUnderOdds)})
          </span>
        </span>
      );

  return (
    <div className="mt-4 rounded-xl border border-[#2a2a2a] bg-black/10 overflow-hidden">
      {/* Header row with abbreviations */}
      <div className="grid grid-cols-3 gap-3 px-4 py-2 border-b border-[#141414] items-center">
        <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide"> </div>
        <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide text-right">
          {away.abbr}
        </div>
        <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide text-right">
          {home.abbr}
        </div>
      </div>

      {/* Rows */}
      <div className="px-4">
        <div className="grid grid-cols-3 gap-3 py-2 border-b border-[#141414] items-center">
          <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">Proj Margin</div>
          {awayProjMargin}
          {homeProjMargin}
        </div>

        <div className="grid grid-cols-3 gap-3 py-2 border-b border-[#141414] items-center">
          <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">Proj Total</div>
          {awayProjTotal}
          {homeProjTotal}
        </div>

        <div className="grid grid-cols-3 gap-3 py-2 border-b border-[#141414] items-center">
          <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">Cons Spread</div>
          <div className="text-right">{consSpreadAway}</div>
          <div className="text-right">{consSpreadHome}</div>
        </div>

        <div className="grid grid-cols-3 gap-3 py-2 items-center">
          <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">Cons Total</div>
          <div className="text-right">{consTotalOver}</div>
          <div className="text-right">{consTotalUnder}</div>
        </div>
      </div>
    </div>
  );
}

/** ---------------- Mobile collapsible details block (abbr headers) ---------------- */
function MobileDetailsBlock({ away, home }: { away: TeamRow; home: TeamRow }) {
  const fmtSigned = (x: number) => `${x > 0 ? "+" : ""}${x.toFixed(1)}`;

  const headerRow = (
    <div className="grid grid-cols-3 gap-2 items-center py-2 border-b border-[#141414]">
      <div className="text-[9px] text-[#8a8a8a] font-extrabold uppercase tracking-wide"> </div>
      <div className="text-[9px] text-[#8a8a8a] font-extrabold uppercase tracking-wide text-right">
        {away.abbr}
      </div>
      <div className="text-[9px] text-[#8a8a8a] font-extrabold uppercase tracking-wide text-right">
        {home.abbr}
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
      : `${fmtSigned(away.consSpreadLineTeam)} (${away.consSpreadOddsTeam == null ? "—" : formatAmerican(away.consSpreadOddsTeam)})`;

  const consSpreadHome =
    home.consSpreadLineTeam == null
      ? "—"
      : `${fmtSigned(home.consSpreadLineTeam)} (${home.consSpreadOddsTeam == null ? "—" : formatAmerican(home.consSpreadOddsTeam)})`;

  const consTotalOver =
    away.consTotalLine == null
      ? "—"
      : `o${away.consTotalLine.toFixed(1)} (${away.consTotalOverOdds == null ? "—" : formatAmerican(away.consTotalOverOdds)})`;

  const consTotalUnder =
    home.consTotalLine == null
      ? "—"
      : `u${home.consTotalLine.toFixed(1)} (${home.consTotalUnderOdds == null ? "—" : formatAmerican(home.consTotalUnderOdds)})`;

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-black/10 overflow-hidden">
      <div className="px-4 py-2 border-b border-[#141414] text-[11px] text-white font-extrabold">Details</div>
      <div className="px-4">
        {headerRow}
        {row(
          "Proj Margin",
          <>
            {fmtSigned(away.projMarginTeam)}{" "}
            <span className="text-[#808080] font-semibold text-[10px]">({formatPct(away.coverProbTeam)})</span>
          </>,
          <>
            {fmtSigned(home.projMarginTeam)}{" "}
            <span className="text-[#808080] font-semibold text-[10px]">({formatPct(home.coverProbTeam)})</span>
          </>
        )}
        {row(
          "Proj Total",
          <>
            o{away.projTotal.toFixed(1)}{" "}
            <span className="text-[#808080] font-semibold text-[10px]">({formatPct(away.overProb)})</span>
          </>,
          <>
            u{home.projTotal.toFixed(1)}{" "}
            <span className="text-[#808080] font-semibold text-[10px]">({formatPct(home.underProb)})</span>
          </>
        )}
        {row("Cons Spread", consSpreadAway, consSpreadHome)}
        {row("Cons Total", consTotalOver, consTotalUnder)}
      </div>
    </div>
  );
}

/** ---------------- Desktop event block (no toggle) ---------------- */
function DesktopEventBlock({ ev }: { ev: EventBundle }) {
  const timeLabel = ev.away.commenceTime ? formatStartStamp(ev.away.commenceTime) : "TBD";

  return (
    <div className="rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden shadow-[0_16px_60px_rgba(0,0,0,0.32)]">
      {/* top mini header */}
      <div className="px-5 py-4 border-b border-[#2a2a2a] bg-black/20">
        <EventMiniHeader timeLabel={timeLabel} variant="desktop" />
      </div>

      {/* core */}
      <div className="px-5 py-4">
        <div className="space-y-3">
          <SummaryLine
            team={ev.away.teamName}
            sideLabel={ev.away.abbr}
            logoUrl={ev.away.logoUrl}
            score={ev.away.projPoints}
            winProb={ev.away.winProbTeam}
            isWinner={ev.away.isProjectedWinner}
            variant="desktop"
          />
          <SummaryLine
            team={ev.home.teamName}
            sideLabel={ev.home.abbr}
            logoUrl={ev.home.logoUrl}
            score={ev.home.projPoints}
            winProb={ev.home.winProbTeam}
            isWinner={ev.home.isProjectedWinner}
            variant="desktop"
          />
        </div>

        {/* ✅ Inline details to kill dead space */}
        <DesktopInlineDetails away={ev.away} home={ev.home} />
      </div>
    </div>
  );
}

/** ---------------- Main Screen ---------------- */
export function MonteCarloScreen({ sportKey }: { sportKey: SportKey }) {
  const [run, setRun] = useState<MonteCarloRun | null>(null);
  const [results, setResults] = useState<MonteCarloResultRow[]>([]);

  // Canonical -> {logo, abbr}
  const [logoMap, setLogoMap] = useState<Map<string, string>>(new Map());
  const [abbrMap, setAbbrMap] = useState<Map<string, string>>(new Map());

  const [consensusMap, setConsensusMap] = useState<Map<string, Consensus>>(new Map());
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});

  const [loadingRun, setLoadingRun] = useState(true);
  const [loadingResults, setLoadingResults] = useState(false);
  const [loadingConsensus, setLoadingConsensus] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 0) team_map (logos + abbreviations) */
  useEffect(() => {
    let alive = true;

    (async () => {
      const { data, error } = await supabase
        .from("team_map")
        .select('canonical,"Logo URL",abbreviation,Abbreviation');

      if (!alive) return;

      if (error) {
        console.warn("[MonteCarloScreen] team_map fetch failed:", error.message);
        setLogoMap(new Map());
        setAbbrMap(new Map());
        return;
      }

      const lm = new Map<string, string>();
      const am = new Map<string, string>();

      for (const r of (data ?? []) as TeamMapRow[]) {
        const canon = (r.canonical ?? "").trim();
        if (!canon) continue;

        const url = (r["Logo URL"] ?? "").trim();
        if (url) lm.set(canon, url);

        const abbr = ((r.abbreviation ?? r.Abbreviation) ?? "").toString().trim();
        if (abbr) am.set(canon, abbr.toUpperCase());
      }

      setLogoMap(lm);
      setAbbrMap(am);
    })();

    return () => {
      alive = false;
    };
  }, []);

  /** 1) latest run (filtered by sport) */
  useEffect(() => {
    let alive = true;

    (async () => {
      setLoadingRun(true);
      setError(null);
      setRun(null);
      setResults([]);
      setConsensusMap(new Map());

      const { data, error } = await supabase
        .from("monte_carlo_runs")
        .select("id, created_at, sport_key")
        .eq("sport_key", sportKey)
        .order("created_at", { ascending: false })
        .limit(1);

      if (!alive) return;

      if (error) {
        setError(error.message);
        setLoadingRun(false);
        return;
      }

      setRun((data?.[0] ?? null) as MonteCarloRun | null);
      setLoadingRun(false);
    })();

    return () => {
      alive = false;
    };
  }, [sportKey]);

  /** 2) results (filtered by run + sport) */
  useEffect(() => {
    let alive = true;

    async function loadResults(runId: string) {
      setLoadingResults(true);
      setError(null);

      const selectCols = [
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
        .select(selectCols)
        .eq("run_id", runId)
        .eq("sport_key", sportKey)
        .order("commence_time", { ascending: true });

      if (!alive) return;

      if (error) {
        setError(error.message);
        setResults([]);
        setConsensusMap(new Map());
        setLoadingResults(false);
        return;
      }

      setResults((data ?? []) as MonteCarloResultRow[]);
      setLoadingResults(false);
    }

    if (run?.id) loadResults(run.id);
    else setLoadingResults(false);

    return () => {
      alive = false;
    };
  }, [run?.id, sportKey]);

  /** 3) consensus (spreads/totals) */
  useEffect(() => {
    let alive = true;

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

      if (!alive) return;

      if (error) {
        console.warn("[MonteCarloScreen] odds_snapshot consensus failed:", error.message);
        setConsensusMap(new Map());
        setLoadingConsensus(false);
        return;
      }

      const rows = (data ?? []) as OddsSnapshotRow[];

      const seen = new Set<string>();

      const spreadHomeLines: Map<string, number[]> = new Map();
      const spreadHomeOdds: Map<string, number[]> = new Map();
      const spreadAwayOdds: Map<string, number[]> = new Map();

      const totalLines: Map<string, number[]> = new Map();
      const totalOverOdds: Map<string, number[]> = new Map();
      const totalUnderOdds: Map<string, number[]> = new Map();

      const bestTsByEvent: Map<string, string> = new Map();

      for (const r of rows) {
        const eventId = (r.event_id ?? "").trim();
        const market = (r.market ?? "").trim().toLowerCase();
        const book = (r.bookmaker ?? "").trim().toLowerCase() || "unknown";
        const side = normalizeSide(r.side);
        const line = numOrNullable(r.line);
        const odds = numOrNullable(r.odds);

        if (!eventId || !market || !side) continue;

        if (r.ts) {
          const prev = bestTsByEvent.get(eventId);
          if (!prev || new Date(r.ts).getTime() > new Date(prev).getTime()) bestTsByEvent.set(eventId, r.ts);
        }

        const k = `${eventId}|${market}|${book}|${side}`;
        if (seen.has(k)) continue;
        seen.add(k);

        if (market === "spreads") {
          if (side === "home") {
            if (line != null) pushMap(spreadHomeLines, eventId, line);
            if (odds != null) pushMap(spreadHomeOdds, eventId, odds);
          }
          if (side === "away") {
            if (odds != null) pushMap(spreadAwayOdds, eventId, odds);
          }
        } else if (market === "totals") {
          if (side === "over") {
            if (line != null) pushMap(totalLines, eventId, line);
            if (odds != null) pushMap(totalOverOdds, eventId, odds);
          }
          if (side === "under") {
            if (odds != null) pushMap(totalUnderOdds, eventId, odds);
          }
        }
      }

      const m = new Map<string, Consensus>();
      for (const eventId of eventIds) {
        m.set(eventId, {
          spread_home_line: medianOrNull(spreadHomeLines.get(eventId) ?? []),
          spread_home_odds: medianOrNull(spreadHomeOdds.get(eventId) ?? []),
          spread_away_odds: medianOrNull(spreadAwayOdds.get(eventId) ?? []),

          total_line: medianOrNull(totalLines.get(eventId) ?? []),
          total_over_odds: medianOrNull(totalOverOdds.get(eventId) ?? []),
          total_under_odds: medianOrNull(totalUnderOdds.get(eventId) ?? []),

          ts: bestTsByEvent.get(eventId) ?? null,
        });
      }

      setConsensusMap(m);
      setLoadingConsensus(false);
    }

    const ids = Array.from(new Set(results.map((r) => r.event_id).filter(Boolean)));
    loadConsensus(ids);

    return () => {
      alive = false;
    };
  }, [results]);

  /** 4) build bundles */
  const events: EventBundle[] = useMemo(() => {
    const out: EventBundle[] = [];

    for (const r of results) {
      const home = (r.home_team ?? "").trim();
      const away = (r.away_team ?? "").trim();
      if (!home || !away) continue;

      const marginHomeStored = numOr(r.projected_margin_home, 0);
      const totalProj = numOr(r.projected_total, 0);

      const homePtsStored = numOrNullable(r.projected_home_points);
      const awayPtsStored = numOrNullable(r.projected_away_points);

      // NOTE: we treat stored margin as "home perspective", but don’t assume sign convention here.
      // We only need team-perspective margin values for display.
      // If stored margin convention is inverted, it affects both sides equally; UI still shows +/− consistently.
      const homePts = homePtsStored ?? safeRound1((totalProj + marginHomeStored) / 2);
      const awayPts = awayPtsStored ?? safeRound1((totalProj - marginHomeStored) / 2);

      const pHomeCover = numOrNullable(r.home_cover_prob);
      const pAwayCover = numOrNullable(r.away_cover_prob);

      const pOver = numOrNullable(r.over_prob);
      const pUnder = numOrNullable(r.under_prob);

      const pHomeWin = numOrNullable(r.home_win_prob);
      const pAwayWin = numOrNullable(r.away_win_prob);

      const finalHomeWin = pHomeWin ?? (pAwayWin != null ? 1 - pAwayWin : null);
      const finalAwayWin = pAwayWin ?? (finalHomeWin != null ? 1 - finalHomeWin : null);

      const c = consensusMap.get(r.event_id) ?? null;
      const consSpreadHome = numOrNullable(c?.spread_home_line);
      const consTotal = numOrNullable(c?.total_line);

      const awayIsWinner = awayPts > homePts;
      const homeIsWinner = homePts > awayPts;

      const awayAbbr = abbrMap.get(away) ?? "AWAY";
      const homeAbbr = abbrMap.get(home) ?? "HOME";

      const awayRow: TeamRow = {
        key: `${r.event_id}-AWAY`,
        eventId: r.event_id,
        commenceTime: r.commence_time ?? null,
        side: "AWAY",
        teamName: away,
        abbr: awayAbbr,
        logoUrl: logoMap.get(away) ?? null,

        projPoints: awayPts,
        projMarginTeam: -marginHomeStored,
        coverProbTeam: pAwayCover,

        projTotal: totalProj,
        overProb: pOver,
        underProb: pUnder,

        winProbTeam: finalAwayWin,

        consSpreadLineTeam: consSpreadHome == null ? null : -consSpreadHome,
        consSpreadOddsTeam: numOrNullable(c?.spread_away_odds),

        consTotalLine: consTotal,
        consTotalOverOdds: numOrNullable(c?.total_over_odds),
        consTotalUnderOdds: numOrNullable(c?.total_under_odds),

        isProjectedWinner: awayIsWinner,
      };

      const homeRow: TeamRow = {
        key: `${r.event_id}-HOME`,
        eventId: r.event_id,
        commenceTime: r.commence_time ?? null,
        side: "HOME",
        teamName: home,
        abbr: homeAbbr,
        logoUrl: logoMap.get(home) ?? null,

        projPoints: homePts,
        projMarginTeam: marginHomeStored,
        coverProbTeam: pHomeCover,

        projTotal: totalProj,
        overProb: pOver,
        underProb: pUnder,

        winProbTeam: finalHomeWin,

        consSpreadLineTeam: consSpreadHome,
        consSpreadOddsTeam: numOrNullable(c?.spread_home_odds),

        consTotalLine: consTotal,
        consTotalOverOdds: numOrNullable(c?.total_over_odds),
        consTotalUnderOdds: numOrNullable(c?.total_under_odds),

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
  }, [results, logoMap, consensusMap, abbrMap]);

  /** Keep open state aligned */
  useEffect(() => {
    setOpenMap((prev) => {
      const next: Record<string, boolean> = {};
      for (const ev of events) next[ev.eventId] = prev[ev.eventId] ?? false;
      return next;
    });
  }, [events]);

  const loading = loadingRun || loadingResults;

  return (
    <div className="w-full">
      <div className="max-w-[1320px] mx-auto px-4 md:px-8">
        {/* Header */}
        <div className="pt-4 md:pt-6 flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <h2 className="text-[22px] md:text-[28px] text-white font-extrabold tracking-tight">
              Monte Carlo
            </h2>
            <div className="text-xs text-[#8a8a8a] mt-1">
              Sport: <span className="text-white font-extrabold">{sportKey}</span>
              {run?.created_at ? (
                <span className="ml-2 text-[#5a5a5a]">· Latest run: {formatTs(run.created_at)}</span>
              ) : null}
              {loadingConsensus ? <span className="ml-2 text-[#5a5a5a]">· Loading consensus…</span> : null}
            </div>
          </div>

          <div className="hidden md:block text-right">
            <div className="text-[10px] text-[#6a6a6a] font-semibold">Games</div>
            <div className="text-xs text-white">
              <span className="font-extrabold tabular-nums">{events.length}</span>
            </div>
          </div>
        </div>

        {error ? (
          <div className="mt-4 bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl p-4 text-xs text-red-300">
            Supabase error: {error}
          </div>
        ) : null}

        <div className="mt-5 rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden shadow-[0_16px_60px_rgba(0,0,0,0.38)]">
          {/* MOBILE */}
          <div className="md:hidden">
            {loading ? (
              <div className="p-4 text-xs text-[#808080]">Loading Monte Carlo results…</div>
            ) : !events.length ? (
              <div className="p-4 text-xs text-[#808080]">No Monte Carlo rows found for latest run.</div>
            ) : (
              <div className="p-3 space-y-3">
                {events.map((ev) => {
                  const timeLabel = ev.away.commenceTime ? formatStartStamp(ev.away.commenceTime) : "TBD";
                  const open = !!openMap[ev.eventId];

                  return (
                    <div key={ev.eventId} className="rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden">
                      <div className="px-3 py-2 border-b border-[#2a2a2a] bg-black/20 flex items-center justify-between">
                        <div className="text-[10px] font-extrabold text-[#cfcfcf] truncate">
                          {timeLabel}
                        </div>

                        <button
                          type="button"
                          onClick={() => setOpenMap((p) => ({ ...p, [ev.eventId]: !p[ev.eventId] }))}
                          className="text-[10px] font-extrabold text-white/90 hover:text-white px-2 py-[5px] rounded-md border border-[#2a2a2a] hover:border-[#3a3a3a]"
                        >
                          {open ? "Hide" : "Details"}
                        </button>
                      </div>

                      <div className="p-3 space-y-3">
                        <div className="pb-2 border-b border-[#141414]">
                          <EventMiniHeader timeLabel={timeLabel} variant="mobile" />
                        </div>

                        <SummaryLine
                          team={ev.away.teamName}
                          sideLabel={ev.away.abbr}
                          logoUrl={ev.away.logoUrl}
                          score={ev.away.projPoints}
                          winProb={ev.away.winProbTeam}
                          isWinner={ev.away.isProjectedWinner}
                          variant="mobile"
                        />
                        <SummaryLine
                          team={ev.home.teamName}
                          sideLabel={ev.home.abbr}
                          logoUrl={ev.home.logoUrl}
                          score={ev.home.projPoints}
                          winProb={ev.home.winProbTeam}
                          isWinner={ev.home.isProjectedWinner}
                          variant="mobile"
                        />

                        {open ? <MobileDetailsBlock away={ev.away} home={ev.home} /> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* DESKTOP */}
          <div className="hidden md:block">
            {loading ? (
              <div className="p-8 text-sm text-[#808080]">Loading Monte Carlo results…</div>
            ) : !events.length ? (
              <div className="p-8 text-sm text-[#808080]">No Monte Carlo rows found for latest run.</div>
            ) : (
              <div className="p-6">
                <div className="space-y-5">
                  {events.map((ev) => (
                    <DesktopEventBlock key={ev.eventId} ev={ev} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="h-12" />
      </div>
    </div>
  );
}

