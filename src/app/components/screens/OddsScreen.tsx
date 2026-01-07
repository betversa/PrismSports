"use client";

/**
 * src/app/components/screens/OddsScreen.tsx — FULL REWRITE (Premium Black+Gold, no dark blue)
 * -------------------------------------------------------------------------------------------------
 * ✅ Unified Market dropdown (ML / Spread / Total) for the main board
 * ✅ Premium Prism look: hero gradient, gold glow, glass panels, tight rows, sticky header table
 * ✅ Mobile: per-game cards; Desktop: clean board rows
 * ✅ Game Details modal:
 *    - Odds View dropdown: ML / Spread / Total
 *    - History View dropdown: Odds History / Line Movement
 * ✅ NO dark-blue theme colors anywhere (all neutrals + gold)
 *
 * Data dependencies (unchanged assumptions):
 *   - public.odds_wide_latest (one row per side per event) with:
 *       sport_key, event_id, commence_time, side, team, logo_url, updated_at,
 *       dk_* / fd_* / mgm_* / pin_* / bol_* columns for ml/spread/total
 *   - public.odds_snapshot_history (for modal history, optional but supported):
 *       sport_key, event_id, ts, bookmaker, market, side, line, odds
 *
 * Notes:
 * - This file is drop-in. If your history table columns differ, adjust the
 *   loadHistory() select() mapping at the bottom.
 */

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";

/* =============================================================================
   TYPES
============================================================================= */

type Market = "ml" | "spread" | "total";
type HistoryMode = "odds" | "movement";

// Internal book keys used throughout UI
type BookKey = "dk" | "fd" | "mgm" | "pin" | "bol";

type SpreadCell = { line: number | null; odds: number | null };
type TotalCell = { line: number | null; over: number | null; under: number | null };

type SideOdds = {
  side: "AWAY" | "HOME";
  team: string;
  logoUrl: string | null;

  ml: Record<BookKey, number | null>;
  spread: Record<BookKey, SpreadCell>;
  total: Record<BookKey, TotalCell>;

  updatedAt: string | null;
};

type EventOdds = {
  eventId: string;
  sportKey?: string | null;
  commenceTime: string;
  away?: SideOdds;
  home?: SideOdds;
  latestUpdatedAt: string | null;
};

type HistoryRow = {
  ts: string; // ISO
  bookmaker: string; // "draftkings" | "fanduel" | "betmgm" | "pinnacle" | "betonlineag" etc.
  market: string; // "ml" | "spread" | "total" (or your naming)
  side: string; // "AWAY" | "HOME" | "OVER" | "UNDER"
  line: number | null;
  odds: number | null;
};

/* =============================================================================
   THEME (NO DARK BLUE)
============================================================================= */

const CT_TZ = "America/Chicago";

// Prism palette: strict neutrals + gold
const GOLD = "#d4af37";
const GOLD_SOFT = "rgba(212, 175, 55, 0.20)";
const PANEL = "rgba(10,10,10,0.85)";
const PANEL_2 = "rgba(0,0,0,0.55)";
const BORDER = "rgba(255,255,255,0.08)";
const MUTED = "rgba(255,255,255,0.62)";
const MUTED_2 = "rgba(255,255,255,0.42)";

// Books shown on the strip
const BOOKS: BookKey[] = ["dk", "fd", "mgm", "pin", "bol"];

const BOOK_LABEL: Record<BookKey, string> = {
  dk: "DK",
  fd: "FD",
  mgm: "MGM",
  pin: "PIN",
  bol: "BOL",
};

// Keep sportsbook branding for the text only.
// Avoid using those colors as backgrounds (prevents “blue theme” feel).
const BOOK_TEXT: Record<BookKey, string> = {
  dk: "#22c55e",     // green
  fd: "#60a5fa",     // light sky-blue (not dark)
  mgm: GOLD,         // gold
  pin: "#fb923c",    // orange
  bol: "#f87171",    // soft red
};

function clampText(v: any) {
  if (v === null || v === undefined) return "—";
  return String(v);
}

/* =============================================================================
   TIME HELPERS
============================================================================= */

function normalizeIso(v?: string | null) {
  if (!v) return null;
  if (v.endsWith("Z")) return v;
  // try to coerce a "YYYY-MM-DD HH:mm:ss" or similar
  return v.includes("T") ? `${v}Z` : v.replace(" ", "T") + "Z";
}

function fmtCT(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(normalizeIso(iso)!);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/* =============================================================================
   MAP WIDE ROW → SIDE ODDS
============================================================================= */

function mapWide(row: any): SideOdds {
  return {
    side: row.side,
    team: row.team,
    logoUrl: row.logo_url ?? null,
    updatedAt: row.updated_at ?? null,

    ml: {
      dk: row.dk_ml_odds ?? null,
      fd: row.fd_ml_odds ?? null,
      mgm: row.mgm_ml_odds ?? null,
      pin: row.pin_ml_odds ?? null,
      bol: row.bol_ml_odds ?? null,
    },

    spread: {
      dk: { line: row.dk_spread_line ?? null, odds: row.dk_spread_odds ?? null },
      fd: { line: row.fd_spread_line ?? null, odds: row.fd_spread_odds ?? null },
      mgm: { line: row.mgm_spread_line ?? null, odds: row.mgm_spread_odds ?? null },
      pin: { line: row.pin_spread_line ?? null, odds: row.pin_spread_odds ?? null },
      bol: { line: row.bol_spread_line ?? null, odds: row.bol_spread_odds ?? null },
    },

    total: {
      dk: { line: row.dk_total_line ?? null, over: row.dk_total_over_odds ?? null, under: row.dk_total_under_odds ?? null },
      fd: { line: row.fd_total_line ?? null, over: row.fd_total_over_odds ?? null, under: row.fd_total_under_odds ?? null },
      mgm:{ line: row.mgm_total_line ?? null, over: row.mgm_total_over_odds ?? null, under: row.mgm_total_under_odds ?? null },
      pin:{ line: row.pin_total_line ?? null, over: row.pin_total_over_odds ?? null, under: row.pin_total_under_odds ?? null },
      bol:{ line: row.bol_total_line ?? null, over: row.bol_total_over_odds ?? null, under: row.bol_total_under_odds ?? null },
    },
  };
}

/* =============================================================================
   MAIN SCREEN
============================================================================= */

export function OddsScreen({ sportKey }: { sportKey: string }) {
  const [events, setEvents] = useState<EventOdds[]>([]);
  const [market, setMarket] = useState<Market>("ml");
  const [loading, setLoading] = useState(true);
  const [detailsEvent, setDetailsEvent] = useState<EventOdds | null>(null);

  async function loadBoard() {
    setLoading(true);

    const { data, error } = await supabase
      .from("odds_wide_latest")
      .select("*")
      .eq("sport_key", sportKey)
      .in("side", ["AWAY", "HOME"])
      .order("commence_time", { ascending: true });

    if (error) {
      console.error("odds_wide_latest error:", error);
      setEvents([]);
      setLoading(false);
      return;
    }

    const byEvent = new Map<string, EventOdds>();

    for (const r of data ?? []) {
      const id = r.event_id as string;

      const cur =
        byEvent.get(id) ??
        ({
          eventId: id,
          sportKey,
          commenceTime: r.commence_time,
          latestUpdatedAt: null,
        } as EventOdds);

      const side = mapWide(r);

      if (side.side === "AWAY") cur.away = side;
      if (side.side === "HOME") cur.home = side;

      const sUp = side.updatedAt;
      if (sUp) {
        if (!cur.latestUpdatedAt || new Date(sUp) > new Date(cur.latestUpdatedAt)) {
          cur.latestUpdatedAt = sUp;
        }
      }

      byEvent.set(id, cur);
    }

    setEvents(Array.from(byEvent.values()));
    setLoading(false);
  }

  useEffect(() => {
    loadBoard();
    const t = setInterval(loadBoard, 60_000);
    return () => clearInterval(t);
  }, [sportKey]);

  const hasData = events.length > 0;

  return (
    <div className="min-h-screen px-4 pb-16 text-white"
      style={{
        background:
          // No blue: only black/graphite + gold glow
          `radial-gradient(1200px 600px at 20% 0%, ${GOLD_SOFT} 0%, rgba(0,0,0,0) 60%),
           radial-gradient(900px 500px at 90% 10%, rgba(255,255,255,0.06) 0%, rgba(0,0,0,0) 65%),
           linear-gradient(180deg, #050505 0%, #000000 60%, #000000 100%)`,
      }}
    >
      {/* HERO */}
      <div className="pt-5 pb-4">
        <div
          className="rounded-2xl border p-4 sm:p-5"
          style={{
            borderColor: BORDER,
            background: `linear-gradient(180deg, ${PANEL} 0%, rgba(0,0,0,0.65) 100%)`,
            boxShadow: `0 0 0 1px rgba(255,255,255,0.03) inset, 0 20px 60px rgba(0,0,0,0.6)`,
          }}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[11px] tracking-[0.22em] uppercase"
                   style={{ color: MUTED_2 }}>
                Odds Board
              </div>
              <div className="text-2xl sm:text-3xl font-extrabold leading-tight">
                Prism <span style={{ color: GOLD }}>Lines</span>
              </div>
              <div className="text-sm mt-1" style={{ color: MUTED }}>
                Clean board view + premium modal with history controls.
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* MARKET DROPDOWN */}
              <div
                className="rounded-xl border px-3 py-2"
                style={{ borderColor: BORDER, background: PANEL_2 }}
              >
                <div className="text-[10px] uppercase tracking-[0.22em]" style={{ color: MUTED_2 }}>
                  Market
                </div>
                <select
                  value={market}
                  onChange={(e) => setMarket(e.target.value as Market)}
                  className="bg-transparent outline-none font-extrabold text-sm pr-2"
                >
                  <option value="ml">Moneyline</option>
                  <option value="spread">Spread</option>
                  <option value="total">Total</option>
                </select>
              </div>

              <button
                onClick={loadBoard}
                className="rounded-xl px-4 py-3 font-extrabold border"
                style={{
                  borderColor: BORDER,
                  background: `linear-gradient(180deg, rgba(255,255,255,0.06), rgba(0,0,0,0.20))`,
                }}
              >
                Refresh
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* BODY */}
      {loading ? (
        <div className="mt-6 text-sm" style={{ color: MUTED }}>
          Loading odds…
        </div>
      ) : !hasData ? (
        <div className="mt-6 text-sm" style={{ color: MUTED }}>
          No odds found for this sport.
        </div>
      ) : (
        <>
          {/* MOBILE CARDS */}
          <div className="block lg:hidden space-y-4">
            {events.map((ev) => (
              <MobileEventCard
                key={ev.eventId}
                ev={ev}
                market={market}
                onDetails={() => setDetailsEvent(ev)}
              />
            ))}
          </div>

          {/* DESKTOP TABLE */}
          <div className="hidden lg:block">
            <DesktopBoard
              events={events}
              market={market}
              onDetails={(ev) => setDetailsEvent(ev)}
            />
          </div>
        </>
      )}

      {/* MODAL */}
      {detailsEvent && (
        <GameDetailsModal
          sportKey={sportKey}
          event={detailsEvent}
          onClose={() => setDetailsEvent(null)}
        />
      )}
    </div>
  );
}

/* =============================================================================
   MOBILE CARD
============================================================================= */

function MobileEventCard({
  ev,
  market,
  onDetails,
}: {
  ev: EventOdds;
  market: Market;
  onDetails: () => void;
}) {
  const away = ev.away;
  const home = ev.home;

  return (
    <div
      className="rounded-2xl border p-4"
      style={{
        borderColor: BORDER,
        background: `linear-gradient(180deg, rgba(18,18,18,0.82), rgba(0,0,0,0.65))`,
        boxShadow: `0 0 0 1px rgba(255,255,255,0.02) inset, 0 16px 50px rgba(0,0,0,0.55)`,
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs" style={{ color: MUTED_2 }}>
            {fmtCT(ev.commenceTime)} CT
          </div>
          <div className="font-extrabold text-base truncate">
            {away?.team ?? "Away"} <span style={{ color: MUTED_2 }}>vs</span> {home?.team ?? "Home"}
          </div>
        </div>

        <button
          onClick={onDetails}
          className="rounded-xl px-3 py-2 font-extrabold text-sm"
          style={{
            background: `linear-gradient(180deg, ${GOLD} 0%, rgba(212,175,55,0.75) 100%)`,
            color: "#000",
            boxShadow: `0 10px 30px rgba(212,175,55,0.20)`,
          }}
        >
          Details
        </button>
      </div>

      {/* Book strip */}
      <div className="mt-4 grid grid-cols-5 gap-2">
        {BOOKS.map((bk) => {
          const text = getBookCellText(ev, market, bk);
          return (
            <div
              key={bk}
              className="rounded-xl border px-2 py-2 text-center"
              style={{
                borderColor: BORDER,
                background: `linear-gradient(180deg, rgba(255,255,255,0.05), rgba(0,0,0,0.25))`,
              }}
            >
              <div className="text-[10px] font-extrabold" style={{ color: BOOK_TEXT[bk] }}>
                {BOOK_LABEL[bk]}
              </div>
              <div className="mt-0.5 text-[12px] font-extrabold" style={{ color: "rgba(255,255,255,0.88)" }}>
                {text}
              </div>
            </div>
          );
        })}
      </div>

      {/* Updated */}
      <div className="mt-3 text-[11px]" style={{ color: MUTED_2 }}>
        Updated: {fmtCT(ev.latestUpdatedAt)}
      </div>
    </div>
  );
}

/* =============================================================================
   DESKTOP BOARD (Sticky header, premium rows)
============================================================================= */

function DesktopBoard({
  events,
  market,
  onDetails,
}: {
  events: EventOdds[];
  market: Market;
  onDetails: (ev: EventOdds) => void;
}) {
  return (
    <div
      className="rounded-2xl border overflow-hidden"
      style={{
        borderColor: BORDER,
        background: `linear-gradient(180deg, rgba(18,18,18,0.75), rgba(0,0,0,0.55))`,
        boxShadow: `0 0 0 1px rgba(255,255,255,0.02) inset, 0 22px 70px rgba(0,0,0,0.60)`,
      }}
    >
      <div className="max-h-[72vh] overflow-auto">
        <table className="w-full text-sm">
          <thead
            className="sticky top-0 z-10"
            style={{
              background: `linear-gradient(180deg, rgba(0,0,0,0.92), rgba(10,10,10,0.92))`,
              borderBottom: `1px solid ${BORDER}`,
            }}
          >
            <tr>
              <th className="text-left px-4 py-3 font-extrabold">Matchup</th>
              <th className="text-left px-4 py-3 font-extrabold">Time (CT)</th>
              {BOOKS.map((bk) => (
                <th key={bk} className="text-center px-2 py-3 font-extrabold" style={{ color: BOOK_TEXT[bk] }}>
                  {BOOK_LABEL[bk]}
                </th>
              ))}
              <th className="text-right px-4 py-3 font-extrabold">Updated</th>
              <th className="text-right px-4 py-3 font-extrabold"> </th>
            </tr>
          </thead>

          <tbody>
            {events.map((ev, idx) => {
              const away = ev.away?.team ?? "Away";
              const home = ev.home?.team ?? "Home";
              return (
                <tr
                  key={ev.eventId}
                  style={{
                    borderBottom: `1px solid ${idx === events.length - 1 ? "transparent" : "rgba(255,255,255,0.06)"}`,
                    background: idx % 2 === 0 ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.15)",
                  }}
                >
                  <td className="px-4 py-3 font-extrabold">
                    {away} <span style={{ color: MUTED_2 }}>vs</span> {home}
                  </td>
                  <td className="px-4 py-3" style={{ color: MUTED }}>
                    {fmtCT(ev.commenceTime)}
                  </td>

                  {BOOKS.map((bk) => (
                    <td key={bk} className="px-2 py-3 text-center">
                      <span className="font-extrabold" style={{ color: "rgba(255,255,255,0.90)" }}>
                        {getBookCellText(ev, market, bk)}
                      </span>
                    </td>
                  ))}

                  <td className="px-4 py-3 text-right text-xs" style={{ color: MUTED_2 }}>
                    {fmtCT(ev.latestUpdatedAt)}
                  </td>

                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => onDetails(ev)}
                      className="rounded-xl px-3 py-2 font-extrabold text-sm"
                      style={{
                        background: `linear-gradient(180deg, ${GOLD} 0%, rgba(212,175,55,0.72) 100%)`,
                        color: "#000",
                        boxShadow: `0 10px 30px rgba(212,175,55,0.18)`,
                      }}
                    >
                      Game Details
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* =============================================================================
   CELL TEXT PER MARKET
============================================================================= */

function getBookCellText(ev: EventOdds, market: Market, bk: BookKey) {
  const away = ev.away;
  const home = ev.home;

  if (market === "ml") {
    const a = away?.ml[bk];
    const h = home?.ml[bk];
    return `${clampText(a)} / ${clampText(h)}`;
  }

  if (market === "spread") {
    // Display both sides compactly, not just away
    const aL = away?.spread[bk]?.line ?? null;
    const aO = away?.spread[bk]?.odds ?? null;
    const hL = home?.spread[bk]?.line ?? null;
    const hO = home?.spread[bk]?.odds ?? null;

    // Example: "-3.5 (-110) | +3.5 (-110)"
    const left = aL === null ? "—" : `${aL} (${clampText(aO)})`;
    const right = hL === null ? "—" : `${hL} (${clampText(hO)})`;
    return `${left} | ${right}`;
  }

  // total
  const line = away?.total[bk]?.line ?? home?.total[bk]?.line ?? null;
  const over = away?.total[bk]?.over ?? null;
  const under = away?.total[bk]?.under ?? null;
  // Example: "228.5 O(-110)/U(-110)"
  if (line === null) return "—";
  return `${line} O(${clampText(over)})/U(${clampText(under)})`;
}

/* =============================================================================
   GAME DETAILS MODAL (Premium)
============================================================================= */

function GameDetailsModal({
  sportKey,
  event,
  onClose,
}: {
  sportKey: string;
  event: EventOdds;
  onClose: () => void;
}) {
  const [oddsView, setOddsView] = useState<Market>("ml");
  const [historyView, setHistoryView] = useState<HistoryMode>("odds");
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [histLoading, setHistLoading] = useState(false);

  const away = event.away;
  const home = event.home;

  useEffect(() => {
    // Load modal history (optional, but premium).
    // If your table differs, adjust loadHistory() below.
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.eventId]);

  async function loadHistory() {
    setHistLoading(true);

    const { data, error } = await supabase
      .from("odds_snapshot_history")
      .select("ts, bookmaker, market, side, line, odds")
      .eq("sport_key", sportKey)
      .eq("event_id", event.eventId)
      .order("ts", { ascending: true })
      .limit(400);

    if (error) {
      console.warn("odds_snapshot_history load failed (ok if not used):", error);
      setHistory([]);
      setHistLoading(false);
      return;
    }

    setHistory((data ?? []) as any);
    setHistLoading(false);
  }

  // Build chart series per bookmaker for the selected view.
  const chartData = useMemo(() => {
    if (!history.length) return [];

    // Filter by market
    const marketKey = oddsView; // expects "ml" | "spread" | "total"
    const rows = history.filter((r) => (r.market ?? "").toLowerCase().includes(marketKey));

    // For ML: use odds values (side: AWAY/HOME)
    // For Spread/Total:
    //  - Odds History: y = odds
    //  - Line Movement: y = line
    const grouped = new Map<string, any[]>(); // book -> points

    for (const r of rows) {
      const book = normalizeBook(r.bookmaker);
      if (!book) continue;

      const ts = r.ts;
      const y = historyView === "movement" ? r.line : r.odds;
      if (y === null || y === undefined) continue;

      if (!grouped.has(book)) grouped.set(book, []);
      grouped.get(book)!.push({ ts, y });
    }

    // Normalize timestamps into merged records { timeLabel, dk, fd, ... }
    const allTs = Array.from(new Set([].concat(...Array.from(grouped.values()).map((pts) => pts.map((p) => p.ts))))).sort();
    const merged: any[] = [];

    for (const ts of allTs) {
      const rec: any = { ts, label: fmtCT(ts) };
      for (const [book, pts] of grouped.entries()) {
        const hit = pts.find((p) => p.ts === ts);
        rec[book] = hit ? hit.y : null;
      }
      merged.push(rec);
    }

    return merged;
  }, [history, oddsView, historyView]);

  // Modal odds strip uses the current event wide snapshot
  const oddsStrip = useMemo(() => {
    return BOOKS.map((bk) => {
      const text = getBookCellText(event, oddsView, bk);
      return { bk, text };
    });
  }, [event, oddsView]);

  return (
    <div
      className="fixed inset-0 z-[999] flex items-center justify-center"
      style={{
        background: "rgba(0,0,0,0.72)",
        backdropFilter: "blur(6px)",
      }}
    >
      <div
        className="w-[92vw] max-w-6xl rounded-2xl border"
        style={{
          borderColor: BORDER,
          background: `linear-gradient(180deg, rgba(14,14,14,0.92), rgba(0,0,0,0.78))`,
          boxShadow: `0 0 0 1px rgba(255,255,255,0.03) inset, 0 30px 100px rgba(0,0,0,0.75)`,
        }}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between gap-4 px-5 py-4 border-b"
          style={{ borderColor: BORDER }}
        >
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.22em]" style={{ color: MUTED_2 }}>
              Game Details
            </div>

            <div className="mt-1 flex items-center gap-3">
              <TeamChip team={away?.team ?? "Away"} logoUrl={away?.logoUrl ?? null} />
              <span className="text-xs" style={{ color: MUTED_2 }}>
                vs
              </span>
              <TeamChip team={home?.team ?? "Home"} logoUrl={home?.logoUrl ?? null} />
            </div>

            <div className="mt-2 text-sm" style={{ color: MUTED }}>
              {fmtCT(event.commenceTime)} CT • Updated {fmtCT(event.latestUpdatedAt)}
            </div>
          </div>

          <button
            onClick={onClose}
            className="rounded-xl border px-3 py-2 font-extrabold"
            style={{
              borderColor: BORDER,
              background: `linear-gradient(180deg, rgba(255,255,255,0.06), rgba(0,0,0,0.25))`,
            }}
          >
            ✕
          </button>
        </div>

        {/* Controls */}
        <div className="px-5 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-3">
            <ControlSelect
              label="Odds View"
              value={oddsView}
              onChange={(v) => setOddsView(v as Market)}
              options={[
                { value: "ml", label: "Moneyline" },
                { value: "spread", label: "Spread" },
                { value: "total", label: "Total" },
              ]}
            />

            <ControlSelect
              label="History View"
              value={historyView}
              onChange={(v) => setHistoryView(v as HistoryMode)}
              options={[
                { value: "odds", label: "Odds History" },
                { value: "movement", label: "Line Movement" },
              ]}
            />
          </div>

          <div className="flex gap-3">
            <button
              onClick={loadHistory}
              className="rounded-xl px-4 py-3 font-extrabold border"
              style={{
                borderColor: BORDER,
                background: `linear-gradient(180deg, rgba(255,255,255,0.06), rgba(0,0,0,0.20))`,
              }}
            >
              Refresh History
            </button>
          </div>
        </div>

        {/* Current Odds Strip */}
        <div className="px-5 pb-4">
          <div
            className="rounded-2xl border p-4"
            style={{
              borderColor: BORDER,
              background: `linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.20))`,
            }}
          >
            <div className="text-[11px] uppercase tracking-[0.22em]" style={{ color: MUTED_2 }}>
              Current Board — {oddsView.toUpperCase()}
            </div>

            <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2">
              {oddsStrip.map(({ bk, text }) => (
                <div
                  key={bk}
                  className="rounded-xl border px-3 py-3"
                  style={{
                    borderColor: BORDER,
                    background: `linear-gradient(180deg, rgba(255,255,255,0.05), rgba(0,0,0,0.25))`,
                  }}
                >
                  <div className="text-[10px] font-extrabold" style={{ color: BOOK_TEXT[bk] }}>
                    {BOOK_LABEL[bk]}
                  </div>
                  <div className="mt-1 text-sm font-extrabold" style={{ color: "rgba(255,255,255,0.90)" }}>
                    {text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* History Chart */}
        <div className="px-5 pb-6">
          <div
            className="rounded-2xl border p-4"
            style={{
              borderColor: BORDER,
              background: `linear-gradient(180deg, rgba(18,18,18,0.70), rgba(0,0,0,0.55))`,
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.22em]" style={{ color: MUTED_2 }}>
                  {historyView === "odds" ? "Odds History" : "Line Movement"} — {oddsView.toUpperCase()}
                </div>
                <div className="mt-1 text-sm" style={{ color: MUTED }}>
                  {histLoading ? "Loading…" : history.length ? "Showing history across books." : "No history found (or table not used)."}
                </div>
              </div>
              <div className="text-xs font-extrabold" style={{ color: GOLD }}>
                PRISM
              </div>
            </div>

            <div className="mt-4 h-[320px] w-full">
              {chartData.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid stroke="rgba(255,255,255,0.08)" />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: "rgba(255,255,255,0.55)", fontSize: 11 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis tick={{ fill: "rgba(255,255,255,0.55)", fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{
                        background: "rgba(0,0,0,0.90)",
                        border: `1px solid ${BORDER}`,
                        borderRadius: 12,
                        color: "white",
                      }}
                      labelStyle={{ color: GOLD, fontWeight: 800 }}
                    />
                    <Legend wrapperStyle={{ color: "rgba(255,255,255,0.70)" }} />
                    {/* Lines per book (book keys normalized below) */}
                    {/* Use subtle book colors but NO blue backgrounds */}
                    <Line type="monotone" dataKey="draftkings" dot={false} stroke={BOOK_TEXT.dk} strokeWidth={2} />
                    <Line type="monotone" dataKey="fanduel" dot={false} stroke={BOOK_TEXT.fd} strokeWidth={2} />
                    <Line type="monotone" dataKey="betmgm" dot={false} stroke={BOOK_TEXT.mgm} strokeWidth={2} />
                    <Line type="monotone" dataKey="pinnacle" dot={false} stroke={BOOK_TEXT.pin} strokeWidth={2} />
                    <Line type="monotone" dataKey="betonlineag" dot={false} stroke={BOOK_TEXT.bol} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-sm" style={{ color: MUTED_2 }}>
                  {histLoading ? "Loading…" : "No chart data for this selection."}
                </div>
              )}
            </div>

            <div className="mt-3 text-[11px]" style={{ color: MUTED_2 }}>
              Tip: History dropdowns are independent — you can view ML board while charting spread movement.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =============================================================================
   SMALL COMPONENTS
============================================================================= */

function TeamChip({ team, logoUrl }: { team: string; logoUrl: string | null }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div
        className="h-7 w-7 rounded-lg border overflow-hidden flex items-center justify-center"
        style={{
          borderColor: BORDER,
          background: "rgba(255,255,255,0.04)",
        }}
      >
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={team} className="h-6 w-6 object-contain" />
        ) : (
          <span className="text-[10px] font-extrabold" style={{ color: GOLD }}>
            PR
          </span>
        )}
      </div>
      <div className="font-extrabold truncate">{team}</div>
    </div>
  );
}

function ControlSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div
      className="rounded-2xl border px-3 py-2"
      style={{ borderColor: BORDER, background: PANEL_2 }}
    >
      <div className="text-[10px] uppercase tracking-[0.22em]" style={{ color: MUTED_2 }}>
        {label}
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent outline-none font-extrabold text-sm pr-2"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/* =============================================================================
   BOOK NORMALIZATION (history table → chart keys)
============================================================================= */

function normalizeBook(bookmaker: string | null | undefined) {
  if (!bookmaker) return null;
  const b = bookmaker.toLowerCase();
  if (b.includes("draftkings")) return "draftkings";
  if (b.includes("fanduel")) return "fanduel";
  if (b.includes("betmgm")) return "betmgm";
  if (b.includes("pinnacle")) return "pinnacle";
  if (b.includes("betonline")) return "betonlineag";
  // Some pipelines store short keys
  if (b === "dk") return "draftkings";
  if (b === "fd") return "fanduel";
  if (b === "mgm") return "betmgm";
  if (b === "pin") return "pinnacle";
  if (b === "bol") return "betonlineag";
  return null;
}

