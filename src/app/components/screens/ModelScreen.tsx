// src/app/components/screens/ModelScreen.tsx — FULL REWRITE (Line Movement + FantasyPros Game Logs in Modal)
// -----------------------------------------------------------------------------------------------------
// ✅ Aggregated: 1 row per play, shows DK / FD / MGM strip, highlights best book
// ✅ Game +EV plays from public.ev_plays
// ✅ Player prop +EV plays from public.player_prop_ev_latest
// ✅ Filters: Play Type + Book
// ✅ Bet $ uses app_settings.bankroll + app_settings.kelly_factor (best book fraction)
//
// ✅ MODAL: Line Movement + FantasyPros Game Logs (props only)
// ✅ ONLY the Pick column / Pick block is clickable to open modal
// ✅ History graph:
//    - PLAYER PROPS: public.player_props_history
//        Match on: player_name, market, side, bookmaker
//    - GAME LINES: public.odds_snapshot_history
//        Match on: sport_key, event_id, market, side, bookmaker
// ✅ Adds Pinnacle line to history graph (when present)
// ✅ Colors each book line uniquely + tooltip shows DATE + TIME (America/Chicago)
//
// ✅ FantasyPros Game Logs:
//    - Props modal fetches from FP logs table (configurable constant below)
//    - Displays last N games with date/opponent/min/pts/reb/ast/3pm
//    - Includes safe fallbacks + debug messages if schema differs

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";

/* =========================================================
   Types
========================================================= */

type GameMarketKey = "h2h" | "spreads" | "totals";
type GameSideKey = "home" | "away" | "over" | "under";

type SoftBookKey = "all" | "draftkings" | "fanduel" | "betmgm" | "pinnacle";
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

  book: string;
  odds: number;

  p_quantum: number | null;
  quantum_fair_odds: number;

  ev_pct: number;
  kelly_fraction: number;
  score: number;
};

type AnyBook = "draftkings" | "fanduel" | "betmgm" | "pinnacle";

type BookOffer = {
  book: AnyBook;
  odds: number;
  ev_pct: number;
  bet_fraction: number;
};

type AggregatedPlay = {
  kind: "game" | "prop";
  playKey: string;

  sport_key?: string | null;
  event_id: string;
  commence_time: string | null;
  matchup: string | null;

  marketLabel: string;
  sideLabel: string;
  pickLabel: string;
  lineLabel: string;

  quantum_odds: number;
  quantum_prob?: number | null;

  gameMeta?: { market: GameMarketKey; side: GameSideKey };
  propMeta?: {
    player_name: string | null;
    market: string | null;
    side: string | null;
    picture_url: string | null;
    position: string | null;
  };

  offers: Partial<Record<Exclude<SoftBookKey, "all">, BookOffer>>;
  bestBook: Exclude<SoftBookKey, "all"> | null;
  bestEvPct: number;
  bestBetFraction: number;
  bestScore: number;

  created_at: string | null;
};

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

const PLAYER_COL_PROPS = "player_name";
const MARKET_COL_PROPS = "market";
const SIDE_COL_PROPS = "side";

/* =========================================================
   FantasyPros Game Logs (CONFIG)
   ---------------------------------------------------------
   IMPORTANT: If your table/columns differ, change ONLY these constants.

   Recommended schema for FP logs table:
     - player_name (text)
     - game_date (timestamptz or date)  OR  date (timestamptz/date)
     - opponent (text) OR opp (text)
     - minutes (number) OR min (number)
     - pts, reb, ast, threes (3pm) columns (any reasonable naming)
========================================================= */

const FP_GAMELOGS_TABLE = "fantasypros_game_logs"; // <-- change if your table name differs

// We support multiple possible column names safely:
const FP_COL_PLAYER = "player_name";

// Date candidates:
const FP_DATE_CANDIDATES = ["game_date", "date", "gm_date", "dt"];

// Opponent candidates:
const FP_OPP_CANDIDATES = ["opponent", "opp", "vs", "opponent_abbrev"];

// Minutes candidates:
const FP_MIN_CANDIDATES = ["minutes", "min", "mins"];

// Stat candidates:
const FP_PTS_CANDIDATES = ["pts", "points"];
const FP_REB_CANDIDATES = ["reb", "rebounds"];
const FP_AST_CANDIDATES = ["ast", "assists"];
const FP_3PM_CANDIDATES = ["threes", "3pm", "fg3m", "three_pm", "three_pointers_made"];

// Optional: location (home/away)
const FP_LOC_CANDIDATES = ["location", "home_away", "loc", "ha"];

// Optional: team/opponent/team abbreviations
const FP_TEAM_CANDIDATES = ["team", "team_abbrev"];
const FP_RESULT_CANDIDATES = ["result", "wl", "outcome"];

// How many rows to show
const FP_GAMELOGS_LIMIT = 12;

/* =========================================================
   Books + colors
========================================================= */

const HISTORY_BOOKS: AnyBook[] = ["draftkings", "fanduel", "betmgm", "pinnacle"];

const BOOK_COLOR: Record<AnyBook, string> = {
  draftkings: "#22c55e",
  fanduel: "#3b82f6",
  betmgm: "#d4af37",
  pinnacle: "#a855f7",
};

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

function normalizeBookKey(bookmaker: string): SoftBookKey | "other" {
  const b = (bookmaker || "").toLowerCase();
  if (b === "draftkings" || b === "dk") return "draftkings";
  if (b === "fanduel" || b === "fd") return "fanduel";
  if (b === "betmgm" || b === "mgm") return "betmgm";
  if (b === "pinnacle" || b === "pin") return "pinnacle";
  return "other";
}

function bookShort(book: AnyBook) {
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

/**
 * player_props_history.market values are typically:
 *   "player_points" / "player_rebounds" / "player_assists" / "player_threes"
 */
type PropHistoryMarketKey =
  | "player_points"
  | "player_rebounds"
  | "player_assists"
  | "player_threes";

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

/* =========================================================
   Dedup keys
========================================================= */

function gamePlayKey(r: EvPlayRow) {
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
   Best offer
========================================================= */

function chooseBestOffer(
  offers: Partial<Record<Exclude<SoftBookKey, "all">, BookOffer>>
) {
  const order: Exclude<SoftBookKey, "all">[] = ["draftkings", "fanduel", "betmgm"];
  const list = order
    .map((b) => (offers[b] ? ({ b, o: offers[b]! }) : null))
    .filter(Boolean) as { b: Exclude<SoftBookKey, "all">; o: BookOffer }[];

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
   History series builder (pivot by ts + book)
========================================================= */

type HistoryPoint = {
  ts: string;
  draftkings?: number | null;
  fanduel?: number | null;
  betmgm?: number | null;
  pinnacle?: number | null;
};

function normalizeIso(raw: any): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function collapseHistory(
  rows: any[],
  tsCol: string,
  bookCol: string,
  oddsCol: string
): HistoryPoint[] {
  const map = new Map<string, HistoryPoint>();

  for (const r of rows) {
    const ts = normalizeIso(r?.[tsCol]);
    if (!ts) continue;

    const book = String(r?.[bookCol] ?? "").toLowerCase() as AnyBook;
    if (!HISTORY_BOOKS.includes(book)) continue;

    const odds = Number(r?.[oddsCol]);
    if (!Number.isFinite(odds)) continue;

    const cur = map.get(ts) ?? { ts };
    (cur as any)[book] = odds;
    map.set(ts, cur);
  }

  return Array.from(map.values()).sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
  );
}

/* =========================================================
   FantasyPros Game Logs types + helpers
========================================================= */

type FpGameLog = {
  dateIso: string | null;
  opp: string | null;
  loc: string | null; // "H"/"A" or "@"
  team: string | null;
  result: string | null;

  min: number | null;
  pts: number | null;
  reb: number | null;
  ast: number | null;
  threes: number | null;

  raw: any;
};

function pickFirst(r: any, keys: string[]): any {
  for (const k of keys) {
    if (r && Object.prototype.hasOwnProperty.call(r, k) && r[k] != null) return r[k];
  }
  return null;
}

function toNumberOrNull(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIsoOrNull(v: any): string | null {
  const iso = normalizeIso(v);
  return iso ?? null;
}

function normalizeLoc(v: any): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (low === "home" || low === "h") return "H";
  if (low === "away" || low === "a") return "A";
  if (s === "@") return "A";
  return s.length <= 2 ? s.toUpperCase() : s;
}

function fmtLogDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
  });
}

function fmtOpp(opp: string | null, loc: string | null) {
  const o = (opp || "").trim();
  if (!o) return "—";
  if (loc === "A" || loc === "@") return `@ ${o}`;
  if (loc === "H") return `vs ${o}`;
  return o;
}

/* =========================================================
   Screen
========================================================= */

const SOFT_BOOKS: { key: SoftBookKey; label: string }[] = [
  { key: "all", label: "All Books" },
  { key: "draftkings", label: "DraftKings" },
  { key: "fanduel", label: "FanDuel" },
  { key: "betmgm", label: "BetMGM" },
  { key: "pinnacle", label: "Pinnacle (history only)" },
];

export function ModelScreen() {
  const [bookFilter, setBookFilter] = useState<SoftBookKey>("all");
  const [kindFilter, setKindFilter] = useState<PlayKind>("all");

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

      const settingsQ = supabase
        .from("app_settings")
        .select("id,bankroll,kelly_factor,updated_at")
        .eq("id", 1)
        .limit(1);

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

    // GAME PLAYS
    for (const r of games) {
      const bk = normalizeBookKey(r.bookmaker);
      if (bk === "other" || bk === "pinnacle") continue;

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
        book: bk as AnyBook,
        odds: safeNum(r.book_odds, NaN),
        ev_pct: safeNum(r.ev_pct, 0),
        bet_fraction: clamp(safeNum(r.bet_fraction, 0), 0, 1),
      };

      base.bestScore = Math.max(safeNum(base.bestScore, 0), safeNum(r.confidence_score, 0));
      map.set(key, base);
    }

    // PROP PLAYS
    for (const r of props) {
      const bk = normalizeBookKey(r.book);
      if (bk === "other" || bk === "pinnacle") continue;

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
          },

          offers: {},
          bestBook: null,
          bestEvPct: 0,
          bestBetFraction: 0,
          bestScore: 0,

          created_at: r.created_at ?? null,
        } as AggregatedPlay);

      base.offers[bk] = {
        book: bk as AnyBook,
        odds: safeNum(r.odds, NaN),
        ev_pct: safeNum(r.ev_pct, 0),
        bet_fraction: clamp(safeNum(r.kelly_fraction, 0), 0, 1),
      };

      base.bestScore = Math.max(safeNum(base.bestScore, 0), clamp(safeNum(r.score, 0), 0, 100));
      map.set(key, base);
    }

    const plays = Array.from(map.values()).map((p) => {
      const { bestBook, bestEvPct, bestBetFraction } = chooseBestOffer(p.offers);
      return { ...p, bestBook, bestEvPct, bestBetFraction };
    });

    return plays.sort(sortPlays);
  }, [games, props]);

  const filtered = useMemo(() => {
    let list = aggregated;
    if (kindFilter !== "all") list = list.filter((p) => p.kind === kindFilter);

    if (bookFilter !== "all") {
      if (bookFilter === "pinnacle") {
        list = list; // history-only
      } else {
        list = list.filter((p) => !!p.offers[bookFilter]);
      }
    }
    return list;
  }, [aggregated, kindFilter, bookFilter]);

  const bankroll = safeNum(settings?.bankroll, 0);
  const kellyFactor = clamp(safeNum(settings?.kelly_factor, 0), 0, 1);
  const settingsReady = !!(bankroll && kellyFactor);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h2 className="text-xl text-white mb-1">Model Picks</h2>
          <p className="text-xs text-[#808080]">
            {filtered.length} plays ·{" "}
            {kindFilter === "all" ? "All" : kindFilter === "game" ? "Game Lines" : "Player Props"}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="inline-flex items-center bg-[#111] border border-[#2a2a2a] rounded overflow-hidden">
            <KindPill active={kindFilter === "all"} onClick={() => setKindFilter("all")} label="All" />
            <KindPill active={kindFilter === "game"} onClick={() => setKindFilter("game")} label="Game Lines" />
            <KindPill active={kindFilter === "prop"} onClick={() => setKindFilter("prop")} label="Player Props" />
          </div>

          <select
            value={bookFilter}
            onChange={(e) => setBookFilter(e.target.value as SoftBookKey)}
            className="px-2 py-1 bg-[#111] border border-[#2a2a2a] rounded text-[#d0d0d0] outline-none"
          >
            {SOFT_BOOKS.map((b) => (
              <option key={b.key} value={b.key}>
                {b.label}
              </option>
            ))}
          </select>

          <div className="px-2 py-1 bg-[#1a1a1a] rounded text-[#808080]">
            Bankroll: <span className="text-[#d4af37]">{bankroll ? formatMoney(bankroll) : "—"}</span>
          </div>
          <div className="px-2 py-1 bg-[#1a1a1a] rounded text-[#808080]">
            Kelly:{" "}
            <span className="text-[#d4af37]">
              {settings?.kelly_factor != null ? `${(kellyFactor * 100).toFixed(1)}%` : "—"}
            </span>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-xs text-[#808080] px-3 py-2 bg-[#0f0f0f] border border-[#2a2a2a] rounded">
          Loading EV plays…
        </div>
      ) : null}

      {error ? (
        <div className="text-xs text-red-400 px-3 py-2 bg-[#0f0f0f] border border-red-900/50 rounded">
          Failed to load ev_plays: {error}
        </div>
      ) : null}

      {/* Desktop table */}
      <div className="hidden md:block bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-10 min-w-[340px]">
                  Matchup
                </th>
                <th className="text-left p-3 text-[#808080] min-w-[120px]">Market</th>
                <th className="text-left p-3 text-[#808080] min-w-[260px]">Pick</th>
                <th className="text-center p-3 text-[#808080] min-w-[80px]">Line</th>

                <th className="text-center p-3 text-[#808080] min-w-[110px]">
                  <div className="flex items-center justify-center">
                    <img src="/logos/Quantum.png" alt="Quantum" className="h-6 w-auto opacity-90" draggable={false} />
                  </div>
                </th>

                <th className="text-center p-3 text-[#808080] min-w-[110px]">DK</th>
                <th className="text-center p-3 text-[#808080] min-w-[110px]">FD</th>
                <th className="text-center p-3 text-[#808080] min-w-[110px]">MGM</th>

                <th className="text-center p-3 text-[#808080] min-w-[110px]">
                  <div className="flex items-center justify-center">
                    <img
                      src="/logos/SpectrumEV.png"
                      alt="SpectrumEV"
                      className="h-6 w-auto opacity-90"
                      draggable={false}
                    />
                  </div>
                </th>

                <th className="text-center p-3 text-[#808080] min-w-[90px]">Score</th>
                <th className="text-center p-3 text-[#808080] min-w-[120px]">Bet $</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#1a1a1a]">
              {filtered.map((p) => (
                <PlayRow
                  key={p.playKey}
                  play={p}
                  bankroll={bankroll}
                  kellyFactor={kellyFactor}
                  settingsReady={settingsReady}
                  onOpenDetails={() => {
                    setSelected(p);
                    setDetailsOpen(true);
                  }}
                />
              ))}

              {!loading && !filtered.length ? (
                <tr>
                  <td colSpan={11} className="p-6 text-center text-xs text-[#808080]">
                    No positive EV plays found for this filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {!loading && !filtered.length ? (
          <div className="text-xs text-[#808080] px-3 py-8 bg-[#0f0f0f] border border-[#2a2a2a] rounded text-center">
            No positive EV plays found for this filter.
          </div>
        ) : null}

        {filtered.map((p) => (
          <PlayCard
            key={p.playKey}
            play={p}
            bankroll={bankroll}
            kellyFactor={kellyFactor}
            settingsReady={settingsReady}
            onOpenDetails={() => {
              setSelected(p);
              setDetailsOpen(true);
            }}
          />
        ))}
      </div>

      <PlayDetailsModal
        open={detailsOpen}
        play={selected}
        onClose={() => setDetailsOpen(false)}
        bankroll={bankroll}
        kellyFactor={kellyFactor}
        settingsReady={settingsReady}
      />
    </div>
  );
}

/* =========================================================
   Desktop Row (ONLY pick opens modal)
========================================================= */

function PlayRow({
  play,
  bankroll,
  kellyFactor,
  settingsReady,
  onOpenDetails,
}: {
  play: AggregatedPlay;
  bankroll: number;
  kellyFactor: number;
  settingsReady: boolean;
  onOpenDetails: () => void;
}) {
  const betAmount = settingsReady ? calcBetAmount(bankroll, play.bestBetFraction, kellyFactor) : NaN;

  return (
    <tr className="hover:bg-[#0f0f0f]/50 transition-colors">
      <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10 min-w-[340px]">
        <div className="text-white">
          {play.matchup ?? "—"}
          <span className="text-[#606060]"> · </span>
          <span className="text-[#b0b0b0]">{fmtDateCentral(play.commence_time)}</span>
          <span className="text-[#606060]"> </span>
          <span className="text-[#b0b0b0]">{fmtTimeCentral(play.commence_time)}</span>

          {play.kind === "prop" ? (
            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-[#d4af37]/15 border border-[#d4af37]/25 text-[10px] text-[#d4af37]">
              PROP
            </span>
          ) : null}
        </div>
        <div className="text-[10px] text-[#606060] mt-0.5">
          Event: <span className="text-[#404040]">{play.event_id}</span>
        </div>
      </td>

      <td className="p-3 text-left">
        <div className="text-white">{play.marketLabel}</div>
        <div className="text-[10px] text-[#606060] mt-0.5">{play.sideLabel}</div>
      </td>

      {/* PICK (clickable) */}
      <td className="p-3 text-left">
        <button
          type="button"
          onClick={onOpenDetails}
          className="w-full text-left hover:opacity-90"
          title="Open line movement + FantasyPros logs"
        >
          {play.kind === "prop" ? (
            <PropPickInline
              name={play.pickLabel}
              position={play.propMeta?.position ?? null}
              picture_url={play.propMeta?.picture_url ?? null}
            />
          ) : (
            <div className="text-white">{play.pickLabel}</div>
          )}
        </button>
      </td>

      <td className="p-3 text-center">
        <div className="text-white">{play.lineLabel}</div>
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
        <div className="text-[#d4af37] tabular-nums">{pct(play.bestEvPct, 1)}</div>
      </td>

      <td className="p-3 text-center">
        <ScoreValue value={play.bestScore} />
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
}: {
  play: AggregatedPlay;
  bankroll: number;
  kellyFactor: number;
  settingsReady: boolean;
  onOpenDetails: () => void;
}) {
  const betAmount = settingsReady ? calcBetAmount(bankroll, play.bestBetFraction, kellyFactor) : 0;

  return (
    <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4">
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
        </div>

        <div className="shrink-0 text-right">
          <div className="text-[10px] text-[#606060]">Bet</div>
          <div className="text-[#d4af37] font-semibold tabular-nums">
            {settingsReady && betAmount > 0 ? formatMoney(betAmount) : "—"}
          </div>
        </div>
      </div>

      {/* PICK (clickable) */}
      <button
        type="button"
        onClick={onOpenDetails}
        className="mt-3 w-full text-left hover:opacity-90"
        title="Open line movement + FantasyPros logs"
      >
        {play.kind === "prop" ? (
          <div className="flex items-center gap-3">
            <PropAvatar url={play.propMeta?.picture_url ?? null} name={play.pickLabel} />
            <div className="min-w-0">
              <div className="text-white text-sm truncate">
                {play.pickLabel}
                {play.propMeta?.position ? (
                  <span className="text-[#808080]"> · {play.propMeta.position}</span>
                ) : null}
              </div>
              <div className="text-[11px] text-[#808080] mt-0.5 truncate">
                {play.marketLabel} · {play.sideLabel} {play.lineLabel}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-white text-sm">
            {play.pickLabel}{" "}
            <span className="text-[#808080] text-xs">
              · {play.marketLabel} · {play.sideLabel}{" "}
              {play.lineLabel !== "—" ? play.lineLabel : ""}
            </span>
          </div>
        )}
      </button>

      <div className="mt-3 grid grid-cols-4 gap-2 items-stretch">
        <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-2 text-center">
          <div className="text-[10px] text-[#606060]">Quantum</div>
          <div className="text-white font-semibold tabular-nums">{american(play.quantum_odds)}</div>
        </div>

        <BookChip offer={play.offers.draftkings} isBest={play.bestBook === "draftkings"} />
        <BookChip offer={play.offers.fanduel} isBest={play.bestBook === "fanduel"} />
        <BookChip offer={play.offers.betmgm} isBest={play.bestBook === "betmgm"} />
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] text-[#606060]">EV (best)</div>
          <div className="text-[#d4af37] font-semibold tabular-nums">{pct(play.bestEvPct, 1)}</div>
        </div>

        <div className="text-right">
          <div className="text-[10px] text-[#606060]">Score</div>
          <div className="text-sm">
            <ScoreValue value={play.bestScore} />
          </div>
        </div>

        <div className="text-[10px] text-[#606060]">Tap pick for details</div>
      </div>
    </div>
  );
}

/* =========================================================
   Details Modal (Line Movement + FantasyPros Game Logs)
========================================================= */

type ModalTab = "movement" | "gamelogs";

function PlayDetailsModal({
  open,
  play,
  onClose,
  bankroll,
  kellyFactor,
  settingsReady,
}: {
  open: boolean;
  play: AggregatedPlay | null;
  onClose: () => void;
  bankroll: number;
  kellyFactor: number;
  settingsReady: boolean;
}) {
  const [tab, setTab] = useState<ModalTab>("movement");

  useEffect(() => {
    if (open) setTab("movement");
  }, [open, play?.playKey]);

  if (!open || !play) return null;

  const betAmount = settingsReady ? calcBetAmount(bankroll, play.bestBetFraction, kellyFactor) : 0;

  const tabEnabledLogs = play.kind === "prop";

  return (
    <div className="fixed inset-0 z-[100]">
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-black/70"
        aria-label="Close details modal"
      />

      <div className="absolute inset-x-0 bottom-0 md:inset-0 md:flex md:items-center md:justify-center p-0 md:p-6">
        <div className="relative w-full md:max-w-3xl bg-[#0b0b0b] border border-[#2a2a2a] md:rounded-xl rounded-t-xl overflow-hidden">
          <div className="p-4 border-b border-[#1f1f1f] bg-[#0a0a0a]">
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

                <div className="mt-2 text-white">
                  <span className="text-[#d4af37]">{play.marketLabel}</span>{" "}
                  <span className="text-[#606060]">·</span>{" "}
                  <span className="text-white">{play.pickLabel}</span>{" "}
                  <span className="text-[#808080]">
                    · {play.sideLabel} {play.lineLabel !== "—" ? play.lineLabel : ""}
                  </span>
                </div>
              </div>

              <div className="shrink-0 text-right">
                <div className="text-[10px] text-[#606060]">Best EV</div>
                <div className="text-[#d4af37] font-semibold tabular-nums">
                  {pct(play.bestEvPct, 1)}
                </div>
                <div className="mt-1 text-[10px] text-[#606060]">Bet</div>
                <div className="text-[#d4af37] font-semibold tabular-nums">
                  {settingsReady && betAmount > 0 ? formatMoney(betAmount) : "—"}
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="mt-4 flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => setTab("movement")}
                className={[
                  "px-3 py-1.5 rounded border transition-colors",
                  tab === "movement"
                    ? "bg-[#111] border-[#d4af37]/40 text-white"
                    : "bg-transparent border-[#2a2a2a] text-[#808080] hover:text-white hover:bg-[#0f0f0f]",
                ].join(" ")}
              >
                Line Movement
              </button>

              <button
                type="button"
                onClick={() => tabEnabledLogs && setTab("gamelogs")}
                disabled={!tabEnabledLogs}
                className={[
                  "px-3 py-1.5 rounded border transition-colors",
                  !tabEnabledLogs
                    ? "bg-transparent border-[#222] text-[#404040] cursor-not-allowed"
                    : tab === "gamelogs"
                    ? "bg-[#111] border-[#d4af37]/40 text-white"
                    : "bg-transparent border-[#2a2a2a] text-[#808080] hover:text-white hover:bg-[#0f0f0f]",
                ].join(" ")}
                title={!tabEnabledLogs ? "FantasyPros logs are only available for player props" : "FantasyPros game logs"}
              >
                FantasyPros Logs
              </button>
            </div>
          </div>

          <div className="p-4">
            {tab === "movement" ? (
              <OddsHistoryMiniChart play={play} />
            ) : (
              <FantasyProsGameLogs play={play} />
            )}
          </div>

          <div className="p-4 border-t border-[#1f1f1f] bg-[#0a0a0a] flex items-center justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded bg-[#111] border border-[#2a2a2a] text-[11px] text-[#d0d0d0] hover:bg-[#141414]"
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
   Odds History (PIN + colors + date in hover)
========================================================= */

function OddsHistoryMiniChart({ play }: { play: AggregatedPlay }) {
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

          const marketKey =
            historyPropMarketKey(play.propMeta?.market ?? null) ??
            historyPropMarketKey(play.marketLabel ?? null);

          const sideRaw = (play.propMeta?.side ?? "").trim().toLowerCase();
          const sideCanon = sideRaw === "o" ? "over" : sideRaw === "u" ? "under" : sideRaw;

          if (!player_name || !marketKey || !["over", "under"].includes(sideCanon)) {
            if (mounted) {
              setDebug(
                `props keys missing: player="${player_name || "—"}" marketKey="${marketKey || "null"}" side="${sideCanon || "null"}"`
              );
            }
            return;
          }

          const { data, error } = await supabase
            .from(PROPS_HISTORY_TABLE)
            .select(
              `${PLAYER_COL_PROPS},${MARKET_COL_PROPS},${SIDE_COL_PROPS},${BOOK_COL_PROPS},${ODDS_COL_PROPS},${TS_COL_PROPS}`
            )
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

          const pts = collapseHistory(data ?? [], TS_COL_PROPS, BOOK_COL_PROPS, ODDS_COL_PROPS);
          setSeries(pts);

          if (!pts.length) {
            setDebug(
              `no rows (props): player="${player_name}" marketKey="${marketKey}" side="${sideCanon}" books=${HISTORY_BOOKS.join(
                ","
              )}`
            );
          }
          return;
        }

        // GAME history
        const sport_key = (play.sport_key ?? "").trim();
        const event_id = play.event_id;
        const market = play.gameMeta?.market ?? null;
        const side = play.gameMeta?.side ?? null;

        if (!sport_key || !event_id || !market || !side) {
          if (mounted) {
            setDebug(
              `game keys missing: sport_key=${!!sport_key} event_id=${!!event_id} market=${market ?? "null"} side=${
                side ?? "null"
              }`
            );
          }
          return;
        }

        const { data, error } = await supabase
          .from(GAME_HISTORY_TABLE)
          .select(`sport_key,event_id,market,side,${BOOK_COL_GAME},${ODDS_COL_GAME},${TS_COL_GAME}`)
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

        const pts = collapseHistory(data ?? [], TS_COL_GAME, BOOK_COL_GAME, ODDS_COL_GAME);
        setSeries(pts);

        if (!pts.length) {
          setDebug(
            `no rows: sport_key="${sport_key}" event_id="${event_id}" market="${market}" side="${side}" books=${HISTORY_BOOKS.join(
              ","
            )}`
          );
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

  if (loading && !series.length) {
    return (
      <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
        <div className="text-xs text-[#808080]">Loading line movement…</div>
      </div>
    );
  }

  if (!series.length) {
    return (
      <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
        <div className="text-[10px] text-[#606060] mb-1">Line Movement (this side)</div>
        <div className="text-xs text-[#808080]">No odds history available for this side.</div>
        {debug ? <div className="mt-2 text-[10px] text-[#404040] break-words">{debug}</div> : null}
      </div>
    );
  }

  const hasAny = (k: AnyBook) => series.some((p) => Number.isFinite((p as any)[k]));

  return (
    <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
      <div className="text-[10px] text-[#606060] mb-2">Line Movement (this side)</div>

      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series}>
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
              width={56}
            />
            <Tooltip
              formatter={(v: any) => american(Number(v))}
              labelFormatter={(l) => fmtDateTimeCT(String(l))}
              contentStyle={{
                background: "#0b0b0b",
                border: "1px solid #2a2a2a",
                color: "#d0d0d0",
                fontSize: 12,
              }}
            />
            <Legend />

            {hasAny("draftkings") ? (
              <Line type="monotone" dataKey="draftkings" name="DK" dot={false} strokeWidth={2} stroke={BOOK_COLOR.draftkings} isAnimationActive={false} />
            ) : null}
            {hasAny("fanduel") ? (
              <Line type="monotone" dataKey="fanduel" name="FD" dot={false} strokeWidth={2} stroke={BOOK_COLOR.fanduel} isAnimationActive={false} />
            ) : null}
            {hasAny("betmgm") ? (
              <Line type="monotone" dataKey="betmgm" name="MGM" dot={false} strokeWidth={2} stroke={BOOK_COLOR.betmgm} isAnimationActive={false} />
            ) : null}
            {hasAny("pinnacle") ? (
              <Line type="monotone" dataKey="pinnacle" name="PIN" dot={false} strokeWidth={2} stroke={BOOK_COLOR.pinnacle} isAnimationActive={false} />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {debug ? <div className="mt-2 text-[10px] text-[#404040] break-words">{debug}</div> : null}
    </div>
  );
}

/* =========================================================
   FantasyPros Game Logs (props only)
========================================================= */

function FantasyProsGameLogs({ play }: { play: AggregatedPlay }) {
  const [rows, setRows] = useState<FpGameLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [debug, setDebug] = useState<string>("");

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setRows([]);
      setDebug("");

      try {
        if (play.kind !== "prop") {
          setDebug("FantasyPros logs are only shown for player props.");
          return;
        }

        const player = (play.propMeta?.player_name ?? play.pickLabel ?? "").trim();
        if (!player) {
          setDebug("Missing player_name for FantasyPros logs lookup.");
          return;
        }

        // We deliberately select * to support unknown schemas.
        const { data, error } = await supabase
          .from(FP_GAMELOGS_TABLE)
          .select("*")
          .eq(FP_COL_PLAYER, player)
          // Order by likely date col - we can't safely order without knowing which exists,
          // so we'll sort client-side after parsing.
          .limit(150);

        if (!mounted) return;

        if (error) {
          setDebug(`FantasyPros logs error: ${error.message} (table: ${FP_GAMELOGS_TABLE})`);
          setRows([]);
          return;
        }

        const parsed: FpGameLog[] = (data ?? []).map((r: any) => {
          const dateRaw = pickFirst(r, FP_DATE_CANDIDATES);
          const oppRaw = pickFirst(r, FP_OPP_CANDIDATES);
          const minRaw = pickFirst(r, FP_MIN_CANDIDATES);

          const ptsRaw = pickFirst(r, FP_PTS_CANDIDATES);
          const rebRaw = pickFirst(r, FP_REB_CANDIDATES);
          const astRaw = pickFirst(r, FP_AST_CANDIDATES);
          const thRaw = pickFirst(r, FP_3PM_CANDIDATES);

          const locRaw = pickFirst(r, FP_LOC_CANDIDATES);
          const teamRaw = pickFirst(r, FP_TEAM_CANDIDATES);
          const resRaw = pickFirst(r, FP_RESULT_CANDIDATES);

          return {
            dateIso: toIsoOrNull(dateRaw),
            opp: oppRaw != null ? String(oppRaw) : null,
            loc: normalizeLoc(locRaw),
            team: teamRaw != null ? String(teamRaw) : null,
            result: resRaw != null ? String(resRaw) : null,

            min: toNumberOrNull(minRaw),
            pts: toNumberOrNull(ptsRaw),
            reb: toNumberOrNull(rebRaw),
            ast: toNumberOrNull(astRaw),
            threes: toNumberOrNull(thRaw),

            raw: r,
          };
        });

        // Sort by date desc
        parsed.sort((a, b) => {
          const ta = a.dateIso ? new Date(a.dateIso).getTime() : -Infinity;
          const tb = b.dateIso ? new Date(b.dateIso).getTime() : -Infinity;
          return tb - ta;
        });

        const trimmed = parsed.slice(0, FP_GAMELOGS_LIMIT);
        setRows(trimmed);

        if (!trimmed.length) {
          setDebug(
            `No FantasyPros logs found for "${player}". Table="${FP_GAMELOGS_TABLE}". Check that "${FP_COL_PLAYER}" matches.`
          );
        } else {
          // Light schema sanity debug:
          const sample = trimmed[0];
          const missing =
            sample.dateIso == null ||
            (sample.pts == null && sample.reb == null && sample.ast == null && sample.threes == null);

          if (missing) {
            setDebug(
              `Found rows, but key columns may not match expected names. Adjust FP_DATE_CANDIDATES / stat candidates at top.`
            );
          }
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

  if (loading && !rows.length) {
    return (
      <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
        <div className="text-xs text-[#808080]">Loading FantasyPros game logs…</div>
      </div>
    );
  }

  return (
    <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="text-[10px] text-[#606060]">FantasyPros Game Logs</div>
        <div className="text-[10px] text-[#404040]">
          Showing last {Math.min(rows.length, FP_GAMELOGS_LIMIT)} games
        </div>
      </div>

      {!rows.length ? (
        <div className="text-xs text-[#808080]">
          No game logs available.
          {debug ? <div className="mt-2 text-[10px] text-[#404040] break-words">{debug}</div> : null}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[#808080] border-b border-[#1f1f1f]">
                <th className="text-left py-2 pr-3">Date</th>
                <th className="text-left py-2 pr-3">Opp</th>
                <th className="text-center py-2 pr-3">MIN</th>
                <th className="text-center py-2 pr-3">PTS</th>
                <th className="text-center py-2 pr-3">REB</th>
                <th className="text-center py-2 pr-3">AST</th>
                <th className="text-center py-2 pr-0">3PM</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#141414]">
              {rows.map((r, idx) => (
                <tr key={idx} className="text-[#d0d0d0]">
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtLogDate(r.dateIso)}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <span className="text-white">{fmtOpp(r.opp, r.loc)}</span>
                    {r.result ? <span className="text-[#606060]"> · {r.result}</span> : null}
                  </td>
                  <td className="py-2 pr-3 text-center tabular-nums">{r.min ?? "—"}</td>
                  <td className="py-2 pr-3 text-center tabular-nums">{r.pts ?? "—"}</td>
                  <td className="py-2 pr-3 text-center tabular-nums">{r.reb ?? "—"}</td>
                  <td className="py-2 pr-3 text-center tabular-nums">{r.ast ?? "—"}</td>
                  <td className="py-2 pr-0 text-center tabular-nums">{r.threes ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {debug ? <div className="mt-2 text-[10px] text-[#404040] break-words">{debug}</div> : null}
        </div>
      )}
    </div>
  );
}

/* =========================================================
   UI atoms
========================================================= */

function KindPill({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "px-2.5 py-1 text-xs transition-colors",
        active
          ? "bg-[#1a1a1a] text-white"
          : "bg-transparent text-[#808080] hover:text-white hover:bg-[#141414]",
      ].join(" ")}
      type="button"
    >
      {label}
    </button>
  );
}

function BookOfferCell({ offer, isBest }: { offer?: BookOffer; isBest?: boolean }) {
  if (!offer) return <div className="text-[#404040]">—</div>;

  const logo = bookLogoSrc(offer.book);
  return (
    <div
      className={[
        "inline-flex flex-col items-center justify-center gap-1 px-2 py-1 rounded border",
        isBest ? "bg-[#d4af37]/12 border-[#d4af37]/40" : "bg-[#0a0a0a] border-[#1f1f1f]",
      ].join(" ")}
    >
      <div className="inline-flex items-center justify-center gap-2">
        {logo ? (
          <img src={logo} alt={bookShort(offer.book)} className="h-5 w-5 opacity-95 shrink-0" draggable={false} />
        ) : (
          <div className="h-5 w-5 rounded bg-[#111] border border-[#2a2a2a] flex items-center justify-center text-[10px] text-[#808080]">
            {bookShort(offer.book)}
          </div>
        )}
        <div className="text-white font-semibold tabular-nums">{american(offer.odds)}</div>
      </div>
      <div className={isBest ? "text-[#d4af37] text-[10px] tabular-nums" : "text-[#808080] text-[10px] tabular-nums"}>
        {pct(offer.ev_pct, 1)}
      </div>
    </div>
  );
}

function BookChip({ offer, isBest }: { offer?: BookOffer; isBest?: boolean }) {
  if (!offer) {
    return (
      <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-2 text-center">
        <div className="text-[10px] text-[#606060]">—</div>
        <div className="text-[#404040]">—</div>
      </div>
    );
  }

  const logo = bookLogoSrc(offer.book);
  return (
    <div
      className={[
        "rounded p-2 text-center border",
        isBest ? "bg-[#d4af37]/12 border-[#d4af37]/40" : "bg-[#0a0a0a] border border-[#1f1f1f]",
      ].join(" ")}
    >
      <div className="flex items-center justify-center gap-2">
        {logo ? (
          <img src={logo} alt={bookShort(offer.book)} className="h-4 w-4 opacity-95" draggable={false} />
        ) : (
          <div className="h-4 w-4 rounded bg-[#111] border border-[#2a2a2a] flex items-center justify-center text-[9px] text-[#808080]">
            {bookShort(offer.book)}
          </div>
        )}
        <div className="text-white font-semibold tabular-nums">{american(offer.odds)}</div>
      </div>
      <div className={isBest ? "text-[#d4af37] text-[10px] tabular-nums mt-1" : "text-[#808080] text-[10px] tabular-nums mt-1"}>
        {pct(offer.ev_pct, 1)}
      </div>
    </div>
  );
}

function PropAvatar({ url, name }: { url: string | null; name: string }) {
  if (url) {
    return (
      <img
        src={url}
        alt={name || "Player"}
        className="h-8 w-8 rounded-full object-cover border border-[#2a2a2a] bg-[#111] shrink-0"
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
    <div className="h-8 w-8 rounded-full border border-[#2a2a2a] bg-[#111] text-[#808080] flex items-center justify-center text-[11px] shrink-0">
      {initials || "P"}
    </div>
  );
}

function PropPickInline({
  name,
  position,
  picture_url,
}: {
  name: string;
  position: string | null;
  picture_url: string | null;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <PropAvatar url={picture_url} name={name} />
      <div className="min-w-0">
        <div className="text-white truncate">
          {name}
          {position ? <span className="text-[#808080]"> · {String(position).toUpperCase()}</span> : null}
        </div>
      </div>
    </div>
  );
}

function ScoreValue({ value }: { value: number }) {
  const v = Number(value ?? 0);
  let color = "text-[#606060]";
  if (v >= 85) color = "text-[#d4af37]";
  else if (v >= 70) color = "text-white";
  return <div className={color}>{Math.round(v)}</div>;
}

function BetAmountValue({ amount, ready }: { amount: number; ready: boolean }) {
  if (!ready || !Number.isFinite(amount) || amount <= 0) return <div className="text-[#404040]">—</div>;
  return (
    <div className="inline-flex items-center justify-center px-2 py-0.5 bg-[#d4af37]/20 border border-[#d4af37]/40 rounded text-[#d4af37] tabular-nums">
      {formatMoney(amount)}
    </div>
  );
}


