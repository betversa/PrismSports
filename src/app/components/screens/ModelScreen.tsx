// src/app/components/screens/ModelScreen.tsx — FULL REWRITE (Newest Steam + Gates + Mobile Modal)
// -------------------------------------------------------------------------------------------------------------
// ✅ Aggregated: 1 row per play, shows DK / FD / MGM strip, highlights best book
// ✅ Game +EV plays from public.ev_plays
// ✅ Player prop +EV plays from public.player_prop_ev_latest
//
// ✅ Filters: Play Type + Book (BOOK FILTER OPTIONS = soft books only: Any / DK / FD / MGM)
//
// ✅ STEAM MODE (LINE + PRICE aware; FIXED stale/value logic):
//    Shows plays where Pinnacle is moving AGAINST the bettor (steam) via:
//      A) PRICE steam: Pinnacle odds moved worse on SAME LINE (e.g., -110 → -125 or +120 → +105)
//      B) LINE steam: Pinnacle moved the LINE worse for bettor (favorite -3.5 → -4.5, Over 228.5 → 229.5)
//
//    AND at least one soft book is still BETTER than Pinnacle RIGHT NOW by:
//      - better LINE (spread/total) OR
//      - same line with better PRICE (moneyline/spread/total)
//      - Soft can be on a different line than Pinnacle (THIS IS THE FIX).
//
// ✅ Steam calculations use odds_snapshot_history last-2 per (event,market,side,book) — line changes included.
// ✅ Steam key does NOT include line anymore (event+market+side), so line moves are captured correctly.
//
// ✅ RULES (same as Overview):
//    - Odds gate (book price): only include offers with odds between -200 and +200
//    - Games: positive EV only, cap EV at 15% (NO 2% min gate)
//    - Props: EV must be 2% to 15% (inclusive), AND odds within -200..+200
//    - Pinnacle is history-only (used for steam + line chart), NOT a filter option
//
// ✅ Bet $ uses app_settings.bankroll + app_settings.kelly_factor (best book fraction)
// ✅ ONLY the Pick column (desktop) / Pick block (mobile) opens the modal
// ✅ Modal: NO scrolling required to reach Done (header/footer fixed, safe-area aware)
// ✅ Modal: Tabs: "Line History" + "Hit Rate"
// ✅ Line History: LINE CHART (DK/FD/MGM/PIN) — tooltip shows DATE+TIME (CT) + LINE + ODDS per book
// ✅ Hit Rate tab: FantasyPros GAME LOGS = BAR CHART (OVER green / UNDER red), cursor transparent
//
// ✅ Exports both named + default to avoid import mismatch.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  Cell,
  ReferenceLine,
} from "recharts";

/* =========================================================
   Gates (MATCH Overview rules)
========================================================= */

const ODDS_MIN = -200;
const ODDS_MAX = 200;

const MAX_EV_PCT = 15; // games + props
const MIN_EV_PCT_PROPS = 2; // props only

/* =========================================================
   Types
========================================================= */

type GameMarketKey = "h2h" | "spreads" | "totals";
type GameSideKey = "home" | "away" | "over" | "under";

// Soft book filter (UI) — ONLY these options
type SoftBookFilter = "any" | "draftkings" | "fanduel" | "betmgm";
type SoftOfferKey = Exclude<SoftBookFilter, "any">;

type PlayKind = "all" | "game" | "prop";

type AppSettingsRow = {
  id: number;
  bankroll: number | null;
  kelly_factor: number | null;
  updated_at?: string | null;
};

type EvPlayRow = {
  run_id: string;
  sport_key?: string | null;

  event_id: string;
  commence_time: string | null;
  matchup: string | null;

  team: string | null;

  market: GameMarketKey;
  side: GameSideKey;

  line: number | null;
  bookmaker: string;
  book_odds: number;

  quantum_prob: number;
  quantum_odds: number;
  ev_pct: number;

  confidence_score: number;
  confidence_tier: string;

  kelly_fraction: number;
  bet_fraction: number;

  created_at?: string | null;
};

type PlayerPropEvLatestRow = {
  id: string;
  run_id: string;
  created_at: string | null;

  sport_key: string | null;
  event_id: string;
  commence_time: string | null;

  team: string | null;
  opponent: string | null;

  player_name: string | null;
  position: string | null;
  picture_url: string | null;

  market: string | null;
  side: string | null;
  line: number | null;

  book: string; // "draftkings"/"fanduel"/"betmgm"
  odds: number;

  // model outputs
  mu?: number | null;
  p_quantum: number | null;
  quantum_fair_odds: number;

  ev_pct: number;
  kelly_fraction: number;
  score: number;
};

type AnyBookHistory = "draftkings" | "fanduel" | "betmgm" | "pinnacle";

type BookOffer = {
  book: SoftOfferKey; // offer strip is soft books only
  odds: number;
  ev_pct: number;
  bet_fraction: number;
  line?: number | null; // needed for steam fallback + display
};

type AggregatedPlay = {
  kind: "game" | "prop";
  playKey: string;

  // identity
  sport_key?: string | null;
  event_id: string;
  commence_time: string | null;
  matchup: string | null;

  // display
  marketLabel: string;
  sideLabel: string;
  pickLabel: string;
  lineLabel: string;

  // fair odds
  quantum_odds: number;
  quantum_prob?: number | null;

  // meta for history keys
  gameMeta?: { market: GameMarketKey; side: GameSideKey };
  propMeta?: {
    player_name: string | null;
    market: string | null;
    side: string | null;
    picture_url: string | null;
    position: string | null;
    mu: number | null;
    line: number | null;
  };

  offers: Partial<Record<SoftOfferKey, BookOffer>>;
  bestBook: SoftOfferKey | null;
  bestEvPct: number;
  bestBetFraction: number;
  bestScore: number;

  created_at: string | null;
};

/* =========================================================
   FantasyPros logs (API response type)
========================================================= */

type FantasyProsLogRow = {
  date: string;
  opp: string;
  score: string;
  min: string;
  pts: string;
  reb: string;
  ast: string;
  threes: string;
};

type FantasyProsApiResponse =
  | { ok: true; player_name: string; slug: string; url: string; rows: FantasyProsLogRow[] }
  | { ok: false; error: string; slug?: string; url?: string };

/* =========================================================
   History tables & columns
========================================================= */

const PROPS_HISTORY_TABLE = "player_props_history";
const GAME_HISTORY_TABLE = "odds_snapshot_history";

const TS_COL_PROPS = "ts";
const TS_COL_GAME = "ts";

const BOOK_COL_PROPS = "bookmaker";
const BOOK_COL_GAME = "bookmaker";

const ODDS_COL_PROPS = "odds";
const ODDS_COL_GAME = "odds";

const LINE_COL_GAME = "line";

const PLAYER_COL_PROPS = "player_name";
const MARKET_COL_PROPS = "market";
const SIDE_COL_PROPS = "side";

/* =========================================================
   Books + colors
========================================================= */

const HISTORY_BOOKS: AnyBookHistory[] = ["draftkings", "fanduel", "betmgm", "pinnacle"];

const BOOK_COLOR: Record<AnyBookHistory, string> = {
  draftkings: "#22c55e", // green
  fanduel: "#3b82f6", // blue
  betmgm: "#d4af37", // gold
  pinnacle: "#a855f7", // purple
};

const OVER_GREEN = "#22c55e";
const UNDER_RED = "#ef4444";

/* =========================================================
   Helpers
========================================================= */

function safeNum(n: any, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function american(odds: number) {
  if (!Number.isFinite(odds)) return "—";
  return odds > 0 ? `+${Math.round(odds)}` : `${Math.round(odds)}`;
}

function pct(n: number, digits = 1) {
  const x = safeNum(n, 0);
  return `${x > 0 ? "+" : ""}${x.toFixed(digits)}%`;
}

function formatMoney(n: number) {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
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

function fmtHourMinCT(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDateTimeCT(iso: string) {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} · ${time}`;
}

function fmtMu(mu: number | null | undefined) {
  if (mu == null || !Number.isFinite(mu)) return "—";
  const v = Math.round(mu * 10) / 10;
  return v.toFixed(1);
}

// Soft book normalize for OFFER rows (not history)
function normalizeSoftBookKey(bookmaker: string): SoftOfferKey | "other" {
  const b = (bookmaker || "").toLowerCase();
  if (b === "draftkings" || b === "dk") return "draftkings";
  if (b === "fanduel" || b === "fd") return "fanduel";
  if (b === "betmgm" || b === "mgm") return "betmgm";
  return "other";
}

// History normalize (includes pinnacle)
function normalizeHistoryBookKey(bookmaker: string): AnyBookHistory | "other" {
  const b = (bookmaker || "").toLowerCase();
  if (b === "draftkings" || b === "dk") return "draftkings";
  if (b === "fanduel" || b === "fd") return "fanduel";
  if (b === "betmgm" || b === "mgm") return "betmgm";
  if (b === "pinnacle" || b === "pin") return "pinnacle";
  return "other";
}

function bookShort(book: AnyBookHistory) {
  if (book === "draftkings") return "DK";
  if (book === "fanduel") return "FD";
  if (book === "betmgm") return "MGM";
  return "PIN";
}

function bookLogoSrc(bookmaker: string): string | null {
  const b = (bookmaker || "").toLowerCase();
  if (b === "draftkings" || b === "dk") return "/books/dksquare.png";
  if (b === "fanduel" || b === "fd") return "/books/fdsquare.png";
  if (b === "betmgm" || b === "mgm") return "/books/mgmsquare.png";
  if (b === "pinnacle" || b === "pin") return "/books/pinsquare.png";
  return null;
}

function calcBetAmount(bankroll: number, betFraction: number, kellyFactor: number) {
  const b = Math.max(0, safeNum(bankroll, 0));
  const f = Math.max(0, safeNum(betFraction, 0));
  const k = clamp(safeNum(kellyFactor, 0), 0, 1);
  return b * f * k;
}

function marketLabelGame(market: GameMarketKey) {
  if (market === "h2h") return "Moneyline";
  if (market === "spreads") return "Spread";
  return "Total";
}

function sideLabelGame(market: GameMarketKey, side: GameSideKey) {
  if (market === "totals") return side === "over" ? "Over" : "Under";
  return side === "home" ? "Home" : "Away";
}

function fmtLineGame(market: GameMarketKey, line: number | null) {
  if (market === "h2h") return "—";
  if (line == null || !Number.isFinite(line)) return "—";
  if (market === "spreads") return `${line > 0 ? "+" : ""}${line}`;
  return `${line}`;
}

type PropHistoryMarketKey = "player_points" | "player_rebounds" | "player_assists" | "player_threes";

function historyPropMarketKey(marketRaw: string | null): PropHistoryMarketKey | null {
  const m = (marketRaw || "").trim().toLowerCase();
  if (!m) return null;

  if (m === "player_points") return "player_points";
  if (m === "player_rebounds") return "player_rebounds";
  if (m === "player_assists") return "player_assists";
  if (m === "player_threes") return "player_threes";

  if (m === "points" || m === "pts") return "player_points";
  if (m === "rebounds" || m === "reb") return "player_rebounds";
  if (m === "assists" || m === "ast") return "player_assists";
  if (m === "3pt" || m === "3pm" || m === "threes" || m === "3") return "player_threes";

  if (m.includes("player_points")) return "player_points";
  if (m.includes("player_rebounds")) return "player_rebounds";
  if (m.includes("player_assists")) return "player_assists";
  if (m.includes("player_threes")) return "player_threes";

  return null;
}

function propMarketLabel(marketRaw: string | null) {
  const k = historyPropMarketKey(marketRaw);
  if (k === "player_points") return "Points";
  if (k === "player_rebounds") return "Rebounds";
  if (k === "player_assists") return "Assists";
  if (k === "player_threes") return "3PT";
  return marketRaw ? marketRaw : "Prop";
}

function propSideLabel(sideRaw: string | null) {
  const s = (sideRaw || "").toLowerCase().trim();
  if (s === "over" || s === "o") return "Over";
  if (s === "under" || s === "u") return "Under";
  return sideRaw || "—";
}

function fmtPropLine(line: number | null) {
  if (line == null || !Number.isFinite(line)) return "—";
  const rounded = Math.round(line * 100) / 100;
  return `${rounded}`;
}

function evTone(ev: number) {
  if (ev >= 7) return "text-emerald-400";
  if (ev >= 3) return "text-[#d4af37]";
  return "text-[#b0b0b0]";
}

function scoreTone(score: number) {
  if (score >= 90) return { bg: "bg-[#d4af37]/15", border: "border-[#d4af37]/35", text: "text-[#d4af37]" };
  if (score >= 75) return { bg: "bg-white/5", border: "border-white/10", text: "text-white" };
  return { bg: "bg-white/0", border: "border-white/0", text: "text-[#a0a0a0]" };
}

/* =========================================================
   Gates helpers (same as Overview)
========================================================= */

function withinOddsGate(odds: number) {
  return Number.isFinite(odds) && odds >= ODDS_MIN && odds <= ODDS_MAX;
}

function withinMaxEvGate(ev: number) {
  return Number.isFinite(ev) && ev <= MAX_EV_PCT;
}

function withinPropEvRange(ev: number) {
  return Number.isFinite(ev) && ev >= MIN_EV_PCT_PROPS && ev <= MAX_EV_PCT;
}

/* =========================================================
   Steam: LINE + PRICE aware helpers
========================================================= */

// Odds moved worse for bettor on the SAME line when American number decreases.
// -110 -> -125 (decrease), +120 -> +105 (decrease)
function movedWorsePrice(prevOdds: number, curOdds: number) {
  return Number.isFinite(prevOdds) && Number.isFinite(curOdds) && curOdds < prevOdds;
}

// Spread line "worse for bettor" when numeric value decreases (because higher is always better for bettor on that side):
// +4 > +3, -3 > -4, so decreasing is worse.
function movedWorseSpreadLine(prevLine: number, curLine: number) {
  return Number.isFinite(prevLine) && Number.isFinite(curLine) && curLine < prevLine;
}

// Total line "worse for bettor" depends on side:
// Over: higher total is worse; Under: lower total is worse.
function movedWorseTotalLine(side: GameSideKey, prevLine: number, curLine: number) {
  if (!Number.isFinite(prevLine) || !Number.isFinite(curLine)) return false;
  if (side === "over") return curLine > prevLine;
  if (side === "under") return curLine < prevLine;
  return false;
}

// Is "soft" better for bettor than "pin" RIGHT NOW? (line first, then price if line equal)
function softBetterThanPin(args: {
  market: GameMarketKey;
  side: GameSideKey;
  softLine: number | null;
  softOdds: number;
  pinLine: number | null;
  pinOdds: number;
}) {
  const { market, side, softLine, softOdds, pinLine, pinOdds } = args;

  if (!Number.isFinite(softOdds) || !Number.isFinite(pinOdds)) return false;

  // ML: price only (higher is better)
  if (market === "h2h") return softOdds > pinOdds;

  // Spread:
  if (market === "spreads") {
    const sL = softLine;
    const pL = pinLine;

    if (Number.isFinite(sL) && Number.isFinite(pL)) {
      if ((sL as number) > (pL as number)) return true; // better line
      if ((sL as number) < (pL as number)) return false;
      return softOdds > pinOdds; // same line -> better price
    }
    return softOdds > pinOdds; // fallback
  }

  // Totals:
  const sL = softLine;
  const pL = pinLine;

  if (Number.isFinite(sL) && Number.isFinite(pL)) {
    if (side === "over") {
      if ((sL as number) < (pL as number)) return true; // lower total is better for over
      if ((sL as number) > (pL as number)) return false;
      return softOdds > pinOdds;
    }
    if (side === "under") {
      if ((sL as number) > (pL as number)) return true; // higher total is better for under
      if ((sL as number) < (pL as number)) return false;
      return softOdds > pinOdds;
    }
  }

  return softOdds > pinOdds;
}

// Did Pinnacle "steam" this side recently? line OR price
function pinSteamMoved(args: {
  market: GameMarketKey;
  side: GameSideKey;
  prevLine: number | null;
  curLine: number | null;
  prevOdds: number | null;
  curOdds: number | null;
}) {
  const { market, side, prevLine, curLine, prevOdds, curOdds } = args;

  const prevHasLine = Number.isFinite(prevLine as number);
  const curHasLine = Number.isFinite(curLine as number);
  const sameLine = !prevHasLine || !curHasLine ? true : (prevLine as number) === (curLine as number);

  // Price steam: only apply when same line (or line unknown)
  const priceSteam =
    prevOdds != null &&
    curOdds != null &&
    Number.isFinite(prevOdds) &&
    Number.isFinite(curOdds) &&
    sameLine &&
    movedWorsePrice(prevOdds as number, curOdds as number);

  // Line steam:
  let lineSteam = false;
  if (market === "spreads" && prevHasLine && curHasLine) lineSteam = movedWorseSpreadLine(prevLine as number, curLine as number);
  if (market === "totals" && prevHasLine && curHasLine) lineSteam = movedWorseTotalLine(side, prevLine as number, curLine as number);

  return priceSteam || lineSteam;
}

/* =========================================================
   Dedup keys
========================================================= */

function gamePlayKey(r: EvPlayRow) {
  // Keep line in key for normal aggregation (best EV by line).
  const team = (r.team || "").trim().toLowerCase();
  const line = r.line == null ? "x" : String(r.line);
  return `g|${r.event_id}|${r.market}|${r.side}|${line}|${team}`;
}

function propPlayKey(r: PlayerPropEvLatestRow) {
  const name = (r.player_name || "").trim().toLowerCase();
  const market = (r.market || "").trim().toLowerCase();
  const side = (r.side || "").trim().toLowerCase();
  const line = r.line == null ? "x" : String(r.line);
  return `p|${r.event_id}|${name}|${market}|${side}|${line}`;
}

/* =========================================================
   Best offer (soft books only)
========================================================= */

function chooseBestOffer(offers: Partial<Record<SoftOfferKey, BookOffer>>) {
  const order: SoftOfferKey[] = ["draftkings", "fanduel", "betmgm"];
  const list = order
    .map((b) => (offers[b] ? ({ b, o: offers[b]! }) : null))
    .filter(Boolean) as { b: SoftOfferKey; o: BookOffer }[];

  if (!list.length) return { bestBook: null as const, bestEvPct: 0, bestBetFraction: 0 };

  list.sort((a, b) => {
    const ev = safeNum(b.o.ev_pct, 0) - safeNum(a.o.ev_pct, 0);
    if (ev !== 0) return ev;
    return safeNum(b.o.bet_fraction, 0) - safeNum(a.o.bet_fraction, 0);
  });

  const top = list[0];
  return {
    bestBook: top.b,
    bestEvPct: safeNum(top.o.ev_pct, 0),
    bestBetFraction: clamp(safeNum(top.o.bet_fraction, 0), 0, 1),
  };
}

function sortPlays(a: AggregatedPlay, b: AggregatedPlay) {
  const ta = a.commence_time ? new Date(a.commence_time).getTime() : Number.POSITIVE_INFINITY;
  const tb = b.commence_time ? new Date(b.commence_time).getTime() : Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta - tb;

  const ev = safeNum(b.bestEvPct, 0) - safeNum(a.bestEvPct, 0);
  if (ev !== 0) return ev;

  return safeNum(b.bestScore, 0) - safeNum(a.bestScore, 0);
}

/* =========================================================
   History series (odds + line per book for games)
========================================================= */

type HistoryPoint = {
  ts: string;

  // odds
  draftkings?: number | null;
  fanduel?: number | null;
  betmgm?: number | null;
  pinnacle?: number | null;

  // line
  draftkings_line?: number | null;
  fanduel_line?: number | null;
  betmgm_line?: number | null;
  pinnacle_line?: number | null;
};

function normalizeIso(raw: any): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function collapseGameHistory(rows: any[]): HistoryPoint[] {
  const map = new Map<string, HistoryPoint>();

  for (const r of rows) {
    const ts = normalizeIso(r?.[TS_COL_GAME]);
    if (!ts) continue;

    const book = String(r?.[BOOK_COL_GAME] ?? "").toLowerCase();
    const bk = normalizeHistoryBookKey(book);
    if (bk === "other") continue;

    const odds = Number(r?.[ODDS_COL_GAME]);
    const line = r?.[LINE_COL_GAME] == null ? null : Number(r?.[LINE_COL_GAME]);

    if (!Number.isFinite(odds)) continue;

    const cur = map.get(ts) ?? { ts };
    (cur as any)[bk] = odds;
    (cur as any)[`${bk}_line`] = Number.isFinite(line as number) ? (line as number) : null;

    map.set(ts, cur);
  }

  return Array.from(map.values()).sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

function collapsePropsHistory(rows: any[]) {
  const map = new Map<string, any>();

  for (const r of rows) {
    const ts = normalizeIso(r?.[TS_COL_PROPS]);
    if (!ts) continue;

    const book = String(r?.[BOOK_COL_PROPS] ?? "").toLowerCase();
    const bk = normalizeHistoryBookKey(book);
    if (bk === "other") continue;

    const odds = Number(r?.[ODDS_COL_PROPS]);
    if (!Number.isFinite(odds)) continue;

    const cur = map.get(ts) ?? { ts };
    (cur as any)[bk] = odds;
    map.set(ts, cur);
  }

  return Array.from(map.values()).sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

/* =========================================================
   Steam Eligibility (LINE + PRICE aware; NO line in key)
========================================================= */

type Quote = { line: number | null; odds: number };

type SteamInfo = {
  pinPrev: Quote;
  pinCur: Quote;

  // soft books that are better than pin right now (by line or price)
  // and a snapshot of their latest quote (line+odds)
  lagging: Partial<Record<SoftOfferKey, Quote>>;

  // why pin moved (for tooltip/label)
  pinMove: "line" | "price" | "both";
};

function steamKey(sport_key: string | null | undefined, event_id: string, market: GameMarketKey, side: GameSideKey) {
  return `${String(sport_key ?? "").trim()}|${event_id}|${market}|${side}`;
}

/* =========================================================
   Book filter options (soft only)
========================================================= */

const SOFT_BOOK_FILTERS: { key: SoftBookFilter; label: string }[] = [
  { key: "any", label: "Any (DK/FD/MGM)" },
  { key: "draftkings", label: "DraftKings" },
  { key: "fanduel", label: "FanDuel" },
  { key: "betmgm", label: "BetMGM" },
];

/* =========================================================
   Screen
========================================================= */

export const ModelScreen = () => {
  const [bookFilter, setBookFilter] = useState<SoftBookFilter>("any");
  const [kindFilter, setKindFilter] = useState<PlayKind>("all");

  // Steam mode
  const [steamOnly, setSteamOnly] = useState(true);
  const [steamLookbackHours, setSteamLookbackHours] = useState(48);
  const [steamEligible, setSteamEligible] = useState<Record<string, SteamInfo>>({});
  const [steamLoading, setSteamLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [games, setGames] = useState<EvPlayRow[]>([]);
  const [props, setProps] = useState<PlayerPropEvLatestRow[]>([]);
  const [settings, setSettings] = useState<AppSettingsRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<AggregatedPlay | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const openDetails = (p: AggregatedPlay) => {
    setSelected(p);
    setDetailsOpen(true);
  };
  const closeDetails = () => setDetailsOpen(false);

  // ESC to close modal + lock body scroll
  useEffect(() => {
    if (!detailsOpen) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailsOpen(false);
    };
    window.addEventListener("keydown", onKey);

    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [detailsOpen]);

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError(null);

      const nowIso = new Date().toISOString();

      const evQ = supabase
        .from("ev_plays")
        .select(
          "run_id,sport_key,event_id,commence_time,matchup,team,market,side,line,bookmaker,book_odds,quantum_prob,quantum_odds,ev_pct,confidence_score,confidence_tier,kelly_fraction,bet_fraction,created_at"
        )
        .gte("commence_time", nowIso)
        .gt("ev_pct", 0)
        .in("bookmaker", ["draftkings", "fanduel", "betmgm"])
        .order("commence_time", { ascending: true })
        .order("ev_pct", { ascending: false });

      const propsQ = supabase
        .from("player_prop_ev_latest")
        .select(
          [
            "id",
            "run_id",
            "created_at",
            "sport_key",
            "event_id",
            "commence_time",
            "team",
            "opponent",
            "player_name",
            "position",
            "picture_url",
            "market",
            "side",
            "line",
            "book",
            "odds",
            "mu",
            "p_quantum",
            "quantum_fair_odds",
            "ev_pct",
            "kelly_fraction",
            "score",
          ].join(",")
        )
        .gte("commence_time", nowIso)
        .gt("ev_pct", 0)
        .in("book", ["draftkings", "fanduel", "betmgm"])
        .order("commence_time", { ascending: true })
        .order("ev_pct", { ascending: false });

      const settingsQ = supabase.from("app_settings").select("id,bankroll,kelly_factor,updated_at").eq("id", 1).limit(1);

      const [evRes, prRes, sRes] = await Promise.all([evQ, propsQ, settingsQ]);

      if (!mounted) return;

      if (evRes.error) {
        setError(evRes.error.message);
        setGames([]);
      } else {
        setGames((evRes.data ?? []) as EvPlayRow[]);
      }

      if (prRes.error) {
        console.warn("[ModelScreen] player_prop_ev_latest error:", prRes.error.message);
        setProps([]);
      } else {
        setProps((prRes.data ?? []) as PlayerPropEvLatestRow[]);
      }

      if (sRes.error) {
        console.warn("[ModelScreen] app_settings error:", sRes.error.message);
        setSettings(null);
      } else {
        setSettings((sRes.data?.[0] ?? null) as AppSettingsRow | null);
      }

      setLoading(false);
    }

    load();
    return () => {
      mounted = false;
    };
  }, []);

  const aggregated = useMemo(() => {
    const map = new Map<string, AggregatedPlay>();

    // ---- games (apply gates per offer)
    for (const r of games) {
      const bk = normalizeSoftBookKey(r.bookmaker);
      if (bk === "other") continue;

      const odds = safeNum(r.book_odds, NaN);
      const ev = safeNum(r.ev_pct, NaN);

      // Games: odds gate AND EV cap
      if (!withinOddsGate(odds)) continue;
      if (!withinMaxEvGate(ev)) continue;

      const key = gamePlayKey(r);
      const existing = map.get(key);

      const base: AggregatedPlay =
        existing ??
        ({
          kind: "game",
          playKey: key,

          sport_key: r.sport_key ?? null,
          event_id: r.event_id,
          commence_time: r.commence_time ?? null,
          matchup: r.matchup ?? null,

          marketLabel: marketLabelGame(r.market),
          sideLabel: sideLabelGame(r.market, r.side),
          pickLabel: r.market === "totals" ? (r.matchup ?? "Total") : (r.team ?? "—"),
          lineLabel: fmtLineGame(r.market, r.line),

          quantum_odds: safeNum(r.quantum_odds, NaN),
          quantum_prob: safeNum(r.quantum_prob, NaN),

          gameMeta: { market: r.market, side: r.side },

          offers: {},
          bestBook: null,
          bestEvPct: 0,
          bestBetFraction: 0,
          bestScore: 0,

          created_at: r.created_at ?? null,
        } as AggregatedPlay);

      base.offers[bk] = {
        book: bk,
        odds,
        ev_pct: ev,
        bet_fraction: clamp(safeNum(r.bet_fraction, 0), 0, 1),
        line: r.line ?? null,
      };

      base.bestScore = Math.max(safeNum(base.bestScore, 0), safeNum(r.confidence_score, 0));
      base.created_at = [base.created_at, r.created_at ?? null].filter(Boolean).sort().slice(-1)[0] ?? base.created_at;

      map.set(key, base);
    }

    // ---- props (apply gates per offer)
    for (const r of props) {
      const bk = normalizeSoftBookKey(r.book);
      if (bk === "other") continue;

      const odds = safeNum(r.odds, NaN);
      const ev = safeNum(r.ev_pct, NaN);

      // Props: odds gate AND EV range
      if (!withinOddsGate(odds)) continue;
      if (!withinPropEvRange(ev)) continue;

      const key = propPlayKey(r);
      const existing = map.get(key);

      const base: AggregatedPlay =
        existing ??
        ({
          kind: "prop",
          playKey: key,

          sport_key: r.sport_key ?? null,
          event_id: r.event_id,
          commence_time: r.commence_time ?? null,
          matchup: (() => {
            const a = (r.team || "").trim();
            const b = (r.opponent || "").trim();
            if (a && b) return `${a} vs ${b}`;
            return a || b || "—";
          })(),

          marketLabel: propMarketLabel(r.market),
          sideLabel: propSideLabel(r.side),
          pickLabel: r.player_name ?? "—",
          lineLabel: fmtPropLine(r.line),

          quantum_odds: safeNum(r.quantum_fair_odds, NaN),
          quantum_prob: r.p_quantum ?? null,

          propMeta: {
            player_name: r.player_name ?? null,
            market: r.market ?? null,
            side: r.side ?? null,
            picture_url: r.picture_url ?? null,
            position: r.position ?? null,
            mu: (r.mu ?? null) as number | null,
            line: (r.line ?? null) as number | null,
          },

          offers: {},
          bestBook: null,
          bestEvPct: 0,
          bestBetFraction: 0,
          bestScore: 0,

          created_at: r.created_at ?? null,
        } as AggregatedPlay);

      base.offers[bk] = {
        book: bk,
        odds,
        ev_pct: ev,
        bet_fraction: clamp(safeNum(r.kelly_fraction, 0), 0, 1),
      };

      base.bestScore = Math.max(safeNum(base.bestScore, 0), clamp(safeNum(r.score, 0), 0, 100));
      base.created_at = [base.created_at, r.created_at ?? null].filter(Boolean).sort().slice(-1)[0] ?? base.created_at;

      if (base.propMeta) {
        const nextMu = (r.mu ?? null) as number | null;
        if (nextMu != null && Number.isFinite(nextMu) && (base.propMeta.mu == null || !Number.isFinite(base.propMeta.mu))) {
          base.propMeta.mu = nextMu;
        }

        const nextLine = (r.line ?? null) as number | null;
        if (nextLine != null && Number.isFinite(nextLine) && (base.propMeta.line == null || !Number.isFinite(base.propMeta.line))) {
          base.propMeta.line = nextLine;
        }
      }

      map.set(key, base);
    }

    // finalize: compute best book from remaining gated offers
    const plays = Array.from(map.values())
      .map((p) => {
        const { bestBook, bestEvPct, bestBetFraction } = chooseBestOffer(p.offers);
        return { ...p, bestBook, bestEvPct, bestBetFraction };
      })
      .filter((p) => !!p.bestBook && (p.offers.draftkings || p.offers.fanduel || p.offers.betmgm));

    return plays.sort(sortPlays);
  }, [games, props]);

  /* =========================================================
     Steam computation (games only) — LINE + PRICE aware, no line in key
  ========================================================= */

  useEffect(() => {
    let mounted = true;

    async function computeSteam() {
      const gamePlays = aggregated.filter((p) => p.kind === "game" && p.gameMeta?.market && p.gameMeta?.side);

      if (!gamePlays.length) {
        if (mounted) setSteamEligible({});
        return;
      }

      setSteamLoading(true);

      try {
        const eventIds = Array.from(new Set(gamePlays.map((p) => p.event_id)));
        const sportKeys = Array.from(new Set(gamePlays.map((p) => (p.sport_key ?? "").trim()).filter(Boolean)));

        const lookbackIso = new Date(Date.now() - steamLookbackHours * 3600 * 1000).toISOString();

        const books = ["pinnacle", "draftkings", "fanduel", "betmgm"];
        const chunkSize = 150;
        const chunks: string[][] = [];
        for (let i = 0; i < eventIds.length; i += chunkSize) chunks.push(eventIds.slice(i, i + chunkSize));

        const allRows: any[] = [];

        for (const chunk of chunks) {
          const q = supabase
            .from(GAME_HISTORY_TABLE)
            .select("sport_key,event_id,market,side,line,bookmaker,odds,ts")
            .in("event_id", chunk)
            .in("bookmaker", books)
            .gte("ts", lookbackIso)
            .order("ts", { ascending: true });

          if (sportKeys.length) q.in("sport_key", sportKeys);

          const { data, error } = await q;
          if (error) {
            console.warn("[steam] odds_snapshot_history error:", error.message);
            continue;
          }
          allRows.push(...(data ?? []));
        }

        // last-2 per (sport_key,event_id,market,side,book)
        type Last2 = { prev?: Quote; cur?: Quote };
        const last2 = new Map<string, Last2>();

        function rowKey(r: any, book: AnyBookHistory) {
          return steamKey(r.sport_key, r.event_id, r.market as GameMarketKey, r.side as GameSideKey) + `|${book}`;
        }

        for (const r of allRows) {
          const book = normalizeHistoryBookKey(String(r.bookmaker ?? ""));
          if (book === "other") continue;

          const odds = Number(r.odds);
          const line = r.line == null ? null : Number(r.line);
          if (!Number.isFinite(odds)) continue;

          const key = rowKey(r, book);
          const cur = last2.get(key) ?? {};
          cur.prev = cur.cur;
          cur.cur = { line: Number.isFinite(line as number) ? (line as number) : null, odds };
          last2.set(key, cur);
        }

        const eligible: Record<string, SteamInfo> = {};

        for (const p of gamePlays) {
          const market = p.gameMeta!.market;
          const side = p.gameMeta!.side;
          const k = steamKey(p.sport_key, p.event_id, market, side);

          const pin = last2.get(`${k}|pinnacle`);
          const pinPrev = pin?.prev;
          const pinCur = pin?.cur;

          if (!pinPrev || !pinCur) continue;

          const pinMoved = pinSteamMoved({
            market,
            side,
            prevLine: pinPrev.line,
            curLine: pinCur.line,
            prevOdds: pinPrev.odds,
            curOdds: pinCur.odds,
          });

          if (!pinMoved) continue;

          // Why moved?
          const prevHasLine = Number.isFinite(pinPrev.line as number);
          const curHasLine = Number.isFinite(pinCur.line as number);
          const sameLine = !prevHasLine || !curHasLine ? true : (pinPrev.line as number) === (pinCur.line as number);

          const priceSteam = sameLine && movedWorsePrice(pinPrev.odds, pinCur.odds);

          let lineSteam = false;
          if (market === "spreads" && prevHasLine && curHasLine) lineSteam = movedWorseSpreadLine(pinPrev.line as number, pinCur.line as number);
          if (market === "totals" && prevHasLine && curHasLine) lineSteam = movedWorseTotalLine(side, pinPrev.line as number, pinCur.line as number);

          const pinMove: SteamInfo["pinMove"] = priceSteam && lineSteam ? "both" : lineSteam ? "line" : "price";

          const lagging: SteamInfo["lagging"] = {};

          (["draftkings", "fanduel", "betmgm"] as SoftOfferKey[]).forEach((sb) => {
            const soft = last2.get(`${k}|${sb}`);
            const softCur = soft?.cur;

            // if no soft history rows, fall back to current offer (from aggregation)
            const offer = p.offers[sb];
            const fallbackCur: Quote | null =
              offer && Number.isFinite(offer.odds)
                ? { line: offer.line ?? null, odds: offer.odds }
                : null;

            const curQuote = softCur ?? fallbackCur;
            if (!curQuote) return;

            // Must be within odds gate right now (user is looking to take it)
            if (!withinOddsGate(curQuote.odds)) return;

            // Soft must currently be BETTER than Pinnacle now — by line or price
            const better = softBetterThanPin({
              market,
              side,
              softLine: curQuote.line,
              softOdds: curQuote.odds,
              pinLine: pinCur.line,
              pinOdds: pinCur.odds,
            });

            if (!better) return;

            lagging[sb] = curQuote;
          });

          if (!Object.keys(lagging).length) continue;

          eligible[k] = {
            pinPrev,
            pinCur,
            lagging,
            pinMove,
          };
        }

        if (mounted) setSteamEligible(eligible);
      } finally {
        if (mounted) setSteamLoading(false);
      }
    }

    computeSteam();
    return () => {
      mounted = false;
    };
  }, [aggregated, steamLookbackHours]);

  /* =========================================================
     Filtering
  ========================================================= */

  const filtered = useMemo(() => {
    let list = aggregated;

    // Steam-only mode: show ONLY game plays (props hidden)
    if (steamOnly) {
      list = list.filter((p) => p.kind === "game");
    } else {
      if (kindFilter !== "all") list = list.filter((p) => p.kind === kindFilter);
    }

    // Book filter soft-only
    if (bookFilter !== "any") {
      list = list.filter((p) => !!p.offers[bookFilter]);
    }

    // Steam gating: require eligibility. If a specific soft book is selected,
    // require that book is one of the "better than PIN right now" lagging books.
    if (steamOnly) {
      list = list.filter((p) => {
        const k = steamKey(p.sport_key, p.event_id, p.gameMeta!.market, p.gameMeta!.side);
        const info = steamEligible[k];
        if (!info) return false;
        if (bookFilter !== "any") return !!info.lagging[bookFilter];
        return true;
      });
    }

    return list;
  }, [aggregated, kindFilter, bookFilter, steamOnly, steamEligible]);

  const bankroll = safeNum(settings?.bankroll, 0);
  const kellyFactor = clamp(safeNum(settings?.kelly_factor, 0), 0, 1);
  const settingsReady = !!(bankroll && kellyFactor);

  const headerStats = useMemo(() => {
    const best = filtered[0];
    const bestEv = best ? best.bestEvPct : 0;
    const bestScore = best ? best.bestScore : 0;
    return { bestEv, bestScore };
  }, [filtered]);

  const steamCount = useMemo(() => Object.keys(steamEligible).length, [steamEligible]);

  return (
    <div className="h-[calc(100vh-120px)] md:h-[calc(100vh-140px)] overflow-y-auto pr-1 space-y-4">
      {/* HERO / HEADER */}
      <div className="relative overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#0b0b0b] p-4 md:p-5">
        <div
          className="pointer-events-none absolute inset-0 opacity-100"
          style={{
            background:
              "radial-gradient(700px 260px at 18% 0%, rgba(212,175,55,0.14), transparent 60%), radial-gradient(520px 220px at 86% 10%, rgba(255,255,255,0.05), transparent 60%)",
          }}
        />

        <div className="relative flex flex-col md:flex-row md:items-start md:justify-between gap-4">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-black/40 px-3 py-1 text-[11px] text-[#b0b0b0]">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#d4af37" }} />
              Prism Model Picks
            </div>

            <h2 className="text-lg md:text-xl text-white mt-2 tracking-tight">
              {steamOnly ? "Steam (PIN moved · Soft stale/value)" : "Best +EV Plays"}
            </h2>

            <div className="text-xs text-[#a8a8a8] mt-1 leading-relaxed">
              {steamOnly ? (
                <>
                  Detects <span className="text-white">Pinnacle steam</span> by <span className="text-white">line OR price</span>, then shows
                  soft books that are still <span className="text-white">better than PIN right now</span> (line or price).
                </>
              ) : (
                <>
                  Aggregated to 1 row per play. Tap/click the <span className="text-white">Pick</span> to open details.
                </>
              )}
            </div>

            <div className="text-[11px] text-[#9a9a9a] mt-2 leading-relaxed">
              Gates: Odds {ODDS_MIN} to +{ODDS_MAX} • Games EV ≤ {MAX_EV_PCT}% • Props EV {MIN_EV_PCT_PROPS}–{MAX_EV_PCT}%
              {steamOnly ? <span className="text-[#606060]"> • Steam lookback: {steamLookbackHours}h</span> : null}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <Pill label="Plays" value={loading ? "…" : String(filtered.length)} />
              <Pill label="Best EV" value={loading ? "…" : pct(headerStats.bestEv, 1)} tone={evTone(headerStats.bestEv)} />
              <Pill label="Best Score" value={loading ? "…" : String(Math.round(headerStats.bestScore))} />
              <Pill label="Steam Keys" value={steamLoading ? "…" : String(steamCount)} />
              <Pill label="Bankroll" value={bankroll ? formatMoney(bankroll) : "—"} />
              <Pill label="Kelly" value={settings?.kelly_factor != null ? `${(kellyFactor * 100).toFixed(1)}%` : "—"} />
            </div>
          </div>

          {/* Filters */}
          <div className="w-full md:w-auto">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-1 gap-2">
              <div className="inline-flex items-center bg-black/40 border border-[#2a2a2a] rounded-lg overflow-hidden">
                <KindPill active={kindFilter === "all"} onClick={() => setKindFilter("all")} label="All" disabled={steamOnly} />
                <KindPill active={kindFilter === "game"} onClick={() => setKindFilter("game")} label="Game Lines" disabled={steamOnly} />
                <KindPill active={kindFilter === "prop"} onClick={() => setKindFilter("prop")} label="Player Props" disabled={steamOnly} />
              </div>

              <select
                value={bookFilter}
                onChange={(e) => setBookFilter(e.target.value as SoftBookFilter)}
                className="px-3 py-2 bg-black/40 border border-[#2a2a2a] rounded-lg text-[#d0d0d0] outline-none text-xs"
              >
                {SOFT_BOOK_FILTERS.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.label}
                  </option>
                ))}
              </select>

              <div className="inline-flex items-center justify-between gap-2 bg-black/40 border border-[#2a2a2a] rounded-lg px-3 py-2">
                <div className="text-xs text-[#b0b0b0]">Steam Only</div>
                <button
                  type="button"
                  onClick={() => setSteamOnly((v) => !v)}
                  className={[
                    "px-3 py-1 rounded-md border text-xs",
                    steamOnly ? "bg-[#141414] border-white/10 text-white" : "bg-transparent border-[#2a2a2a] text-[#808080]",
                  ].join(" ")}
                >
                  {steamOnly ? "ON" : "OFF"}
                </button>
              </div>

              {steamOnly ? (
                <div className="inline-flex items-center justify-between gap-2 bg-black/40 border border-[#2a2a2a] rounded-lg px-3 py-2">
                  <div className="text-[11px] text-[#808080]">Lookback</div>
                  <select
                    value={steamLookbackHours}
                    onChange={(e) => setSteamLookbackHours(Number(e.target.value))}
                    className="bg-transparent text-xs text-white outline-none"
                  >
                    {[6, 12, 24, 48, 72].map((h) => (
                      <option key={h} value={h}>
                        {h}h
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="relative mt-4 text-xs text-[#808080] px-3 py-2 bg-black/40 border border-[#2a2a2a] rounded-lg">
            Loading EV plays…
          </div>
        ) : null}

        {steamOnly && steamLoading ? (
          <div className="relative mt-2 text-xs text-[#808080] px-3 py-2 bg-black/40 border border-[#2a2a2a] rounded-lg">
            Computing steam signals from odds_snapshot_history (line + price)…
          </div>
        ) : null}

        {error ? (
          <div className="relative mt-3 text-xs text-red-400 px-3 py-2 bg-black/40 border border-red-900/50 rounded-lg">
            Failed to load ev_plays: {error}
          </div>
        ) : null}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl overflow-hidden">
        <div className="max-h-[70vh] overflow-y-auto">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-20">
                <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                  <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-30 min-w-[360px]">Matchup</th>
                  <th className="text-left p-3 text-[#808080] min-w-[120px]">Market</th>
                  <th className="text-left p-3 text-[#808080] min-w-[320px]">Pick</th>
                  <th className="text-center p-3 text-[#808080] min-w-[90px]">Line</th>
                  <th className="text-center p-3 text-[#808080] min-w-[120px]">Fair Odds</th>
                  <th className="text-center p-3 text-[#808080] min-w-[120px]">DK</th>
                  <th className="text-center p-3 text-[#808080] min-w-[120px]">FD</th>
                  <th className="text-center p-3 text-[#808080] min-w-[120px]">MGM</th>
                  <th className="text-center p-3 text-[#808080] min-w-[110px]">EV</th>
                  <th className="text-center p-3 text-[#808080] min-w-[90px]">Score</th>
                  <th className="text-center p-3 text-[#808080] min-w-[120px]">Bet $</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-[#141414]">
                {filtered.map((p) => {
                  const sInfo =
                    p.kind === "game"
                      ? steamEligible[steamKey(p.sport_key, p.event_id, p.gameMeta!.market, p.gameMeta!.side)]
                      : undefined;

                  return (
                    <PlayRow
                      key={p.playKey}
                      play={p}
                      bankroll={bankroll}
                      kellyFactor={kellyFactor}
                      settingsReady={settingsReady}
                      onOpenDetails={() => openDetails(p)}
                      steamInfo={sInfo}
                      steamOnly={steamOnly}
                    />
                  );
                })}

                {!loading && !filtered.length ? (
                  <tr>
                    <td colSpan={11} className="p-10 text-center text-xs text-[#808080]">
                      No plays found after gates/filters{steamOnly ? " (steam mode)." : "."}
                      <div className="text-[11px] text-[#606060] mt-1">
                        {steamOnly
                          ? "Try increasing lookback hours, or set Steam Only to OFF."
                          : `Check odds (${ODDS_MIN}..+${ODDS_MAX}) and EV caps (Games ≤ ${MAX_EV_PCT}%, Props ${MIN_EV_PCT_PROPS}–${MAX_EV_PCT}%).`}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {!loading && !filtered.length ? (
          <div className="text-xs text-[#808080] px-3 py-10 bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl text-center">
            No plays found after gates/filters{steamOnly ? " (steam mode)." : "."}
          </div>
        ) : null}

        {filtered.map((p) => {
          const sInfo =
            p.kind === "game"
              ? steamEligible[steamKey(p.sport_key, p.event_id, p.gameMeta!.market, p.gameMeta!.side)]
              : undefined;

          return (
            <PlayCard
              key={p.playKey}
              play={p}
              bankroll={bankroll}
              kellyFactor={kellyFactor}
              settingsReady={settingsReady}
              onOpenDetails={() => openDetails(p)}
              steamInfo={sInfo}
              steamOnly={steamOnly}
            />
          );
        })}
      </div>

      <PlayDetailsModal
        open={detailsOpen}
        play={selected}
        onClose={closeDetails}
        bankroll={bankroll}
        kellyFactor={kellyFactor}
        settingsReady={settingsReady}
      />
    </div>
  );
};

/* =========================================================
   Desktop Row (ONLY pick column opens modal)
========================================================= */

function PlayRow({
  play,
  bankroll,
  kellyFactor,
  settingsReady,
  onOpenDetails,
  steamInfo,
  steamOnly,
}: {
  play: AggregatedPlay;
  bankroll: number;
  kellyFactor: number;
  settingsReady: boolean;
  onOpenDetails: () => void;
  steamInfo?: SteamInfo;
  steamOnly: boolean;
}) {
  const betAmount = settingsReady ? calcBetAmount(bankroll, play.bestBetFraction, kellyFactor) : NaN;
  const score = Math.round(safeNum(play.bestScore, 0));
  const sTone = scoreTone(score);
  const bestOffer = play.bestBook ? play.offers[play.bestBook] : null;

  const steamBadge =
    steamOnly && play.kind === "game" && steamInfo ? (
      <div
        className="mt-1 inline-flex items-center gap-2 rounded-md border border-[#a855f7]/30 bg-[#a855f7]/10 px-2 py-0.5 text-[10px] text-[#d8b4fe]"
        title={`PIN moved (${steamInfo.pinMove}). PIN: ${steamInfo.pinPrev.line != null ? fmtLineGame(play.gameMeta!.market, steamInfo.pinPrev.line) + " " : ""}${american(
          steamInfo.pinPrev.odds
        )} → ${steamInfo.pinCur.line != null ? fmtLineGame(play.gameMeta!.market, steamInfo.pinCur.line) + " " : ""}${american(steamInfo.pinCur.odds)} | Soft better now: ${Object.keys(
          steamInfo.lagging
        ).join(", ")}`}
      >
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: BOOK_COLOR.pinnacle }} />
        <span>Steam</span>
        <span className="text-[#808080]">·</span>
        <span className="text-[#d0d0d0]">
          PIN {steamInfo.pinCur.line != null ? fmtLineGame(play.gameMeta!.market, steamInfo.pinCur.line) + " " : ""}
          {american(steamInfo.pinCur.odds)}
        </span>
      </div>
    ) : null;

  return (
    <tr className="transition-colors hover:bg-white/[0.02]">
      <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10 min-w-[360px]">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-white truncate">
              {play.matchup ?? "—"}
              <span className="text-[#404040]"> · </span>
              <span className="text-[#b0b0b0]">{fmtDateCentral(play.commence_time)}</span>
              <span className="text-[#404040]"> </span>
              <span className="text-[#b0b0b0]">{fmtTimeCentral(play.commence_time)}</span>

              {play.kind === "prop" ? (
                <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-[#d4af37]/15 border border-[#d4af37]/25 text-[10px] text-[#d4af37]">
                  PROP
                </span>
              ) : null}
            </div>
            <div className="text-[10px] text-[#606060] mt-0.5 truncate">
              Event: <span className="text-[#404040]">{play.event_id}</span>
            </div>
            {steamBadge}
          </div>

          {bestOffer ? (
            <div
              className="shrink-0 inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1"
              title={`Best book: ${bestOffer.book.toUpperCase()} (${pct(bestOffer.ev_pct, 1)})`}
            >
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: BOOK_COLOR[bestOffer.book as AnyBookHistory] }} />
              <span className="text-[10px] text-[#b0b0b0]">
                {bestOffer.book === "betmgm" ? "MGM" : bestOffer.book === "fanduel" ? "FD" : "DK"}
              </span>
            </div>
          ) : null}
        </div>
      </td>

      <td className="p-3 text-left">
        <div className="text-white">{play.marketLabel}</div>
        <div className="text-[10px] text-[#606060] mt-0.5">{play.sideLabel}</div>
      </td>

      {/* PICK (clickable) */}
      <td className="p-3 text-left">
        <button type="button" onClick={onOpenDetails} className="w-full text-left hover:opacity-90" title="Open details">
          {play.kind === "prop" ? (
            <PropPickInline
              name={play.pickLabel}
              position={play.propMeta?.position ?? null}
              picture_url={play.propMeta?.picture_url ?? null}
              sub={`${play.marketLabel} · ${play.sideLabel} ${play.lineLabel}`}
              mu={play.propMeta?.mu ?? null}
            />
          ) : (
            <div className="min-w-0">
              <div className="text-white truncate">{play.pickLabel}</div>
              <div className="text-[10px] text-[#606060] mt-0.5 truncate">
                {play.marketLabel} · {play.sideLabel} {play.lineLabel !== "—" ? play.lineLabel : ""}
              </div>

              {/* In steam mode, show soft-vs-pin line/price if available */}
              {steamOnly && steamInfo ? (
                <div className="text-[10px] text-[#808080] mt-1 truncate">
                  PIN now:{" "}
                  <span className="text-[#d8b4fe]">
                    {steamInfo.pinCur.line != null ? fmtLineGame(play.gameMeta!.market, steamInfo.pinCur.line) + " " : ""}
                    {american(steamInfo.pinCur.odds)}
                  </span>
                  <span className="text-[#404040]"> · </span>
                  Soft better:{" "}
                  <span className="text-white">
                    {Object.entries(steamInfo.lagging)
                      .map(([b, q]) => {
                        const tag = b === "draftkings" ? "DK" : b === "fanduel" ? "FD" : "MGM";
                        const line = q?.line != null ? fmtLineGame(play.gameMeta!.market, q.line) + " " : "";
                        return `${tag} ${line}${american(q!.odds)}`;
                      })
                      .join(" · ")}
                  </span>
                </div>
              ) : null}
            </div>
          )}
        </button>
      </td>

      <td className="p-3 text-center">
        <div className="text-white tabular-nums">{play.lineLabel}</div>
      </td>

      <td className="p-3 text-center">
        <div className="text-white font-semibold tabular-nums">{american(play.quantum_odds)}</div>
      </td>

      <td className="p-3 text-center">
        <BookOfferCell offer={play.offers.draftkings} isBest={play.bestBook === "draftkings"} />
      </td>
      <td className="p-3 text-center">
        <BookOfferCell offer={play.offers.fanduel} isBest={play.bestBook === "fanduel"} />
      </td>
      <td className="p-3 text-center">
        <BookOfferCell offer={play.offers.betmgm} isBest={play.bestBook === "betmgm"} />
      </td>

      <td className="p-3 text-center">
        <div className={["font-semibold tabular-nums", evTone(play.bestEvPct)].join(" ")}>{pct(play.bestEvPct, 1)}</div>
      </td>

      <td className="p-3 text-center">
        <div className={["inline-flex items-center justify-center px-2 py-0.5 rounded border text-[11px] tabular-nums", sTone.bg, sTone.border, sTone.text].join(" ")}>
          {score}
        </div>
      </td>

      <td className="p-3 text-center">
        <BetAmountValue amount={betAmount} ready={settingsReady} />
      </td>
    </tr>
  );
}

/* =========================================================
   Mobile Card (ONLY pick block opens modal)
========================================================= */

function PlayCard({
  play,
  bankroll,
  kellyFactor,
  settingsReady,
  onOpenDetails,
  steamInfo,
  steamOnly,
}: {
  play: AggregatedPlay;
  bankroll: number;
  kellyFactor: number;
  settingsReady: boolean;
  onOpenDetails: () => void;
  steamInfo?: SteamInfo;
  steamOnly: boolean;
}) {
  const betAmount = settingsReady ? calcBetAmount(bankroll, play.bestBetFraction, kellyFactor) : 0;
  const mu = play.propMeta?.mu ?? null;
  const score = Math.round(safeNum(play.bestScore, 0));
  const sTone = scoreTone(score);

  const steamBadge =
    steamOnly && play.kind === "game" && steamInfo ? (
      <div className="mt-2 inline-flex items-center gap-2 rounded-md border border-[#a855f7]/30 bg-[#a855f7]/10 px-2 py-1 text-[11px] text-[#d8b4fe]">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: BOOK_COLOR.pinnacle }} />
        <span>
          PIN moved ({steamInfo.pinMove}) to{" "}
          <span className="text-white">
            {steamInfo.pinCur.line != null ? fmtLineGame(play.gameMeta!.market, steamInfo.pinCur.line) + " " : ""}
            {american(steamInfo.pinCur.odds)}
          </span>
        </span>
      </div>
    ) : null;

  return (
    <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-white text-sm truncate">
            {play.matchup ?? "—"}
            {play.kind === "prop" ? (
              <span className="ml-2 align-middle inline-flex items-center px-1.5 py-0.5 rounded bg-[#d4af37]/15 border border-[#d4af37]/25 text-[10px] text-[#d4af37]">
                PROP
              </span>
            ) : null}
          </div>
          <div className="text-[11px] text-[#808080] mt-1">
            {fmtDateCentral(play.commence_time)} · {fmtTimeCentral(play.commence_time)}
          </div>
          {steamBadge}
        </div>

        <div className="shrink-0 text-right">
          <div className="inline-flex items-center gap-2">
            <div className={["inline-flex items-center justify-center px-2 py-0.5 rounded border text-[11px] tabular-nums", sTone.bg, sTone.border, sTone.text].join(" ")}>
              {score}
            </div>
            <div className="text-right">
              <div className="text-[10px] text-[#606060]">Bet</div>
              <div className="text-[#d4af37] font-semibold tabular-nums">{settingsReady && betAmount > 0 ? formatMoney(betAmount) : "—"}</div>
            </div>
          </div>
        </div>
      </div>

      {/* PICK (clickable) */}
      <button type="button" onClick={onOpenDetails} className="mt-3 w-full text-left hover:opacity-90" title="Open details">
        {play.kind === "prop" ? (
          <div className="flex items-center gap-3">
            <PropAvatar url={play.propMeta?.picture_url ?? null} name={play.pickLabel} />
            <div className="min-w-0">
              <div className="text-white text-sm truncate">
                {play.pickLabel}
                {play.propMeta?.position ? <span className="text-[#808080]"> · {play.propMeta.position}</span> : null}
              </div>
              <div className="text-[11px] text-[#808080] mt-0.5 truncate">
                {play.marketLabel} · {play.sideLabel} {play.lineLabel}
              </div>
              <div className="text-[11px] text-[#b0b0b0] mt-0.5">
                Projection: <span className="text-white tabular-nums">{fmtMu(mu)}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="min-w-0">
            <div className="text-white text-sm truncate">
              {play.pickLabel}{" "}
              <span className="text-[#808080] text-xs">
                · {play.marketLabel} · {play.sideLabel} {play.lineLabel !== "—" ? play.lineLabel : ""}
              </span>
            </div>

            {steamOnly && steamInfo ? (
              <div className="text-[11px] text-[#808080] mt-1 truncate">
                Soft better:{" "}
                <span className="text-white">
                  {Object.entries(steamInfo.lagging)
                    .map(([b, q]) => {
                      const tag = b === "draftkings" ? "DK" : b === "fanduel" ? "FD" : "MGM";
                      const line = q?.line != null ? fmtLineGame(play.gameMeta!.market, q.line) + " " : "";
                      return `${tag} ${line}${american(q!.odds)}`;
                    })
                    .join(" · ")}
                </span>
              </div>
            ) : null}
          </div>
        )}
      </button>

      {/* Offers strip */}
      <div className="mt-3 grid grid-cols-4 gap-2 items-stretch">
        <StatChip label="Fair" value={american(play.quantum_odds)} accent />
        <BookChip offer={play.offers.draftkings} isBest={play.bestBook === "draftkings"} />
        <BookChip offer={play.offers.fanduel} isBest={play.bestBook === "fanduel"} />
        <BookChip offer={play.offers.betmgm} isBest={play.bestBook === "betmgm"} />
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] text-[#606060]">EV (best)</div>
          <div className={["font-semibold tabular-nums", evTone(play.bestEvPct)].join(" ")}>{pct(play.bestEvPct, 1)}</div>
        </div>

        <div className="text-[10px] text-[#606060]">Tap pick for charts</div>
      </div>
    </div>
  );
}

/* =========================================================
   Details Modal (tabs; safe-area; no scroll-to-footer)
========================================================= */

type ModalTab = "line" | "hit";

function PlayDetailsModal({
  open,
  play,
  onClose,
}: {
  open: boolean;
  play: AggregatedPlay | null;
  onClose: () => void;
  bankroll: number;
  kellyFactor: number;
  settingsReady: boolean;
}) {
  const [tab, setTab] = useState<ModalTab>("line");

  useEffect(() => {
    if (open) setTab("line");
  }, [open, play?.playKey]);

  if (!open || !play) return null;

  const canShowHitRate = play.kind === "prop";

  return (
    <div className="fixed inset-0 z-[100]">
      <button type="button" onClick={onClose} className="absolute inset-0 bg-black/70" aria-label="Close details modal" />

      <div
        className="absolute inset-0 flex items-end md:items-center md:justify-center"
        style={{
          paddingTop: "max(env(safe-area-inset-top), 12px)",
          paddingBottom: "max(env(safe-area-inset-bottom), 12px)",
        }}
      >
        <div
          className="relative w-full md:max-w-4xl bg-[#0b0b0b] border border-[#2a2a2a] md:rounded-2xl rounded-t-2xl overflow-hidden flex flex-col"
          style={{ maxHeight: "min(92vh, 920px)" }}
        >
          {/* Header */}
          <div className="shrink-0 p-4 border-b border-[#1f1f1f] bg-[#0a0a0a]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-white text-sm md:text-base truncate">
                  {play.matchup ?? "—"}{" "}
                  {play.kind === "prop" ? (
                    <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-[#d4af37]/15 border border-[#d4af37]/25 text-[10px] text-[#d4af37]">
                      PROP
                    </span>
                  ) : null}
                </div>
                <div className="text-[11px] text-[#808080] mt-1">
                  {fmtDateCentral(play.commence_time)} · {fmtTimeCentral(play.commence_time)} ·{" "}
                  <span className="text-[#606060]">{play.event_id}</span>
                </div>

                <div className="mt-2 text-white flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[#d4af37]">{play.marketLabel}</span>
                  <span className="text-[#404040]">·</span>
                  <span className="text-white">{play.pickLabel}</span>
                  <span className="text-[#808080]">
                    · {play.sideLabel} {play.lineLabel !== "—" ? play.lineLabel : ""}
                  </span>
                </div>

                {play.kind === "prop" ? (
                  <div className="mt-1 text-[11px] text-[#b0b0b0]">
                    Projection: <span className="text-white tabular-nums">{fmtMu(play.propMeta?.mu ?? null)}</span>
                  </div>
                ) : null}
              </div>
            </div>

            {/* Tabs */}
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="inline-flex items-center rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] overflow-hidden">
                <TabButton active={tab === "line"} onClick={() => setTab("line")} label="Line History" />
                <TabButton active={tab === "hit"} onClick={() => setTab("hit")} label="Hit Rate" disabled={!canShowHitRate} />
              </div>

              <div className="hidden sm:flex flex-wrap items-center gap-2 text-[11px] text-[#808080]">
                <LegendDot label="DK" color={BOOK_COLOR.draftkings} />
                <LegendDot label="FD" color={BOOK_COLOR.fanduel} />
                <LegendDot label="MGM" color={BOOK_COLOR.betmgm} />
                <LegendDot label="PIN" color={BOOK_COLOR.pinnacle} />
                <span className="text-[#404040]">·</span>
                <span>Tooltip includes line + odds</span>
              </div>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 min-h-0 p-4">{tab === "line" ? <OddsHistoryPanel play={play} /> : <HitRatePanel play={play} />}</div>

          {/* Footer */}
          <div className="shrink-0 p-4 border-t border-[#1f1f1f] bg-[#0a0a0a]">
            <button
              type="button"
              onClick={onClose}
              className="w-full md:w-auto md:ml-auto md:flex md:justify-end px-4 py-2 rounded-lg bg-[#111] border border-[#2a2a2a] text-[12px] text-[#d0d0d0] hover:bg-[#141414]"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, label, disabled }: { active: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!!disabled}
      className={[
        "px-3 py-2 text-xs transition-colors",
        disabled ? "text-[#4a4a4a] cursor-not-allowed" : active ? "bg-[#141414] text-white" : "bg-transparent text-[#808080] hover:text-white hover:bg-[#111]",
      ].join(" ")}
      title={disabled ? "Hit Rate available for props only" : label}
    >
      {label}
    </button>
  );
}

/* =========================================================
   Line History Panel — games show ALL lines (tooltip includes line)
========================================================= */

function OddsHistoryPanel({ play }: { play: AggregatedPlay }) {
  const [series, setSeries] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [debug, setDebug] = useState<string>("");

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setSeries([]);
      setDebug("");

      try {
        if (play.kind === "prop") {
          const player_name = (play.propMeta?.player_name ?? play.pickLabel ?? "").trim();
          const marketKey = historyPropMarketKey(play.propMeta?.market ?? null);

          const sideRaw = (play.propMeta?.side ?? "").trim().toLowerCase();
          const sideCanon = sideRaw === "o" ? "over" : sideRaw === "u" ? "under" : sideRaw;

          if (!player_name || !marketKey || !["over", "under"].includes(sideCanon)) {
            if (mounted) {
              setDebug(`props keys missing: player="${player_name || "—"}" marketKey="${marketKey || "null"}" side="${sideCanon || "null"}"`);
            }
            return;
          }

          const { data, error } = await supabase
            .from(PROPS_HISTORY_TABLE)
            .select(`${PLAYER_COL_PROPS},${MARKET_COL_PROPS},${SIDE_COL_PROPS},${BOOK_COL_PROPS},${ODDS_COL_PROPS},${TS_COL_PROPS}`)
            .eq(PLAYER_COL_PROPS, player_name)
            .eq(MARKET_COL_PROPS, marketKey)
            .eq(SIDE_COL_PROPS, sideCanon)
            .in(BOOK_COL_PROPS, HISTORY_BOOKS)
            .order(TS_COL_PROPS, { ascending: true });

          if (!mounted) return;

          if (error) {
            setDebug(`props history error: ${error.message}`);
            setSeries([]);
            return;
          }

          const pts = collapsePropsHistory(data ?? []).map((p: any) => ({
            ts: p.ts,
            draftkings: p.draftkings ?? null,
            fanduel: p.fanduel ?? null,
            betmgm: p.betmgm ?? null,
            pinnacle: p.pinnacle ?? null,
          })) as any;

          setSeries(pts);

          if (!pts.length) {
            setDebug(`no rows (props): player="${player_name}" marketKey="${marketKey}" side="${sideCanon}" books=${HISTORY_BOOKS.join(",")}`);
          }
          return;
        }

        // game history: pull ALL rows for event+market+side (NO line filter!)
        const sport_key = (play.sport_key ?? "").trim();
        const event_id = play.event_id;
        const market = play.gameMeta?.market ?? null;
        const side = play.gameMeta?.side ?? null;

        if (!sport_key || !event_id || !market || !side) {
          if (mounted) setDebug(`game keys missing: sport_key=${!!sport_key} event_id=${!!event_id} market=${market ?? "null"} side=${side ?? "null"}`);
          return;
        }

        const { data, error } = await supabase
          .from(GAME_HISTORY_TABLE)
          .select(`sport_key,event_id,market,side,line,${BOOK_COL_GAME},${ODDS_COL_GAME},${TS_COL_GAME}`)
          .eq("sport_key", sport_key)
          .eq("event_id", event_id)
          .eq("market", market)
          .eq("side", side)
          .in(BOOK_COL_GAME, HISTORY_BOOKS)
          .order(TS_COL_GAME, { ascending: true });

        if (!mounted) return;

        if (error) {
          setDebug(`game history error: ${error.message}`);
          setSeries([]);
          return;
        }

        const pts = collapseGameHistory(data ?? []);
        setSeries(pts);

        if (!pts.length) {
          setDebug(`no rows: sport_key="${sport_key}" event_id="${event_id}" market="${market}" side="${side}" books=${HISTORY_BOOKS.join(",")}`);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [play.playKey]);

  const hasAny = (k: AnyBookHistory) => series.some((p) => Number.isFinite((p as any)[k]));

  const TooltipContent = (props: any) => {
    const { active, payload, label } = props;
    if (!active || !payload?.length) return null;

    const ts = String(label ?? "");

    const order: AnyBookHistory[] = ["draftkings", "fanduel", "betmgm", "pinnacle"];
    const rows = order
      .map((k) => {
        const found = payload.find((p: any) => p.dataKey === k);
        const odds = found?.value;
        if (!Number.isFinite(Number(odds))) return null;

        const lineField = `${k}_line`;
        const lineVal = (found?.payload as any)?.[lineField];

        const lineText =
          play.kind === "game" && play.gameMeta && play.gameMeta.market !== "h2h" && Number.isFinite(Number(lineVal))
            ? fmtLineGame(play.gameMeta.market, Number(lineVal))
            : null;

        return { k, odds: Number(odds), lineText };
      })
      .filter(Boolean) as { k: AnyBookHistory; odds: number; lineText: string | null }[];

    return (
      <div
        style={{
          background: "#0b0b0b",
          border: "1px solid #2a2a2a",
          padding: "10px",
          borderRadius: 10,
          color: "#d0d0d0",
          minWidth: 260,
          boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: "#fff", marginBottom: 6 }}>{fmtDateTimeCT(ts)}</div>

        <div style={{ fontSize: 11, color: "#b0b0b0", marginBottom: 8, lineHeight: 1.35 }}>
          <div style={{ color: "#ffffff" }}>{play.matchup ?? "—"}</div>
          <div>
            <span style={{ color: "#d4af37" }}>{play.marketLabel}</span> <span style={{ color: "#606060" }}>·</span>{" "}
            <span style={{ color: "#d0d0d0" }}>
              {play.sideLabel} {play.kind === "prop" ? play.lineLabel : ""}
            </span>
          </div>
        </div>

        <div style={{ display: "grid", gap: 4 }}>
          {rows.map(({ k, odds, lineText }) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span style={{ fontSize: 11, color: BOOK_COLOR[k] }}>{bookShort(k)}</span>
              <span style={{ fontSize: 11, color: "#fff", fontVariantNumeric: "tabular-nums" }}>
                {play.kind === "game" && lineText ? `${lineText}  ${american(odds)}` : american(odds)}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const chartHeightClass = "h-[min(44vh,360px)]";

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="text-[10px] text-[#606060] mb-2">Line Movement (odds chart; tooltip includes line)</div>

      {loading && !series.length ? (
        <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl p-4">
          <div className="text-xs text-[#808080]">Loading line movement…</div>
        </div>
      ) : null}

      {!loading && !series.length ? (
        <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl p-4">
          <div className="text-xs text-[#808080]">No odds history available for this side.</div>
          {debug ? <div className="mt-2 text-[10px] text-[#404040] break-words">{debug}</div> : null}
        </div>
      ) : null}

      {!!series.length ? (
        <div className={["bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl p-3", chartHeightClass].join(" ")}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series}>
              <CartesianGrid stroke="#1f1f1f" strokeDasharray="3 3" />
              <XAxis
                dataKey="ts"
                tickFormatter={fmtHourMinCT}
                tick={{ fontSize: 10, fill: "#808080" }}
                axisLine={{ stroke: "#2a2a2a" }}
                tickLine={{ stroke: "#2a2a2a" }}
                minTickGap={18}
              />
              <YAxis
                tickFormatter={(v) => american(Number(v))}
                tick={{ fontSize: 10, fill: "#808080" }}
                axisLine={{ stroke: "#2a2a2a" }}
                tickLine={{ stroke: "#2a2a2a" }}
                width={58}
                domain={["auto", "auto"]}
              />

              <Tooltip content={TooltipContent} />
              <Legend
                wrapperStyle={{ fontSize: 11, color: "#808080" }}
                formatter={(value: any) => <span style={{ color: "#b0b0b0" }}>{String(value)}</span>}
              />

              {hasAny("draftkings") ? <Line type="monotone" dataKey="draftkings" name="DK" stroke={BOOK_COLOR.draftkings} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} /> : null}
              {hasAny("fanduel") ? <Line type="monotone" dataKey="fanduel" name="FD" stroke={BOOK_COLOR.fanduel} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} /> : null}
              {hasAny("betmgm") ? <Line type="monotone" dataKey="betmgm" name="MGM" stroke={BOOK_COLOR.betmgm} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} /> : null}
              {hasAny("pinnacle") ? <Line type="monotone" dataKey="pinnacle" name="PIN" stroke={BOOK_COLOR.pinnacle} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} /> : null}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : null}

      {debug && series.length ? <div className="mt-2 text-[10px] text-[#404040] break-words">{debug}</div> : null}
    </div>
  );
}

/* =========================================================
   Hit Rate Panel — props only
========================================================= */

function HitRatePanel({ play }: { play: AggregatedPlay }) {
  if (play.kind !== "prop") {
    return (
      <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl p-4">
        <div className="text-xs text-[#808080]">Hit Rate is available for player props only.</div>
      </div>
    );
  }
  return <FantasyProsGameLogs play={play} />;
}

function FantasyProsGameLogs({ play }: { play: AggregatedPlay }) {
  const [rows, setRows] = useState<FantasyProsLogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [debug, setDebug] = useState<string>("");

  const todayLine = play.propMeta?.line ?? null;

  useEffect(() => {
    let mounted = true;

    async function load() {
      const playerName = (play.propMeta?.player_name ?? play.pickLabel ?? "").trim();
      if (!playerName) {
        setRows([]);
        setDebug("No player name available for FantasyPros lookup.");
        return;
      }

      setLoading(true);
      setDebug("");
      setRows([]);

      try {
        const url = `/api/fantasypros-gamelog?player_name=${encodeURIComponent(playerName)}`;
        const res = await fetch(url);
        const json = (await res.json()) as FantasyProsApiResponse;

        if (!mounted) return;

        if (!json.ok) {
          setRows([]);
          setDebug(`FantasyPros logs error: ${json.error}${json.url ? ` (${json.url})` : ""}`);
          return;
        }

        setRows(json.rows ?? []);
        if (!(json.rows ?? []).length) {
          setDebug(`FantasyPros logs: parsed 0 rows (${json.url})`);
        }
      } catch (e: any) {
        if (!mounted) return;
        setDebug(`FantasyPros logs error: ${e?.message ?? String(e)}`);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [play.playKey]);

  const marketKey = historyPropMarketKey(play.propMeta?.market ?? null);

  const statKey: "pts" | "reb" | "ast" | "threes" =
    marketKey === "player_rebounds" ? "reb" : marketKey === "player_assists" ? "ast" : marketKey === "player_threes" ? "threes" : "pts";

  const statLabel = statKey === "reb" ? "REB" : statKey === "ast" ? "AST" : statKey === "threes" ? "3PM" : "PTS";

  const chartData = useMemo(() => {
    const last = (rows ?? []).slice(0, 10).slice().reverse();
    return last.map((r) => ({
      date: r.date,
      opp: r.opp,
      score: r.score,
      min: safeNum(r.min, 0),
      pts: safeNum(r.pts, 0),
      reb: safeNum(r.reb, 0),
      ast: safeNum(r.ast, 0),
      threes: safeNum(r.threes, 0),
    }));
  }, [rows]);

  const LogsTooltip = (props: any) => {
    const { active, payload, label } = props;
    if (!active || !payload?.length) return null;

    const d = payload[0]?.payload;
    if (!d) return null;

    const v = safeNum(d[statKey], NaN);
    const line = todayLine != null && Number.isFinite(todayLine) ? todayLine : null;
    const overUnder = line != null && Number.isFinite(v) ? (v >= line ? "OVER" : "UNDER") : undefined;

    return (
      <div
        style={{
          background: "#0b0b0b",
          border: "1px solid #2a2a2a",
          padding: "10px",
          borderRadius: 10,
          color: "#d0d0d0",
          minWidth: 240,
          boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: "#fff", marginBottom: 6 }}>{label}</div>

        <div style={{ fontSize: 11, color: "#b0b0b0", lineHeight: 1.35 }}>
          <div>
            vs <span style={{ color: "#fff" }}>{d.opp}</span> · <span style={{ color: "#808080" }}>{d.score}</span>
          </div>

          <div style={{ marginTop: 8, display: "grid", gap: 2 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#808080" }}>MIN</span>
              <span style={{ color: "#fff" }}>{d.min}</span>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#808080" }}>{statLabel}</span>
              <span style={{ color: "#fff" }}>{Number.isFinite(v) ? v : "—"}</span>
            </div>

            {line != null ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#808080" }}>Today Line</span>
                  <span style={{ color: "#fff" }}>{line}</span>
                </div>
                {overUnder ? <div style={{ marginTop: 4, fontSize: 11, color: overUnder === "OVER" ? OVER_GREEN : UNDER_RED }}>{overUnder}</div> : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const activeBarStyle = { stroke: "#ffffff", strokeWidth: 1, fillOpacity: 1 };
  const chartWrapClass = "h-[min(44vh,340px)]";

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="text-[10px] text-[#606060]">FantasyPros Game Logs</div>
        {loading ? <div className="text-[10px] text-[#606060]">Loading…</div> : null}
      </div>

      {chartData.length ? (
        <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl p-3">
          <div className="text-[10px] text-[#606060] mb-2">
            Last {chartData.length} games · {statLabel} bars
            {todayLine != null && Number.isFinite(todayLine) ? <span className="text-[#808080]"> · Today Line {todayLine}</span> : null}
          </div>

          <div className={chartWrapClass}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} barCategoryGap={12}>
                <CartesianGrid stroke="#1f1f1f" strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#808080" }} axisLine={{ stroke: "#2a2a2a" }} tickLine={{ stroke: "#2a2a2a" }} minTickGap={12} />
                <YAxis tick={{ fontSize: 10, fill: "#808080" }} axisLine={{ stroke: "#2a2a2a" }} tickLine={{ stroke: "#2a2a2a" }} width={36} />

                <Tooltip content={LogsTooltip} cursor={{ fill: "rgba(0,0,0,0)" }} />

                {todayLine != null && Number.isFinite(todayLine) ? (
                  <ReferenceLine
                    y={todayLine}
                    stroke="#d0d0d0"
                    strokeDasharray="4 4"
                    ifOverflow="extendDomain"
                    label={{ value: "Today Line", position: "right", fill: "#808080", fontSize: 10 }}
                  />
                ) : null}

                <Bar dataKey={statKey} name={statLabel} isAnimationActive={false} activeBar={activeBarStyle}>
                  {chartData.map((d, idx) => {
                    const v = safeNum((d as any)[statKey], NaN);
                    const line = todayLine != null && Number.isFinite(todayLine) ? todayLine : null;
                    const isOver = line != null && Number.isFinite(v) ? v >= line : true;
                    return <Cell key={idx} fill={isOver ? OVER_GREEN : UNDER_RED} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : (
        <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl p-4">
          <div className="text-xs text-[#808080]">No game logs available.</div>
          {debug ? <div className="mt-2 text-[10px] text-[#404040] break-words">{debug}</div> : null}
        </div>
      )}
    </div>
  );
}

/* =========================================================
   UI atoms
========================================================= */

function KindPill({ active, onClick, label, disabled }: { active: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={!!disabled}
      className={[
        "px-3 py-2 text-xs transition-colors",
        disabled ? "bg-transparent text-[#404040] cursor-not-allowed" : active ? "bg-[#141414] text-white" : "bg-transparent text-[#808080] hover:text-white hover:bg-[#111]",
      ].join(" ")}
      type="button"
    >
      {label}
    </button>
  );
}

function Pill({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-black/40 px-3 py-1">
      <div className="text-[11px] text-[#808080]">{label}</div>
      <div className={["text-[11px] font-medium tabular-nums", tone ? tone : "text-white"].join(" ")}>{value}</div>
    </div>
  );
}

function LegendDot({ label, color }: { label: string; color: string }) {
  return (
    <div className="inline-flex items-center gap-1">
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

function StatChip({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={["rounded-lg border px-2 py-2 text-center", accent ? "bg-[#d4af37]/10 border-[#d4af37]/25" : "bg-[#0a0a0a] border-[#1f1f1f]"].join(" ")}>
      <div className="text-[10px] text-[#606060]">{label}</div>
      <div className={["mt-0.5 font-semibold tabular-nums", accent ? "text-[#d4af37]" : "text-white"].join(" ")}>{value}</div>
    </div>
  );
}

function BookOfferCell({ offer, isBest }: { offer?: BookOffer; isBest?: boolean }) {
  if (!offer) return <div className="text-[#404040]">—</div>;

  const logo = bookLogoSrc(offer.book);
  const ring = isBest ? `shadow-[0_0_0_1px_${BOOK_COLOR[offer.book as AnyBookHistory]}]` : "shadow-none";

  return (
    <div className={["inline-flex flex-col items-center justify-center gap-1 px-2 py-1 rounded-lg border", isBest ? "bg-white/5 border-white/10" : "bg-[#0a0a0a] border-[#1f1f1f]", ring].join(" ")}>
      <div className="inline-flex items-center justify-center gap-2">
        {logo ? (
          <img src={logo} alt={offer.book} className="h-5 w-5 opacity-95 shrink-0" draggable={false} />
        ) : (
          <div className="h-5 w-5 rounded bg-[#111] border border-[#2a2a2a] flex items-center justify-center text-[10px] text-[#808080]">—</div>
        )}
        <div className="text-white font-semibold tabular-nums">{american(offer.odds)}</div>
      </div>

      <div className={["text-[10px] tabular-nums", isBest ? "text-[#d4af37]" : "text-[#808080]"].join(" ")}>{pct(offer.ev_pct, 1)}</div>
    </div>
  );
}

function BookChip({ offer, isBest }: { offer?: BookOffer; isBest?: boolean }) {
  if (!offer) {
    return (
      <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg p-2 text-center">
        <div className="text-[10px] text-[#606060]">—</div>
        <div className="text-[#404040]">—</div>
      </div>
    );
  }

  const logo = bookLogoSrc(offer.book);
  const ring = isBest ? `shadow-[0_0_0_1px_${BOOK_COLOR[offer.book as AnyBookHistory]}]` : "shadow-none";

  return (
    <div className={["rounded-lg p-2 text-center border", isBest ? "bg-white/5 border-white/10" : "bg-[#0a0a0a] border-[#1f1f1f]", ring].join(" ")}>
      <div className="flex items-center justify-center gap-2">
        {logo ? <img src={logo} alt={offer.book} className="h-4 w-4 opacity-95" draggable={false} /> : null}
        <div className="text-white font-semibold tabular-nums">{american(offer.odds)}</div>
      </div>
      <div className={["text-[10px] tabular-nums mt-1", isBest ? "text-[#d4af37]" : "text-[#808080]"].join(" ")}>{pct(offer.ev_pct, 1)}</div>
    </div>
  );
}

function PropAvatar({ url, name }: { url: string | null; name: string }) {
  if (url) {
    return (
      <img
        src={url}
        alt={name || "Player"}
        className="h-9 w-9 rounded-full object-cover border border-[#2a2a2a] bg-[#111] shrink-0"
        draggable={false}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }

  const initials = (name || "P")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");

  return (
    <div className="h-9 w-9 rounded-full border border-[#2a2a2a] bg-[#111] text-[#808080] flex items-center justify-center text-[11px] shrink-0">
      {initials || "P"}
    </div>
  );
}

function PropPickInline({ name, position, picture_url, sub, mu }: { name: string; position: string | null; picture_url: string | null; sub?: string; mu?: number | null }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <PropAvatar url={picture_url} name={name} />
      <div className="min-w-0">
        <div className="text-white truncate">
          {name}
          {position ? <span className="text-[#808080]"> · {String(position).toUpperCase()}</span> : null}
        </div>
        {sub ? <div className="text-[10px] text-[#606060] mt-0.5 truncate">{sub}</div> : null}
        <div className="text-[10px] text-[#b0b0b0] mt-0.5">
          Projection: <span className="text-white tabular-nums">{fmtMu(mu ?? null)}</span>
        </div>
      </div>
    </div>
  );
}

function BetAmountValue({ amount, ready }: { amount: number; ready: boolean }) {
  if (!ready || !Number.isFinite(amount) || amount <= 0) return <div className="text-[#404040]">—</div>;
  return (
    <div className="inline-flex items-center justify-center px-2 py-1 bg-[#d4af37]/15 border border-[#d4af37]/35 rounded-lg text-[#d4af37] tabular-nums">
      {formatMoney(amount)}
    </div>
  );
}

/* ✅ ALSO provide a default export so any default-import usage won't break */
export default ModelScreen;

