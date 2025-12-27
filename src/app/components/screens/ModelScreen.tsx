// screens/Model/ModelScreen.tsx — FULL REWRITE (Aggregated: 1 row per play, 3-book strip + Details Modals + Odds History)
// ✅ Game +EV plays from public.ev_plays
// ✅ Player prop +EV plays from public.player_prop_ev_latest
// ✅ NO duplicates: each unique play appears once
// ✅ Shows DK / FD / MGM odds (and tiny EV%) in the same row
// ✅ Highlights the BEST book for that play
// ✅ Filters: Play Type (All / Game Lines / Player Props) + Book (All / DK / FD / MGM)
// ✅ Bet $ uses app_settings.bankroll + app_settings.kelly_factor with best book’s bet fraction
// ✅ Click any row/card to open Details modal (offers + sizing + meta)
// ✅ Details modal shows ODDS HISTORY chart for that exact side (DK/FD/MGM)
// ✅ FIX (your issue): Props odds history is RESILIENT:
//    - Does NOT require line match
//    - Tries: event_id+exact name, then loosens constraints (no event_id, ilike name)
//    - Accepts market aliases (points vs player_points, etc.)
//    - Accepts book aliases (dk/fd/mgm vs draftkings/fanduel/betmgm)
//    - Reads from player_props_history with fallback to player_props_snapshot
//    - Uses last 48h window by default to keep queries light

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

type SoftBookKey = "all" | "draftkings" | "fanduel" | "betmgm";
type PlayKind = "all" | "game" | "prop";

type AppSettingsRow = {
  id: number;
  bankroll: number | null;
  kelly_factor: number | null;
  max_units_per_play?: number | null;
  updated_at?: string | null;
};

type EvPlayRow = {
  run_id: string;
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

  fp_id: number | string | null;
  player_name: string | null;
  position: string | null;
  picture_url: string | null;

  market: string | null; // often "assists"/"points"/"rebounds"/"threes"
  side: string | null; // "over"/"under"
  line: number | null;

  book: string; // "draftkings"/"fanduel"/"betmgm"
  odds: number;

  p_quantum: number | null;
  quantum_fair_odds: number;

  ev_pct: number;
  kelly_fraction: number;
  score: number;
};

type BookOffer = {
  book: "draftkings" | "fanduel" | "betmgm";
  odds: number; // bettable odds
  ev_pct: number;
  bet_fraction: number; // game: bet_fraction, prop: kelly_fraction
};

type AggregatedPlay = {
  kind: "game" | "prop";
  playKey: string;

  event_id: string;
  commence_time: string | null;
  matchup: string | null;

  // Display
  marketLabel: string;
  sideLabel: string;
  pickLabel: string;
  lineLabel: string;

  // Quantum / fair odds
  quantum_odds: number;
  quantum_prob?: number | null;

  // extra for game queries
  gameMeta?: {
    market: GameMarketKey;
    side: GameSideKey;
    line: number | null;
    team: string | null;
  };

  // extra for props
  propMeta?: {
    team: string | null;
    opponent: string | null;
    player_name: string | null;
    position: string | null;
    picture_url: string | null;

    market_raw?: string | null; // as stored in player_prop_ev_latest
    side_raw?: string | null; // as stored in player_prop_ev_latest
    line?: number | null;
    p_quantum?: number | null;

    fp_id?: string | null;
  };

  offers: Partial<Record<"draftkings" | "fanduel" | "betmgm", BookOffer>>;

  bestBook: "draftkings" | "fanduel" | "betmgm" | null;
  bestEvPct: number;
  bestBetFraction: number;
  bestScore: number;

  created_at: string | null;
};

/* =========================================================
   Constants
========================================================= */

const SOFT_BOOKS: { key: SoftBookKey; label: string }[] = [
  { key: "all", label: "All Books" },
  { key: "draftkings", label: "DraftKings" },
  { key: "fanduel", label: "FanDuel" },
  { key: "betmgm", label: "BetMGM" },
];

/* History tables */
const GAME_HISTORY_TABLE = "odds_history";
const PROP_HISTORY_TABLE_PRIMARY = "player_props_history";
const PROP_HISTORY_TABLE_FALLBACK = "player_props_snapshot";

/* =========================================================
   Formatting helpers
========================================================= */

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

function american(odds: number) {
  if (!Number.isFinite(odds)) return "—";
  return odds > 0 ? `+${Math.round(odds)}` : `${Math.round(odds)}`;
}

function safeNum(n: any, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function formatMoney(n: number) {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function pct(n: number, digits = 1) {
  const x = safeNum(n, 0);
  return `${x > 0 ? "+" : ""}${x.toFixed(digits)}%`;
}

function calcBetAmount(bankroll: number, betFraction: number, kellyFactor: number) {
  const b = Math.max(0, safeNum(bankroll, 0));
  const f = Math.max(0, safeNum(betFraction, 0));
  const k = clamp(safeNum(kellyFactor, 0), 0, 1);
  if (!b || !k || !f) return 0;
  return b * f * k;
}

function normalizeBookKey(bookmaker: string): SoftBookKey | "other" {
  const b = (bookmaker || "").toLowerCase();
  if (b === "draftkings" || b === "dk") return "draftkings";
  if (b === "fanduel" || b === "fd") return "fanduel";
  if (b === "betmgm" || b === "mgm") return "betmgm";
  return "other";
}

function bookLogoSrc(bookmaker: string): string | null {
  const b = (bookmaker || "").toLowerCase();
  if (b === "draftkings" || b === "dk") return "/books/dksquare.png";
  if (b === "fanduel" || b === "fd") return "/books/fdsquare.png";
  if (b === "betmgm" || b === "mgm") return "/books/mgmsquare.png";
  return null;
}

function bookShort(book: "draftkings" | "fanduel" | "betmgm") {
  if (book === "draftkings") return "DK";
  if (book === "fanduel") return "FD";
  return "MGM";
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

function propMarketLabel(marketRaw: string | null) {
  const m = (marketRaw || "").toLowerCase();

  if (m.includes("points_rebounds_assists") || m.includes("pra")) return "PRA";
  if (m.includes("points_assists") || m.includes("pa")) return "PTS+AST";
  if (m.includes("points_rebounds") || m.includes("pr")) return "PTS+REB";
  if (m.includes("rebounds_assists") || m.includes("ra")) return "REB+AST";

  if (m.includes("player_points") || m === "points" || m === "pts") return "Points";
  if (m.includes("player_rebounds") || m === "rebounds" || m === "reb") return "Rebounds";
  if (m.includes("player_assists") || m === "assists" || m === "ast") return "Assists";
  if (m.includes("player_threes") || m === "threes" || m.includes("3")) return "3PT";

  return marketRaw ? marketRaw.replaceAll("_", " ") : "Prop";
}

function propSideLabel(sideRaw: string | null) {
  const s = (sideRaw || "").toLowerCase();
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
   PlayKey builders (how we dedupe)
========================================================= */

function gamePlayKey(r: EvPlayRow) {
  // Unique per: event + market + side + line + team
  const team = (r.team || "").trim().toLowerCase();
  const line = r.line == null ? "x" : String(r.line);
  return `g|${r.event_id}|${r.market}|${r.side}|${line}|${team}`;
}

function propPlayKey(r: PlayerPropEvLatestRow) {
  // Unique per: event + (fp_id or player) + market + side + line
  const pid = r.fp_id != null ? String(r.fp_id) : (r.player_name || "").trim().toLowerCase();
  const market = (r.market || "").trim().toLowerCase();
  const side = (r.side || "").trim().toLowerCase();
  const line = r.line == null ? "x" : String(r.line);
  return `p|${r.event_id}|${pid}|${market}|${side}|${line}`;
}

/* =========================================================
   Aggregation helpers
========================================================= */

function chooseBestOffer(offers: Partial<Record<"draftkings" | "fanduel" | "betmgm", BookOffer>>) {
  const list = (["draftkings", "fanduel", "betmgm"] as const)
    .map((b) => (offers[b] ? ({ b, o: offers[b]! }) : null))
    .filter(Boolean) as { b: "draftkings" | "fanduel" | "betmgm"; o: BookOffer }[];

  if (!list.length) return { bestBook: null as const, bestEvPct: 0, bestBetFraction: 0 };

  list.sort((a, b) => {
    const ev = safeNum(b.o.ev_pct, 0) - safeNum(a.o.ev_pct, 0);
    if (ev !== 0) return ev;
    const bf = safeNum(b.o.bet_fraction, 0) - safeNum(a.o.bet_fraction, 0);
    if (bf !== 0) return bf;
    return Math.abs(safeNum(a.o.odds, 0)) - Math.abs(safeNum(b.o.odds, 0));
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
   History chart helpers
========================================================= */

type HistoryPoint = {
  ts: string;
  draftkings?: number | null;
  fanduel?: number | null;
  betmgm?: number | null;
};

function normalizeIso(raw: any): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function fmtHourMinCT(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
  });
}

function collapseHistory(rows: any[], bookCol: string, oddsCol: string, ...tsCols: string[]): HistoryPoint[] {
  const map = new Map<string, HistoryPoint>();

  for (const r of rows) {
    const book = String(r?.[bookCol] ?? "").toLowerCase();
    if (!["draftkings", "fanduel", "betmgm"].includes(book)) continue;

    const odds = Number(r?.[oddsCol]);
    if (!Number.isFinite(odds)) continue;

    let ts: string | null = null;
    for (const c of tsCols) {
      ts = normalizeIso(r?.[c]);
      if (ts) break;
    }
    if (!ts) continue;

    const cur = map.get(ts) ?? { ts };
    (cur as any)[book] = odds;
    map.set(ts, cur);
  }

  return Array.from(map.values()).sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

function toPropHistoryMarket(marketRaw: string | null): string | null {
  const m = (marketRaw || "").trim().toLowerCase();
  if (!m) return null;

  if (m.startsWith("player_")) return m;

  if (m === "points" || m === "pts") return "player_points";
  if (m === "rebounds" || m === "reb") return "player_rebounds";
  if (m === "assists" || m === "ast") return "player_assists";
  if (m === "threes" || m === "3pt" || m === "3pm" || m === "3s") return "player_threes";

  if (m === "pra" || m.includes("points_rebounds_assists")) return "player_points_rebounds_assists";
  if (m === "pa" || m.includes("points_assists")) return "player_points_assists";
  if (m === "pr" || m.includes("points_rebounds")) return "player_points_rebounds";
  if (m === "ra" || m.includes("rebounds_assists")) return "player_rebounds_assists";

  return m;
}

function toOverUnderSide(sideRaw: string | null): "over" | "under" | null {
  const s = (sideRaw || "").trim().toLowerCase();
  if (s === "over" || s === "o") return "over";
  if (s === "under" || s === "u") return "under";
  return null;
}

function buildPropMarketCandidates(marketRaw: string | null): string[] {
  const m0 = (marketRaw || "").trim().toLowerCase();
  const mCanon = toPropHistoryMarket(marketRaw);
  const list = [
    mCanon,
    m0,
    m0.startsWith("player_") ? m0.replace("player_", "") : null,
    m0 === "pts" ? "points" : null,
    m0 === "reb" ? "rebounds" : null,
    m0 === "ast" ? "assists" : null,
    m0 === "3pm" ? "threes" : null,
  ].filter(Boolean) as string[];

  return Array.from(new Set(list));
}

/* =========================================================
   Screen
========================================================= */

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

  // Load once
  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError(null);

      const nowIso = new Date().toISOString();

      const evQ = supabase
        .from("ev_plays")
        .select(
          "run_id,event_id,commence_time,matchup,team,market,side,line,bookmaker,book_odds,quantum_prob,quantum_odds,ev_pct,confidence_score,confidence_tier,kelly_fraction,bet_fraction,created_at"
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
            "fp_id",
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
        .select("id,bankroll,kelly_factor,max_units_per_play,updated_at")
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

  // Live-refresh settings
  useEffect(() => {
    const channel = supabase
      .channel("model-screen-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, () => {
        supabase
          .from("app_settings")
          .select("id,bankroll,kelly_factor,max_units_per_play,updated_at")
          .eq("id", 1)
          .limit(1)
          .then(({ data, error }) => {
            if (error) return;
            setSettings((data?.[0] ?? null) as AppSettingsRow | null);
          });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Modal ESC close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && detailsOpen) closeDetails();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailsOpen]);

  const aggregated = useMemo(() => {
    const map = new Map<string, AggregatedPlay>();

    // 1) games
    for (const r of games) {
      const bk = normalizeBookKey(r.bookmaker);
      if (bk === "other") continue;

      const key = gamePlayKey(r);
      const existing = map.get(key);

      const base: AggregatedPlay =
        existing ??
        ({
          kind: "game",
          playKey: key,

          event_id: r.event_id,
          commence_time: r.commence_time ?? null,
          matchup: r.matchup ?? null,

          marketLabel: marketLabelGame(r.market),
          sideLabel: sideLabelGame(r.market, r.side),
          pickLabel: r.market === "totals" ? (r.matchup ?? "Total") : (r.team ?? "—"),
          lineLabel: fmtLineGame(r.market, r.line),

          quantum_odds: safeNum(r.quantum_odds, NaN),
          quantum_prob: safeNum(r.quantum_prob, NaN),

          gameMeta: {
            market: r.market,
            side: r.side,
            line: r.line ?? null,
            team: r.team ?? null,
          },

          offers: {},

          bestBook: null,
          bestEvPct: 0,
          bestBetFraction: 0,
          bestScore: 0,

          created_at: r.created_at ?? null,
        } as AggregatedPlay);

      const offer: BookOffer = {
        book: bk,
        odds: safeNum(r.book_odds, NaN),
        ev_pct: safeNum(r.ev_pct, 0),
        bet_fraction: clamp(safeNum(r.bet_fraction, 0), 0, 1),
      };

      base.offers[bk] = offer;
      base.created_at = [base.created_at, r.created_at ?? null].filter(Boolean).sort().slice(-1)[0] ?? base.created_at;
      base.bestScore = Math.max(safeNum(base.bestScore, 0), safeNum(r.confidence_score, 0));

      map.set(key, base);
    }

    // 2) props
    for (const r of props) {
      const bk = normalizeBookKey(r.book);
      if (bk === "other") continue;

      const key = propPlayKey(r);
      const existing = map.get(key);

      const base: AggregatedPlay =
        existing ??
        ({
          kind: "prop",
          playKey: key,

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
            team: r.team ?? null,
            opponent: r.opponent ?? null,
            player_name: r.player_name ?? null,
            position: r.position ?? null,
            picture_url: r.picture_url ?? null,
            market_raw: r.market ?? null,
            side_raw: r.side ?? null,
            line: r.line ?? null,
            p_quantum: r.p_quantum ?? null,
            fp_id: r.fp_id != null ? String(r.fp_id) : null,
          },

          offers: {},

          bestBook: null,
          bestEvPct: 0,
          bestBetFraction: 0,
          bestScore: 0,

          created_at: r.created_at ?? null,
        } as AggregatedPlay);

      const offer: BookOffer = {
        book: bk,
        odds: safeNum(r.odds, NaN),
        ev_pct: safeNum(r.ev_pct, 0),
        bet_fraction: clamp(safeNum(r.kelly_fraction, 0), 0, 1),
      };

      base.offers[bk] = offer;
      base.created_at = [base.created_at, r.created_at ?? null].filter(Boolean).sort().slice(-1)[0] ?? base.created_at;
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
    if (bookFilter !== "all") list = list.filter((p) => !!p.offers[bookFilter]);

    return list;
  }, [aggregated, kindFilter, bookFilter]);

  const updatedText = useMemo(() => {
    const latest = filtered.map((p) => p.created_at).filter(Boolean).sort().slice(-1)[0];
    if (!latest) return "Updated —";
    const d = new Date(latest as string);
    const t = d.toLocaleTimeString("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "2-digit",
    });
    return `Updated ${t} CT`;
  }, [filtered]);

  const bankroll = safeNum(settings?.bankroll, 0);
  const kellyFactor = clamp(safeNum(settings?.kelly_factor, 0), 0, 1);
  const settingsReady = !!(bankroll && kellyFactor);

  const totalBetDollars = useMemo(() => {
    if (!settingsReady) return 0;
    return filtered.reduce((sum, p) => sum + calcBetAmount(bankroll, p.bestBetFraction, kellyFactor), 0);
  }, [filtered, bankroll, kellyFactor, settingsReady]);

  const counts = useMemo(() => {
    const game = filtered.filter((p) => p.kind === "game").length;
    const prop = filtered.filter((p) => p.kind === "prop").length;
    return { total: filtered.length, game, prop };
  }, [filtered]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h2 className="text-xl text-white mb-1">Model Picks</h2>
          <p className="text-xs text-[#808080]">
            {counts.total} plays · {counts.game} game · {counts.prop} props · {updatedText}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* kind filter */}
          <div className="inline-flex items-center bg-[#111] border border-[#2a2a2a] rounded overflow-hidden">
            <KindPill active={kindFilter === "all"} onClick={() => setKindFilter("all")} label="All" />
            <KindPill active={kindFilter === "game"} onClick={() => setKindFilter("game")} label="Game Lines" />
            <KindPill active={kindFilter === "prop"} onClick={() => setKindFilter("prop")} label="Player Props" />
          </div>

          {/* book filter */}
          <select
            value={bookFilter}
            onChange={(e) => setBookFilter(e.target.value as SoftBookKey)}
            className="px-2 py-1 bg-[#111] border border-[#2a2a2a] rounded text-[#d0d0d0] outline-none"
            title="Filter by sportsbook"
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

          <div className="px-2 py-1 bg-[#1a1a1a] rounded text-[#808080]">
            Total Bet: <span className="text-[#d4af37]">{totalBetDollars ? formatMoney(totalBetDollars) : "—"}</span>
          </div>
        </div>
      </div>

      {/* Status */}
      {loading && (
        <div className="text-xs text-[#808080] px-3 py-2 bg-[#0f0f0f] border border-[#2a2a2a] rounded">
          Loading EV plays…
        </div>
      )}

      {error && (
        <div className="text-xs text-red-400 px-3 py-2 bg-[#0f0f0f] border border-red-900/50 rounded">
          Failed to load ev_plays: {error}
        </div>
      )}

      {/* MOBILE: cards */}
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
            onOpenDetails={() => openDetails(p)}
          />
        ))}
      </div>

      {/* DESKTOP: table */}
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
                    <img
                      src="/logos/Quantum.png"
                      alt="Quantum"
                      className="h-5 md:h-7 w-auto opacity-90"
                      draggable={false}
                    />
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
                      className="h-5 md:h-7 w-auto opacity-90"
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
                  onOpenDetails={() => openDetails(p)}
                />
              ))}

              {!loading && !filtered.length && (
                <tr>
                  <td colSpan={11} className="p-6 text-center text-xs text-[#808080]">
                    No positive EV plays found for this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-6 text-[10px] text-[#606060] pt-2">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-[#d4af37]/20 border border-[#d4af37]/40 rounded" />
          <span>Positive EV (aggregated per play across books)</span>
        </div>

        <div>
          <span className="text-[#808080]">Bet $:</span> bankroll × best_book_fraction × kelly_factor
        </div>

        <div className="text-[#808080]">
          Tip: click any row/card for <span className="text-white">Details</span>.
        </div>

        {!settingsReady ? (
          <div className="text-[#808080]">
            Set <span className="text-white">Bankroll</span> and{" "}
            <span className="text-white">Kelly Factor</span> in Settings to enable bet amounts.
          </div>
        ) : null}
      </div>

      {/* DETAILS MODAL */}
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
   Desktop Row
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
    <tr
      className="hover:bg-[#0f0f0f]/50 transition-colors cursor-pointer"
      onClick={onOpenDetails}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpenDetails();
      }}
      title="Open details"
    >
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

      <td className="p-3 text-left">
        {play.kind === "prop" ? (
          <PropPickInline
            name={play.propMeta?.player_name ?? play.pickLabel}
            position={play.propMeta?.position ?? null}
            picture_url={play.propMeta?.picture_url ?? null}
          />
        ) : (
          <div className="text-white">{play.pickLabel}</div>
        )}
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
        <BetAmountValue
          amount={betAmount}
          frac={play.bestBetFraction}
          bankroll={bankroll}
          kellyFactor={kellyFactor}
          ready={settingsReady}
        />
      </td>
    </tr>
  );
}

/* =========================================================
   Mobile Card
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
      {/* Top line */}
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

      {/* Pick */}
      <div className="mt-3">
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
              · {play.marketLabel} · {play.sideLabel} {play.lineLabel !== "—" ? play.lineLabel : ""}
            </span>
          </div>
        )}
      </div>

      {/* Odds strip */}
      <div className="mt-3 grid grid-cols-4 gap-2 items-stretch">
        <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-2 text-center">
          <div className="text-[10px] text-[#606060]">Quantum</div>
          <div className="text-white font-semibold tabular-nums">{american(play.quantum_odds)}</div>
        </div>

        <BookChip offer={play.offers.draftkings} isBest={play.bestBook === "draftkings"} />
        <BookChip offer={play.offers.fanduel} isBest={play.bestBook === "fanduel"} />
        <BookChip offer={play.offers.betmgm} isBest={play.bestBook === "betmgm"} />
      </div>

      {/* EV + Score + Details */}
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

        <button
          type="button"
          onClick={onOpenDetails}
          className="shrink-0 px-2.5 py-1 rounded bg-[#111] border border-[#2a2a2a] text-[11px] text-[#d0d0d0] hover:bg-[#141414]"
        >
          Details
        </button>
      </div>

      {settingsReady && betAmount > 0 ? (
        <div className="mt-2 text-[10px] text-[#606060] tabular-nums">
          {(play.bestBetFraction * 100).toFixed(2)}% × {Math.round(kellyFactor * 100)}% × {formatMoney(bankroll)}
        </div>
      ) : null}
    </div>
  );
}

/* =========================================================
   Details Modal (Offers + Sizing + Meta + Odds History)
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
  const [tab, setTab] = useState<"offers" | "sizing" | "meta">("offers");

  useEffect(() => {
    if (open) setTab("offers");
  }, [open]);

  if (!open || !play) return null;

  const betAmount = settingsReady ? calcBetAmount(bankroll, play.bestBetFraction, kellyFactor) : 0;

  const offersList = (["draftkings", "fanduel", "betmgm"] as const)
    .map((b) => (play.offers[b] ? ({ key: b, offer: play.offers[b]! }) : null))
    .filter(Boolean) as { key: "draftkings" | "fanduel" | "betmgm"; offer: BookOffer }[];

  return (
    <div className="fixed inset-0 z-[100]">
      {/* Backdrop */}
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-black/70"
        aria-label="Close details modal"
      />

      {/* Panel */}
      <div className="absolute inset-x-0 bottom-0 md:inset-0 md:flex md:items-center md:justify-center p-0 md:p-6">
        <div className="relative w-full md:max-w-3xl bg-[#0b0b0b] border border-[#2a2a2a] md:rounded-xl rounded-t-xl overflow-hidden">
          {/* Header */}
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
              </div>

              <div className="shrink-0 flex items-center gap-2">
                <div className="text-right">
                  <div className="text-[10px] text-[#606060]">Best EV</div>
                  <div className="text-[#d4af37] font-semibold tabular-nums">{pct(play.bestEvPct, 1)}</div>
                </div>

                <button
                  type="button"
                  onClick={onClose}
                  className="px-2.5 py-1 rounded bg-[#111] border border-[#2a2a2a] text-[11px] text-[#d0d0d0] hover:bg-[#141414]"
                >
                  Close
                </button>
              </div>
            </div>

            {/* Subheader: pick */}
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                {play.kind === "prop" ? (
                  <div className="flex items-center gap-3">
                    <PropAvatar url={play.propMeta?.picture_url ?? null} name={play.pickLabel} />
                    <div className="min-w-0">
                      <div className="text-white truncate">
                        {play.pickLabel}
                        {play.propMeta?.position ? (
                          <span className="text-[#808080]"> · {String(play.propMeta.position).toUpperCase()}</span>
                        ) : null}
                      </div>
                      <div className="text-[11px] text-[#808080] mt-0.5 truncate">
                        {play.marketLabel} · {play.sideLabel} {play.lineLabel}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-white">
                    <span className="text-[#d4af37]">{play.marketLabel}</span>{" "}
                    <span className="text-[#606060]">·</span>{" "}
                    <span className="text-white">{play.pickLabel}</span>{" "}
                    <span className="text-[#808080]">
                      · {play.sideLabel} {play.lineLabel !== "—" ? play.lineLabel : ""}
                    </span>
                  </div>
                )}
              </div>

              <div className="shrink-0 text-right">
                <div className="text-[10px] text-[#606060]">Bet</div>
                <div className="text-[#d4af37] font-semibold tabular-nums">
                  {settingsReady && betAmount > 0 ? formatMoney(betAmount) : "—"}
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="mt-4 inline-flex items-center bg-[#111] border border-[#2a2a2a] rounded overflow-hidden">
              <TabPill active={tab === "offers"} onClick={() => setTab("offers")} label="Offers" />
              <TabPill active={tab === "sizing"} onClick={() => setTab("sizing")} label="Sizing" />
              <TabPill active={tab === "meta"} onClick={() => setTab("meta")} label="Meta" />
            </div>
          </div>

          {/* Body */}
          <div className="p-4">
            {tab === "offers" ? (
              <div className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
                    <div className="text-[10px] text-[#606060]">Quantum</div>
                    <div className="mt-1 text-white font-semibold tabular-nums text-lg">{american(play.quantum_odds)}</div>
                    {Number.isFinite(safeNum(play.quantum_prob, NaN)) ? (
                      <div className="mt-1 text-[11px] text-[#808080] tabular-nums">
                        p ≈ {(clamp(safeNum(play.quantum_prob, 0), 0, 1) * 100).toFixed(1)}%
                      </div>
                    ) : null}
                  </div>

                  <div className="md:col-span-2 bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
                    <div className="text-[10px] text-[#606060] mb-2">Sportsbooks</div>
                    <div className="space-y-2">
                      {offersList.length ? (
                        offersList.map(({ key, offer }) => (
                          <OfferRow key={key} offer={offer} isBest={play.bestBook === key} />
                        ))
                      ) : (
                        <div className="text-xs text-[#808080]">No book offers found for this play.</div>
                      )}
                    </div>
                  </div>
                </div>

                <OddsHistoryMiniChart play={play} />

                <div className="text-[10px] text-[#606060]">
                  Best book is highlighted. Tap/click other tabs for sizing + metadata.
                </div>
              </div>
            ) : null}

            {tab === "sizing" ? (
              <div className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
                    <div className="text-[10px] text-[#606060]">Inputs</div>
                    <div className="mt-2 space-y-1 text-[11px] text-[#d0d0d0]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[#808080]">Bankroll</span>
                        <span className="tabular-nums text-white">{bankroll ? formatMoney(bankroll) : "—"}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[#808080]">Kelly Factor</span>
                        <span className="tabular-nums text-white">{(kellyFactor * 100).toFixed(1)}%</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[#808080]">Best Book Fraction</span>
                        <span className="tabular-nums text-white">{(play.bestBetFraction * 100).toFixed(2)}%</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[#808080]">Best EV</span>
                        <span className="tabular-nums text-[#d4af37]">{pct(play.bestEvPct, 1)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
                    <div className="text-[10px] text-[#606060]">Bet Amount</div>
                    <div className="mt-2">
                      <div className="inline-flex items-center px-3 py-1 rounded bg-[#d4af37]/20 border border-[#d4af37]/40 text-[#d4af37] font-semibold tabular-nums text-lg">
                        {settingsReady && betAmount > 0 ? formatMoney(betAmount) : "—"}
                      </div>
                      <div className="mt-2 text-[11px] text-[#808080] tabular-nums">
                        {settingsReady ? (
                          <>
                            {formatMoney(bankroll)} × {(play.bestBetFraction * 100).toFixed(2)}% ×{" "}
                            {(kellyFactor * 100).toFixed(1)}%
                          </>
                        ) : (
                          <>Set bankroll + kelly_factor in Settings to enable sizing.</>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
                  <div className="text-[10px] text-[#606060] mb-2">Per-book fractions</div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <MiniFrac book="draftkings" offer={play.offers.draftkings} />
                    <MiniFrac book="fanduel" offer={play.offers.fanduel} />
                    <MiniFrac book="betmgm" offer={play.offers.betmgm} />
                  </div>
                </div>
              </div>
            ) : null}

            {tab === "meta" ? (
              <div className="space-y-3">
                <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
                  <div className="text-[10px] text-[#606060] mb-2">Core</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
                    <MetaRow k="Kind" v={play.kind === "prop" ? "Player Prop" : "Game Line"} />
                    <MetaRow k="Market" v={`${play.marketLabel} · ${play.sideLabel}`} />
                    <MetaRow k="Pick" v={play.pickLabel} />
                    <MetaRow k="Line" v={play.lineLabel} />
                    <MetaRow k="Commence" v={`${fmtDateCentral(play.commence_time)} · ${fmtTimeCentral(play.commence_time)}`} />
                    <MetaRow k="Event ID" v={play.event_id} mono />
                    <MetaRow k="Updated" v={play.created_at ? fmtTimeCentral(play.created_at) : "—"} />
                    <MetaRow k="Score" v={`${Math.round(play.bestScore)}`} />
                  </div>
                </div>

                {play.kind === "prop" ? (
                  <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
                    <div className="text-[10px] text-[#606060] mb-2">Prop details</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
                      <MetaRow k="Team" v={play.propMeta?.team ?? "—"} />
                      <MetaRow k="Opponent" v={play.propMeta?.opponent ?? "—"} />
                      <MetaRow k="Position" v={play.propMeta?.position ? String(play.propMeta.position).toUpperCase() : "—"} />
                      <MetaRow k="Market raw" v={play.propMeta?.market_raw ?? "—"} mono />
                      <MetaRow k="Side raw" v={play.propMeta?.side_raw ?? "—"} mono />
                      <MetaRow k="FP id" v={play.propMeta?.fp_id ?? "—"} mono />
                      <MetaRow
                        k="p_quantum"
                        v={
                          play.propMeta?.p_quantum != null
                            ? `${(clamp(safeNum(play.propMeta.p_quantum, 0), 0, 1) * 100).toFixed(1)}%`
                            : "—"
                        }
                        mono
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-[#1f1f1f] bg-[#0a0a0a] flex items-center justify-between">
            <div className="text-[10px] text-[#606060]">
              Best book: <span className="text-[#d4af37]">{play.bestBook ? bookShort(play.bestBook) : "—"}</span>
              <span className="text-[#404040]"> · </span>
              EV: <span className="text-[#d4af37] tabular-nums">{pct(play.bestEvPct, 1)}</span>
            </div>

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
   Odds History chart (modal) — FIXED FOR PROPS
========================================================= */

function OddsHistoryMiniChart({ play }: { play: AggregatedPlay }) {
  const [rows, setRows] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [debug, setDebug] = useState<string>("");

  useEffect(() => {
    let mounted = true;

    async function load() {
      if (!play?.event_id) return;

      setLoading(true);
      setDebug("");
      try {
        // --------------------
        // GAME HISTORY
        // --------------------
        if (play.kind === "game") {
          const gm = play.gameMeta;
          if (!gm) {
            if (mounted) setRows([]);
            return;
          }

          let q: any = supabase
            .from(GAME_HISTORY_TABLE)
            .select("event_id,market,side,line,bookmaker,odds,ts,created_at")
            .eq("event_id", play.event_id)
            .eq("market", gm.market)
            .eq("side", gm.side)
            .in("bookmaker", ["draftkings", "fanduel", "betmgm"])
            .order("ts", { ascending: true });

          if (gm.market !== "h2h") q = q.eq("line", gm.line);

          const { data, error } = await q;
          if (!mounted) return;

          if (error) {
            console.warn("[OddsHistoryMiniChart] game history error:", error.message);
            setRows([]);
            setDebug(`game history error: ${error.message}`);
            return;
          }

          setRows(collapseHistory(data ?? [], "bookmaker", "odds", "ts", "created_at"));
          return;
        }

        // --------------------
        // PROP HISTORY (resilient)
        // --------------------
        const pm = play.propMeta;

        const playerNameRaw = (pm?.player_name ?? play.pickLabel ?? "").trim();
        const side = toOverUnderSide(pm?.side_raw ?? null);
        const marketCandidates = buildPropMarketCandidates(pm?.market_raw ?? play.marketLabel);

        if (!playerNameRaw || !side || !marketCandidates.length) {
          if (mounted) {
            setRows([]);
            setDebug(`missing keys: name=${!!playerNameRaw} side=${!!side} markets=${marketCandidates.length}`);
          }
          return;
        }

        // last 48h window
        const since = new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString();

        const BOOK_ALIASES = ["draftkings", "dk", "fanduel", "fd", "betmgm", "mgm"];

        const normalizeBook = (b: any) => {
          const x = String(b ?? "").toLowerCase();
          if (x === "dk") return "draftkings";
          if (x === "fd") return "fanduel";
          if (x === "mgm") return "betmgm";
          return x;
        };

        async function tryPrimaryHistory(opts: { useEventId: boolean; ilikeName: boolean }) {
          let q: any = supabase
            .from(PROP_HISTORY_TABLE_PRIMARY)
            .select("event_id,player_name,market,side,bookmaker,book,odds,ts,created_at,snapshot_ts,inserted_at")
            // If your table doesn't have these exact columns, it will throw — we catch and fallback.
            .gte("created_at", since)
            .eq("side", side);

          if (opts.useEventId) q = q.eq("event_id", play.event_id);

          // market OR chain
          const marketOr = marketCandidates.map((m) => `market.eq.${m}`).join(",");
          q = q.or(marketOr);

          if (opts.ilikeName) {
            const pattern = `%${playerNameRaw.replace(/\s+/g, "%")}%`;
            q = q.ilike("player_name", pattern);
          } else {
            q = q.eq("player_name", playerNameRaw);
          }

          q = q.order("ts", { ascending: true });

          const res = await q;
          if (res.error) return { ok: false as const, data: [] as any[], error: res.error.message };

          const filtered = (res.data ?? []).filter((r: any) => {
            const b = normalizeBook(r.bookmaker ?? r.book);
            return BOOK_ALIASES.includes(b);
          });

          const normalized = filtered.map((r: any) => ({ ...r, __book_norm: normalizeBook(r.bookmaker ?? r.book) }));
          return { ok: true as const, data: normalized, error: "" };
        }

        async function tryFallbackSnapshot(opts: { useEventId: boolean; ilikeName: boolean }) {
          let q: any = supabase
            .from(PROP_HISTORY_TABLE_FALLBACK)
            .select("event_id,player_name,market,side,book,bookmaker,odds,snapshot_ts,ts,created_at,inserted_at")
            .gte("created_at", since)
            .eq("side", side);

          if (opts.useEventId) q = q.eq("event_id", play.event_id);

          const marketOr = marketCandidates.map((m) => `market.eq.${m}`).join(",");
          q = q.or(marketOr);

          if (opts.ilikeName) {
            const pattern = `%${playerNameRaw.replace(/\s+/g, "%")}%`;
            q = q.ilike("player_name", pattern);
          } else {
            q = q.eq("player_name", playerNameRaw);
          }

          q = q.order("snapshot_ts", { ascending: true });

          const res = await q;
          if (res.error) return { ok: false as const, data: [] as any[], error: res.error.message };

          const filtered = (res.data ?? []).filter((r: any) => {
            const b = normalizeBook(r.book ?? r.bookmaker);
            return BOOK_ALIASES.includes(b);
          });

          const normalized = filtered.map((r: any) => ({ ...r, __book_norm: normalizeBook(r.book ?? r.bookmaker) }));
          return { ok: true as const, data: normalized, error: "" };
        }

        const attempts: Array<{
          label: string;
          run: () => Promise<{ ok: boolean; data: any[]; error: string }>;
        }> = [
          { label: "primary strict (event + exact name)", run: () => tryPrimaryHistory({ useEventId: true, ilikeName: false }) },
          { label: "primary loose (no event + exact name)", run: () => tryPrimaryHistory({ useEventId: false, ilikeName: false }) },
          { label: "primary ilike (no event + fuzzy name)", run: () => tryPrimaryHistory({ useEventId: false, ilikeName: true }) },
          { label: "fallback strict (event + exact name)", run: () => tryFallbackSnapshot({ useEventId: true, ilikeName: false }) },
          { label: "fallback ilike (no event + fuzzy name)", run: () => tryFallbackSnapshot({ useEventId: false, ilikeName: true }) },
        ];

        let picked: { label: string; data: any[]; error?: string } | null = null;
        let lastErr = "";

        for (const a of attempts) {
          const res = await a.run();
          if (!mounted) return;

          if (res.ok && res.data.length) {
            picked = { label: a.label, data: res.data };
            break;
          }
          if (res.error) lastErr = `${a.label}: ${res.error}`;
        }

        if (!picked) {
          setRows([]);
          setDebug(
            [
              "no rows found",
              `name="${playerNameRaw}"`,
              `side="${side}"`,
              `markets=[${marketCandidates.join(", ")}]`,
              lastErr ? `lastErr=${lastErr}` : "",
            ]
              .filter(Boolean)
              .join(" · ")
          );
          return;
        }

        const pts = collapseHistory(picked.data, "__book_norm", "odds", "ts", "snapshot_ts", "inserted_at", "created_at");
        setRows(pts);

        if (!pts.length) {
          setDebug(
            [
              `matched: ${picked.label}`,
              `name="${playerNameRaw}"`,
              `side="${side}"`,
              `markets=[${marketCandidates.join(", ")}]`,
              "but points collapsed to 0 (likely missing timestamps/odds columns)",
            ].join(" · ")
          );
        } else {
          setDebug(`matched: ${picked.label}`);
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
      <div className="mt-3 bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
        <div className="text-xs text-[#808080]">Loading odds history…</div>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="mt-3 bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
        <div className="text-[10px] text-[#606060] mb-1">Odds History (this side)</div>
        <div className="text-xs text-[#808080]">No odds history available for this side.</div>
        {debug ? <div className="mt-2 text-[10px] text-[#404040] break-words">{debug}</div> : null}
      </div>
    );
  }

  return (
    <div className="mt-3 bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
      <div className="text-[10px] text-[#606060] mb-2">Odds History (this side)</div>

      <div className="h-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows}>
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
              labelFormatter={(l) => `CT ${fmtHourMinCT(String(l))}`}
              contentStyle={{
                background: "#0b0b0b",
                border: "1px solid #2a2a2a",
                color: "#d0d0d0",
              }}
            />
            <Legend />
            <Line type="monotone" dataKey="draftkings" name="DK" dot={false} strokeWidth={2} />
            <Line type="monotone" dataKey="fanduel" name="FD" dot={false} strokeWidth={2} />
            <Line type="monotone" dataKey="betmgm" name="MGM" dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {debug ? <div className="mt-2 text-[10px] text-[#404040] break-words">{debug}</div> : null}
    </div>
  );
}

/* =========================================================
   Modal atoms
========================================================= */

function TabPill({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={[
        "px-3 py-1.5 text-xs transition-colors",
        active ? "bg-[#1a1a1a] text-white" : "bg-transparent text-[#808080] hover:text-white hover:bg-[#141414]",
      ].join(" ")}
      type="button"
    >
      {label}
    </button>
  );
}

function OfferRow({ offer, isBest }: { offer: BookOffer; isBest: boolean }) {
  const logo = bookLogoSrc(offer.book);
  return (
    <div
      className={[
        "flex items-center justify-between gap-3 rounded border px-3 py-2",
        isBest ? "bg-[#d4af37]/12 border-[#d4af37]/40" : "bg-[#0b0b0b] border-[#1f1f1f]",
      ].join(" ")}
    >
      <div className="flex items-center gap-2 min-w-0">
        {logo ? (
          <img src={logo} alt={bookShort(offer.book)} className="h-5 w-5 opacity-95 shrink-0" draggable={false} />
        ) : (
          <div className="h-5 w-5 rounded bg-[#111] border border-[#2a2a2a] flex items-center justify-center text-[10px] text-[#808080]">
            {bookShort(offer.book)}
          </div>
        )}
        <div className="text-white font-semibold tabular-nums">{american(offer.odds)}</div>
      </div>

      <div className="flex items-center gap-4">
        <div className="text-right">
          <div className="text-[10px] text-[#606060]">EV</div>
          <div className={isBest ? "text-[#d4af37] tabular-nums" : "text-[#b0b0b0] tabular-nums"}>
            {pct(offer.ev_pct, 1)}
          </div>
        </div>

        <div className="text-right">
          <div className="text-[10px] text-[#606060]">Frac</div>
          <div className="text-white tabular-nums">{(clamp(offer.bet_fraction, 0, 1) * 100).toFixed(2)}%</div>
        </div>
      </div>
    </div>
  );
}

function MiniFrac({ book, offer }: { book: "draftkings" | "fanduel" | "betmgm"; offer?: BookOffer }) {
  const logo = bookLogoSrc(book);
  return (
    <div className="rounded border border-[#1f1f1f] bg-[#0b0b0b] px-3 py-2 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        {logo ? (
          <img src={logo} alt={bookShort(book)} className="h-4 w-4 opacity-95" draggable={false} />
        ) : (
          <div className="h-4 w-4 rounded bg-[#111] border border-[#2a2a2a] flex items-center justify-center text-[9px] text-[#808080]">
            {bookShort(book)}
          </div>
        )}
        <div className="text-[11px] text-[#d0d0d0]">{bookShort(book)}</div>
      </div>

      <div className="text-right">
        <div className="text-[10px] text-[#606060]">Frac</div>
        <div className="text-white tabular-nums">{offer ? `${(offer.bet_fraction * 100).toFixed(2)}%` : "—"}</div>
      </div>
    </div>
  );
}

function MetaRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-[#0b0b0b] border border-[#1f1f1f] rounded px-3 py-2">
      <div className="text-[#808080] text-[10px]">{k}</div>
      <div className={["text-[#d0d0d0] text-[11px] truncate max-w-[60%]", mono ? "font-mono" : ""].join(" ")}>
        {v}
      </div>
    </div>
  );
}

/* =========================================================
   UI atoms (table/cards)
========================================================= */

function KindPill({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={[
        "px-2.5 py-1 text-xs transition-colors",
        active ? "bg-[#1a1a1a] text-white" : "bg-transparent text-[#808080] hover:text-white hover:bg-[#141414]",
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
  const oddsTxt = american(offer.odds);

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
        <div className="text-white font-semibold tabular-nums">{oddsTxt}</div>
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

function BetAmountValue({
  amount,
  frac,
  bankroll,
  kellyFactor,
  ready,
}: {
  amount: number;
  frac: number;
  bankroll: number;
  kellyFactor: number;
  ready: boolean;
}) {
  if (!ready || !Number.isFinite(amount) || amount <= 0) {
    return <div className="text-[#404040]">—</div>;
  }

  return (
    <div className="inline-flex flex-col items-center justify-center">
      <div className="inline-flex items-center justify-center px-2 py-0.5 bg-[#d4af37]/20 border border-[#d4af37]/40 rounded text-[#d4af37] tabular-nums">
        {formatMoney(amount)}
      </div>
      <div className="text-[10px] text-[#606060] mt-1 tabular-nums">
        {(frac * 100).toFixed(2)}% × {Math.round(kellyFactor * 100)}% × {formatMoney(bankroll)}
      </div>
    </div>
  );
}

