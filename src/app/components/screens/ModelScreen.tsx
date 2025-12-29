// src/app/components/screens/ModelScreen.tsx — FULL REWRITE (Best visual version of itself)
// -----------------------------------------------------------------------------------------------------
// ✅ Aggregated: 1 row per play, shows DK / FD / MGM strip, highlights best book
// ✅ Game +EV plays from public.ev_plays
// ✅ Player prop +EV plays from public.player_prop_ev_latest
// ✅ Filters: Play Type + Book
// ✅ Bet $ uses app_settings.bankroll + app_settings.kelly_factor (best book fraction)
//
// ✅ LINE MOVEMENT = LINE CHART (DK/FD/MGM/PIN) with tooltip showing DATE + TIME (CT)
// ✅ Props modal: FantasyPros GAME LOGS = BAR CHART (single stat bars)
//    - Adds a horizontal reference line for TODAY’S line (the prop line)
//    - Bars colored by whether that game was OVER (green) / UNDER (red) today’s line
//    - Hover does NOT shade the whole chart area; it only highlights the bar
// ✅ Projection label uses μ symbol
// ✅ ONLY the Pick column (desktop) / Pick block (mobile) opens the modal
//
// ✅ Adds Pinnacle odds to line movement (when present)
// ✅ Colors each book uniquely (DK/FD/MGM/PIN)

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

  book: string; // "draftkings"/"fanduel"/"betmgm"
  odds: number;

  // model outputs
  mu?: number | null; // ✅ projection
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
    mu: number | null; // ✅ projection shown in modal
    line: number | null; // ✅ today line shown on bar chart
  };

  offers: Partial<Record<Exclude<SoftBookKey, "all">, BookOffer>>;
  bestBook: Exclude<SoftBookKey, "all"> | null;
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

const PLAYER_COL_PROPS = "player_name";
const MARKET_COL_PROPS = "market";
const SIDE_COL_PROPS = "side";

/* =========================================================
   Books + colors
========================================================= */

const HISTORY_BOOKS: AnyBook[] = ["draftkings", "fanduel", "betmgm", "pinnacle"];

const BOOK_COLOR: Record<AnyBook, string> = {
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

function bookFull(book: AnyBook) {
  if (book === "draftkings") return "DraftKings";
  if (book === "fanduel") return "FanDuel";
  if (book === "betmgm") return "BetMGM";
  return "Pinnacle";
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

function chooseBestOffer(offers: Partial<Record<Exclude<SoftBookKey, "all">, BookOffer>>) {
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
   History series builder
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

function collapseHistory(rows: any[], tsCol: string, bookCol: string, oddsCol: string): HistoryPoint[] {
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

  return Array.from(map.values()).sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
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

    // ---- games
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
      base.created_at = [base.created_at, r.created_at ?? null].filter(Boolean).sort().slice(-1)[0] ?? base.created_at;

      map.set(key, base);
    }

    // ---- props
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
        book: bk as AnyBook,
        odds: safeNum(r.odds, NaN),
        ev_pct: safeNum(r.ev_pct, 0),
        bet_fraction: clamp(safeNum(r.kelly_fraction, 0), 0, 1),
      };

      base.bestScore = Math.max(safeNum(base.bestScore, 0), clamp(safeNum(r.score, 0), 0, 100));
      base.created_at = [base.created_at, r.created_at ?? null].filter(Boolean).sort().slice(-1)[0] ?? base.created_at;

      // preserve mu/line if missing
      if (base.propMeta) {
        const nextMu = (r.mu ?? null) as number | null;
        if (nextMu != null && Number.isFinite(nextMu) && (base.propMeta.mu == null || !Number.isFinite(base.propMeta.mu)))
          base.propMeta.mu = nextMu;

        const nextLine = (r.line ?? null) as number | null;
        if (nextLine != null && Number.isFinite(nextLine) && (base.propMeta.line == null || !Number.isFinite(base.propMeta.line)))
          base.propMeta.line = nextLine;
      }

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
        // history only filter: don't remove rows; just clarifies the dropdown option
        list = list;
      } else {
        list = list.filter((p) => !!p.offers[bookFilter]);
      }
    }

    return list;
  }, [aggregated, kindFilter, bookFilter]);

  const bankroll = safeNum(settings?.bankroll, 0);
  const kellyFactor = clamp(safeNum(settings?.kelly_factor, 0), 0, 1);
  const settingsReady = !!(bankroll && kellyFactor);

  const headerStats = useMemo(() => {
    const best = filtered[0];
    const bestEv = best ? best.bestEvPct : 0;
    const bestScore = best ? best.bestScore : 0;
    return { bestEv, bestScore };
  }, [filtered]);

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
              Prism Model Picks
            </div>

            <h2 className="text-lg md:text-xl text-white mt-2 tracking-tight">Best +EV Plays</h2>

            <div className="text-xs text-[#a8a8a8] mt-1 leading-relaxed">
              Aggregated to 1 row per play. Tap/click the <span className="text-white">Pick</span> to open line movement.
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <Pill label="Plays" value={loading ? "…" : String(filtered.length)} />
              <Pill label="Best EV" value={loading ? "…" : pct(headerStats.bestEv, 1)} tone={evTone(headerStats.bestEv)} />
              <Pill label="Best Score" value={loading ? "…" : String(Math.round(headerStats.bestScore))} />
              <Pill label="Bankroll" value={bankroll ? formatMoney(bankroll) : "—"} />
              <Pill label="Kelly" value={settings?.kelly_factor != null ? `${(kellyFactor * 100).toFixed(1)}%` : "—"} />
            </div>
          </div>

          {/* Filters */}
          <div className="w-full md:w-auto">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-1 gap-2">
              <div className="inline-flex items-center bg-[#0b0b0b] border border-[#2a2a2a] rounded-lg overflow-hidden">
                <KindPill active={kindFilter === "all"} onClick={() => setKindFilter("all")} label="All" />
                <KindPill active={kindFilter === "game"} onClick={() => setKindFilter("game")} label="Game Lines" />
                <KindPill active={kindFilter === "prop"} onClick={() => setKindFilter("prop")} label="Player Props" />
              </div>

              <select
                value={bookFilter}
                onChange={(e) => setBookFilter(e.target.value as SoftBookKey)}
                className="px-3 py-2 bg-[#0b0b0b] border border-[#2a2a2a] rounded-lg text-[#d0d0d0] outline-none text-xs"
              >
                {SOFT_BOOKS.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="relative mt-4 text-xs text-[#808080] px-3 py-2 bg-[#0b0b0b] border border-[#2a2a2a] rounded-lg">
            Loading EV plays…
          </div>
        ) : null}

        {error ? (
          <div className="relative mt-3 text-xs text-red-400 px-3 py-2 bg-[#0b0b0b] border border-red-900/50 rounded-lg">
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
                  <th className="text-left p-3 text-[#808080] min-w-[280px]">Pick</th>
                  <th className="text-center p-3 text-[#808080] min-w-[80px]">Line</th>
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
                {filtered.map((p) => (
                  <PlayRow
                    key={p.playKey}
                    play={p}
                    bankroll={bankroll}
                    kellyFactor={kellyFactor}
                    settingsReady={settingsReady}
                    onOpenDetails={() => openDetails(p)}
                  />
                ))}

                {!loading && !filtered.length ? (
                  <tr>
                    <td colSpan={11} className="p-10 text-center text-xs text-[#808080]">
                      No positive EV plays found for this filter.
                      <div className="text-[11px] text-[#606060] mt-1">
                        If this seems wrong, confirm <span className="text-white">commence_time</span> is in the future and{" "}
                        <span className="text-white">ev_pct</span> is &gt; 0 for DK/FD/MGM rows.
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
            onOpenDetails={() => openDetails(p)}
          />
        ))}
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
}

/* =========================================================
   Desktop Row (ONLY pick column opens modal)
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
  const score = Math.round(safeNum(play.bestScore, 0));
  const sTone = scoreTone(score);

  const bestOffer = play.bestBook ? play.offers[play.bestBook] : null;

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
          </div>

          {/* Tiny best-book hint */}
          {bestOffer ? (
            <div
              className="shrink-0 inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1"
              title={`Best book: ${bookFull(bestOffer.book)} (${pct(bestOffer.ev_pct, 1)})`}
            >
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: BOOK_COLOR[bestOffer.book] }} />
              <span className="text-[10px] text-[#b0b0b0]">{bookShort(bestOffer.book)}</span>
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
        <button
          type="button"
          onClick={onOpenDetails}
          className="w-full text-left hover:opacity-90"
          title="Open line movement"
        >
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
}: {
  play: AggregatedPlay;
  bankroll: number;
  kellyFactor: number;
  settingsReady: boolean;
  onOpenDetails: () => void;
}) {
  const betAmount = settingsReady ? calcBetAmount(bankroll, play.bestBetFraction, kellyFactor) : 0;
  const mu = play.propMeta?.mu ?? null;
  const score = Math.round(safeNum(play.bestScore, 0));
  const sTone = scoreTone(score);

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
        </div>

        <div className="shrink-0 text-right">
          <div className="inline-flex items-center gap-2">
            <div className={["inline-flex items-center justify-center px-2 py-0.5 rounded border text-[11px] tabular-nums", sTone.bg, sTone.border, sTone.text].join(" ")}>
              {score}
            </div>
            <div className="text-right">
              <div className="text-[10px] text-[#606060]">Bet</div>
              <div className="text-[#d4af37] font-semibold tabular-nums">
                {settingsReady && betAmount > 0 ? formatMoney(betAmount) : "—"}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* PICK (clickable) */}
      <button
        type="button"
        onClick={onOpenDetails}
        className="mt-3 w-full text-left hover:opacity-90"
        title="Open line movement"
      >
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
                μ Projection: <span className="text-white tabular-nums">{fmtMu(mu)}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-white text-sm">
            {play.pickLabel}{" "}
            <span className="text-[#808080] text-xs">
              · {play.marketLabel} · {play.sideLabel} {play.lineLabel !== "—" ? play.lineLabel : ""}
            </span>
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
   Details Modal (LINE MOVEMENT line chart + FantasyPros BAR logs)
========================================================= */

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
  if (!open || !play) return null;

  const betAmount = settingsReady ? calcBetAmount(bankroll, play.bestBetFraction, kellyFactor) : 0;
  const mu = play.propMeta?.mu ?? null;

  return (
    <div className="fixed inset-0 z-[100]">
      <button type="button" onClick={onClose} className="absolute inset-0 bg-black/70" aria-label="Close details modal" />

      <div
        className="absolute inset-0 md:flex md:items-center md:justify-center p-0 md:p-6"
        style={{
          paddingTop: "max(env(safe-area-inset-top), 12px)",
          paddingBottom: "max(env(safe-area-inset-bottom), 12px)",
        }}
      >
        <div className="relative w-full md:max-w-4xl bg-[#0b0b0b] border border-[#2a2a2a] md:rounded-2xl rounded-t-2xl overflow-hidden flex flex-col max-h-[92vh] md:max-h-[85vh]">
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
                    μ Projection: <span className="text-white tabular-nums">{fmtMu(mu)}</span>
                  </div>
                ) : null}
              </div>

              <div className="shrink-0 text-right">
                <div className="text-[10px] text-[#606060]">Best EV</div>
                <div className={["font-semibold tabular-nums", evTone(play.bestEvPct)].join(" ")}>{pct(play.bestEvPct, 1)}</div>
                <div className="mt-1 text-[10px] text-[#606060]">Bet</div>
                <div className="text-[#d4af37] font-semibold tabular-nums">{settingsReady && betAmount > 0 ? formatMoney(betAmount) : "—"}</div>
              </div>
            </div>

            {/* Legend hint */}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-[#808080]">
              <LegendDot label="DK" color={BOOK_COLOR.draftkings} />
              <LegendDot label="FD" color={BOOK_COLOR.fanduel} />
              <LegendDot label="MGM" color={BOOK_COLOR.betmgm} />
              <LegendDot label="PIN" color={BOOK_COLOR.pinnacle} />
              <span className="text-[#404040]">·</span>
              <span>Tooltip shows date + time (CT)</span>
            </div>
          </div>

          {/* Body (scrollable) */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <OddsHistoryMiniChart play={play} />
            {play.kind === "prop" ? <FantasyProsGameLogs play={play} /> : null}
          </div>

          {/* Footer */}
          <div className="shrink-0 p-4 border-t border-[#1f1f1f] bg-[#0a0a0a] flex items-center justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg bg-[#111] border border-[#2a2a2a] text-[11px] text-[#d0d0d0] hover:bg-[#141414]"
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
   Odds History (LINE GRAPH + tooltip includes date + time CT)
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
            historyPropMarketKey(play.propMeta?.market ?? null) ?? historyPropMarketKey(play.marketLabel ?? null);

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

          const pts = collapseHistory(data ?? [], TS_COL_PROPS, BOOK_COL_PROPS, ODDS_COL_PROPS);
          setSeries(pts);

          if (!pts.length) {
            setDebug(`no rows (props): player="${player_name}" marketKey="${marketKey}" side="${sideCanon}" books=${HISTORY_BOOKS.join(",")}`);
          }
          return;
        }

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

  if (loading && !series.length) {
    return (
      <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl p-4">
        <div className="text-xs text-[#808080]">Loading line movement…</div>
      </div>
    );
  }

  if (!series.length) {
    return (
      <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl p-4">
        <div className="text-[10px] text-[#606060] mb-1">Line Movement (this side)</div>
        <div className="text-xs text-[#808080]">No odds history available for this side.</div>
        {debug ? <div className="mt-2 text-[10px] text-[#404040] break-words">{debug}</div> : null}
      </div>
    );
  }

  const hasAny = (k: AnyBook) => series.some((p) => Number.isFinite((p as any)[k]));

  const TooltipContent = (props: any) => {
    const { active, payload, label } = props;
    if (!active || !payload?.length) return null;

    const ts = String(label ?? "");
    const matchup = play.matchup ?? "—";
    const market = play.marketLabel;
    const side = play.sideLabel;
    const line = play.lineLabel;
    const start = play.commence_time ? `${fmtDateCentral(play.commence_time)} · ${fmtTimeCentral(play.commence_time)}` : "—";

    const order: AnyBook[] = ["draftkings", "fanduel", "betmgm", "pinnacle"];
    const rows = order
      .map((k) => {
        const found = payload.find((p: any) => p.dataKey === k);
        const v = found?.value;
        if (!Number.isFinite(Number(v))) return null;
        return { k, v: Number(v) };
      })
      .filter(Boolean) as { k: AnyBook; v: number }[];

    return (
      <div
        style={{
          background: "#0b0b0b",
          border: "1px solid #2a2a2a",
          padding: "10px",
          borderRadius: 10,
          color: "#d0d0d0",
          minWidth: 250,
          boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: "#fff", marginBottom: 6 }}>{fmtDateTimeCT(ts)}</div>

        <div style={{ fontSize: 11, color: "#b0b0b0", marginBottom: 8, lineHeight: 1.35 }}>
          <div style={{ color: "#ffffff" }}>{matchup}</div>
          <div>
            <span style={{ color: "#d4af37" }}>{market}</span> <span style={{ color: "#606060" }}>·</span>{" "}
            <span style={{ color: "#d0d0d0" }}>
              {side} {line !== "—" ? line : ""}
            </span>
          </div>
          <div style={{ color: "#808080" }}>Starts: {start}</div>

          {play.kind === "prop" ? (
            <div style={{ color: "#808080" }}>
              μ Projection:{" "}
              <span style={{ color: "#fff", fontVariantNumeric: "tabular-nums" }}>{fmtMu(play.propMeta?.mu ?? null)}</span>
            </div>
          ) : null}
        </div>

        <div style={{ display: "grid", gap: 4 }}>
          {rows.map(({ k, v }) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span style={{ fontSize: 11, color: BOOK_COLOR[k] }}>{bookShort(k)}</span>
              <span style={{ fontSize: 11, color: "#fff", fontVariantNumeric: "tabular-nums" }}>{american(v)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl p-4">
      <div className="text-[10px] text-[#606060] mb-2">Line Movement (this side)</div>

      <div className="h-[280px]">
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

            {hasAny("draftkings") ? (
              <Line
                type="monotone"
                dataKey="draftkings"
                name="DK"
                stroke={BOOK_COLOR.draftkings}
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ) : null}

            {hasAny("fanduel") ? (
              <Line
                type="monotone"
                dataKey="fanduel"
                name="FD"
                stroke={BOOK_COLOR.fanduel}
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ) : null}

            {hasAny("betmgm") ? (
              <Line
                type="monotone"
                dataKey="betmgm"
                name="MGM"
                stroke={BOOK_COLOR.betmgm}
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ) : null}

            {hasAny("pinnacle") ? (
              <Line
                type="monotone"
                dataKey="pinnacle"
                name="PIN"
                stroke={BOOK_COLOR.pinnacle}
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {debug ? <div className="mt-2 text-[10px] text-[#404040] break-words">{debug}</div> : null}
    </div>
  );
}

/* =========================================================
   FantasyPros Game Logs (props only) — BAR CHART
========================================================= */

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
    // show most recent 10 but plot oldest->newest left-to-right
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
                {overUnder ? (
                  <div style={{ marginTop: 4, fontSize: 11, color: overUnder === "OVER" ? OVER_GREEN : UNDER_RED }}>
                    {overUnder}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const activeBarStyle = { stroke: "#ffffff", strokeWidth: 1, fillOpacity: 1 };

  return (
    <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl p-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="text-[10px] text-[#606060]">FantasyPros Game Logs</div>
        {loading ? <div className="text-[10px] text-[#606060]">Loading…</div> : null}
      </div>

      {chartData.length ? (
        <div className="mb-3">
          <div className="text-[10px] text-[#606060] mb-2">
            Last {chartData.length} games · {statLabel} bars
            {todayLine != null && Number.isFinite(todayLine) ? <span className="text-[#808080]"> · Today Line {todayLine}</span> : null}
          </div>

          <div className="h-[230px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} barCategoryGap={12}>
                <CartesianGrid stroke="#1f1f1f" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "#808080" }}
                  axisLine={{ stroke: "#2a2a2a" }}
                  tickLine={{ stroke: "#2a2a2a" }}
                  minTickGap={12}
                />
                <YAxis tick={{ fontSize: 10, fill: "#808080" }} axisLine={{ stroke: "#2a2a2a" }} tickLine={{ stroke: "#2a2a2a" }} width={36} />

                {/* ✅ Tooltip cursor transparent so it doesn't shade the whole plot */}
                <Tooltip content={LogsTooltip} cursor={{ fill: "rgba(0,0,0,0)" }} />

                {/* ✅ Today's line reference */}
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
      ) : null}

      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-[#808080] border-b border-[#1f1f1f]">
                <th className="text-left py-1 pr-2">Date</th>
                <th className="text-left py-1 pr-2">Opp</th>
                <th className="text-left py-1 pr-2">Score</th>
                <th className="text-right py-1 pr-2">Min</th>
                <th className="text-right py-1 pr-0">{statLabel}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#121212]">
              {rows.slice(0, 10).map((r, idx) => {
                const d = { min: safeNum(r.min, 0), pts: safeNum(r.pts, 0), reb: safeNum(r.reb, 0), ast: safeNum(r.ast, 0), threes: safeNum(r.threes, 0) };
                const v = safeNum((d as any)[statKey], NaN);
                const line = todayLine != null && Number.isFinite(todayLine) ? todayLine : null;
                const isOver = line != null && Number.isFinite(v) ? v >= line : null;

                return (
                  <tr key={idx} className="text-[#d0d0d0]">
                    <td className="py-1 pr-2 whitespace-nowrap">{r.date}</td>
                    <td className="py-1 pr-2 whitespace-nowrap">{r.opp}</td>
                    <td className="py-1 pr-2 whitespace-nowrap text-[#b0b0b0]">{r.score}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{d.min}</td>
                    <td className="py-1 text-right tabular-nums" style={{ color: isOver == null ? "#d0d0d0" : isOver ? OVER_GREEN : UNDER_RED }}>
                      {Number.isFinite(v) ? v : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-2 text-[10px] text-[#606060]">Showing last {Math.min(10, rows.length)} games</div>
        </div>
      ) : (
        <div className="text-xs text-[#808080]">
          No game logs available.
          {debug ? <div className="mt-2 text-[10px] text-[#404040] break-words">{debug}</div> : null}
        </div>
      )}
    </div>
  );
}

/* =========================================================
   UI atoms
========================================================= */

function KindPill({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={[
        "px-3 py-2 text-xs transition-colors",
        active ? "bg-[#141414] text-white" : "bg-transparent text-[#808080] hover:text-white hover:bg-[#111]",
      ].join(" ")}
      type="button"
    >
      {label}
    </button>
  );
}

function Pill({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-1">
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

function StatChip({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={[
        "rounded-lg border px-2 py-2 text-center",
        accent
          ? "bg-[#d4af37]/10 border-[#d4af37]/25"
          : "bg-[#0a0a0a] border-[#1f1f1f"] // <-- ensure this string closes, then only ONE ]
      ].join(" ")}
    >
      <div className="text-[10px] text-[#606060]">{label}</div>
      <div
        className={[
          "mt-0.5 font-semibold tabular-nums",
          accent ? "text-[#d4af37]" : "text-white",
        ].join(" ")}
      >
        {value}
      </div>
    </div>
  );
}

function BookOfferCell({ offer, isBest }: { offer?: BookOffer; isBest?: boolean }) {
  if (!offer) return <div className="text-[#404040]">—</div>;

  const logo = bookLogoSrc(offer.book);
  const ring = isBest ? `shadow-[0_0_0_1px_${BOOK_COLOR[offer.book]}]` : "shadow-none";

  return (
    <div
      className={[
        "inline-flex flex-col items-center justify-center gap-1 px-2 py-1 rounded-lg border",
        isBest ? "bg-white/5 border-white/10" : "bg-[#0a0a0a] border-[#1f1f1f]",
        ring,
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

      <div className={["text-[10px] tabular-nums", isBest ? "text-[#d4af37]" : "text-[#808080]"].join(" ")}>
        {pct(offer.ev_pct, 1)}
      </div>
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
  const ring = isBest ? `shadow-[0_0_0_1px_${BOOK_COLOR[offer.book]}]` : "shadow-none";

  return (
    <div className={["rounded-lg p-2 text-center border", isBest ? "bg-white/5 border-white/10" : "bg-[#0a0a0a] border-[#1f1f1f]", ring].join(" ")}>
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
      <div className={["text-[10px] tabular-nums mt-1", isBest ? "text-[#d4af37]" : "text-[#808080]"].join(" ")}>
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

function PropPickInline({
  name,
  position,
  picture_url,
  sub,
  mu,
}: {
  name: string;
  position: string | null;
  picture_url: string | null;
  sub?: string;
  mu?: number | null;
}) {
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
          μ Projection: <span className="text-white tabular-nums">{fmtMu(mu ?? null)}</span>
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

