// screens/Model/ModelScreen.tsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

/**
 * MODEL SCREEN (EV PLAYS) — FULL REWRITE
 *
 * Reads from: public.ev_plays
 * Layout: same “two rows per game” style as OddsScreen / MonteCarlo tables
 * - Groups EV plays by event_id
 * - Renders 2 rows: away then home (like OddsScreen)
 * - Shows best play (by EV%) for each market bucket:
 *   • Moneyline: market=h2h (away/home)
 *   • Spread:    market=spreads (away/home) with line
 *   • Total:     market=totals (over/under) with line
 *
 * “Prism” column in UI = Quantum No-Vig odds (quantum_odds)
 * “Book” column in UI  = soft book odds (book_odds) + book name
 * EV% = ev_pct
 * Score = confidence_score
 * Units = bet_fraction * 100 as “% bankroll” OR convert to units if you want (see comment)
 */

type MarketKey = "h2h" | "spreads" | "totals";
type SideKey = "home" | "away" | "over" | "under";

type EvPlayRow = {
  id?: string;
  run_id: string;
  event_id: string;
  commence_time: string | null;
  matchup: string | null;

  team: string | null;

  market: MarketKey;
  side: SideKey;
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

type EventGroup = {
  event_id: string;
  commence_time: string | null;
  matchup: string | null;
  awayTeam: string;
  homeTeam: string;
  awayRowPlays: MarketBucketPlays;
  homeRowPlays: MarketBucketPlays;
};

type CellPlay = {
  market: MarketKey;
  side: SideKey;
  line: number | null;
  bookmaker: string;
  book_odds: number;
  quantum_odds: number;
  ev_pct: number;
  confidence_score: number;
  confidence_tier: string;
  bet_fraction: number;
};

type MarketBucketPlays = {
  ml?: CellPlay | null;     // h2h
  spread?: CellPlay | null;  // spreads
  total?: CellPlay | null;   // totals
};

type SportKey = "basketball_ncaab" | "basketball_nba" | "football_nfl" | "football_ncaaf" | "hockey_nhl" | "baseball_mlb";

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

function fmtLine(market: MarketKey, side: SideKey, line: number | null) {
  if (market === "h2h") return "";
  if (line == null || !Number.isFinite(line)) return "";
  const sign = line > 0 ? "+" : "";
  if (market === "spreads") return `${sign}${line}`;
  // totals: just show the number (Over/Under label is in header)
  return `${line}`;
}

function bookLabel(bookmaker: string) {
  const b = (bookmaker || "").toLowerCase();
  if (b === "draftkings") return "DK";
  if (b === "fanduel") return "FD";
  if (b === "betmgm") return "MGM";
  if (b === "betonline" || b === "betonlineag") return "BOL";
  if (b === "pinnacle") return "PIN";
  return bookmaker?.toUpperCase?.() ?? "BOOK";
}

function bookColorClass(bookmaker: string) {
  const b = (bookmaker || "").toLowerCase();
  // Match your brand rules: DK green, FD blue, MGM gold (you previously used these)
  if (b === "draftkings") return "text-green-400";
  if (b === "fanduel") return "text-blue-400";
  if (b === "betmgm") return "text-[#d4af37]";
  return "text-[#b0b0b0]";
}

function clamp0(x: number) {
  return Math.max(0, x);
}

function sumBetFraction(rows: EvPlayRow[]) {
  return rows.reduce((a, r) => a + clamp0(Number(r.bet_fraction ?? 0)), 0);
}

/**
 * Choose the best play for a bucket:
 * - primary: highest EV%
 * - tie: higher confidence_score
 */
function pickBest(rows: EvPlayRow[]): EvPlayRow | null {
  if (!rows.length) return null;
  return rows
    .slice()
    .sort((a, b) => {
      const ev = (b.ev_pct ?? 0) - (a.ev_pct ?? 0);
      if (Math.abs(ev) > 1e-9) return ev;
      return (b.confidence_score ?? 0) - (a.confidence_score ?? 0);
    })[0];
}

/**
 * Derive “away/home team names” from:
 * - matchup: "Away @ Home" preferred
 * - fallback: ev_plays.team (for h2h it should be team name)
 */
function parseMatchup(matchup: string | null): { away: string; home: string } {
  const m = (matchup || "").trim();
  // Most common: "AWAY @ HOME"
  if (m.includes("@")) {
    const [a, h] = m.split("@").map((s) => s.trim());
    if (a && h) return { away: a, home: h };
  }
  // Also allow "AWAY vs HOME"
  if (m.toLowerCase().includes("vs")) {
    const parts = m.split(/vs\.?/i).map((s) => s.trim());
    if (parts.length === 2 && parts[0] && parts[1]) return { away: parts[0], home: parts[1] };
  }
  return { away: "Away", home: "Home" };
}

export function ModelScreen() {
  const [sportKey, setSportKey] = useState<SportKey>("basketball_ncaab");
  const [loading, setLoading] = useState<boolean>(true);
  const [rows, setRows] = useState<EvPlayRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  // ✅ Load EV plays (latest snapshot; table is cleared each run in your pipeline)
  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError(null);

      // We don’t have sport_key in ev_plays in your script.
      // So we filter by joining to events? (cheap: pull event_ids from events by sport_key + future cutoff)
      // If you add sport_key to ev_plays later, you can filter directly.
      const now = new Date().toISOString();

      const { data: ev, error: evErr } = await supabase
        .from("ev_plays")
        .select(
          "run_id,event_id,commence_time,matchup,team,market,side,line,bookmaker,book_odds,quantum_prob,quantum_odds,ev_pct,confidence_score,confidence_tier,kelly_fraction,bet_fraction,created_at"
        )
        .gte("commence_time", now) // future games
        .order("commence_time", { ascending: true });

      if (!mounted) return;

      if (evErr) {
        setError(evErr.message);
        setRows([]);
        setLoading(false);
        return;
      }

      // Filter to sport by looking up event_ids from events (only if you want sport dropdown behavior)
      const eventIds = Array.from(new Set((ev ?? []).map((r) => r.event_id).filter(Boolean)));

      if (!eventIds.length) {
        setRows([]);
        setLoading(false);
        return;
      }

      const { data: events, error: eventsErr } = await supabase
        .from("events")
        .select("event_id,sport_key")
        .in("event_id", eventIds);

      if (!mounted) return;

      if (eventsErr) {
        // still show without sport filtering
        setRows((ev ?? []) as EvPlayRow[]);
        setLoading(false);
        return;
      }

      const sportMap = new Map<string, string>();
      for (const e of events ?? []) sportMap.set(e.event_id, e.sport_key);

      const filtered = (ev ?? []).filter((r) => sportMap.get(r.event_id) === sportKey) as EvPlayRow[];

      setRows(filtered);
      setLoading(false);
    }

    load();

    return () => {
      mounted = false;
    };
  }, [sportKey]);

  const grouped = useMemo(() => buildEventGroups(rows), [rows]);

  const updatedText = useMemo(() => {
    // If you want "Updated X" use max(created_at)
    const latest = rows
      .map((r) => r.created_at)
      .filter(Boolean)
      .sort()
      .slice(-1)[0];

    if (!latest) return "Updated —";
    const d = new Date(latest);
    const t = d.toLocaleTimeString("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "2-digit",
    });
    return `Updated ${t} CT`;
  }, [rows]);

  const totalBankrollPct = useMemo(() => {
    // bet_fraction is fraction of bankroll. Display as % bankroll.
    return sumBetFraction(rows) * 100;
  }, [rows]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl text-white mb-1">Model Picks</h2>
          <p className="text-xs text-[#808080]">
            {grouped.length} games · {updatedText}
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <select
            value={sportKey}
            onChange={(e) => setSportKey(e.target.value as SportKey)}
            className="px-2 py-1 bg-[#111] border border-[#2a2a2a] rounded text-[#d0d0d0] outline-none"
          >
            <option value="basketball_ncaab">NCAAB</option>
            <option value="basketball_nba">NBA</option>
            <option value="football_nfl">NFL</option>
            <option value="football_ncaaf">NCAAF</option>
            <option value="hockey_nhl">NHL</option>
            <option value="baseball_mlb">MLB</option>
          </select>

          <div className="px-2 py-1 bg-[#1a1a1a] rounded text-[#808080]">
            Total %: <span className="text-[#d4af37]">{totalBankrollPct.toFixed(2)}%</span>
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

      {/* Main Table */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-10 min-w-[240px]">
                  Matchup
                </th>

                <th colSpan={5} className="text-center p-3 text-[#d4af37] border-l border-[#2a2a2a]">
                  MONEYLINE
                </th>
                <th colSpan={5} className="text-center p-3 text-[#d4af37] border-l border-[#2a2a2a]">
                  SPREAD
                </th>
                <th colSpan={5} className="text-center p-3 text-[#d4af37] border-l border-[#2a2a2a]">
                  TOTAL
                </th>
              </tr>

              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a] text-[10px]">
                <th className="sticky left-0 bg-[#0a0a0a] z-10" />

                {/* ML */}
                <th className="text-center p-2 text-[#606060] border-l border-[#2a2a2a]">Quantum</th>
                <th className="text-center p-2 text-[#606060]">Book</th>
                <th className="text-center p-2 text-[#606060]">EV%</th>
                <th className="text-center p-2 text-[#606060]">Score</th>
                <th className="text-center p-2 text-[#606060]">%</th>

                {/* Spread */}
                <th className="text-center p-2 text-[#606060] border-l border-[#2a2a2a]">Quantum</th>
                <th className="text-center p-2 text-[#606060]">Book</th>
                <th className="text-center p-2 text-[#606060]">EV%</th>
                <th className="text-center p-2 text-[#606060]">Score</th>
                <th className="text-center p-2 text-[#606060]">%</th>

                {/* Total */}
                <th className="text-center p-2 text-[#606060] border-l border-[#2a2a2a]">Quantum</th>
                <th className="text-center p-2 text-[#606060]">Book</th>
                <th className="text-center p-2 text-[#606060]">EV%</th>
                <th className="text-center p-2 text-[#606060]">Score</th>
                <th className="text-center p-2 text-[#606060]">%</th>
              </tr>

              {/* Label row for Away/Home/Over/Under */}
              <tr className="bg-[#070707] border-b border-[#2a2a2a] text-[10px]">
                <th className="sticky left-0 bg-[#070707] z-10 p-2 text-[#606060]">
                  {/* blank */}
                </th>

                {/* ML labels */}
                <th colSpan={5} className="text-center p-2 border-l border-[#2a2a2a] text-[#606060]">
                  Away / Home
                </th>
                <th colSpan={5} className="text-center p-2 border-l border-[#2a2a2a] text-[#606060]">
                  Away / Home
                </th>
                <th colSpan={5} className="text-center p-2 border-l border-[#2a2a2a] text-[#606060]">
                  Over / Under
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#1a1a1a]">
              {grouped.map((g) => (
                <EventTwoRow key={g.event_id} group={g} />
              ))}

              {!loading && !grouped.length && (
                <tr>
                  <td colSpan={16} className="p-6 text-center text-xs text-[#808080]">
                    No positive EV plays found for this sport.
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
          <span>Positive EV (ev_plays)</span>
        </div>
        <div>
          <span className="text-[#808080]">Score:</span> confidence_score (0-100)
        </div>
        <div>
          <span className="text-[#808080]">%:</span> bet_fraction as % of bankroll (fractional Kelly)
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   RENDER: 2 ROWS PER EVENT
========================================================= */

function EventTwoRow({ group }: { group: EventGroup }) {
  const { awayTeam, homeTeam, commence_time, matchup } = group;

  return (
    <>
      {/* Away row */}
      <tr className="hover:bg-[#0f0f0f]/50 transition-colors">
        <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10 min-w-[240px]">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-white">
                <span className="text-[#b0b0b0]">{awayTeam}</span>
                <span className="text-[#606060]"> @ </span>
                <span className="text-white">{homeTeam}</span>
              </div>
              <div className="text-[10px] text-[#606060] mt-0.5">
                {fmtDateCentral(commence_time)} · {fmtTimeCentral(commence_time)}
                {matchup ? <span className="text-[#404040]"> · {matchup}</span> : null}
              </div>
            </div>
            <div className="text-[10px] text-[#606060] mt-0.5 whitespace-nowrap">Away</div>
          </div>
        </td>

        {/* ML */}
        <CellBlock play={group.awayRowPlays.ml ?? null} borderLeft />
        {/* Spread */}
        <CellBlock play={group.awayRowPlays.spread ?? null} borderLeft />
        {/* Total */}
        <CellBlock play={group.awayRowPlays.total ?? null} borderLeft />
      </tr>

      {/* Home row */}
      <tr className="hover:bg-[#0f0f0f]/50 transition-colors">
        <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10 min-w-[240px]">
          <div className="flex items-start justify-between gap-2">
            <div className="text-white">{homeTeam}</div>
            <div className="text-[10px] text-[#606060] mt-0.5 whitespace-nowrap">Home</div>
          </div>
        </td>

        {/* ML */}
        <CellBlock play={group.homeRowPlays.ml ?? null} borderLeft />
        {/* Spread */}
        <CellBlock play={group.homeRowPlays.spread ?? null} borderLeft />
        {/* Total */}
        <CellBlock play={group.homeRowPlays.total ?? null} borderLeft />
      </tr>
    </>
  );
}

/**
 * Each CellBlock renders 5 columns: Quantum / Book / EV / Score / %
 * (Like your existing structure)
 */
function CellBlock({ play, borderLeft }: { play: CellPlay | null; borderLeft?: boolean }) {
  const faded = !play;

  return (
    <>
      <td className={`text-center p-3 ${borderLeft ? "border-l border-[#2a2a2a]" : ""} ${faded ? "opacity-40" : ""}`}>
        {play ? <QuantumValue play={play} /> : <Dash />}
      </td>

      <td className={`text-center p-3 ${faded ? "opacity-40" : ""}`}>
        {play ? <BookValue play={play} /> : <Dash />}
      </td>

      <td className={`text-center p-3 ${faded ? "opacity-40" : ""}`}>
        {play ? <EVValue value={play.ev_pct} /> : <Dash />}
      </td>

      <td className={`text-center p-3 ${faded ? "opacity-40" : ""}`}>
        {play ? <ScoreValue value={play.confidence_score} tier={play.confidence_tier} /> : <Dash />}
      </td>

      <td className={`text-center p-3 ${faded ? "opacity-40" : ""}`}>
        {play ? <PctValue frac={play.bet_fraction} /> : <Dash />}
      </td>
    </>
  );
}

function Dash() {
  return <div className="text-[#404040]">—</div>;
}

function QuantumValue({ play }: { play: CellPlay }) {
  const lineStr = fmtLine(play.market, play.side, play.line);
  return (
    <div className="text-white leading-tight">
      <div className="font-semibold">{american(play.quantum_odds)}</div>
      {lineStr ? <div className="text-[10px] text-[#606060] mt-0.5">{lineStr}</div> : null}
    </div>
  );
}

function BookValue({ play }: { play: CellPlay }) {
  const lineStr = fmtLine(play.market, play.side, play.line);
  return (
    <div className="leading-tight">
      <div className={`font-semibold ${bookColorClass(play.bookmaker)}`}>
        {american(play.book_odds)} <span className="text-[10px] text-[#606060]">({bookLabel(play.bookmaker)})</span>
      </div>
      {lineStr ? <div className="text-[10px] text-[#606060] mt-0.5">{lineStr}</div> : null}
    </div>
  );
}

function EVValue({ value }: { value: number }) {
  const isPositive = value > 0;
  return (
    <div className={`${isPositive ? "text-[#d4af37]" : "text-[#808080]"}`}>
      {value > 0 ? "+" : ""}
      {value.toFixed(1)}%
    </div>
  );
}

function ScoreValue({ value, tier }: { value: number; tier?: string }) {
  let color = "text-[#606060]";
  if (value >= 85) color = "text-[#d4af37]";
  else if (value >= 70) color = "text-white";

  return (
    <div className={color}>
      {Math.round(value)}
      {tier ? <span className="text-[10px] text-[#606060]"> {tier}</span> : null}
    </div>
  );
}

function PctValue({ frac }: { frac: number }) {
  const pct = Math.max(0, frac) * 100;
  if (pct <= 0) return <div className="text-[#404040]">—</div>;

  return (
    <div className="inline-flex items-center justify-center px-2 py-0.5 bg-[#d4af37]/20 border border-[#d4af37]/40 rounded text-[#d4af37]">
      {pct.toFixed(2)}%
    </div>
  );
}

/* =========================================================
   GROUPING HELPERS
========================================================= */

function buildEventGroups(rows: EvPlayRow[]): EventGroup[] {
  // group by event_id
  const byEvent = new Map<string, EvPlayRow[]>();
  for (const r of rows) {
    const eid = r.event_id;
    if (!eid) continue;
    const arr = byEvent.get(eid) ?? [];
    arr.push(r);
    byEvent.set(eid, arr);
  }

  const groups: EventGroup[] = [];

  for (const [event_id, evs] of byEvent.entries()) {
    // determine matchup + teams
    const first = evs[0];
    const commence_time = first.commence_time ?? null;
    const matchup = first.matchup ?? null;

    const { away, home } = parseMatchup(matchup);

    // Split candidates per row (away/home) and per market bucket
    const awayML = pickBest(evs.filter((r) => r.market === "h2h" && r.side === "away"));
    const homeML = pickBest(evs.filter((r) => r.market === "h2h" && r.side === "home"));

    const awaySpread = pickBest(evs.filter((r) => r.market === "spreads" && r.side === "away"));
    const homeSpread = pickBest(evs.filter((r) => r.market === "spreads" && r.side === "home"));

    const overTotal = pickBest(evs.filter((r) => r.market === "totals" && r.side === "over"));
    const underTotal = pickBest(evs.filter((r) => r.market === "totals" && r.side === "under"));

    groups.push({
      event_id,
      commence_time,
      matchup,

      awayTeam: away,
      homeTeam: home,

      awayRowPlays: {
        ml: awayML ? toCell(awayML) : null,
        spread: awaySpread ? toCell(awaySpread) : null,
        total: overTotal ? toCell(overTotal) : null, // totals are OVER on away row
      },

      homeRowPlays: {
        ml: homeML ? toCell(homeML) : null,
        spread: homeSpread ? toCell(homeSpread) : null,
        total: underTotal ? toCell(underTotal) : null, // totals are UNDER on home row
      },
    });
  }

  // sort by time
  groups.sort((a, b) => {
    const ta = a.commence_time ? new Date(a.commence_time).getTime() : 0;
    const tb = b.commence_time ? new Date(b.commence_time).getTime() : 0;
    return ta - tb;
  });

  return groups;
}

function toCell(r: EvPlayRow): CellPlay {
  return {
    market: r.market,
    side: r.side,
    line: r.line ?? null,
    bookmaker: r.bookmaker,
    book_odds: r.book_odds,
    quantum_odds: r.quantum_odds,
    ev_pct: r.ev_pct,
    confidence_score: r.confidence_score,
    confidence_tier: r.confidence_tier,
    bet_fraction: r.bet_fraction,
  };
}
