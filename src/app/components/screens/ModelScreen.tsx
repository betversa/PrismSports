// screens/Model/ModelScreen.tsx — FULL REWRITE (Aggregated: 1 row per play, 3-book strip + Details Modal + Prop Odds History)
// ✅ Game +EV plays from public.ev_plays
// ✅ Player prop +EV plays from public.player_prop_ev_latest
// ✅ NO duplicates: each unique play appears once
// ✅ Shows DK / FD / MGM odds (and tiny EV%) in the same row
// ✅ Highlights the BEST book for that play
// ✅ Filters: Play Type (All / Game Lines / Player Props) + Book (All / DK / FD / MGM)
// ✅ Bet $ uses app_settings.bankroll + app_settings.kelly_factor with best book’s bet fraction
// ✅ NEW: Click any row/card to open a Details modal (offers + sizing + meta + prop odds history graph)
// ✅ Prop odds history pulls from public.player_props_history (NOT player_props_snapshot)
// ✅ Mobile cards + Desktop table

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
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

type PlayerPropsHistoryRow = {
  id: number | string;
  ts: string | null;

  run_id?: string | null;
  sport_key?: string | null;
  event_id: string;

  commence_time?: string | null;
  home_team?: string | null;
  away_team?: string | null;

  player_name: string | null;
  player_id?: string | number | null;

  team?: string | null;
  opponent?: string | null;

  market: string | null;
  side: string | null;
  line: number | null;

  odds: number | null;
  bookmaker: string | null;

  source?: string | null;
  inserted_at?: string | null;
};

type BookOffer = {
  book: "draftkings" | "fanduel" | "betmgm";
  odds: number; // bettable odds
  ev_pct: number;
  bet_fraction: number; // fraction to use for sizing (game: bet_fraction, prop: kelly_fraction)
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
  quantum_prob?: number | null; // used in modal (optional)

  // extra for props
  propMeta?: {
    team: string | null;
    opponent: string | null;
    player_name: string | null;
    position: string | null;
    picture_url: string | null;
    market_raw?: string | null;
    side_raw?: string | null;
    line?: number | null;
    p_quantum?: number | null;
  };

  // Books
  offers: Partial<Record<"draftkings" | "fanduel" | "betmgm", BookOffer>>;

  // Derived
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

function fmtDateTimeCentralShort(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} ${time}`;
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
  if (b === "draftkings") return "draftkings";
  if (b === "fanduel") return "fanduel";
  if (b === "betmgm") return "betmgm";
  return "other";
}

function bookLogoSrc(bookmaker: string): string | null {
  const b = (bookmaker || "").toLowerCase();
  if (b === "draftkings") return "/books/dksquare.png";
  if (b === "fanduel") return "/books/fdsquare.png";
  if (b === "betmgm") return "/books/mgmsquare.png";
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

  if (m.includes("player_points") || m.endsWith("points")) return "Points";
  if (m.includes("player_rebounds") || m.endsWith("rebounds")) return "Rebounds";
  if (m.includes("player_assists") || m.endsWith("assists")) return "Assists";
  if (m.includes("player_threes") || m.includes("threes") || m.includes("3")) return "3PT";

  return marketRaw ? marketRaw.replaceAll("_", " ") : "Prop";
}

function propSideLabel(sideRaw: string | null) {
  const s = (sideRaw || "").toLowerCase();
  if (s === "over") return "Over";
  if (s === "under") return "Under";
  return sideRaw || "—";
}

function fmtPropLine(line: number | null) {
  if (line == null || !Number.isFinite(line)) return "—";
  const rounded = Math.round(line * 100) / 100;
  return `${rounded}`;
}

function normalizeSide(raw: string | null) {
  const s = (raw || "").trim().toLowerCase();
  if (s === "o" || s === "over") return "over";
  if (s === "u" || s === "under") return "under";
  return s || null;
}

/* =========================================================
   PlayKey builders (dedupe)
========================================================= */

function gamePlayKey(r: EvPlayRow) {
  const team = (r.team || "").trim().toLowerCase();
  const line = r.line == null ? "x" : String(r.line);
  return `g|${r.event_id}|${r.market}|${r.side}|${line}|${team}`;
}

function propPlayKey(r: PlayerPropEvLatestRow) {
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

  // Details modal state
  const [selected, setSelected] = useState<AggregatedPlay | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const openDetails = (p: AggregatedPlay) => {
    setSelected(p);
    setDetailsOpen(true);
  };

  const closeDetails = () => {
    setDetailsOpen(false);
  };

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

  // ESC close
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
          quantum_prob: Number.isFinite(safeNum(r.quantum_prob, NaN)) ? safeNum(r.quantum_prob, NaN) : null,

          offers: {},

          bestBook: null,
          bestEvPct: 0,
          bestBetFraction: 0,
          bestScore: 0,

          created_at: r.created_at ?? null,
        } as AggregatedPlay);

      base.offers[bk] = {
        book: bk,
        odds: safeNum(r.book_odds, NaN),
        ev_pct: safeNum(r.ev_pct, 0),
        bet_fraction: clamp(safeNum(r.bet_fraction, 0), 0, 1),
      };

      base.created_at =
        [base.created_at, r.created_at ?? null].filter(Boolean).sort().slice(-1)[0] ?? base.created_at;

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
        odds: safeNum(r.odds, NaN),
        ev_pct: safeNum(r.ev_pct, 0),
        // props sizing uses kelly_fraction
        bet_fraction: clamp(safeNum(r.kelly_fraction, 0), 0, 1),
      };

      base.created_at =
        [base.created_at, r.created_at ?? null].filter(Boolean).sort().slice(-1)[0] ?? base.created_at;

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

    if (kindFilter !== "all") {
      list = list.filter((p) => p.kind === kindFilter);
    }

    if (bookFilter !== "all") {
      list = list.filter((p) => !!p.offers[bookFilter]);
    }

    return list;
  }, [aggregated, kindFilter, bookFilter]);

  const updatedText = useMemo(() => {
    const latest = filtered
      .map((p) => p.created_at)
      .filter(Boolean)
      .sort()
      .slice(-1)[0];

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
            <Pill active={kindFilter === "all"} onClick={() => setKindFilter("all")} label="All" />
            <Pill active={kindFilter === "game"} onClick={() => setKindFilter("game")} label="Game Lines" />
            <Pill active={kindFilter === "prop"} onClick={() => setKindFilter("prop")} label="Player Props" />
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
            Set <span className="text-white">Bankroll</span> and <span className="text-white">Kelly Factor</span> in
            Settings to enable bet amounts.
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
                {play.propMeta?.position ? <span className="text-[#808080]"> · {play.propMeta.position}</span> : null}
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

      {/* sizing breakdown */}
      {settingsReady && betAmount > 0 ? (
        <div className="mt-2 text-[10px] text-[#606060] tabular-nums">
          {(play.bestBetFraction * 100).toFixed(2)}% × {Math.round(kellyFactor * 100)}% × {formatMoney(bankroll)}
        </div>
      ) : null}
    </div>
  );
}

/* =========================================================
   Details Modal
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
  const [tab, setTab] = useState<"offers" | "history" | "sizing" | "meta">("offers");

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
      <button type="button" onClick={onClose} className="absolute inset-0 bg-black/70" aria-label="Close modal" />

      {/* Panel */}
      <div className="absolute inset-x-0 bottom-0 md:inset-0 md:flex md:items-center md:justify-center p-0 md:p-6">
        <div className="relative w-full md:max-w-4xl bg-[#0b0b0b] border border-[#2a2a2a] md:rounded-xl rounded-t-xl overflow-hidden">
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
              <TabPill active={tab === "history"} onClick={() => setTab("history")} label="History" />
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
                    <div className="mt-1 text-white font-semibold tabular-nums text-lg">
                      {american(play.quantum_odds)}
                    </div>
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

                <div className="text-[10px] text-[#606060]">
                  Best book is highlighted. Use <span className="text-white">History</span> for prop odds movement.
                </div>
              </div>
            ) : null}

            {tab === "history" ? (
              <div className="space-y-3">
                {play.kind !== "prop" ? (
                  <div className="text-xs text-[#808080] bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
                    History is currently supported for <span className="text-white">player props</span> only.
                  </div>
                ) : (
                  <PropOddsHistoryPanel play={play} />
                )}
              </div>
            ) : null}

            {tab === "sizing" ? (
              <div className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
                    <div className="text-[10px] text-[#606060]">Inputs</div>
                    <div className="mt-2 space-y-1 text-[11px] text-[#d0d0d0]">
                      <RowKV k="Bankroll" v={bankroll ? formatMoney(bankroll) : "—"} />
                      <RowKV k="Kelly Factor" v={`${(kellyFactor * 100).toFixed(1)}%`} />
                      <RowKV k="Best Book Fraction" v={`${(play.bestBetFraction * 100).toFixed(2)}%`} />
                      <RowKV k="Best EV" v={pct(play.bestEvPct, 1)} highlight />
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
                    <MetaRow k="Updated" v={play.created_at ? fmtDateTimeCentralShort(play.created_at) : "—"} />
                    <MetaRow k="Score" v={`${Math.round(play.bestScore)}`} />
                  </div>
                </div>

                {play.kind === "prop" ? (
                  <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
                    <div className="text-[10px] text-[#606060] mb-2">Prop details</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
                      <MetaRow k="Team" v={play.propMeta?.team ?? "—"} />
                      <MetaRow k="Opponent" v={play.propMeta?.opponent ?? "—"} />
                      <MetaRow
                        k="Position"
                        v={play.propMeta?.position ? String(play.propMeta.position).toUpperCase() : "—"}
                      />
                      <MetaRow k="Market raw" v={play.propMeta?.market_raw ?? "—"} mono />
                      <MetaRow k="Side raw" v={play.propMeta?.side_raw ?? "—"} mono />
                      <MetaRow k="Line raw" v={play.propMeta?.line != null ? String(play.propMeta.line) : "—"} mono />
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
              Best book:{" "}
              <span className="text-[#d4af37]">{play.bestBook ? bookShort(play.bestBook) : "—"}</span>
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
   Prop Odds History Panel (pulls from player_props_history)
========================================================= */

type HistPoint = {
  ts: string;
  t: number;
  dk?: number | null;
  fd?: number | null;
  mgm?: number | null;
};

function collapsePropHistory(rows: PlayerPropsHistoryRow[]): HistPoint[] {
  const byTs = new Map<string, HistPoint>();

  for (const r of rows) {
    const ts = r.ts || r.inserted_at || null;
    if (!ts) continue;

    const key = ts;
    const existing = byTs.get(key) ?? { ts: key, t: new Date(key).getTime() };

    const b = (r.bookmaker || "").toLowerCase();
    const o = r.odds != null ? safeNum(r.odds, NaN) : NaN;
    if (!Number.isFinite(o)) {
      byTs.set(key, existing);
      continue;
    }

    if (b === "draftkings") existing.dk = o;
    if (b === "fanduel") existing.fd = o;
    if (b === "betmgm") existing.mgm = o;

    byTs.set(key, existing);
  }

  return Array.from(byTs.values())
    .sort((a, b) => a.t - b.t)
    .map((p) => ({ ...p }));
}

function PropOddsHistoryPanel({ play }: { play: AggregatedPlay }) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [points, setPoints] = useState<HistPoint[]>([]);
  const [rawCount, setRawCount] = useState(0);

  const lastKeyRef = useRef<string>("");

  useEffect(() => {
    let mounted = true;

    async function load() {
      if (play.kind !== "prop") return;

      const pm = play.propMeta ?? {};
      const playerName = (pm.player_name || play.pickLabel || "").trim();
      const market = (pm.market_raw || "").trim();
      const side = normalizeSide(pm.side_raw || play.sideLabel) || null;

      // prefer numeric line from propMeta
      const lineVal =
        pm.line != null && Number.isFinite(Number(pm.line))
          ? Number(pm.line)
          : (() => {
              const n = Number(play.lineLabel);
              return Number.isFinite(n) ? n : null;
            })();

      const key = `prop|${play.event_id}|${playerName}|${market}|${side}|${lineVal}`;
      if (lastKeyRef.current === key) return;
      lastKeyRef.current = key;

      setLoading(true);
      setErr(null);
      setPoints([]);
      setRawCount(0);

      // If we can't form a reliable query, show a clear message.
      if (!play.event_id || !playerName || !market || !side || lineVal == null) {
        setLoading(false);
        setErr("Missing keys for prop history lookup (event/player/market/side/line).");
        return;
      }

      const q = supabase
        .from("player_props_history")
        .select("ts,inserted_at,event_id,player_name,market,side,line,odds,bookmaker")
        .eq("event_id", play.event_id)
        .eq("player_name", playerName)
        .eq("market", market)
        .eq("side", side)
        .eq("line", lineVal)
        .in("bookmaker", ["draftkings", "fanduel", "betmgm"])
        .order("ts", { ascending: true })
        .limit(800);

      const res = await q;
      if (!mounted) return;

      if (res.error) {
        setErr(res.error.message);
        setLoading(false);
        return;
      }

      const rows = (res.data ?? []) as PlayerPropsHistoryRow[];
      setRawCount(rows.length);

      const pts = collapsePropHistory(rows);
      setPoints(pts);
      setLoading(false);
    }

    load();
    return () => {
      mounted = false;
    };
  }, [play]);

  const hasAny =
    points.some((p) => Number.isFinite(safeNum(p.dk, NaN))) ||
    points.some((p) => Number.isFinite(safeNum(p.fd, NaN))) ||
    points.some((p) => Number.isFinite(safeNum(p.mgm, NaN)));

  return (
    <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] text-[#606060]">Prop Odds History</div>
          <div className="text-[11px] text-[#b0b0b0] mt-1">
            {play.marketLabel} · {play.sideLabel} {play.lineLabel} ·{" "}
            <span className="text-[#808080]">{rawCount ? `${rawCount} rows` : "—"}</span>
          </div>
        </div>

        <div className="text-[10px] text-[#606060] text-right">
          <div>Books</div>
          <div className="text-[#808080]">DK · FD · MGM</div>
        </div>
      </div>

      <div className="mt-3 h-[220px] md:h-[260px]">
        {loading ? (
          <div className="h-full flex items-center justify-center text-xs text-[#808080]">
            Loading history…
          </div>
        ) : err ? (
          <div className="h-full flex items-center justify-center text-xs text-red-400 px-2 text-center">
            History error: {err}
          </div>
        ) : !hasAny ? (
          <div className="h-full flex items-center justify-center text-xs text-[#808080] px-2 text-center">
            No history rows found for this exact prop key.
            <div className="mt-2 text-[10px] text-[#606060]">
              Lookup key uses: event_id + player_name + market + side + line (from player_prop_ev_latest)
            </div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 10, right: 18, bottom: 10, left: 6 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
              <XAxis
                dataKey="ts"
                tickFormatter={(v) => fmtDateTimeCentralShort(String(v))}
                minTickGap={24}
                tick={{ fontSize: 10, fill: "#9a9a9a" }}
                axisLine={{ stroke: "#2a2a2a" }}
                tickLine={{ stroke: "#2a2a2a" }}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#9a9a9a" }}
                axisLine={{ stroke: "#2a2a2a" }}
                tickLine={{ stroke: "#2a2a2a" }}
                tickFormatter={(v) => american(Number(v))}
                width={44}
              />
              <Tooltip
                content={<OddsTooltip />}
                cursor={{ stroke: "#d4af37", opacity: 0.25, strokeWidth: 1 }}
              />
              <Line
                type="monotone"
                dataKey="dk"
                name="DraftKings"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="fd"
                name="FanDuel"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="mgm"
                name="BetMGM"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-2 text-[10px] text-[#606060]">
        Tip: hover a point to see odds at that timestamp.
      </div>
    </div>
  );
}

function OddsTooltip({ active, payload, label }: any) {
  if (!active || !payload || !payload.length) return null;

  const getVal = (key: string) => {
    const p = payload.find((x: any) => x.dataKey === key);
    const v = p?.value;
    return v == null || !Number.isFinite(Number(v)) ? "—" : american(Number(v));
  };

  return (
    <div className="bg-[#0b0b0b] border border-[#2a2a2a] rounded px-3 py-2 text-[11px]">
      <div className="text-[#d0d0d0]">{fmtDateTimeCentralShort(String(label))}</div>
      <div className="mt-1 grid grid-cols-3 gap-3">
        <div className="text-[#808080]">
          DK <span className="text-white tabular-nums ml-1">{getVal("dk")}</span>
        </div>
        <div className="text-[#808080]">
          FD <span className="text-white tabular-nums ml-1">{getVal("fd")}</span>
        </div>
        <div className="text-[#808080]">
          MGM <span className="text-white tabular-nums ml-1">{getVal("mgm")}</span>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   Small UI helpers
========================================================= */

function Pill({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
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
  if (!ready || !Number.isFinite(amount) || amount <= 0) return <div className="text-[#404040]">—</div>;

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

function RowKV({ k, v, highlight }: { k: string; v: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[#808080]">{k}</span>
      <span className={["tabular-nums", highlight ? "text-[#d4af37]" : "text-white"].join(" ")}>{v}</span>
    </div>
  );
}

