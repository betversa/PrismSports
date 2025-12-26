// screens/MonteCarlo/MonteCarloScreen.tsx — FULL REWRITE (v4.2)
// ✅ Filters by selected sport (sportKey prop) using monte_carlo_runs.sport_key + monte_carlo_results.sport_key
// ✅ Robust logo + abbreviation mapping from team_map (canonical, Abbreviation, "Logo URL")
// ✅ Normalized key matching (fixes “some logos missing”)
// ✅ Desktop: details (Proj Margin/Total + Cons Spread/Total) lives INLINE beside Proj Score (fills dead space)
// ✅ Mobile: cards + collapsible details, Away/Home headers use team abbreviations (from team_map)
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
  sport_key: string;

  event_id: string;
  commence_time: string | null;

  home_team: string | null;
  away_team: string | null;

  projected_margin_home: number | null; // stored convention (may be negative for home better depending on your pipeline)
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

type OddsSnapshotRow = {
  ts: string;
  event_id: string;
  market: string; // spreads | totals
  side: string | null; // home/away | over/under (or variants)
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
  teamName: string;
  teamAbbr: string; // from team_map
  logoUrl: string | null;

  projPoints: number;

  projMarginTeam: number; // margin for THIS team
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

/** ---------------- Normalizers ---------------- */
const normKey = (s: string) =>
  (s ?? "")
    .toString()
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

/** ---------------- Side normalization (odds_snapshot) ---------------- */
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

function formatAmerican(odds: number | null) {
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

/** ---------------- Logo component (robust fallback) ---------------- */
function LogoBox({ team, url, size }: { team: string; url: string | null; size: number }) {
  const [ok, setOk] = React.useState(true);

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
    />
  );
}

/** ---------------- Desktop row pieces ---------------- */
const SCORE_COL_W = 62;
const WIN_COL_W = 62;

function TeamLineDesktop({
  team,
  abbr,
  sideLabel,
  logoUrl,
  score,
  winProb,
  isWinner,
}: {
  team: string;
  abbr: string;
  sideLabel: "AWAY" | "HOME";
  logoUrl: string | null;
  score: number;
  winProb: number | null;
  isWinner: boolean;
}) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <LogoBox team={team} url={logoUrl} size={44} />

      <div className="min-w-0 leading-tight">
        <div className="text-[13px] text-white font-extrabold truncate" title={team}>
          {team}
        </div>
        <div className="text-[10px] text-[#7a7a7a] font-semibold">
          {sideLabel} · {abbr}
        </div>
      </div>

      <div className="ml-auto flex items-baseline tabular-nums shrink-0 gap-3">
        <div
          className={[
            "text-right font-extrabold text-[16px]",
            isWinner ? "text-green-400" : "text-white",
          ].join(" ")}
          style={{ width: SCORE_COL_W }}
        >
          {score.toFixed(1)}
        </div>
        <div className="text-right font-bold text-[12px] text-[#bdbdbd]" style={{ width: WIN_COL_W }}>
          {formatPct(winProb)}
        </div>
      </div>
    </div>
  );
}

function MetricRow({
  label,
  away,
  home,
  awayHdr,
  homeHdr,
}: {
  label: string;
  away: React.ReactNode;
  home: React.ReactNode;
  awayHdr: string;
  homeHdr: string;
}) {
  return (
    <div className="grid grid-cols-[86px_1fr_1fr] gap-3 items-center py-2 border-b border-[#141414] last:border-b-0">
      <div className="text-[10px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">{label}</div>
      <div className="text-right">
        <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase tracking-wide">{awayHdr}</div>
        <div className="text-[12px] text-white font-bold tabular-nums">{away}</div>
      </div>
      <div className="text-right">
        <div className="text-[9px] text-[#6f6f6f] font-extrabold uppercase tracking-wide">{homeHdr}</div>
        <div className="text-[12px] text-white font-bold tabular-nums">{home}</div>
      </div>
    </div>
  );
}

function DesktopInlineDetails({
  away,
  home,
}: {
  away: TeamRow;
  home: TeamRow;
}) {
  const projMarginAway = `${away.projMarginTeam > 0 ? "+" : ""}${away.projMarginTeam.toFixed(1)}`;
  const projMarginHome = `${home.projMarginTeam > 0 ? "+" : ""}${home.projMarginTeam.toFixed(1)}`;

  const projTotalOver =
    away.projTotal ? `o${away.projTotal.toFixed(1)}` : "—";
  const projTotalUnder =
    home.projTotal ? `u${home.projTotal.toFixed(1)}` : "—";

  const consSpreadAway =
    away.consSpreadLineTeam == null
      ? "—"
      : `${away.consSpreadLineTeam > 0 ? "+" : ""}${away.consSpreadLineTeam.toFixed(1)} (${formatAmerican(
          away.consSpreadOddsTeam
        )})`;

  const consSpreadHome =
    home.consSpreadLineTeam == null
      ? "—"
      : `${home.consSpreadLineTeam > 0 ? "+" : ""}${home.consSpreadLineTeam.toFixed(1)} (${formatAmerican(
          home.consSpreadOddsTeam
        )})`;

  const consTotalOver =
    away.consTotalLine == null
      ? "—"
      : `o${away.consTotalLine.toFixed(1)} (${formatAmerican(away.consTotalOverOdds)})`;

  const consTotalUnder =
    home.consTotalLine == null
      ? "—"
      : `u${home.consTotalLine.toFixed(1)} (${formatAmerican(home.consTotalUnderOdds)})`;

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-black/10 overflow-hidden">
      <div className="px-4 py-3 border-b border-[#141414]">
        <div className="text-[11px] text-white font-extrabold">Details</div>
      </div>
      <div className="px-4 py-2">
        <MetricRow
          label="Proj Margin"
          away={
            <>
              {projMarginAway}{" "}
              <span className="text-[#808080] font-semibold text-[11px]">({formatPct(away.coverProbTeam)})</span>
            </>
          }
          home={
            <>
              {projMarginHome}{" "}
              <span className="text-[#808080] font-semibold text-[11px]">({formatPct(home.coverProbTeam)})</span>
            </>
          }
          awayHdr={away.teamAbbr}
          homeHdr={home.teamAbbr}
        />

        <MetricRow
          label="Proj Total"
          away={
            <>
              {projTotalOver}{" "}
              <span className="text-[#808080] font-semibold text-[11px]">({formatPct(away.overProb)})</span>
            </>
          }
          home={
            <>
              {projTotalUnder}{" "}
              <span className="text-[#808080] font-semibold text-[11px]">({formatPct(home.underProb)})</span>
            </>
          }
          awayHdr={`O (${away.teamAbbr})`}
          homeHdr={`U (${home.teamAbbr})`}
        />

        <MetricRow
          label="Cons Spread"
          away={consSpreadAway}
          home={consSpreadHome}
          awayHdr={away.teamAbbr}
          homeHdr={home.teamAbbr}
        />

        <MetricRow
          label="Cons Total"
          away={consTotalOver}
          home={consTotalUnder}
          awayHdr="OVER"
          homeHdr="UNDER"
        />
      </div>
    </div>
  );
}

/** ---------------- Mobile details block (abbr headers) ---------------- */
function MobileDetailsBlock({ away, home }: { away: TeamRow; home: TeamRow }) {
  const projMarginAway = `${away.projMarginTeam > 0 ? "+" : ""}${away.projMarginTeam.toFixed(1)}`;
  const projMarginHome = `${home.projMarginTeam > 0 ? "+" : ""}${home.projMarginTeam.toFixed(1)}`;

  const consSpreadAway =
    away.consSpreadLineTeam == null
      ? "—"
      : `${away.consSpreadLineTeam > 0 ? "+" : ""}${away.consSpreadLineTeam.toFixed(1)} (${formatAmerican(
          away.consSpreadOddsTeam
        )})`;

  const consSpreadHome =
    home.consSpreadLineTeam == null
      ? "—"
      : `${home.consSpreadLineTeam > 0 ? "+" : ""}${home.consSpreadLineTeam.toFixed(1)} (${formatAmerican(
          home.consSpreadOddsTeam
        )})`;

  const consTotalOver =
    away.consTotalLine == null
      ? "—"
      : `o${away.consTotalLine.toFixed(1)} (${formatAmerican(away.consTotalOverOdds)})`;

  const consTotalUnder =
    home.consTotalLine == null
      ? "—"
      : `u${home.consTotalLine.toFixed(1)} (${formatAmerican(home.consTotalUnderOdds)})`;

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

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-black/10 overflow-hidden">
      <div className="px-4 py-2 border-b border-[#141414] text-[11px] text-white font-extrabold">Details</div>
      <div className="px-4">
        {headerRow}
        {row(
          "Proj Margin",
          <>
            {projMarginAway}{" "}
            <span className="text-[#808080] font-semibold text-[10px]">({formatPct(away.coverProbTeam)})</span>
          </>,
          <>
            {projMarginHome}{" "}
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

/** ---------------- Desktop Event Block (inline details) ---------------- */
function DesktopEventBlock({ ev }: { ev: EventBundle }) {
  const timeLabel = ev.away.commenceTime ? formatStartStamp(ev.away.commenceTime) : "TBD";

  return (
    <div className="rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden shadow-[0_16px_60px_rgba(0,0,0,0.32)]">
      <div className="px-5 py-4 border-b border-[#2a2a2a] bg-black/20">
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[10px] font-extrabold uppercase tracking-wide text-[#8a8a8a]">Matchup</div>
            <div className="text-[12px] text-[#cfcfcf] font-extrabold truncate">{timeLabel}</div>
          </div>

          <div className="flex items-end tabular-nums gap-3 shrink-0">
            <div className="text-[10px] font-extrabold uppercase tracking-wide text-[#8a8a8a] text-right" style={{ width: SCORE_COL_W }}>
              Proj Score
            </div>
            <div className="text-[10px] font-extrabold uppercase tracking-wide text-[#8a8a8a] text-right" style={{ width: WIN_COL_W }}>
              Win%
            </div>
          </div>
        </div>
      </div>

      {/* two-column desktop body: left teams, right inline details */}
      <div className="p-5 grid grid-cols-1 lg:grid-cols-[1.05fr_0.95fr] gap-4">
        <div className="space-y-3">
          <TeamLineDesktop
            team={ev.away.teamName}
            abbr={ev.away.teamAbbr}
            sideLabel="AWAY"
            logoUrl={ev.away.logoUrl}
            score={ev.away.projPoints}
            winProb={ev.away.winProbTeam}
            isWinner={ev.away.isProjectedWinner}
          />
          <TeamLineDesktop
            team={ev.home.teamName}
            abbr={ev.home.teamAbbr}
            sideLabel="HOME"
            logoUrl={ev.home.logoUrl}
            score={ev.home.projPoints}
            winProb={ev.home.winProbTeam}
            isWinner={ev.home.isProjectedWinner}
          />
        </div>

        <DesktopInlineDetails away={ev.away} home={ev.home} />
      </div>
    </div>
  );
}

/** ---------------- Main Screen ---------------- */
export function MonteCarloScreen({ sportKey }: { sportKey: SportKey }) {
  const [run, setRun] = useState<MonteCarloRun | null>(null);
  const [results, setResults] = useState<MonteCarloResultRow[]>([]);
  const [logoMap, setLogoMap] = useState<Map<string, string>>(new Map());
  const [abbrMap, setAbbrMap] = useState<Map<string, string>>(new Map());
  const [consensusMap, setConsensusMap] = useState<Map<string, Consensus>>(new Map());
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});

  const [loadingRun, setLoadingRun] = useState(true);
  const [loadingResults, setLoadingResults] = useState(false);
  const [loadingConsensus, setLoadingConsensus] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 0) logos + abbreviations */
  useEffect(() => {
    let alive = true;

    (async () => {
      const { data, error } = await supabase
        .from("team_map")
        .select('canonical,"Logo URL","Abbreviation"');

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
        const k = normKey(r.canonical);
        if (!k) continue;

        const url = (r["Logo URL"] ?? "").trim();
        if (url) lm.set(k, url);

        const ab = (r.Abbreviation ?? "").trim();
        if (ab) am.set(k, ab.toUpperCase());
      }

      setLogoMap(lm);
      setAbbrMap(am);
    })();

    return () => {
      alive = false;
    };
  }, []);

  /** 1) latest run (FILTERED BY SPORT) */
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

  /** 2) results (FILTERED BY RUN + SPORT) */
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

  /** 3) consensus (spreads/totals) for event_ids in this run */
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
      const homeRaw = (r.home_team ?? "").trim();
      const awayRaw = (r.away_team ?? "").trim();
      if (!homeRaw || !awayRaw) continue;

      const homeKey = normKey(homeRaw);
      const awayKey = normKey(awayRaw);

      const homeAbbr = abbrMap.get(homeKey) ?? "HOME";
      const awayAbbr = abbrMap.get(awayKey) ?? "AWAY";

      const marginHome = numOr(r.projected_margin_home, 0);
      const totalProj = numOr(r.projected_total, 0);

      const homePtsStored = numOrNullable(r.projected_home_points);
      const awayPtsStored = numOrNullable(r.projected_away_points);

      const homePts = homePtsStored ?? safeRound1((totalProj + marginHome) / 2);
      const awayPts = awayPtsStored ?? safeRound1((totalProj - marginHome) / 2);

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

      const awayRow: TeamRow = {
        key: `${r.event_id}-AWAY`,
        eventId: r.event_id,
        commenceTime: r.commence_time ?? null,
        side: "AWAY",
        teamName: awayRaw,
        teamAbbr: awayAbbr,
        logoUrl: logoMap.get(awayKey) ?? null,

        projPoints: awayPts,
        projMarginTeam: -marginHome,
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
        teamName: homeRaw,
        teamAbbr: homeAbbr,
        logoUrl: logoMap.get(homeKey) ?? null,

        projPoints: homePts,
        projMarginTeam: marginHome,
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
  }, [results, logoMap, abbrMap, consensusMap]);

  /** keep open state aligned */
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
            <h2 className="text-[22px] md:text-[28px] text-white font-extrabold tracking-tight">Monte Carlo</h2>
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
                        <div className="text-[10px] font-extrabold uppercase tracking-wide text-[#8a8a8a] truncate">
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
                        {/* Away */}
                        <div className="flex items-center gap-3 min-w-0">
                          <LogoBox team={ev.away.teamName} url={ev.away.logoUrl} size={34} />
                          <div className="min-w-0 leading-tight">
                            <div className="text-[11px] text-white font-extrabold truncate" title={ev.away.teamName}>
                              {ev.away.teamName}
                            </div>
                            <div className="text-[9px] text-[#7a7a7a] font-semibold">
                              AWAY · {ev.away.teamAbbr}
                            </div>
                          </div>
                          <div className="ml-auto flex items-baseline tabular-nums gap-2 shrink-0">
                            <div className={["font-extrabold text-[13px]", ev.away.isProjectedWinner ? "text-green-400" : "text-white"].join(" ")}>
                              {ev.away.projPoints.toFixed(1)}
                            </div>
                            <div className="font-bold text-[10px] text-[#bdbdbd]">{formatPct(ev.away.winProbTeam)}</div>
                          </div>
                        </div>

                        {/* Home */}
                        <div className="flex items-center gap-3 min-w-0">
                          <LogoBox team={ev.home.teamName} url={ev.home.logoUrl} size={34} />
                          <div className="min-w-0 leading-tight">
                            <div className="text-[11px] text-white font-extrabold truncate" title={ev.home.teamName}>
                              {ev.home.teamName}
                            </div>
                            <div className="text-[9px] text-[#7a7a7a] font-semibold">
                              HOME · {ev.home.teamAbbr}
                            </div>
                          </div>
                          <div className="ml-auto flex items-baseline tabular-nums gap-2 shrink-0">
                            <div className={["font-extrabold text-[13px]", ev.home.isProjectedWinner ? "text-green-400" : "text-white"].join(" ")}>
                              {ev.home.projPoints.toFixed(1)}
                            </div>
                            <div className="font-bold text-[10px] text-[#bdbdbd]">{formatPct(ev.home.winProbTeam)}</div>
                          </div>
                        </div>

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
