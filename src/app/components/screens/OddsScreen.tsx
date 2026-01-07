"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import {
  ChevronDown,
  RefreshCcw,
  Search,
  CalendarDays,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";

/* =========================================================
   GOAL: Odds-board matrix like screenshot
   - Teams are rows
   - Sportsbooks are columns
   - Market is "Point Spread" / "Moneyline" / "Total"
   - Dense cells, sticky header, date separators
========================================================= */

type MarketMode = "spreads" | "h2h" | "totals";
type GameFilter = "all" | "full_game";
type PhaseMode = "pregame" | "live";
type OddsFormat = "american"; // (easy to add decimal later)

type BookKey =
  | "pinnacle"
  | "betmgm"
  | "circa"
  | "fanduel"
  | "draftkings"
  | "betonlineag"
  | "caesars"
  | "espnbet"
  | "betrivers";

/**
 * === IMPORTANT ===
 * This component assumes you have a row-based odds table like:
 * public.odds_snapshot (or public.odds_snapshot_latest)
 *
 * Typical columns seen in odds APIs:
 * - sport_key
 * - event_id
 * - commence_time
 * - home_team, away_team
 * - market_key ("h2h" | "spreads" | "totals")
 * - bookmaker_key (draftkings, fanduel, etc)
 * - outcome_name ("Home" / "Away" / team name / "Over" / "Under")
 * - price (American odds int)
 * - point (spread/total line float, nullable)
 *
 * If your names differ, update the "FETCH" mapper section only.
 */
type SnapshotRow = {
  sport_key?: string | null;
  event_id: string;
  commence_time: string;

  home_team: string;
  away_team: string;

  market_key: string; // "h2h" | "spreads" | "totals"
  bookmaker_key: string;

  outcome_name: string; // team name OR "Over"/"Under"
  price: number | null;
  point: number | null;

  // optional timestamp if you have it
  ts?: string | null;
};

type TeamSide = "away" | "home";

type CellOffer = {
  // for spreads: line + price
  // for h2h: price only
  // for totals: over/under by row (we render separate "Over"/"Under" rows)
  line?: number | null;
  price?: number | null;
};

type BoardRow = {
  // identifies row
  event_id: string;
  commence_time: string;
  dateKey: string;

  // row label
  rowType: "team" | "total";
  side: TeamSide | null; // for team rows
  totalSide: "over" | "under" | null; // for totals rows
  labelLeft: string; // "Los Angeles Rams"
  labelRight: string; // "vs Carolina Panthers" (optional)
  timeLabel: string;

  // offers per book
  offersByBook: Record<BookKey, CellOffer | null>;
};

type EventMeta = {
  event_id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
};

/* =========================================================
   BOOKS (columns) — match screenshot vibe
========================================================= */

const BOOKS: { key: BookKey; label: string }[] = [
  { key: "pinnacle", label: "Pinnacle" },
  { key: "betmgm", label: "BetMGM" },
  { key: "circa", label: "Circa" },
  { key: "fanduel", label: "FanDuel" },
  { key: "draftkings", label: "DraftKings" },
  { key: "betonlineag", label: "BetOnline" },
  { key: "caesars", label: "Caesars" },
  { key: "espnbet", label: "ESPNBET" },
  { key: "betrivers", label: "BetRivers" },
];

/** Optional: wire in your local assets (recommended) */
const BOOK_ICON: Partial<Record<BookKey, string>> = {
  pinnacle: "/books/pinnacle.png",
  betmgm: "/books/betmgm.png",
  circa: "/books/circa.png",
  fanduel: "/books/fanduel.png",
  draftkings: "/books/draftkings.png",
  betonlineag: "/books/betonline.png",
  caesars: "/books/caesars.png",
  espnbet: "/books/espnbet.png",
  betrivers: "/books/betrivers.png",
};

/* =========================================================
   STYLE HELPERS
========================================================= */

const CT = "America/Chicago";

function fmtAmerican(n?: number | null) {
  if (n == null) return "";
  if (n > 0) return `+${n}`;
  return `${n}`;
}

function fmtLine(n?: number | null) {
  if (n == null) return "";
  // keep 0.5 lines clean
  const s = Number.isInteger(n) ? `${n}` : n.toFixed(1);
  return s.startsWith("-") ? s : `+${s}`;
}

function fmtTimeCT(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function fmtDateHeaderCT(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

function ymdCT(iso: string) {
  // used for grouping by day
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CT,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "00";
  const day = parts.find((p) => p.type === "day")?.value ?? "00";
  return `${y}-${m}-${day}`;
}

function normalizeBookKey(raw: string): BookKey | null {
  const k = raw.toLowerCase();
  if (k.includes("pinnacle")) return "pinnacle";
  if (k.includes("betmgm")) return "betmgm";
  if (k.includes("circa")) return "circa";
  if (k.includes("fanduel")) return "fanduel";
  if (k.includes("draftkings")) return "draftkings";
  if (k.includes("betonline")) return "betonlineag";
  if (k.includes("caesars")) return "caesars";
  if (k.includes("espn")) return "espnbet";
  if (k.includes("betrivers")) return "betrivers";

  // if your DB stores exactly these keys, you can simplify:
  if (k === "pinnacle") return "pinnacle";
  if (k === "betmgm") return "betmgm";
  if (k === "circa") return "circa";
  if (k === "fanduel") return "fanduel";
  if (k === "draftkings") return "draftkings";
  if (k === "betonlineag") return "betonlineag";
  if (k === "caesars") return "caesars";
  if (k === "espnbet") return "espnbet";
  if (k === "betrivers") return "betrivers";

  return null;
}

/* =========================================================
   UI PARTS
========================================================= */

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none bg-[#101821] text-[#dbe4ee] border border-[#1e2a36] rounded-md px-3 py-2 pr-9 text-sm focus:outline-none focus:ring-1 focus:ring-[#2b8cff]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-[#7b8a9a]" />
    </div>
  );
}

function Chip({
  icon,
  label,
}: {
  icon?: React.ReactNode;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 bg-[#0f1720] border border-[#1e2a36] rounded-md px-3 py-2 text-sm text-[#dbe4ee]">
      {icon}
      <span className="whitespace-nowrap">{label}</span>
    </div>
  );
}

/* =========================================================
   MAIN
========================================================= */

export function OddsScreen({
  sportKey = "americanfootball_nfl",
}: {
  sportKey?: string;
}) {
  const [market, setMarket] = useState<MarketMode>("spreads");
  const [phase, setPhase] = useState<PhaseMode>("pregame");
  const [gameFilter, setGameFilter] = useState<GameFilter>("all");
  const [format, setFormat] = useState<OddsFormat>("american");
  const [search, setSearch] = useState("");
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    // default: today CT
    const now = new Date().toISOString();
    return ymdCT(now);
  });

  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const [raw, setRaw] = useState<SnapshotRow[]>([]);
  const [metaByEvent, setMetaByEvent] = useState<Record<string, EventMeta>>({});

  const refresh = async () => {
    setLoading(true);
    try {
      /* =========================================================
         FETCH
         - Update table name here if needed
         - Update selected columns if needed
         - Everything else is just UI + pivoting
      ========================================================= */

      // We fetch a window around selectedDate to be safe.
      // If you have a proper date column, filter on it instead.
      const dayStart = new Date(`${selectedDate}T00:00:00.000Z`);
      const dayEnd = new Date(`${selectedDate}T23:59:59.999Z`);

      // NOTE: this assumes commence_time is stored in ISO and comparable.
      const { data, error } = await supabase
        .from("odds_snapshot") // ✅ change if yours is odds_snapshot_latest, odds_snapshot_view, etc.
        .select(
          "sport_key,event_id,commence_time,home_team,away_team,market_key,bookmaker_key,outcome_name,price,point,ts"
        )
        .eq("sport_key", sportKey)
        .gte("commence_time", dayStart.toISOString())
        .lte("commence_time", dayEnd.toISOString())
        .in("market_key", ["h2h", "spreads", "totals"]);

      if (error) throw error;

      const rows = ((data ?? []) as SnapshotRow[]).filter((r) => {
        // phase: pregame vs live (basic heuristic; change if you have status column)
        const isLive =
          new Date(r.commence_time).getTime() < Date.now() - 5 * 60 * 1000;
        return phase === "live" ? isLive : !isLive;
      });

      // meta
      const meta: Record<string, EventMeta> = {};
      for (const r of rows) {
        if (!meta[r.event_id]) {
          meta[r.event_id] = {
            event_id: r.event_id,
            commence_time: r.commence_time,
            home_team: r.home_team,
            away_team: r.away_team,
          };
        }
      }

      setRaw(rows);
      setMetaByEvent(meta);
      setLastUpdated(new Date().toLocaleTimeString("en-US", { timeZone: CT }));
    } catch (e) {
      console.error(e);
      setRaw([]);
      setMetaByEvent({});
      setLastUpdated(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sportKey, selectedDate, phase]);

  /* =========================================================
     PIVOT -> BOARD ROWS
     - This is where the “screenshot look” is born
  ========================================================= */

  const boardRows: BoardRow[] = useMemo(() => {
    const q = search.trim().toLowerCase();

    // Filter raw to current market
    const marketKey = market; // "spreads" | "h2h" | "totals"
    const rows = raw.filter((r) => r.market_key === marketKey);

    // Group by event
    const byEvent: Record<string, SnapshotRow[]> = {};
    for (const r of rows) {
      if (!byEvent[r.event_id]) byEvent[r.event_id] = [];
      byEvent[r.event_id].push(r);
    }

    const out: BoardRow[] = [];

    const eventIds = Object.keys(byEvent).sort((a, b) => {
      const ta = new Date(metaByEvent[a]?.commence_time ?? 0).getTime();
      const tb = new Date(metaByEvent[b]?.commence_time ?? 0).getTime();
      return ta - tb;
    });

    for (const event_id of eventIds) {
      const meta = metaByEvent[event_id];
      if (!meta) continue;

      const dateKey = ymdCT(meta.commence_time);
      const timeLabel = fmtTimeCT(meta.commence_time);

      // Search filter
      if (q) {
        const hit =
          meta.home_team.toLowerCase().includes(q) ||
          meta.away_team.toLowerCase().includes(q);
        if (!hit) continue;
      }

      const chunk = byEvent[event_id];

      if (market === "totals") {
        // Totals board: render two rows "Over" and "Under" (like a board would)
        const makeTotalsRow = (totalSide: "over" | "under"): BoardRow => {
          const offersByBook = {} as Record<BookKey, CellOffer | null>;
          for (const b of BOOKS) offersByBook[b.key] = null;

          for (const r of chunk) {
            const bk = normalizeBookKey(r.bookmaker_key);
            if (!bk) continue;

            const name = r.outcome_name.toLowerCase();
            const want = totalSide === "over" ? "over" : "under";
            if (!name.includes(want)) continue;

            offersByBook[bk] = {
              line: r.point,
              price: r.price,
            };
          }

          return {
            event_id,
            commence_time: meta.commence_time,
            dateKey,
            rowType: "total",
            side: null,
            totalSide,
            labelLeft: totalSide === "over" ? "Over" : "Under",
            labelRight: `${meta.away_team} vs ${meta.home_team}`,
            timeLabel,
            offersByBook,
          };
        };

        out.push(makeTotalsRow("over"));
        out.push(makeTotalsRow("under"));
        continue;
      }

      // Spreads / H2H board: two team rows (away, home)
      const makeTeamRow = (side: TeamSide): BoardRow => {
        const team = side === "away" ? meta.away_team : meta.home_team;

        const offersByBook = {} as Record<BookKey, CellOffer | null>;
        for (const b of BOOKS) offersByBook[b.key] = null;

        for (const r of chunk) {
          const bk = normalizeBookKey(r.bookmaker_key);
          if (!bk) continue;

          // outcome_name may be team name OR "Away"/"Home"
          const on = r.outcome_name.toLowerCase();

          const isMatch =
            on === team.toLowerCase() ||
            (side === "away" && on === "away") ||
            (side === "home" && on === "home") ||
            on.includes(team.toLowerCase());

          if (!isMatch) continue;

          offersByBook[bk] = {
            line: market === "spreads" ? r.point : null,
            price: r.price,
          };
        }

        return {
          event_id,
          commence_time: meta.commence_time,
          dateKey,
          rowType: "team",
          side,
          totalSide: null,
          labelLeft: team,
          labelRight: side === "away" ? "@" : "",
          timeLabel,
          offersByBook,
        };
      };

      out.push(makeTeamRow("away"));
      out.push(makeTeamRow("home"));
    }

    return out;
  }, [raw, metaByEvent, market, search]);

  // Group by dateKey for the date separator rows
  const grouped = useMemo(() => {
    const map = new Map<string, BoardRow[]>();
    for (const r of boardRows) {
      if (!map.has(r.dateKey)) map.set(r.dateKey, []);
      map.get(r.dateKey)!.push(r);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [boardRows]);

  const sportsBookCount = BOOKS.length;

  /* =========================================================
     RENDER
========================================================= */

  return (
    <div className="min-h-screen bg-[#0b1118] text-[#dbe4ee]">
      {/* Top Nav / Toolbar */}
      <div className="px-4 pt-4">
        <div className="rounded-xl border border-[#17222e] bg-gradient-to-b from-[#0f1720] to-[#0b1118]">
          <div className="flex flex-col gap-3 p-4">
            {/* Row 1 */}
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={market}
                onChange={(v) => setMarket(v as MarketMode)}
                options={[
                  { value: "spreads", label: "Point Spread" },
                  { value: "h2h", label: "Moneyline" },
                  { value: "totals", label: "Total" },
                ]}
              />
              <Select
                value={gameFilter}
                onChange={(v) => setGameFilter(v as GameFilter)}
                options={[
                  { value: "all", label: "All Games" },
                  { value: "full_game", label: "Full Game" },
                ]}
              />

              <button
                onClick={() =>
                  setPhase((p) => (p === "pregame" ? "live" : "pregame"))
                }
                className="flex items-center gap-2 bg-[#101821] border border-[#1e2a36] rounded-md px-3 py-2 text-sm"
                title="Toggle Pre Game / Live"
              >
                {phase === "pregame" ? (
                  <>
                    <ToggleLeft className="w-4 h-4 text-[#7b8a9a]" />
                    <span>Pre Game</span>
                  </>
                ) : (
                  <>
                    <ToggleRight className="w-4 h-4 text-[#2b8cff]" />
                    <span>Live</span>
                  </>
                )}
              </button>

              <Chip
                icon={<CalendarDays className="w-4 h-4 text-[#7b8a9a]" />}
                label={selectedDate}
              />

              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="bg-[#101821] text-[#dbe4ee] border border-[#1e2a36] rounded-md px-3 py-2 text-sm"
              />

              <div className="flex-1" />
              <div className="relative w-full sm:w-[340px]">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#7b8a9a]" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search teams…"
                  className="w-full bg-[#101821] text-[#dbe4ee] border border-[#1e2a36] rounded-md pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#2b8cff]"
                />
              </div>
            </div>

            {/* Row 2 */}
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={format}
                onChange={(v) => setFormat(v as OddsFormat)}
                options={[{ value: "american", label: "American" }]}
              />

              <Chip label={`Sportsbooks (${sportsBookCount})`} />

              <button
                onClick={refresh}
                className="ml-auto flex items-center gap-2 bg-[#0f2236] border border-[#224663] text-[#dbe4ee] rounded-md px-3 py-2 text-sm hover:bg-[#12314e]"
              >
                <RefreshCcw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>

            {/* Status */}
            <div className="flex items-center justify-between text-xs text-[#7b8a9a]">
              <div>
                {boardRows.length} rows ·{" "}
                {market === "spreads"
                  ? "Point spreads"
                  : market === "h2h"
                  ? "Moneylines"
                  : "Totals"}
              </div>
              <div>
                {lastUpdated ? `Last updated ${lastUpdated} CT` : "—"}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Board */}
      <div className="px-4 pb-6 pt-3">
        <div className="rounded-xl border border-[#17222e] bg-[#0b1118] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-[1100px] w-full border-collapse">
              {/* Sticky Header */}
              <thead className="sticky top-0 z-10 bg-[#0f1720]">
                <tr className="border-b border-[#17222e]">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-[#9fb0c2] w-[360px]">
                    Game
                  </th>
                  <th className="text-left px-3 py-3 text-xs font-semibold text-[#9fb0c2] w-[90px]">
                    Time
                  </th>

                  {BOOKS.map((b) => (
                    <th
                      key={b.key}
                      className="px-2 py-3 text-center text-xs font-semibold text-[#9fb0c2] w-[120px]"
                    >
                      <div className="flex items-center justify-center gap-2">
                        {BOOK_ICON[b.key] ? (
                          <img
                            src={BOOK_ICON[b.key]}
                            alt={b.label}
                            className="h-4 w-auto opacity-90"
                          />
                        ) : (
                          <span className="opacity-90">{b.label}</span>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {grouped.length === 0 && (
                  <tr>
                    <td
                      colSpan={2 + BOOKS.length}
                      className="px-4 py-10 text-center text-sm text-[#7b8a9a]"
                    >
                      No games found for this date/phase.
                    </td>
                  </tr>
                )}

                {grouped.map(([dateKey, rowsForDate]) => {
                  const dateHeaderLabel =
                    rowsForDate.length > 0
                      ? fmtDateHeaderCT(rowsForDate[0].commence_time)
                      : dateKey;

                  return (
                    <React.Fragment key={dateKey}>
                      {/* Date separator row */}
                      <tr className="bg-[#0f1520]">
                        <td
                          colSpan={2 + BOOKS.length}
                          className="px-4 py-2 text-xs font-semibold text-[#3fb7ff]"
                        >
                          {dateHeaderLabel}
                        </td>
                      </tr>

                      {rowsForDate.map((r, idx) => {
                        const isFirstOfEvent =
                          idx === 0 || rowsForDate[idx - 1].event_id !== r.event_id;

                        // Add a subtle divider between games like screenshot
                        const showGameDivider =
                          idx > 0 &&
                          rowsForDate[idx - 1].event_id !== r.event_id;

                        return (
                          <React.Fragment key={`${r.event_id}-${r.rowType}-${r.side ?? r.totalSide}`}>
                            {showGameDivider && (
                              <tr>
                                <td
                                  colSpan={2 + BOOKS.length}
                                  className="h-[8px] bg-[#0b1118] border-t border-[#17222e]"
                                />
                              </tr>
                            )}

                            <tr className="border-t border-[#131c26] hover:bg-[#0f1720]">
                              {/* Game / Team cell */}
                              <td className="px-4 py-3 align-middle">
                                <div className="flex items-center gap-3">
                                  <div className="min-w-0">
                                    <div className="text-sm font-semibold text-[#e6edf6] truncate">
                                      {r.rowType === "team" ? r.labelLeft : r.labelLeft}
                                    </div>

                                    {/* Only show matchup subline on first row of each event */}
                                    {isFirstOfEvent && (
                                      <div className="text-xs text-[#7b8a9a] mt-1 truncate">
                                        {metaByEvent[r.event_id]?.away_team} vs{" "}
                                        {metaByEvent[r.event_id]?.home_team}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </td>

                              {/* Time cell */}
                              <td className="px-3 py-3 text-xs text-[#9fb0c2]">
                                {r.timeLabel}
                              </td>

                              {/* Book columns */}
                              {BOOKS.map((b) => {
                                const offer = r.offersByBook[b.key];
                                const has = offer && (offer.price != null || offer.line != null);

                                return (
                                  <td
                                    key={b.key}
                                    className="px-2 py-2 text-center align-middle"
                                  >
                                    <div className="mx-auto w-[104px] rounded-md border border-[#1a2734] bg-[#0e151f] px-2 py-2">
                                      {!has ? (
                                        <div className="text-xs text-[#3b4a5b]">—</div>
                                      ) : market === "h2h" ? (
                                        <div className="text-xs font-semibold text-[#dbe4ee] tabular-nums">
                                          {fmtAmerican(offer?.price)}
                                        </div>
                                      ) : market === "spreads" ? (
                                        <div className="space-y-[2px] text-xs font-semibold tabular-nums">
                                          <div className="text-[#dbe4ee]">
                                            {offer?.line != null ? fmtLine(offer.line) : ""}
                                          </div>
                                          <div className="text-[#9fb0c2]">
                                            {fmtAmerican(offer?.price)}
                                          </div>
                                        </div>
                                      ) : (
                                        // totals
                                        <div className="space-y-[2px] text-xs font-semibold tabular-nums">
                                          <div className="text-[#dbe4ee]">
                                            {offer?.line != null ? offer.line.toFixed(1) : ""}
                                          </div>
                                          <div className="text-[#9fb0c2]">
                                            {fmtAmerican(offer?.price)}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </td>
                                );
                              })}
                            </tr>
                          </React.Fragment>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-[#17222e] text-xs text-[#7b8a9a] bg-[#0b1118]">
            <div>Showing {boardRows.length} rows</div>
            <div className="italic">Market Board · American format</div>
          </div>
        </div>
      </div>
    </div>
  );
}

