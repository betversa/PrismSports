// screens/Model/ModelScreen.tsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

/**
 * MODEL PICKS (EV PLAYS) — FULL REWRITE
 *
 * ✅ Game EV plays from public.ev_plays
 * ✅ Player prop +EV plays from public.player_prop_ev_latest
 * ✅ Filter: sportsbook (SOFT books only) — default = All
 * ✅ Optional filter: All / Game Lines / Player Props
 * ✅ Book column uses square logos in /public/books/
 *    - dksquare.png, fdsquare.png, mgmsquare.png
 * ✅ Bet Amount uses Settings:
 *    - app_settings.bankroll (dollars)
 *    - app_settings.kelly_factor (multiplier, 0..1)
 *   Bet Amount = bankroll * bet_fraction * kelly_factor
 *
 * RESPONSIVE UI:
 * - Mobile (<md): Card layout
 * - Desktop (md+): Table layout
 */

type GameMarketKey = "h2h" | "spreads" | "totals";
type GameSideKey = "home" | "away" | "over" | "under";

// Common
type SoftBookKey = "all" | "draftkings" | "fanduel" | "betmgm";
type PlayKind = "all" | "game" | "prop";

type AppSettingsRow = {
  id: number;
  bankroll: number | null;
  kelly_factor: number | null;
  max_units_per_play?: number | null;
};

const SOFT_BOOKS: { key: SoftBookKey; label: string }[] = [
  { key: "all", label: "All Books" },
  { key: "draftkings", label: "DraftKings" },
  { key: "fanduel", label: "FanDuel" },
  { key: "betmgm", label: "BetMGM" },
];

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

function bookFallbackLabel(bookmaker: string) {
  const b = (bookmaker || "").toLowerCase();
  if (b === "draftkings") return "DK";
  if (b === "fanduel") return "FD";
  if (b === "betmgm") return "MGM";
  return (bookmaker || "BOOK").toUpperCase();
}

/* =========================================================
   GAME EV PLAYS (public.ev_plays)
========================================================= */

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

  created_at?: string;
};

function marketLabelGame(market: GameMarketKey) {
  if (market === "h2h") return "Moneyline";
  if (market === "spreads") return "Spread";
  return "Total";
}

function sideLabelForDisplayGame(market: GameMarketKey, side: GameSideKey) {
  if (market === "totals") return side === "over" ? "Over" : "Under";
  return side === "home" ? "Home" : "Away";
}

function fmtLineGame(market: GameMarketKey, line: number | null) {
  if (market === "h2h") return "—";
  if (line == null || !Number.isFinite(line)) return "—";
  if (market === "spreads") return `${line > 0 ? "+" : ""}${line}`;
  return `${line}`;
}

/* =========================================================
   PROP EV PLAYS (public.player_prop_ev_latest)
   CSV columns (high level):
   - event_id, commence_time, player_name, position, picture_url
   - market, side, line
   - book, odds
   - p_quantum, quantum_fair_odds
   - ev_pct, kelly_fraction, score
   - team, opponent
========================================================= */

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

  market: string | null; // e.g. player_points, player_rebounds...
  side: string | null; // over/under (or home/away in weird cases)
  line: number | null;

  book: string; // draftkings/fanduel/betmgm
  odds: number; // book odds (american)

  p_quantum: number | null;
  quantum_fair_odds: number; // fair odds (american)

  ev_pct: number;
  kelly_fraction: number;
  score: number;
};

function propMarketLabel(marketRaw: string | null) {
  const m = (marketRaw || "").toLowerCase();

  if (m.includes("points_rebounds_assists") || m.includes("pra")) return "PRA";
  if (m.includes("points_assists") || m.includes("pa")) return "PTS+AST";
  if (m.includes("points_rebounds") || m.includes("pr")) return "PTS+REB";
  if (m.includes("rebounds_assists") || m.includes("ra")) return "REB+AST";

  if (m.includes("player_points") || m.endsWith("points")) return "Points";
  if (m.includes("player_rebounds") || m.endsWith("rebounds")) return "Rebounds";
  if (m.includes("player_assists") || m.endsWith("assists")) return "Assists";
  if (m.includes("player_threes") || m.includes("3") || m.includes("threes")) return "3PT";

  return marketRaw ? marketRaw.replaceAll("_", " ") : "Prop";
}

function propSideLabel(sideRaw: string | null) {
  const s = (sideRaw || "").toLowerCase();
  if (s === "over") return "Over";
  if (s === "under") return "Under";
  if (s === "home") return "Home";
  if (s === "away") return "Away";
  return sideRaw || "—";
}

function fmtPropLine(line: number | null) {
  if (line == null || !Number.isFinite(line)) return "—";
  // props should not show + sign typically
  const rounded = Math.round(line * 100) / 100;
  return `${rounded}`;
}

/* =========================================================
   Unified row for UI
========================================================= */

type UnifiedRow = {
  kind: "game" | "prop";

  // common
  event_id: string;
  commence_time: string | null;
  matchup: string | null;

  bookmaker: string; // normalized string (draftkings/fanduel/betmgm)
  book_odds: number;

  quantum_odds: number; // fair odds
  ev_pct: number;

  // bet sizing
  bet_fraction: number; // always present in unified
  score: number; // confidence / score

  // game-specific
  game?: {
    market: GameMarketKey;
    side: GameSideKey;
    line: number | null;
    team: string | null;
    confidence_tier?: string;
  };

  // prop-specific
  prop?: {
    market: string | null;
    side: string | null;
    line: number | null;
    player_name: string | null;
    position: string | null;
    picture_url: string | null;
    team: string | null;
    opponent: string | null;
  };

  created_at?: string | null;
};

function toUnifiedFromGame(r: EvPlayRow): UnifiedRow {
  return {
    kind: "game",
    event_id: r.event_id,
    commence_time: r.commence_time ?? null,
    matchup: r.matchup ?? null,
    bookmaker: r.bookmaker,
    book_odds: safeNum(r.book_odds, NaN),
    quantum_odds: safeNum(r.quantum_odds, NaN),
    ev_pct: safeNum(r.ev_pct, 0),
    bet_fraction: clamp(safeNum(r.bet_fraction, 0), 0, 1),
    score: safeNum(r.confidence_score, 0),
    game: {
      market: r.market,
      side: r.side,
      line: r.line ?? null,
      team: r.team ?? null,
      confidence_tier: r.confidence_tier,
    },
    created_at: r.created_at ?? null,
  };
}

function toUnifiedFromProp(r: PlayerPropEvLatestRow): UnifiedRow {
  return {
    kind: "prop",
    event_id: r.event_id,
    commence_time: r.commence_time ?? null,
    matchup: formatPropMatchup(r.team, r.opponent),
    bookmaker: r.book,
    book_odds: safeNum(r.odds, NaN),
    quantum_odds: safeNum(r.quantum_fair_odds, NaN),
    ev_pct: safeNum(r.ev_pct, 0),
    // Use kelly_fraction as bet_fraction (unless you later add bet_fraction to table)
    bet_fraction: clamp(safeNum(r.kelly_fraction, 0), 0, 1),
    // score in this table can be wide; keep display sensible
    score: clamp(safeNum(r.score, 0), 0, 100),
    prop: {
      market: r.market ?? null,
      side: r.side ?? null,
      line: r.line ?? null,
      player_name: r.player_name ?? null,
      position: r.position ?? null,
      picture_url: r.picture_url ?? null,
      team: r.team ?? null,
      opponent: r.opponent ?? null,
    },
    created_at: r.created_at ?? null,
  };
}

function formatPropMatchup(team: string | null, opponent: string | null) {
  const a = (team || "").trim();
  const b = (opponent || "").trim();
  if (a && b) return `${a} vs ${b}`;
  if (a) return a;
  if (b) return b;
  return "—";
}

function sortUnified(a: UnifiedRow, b: UnifiedRow) {
  // 1) soonest commence_time first (nulls last)
  const ta = a.commence_time ? new Date(a.commence_time).getTime() : Number.POSITIVE_INFINITY;
  const tb = b.commence_time ? new Date(b.commence_time).getTime() : Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta - tb;

  // 2) higher EV first
  const eva = safeNum(a.ev_pct, 0);
  const evb = safeNum(b.ev_pct, 0);
  if (evb !== eva) return evb - eva;

  // 3) props after games? (optional) keep stable
  if (a.kind !== b.kind) return a.kind === "game" ? -1 : 1;

  return 0;
}

export function ModelScreen() {
  const [bookFilter, setBookFilter] = useState<SoftBookKey>("all");
  const [kindFilter, setKindFilter] = useState<PlayKind>("all");

  const [loading, setLoading] = useState(true);

  const [gameRows, setGameRows] = useState<EvPlayRow[]>([]);
  const [propRows, setPropRows] = useState<PlayerPropEvLatestRow[]>([]);

  const [settings, setSettings] = useState<AppSettingsRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load plays + settings
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

      const [evRes, propsRes, sRes] = await Promise.all([evQ, propsQ, settingsQ]);
      if (!mounted) return;

      if (evRes.error) {
        setError(evRes.error.message);
        setGameRows([]);
      } else {
        setGameRows((evRes.data ?? []) as EvPlayRow[]);
      }

      if (propsRes.error) {
        // don't hard-fail the whole screen if props query fails
        console.warn("[ModelScreen] player_prop_ev_latest error:", propsRes.error.message);
        setPropRows([]);
      } else {
        setPropRows((propsRes.data ?? []) as PlayerPropEvLatestRow[]);
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
  }, [bookFilter, kindFilter]); // re-run when filters change (simple + consistent)

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

  const unifiedRows = useMemo(() => {
    const softBooks = ["draftkings", "fanduel", "betmgm"];

    const gamesU = gameRows
      .filter((r) => softBooks.includes((r.bookmaker || "").toLowerCase()))
      .map(toUnifiedFromGame);

    const propsU = propRows
      .filter((r) => softBooks.includes((r.book || "").toLowerCase()))
      .map(toUnifiedFromProp);

    let all = [...gamesU, ...propsU];

    // book filter
    if (bookFilter !== "all") {
      all = all.filter((r) => normalizeBookKey(r.bookmaker) === bookFilter);
    }

    // kind filter
    if (kindFilter !== "all") {
      all = all.filter((r) => r.kind === kindFilter);
    }

    return all.sort(sortUnified);
  }, [gameRows, propRows, bookFilter, kindFilter]);

  const updatedText = useMemo(() => {
    const latest = unifiedRows
      .map((r) => r.created_at ?? null)
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
  }, [unifiedRows]);

  const bankroll = safeNum(settings?.bankroll, 0);
  const kellyFactor = clamp(safeNum(settings?.kelly_factor, 0), 0, 1);
  const settingsReady = !!(bankroll && kellyFactor);

  const totalBetDollars = useMemo(() => {
    if (!settingsReady) return 0;
    return unifiedRows.reduce((sum, r) => sum + calcBetAmount(bankroll, r.bet_fraction, kellyFactor), 0);
  }, [unifiedRows, bankroll, kellyFactor, settingsReady]);

  const counts = useMemo(() => {
    const game = unifiedRows.filter((r) => r.kind === "game").length;
    const prop = unifiedRows.filter((r) => r.kind === "prop").length;
    return { total: unifiedRows.length, game, prop };
  }, [unifiedRows]);

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
            Bankroll:{" "}
            <span className="text-[#d4af37]">{bankroll ? formatMoney(bankroll) : "—"}</span>
          </div>

          <div className="px-2 py-1 bg-[#1a1a1a] rounded text-[#808080]">
            Kelly:{" "}
            <span className="text-[#d4af37]">
              {settings?.kelly_factor != null ? `${(kellyFactor * 100).toFixed(1)}%` : "—"}
            </span>
          </div>

          <div className="px-2 py-1 bg-[#1a1a1a] rounded text-[#808080]">
            Total Bet:{" "}
            <span className="text-[#d4af37]">{totalBetDollars ? formatMoney(totalBetDollars) : "—"}</span>
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
        {!loading && !unifiedRows.length ? (
          <div className="text-xs text-[#808080] px-3 py-8 bg-[#0f0f0f] border border-[#2a2a2a] rounded text-center">
            No positive EV plays found for this filter.
          </div>
        ) : null}

        {unifiedRows.map((r) => (
          <UnifiedPlayCard
            key={unifiedKey(r)}
            row={r}
            bankroll={bankroll}
            kellyFactor={kellyFactor}
            settingsReady={settingsReady}
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

                <th className="text-center p-3 text-[#808080] min-w-[120px]">Book</th>

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
              {unifiedRows.map((r) => (
                <UnifiedPlayRow
                  key={unifiedKey(r)}
                  row={r}
                  bankroll={bankroll}
                  kellyFactor={kellyFactor}
                  settingsReady={settingsReady}
                />
              ))}

              {!loading && !unifiedRows.length && (
                <tr>
                  <td colSpan={9} className="p-6 text-center text-xs text-[#808080]">
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
          <span>Positive EV (game lines + player props)</span>
        </div>

        <div>
          <span className="text-[#808080]">Bet $:</span> bankroll × bet_fraction × kelly_factor
        </div>

        {!settingsReady ? (
          <div className="text-[#808080]">
            Set <span className="text-white">Bankroll</span> and <span className="text-white">Kelly Factor</span> in
            Settings to enable bet amounts.
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ===========================
   Helpers
=========================== */

function unifiedKey(r: UnifiedRow) {
  if (r.kind === "game") {
    const g = r.game!;
    return `g|${r.event_id}|${g.market}|${g.side}|${r.bookmaker}|${g.line ?? "x"}`;
  }
  const p = r.prop!;
  return `p|${r.event_id}|${p.market ?? "m"}|${p.side ?? "s"}|${r.bookmaker}|${p.line ?? "x"}|${p.player_name ?? "player"}`;
}

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

/* ===========================
   Desktop row (unified)
=========================== */

function UnifiedPlayRow({
  row,
  bankroll,
  kellyFactor,
  settingsReady,
}: {
  row: UnifiedRow;
  bankroll: number;
  kellyFactor: number;
  settingsReady: boolean;
}) {
  const logoSrc = bookLogoSrc(row.bookmaker);

  const frac = Math.max(0, safeNum(row.bet_fraction, 0));
  const betAmount = settingsReady ? calcBetAmount(bankroll, frac, kellyFactor) : NaN;

  const marketTxt = row.kind === "game" ? marketLabelGame(row.game!.market) : propMarketLabel(row.prop!.market);
  const sideTxt =
    row.kind === "game"
      ? sideLabelForDisplayGame(row.game!.market, row.game!.side)
      : propSideLabel(row.prop!.side);

  const lineTxt =
    row.kind === "game" ? fmtLineGame(row.game!.market, row.game!.line) : fmtPropLine(row.prop!.line);

  const pickNode =
    row.kind === "game" ? (
      <div className="text-white">
        {row.game!.market === "totals" ? row.matchup ?? row.game!.team ?? "Total" : row.game!.team ?? "—"}
      </div>
    ) : (
      <PropPickInline prop={row.prop!} />
    );

  return (
    <tr className="hover:bg-[#0f0f0f]/50 transition-colors">
      <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10 min-w-[340px]">
        <div className="text-white">
          {row.matchup ?? "—"}
          <span className="text-[#606060]"> · </span>
          <span className="text-[#b0b0b0]">{fmtDateCentral(row.commence_time)}</span>
          <span className="text-[#606060]"> </span>
          <span className="text-[#b0b0b0]">{fmtTimeCentral(row.commence_time)}</span>
          {row.kind === "prop" ? (
            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-[#d4af37]/15 border border-[#d4af37]/25 text-[10px] text-[#d4af37]">
              PROP
            </span>
          ) : null}
        </div>
        <div className="text-[10px] text-[#606060] mt-0.5">
          Event: <span className="text-[#404040]">{row.event_id}</span>
        </div>
      </td>

      <td className="p-3 text-left">
        <div className="text-white">{marketTxt}</div>
        <div className="text-[10px] text-[#606060] mt-0.5">{sideTxt}</div>
      </td>

      <td className="p-3 text-left">{pickNode}</td>

      <td className="p-3 text-center">
        <div className="text-white">{lineTxt}</div>
      </td>

      <td className="p-3 text-center">
        <div className="text-white font-semibold tabular-nums">{american(row.quantum_odds)}</div>
      </td>

      <td className="p-3 text-center">
        <div className="inline-flex items-center justify-center gap-2">
          {logoSrc ? (
            <img
              src={logoSrc}
              alt={bookFallbackLabel(row.bookmaker)}
              className="h-5 w-5 md:h-6 md:w-6 opacity-95 shrink-0"
              draggable={false}
            />
          ) : (
            <div className="h-5 w-5 md:h-6 md:w-6 rounded bg-[#1a1a1a] border border-[#2a2a2a] flex items-center justify-center text-[10px] text-[#808080] shrink-0">
              {bookFallbackLabel(row.bookmaker)}
            </div>
          )}
          <div className="text-white font-semibold tabular-nums">{american(row.book_odds)}</div>
        </div>
      </td>

      <td className="p-3 text-center">
        <div className="text-[#d4af37] tabular-nums">
          {row.ev_pct > 0 ? "+" : ""}
          {Number(row.ev_pct).toFixed(1)}%
        </div>
      </td>

      <td className="p-3 text-center">
        <ScoreValue value={row.score} tier={row.kind === "game" ? row.game?.confidence_tier : undefined} />
      </td>

      <td className="p-3 text-center">
        <BetAmountValue
          amount={betAmount}
          frac={frac}
          bankroll={bankroll}
          kellyFactor={kellyFactor}
          ready={settingsReady}
        />
      </td>
    </tr>
  );
}

/* ===========================
   Mobile card (unified)
=========================== */

function UnifiedPlayCard({
  row,
  bankroll,
  kellyFactor,
  settingsReady,
}: {
  row: UnifiedRow;
  bankroll: number;
  kellyFactor: number;
  settingsReady: boolean;
}) {
  const frac = Math.max(0, safeNum(row.bet_fraction, 0));
  const betAmount = settingsReady ? calcBetAmount(bankroll, frac, kellyFactor) : 0;

  const marketTxt = row.kind === "game" ? marketLabelGame(row.game!.market) : propMarketLabel(row.prop!.market);
  const sideTxt =
    row.kind === "game"
      ? sideLabelForDisplayGame(row.game!.market, row.game!.side)
      : propSideLabel(row.prop!.side);

  const lineTxt =
    row.kind === "game" ? fmtLineGame(row.game!.market, row.game!.line) : fmtPropLine(row.prop!.line);

  const logoSrc = bookLogoSrc(row.bookmaker);

  const pickLine =
    row.kind === "game"
      ? row.game!.market === "totals"
        ? row.matchup ?? row.game!.team ?? "Total"
        : row.game!.team ?? "—"
      : row.prop!.player_name ?? "—";

  return (
    <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4">
      {/* Top line: matchup + time */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-white text-sm truncate">
            {row.matchup ?? "—"}
            {row.kind === "prop" ? (
              <span className="ml-2 align-middle inline-flex items-center px-1.5 py-0.5 rounded bg-[#d4af37]/15 border border-[#d4af37]/25 text-[10px] text-[#d4af37]">
                PROP
              </span>
            ) : null}
          </div>
          <div className="text-[11px] text-[#808080] mt-1">
            {fmtDateCentral(row.commence_time)} · {fmtTimeCentral(row.commence_time)}
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
        {row.kind === "prop" ? (
          <div className="flex items-center gap-3">
            <PropAvatar url={row.prop!.picture_url} name={row.prop!.player_name ?? ""} />
            <div className="min-w-0">
              <div className="text-white text-sm truncate">
                {row.prop!.player_name ?? "—"}
                {row.prop!.position ? <span className="text-[#808080]"> · {row.prop!.position}</span> : null}
              </div>
              <div className="text-[11px] text-[#808080] mt-0.5 truncate">
                {propMarketLabel(row.prop!.market)} · {sideTxt} {lineTxt}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-white text-sm">
            {pickLine}{" "}
            <span className="text-[#808080] text-xs">
              · {marketTxt} · {sideTxt}
              {row.game?.market !== "h2h" ? ` ${lineTxt}` : ""}
            </span>
          </div>
        )}
      </div>

      {/* Bottom: odds row */}
      <div className="mt-3 grid grid-cols-3 gap-3 items-center">
        <div className="text-left">
          <div className="text-[10px] text-[#606060]">Quantum</div>
          <div className="text-white font-semibold tabular-nums">{american(row.quantum_odds)}</div>
        </div>

        <div className="text-center">
          <div className="text-[10px] text-[#606060]">Book</div>
          <div className="inline-flex items-center justify-center gap-2">
            {logoSrc ? (
              <img
                src={logoSrc}
                alt={bookFallbackLabel(row.bookmaker)}
                className="h-5 w-5 opacity-95 shrink-0"
                draggable={false}
              />
            ) : (
              <div className="h-5 w-5 rounded bg-[#1a1a1a] border border-[#2a2a2a] flex items-center justify-center text-[10px] text-[#808080] shrink-0">
                {bookFallbackLabel(row.bookmaker)}
              </div>
            )}
            <div className="text-white font-semibold tabular-nums">{american(row.book_odds)}</div>
          </div>
        </div>

        <div className="text-right">
          <div className="text-[10px] text-[#606060]">EV</div>
          <div className="text-[#d4af37] font-semibold tabular-nums">
            {row.ev_pct > 0 ? "+" : ""}
            {Number(row.ev_pct).toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Score */}
      <div className="mt-3 flex items-center justify-between">
        <div className="text-[10px] text-[#606060]">Score</div>
        <div className="text-sm">
          <ScoreValue value={row.score} tier={row.kind === "game" ? row.game?.confidence_tier : undefined} />
        </div>
      </div>

      {/* breakdown (tiny) */}
      {settingsReady && betAmount > 0 ? (
        <div className="mt-2 text-[10px] text-[#606060] tabular-nums">
          {(frac * 100).toFixed(2)}% × {Math.round(kellyFactor * 100)}% × {formatMoney(bankroll)}
        </div>
      ) : null}
    </div>
  );
}

/* ===========================
   Prop pick UI bits
=========================== */

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
          // fallback to initials circle
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

function PropPickInline({ prop }: { prop: NonNullable<UnifiedRow["prop"]> }) {
  const name = prop.player_name ?? "—";
  const pos = prop.position ? prop.position.toUpperCase() : null;

  const meta = [
    propMarketLabel(prop.market),
    propSideLabel(prop.side),
    prop.line != null ? fmtPropLine(prop.line) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex items-center gap-2 min-w-0">
      <PropAvatar url={prop.picture_url} name={name} />
      <div className="min-w-0">
        <div className="text-white truncate">
          {name}
          {pos ? <span className="text-[#808080]"> · {pos}</span> : null}
        </div>
        <div className="text-[10px] text-[#606060] mt-0.5 truncate">{meta}</div>
      </div>
    </div>
  );
}

/* ===========================
   Shared atoms
=========================== */

function ScoreValue({ value, tier }: { value: number; tier?: string }) {
  const v = Number(value ?? 0);
  let color = "text-[#606060]";
  if (v >= 85) color = "text-[#d4af37]";
  else if (v >= 70) color = "text-white";

  return (
    <div className={color}>
      {Math.round(v)}
      {tier ? <span className="text-[10px] text-[#606060]"> {tier}</span> : null}
    </div>
  );
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

