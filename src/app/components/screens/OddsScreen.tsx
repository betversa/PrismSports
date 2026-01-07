"use client";

import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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

/* =========================================================
   TYPES / CONSTANTS
========================================================= */

type Market = "ml" | "spread" | "total";
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

const CT_TZ = "America/Chicago";

const BOOKS: BookKey[] = ["dk", "fd", "mgm", "pin", "bol"];

const BOOK_LABEL: Record<BookKey, string> = {
  dk: "DraftKings",
  fd: "FanDuel",
  mgm: "BetMGM",
  pin: "Pinnacle",
  bol: "BetOnline",
};

const BOOK_STROKES: Record<BookKey, string> = {
  dk: "#16a34a",
  fd: "#2563eb",
  mgm: "#d4af37",
  pin: "#f97316",
  bol: "#ef4444",
};

const BOOK_LOGOS: Record<BookKey, string> = {
  dk: "/books/dk.png",
  fd: "/books/fd.png",
  mgm: "/books/mgm.png",
  pin: "/books/pin.png",
  bol: "/books/bol.png",
};

const COL_MATCHUP = 420;
const COL_CONSENSUS = 180;
const COL_BOOK = 120;

/* =========================================================
   TIME HELPERS
========================================================= */

function normalizeIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(" ", "T");
  if (/[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return `${s}Z`;
  return s;
}

function fmtCTTimeOnly(iso: string | null | undefined) {
  if (!iso) return "—";
  const n = normalizeIso(iso);
  if (!n) return "—";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function ctYmdFromIso(iso: string | null | undefined) {
  const n = normalizeIso(iso);
  if (!n) return "";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${day}`;
}

/* =========================================================
   FLEX PICKERS
========================================================= */

function pickAny(row: any, keys: string[]) {
  for (const k of keys) if (row?.[k] != null) return row[k];
  return null;
}

function pickOdds(row: any): number | null {
  const raw = pickAny(row, ["odds", "price", "american_odds"]);
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function pickLine(row: any): number | null {
  const raw = pickAny(row, ["line", "points", "total"]);
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function bookKeyFromRaw(s: string | null): BookKey | null {
  if (!s) return null;
  const v = s.toLowerCase();
  if (v.includes("draftkings") || v === "dk") return "dk";
  if (v.includes("fanduel") || v === "fd") return "fd";
  if (v.includes("betmgm") || v === "mgm") return "mgm";
  if (v.includes("pinnacle") || v === "pin") return "pin";
  if (v.includes("betonline") || v === "bol") return "bol";
  return null;
}

/* =========================================================
   WIDE ROW → SIDE ODDS
========================================================= */

function mapWideRowToSideOdds(row: any): SideOdds {
  return {
    side: row.side,
    team: row.team ?? row.side,
    logoUrl: row.logo_url ?? null,
    updatedAt: row.updated_at ?? row.ts ?? null,

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
      mgm: { line: row.mgm_total_line ?? null, over: row.mgm_total_over_odds ?? null, under: row.mgm_total_under_odds ?? null },
      pin: { line: row.pin_total_line ?? null, over: row.pin_total_over_odds ?? null, under: row.pin_total_under_odds ?? null },
      bol: { line: row.bol_total_line ?? null, over: row.bol_total_over_odds ?? null, under: row.bol_total_under_odds ?? null },
    },
  };
}
"use client";

import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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

/* =========================================================
   TYPES / CONSTANTS
========================================================= */

type Market = "ml" | "spread" | "total";
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

const CT_TZ = "America/Chicago";

const BOOKS: BookKey[] = ["dk", "fd", "mgm", "pin", "bol"];

const BOOK_LABEL: Record<BookKey, string> = {
  dk: "DraftKings",
  fd: "FanDuel",
  mgm: "BetMGM",
  pin: "Pinnacle",
  bol: "BetOnline",
};

const BOOK_STROKES: Record<BookKey, string> = {
  dk: "#16a34a",
  fd: "#2563eb",
  mgm: "#d4af37",
  pin: "#f97316",
  bol: "#ef4444",
};

const BOOK_LOGOS: Record<BookKey, string> = {
  dk: "/books/dk.png",
  fd: "/books/fd.png",
  mgm: "/books/mgm.png",
  pin: "/books/pin.png",
  bol: "/books/bol.png",
};

const COL_MATCHUP = 420;
const COL_CONSENSUS = 180;
const COL_BOOK = 120;

/* =========================================================
   TIME HELPERS
========================================================= */

function normalizeIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(" ", "T");
  if (/[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return `${s}Z`;
  return s;
}

function fmtCTTimeOnly(iso: string | null | undefined) {
  if (!iso) return "—";
  const n = normalizeIso(iso);
  if (!n) return "—";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function ctYmdFromIso(iso: string | null | undefined) {
  const n = normalizeIso(iso);
  if (!n) return "";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${day}`;
}

/* =========================================================
   FLEX PICKERS
========================================================= */

function pickAny(row: any, keys: string[]) {
  for (const k of keys) if (row?.[k] != null) return row[k];
  return null;
}

function pickOdds(row: any): number | null {
  const raw = pickAny(row, ["odds", "price", "american_odds"]);
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function pickLine(row: any): number | null {
  const raw = pickAny(row, ["line", "points", "total"]);
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function bookKeyFromRaw(s: string | null): BookKey | null {
  if (!s) return null;
  const v = s.toLowerCase();
  if (v.includes("draftkings") || v === "dk") return "dk";
  if (v.includes("fanduel") || v === "fd") return "fd";
  if (v.includes("betmgm") || v === "mgm") return "mgm";
  if (v.includes("pinnacle") || v === "pin") return "pin";
  if (v.includes("betonline") || v === "bol") return "bol";
  return null;
}

/* =========================================================
   WIDE ROW → SIDE ODDS
========================================================= */

function mapWideRowToSideOdds(row: any): SideOdds {
  return {
    side: row.side,
    team: row.team ?? row.side,
    logoUrl: row.logo_url ?? null,
    updatedAt: row.updated_at ?? row.ts ?? null,

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
      mgm: { line: row.mgm_total_line ?? null, over: row.mgm_total_over_odds ?? null, under: row.mgm_total_under_odds ?? null },
      pin: { line: row.pin_total_line ?? null, over: row.pin_total_over_odds ?? null, under: row.pin_total_under_odds ?? null },
      bol: { line: row.bol_total_line ?? null, over: row.bol_total_over_odds ?? null, under: row.bol_total_under_odds ?? null },
    },
  };
}
/* =========================================================
   CONSENSUS HELPERS
========================================================= */

function median(nums: number[]) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

type CellParts = { top: string; bottom?: string };

function cellMl(odds: number | null): CellParts {
  return { top: odds == null ? "—" : String(odds) };
}

function cellLineOdds(line: number | null, odds: number | null): CellParts {
  if (line == null) return { top: "—" };
  return { top: String(line), bottom: odds == null ? "—" : `(${odds})` };
}

function consensusPartsForRow(
  ev: EventOdds,
  market: Market,
  side: "AWAY" | "HOME"
): CellParts {
  const src = side === "AWAY" ? ev.away : ev.home;

  if (market === "ml") {
    const odds: number[] = [];
    if (src) for (const b of BOOKS) if (typeof src.ml[b] === "number") odds.push(src.ml[b]!);
    return cellMl(median(odds));
  }

  if (market === "spread") {
    const lines: number[] = [];
    const odds: number[] = [];
    if (src) {
      for (const b of BOOKS) {
        if (typeof src.spread[b]?.line === "number") lines.push(src.spread[b]!.line!);
        if (typeof src.spread[b]?.odds === "number") odds.push(src.spread[b]!.odds!);
      }
    }
    return cellLineOdds(median(lines), median(odds));
  }

  const lines: number[] = [];
  const overOdds: number[] = [];
  const underOdds: number[] = [];

  if (ev.away) {
    for (const b of BOOKS) {
      if (typeof ev.away.total[b]?.line === "number") lines.push(ev.away.total[b]!.line!);
      if (typeof ev.away.total[b]?.over === "number") overOdds.push(ev.away.total[b]!.over!);
    }
  }
  if (ev.home) {
    for (const b of BOOKS) {
      if (typeof ev.home.total[b]?.under === "number") underOdds.push(ev.home.total[b]!.under!);
    }
  }

  return side === "AWAY"
    ? cellLineOdds(median(lines), median(overOdds))
    : cellLineOdds(median(lines), median(underOdds));
}

function partsForBookSide(
  ev: EventOdds,
  market: Market,
  side: "AWAY" | "HOME",
  book: BookKey
): CellParts {
  const src = side === "AWAY" ? ev.away : ev.home;
  if (!src) return { top: "—" };

  if (market === "ml") return { top: src.ml[book] == null ? "—" : String(src.ml[book]) };

  if (market === "spread") {
    const c = src.spread[book];
    if (c?.line == null) return { top: "—" };
    return { top: String(c.line), bottom: c.odds == null ? "—" : `(${c.odds})` };
  }

  const t = src.total[book];
  const odds = side === "AWAY" ? t?.over ?? null : t?.under ?? null;
  if (t?.line == null) return { top: "—" };
  return { top: String(t.line), bottom: odds == null ? "—" : `(${odds})` };
}

/* =========================================================
   BOARD CELLS
========================================================= */

function ConsensusValue({ parts }: { parts: CellParts }) {
  return (
    <td className="px-2 py-3 text-center text-white font-extrabold tabular-nums border-r border-[#232323]">
      <div>{parts.top}</div>
      {parts.bottom && <div className="text-white/80">{parts.bottom}</div>}
    </td>
  );
}

function BookValue({ parts, borderLeft }: { parts: CellParts; borderLeft?: boolean }) {
  return (
    <td
      className={[
        "px-2 py-3 text-center text-white font-extrabold tabular-nums",
        borderLeft ? "border-l border-[#232323]" : "",
      ].join(" ")}
    >
      <div>{parts.top}</div>
      {parts.bottom && <div className="text-white/80">{parts.bottom}</div>}
    </td>
  );
}

/* =========================================================
   DESKTOP EVENT ROWS
========================================================= */

function EventTwoRows({
  ev,
  market,
  onOpenDetails,
}: {
  ev: EventOdds;
  market: Market;
  onOpenDetails: (ev: EventOdds) => void;
}) {
  return (
    <>
      <tr className="hover:bg-white/5">
        <td
          rowSpan={2}
          className="sticky left-0 z-10 bg-[#0f0f0f] p-4 border-r border-[#232323]"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs text-[#cfcfcf] font-semibold">
              {fmtCTTimeOnly(ev.commenceTime)} CT
            </div>
            <button
              type="button"
              onClick={() => onOpenDetails(ev)}
              className="px-3 py-1.5 text-xs font-extrabold rounded-lg bg-[#d4af37] text-black"
            >
              Game Details
            </button>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-3">
              {ev.away?.logoUrl && (
                <img
                  src={ev.away.logoUrl}
                  className="w-10 h-10 bg-white rounded-md p-1"
                />
              )}
              <div className="text-white font-extrabold">
                {ev.away?.team ?? "Away"}
              </div>
            </div>

            <div className="flex items-center gap-3">
              {ev.home?.logoUrl && (
                <img
                  src={ev.home.logoUrl}
                  className="w-10 h-10 bg-white rounded-md p-1"
                />
              )}
              <div className="text-white font-extrabold">
                {ev.home?.team ?? "Home"}
              </div>
            </div>
          </div>
        </td>

        <ConsensusValue parts={consensusPartsForRow(ev, market, "AWAY")} />
        {BOOKS.map((b, i) => (
          <BookValue
            key={`a-${b}`}
            parts={partsForBookSide(ev, market, "AWAY", b)}
            borderLeft={i === 0}
          />
        ))}
      </tr>

      <tr className="hover:bg-white/5 border-b border-[#232323]">
        <ConsensusValue parts={consensusPartsForRow(ev, market, "HOME")} />
        {BOOKS.map((b, i) => (
          <BookValue
            key={`h-${b}`}
            parts={partsForBookSide(ev, market, "HOME", b)}
            borderLeft={i === 0}
          />
        ))}
      </tr>

      <tr>
        <td colSpan={7} className="h-2" />
      </tr>
    </>
  );
}

/* =========================================================
   MOBILE EVENT CARD
========================================================= */

function EventCardMobile({
  ev,
  market,
  booksOpen,
  onToggleBooks,
  onOpenDetails,
}: {
  ev: EventOdds;
  market: Market;
  booksOpen: boolean;
  onToggleBooks: () => void;
  onOpenDetails: (ev: EventOdds) => void;
}) {
  return (
    <div className="rounded-2xl border border-[#2a2a2a] bg-black/20 overflow-hidden">
      <div className="px-3 py-2 border-b border-[#2a2a2a] flex justify-between">
        <div className="text-xs text-[#cfcfcf]">
          {fmtCTTimeOnly(ev.commenceTime)} CT
        </div>
        <button
          type="button"
          onClick={() => onOpenDetails(ev)}
          className="px-2 py-1 text-xs font-extrabold rounded bg-[#d4af37] text-black"
        >
          Game Details
        </button>
      </div>

      <div className="p-3 space-y-2">
        <div className="text-white font-extrabold">
          {ev.away?.team ?? "Away"}
        </div>
        <div className="text-white font-extrabold">
          {ev.home?.team ?? "Home"}
        </div>
      </div>

      <div className="px-3 pb-3">
        <button
          onClick={onToggleBooks}
          className="text-xs text-[#d4af37] font-extrabold"
        >
          {booksOpen ? "Hide Books" : "Show Books"}
        </button>

        {booksOpen && (
          <div className="mt-2 space-y-2">
            {BOOKS.map((b) => (
              <div
                key={b}
                className="flex justify-between text-white text-xs"
              >
                <div>{BOOK_LABEL[b]}</div>
                <div>
                  {partsForBookSide(ev, market, "AWAY", b).top} /{" "}
                  {partsForBookSide(ev, market, "HOME", b).top}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* =========================================================
   MODAL SHELL
========================================================= */

function ModalShell({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[999] bg-black/70 flex items-center justify-center p-3">
      <div className="w-full max-w-6xl bg-[#0b0b0b] border border-[#2a2a2a] rounded-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="px-4 py-3 border-b border-[#2a2a2a] flex justify-between">
          <div>
            <div className="text-white font-extrabold">{title}</div>
            {subtitle && <div className="text-xs text-[#a0a0a0]">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="text-white font-bold">
            ✕
          </button>
        </div>

        <div className="overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
/* =========================================================
   MAIN SCREEN
========================================================= */

export default function OddsScreen() {
  const [events, setEvents] = useState<EventOdds[]>([]);
  const [loading, setLoading] = useState(false);

  const [market, setMarket] = useState<Market>("ml");
  const [selected, setSelected] = useState<EventOdds | null>(null);

  const [mobileOpen, setMobileOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from("odds_wide_latest")
          .select("*")
          .order("commence_time", { ascending: true });

        if (error) throw error;
        if (!alive) return;

        const map = new Map<string, EventOdds>();

        for (const row of data as any[]) {
          const id = row.event_id;
          if (!map.has(id)) {
            map.set(id, {
              eventId: id,
              sportKey: row.sport_key ?? null,
              commenceTime: row.commence_time,
              latestUpdatedAt: row.updated_at ?? row.ts ?? null,
            });
          }

          const ev = map.get(id)!;
          const side = mapWideRowToSideOdds(row);

          if (side.side === "AWAY") ev.away = side;
          if (side.side === "HOME") ev.home = side;

          if (side.updatedAt) {
            if (!ev.latestUpdatedAt || side.updatedAt > ev.latestUpdatedAt) {
              ev.latestUpdatedAt = side.updatedAt;
            }
          }
        }

        setEvents(Array.from(map.values()));
      } catch (e) {
        console.error(e);
        setEvents([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  const grouped = useMemo(() => {
    const g = new Map<string, EventOdds[]>();
    for (const ev of events) {
      const key = ctYmdFromIso(ev.commenceTime);
      if (!g.has(key)) g.set(key, []);
      g.get(key)!.push(ev);
    }
    return Array.from(g.entries());
  }, [events]);

  return (
    <div className="min-h-screen bg-black text-white">
      {/* HEADER */}
      <div className="sticky top-0 z-30 bg-black border-b border-[#232323]">
        <div className="max-w-[1600px] mx-auto px-4 py-4 flex flex-wrap items-center gap-3">
          <div className="text-xl font-extrabold tracking-tight">
            Odds Board
            <span className="ml-2 text-sm text-[#d4af37] font-bold">
              Pittsburgh Theme
            </span>
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={() => setMarket("ml")}
              className={[
                "px-3 py-1.5 rounded-full text-xs font-extrabold border",
                market === "ml"
                  ? "bg-[#d4af37] text-black border-[#d4af37]"
                  : "border-[#2a2a2a] hover:bg-white/5",
              ].join(" ")}
            >
              Moneyline
            </button>
            <button
              onClick={() => setMarket("spread")}
              className={[
                "px-3 py-1.5 rounded-full text-xs font-extrabold border",
                market === "spread"
                  ? "bg-[#d4af37] text-black border-[#d4af37]"
                  : "border-[#2a2a2a] hover:bg-white/5",
              ].join(" ")}
            >
              Spread
            </button>
            <button
              onClick={() => setMarket("total")}
              className={[
                "px-3 py-1.5 rounded-full text-xs font-extrabold border",
                market === "total"
                  ? "bg-[#d4af37] text-black border-[#d4af37]"
                  : "border-[#2a2a2a] hover:bg-white/5",
              ].join(" ")}
            >
              Total
            </button>
          </div>
        </div>
      </div>

      {/* BOARD */}
      <div className="max-w-[1600px] mx-auto px-4 py-4">
        {loading && (
          <div className="text-sm text-[#cfcfcf] font-semibold mb-4">
            Loading odds…
          </div>
        )}

        <div className="hidden md:block">
          <table className="w-full border-collapse">
            <thead className="sticky top-[72px] z-20 bg-[#0f0f0f] border-b border-[#232323]">
              <tr>
                <th
                  className="text-left px-4 py-3 text-xs font-semibold text-[#a0a0a0]"
                  style={{ width: COL_MATCHUP }}
                >
                  Matchup
                </th>
                <th
                  className="text-center px-2 py-3 text-xs font-semibold text-[#a0a0a0]"
                  style={{ width: COL_CONSENSUS }}
                >
                  Consensus
                </th>
                {BOOKS.map((b) => (
                  <th
                    key={b}
                    className="text-center px-2 py-3 text-xs font-semibold"
                    style={{ width: COL_BOOK, color: BOOK_STROKES[b] }}
                  >
                    <div className="flex items-center justify-center gap-2">
                      <img
                        src={BOOK_LOGOS[b]}
                        className="h-4 w-auto"
                        alt={BOOK_LABEL[b]}
                      />
                      <span>{BOOK_LABEL[b]}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {grouped.map(([date, list]) => (
                <React.Fragment key={date}>
                  <tr>
                    <td
                      colSpan={2 + BOOKS.length}
                      className="px-4 py-2 text-xs font-extrabold text-[#d4af37] bg-[#0b0b0b]"
                    >
                      {date}
                    </td>
                  </tr>

                  {list.map((ev) => (
                    <EventTwoRows
                      key={ev.eventId}
                      ev={ev}
                      market={market}
                      onOpenDetails={setSelected}
                    />
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {/* MOBILE */}
        <div className="md:hidden space-y-3">
          {events.map((ev) => {
            const open = !!mobileOpen[ev.eventId];
            return (
              <EventCardMobile
                key={ev.eventId}
                ev={ev}
                market={market}
                booksOpen={open}
                onToggleBooks={() =>
                  setMobileOpen((m) => ({
                    ...m,
                    [ev.eventId]: !m[ev.eventId],
                  }))
                }
                onOpenDetails={setSelected}
              />
            );
          })}
        </div>
      </div>

      {/* MODAL */}
      {selected && (
        <DetailsModal
          ev={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

