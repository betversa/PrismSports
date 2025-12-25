import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

/**
 * MONTE CARLO SCREEN — FULL REWRITE
 *
 * Default view (clean):
 * - Shows matchup (two rows per game) with team logos
 * - Shows projected score right next to team name
 * - Winner team name is green
 * - Shows away/home win prob in small text next to team name
 * - "Show Details" dropdown reveals full projection + consensus metrics (like OddsScreen)
 *
 * Responsive:
 * - Mobile: card layout with collapsible details
 * - Desktop: OddsScreen-style table; details collapsible per event
 */

type MonteCarloRun = {
  id: string;
  created_at: string;
  sport_key: string;
};

type MonteCarloResultRow = {
  run_id: string;
  event_id: string;
  commence_time: string | null;

  home_team: string | null;
  away_team: string | null;

  projected_margin_home: number | null;
  projected_total: number | null;

  projected_home_points?: number | null;
  projected_away_points?: number | null;

  home_cover_prob: number | null;
  away_cover_prob: number | null;

  over_prob: number | null;
  under_prob: number | null;

  // Optional: if these exist in your table, we’ll show them
  home_win_prob?: number | null;
  away_win_prob?: number | null;
};

type TeamMapLogoRow = {
  canonical: string;
  "Logo URL": string | null;
};

type OddsSnapshotRow = {
  ts: string;
  event_id: string;
  market: string; // "spreads" | "totals"
  side: string | null; // "home"/"away" | "over"/"under"
  line: number | null;
  odds: number | null; // american odds
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
  logoUrl: string | null;

  projPoints: number;
  projMarginTeam: number; // team-view
  coverProbTeam: number | null;

  projTotal: number; // game-view
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
  // for convenience
  projTotal: number;
  projMarginHome: number;
};

/** ---------- Side normalization for odds_snapshot consensus ---------- */
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

/** ---------- Styling constants (OddsScreen vibe) ---------- */
const HDR_LEFT_BG = "bg-[#0a0a0a]";
const HDR_TEXT = "text-[#cfcfcf]";
const HDR_BORDER = "border-[#2a2a2a]";

const COL_MATCHUP = 520;

/** ---------- Formatters ---------- */
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

// expects prob as 0..1 -> "55.5%"
function formatPct(prob01: number | null) {
  const p = Number(prob01);
  if (!Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}%`;
}

/** ---------- numeric helpers ---------- */
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
  const arr = nums.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}

/** ---------- Winner highlight helpers ---------- */
function TeamNameWithScore({
  name,
  score,
  winProb,
  isWinner,
}: {
  name: string;
  score: number;
  winProb: number | null;
  isWinner: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2 min-w-0">
        <div className={["font-extrabold text-[16px] truncate", isWinner ? "text-green-400" : "text-white"].join(" ")}>
          {name}
        </div>
        <div className={["font-extrabold tabular-nums text-[16px] shrink-0", isWinner ? "text-green-400" : "text-white"].join(" ")}>
          {score.toFixed(1)}
        </div>
      </div>
      <div className="text-[11px] text-[#7a7a7a] font-semibold">
        Win: <span className="text-[#bdbdbd]">{formatPct(winProb)}</span>
      </div>
    </div>
  );
}

function LogoBox({ team, url, size = 48 }: { team: string; url: string | null; size?: number }) {
  if (!url) {
    return <div style={{ width: size, height: size }} className="rounded-md bg-white border border-[#e5e5e5]" />;
  }
  return (
    <img
      src={url}
      alt={`${team} logo`}
      style={{ width: size, height: size }}
      className="rounded-md object-contain bg-white border border-[#e5e5e5] p-1"
      loading="lazy"
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

/** ---------- Detail dropdown (shared) ---------- */
function DetailsBlock({ away, home }: { away: TeamRow; home: TeamRow }) {
  const awayTotalLabel = `o${away.projTotal.toFixed(1)}`;
  const homeTotalLabel = `u${home.projTotal.toFixed(1)}`;

  const projMarginAway = `${away.projMarginTeam > 0 ? "+" : ""}${away.projMarginTeam.toFixed(1)}`;
  const projMarginHome = `${home.projMarginTeam > 0 ? "+" : ""}${home.projMarginTeam.toFixed(1)}`;

  const consSpreadAway =
    away.consSpreadLineTeam == null
      ? "—"
      : `${away.consSpreadLineTeam > 0 ? "+" : ""}${away.consSpreadLineTeam.toFixed(1)} (${away.consSpreadOddsTeam == null ? "—" : formatAmerican(away.consSpreadOddsTeam)})`;

  const consSpreadHome =
    home.consSpreadLineTeam == null
      ? "—"
      : `${home.consSpreadLineTeam > 0 ? "+" : ""}${home.consSpreadLineTeam.toFixed(1)} (${home.consSpreadOddsTeam == null ? "—" : formatAmerican(home.consSpreadOddsTeam)})`;

  const consTotalOver =
    away.consTotalLine == null
      ? "—"
      : `o${away.consTotalLine.toFixed(1)} (${away.consTotalOverOdds == null ? "—" : formatAmerican(away.consTotalOverOdds)})`;

  const consTotalUnder =
    home.consTotalLine == null
      ? "—"
      : `u${home.consTotalLine.toFixed(1)} (${home.consTotalUnderOdds == null ? "—" : formatAmerican(home.consTotalUnderOdds)})`;

  const row = (label: string, a: React.ReactNode, h: React.ReactNode) => (
    <div className="grid grid-cols-3 gap-2 items-center py-2 border-b border-[#141414] last:border-b-0">
      <div className="text-[11px] text-[#8a8a8a] font-extrabold uppercase tracking-wide">{label}</div>
      <div className="text-[12px] text-white font-bold tabular-nums text-right">{a}</div>
      <div className="text-[12px] text-white font-bold tabular-nums text-right">{h}</div>
    </div>
  );

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-black/10 overflow-hidden">
      <div className="px-4 py-2 border-b border-[#141414] text-[12px] text-white font-extrabold">Details</div>
      <div className="px-4">
        {row("Proj Margin", <>{projMarginAway} <span className="text-[#808080] font-semibold">({formatPct(away.coverProbTeam)})</span></>, <>{projMarginHome} <span className="text-[#808080] font-semibold">({formatPct(home.coverProbTeam)})</span></>)}
        {row("Proj Total", <>{awayTotalLabel} <span className="text-[#808080] font-semibold">({formatPct(away.overProb)})</span></>, <>{homeTotalLabel} <span className="text-[#808080] font-semibold">({formatPct(home.underProb)})</span></>)}
        {row("Cons Spread", consSpreadAway, consSpreadHome)}
        {row("Cons Total", consTotalOver, consTotalUnder)}
      </div>
    </div>
  );
}

/** ---------- Desktop renderer (two rows per event, dropdown details) ---------- */
function EventTwoRows({
  ev,
  open,
  onToggle,
}: {
  ev: EventBundle;
  open: boolean;
  onToggle: () => void;
}) {
  const away = ev.away;
  const home = ev.home;

  return (
    <>
      <tr className="hover:bg-[#0f0f0f]/50 transition-colors">
        <td className={["p-4 sticky left-0 bg-[#0f0f0f] z-10 align-top", `border-r ${HDR_BORDER}`].join(" ")} rowSpan={2}>
          <div className="text-[12px] text-[#cfcfcf] font-semibold mb-3 flex items-center justify-between gap-3">
            <span>{away.commenceTime ? formatStartStamp(away.commenceTime) : "TBD"}</span>
            <button
              type="button"
              onClick={onToggle}
              className="text-[11px] font-extrabold text-white/90 hover:text-white px-2 py-1 rounded-md border border-[#2a2a2a] hover:border-[#3a3a3a]"
            >
              {open ? "Hide Details" : "Show Details"}
            </button>
          </div>

          <div className="space-y-3">
            {/* away line */}
            <div className="flex items-center gap-3">
              <LogoBox team={away.teamName} url={away.logoUrl} size={48} />
              <TeamNameWithScore name={away.teamName} score={away.projPoints} winProb={away.winProbTeam} isWinner={away.isProjectedWinner} />
              <div className="ml-auto text-[11px] text-[#7a7a7a] font-semibold">AWAY</div>
            </div>

            {/* home line */}
            <div className="flex items-center gap-3">
              <LogoBox team={home.teamName} url={home.logoUrl} size={48} />
              <TeamNameWithScore name={home.teamName} score={home.projPoints} winProb={home.winProbTeam} isWinner={home.isProjectedWinner} />
              <div className="ml-auto text-[11px] text-[#7a7a7a] font-semibold">HOME</div>
            </div>

            {open && <div className="pt-2"><DetailsBlock away={away} home={home} /></div>}
          </div>
        </td>
      </tr>

      {/* spacer row to keep 2-row rhythm like OddsScreen */}
      <tr className={["border-b-2", HDR_BORDER].join(" ")}>
        <td className="p-0" />
      </tr>
    </>
  );
}

/** ---------- Mobile card renderer (clean summary + dropdown details) ---------- */
function EventCardMobile({
  ev,
  open,
  onToggle,
}: {
  ev: EventBundle;
  open: boolean;
  onToggle: () => void;
}) {
  const away = ev.away;
  const home = ev.home;

  const timeLabel = away.commenceTime ? formatStartStamp(away.commenceTime) : "TBD";

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden">
      <div className="px-3 py-2 border-b border-[#2a2a2a] bg-black/20 flex items-center justify-between">
        <div className="text-[11px] text-[#cfcfcf] font-extrabold">{timeLabel}</div>
        <button
          type="button"
          onClick={onToggle}
          className="text-[11px] font-extrabold text-white/90 hover:text-white px-2 py-1 rounded-md border border-[#2a2a2a] hover:border-[#3a3a3a]"
        >
          {open ? "Hide Details" : "Show Details"}
        </button>
      </div>

      <div className="p-3 space-y-3">
        <div className="flex items-center gap-3">
          <LogoBox team={away.teamName} url={away.logoUrl} size={44} />
          <TeamNameWithScore name={away.teamName} score={away.projPoints} winProb={away.winProbTeam} isWinner={away.isProjectedWinner} />
          <div className="ml-auto text-[11px] text-[#7a7a7a] font-semibold">AWAY</div>
        </div>

        <div className="flex items-center gap-3">
          <LogoBox team={home.teamName} url={home.logoUrl} size={44} />
          <TeamNameWithScore name={home.teamName} score={home.projPoints} winProb={home.winProbTeam} isWinner={home.isProjectedWinner} />
          <div className="ml-auto text-[11px] text-[#7a7a7a] font-semibold">HOME</div>
        </div>

        {open && <DetailsBlock away={away} home={home} />}
      </div>
    </div>
  );
}

export function MonteCarloScreen() {
  const [run, setRun] = useState<MonteCarloRun | null>(null);
  const [results, setResults] = useState<MonteCarloResultRow[]>([]);
  const [logoMap, setLogoMap] = useState<Map<string, string>>(new Map());
  const [consensusMap, setConsensusMap] = useState<Map<string, Consensus>>(new Map());

  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});

  const [loadingRun, setLoadingRun] = useState(true);
  const [loadingResults, setLoadingResults] = useState(false);
  const [loadingConsensus, setLoadingConsensus] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 0) logos
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase.from("team_map").select('canonical,"Logo URL"');
      if (!alive) return;

      if (error) {
        console.warn("[MonteCarloScreen] team_map logos failed:", error.message);
        setLogoMap(new Map());
        return;
      }

      const m = new Map<string, string>();
      for (const r of (data ?? []) as TeamMapLogoRow[]) {
        const canon = (r.canonical ?? "").trim();
        const url = (r["Logo URL"] ?? "").trim();
        if (canon && url) m.set(canon, url);
      }
      setLogoMap(m);
    })();

    return () => {
      alive = false;
    };
  }, []);

  // 1) latest run
  useEffect(() => {
    let alive = true;

    (async () => {
      setLoadingRun(true);
      setError(null);

      const { data, error } = await supabase
        .from("monte_carlo_runs")
        .select("id, created_at, sport_key")
        .order("created_at", { ascending: false })
        .limit(1);

      if (!alive) return;

      if (error) {
        setError(error.message);
        setRun(null);
        setResults([]);
        setConsensusMap(new Map());
        setLoadingRun(false);
        return;
      }

      setRun((data?.[0] ?? null) as MonteCarloRun | null);
      setLoadingRun(false);
    })();

    return () => {
      alive = false;
    };
  }, []);

  // 2) results
  useEffect(() => {
    let alive = true;

    async function loadResults(runId: string) {
      setLoadingResults(true);
      setError(null);

      const selectCols = [
        "run_id",
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
        // optional cols:
        "home_win_prob",
        "away_win_prob",
      ].join(",");

      const { data, error } = await supabase
        .from("monte_carlo_results")
        .select(selectCols)
        .eq("run_id", runId)
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

    return () => {
      alive = false;
    };
  }, [run?.id]);

  // 3) consensus from odds_snapshot
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

        // keep latest per (event|market|book|side) because rows are ts desc
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
    if (ids.length) loadConsensus(ids);

    return () => {
      alive = false;
    };
  }, [results]);

  // 4) build per-event bundles (away+home)
  const events: EventBundle[] = useMemo(() => {
    const out: EventBundle[] = [];

    for (const r of results) {
      const home = (r.home_team ?? "").trim();
      const away = (r.away_team ?? "").trim();
      if (!home || !away) continue;

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

      // win probs (if present)
      const pHomeWin = numOrNullable((r as any).home_win_prob);
      const pAwayWin = numOrNullable((r as any).away_win_prob);

      // fallback: if missing, derive a “soft” win prob based on margin direction
      const fallbackHome = pHomeWin == null && pAwayWin == null ? (homePts === awayPts ? 0.5 : homePts > awayPts ? 0.6 : 0.4) : null;
      const finalHomeWin = pHomeWin ?? (pAwayWin != null ? 1 - pAwayWin : fallbackHome);
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
        teamName: away,
        logoUrl: logoMap.get(away) ?? null,

        projPoints: awayPts,
        projMarginTeam: -marginHome,
        coverProbTeam: pAwayCover,

        projTotal: totalProj,
        overProb: pOver,
        underProb: pUnder,

        winProbTeam: finalAwayWin ?? null,

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
        logoUrl: logoMap.get(home) ?? null,

        projPoints: homePts,
        projMarginTeam: marginHome,
        coverProbTeam: pHomeCover,

        projTotal: totalProj,
        overProb: pOver,
        underProb: pUnder,

        winProbTeam: finalHomeWin ?? null,

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
        projTotal: totalProj,
        projMarginHome: marginHome,
      });
    }

    return out;
  }, [results, logoMap, consensusMap]);

  // keep openMap in sync
  useEffect(() => {
    setOpenMap((prev) => {
      const next: Record<string, boolean> = {};
      for (const ev of events) next[ev.eventId] = prev[ev.eventId] ?? false; // default collapsed
      return next;
    });
  }, [events]);

  const loading = loadingRun || loadingResults;

  return (
    <div className="h-[calc(100vh-72px)] flex flex-col gap-4 overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl text-white mb-1">Monte Carlo</h2>
          <p className="text-xs text-[#808080]">
            Latest simulation snapshot
            {run?.created_at ? <span className="ml-2 text-[#5a5a5a]">· Latest run: {formatTs(run.created_at)}</span> : null}
            {loadingConsensus ? <span className="ml-2 text-[#5a5a5a]">· Loading consensus…</span> : null}
          </p>
        </div>
      </div>

      {error ? (
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4 text-xs text-red-300">
          Supabase error: {error}
        </div>
      ) : null}

      {/* Main content */}
      <div className="flex-1 overflow-hidden">
        {/* MOBILE: cards */}
        <div className="md:hidden h-full overflow-y-auto px-3 pb-4 space-y-3">
          {loading ? (
            <div className="text-xs text-[#808080] py-3">Loading Monte Carlo results…</div>
          ) : !events.length ? (
            <div className="text-xs text-[#808080] py-3">No Monte Carlo rows found for latest run.</div>
          ) : (
            events.map((ev) => (
              <EventCardMobile
                key={ev.eventId}
                ev={ev}
                open={!!openMap[ev.eventId]}
                onToggle={() => setOpenMap((p) => ({ ...p, [ev.eventId]: !p[ev.eventId] }))}
              />
            ))
          )}
        </div>

        {/* DESKTOP: table (matchup cell contains dropdown details) */}
        <div className="hidden md:block h-full bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">
          <div className="h-full overflow-y-auto overflow-x-auto">
            {loading ? (
              <div className="p-4 text-xs text-[#808080]">Loading Monte Carlo results…</div>
            ) : !events.length ? (
              <div className="p-4 text-xs text-[#808080]">No Monte Carlo rows found for latest run.</div>
            ) : (
              <table className="w-full table-fixed">
                <colgroup>
                  <col style={{ width: COL_MATCHUP }} />
                  <col />
                </colgroup>

                <thead className="sticky top-0 z-20">
                  <tr className={`border-b ${HDR_BORDER}`}>
                    <th className={["text-left px-3 py-3", HDR_LEFT_BG, HDR_TEXT, "sticky left-0 z-30 text-sm font-extrabold"].join(" ")}>
                      Matchup · Proj Score · Win%
                    </th>
                    <th className={["px-3 py-3", HDR_LEFT_BG, HDR_TEXT, "text-sm font-extrabold border-l", HDR_BORDER].join(" ")}>
                      {/* intentionally blank – keeps layout consistent */}
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {events.map((ev) => (
                    <EventTwoRows
                      key={ev.eventId}
                      ev={ev}
                      open={!!openMap[ev.eventId]}
                      onToggle={() => setOpenMap((p) => ({ ...p, [ev.eventId]: !p[ev.eventId] }))}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


