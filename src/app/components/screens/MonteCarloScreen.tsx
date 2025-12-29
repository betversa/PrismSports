// screens/MonteCarlo/MonteCarloScreen.tsx — FULL REWRITE (v4.4)
// ✅ Mobile stays EXACTLY like v4.2 behavior (cards + collapsible details w/ abbr headers)
// ✅ Desktop restyled to MATCH Picks page feel:
//    - Picks-style "hero" section (badge + title + subtitle + stat pills)
//    - Unified table-card layout (header row + clean separators) for better continuity
// ✅ Desktop: NO details box; shows inline columns:
//    Proj Score | Win% | Proj Margin | Proj Total | Cons Spread | Cons Total
// ✅ Logos + abbreviations mapped robustly from team_map (canonical, Abbreviation, "Logo URL")
// ✅ Consensus derived from odds_snapshot (spreads/totals) for displayed event_ids
// ✅ Filters by selected sport (sportKey prop) using monte_carlo_runs.sport_key + monte_carlo_results.sport_key

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
  teamAbbr: string;
  logoUrl: string | null;

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
  return d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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

function fmtSigned1(x: number | null) {
  if (x == null || !Number.isFinite(x)) return "—";
  const v = Math.round(x * 10) / 10;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

function fmtOU(line: number | null, kind: "o" | "u") {
  if (line == null || !Number.isFinite(line)) return "—";
  return `${kind}${(Math.round(line * 10) / 10).toFixed(1)}`;
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

/** ---------------- Picks-style UI bits ---------------- */
function BadgePill({ label }: { label: string }) {
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#2a2a2a] bg-black/30">
      <span className="inline-block w-2 h-2 rounded-full bg-[#d1a515]" />
      <span className="text-[11px] font-extrabold text-[#d7d7d7]">{label}</span>
    </div>
  );
}

function StatPill({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#2a2a2a] bg-black/20">
      <span className="text-[11px] font-semibold text-[#8a8a8a]">{label}</span>
      <span className="text-[11px] font-extrabold text-white tabular-nums">{value}</span>
    </div>
  );
}

function RightPill({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#2a2a2a] bg-black/25">
      <span className="text-[10px] font-extrabold uppercase tracking-wide text-[#8a8a8a]">{label}</span>
      <span className="text-[11px] font-extrabold text-white tabular-nums">{value}</span>
    </div>
  );
}

/** =========================================================
    MOBILE (UNCHANGED behavior)
========================================================= */

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

/** =========================================================
    DESKTOP (Picks-style table card)
========================================================= */

const DESK_COLS = {
  score: 92,
  win: 76,
  pm: 150,
  pt: 150,
  cs: 150,
  ct: 150,
};

function DesktopTableHeader() {
  const hdr = "text-[10px] font-extrabold uppercase tracking-wide text-[#6f6f6f]";
  return (
    <div className="grid items-end gap-3" style={{ gridTemplateColumns: `1fr ${DESK_COLS.score}px ${DESK_COLS.win}px ${DESK_COLS.pm}px ${DESK_COLS.pt}px ${DESK_COLS.cs}px ${DESK_COLS.ct}px` }}>
      <div className={hdr}>Matchup</div>
      <div className={[hdr, "text-right"].join(" ")}>Proj Score</div>
      <div className={[hdr, "text-right"].join(" ")}>Win%</div>
      <div className={[hdr, "text-right"].join(" ")}>Proj Margin</div>
      <div className={[hdr, "text-right"].join(" ")}>Proj Total</div>
      <div className={[hdr, "text-right"].join(" ")}>Cons Spread</div>
      <div className={[hdr, "text-right"].join(" ")}>Cons Total</div>
    </div>
  );
}

function DesktopTeamLine({
  row,
  isTopRow,
  showMatchup,
}: {
  row: TeamRow;
  isTopRow: boolean;
  showMatchup: boolean;
}) {
  const isAway = row.side === "AWAY";

  const projMarginCell = (
    <div className="text-right font-bold text-[12px] text-white tabular-nums">
      {fmtSigned1(row.projMarginTeam)}{" "}
      <span className="text-[#808080] font-semibold text-[11px]">({formatPct(row.coverProbTeam)})</span>
    </div>
  );

  const projTotalCell = (
    <div className="text-right font-bold text-[12px] text-white tabular-nums">
      {isAway ? fmtOU(row.projTotal, "o") : fmtOU(row.projTotal, "u")}{" "}
      <span className="text-[#808080] font-semibold text-[11px]">
        ({formatPct(isAway ? row.overProb : row.underProb)})
      </span>
    </div>
  );

  const consSpreadCell = (
    <div className="text-right font-bold text-[12px] text-white tabular-nums">
      {row.consSpreadLineTeam == null ? (
        "—"
      ) : (
        <>
          {fmtSigned1(row.consSpreadLineTeam)}{" "}
          <span className="text-[#808080] font-semibold text-[11px]">({formatAmerican(row.consSpreadOddsTeam)})</span>
        </>
      )}
    </div>
  );

  const consTotalCell = (
    <div className="text-right font-bold text-[12px] text-white tabular-nums">
      {row.consTotalLine == null ? (
        "—"
      ) : (
        <>
          {isAway ? "o" : "u"}
          {row.consTotalLine.toFixed(1)}{" "}
          <span className="text-[#808080] font-semibold text-[11px]">
            ({formatAmerican(isAway ? row.consTotalOverOdds : row.consTotalUnderOdds)})
          </span>
        </>
      )}
    </div>
  );

  const matchupCell = (
    <div className="min-w-0 flex items-center gap-3">
      <LogoBox team={row.teamName} url={row.logoUrl} size={44} />
      <div className="min-w-0 leading-tight">
        <div className="text-[13px] text-white font-extrabold truncate" title={row.teamName}>
          {row.teamName}
        </div>
        <div className="text-[10px] text-[#7a7a7a] font-semibold">
          {row.side} · {row.teamAbbr}
        </div>
      </div>
    </div>
  );

  const scoreCell = (
    <div
      className={[
        "text-right font-extrabold text-[16px] tabular-nums",
        row.isProjectedWinner ? "text-green-400" : "text-white",
      ].join(" ")}
    >
      {row.projPoints.toFixed(1)}
    </div>
  );

  const winCell = (
    <div className="text-right font-bold text-[12px] text-[#bdbdbd] tabular-nums">{formatPct(row.winProbTeam)}</div>
  );

  return (
    <div
      className={[
        "grid items-center gap-3",
        isTopRow ? "pt-3" : "pb-3",
        !isTopRow ? "border-t border-[#1f1f1f]" : "",
      ].join(" ")}
      style={{
        gridTemplateColumns: `1fr ${DESK_COLS.score}px ${DESK_COLS.win}px ${DESK_COLS.pm}px ${DESK_COLS.pt}px ${DESK_COLS.cs}px ${DESK_COLS.ct}px`,
      }}
    >
      <div className="min-w-0">
        {showMatchup ? (
          <div className="min-w-0">
            {matchupCell}
          </div>
        ) : (
          // keep alignment (blank matchup on 2nd row is fine, but we still show team block)
          matchupCell
        )}
      </div>
      {scoreCell}
      {winCell}
      {projMarginCell}
      {projTotalCell}
      {consSpreadCell}
      {consTotalCell}
    </div>
  );
}

function DesktopEventGroup({ ev, showDivider }: { ev: EventBundle; showDivider: boolean }) {
  const timeLabel = ev.away.commenceTime ? formatStartStamp(ev.away.commenceTime) : "TBD";
  return (
    <div className={["px-5", showDivider ? "border-t border-[#2a2a2a]" : ""].join(" ")}>
      <div className="py-3">
        <div className="text-[11px] text-[#9a9a9a] font-extrabold truncate">{timeLabel}</div>
      </div>
      <DesktopTeamLine row={ev.away} isTopRow={true} showMatchup={true} />
      <DesktopTeamLine row={ev.home} isTopRow={false} showMatchup={false} />
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
      const { data, error } = await supabase.from("team_map").select('canonical,"Logo URL","Abbreviation"');

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

  const consensusStamp = useMemo(() => {
    // show a single “best” consensus ts for the header (latest among event consensus stamps)
    const stamps: number[] = [];
    for (const ev of events) {
      const c = consensusMap.get(ev.eventId);
      if (c?.ts) {
        const t = new Date(c.ts).getTime();
        if (Number.isFinite(t)) stamps.push(t);
      }
    }
    if (!stamps.length) return null;
    const max = Math.max(...stamps);
    return new Date(max).toLocaleString();
  }, [events, consensusMap]);

  return (
    <div className="w-full">
      <div className="max-w-[1320px] mx-auto px-4 md:px-8">
        {/* Picks-style hero card */}
        <div className="pt-4 md:pt-6">
          <div className="rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden shadow-[0_16px_60px_rgba(0,0,0,0.38)]">
            <div className="px-5 md:px-6 py-5 md:py-6 bg-gradient-to-r from-black/30 via-transparent to-black/10">
              <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                <div className="min-w-0">
                  <BadgePill label="Prism Model Projections" />
                  <div className="mt-3">
                    <h2 className="text-[22px] md:text-[28px] text-white font-extrabold tracking-tight">
                      Monte Carlo
                    </h2>
                    <div className="text-[12px] text-[#8a8a8a] mt-1">
                      Projections + cover/OU probabilities, with consensus medians across books.
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <StatPill label="Sport" value={<span className="uppercase">{sportKey}</span>} />
                    <StatPill label="Games" value={events.length} />
                    <StatPill
                      label="Latest Run"
                      value={run?.created_at ? formatTs(run.created_at) : "—"}
                    />
                    <StatPill label="Consensus" value={consensusStamp ?? "—"} />
                  </div>
                </div>

                {/* Right-side pills (match Picks controls vibe) */}
                <div className="flex md:flex-col items-start md:items-end gap-2 md:gap-2">
                  <RightPill label="Games" value={events.length} />
                  <RightPill label="Consensus" value={consensusStamp ?? "—"} />
                  {loadingConsensus ? <RightPill label="Status" value="Loading…" /> : null}
                </div>
              </div>

              {error ? (
                <div className="mt-4 bg-black/30 border border-[#3a2a2a] rounded-xl p-4 text-xs text-red-300">
                  Supabase error: {error}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* Main content card (table/list) */}
        <div className="mt-5 rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden shadow-[0_16px_60px_rgba(0,0,0,0.38)]">
          {/* MOBILE (UNCHANGED behavior) */}
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
                            <div
                              className={[
                                "font-extrabold text-[13px]",
                                ev.away.isProjectedWinner ? "text-green-400" : "text-white",
                              ].join(" ")}
                            >
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
                            <div
                              className={[
                                "font-extrabold text-[13px]",
                                ev.home.isProjectedWinner ? "text-green-400" : "text-white",
                              ].join(" ")}
                            >
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

          {/* DESKTOP (Picks-style table card) */}
          <div className="hidden md:block">
            {loading ? (
              <div className="p-8 text-sm text-[#808080]">Loading Monte Carlo results…</div>
            ) : !events.length ? (
              <div className="p-8 text-sm text-[#808080]">No Monte Carlo rows found for latest run.</div>
            ) : (
              <div className="p-6">
                {/* Table header strip */}
                <div className="rounded-2xl border border-[#2a2a2a] bg-black/20 overflow-hidden">
                  <div className="px-5 py-3 border-b border-[#2a2a2a] bg-black/25">
                    <DesktopTableHeader />
                  </div>

                  <div className="divide-y divide-[#1b1b1b]">
                    {events.map((ev, idx) => (
                      <DesktopEventGroup key={ev.eventId} ev={ev} showDivider={idx !== 0} />
                    ))}
                  </div>
                </div>

                <div className="mt-3 text-[11px] text-[#6f6f6f]">
                  Tip: Proj Total shows <span className="text-[#bdbdbd] font-semibold">Over</span> probability on the Away row and{" "}
                  <span className="text-[#bdbdbd] font-semibold">Under</span> probability on the Home row — matching the Picks-style single-line density.
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

