// screens/OddsScreen.tsx — FULL REWRITE (Hero matches Model + Monte Carlo exactly)
// -------------------------------------------------------------------------------------------------
// ✅ Hero section uses SAME structure/spacing as Model + MonteCarlo screens
// ✅ Desktop: centered max-width “web” layout
// ✅ Desktop: books ALWAYS shown (no toggle)
// ✅ Mobile: Show/Hide Books toggle + More menu (History / Props)
// ✅ History modal: ML / Spread / Total ODDS movement charts (date+time CT in tooltip)
// ✅ Props modal: odds from player_props_snapshot + meta (pos/pic) from player_prop_ev_latest
// ✅ player_props_snapshot has NO created_at (uses ts / snapshot_ts / inserted_at)
// ✅ History table ordering is schema-safe (no `.order("ts")` on unknown columns)

import React, { useEffect, useMemo, useRef, useState } from "react";
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

// DK green, FD blue, MGM gold, PIN orange, BOL red.
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

const PAGE_MAX_W = "max-w-[1320px]";
const PAGE_X = "px-4 md:px-8";

/** HERO + PANEL styles — intended to match Model/MonteCarlo hero exactly */
const HERO_WRAP =
  "rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden shadow-[0_16px_60px_rgba(0,0,0,0.38)]";
const HERO_INNER = "p-5 md:p-6";
const HERO_SUB = "text-sm text-[#8a8a8a] mt-2";

const CHIP =
  "inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-black/25 px-3 py-1.5";
const CHIP_L = "text-[10px] font-bold text-[#808080]";
const CHIP_V = "text-[11px] font-extrabold text-white tabular-nums";

const PILL =
  "inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-black/35 px-3 py-1";
const PILL_DOT = "inline-block w-2 h-2 rounded-full bg-[#d4af37]";
const PILL_TX = "text-[11px] font-extrabold text-[#d0d0d0]";

const LIVE_BADGE =
  "inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-black/35 px-3 py-1";
const LIVE_TX = "text-[11px] font-extrabold text-[#d0d0d0]";
const LIVE_DOT = "inline-block w-2 h-2 rounded-full bg-emerald-500";

const PANEL_INNER = "border border-[#2a2a2a] bg-black/20 rounded-xl overflow-hidden";

const BTN_BASE =
  "px-3 py-1.5 rounded-lg text-xs font-extrabold border transition-colors whitespace-nowrap";
const BTN_ON = "bg-[#d4af37] text-black border-[#d4af37]";
const BTN_OFF =
  "bg-black/20 text-[#d0d0d0] border-[#2a2a2a] hover:border-[#3a3a3a]";
const BTN_GHOST =
  "text-[11px] font-extrabold text-white/90 hover:text-white px-2.5 py-1 rounded-md border border-[#2a2a2a] hover:border-[#3a3a3a]";
const LINK_GOLD = "text-[11px] font-extrabold text-[#d4af37] hover:underline";

const HDR_LEFT_BG = "bg-[#0b0b0b]";
const HDR_BOOK_BG = "bg-[#1c1c1c]";
const HDR_TEXT = "text-[#d0d0d0]";
const HDR_BORDER = "border-[#232323]";

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

function fmtCTDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const n = normalizeIso(iso);
  if (!n) return "—";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function fmtCTDateTimeLong(iso: string | null | undefined) {
  if (!iso) return "—";
  const n = normalizeIso(iso);
  if (!n) return "—";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    weekday: "short",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
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

function ctTodayYmd() {
  return ctYmdFromIso(new Date().toISOString());
}

function fmtDateBtn(ymd: string) {
  const d = new Date(`${ymd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function maxIso(a: string | null, b: string | null) {
  if (!a) return b;
  if (!b) return a;
  const an = normalizeIso(a);
  const bn = normalizeIso(b);
  if (!an) return b;
  if (!bn) return a;
  return new Date(an).getTime() >= new Date(bn).getTime() ? a : b;
}

/* =========================================================
   FLEX COLUMN PICKERS (history tables vary)
========================================================= */

function pickAny(row: any, keys: string[]) {
  for (const k of keys) if (row?.[k] != null) return row[k];
  return null;
}

function pickTs(row: any): string | null {
  return normalizeIso(
    pickAny(row, ["ts", "timestamp", "snapshot_ts", "inserted_at", "created_at", "time", "date"])
  );
}

function pickOdds(row: any): number | null {
  const raw = pickAny(row, ["odds", "price", "american_odds", "odds_american", "book_odds"]);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function pickLine(row: any): number | null {
  const raw = pickAny(row, ["line", "points", "point", "total", "spread_line", "total_line"]);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function pickBook(row: any): string | null {
  const raw = pickAny(row, ["bookmaker", "book", "sportsbook", "provider", "site"]);
  return raw ? String(raw).toLowerCase() : null;
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

function pickSide(row: any): string | null {
  const raw = pickAny(row, ["side", "team_side", "home_away", "bet_side"]);
  return raw ? String(raw).toLowerCase() : null;
}

function pickOU(row: any): string | null {
  const raw = pickAny(row, ["over_under", "ou", "side_ou", "total_side"]);
  return raw ? String(raw).toLowerCase() : null;
}

/* =========================================================
   MAPPING HELPERS (odds wide)
========================================================= */

function pickLogoUrl(row: any): string | null {
  return row.logo_url ?? row.team_logo_url ?? row.logo ?? row.logoUrl ?? null;
}

function pickUpdatedAt(row: any): string | null {
  return (
    row.updated_at ??
    row.last_update ??
    row.last_updated ??
    row.updatedAt ??
    row.last_updated_ct ??
    row.ts ??
    row.snapshot_ts ??
    row.inserted_at ??
    row.created_at ??
    null
  );
}

function mapWideRowToSideOdds(row: any): SideOdds {
  return {
    side: row.side,
    team: row.team ?? row.side,
    logoUrl: pickLogoUrl(row),
    updatedAt: pickUpdatedAt(row),

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
      dk: {
        line: row.dk_total_line ?? null,
        over: row.dk_total_over_odds ?? null,
        under: row.dk_total_under_odds ?? null,
      },
      fd: {
        line: row.fd_total_line ?? null,
        over: row.fd_total_over_odds ?? null,
        under: row.fd_total_under_odds ?? null,
      },
      mgm: {
        line: row.mgm_total_line ?? null,
        over: row.mgm_total_over_odds ?? null,
        under: row.mgm_total_under_odds ?? null,
      },
      pin: {
        line: row.pin_total_line ?? null,
        over: row.pin_total_over_odds ?? null,
        under: row.pin_total_under_odds ?? null,
      },
      bol: {
        line: row.bol_total_line ?? null,
        over: row.bol_total_over_odds ?? null,
        under: row.bol_total_under_odds ?? null,
      },
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

function renderCellParts(parts: CellParts) {
  return (
    <div className="flex flex-col items-center justify-center leading-tight">
      <div className="tabular-nums">{parts.top}</div>
      {parts.bottom != null ? (
        <div className="tabular-nums opacity-95">{parts.bottom}</div>
      ) : null}
    </div>
  );
}

function consensusPartsForRow(ev: EventOdds, market: Market, side: "AWAY" | "HOME"): CellParts {
  const src = side === "AWAY" ? ev.away : ev.home;

  if (market === "ml") {
    const odds: number[] = [];
    if (src) for (const b of BOOKS) if (typeof src.ml[b] === "number") odds.push(src.ml[b] as number);
    const mOdds = median(odds);
    return cellMl(mOdds == null ? null : mOdds);
  }

  if (market === "spread") {
    const lines: number[] = [];
    const odds: number[] = [];
    if (src) {
      for (const b of BOOKS) {
        const l = src.spread[b]?.line;
        const o = src.spread[b]?.odds;
        if (typeof l === "number") lines.push(l);
        if (typeof o === "number") odds.push(o);
      }
    }
    const mLine = median(lines);
    const mOdds = median(odds);
    return cellLineOdds(mLine == null ? null : mLine, mOdds == null ? null : mOdds);
  }

  // total: AWAY treated as Over, HOME treated as Under
  const lines: number[] = [];
  const overOdds: number[] = [];
  const underOdds: number[] = [];

  if (ev.away) {
    for (const b of BOOKS) {
      const l = ev.away.total[b]?.line;
      const o = ev.away.total[b]?.over;
      if (typeof l === "number") lines.push(l);
      if (typeof o === "number") overOdds.push(o);
    }
  }
  if (ev.home) {
    for (const b of BOOKS) {
      const u = ev.home.total[b]?.under;
      if (typeof u === "number") underOdds.push(u);
    }
  }

  const mLine = median(lines);
  const mOver = median(overOdds);
  const mUnder = median(underOdds);

  if (side === "AWAY") return cellLineOdds(mLine == null ? null : mLine, mOver == null ? null : mOver);
  return cellLineOdds(mLine == null ? null : mLine, mUnder == null ? null : mUnder);
}

function partsForBookSide(ev: EventOdds, market: Market, side: "AWAY" | "HOME", book: BookKey): CellParts {
  const src = side === "AWAY" ? ev.away : ev.home;
  if (!src) return { top: "—" };

  if (market === "ml") return { top: src.ml[book] == null ? "—" : String(src.ml[book]) };

  if (market === "spread") {
    const c = src.spread[book];
    if (c?.line == null) return { top: "—" };
    return { top: String(c.line), bottom: c?.odds == null ? "—" : `(${c.odds})` };
  }

  // total: AWAY is Over, HOME is Under
  const t = src.total[book];
  const odds = side === "AWAY" ? t?.over ?? null : t?.under ?? null;
  if (t?.line == null) return { top: "—" };
  return { top: String(t.line), bottom: odds == null ? "—" : `(${odds})` };
}

/* =========================================================
   BOOK HEADER PILL (white pill like your screenshots)
========================================================= */

const BOOK_LOGO_W = 86;
const BOOK_LOGO_H = 22;

function headerFallbackPillDataUri(label: string) {
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="${BOOK_LOGO_W}" height="${BOOK_LOGO_H}">
    <rect x="0" y="0" width="${BOOK_LOGO_W}" height="${BOOK_LOGO_H}" rx="13" ry="13" fill="#FFFFFF"/>
    <rect x="0.5" y="0.5" width="${BOOK_LOGO_W - 1}" height="${BOOK_LOGO_H - 1}" rx="13" ry="13" fill="none" stroke="#E5E5E5"/>
    <text x="${BOOK_LOGO_W / 2}" y="${Math.floor(BOOK_LOGO_H * 0.70)}"
      font-family="Arial, sans-serif" font-size="12" font-weight="700"
      text-anchor="middle" fill="#111111">${label}</text>
  </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg.trim())}`;
}

function BookLogoPill({
  src,
  alt,
  fallbackLabel,
  size = "md",
}: {
  src: string;
  alt: string;
  fallbackLabel: string;
  size?: "sm" | "md";
}) {
  const pillH = size === "sm" ? "h-7" : "h-8";
  const imgH = size === "sm" ? "h-4" : "h-5";
  const pillW = size === "sm" ? "w-[90px]" : "w-[92px]";

  return (
    <div
      className={`${pillH} ${pillW} rounded-full bg-white/95 border border-[#e5e5e5] px-3 flex items-center justify-center`}
      title={alt}
    >
      <img
        src={src}
        alt={alt}
        className={`${imgH} w-auto object-contain`}
        loading="lazy"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).src = headerFallbackPillDataUri(fallbackLabel);
        }}
      />
    </div>
  );
}

function BookHeader({ bookKey, borderLeft }: { bookKey: BookKey; borderLeft?: boolean }) {
  const fb =
    bookKey === "dk"
      ? "DK"
      : bookKey === "fd"
      ? "FD"
      : bookKey === "mgm"
      ? "MGM"
      : bookKey === "pin"
      ? "PIN"
      : "BOL";
  return (
    <th
      className={[
        "text-center px-2 py-3",
        HDR_BOOK_BG,
        "border-b",
        HDR_BORDER,
        borderLeft ? `border-l ${HDR_BORDER}` : "",
      ].join(" ")}
      style={{ width: COL_BOOK }}
    >
      <div className="flex items-center justify-center">
        <BookLogoPill
          src={BOOK_LOGOS[bookKey]}
          alt={BOOK_LABEL[bookKey]}
          fallbackLabel={fb}
          size="md"
        />
      </div>
    </th>
  );
}

function ConsensusValue({ parts }: { parts: CellParts }) {
  return (
    <td
      className={[
        "px-2 py-3 text-white text-center tabular-nums font-extrabold text-[13px]",
        `border-r ${HDR_BORDER}`,
      ].join(" ")}
    >
      {renderCellParts(parts)}
    </td>
  );
}

function BookValue({ parts, borderLeft }: { parts: CellParts; borderLeft?: boolean }) {
  return (
    <td
      className={[
        "px-2 py-3 text-white text-center tabular-nums font-extrabold text-[13px]",
        borderLeft ? `border-l ${HDR_BORDER}` : "",
      ].join(" ")}
    >
      {renderCellParts(parts)}
    </td>
  );
}

function MiniTeamRow({
  team,
  logoUrl,
  side,
}: {
  team: string;
  logoUrl: string | null;
  side: "AWAY" | "HOME";
}) {
  return (
    <div className="flex items-center gap-3">
      {logoUrl ? (
        <img
          src={logoUrl}
          alt={`${team} logo`}
          className="w-11 h-11 rounded-md object-contain bg-white border border-[#e5e5e5] p-1"
          loading="lazy"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <div className="w-11 h-11 rounded-md bg-white border border-[#e5e5e5]" />
      )}

      <div className="leading-tight min-w-0">
        <div className="text-white font-extrabold text-[15px] truncate">{team}</div>
        <div className="text-[11px] text-[#7a7a7a] font-semibold">{side}</div>
      </div>
    </div>
  );
}

/* =========================================================
   SEGMENTED MARKET CONTROL
========================================================= */

function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "px-3 py-1.5 text-xs font-extrabold transition-colors",
        "border border-[#2a2a2a]",
        active
          ? "bg-[#d4af37] text-black border-[#d4af37]"
          : "bg-[#0f0f0f] text-[#d0d0d0] hover:border-[#3a3a3a]",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function Segmented({ value, onChange }: { value: Market; onChange: (v: Market) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-[#2a2a2a] bg-black/20">
      <SegButton active={value === "ml"} onClick={() => onChange("ml")}>
        Moneyline
      </SegButton>
      <div className="w-px bg-[#2a2a2a]" />
      <SegButton active={value === "spread"} onClick={() => onChange("spread")}>
        Spread
      </SegButton>
      <div className="w-px bg-[#2a2a2a]" />
      <SegButton active={value === "total"} onClick={() => onChange("total")}>
        Total
      </SegButton>
    </div>
  );
}

/* =========================================================
   HERO CHIPS (exact vibe as model screens)
========================================================= */

function Chip({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={CHIP}>
      <div className={CHIP_L}>{label}</div>
      <div className={CHIP_V}>{value}</div>
    </div>
  );
}

/* =========================================================
   MOBILE “MORE” MENU
========================================================= */

function useOutsideClose<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);
  return ref;
}

function MobileMoreMenu({ onHistory, onProps }: { onHistory: () => void; onProps: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose<HTMLDivElement>(() => setOpen(false));
  return (
    <div className="relative" ref={ref as any}>
      <button type="button" onClick={() => setOpen((v) => !v)} className={BTN_GHOST}>
        More ▾
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-40 rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] shadow-[0_16px_60px_rgba(0,0,0,0.45)] overflow-hidden z-20">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onHistory();
            }}
            className="w-full text-left px-3 py-2 text-[12px] font-extrabold text-[#d4af37] hover:bg-white/5"
          >
            History
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onProps();
            }}
            className="w-full text-left px-3 py-2 text-[12px] font-extrabold text-white hover:bg-white/5"
          >
            Player Props
          </button>
        </div>
      )}
    </div>
  );
}

/* =========================================================
   DESKTOP TABLE ROWS + MOBILE CARD
========================================================= */

function EventCardMobile({
  ev,
  market,
  booksOpen,
  onToggleBooks,
  onOpenHistory,
  onOpenProps,
}: {
  ev: EventOdds;
  market: Market;
  booksOpen: boolean;
  onToggleBooks: () => void;
  onOpenHistory: (ev: EventOdds) => void;
  onOpenProps: (ev: EventOdds) => void;
}) {
  const leftLabel = market === "total" ? "Over" : "Away";
  const rightLabel = market === "total" ? "Under" : "Home";

  const awayCons = consensusPartsForRow(ev, market, "AWAY");
  const homeCons = consensusPartsForRow(ev, market, "HOME");

  const metaFor = (book: BookKey) =>
    book === "dk"
      ? { alt: "DraftKings", fb: "DK" }
      : book === "fd"
      ? { alt: "FanDuel", fb: "FD" }
      : book === "mgm"
      ? { alt: "BetMGM", fb: "MGM" }
      : book === "pin"
      ? { alt: "Pinnacle", fb: "PIN" }
      : { alt: "BetOnline", fb: "BOL" };

  return (
    <div className="rounded-2xl border border-[#2a2a2a] bg-black/20 overflow-hidden">
      <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-center justify-between gap-3">
        <div className="text-[12px] text-[#cfcfcf] font-semibold">
          {fmtCTTimeOnly(ev.commenceTime)} CT
        </div>

        <div className="flex items-center gap-2">
          <button type="button" onClick={onToggleBooks} className={BTN_GHOST}>
            {booksOpen ? "Hide Books" : "Show Books"}
          </button>
          <MobileMoreMenu onHistory={() => onOpenHistory(ev)} onProps={() => onOpenProps(ev)} />
        </div>
      </div>

      <div className="px-4 py-3 space-y-3">
        <MiniTeamRow team={ev.away?.team ?? "Away"} logoUrl={ev.away?.logoUrl ?? null} side="AWAY" />
        <MiniTeamRow team={ev.home?.team ?? "Home"} logoUrl={ev.home?.logoUrl ?? null} side="HOME" />
      </div>

      <div className="px-4 pb-4">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#0b0b0b] p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[12px] text-white font-extrabold">Consensus</div>
            <div className="text-[11px] text-[#808080] font-semibold">
              {market === "ml" ? "Moneyline" : market === "spread" ? "Spread" : "Total"}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-[#1f1f1f] bg-black/20 p-2">
              <div className="text-[10px] text-[#808080] font-semibold mb-0.5 text-center">
                {leftLabel}
              </div>
              <div className="text-[14px] text-white font-extrabold tabular-nums text-center">
                {renderCellParts(awayCons)}
              </div>
            </div>
            <div className="rounded-md border border-[#1f1f1f] bg-black/20 p-2">
              <div className="text-[10px] text-[#808080] font-semibold mb-0.5 text-center">
                {rightLabel}
              </div>
              <div className="text-[14px] text-white font-extrabold tabular-nums text-center">
                {renderCellParts(homeCons)}
              </div>
            </div>
          </div>
        </div>

        {booksOpen && (
          <div className="mt-3 rounded-xl border border-[#2a2a2a] bg-black/10 overflow-hidden">
            <div className="px-4 py-2 border-b border-[#141414]">
              <div className="text-[12px] text-white font-extrabold">Books</div>
              <div className="mt-2 grid grid-cols-[110px_1fr_1fr] gap-3 items-center">
                <div />
                <div className="text-[10px] text-[#808080] font-semibold text-center">{leftLabel}</div>
                <div className="text-[10px] text-[#808080] font-semibold text-center">{rightLabel}</div>
              </div>
            </div>

            <div className="px-4">
              {BOOKS.map((bk) => {
                const meta = metaFor(bk);
                return (
                  <div key={bk} className="py-2 border-b border-[#141414] last:border-b-0">
                    <div className="grid grid-cols-[110px_1fr_1fr] items-center gap-3">
                      <div className="flex justify-start">
                        <BookLogoPill
                          src={BOOK_LOGOS[bk]}
                          alt={meta.alt}
                          fallbackLabel={meta.fb}
                          size="md"
                        />
                      </div>

                      <div className="text-center text-white font-extrabold tabular-nums text-[13px] leading-tight">
                        {renderCellParts(partsForBookSide(ev, market, "AWAY", bk))}
                      </div>
                      <div className="text-center text-white font-extrabold tabular-nums text-[13px] leading-tight">
                        {renderCellParts(partsForBookSide(ev, market, "HOME", bk))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EventTwoRows({
  ev,
  market,
  onOpenHistory,
  onOpenProps,
}: {
  ev: EventOdds;
  market: Market;
  onOpenHistory: (ev: EventOdds) => void;
  onOpenProps: (ev: EventOdds) => void;
}) {
  const awayConsensus = consensusPartsForRow(ev, market, "AWAY");
  const homeConsensus = consensusPartsForRow(ev, market, "HOME");

  return (
    <>
      <tr className="hover:bg-white/5 transition-colors">
        <td
          className={[
            "p-4 sticky left-0 bg-[#0f0f0f] z-10 align-middle",
            `border-r ${HDR_BORDER}`,
          ].join(" ")}
          rowSpan={2}
        >
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="text-[12px] text-[#cfcfcf] font-semibold">
              {fmtCTTimeOnly(ev.commenceTime)} CT
            </div>

            <div className="flex items-center gap-2">
              <button type="button" onClick={() => onOpenHistory(ev)} className={LINK_GOLD}>
                History
              </button>
              <button type="button" onClick={() => onOpenProps(ev)} className={BTN_GHOST}>
                Props
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <MiniTeamRow team={ev.away?.team ?? "Away"} logoUrl={ev.away?.logoUrl ?? null} side="AWAY" />
            <MiniTeamRow team={ev.home?.team ?? "Home"} logoUrl={ev.home?.logoUrl ?? null} side="HOME" />
          </div>
        </td>

        <ConsensusValue parts={awayConsensus} />
        <BookValue parts={partsForBookSide(ev, market, "AWAY", "dk")} borderLeft />
        <BookValue parts={partsForBookSide(ev, market, "AWAY", "fd")} />
        <BookValue parts={partsForBookSide(ev, market, "AWAY", "mgm")} />
        <BookValue parts={partsForBookSide(ev, market, "AWAY", "pin")} />
        <BookValue parts={partsForBookSide(ev, market, "AWAY", "bol")} />
      </tr>

      <tr className={["hover:bg-white/5 transition-colors", `border-t border-[#1a1a1a]/60 border-b ${HDR_BORDER}`].join(" ")}>
        <ConsensusValue parts={homeConsensus} />
        <BookValue parts={partsForBookSide(ev, market, "HOME", "dk")} borderLeft />
        <BookValue parts={partsForBookSide(ev, market, "HOME", "fd")} />
        <BookValue parts={partsForBookSide(ev, market, "HOME", "mgm")} />
        <BookValue parts={partsForBookSide(ev, market, "HOME", "pin")} />
        <BookValue parts={partsForBookSide(ev, market, "HOME", "bol")} />
      </tr>

      <tr>
        <td colSpan={7} className="h-2 bg-transparent" />
      </tr>
    </>
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
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[999] flex items-center justify-center bg-black/70 p-2 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-7xl rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden max-h-[92vh] flex flex-col shadow-[0_24px_80px_rgba(0,0,0,0.55)]">
        <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <div className="text-white font-extrabold text-sm">{title}</div>
            {subtitle && (
              <div className="text-[11px] text-[#808080] mt-0.5 break-words">{subtitle}</div>
            )}
          </div>
          <button
            className="text-[#cfcfcf] hover:text-white text-sm font-bold px-2 py-1 rounded-md hover:bg-white/10"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>
        <div className="p-3 sm:p-4 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

/* =========================================================
   HISTORY MODAL (ML / Spread / Total)
========================================================= */

type HistoryRow = {
  ts: string;
  book: BookKey;
  odds: number | null;
  line: number | null;
};

type HistoryPoint = {
  ts: string; // iso
  label: string; // CT formatted
  [key: string]: any; // book series values: "dk", "fd", ...
};

function buildSeries(points: HistoryRow[]): HistoryPoint[] {
  const byTs = new Map<string, HistoryPoint>();
  for (const r of points) {
    const key = r.ts;
    if (!byTs.has(key)) byTs.set(key, { ts: key, label: fmtCTDateTimeLong(key) });
    const p = byTs.get(key)!;
    p[r.book] = r.odds;
    p[`${r.book}__line`] = r.line;
  }
  return Array.from(byTs.values()).sort((a, b) => {
    const ta = new Date(normalizeIso(a.ts) ?? a.ts).getTime();
    const tb = new Date(normalizeIso(b.ts) ?? b.ts).getTime();
    return ta - tb;
  });
}

function HistoryTooltip({ active, payload, label, market }: any) {
  if (!active || !payload?.length) return null;

  const tsLabel = label || payload?.[0]?.payload?.label || "—";
  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] px-3 py-2 shadow-[0_16px_60px_rgba(0,0,0,0.45)]">
      <div className="text-[11px] text-[#d0d0d0] font-extrabold">{tsLabel} CT</div>
      <div className="mt-1 space-y-1">
        {payload
          .filter((p: any) => BOOKS.includes(p.dataKey))
          .map((p: any) => {
            const bk = p.dataKey as BookKey;
            const v = p.value;
            return (
              <div key={bk} className="flex items-center justify-between gap-3 text-[11px]">
                <div className="font-extrabold" style={{ color: BOOK_STROKES[bk] }}>
                  {BOOK_LABEL[bk]}
                </div>
                <div className="text-white font-extrabold tabular-nums">{v == null ? "—" : String(v)}</div>
              </div>
            );
          })}
      </div>
      <div className="mt-2 text-[10px] text-[#808080] font-semibold">
        {market === "ml"
          ? "Moneyline Odds History"
          : market === "spread"
          ? "Spread Odds History"
          : "Total Odds History"}
      </div>
    </div>
  );
}

function LineMovementModal({
  sportKey,
  ev,
  onClose,
}: {
  sportKey: string;
  ev: EventOdds;
  onClose: () => void;
}) {
  const [market, setMarket] = useState<Market>("ml");
  const [side, setSide] = useState<"AWAY" | "HOME">("AWAY"); // total uses AWAY=Over HOME=Under
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<HistoryRow[]>([]);

  const subtitle = `${ev.away?.team ?? "Away"} vs ${ev.home?.team ?? "Home"} • ${fmtCTDateTime(
    ev.commenceTime
  )} CT`;

  useEffect(() => {
    setError("");
    setLoading(true);

    const fetchHistory = async () => {
      const candidates = ["odds_history", "odds_log", "odds_snapshots", "odds_snapshot_history"];

      let lastErr: string | null = null;
      let found: any[] | null = null;

      for (const t of candidates) {
        const res = await supabase
          .from(t)
          .select("*")
          .eq("sport_key", sportKey)
          .eq("event_id", ev.eventId);

        if (!res.error && res.data) {
          found = res.data;
          lastErr = null;
          break;
        }
        lastErr = res.error?.message ?? lastErr;
      }

      if (!found) {
        setRows([]);
        setError(lastErr ?? "No history available (no matching table).");
        setLoading(false);
        return;
      }

      // Filter rows to the requested market+side
      const sideKey = side.toLowerCase(); // "away"/"home"
      const wantOverUnder = market === "total";

      const parsed: HistoryRow[] = [];
      for (const r of found) {
        const ts = pickTs(r);
        const bk = bookKeyFromRaw(pickBook(r));
        if (!ts || !bk) continue;

        // market matching (soft)
        const marketRaw = String(
          pickAny(r, ["market", "market_key", "bet_type", "type"]) ?? ""
        ).toLowerCase();
        const isMl = marketRaw.includes("h2h") || marketRaw.includes("moneyline") || marketRaw === "ml";
        const isSpread = marketRaw.includes("spread");
        const isTotal = marketRaw.includes("total") || marketRaw.includes("ou") || marketRaw.includes("over_under");

        if (marketRaw) {
          if (market === "ml" && !isMl) continue;
          if (market === "spread" && !isSpread) continue;
          if (market === "total" && !isTotal) continue;
        }

        // side matching
        const sideRaw = pickSide(r); // away/home OR team name
        const ouRaw = pickOU(r); // over/under possibly

        let sideOk = true;

        if (wantOverUnder) {
          const need = side === "AWAY" ? "over" : "under";
          if (ouRaw) sideOk = ouRaw.includes(need);
        } else {
          if (sideRaw) sideOk = sideRaw.includes(sideKey);
        }

        if (!sideOk) continue;

        parsed.push({ ts, book: bk, odds: pickOdds(r), line: pickLine(r) });
      }

      // Sort by ts ascending (schema-safe)
      parsed.sort((a, b) => {
        const ta = new Date(normalizeIso(a.ts) ?? a.ts).getTime();
        const tb = new Date(normalizeIso(b.ts) ?? b.ts).getTime();
        return ta - tb;
      });

      setRows(parsed);
      setLoading(false);
    };

    fetchHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sportKey, ev.eventId, market, side]);

  const points = useMemo(() => buildSeries(rows), [rows]);
  const sideLabel =
    market === "total" ? (side === "AWAY" ? "Over" : "Under") : side === "AWAY" ? "Away" : "Home";

  return (
    <ModalShell title="Odds History" subtitle={subtitle} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="inline-flex overflow-hidden rounded-lg border border-[#2a2a2a] bg-black/20">
          <button
            type="button"
            className={`px-3 py-1.5 text-xs font-extrabold ${market === "ml" ? "bg-[#d4af37] text-black" : "text-white"}`}
            onClick={() => setMarket("ml")}
          >
            Moneyline
          </button>
          <div className="w-px bg-[#2a2a2a]" />
          <button
            type="button"
            className={`px-3 py-1.5 text-xs font-extrabold ${market === "spread" ? "bg-[#d4af37] text-black" : "text-white"}`}
            onClick={() => setMarket("spread")}
          >
            Spread
          </button>
          <div className="w-px bg-[#2a2a2a]" />
          <button
            type="button"
            className={`px-3 py-1.5 text-xs font-extrabold ${market === "total" ? "bg-[#d4af37] text-black" : "text-white"}`}
            onClick={() => setMarket("total")}
          >
            Total
          </button>
        </div>

        <div className="inline-flex overflow-hidden rounded-lg border border-[#2a2a2a] bg-black/20">
          <button
            type="button"
            className={`px-3 py-1.5 text-xs font-extrabold ${side === "AWAY" ? "bg-white/10 text-white" : "text-white/80"}`}
            onClick={() => setSide("AWAY")}
          >
            {market === "total" ? "Over" : "Away"}
          </button>
          <div className="w-px bg-[#2a2a2a]" />
          <button
            type="button"
            className={`px-3 py-1.5 text-xs font-extrabold ${side === "HOME" ? "bg-white/10 text-white" : "text-white/80"}`}
            onClick={() => setSide("HOME")}
          >
            {market === "total" ? "Under" : "Home"}
          </button>
        </div>

        <div className="text-[11px] text-[#808080] font-semibold">
          Side: <span className="text-white font-extrabold">{sideLabel}</span>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-[#808080] p-4">Loading history…</div>
      ) : error ? (
        <div className="text-sm text-red-400 p-4">No odds history available: {error}</div>
      ) : !points.length ? (
        <div className="text-sm text-[#808080] p-4">No odds history available for this selection.</div>
      ) : (
        <div className="rounded-2xl border border-[#2a2a2a] bg-black/20 p-3">
          <div className="text-[12px] text-white font-extrabold mb-2">
            Odds History ({market.toUpperCase()} • {sideLabel})
          </div>

          <div className="h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                <CartesianGrid stroke="#222222" strokeDasharray="3 3" />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "#9a9a9a", fontSize: 10 }}
                  interval="preserveStartEnd"
                  minTickGap={18}
                />
                <YAxis tick={{ fill: "#9a9a9a", fontSize: 10 }} width={40} domain={["auto", "auto"]} />
                <Tooltip content={<HistoryTooltip market={market} />} />
                <Legend wrapperStyle={{ color: "#d0d0d0", fontSize: 11 }} />

                {BOOKS.map((bk) => (
                  <Line
                    key={bk}
                    type="monotone"
                    dataKey={bk}
                    name={BOOK_LABEL[bk]}
                    stroke={BOOK_STROKES[bk]}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-2 text-[11px] text-[#808080]">
            Tooltip includes <span className="text-white font-extrabold">date + time (CT)</span>. Lines are book-colored.
          </div>
        </div>
      )}
    </ModalShell>
  );
}

/* =========================================================
   PLAYER PROPS MODAL
========================================================= */

type PropMarket = "Points" | "Rebounds" | "Assists" | "3 Pointers";
const PROP_MARKETS: PropMarket[] = ["Points", "Rebounds", "Assists", "3 Pointers"];

function canonPropMarket(m: PropMarket) {
  if (m === "Points") return ["points", "player_points", "pts"];
  if (m === "Rebounds") return ["rebounds", "player_rebounds", "reb"];
  if (m === "Assists") return ["assists", "player_assists", "ast"];
  return ["threes", "3pm", "player_threes", "3_pointers", "3-pointers"];
}

type PropRow = {
  player_name: string;
  team: string | null;
  position: string | null;
  picture_url: string | null;

  market: string;
  side: string; // over/under
  line: number | null;
  odds: number | null;
  bookmaker: string | null;
  ts: string | null;
};

function normalizeSideOU(s: string | null): "over" | "under" | null {
  if (!s) return null;
  const v = s.toLowerCase();
  if (v.includes("over")) return "over";
  if (v.includes("under")) return "under";
  return null;
}

function PlayerPropsModal({
  sportKey,
  ev,
  onClose,
}: {
  sportKey: string;
  ev: EventOdds;
  onClose: () => void;
}) {
  const [market, setMarket] = useState<PropMarket>("Points");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<PropRow[]>([]);

  const subtitle = `${ev.away?.team ?? "Away"} vs ${ev.home?.team ?? "Home"} • ${fmtCTDateTime(ev.commenceTime)} CT`;

  useEffect(() => {
    setLoading(true);
    setError("");

    const fetchProps = async () => {
      const snap = await supabase
        .from("player_props_snapshot")
        .select("*")
        .eq("sport_key", sportKey)
        .eq("event_id", ev.eventId);

      if (snap.error) {
        setError(snap.error.message);
        setRows([]);
        setLoading(false);
        return;
      }

      const raw = snap.data ?? [];

      const names = Array.from(
        new Set(
          raw
            .map((r: any) => (r.player_name ?? r.player ?? r.name ?? null))
            .filter((x: any) => typeof x === "string" && x.trim().length > 0)
            .map((x: string) => x.trim())
        )
      );

      let metaMap = new Map<string, { position: string | null; picture_url: string | null; team: string | null }>();
      if (names.length) {
        const meta = await supabase
          .from("player_prop_ev_latest")
          .select("player_name,team,position,picture_url")
          .in("player_name", names);

        if (!meta.error && meta.data) {
          for (const m of meta.data as any[]) {
            const key = String(m.player_name ?? "").trim();
            if (!key) continue;
            metaMap.set(key, {
              position: m.position ?? null,
              picture_url: m.picture_url ?? null,
              team: m.team ?? null,
            });
          }
        }
      }

      const wanted = canonPropMarket(market);
      const out: PropRow[] = [];

      for (const r of raw as any[]) {
        const player_name = String(r.player_name ?? r.player ?? r.name ?? "").trim();
        if (!player_name) continue;

        const mRaw = String(r.market ?? r.market_key ?? r.marketRaw ?? r.prop_type ?? "").toLowerCase();
        if (mRaw) {
          const ok = wanted.some((k) => mRaw.includes(k));
          if (!ok) continue;
        }

        const side = normalizeSideOU(String(r.side ?? r.bet_side ?? r.over_under ?? r.ou ?? "")) ?? "over";
        const line = (() => {
          const v = r.line ?? r.points ?? r.point ?? r.total ?? r.value ?? null;
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        })();
        const odds = (() => {
          const v = r.odds ?? r.price ?? r.american_odds ?? r.book_odds ?? null;
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        })();

        const bookmaker = String(r.bookmaker ?? r.book ?? r.sportsbook ?? "").trim() || null;
        const ts = normalizeIso(r.ts ?? r.snapshot_ts ?? r.inserted_at ?? r.created_at ?? null);

        const meta = metaMap.get(player_name) ?? { position: null, picture_url: null, team: null };

        out.push({
          player_name,
          team: meta.team ?? (r.team ?? null),
          position: meta.position,
          picture_url: meta.picture_url,
          market,
          side,
          line,
          odds,
          bookmaker,
          ts,
        });
      }

      out.sort((a, b) => {
        const p = a.player_name.localeCompare(b.player_name);
        if (p !== 0) return p;
        const s = (a.side ?? "").localeCompare(b.side ?? "");
        if (s !== 0) return s;
        const ta = a.ts ? new Date(a.ts).getTime() : 0;
        const tb = b.ts ? new Date(b.ts).getTime() : 0;
        return tb - ta;
      });

      setRows(out);
      setLoading(false);
    };

    fetchProps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sportKey, ev.eventId, market]);

  return (
    <ModalShell title="Player Props" subtitle={subtitle} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="inline-flex overflow-hidden rounded-lg border border-[#2a2a2a] bg-black/20">
          {PROP_MARKETS.map((m) => (
            <button
              key={m}
              type="button"
              className={`px-3 py-1.5 text-xs font-extrabold ${market === m ? "bg-[#d4af37] text-black" : "text-white"}`}
              onClick={() => setMarket(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-[#808080] p-4">Loading props…</div>
      ) : error ? (
        <div className="text-sm text-red-400 p-4">Supabase error: {error}</div>
      ) : !rows.length ? (
        <div className="text-sm text-[#808080] p-4">No props found for this game/market.</div>
      ) : (
        <div className="rounded-2xl border border-[#2a2a2a] bg-black/20 overflow-hidden">
          <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-center justify-between">
            <div className="text-white font-extrabold text-sm">{market}</div>
            <div className="text-[11px] text-[#808080] font-semibold">
              {rows.length} rows • Snapshot time:{" "}
              <span className="text-white font-extrabold">{fmtCTDateTime(rows[0]?.ts)}</span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#232323] bg-[#0b0b0b]">
                  <th className="text-left px-4 py-3 text-[12px] text-[#d0d0d0] font-extrabold">Player</th>
                  <th className="text-left px-3 py-3 text-[12px] text-[#d0d0d0] font-extrabold">Team</th>
                  <th className="text-center px-3 py-3 text-[12px] text-[#d0d0d0] font-extrabold">Side</th>
                  <th className="text-center px-3 py-3 text-[12px] text-[#d0d0d0] font-extrabold">Line</th>
                  <th className="text-center px-3 py-3 text-[12px] text-[#d0d0d0] font-extrabold">Odds</th>
                  <th className="text-left px-3 py-3 text-[12px] text-[#d0d0d0] font-extrabold">Book</th>
                  <th className="text-left px-3 py-3 text-[12px] text-[#d0d0d0] font-extrabold">Time (CT)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => (
                  <tr key={`${r.player_name}-${idx}`} className="border-b border-[#141414] hover:bg-white/5">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3 min-w-0">
                        {r.picture_url ? (
                          <img
                            src={r.picture_url}
                            alt={r.player_name}
                            className="w-9 h-9 rounded-full object-cover border border-[#2a2a2a]"
                            loading="lazy"
                            onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                          />
                        ) : (
                          <div className="w-9 h-9 rounded-full bg-white/5 border border-[#2a2a2a]" />
                        )}

                        <div className="min-w-0">
                          <div className="text-white font-extrabold text-[13px] truncate">{r.player_name}</div>
                          <div className="text-[11px] text-[#808080] font-semibold">{r.position ?? "—"}</div>
                        </div>
                      </div>
                    </td>

                    <td className="px-3 py-3 text-white font-extrabold text-[12px]">{r.team ?? "—"}</td>

                    <td className="px-3 py-3 text-center">
                      <span className={`text-[12px] font-extrabold ${r.side === "over" ? "text-emerald-400" : "text-red-400"}`}>
                        {r.side.toUpperCase()}
                      </span>
                    </td>

                    <td className="px-3 py-3 text-center text-white font-extrabold tabular-nums text-[12px]">
                      {r.line == null ? "—" : r.line}
                    </td>

                    <td className="px-3 py-3 text-center text-white font-extrabold tabular-nums text-[12px]">
                      {r.odds == null ? "—" : r.odds}
                    </td>

                    <td className="px-3 py-3 text-[#d0d0d0] font-extrabold text-[12px]">{r.bookmaker ?? "—"}</td>

                    <td className="px-3 py-3 text-[#d0d0d0] font-semibold text-[12px]">{fmtCTDateTime(r.ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-3 text-[11px] text-[#808080]">
            Odds are read from <span className="text-white font-extrabold">player_props_snapshot</span>. Player photo/position from{" "}
            <span className="text-white font-extrabold">player_prop_ev_latest</span>.
          </div>
        </div>
      )}
    </ModalShell>
  );
}

/* =========================================================
   SCREEN
========================================================= */

export function OddsScreen({ sportKey }: { sportKey: string }) {
  const [allEvents, setAllEvents] = useState<EventOdds[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [market, setMarket] = useState<Market>("ml");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdatedIso, setLastUpdatedIso] = useState<string | null>(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [propsOpen, setPropsOpen] = useState(false);
  const [activeEvent, setActiveEvent] = useState<EventOdds | null>(null);

  const [mobileOpenMap, setMobileOpenMap] = useState<Record<string, boolean>>({});

  async function load() {
    setError("");

    const { data, error } = await supabase
      .from("odds_wide_latest")
      .select("*")
      .eq("sport_key", sportKey)
      .in("side", ["AWAY", "HOME"])
      .order("commence_time", { ascending: true });

    if (error) {
      setError(error.message);
      setAllEvents([]);
      setLastUpdatedIso(null);
      setLoading(false);
      return;
    }

    const byEvent = new Map<string, EventOdds>();
    let globalLatest: string | null = null;

    for (const row of data ?? []) {
      const eventId = row.event_id;
      if (!eventId) continue;

      const cur: EventOdds =
        byEvent.get(eventId) ?? {
          eventId,
          sportKey: row.sport_key ?? null,
          commenceTime: row.commence_time ?? "",
          latestUpdatedAt: null,
        };

      cur.commenceTime = cur.commenceTime || row.commence_time || "";

      const sideOdds = mapWideRowToSideOdds(row);
      if (sideOdds.side === "AWAY") cur.away = sideOdds;
      if (sideOdds.side === "HOME") cur.home = sideOdds;

      cur.latestUpdatedAt = maxIso(cur.latestUpdatedAt, sideOdds.updatedAt);

      globalLatest = maxIso(globalLatest, sideOdds.updatedAt);
      globalLatest = maxIso(globalLatest, pickUpdatedAt(row));

      byEvent.set(eventId, cur);
    }

    const list = Array.from(byEvent.values()).sort((a, b) => {
      const ta = new Date(normalizeIso(a.commenceTime) ?? a.commenceTime).getTime();
      const tb = new Date(normalizeIso(b.commenceTime) ?? b.commenceTime).getTime();
      return ta - tb;
    });

    // optional: include latest props snapshot time if available (schema-safe)
    let propsLatest: string | null = null;
    try {
      const propsRes = await supabase
        .from("player_props_snapshot")
        .select("ts,snapshot_ts,inserted_at")
        .eq("sport_key", sportKey)
        .limit(250);

      if (!propsRes.error && propsRes.data) {
        for (const r of propsRes.data as any[]) {
          const t = normalizeIso(r.ts ?? r.snapshot_ts ?? r.inserted_at ?? null);
          propsLatest = maxIso(propsLatest, t);
        }
      }
    } catch {
      // ignore
    }

    setAllEvents(list);
    setLastUpdatedIso(maxIso(globalLatest, propsLatest));
    setLoading(false);
  }

  useEffect(() => {
    setLoading(true);
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sportKey]);

  useEffect(() => {
    setSelectedDate("");
    setMobileOpenMap({});
    setMarket("ml");
    setHistoryOpen(false);
    setPropsOpen(false);
    setActiveEvent(null);
  }, [sportKey]);

  const availableDates = useMemo(() => {
    const todayCt = ctTodayYmd();
    const nowMs = Date.now();
    const set = new Set<string>();

    for (const ev of allEvents) {
      const evDate = ctYmdFromIso(ev.commenceTime);
      if (!evDate) continue;

      if (evDate === todayCt) {
        const startMs = new Date(normalizeIso(ev.commenceTime) ?? ev.commenceTime).getTime();
        if (Number.isFinite(startMs) && startMs > nowMs) set.add(evDate);
      } else {
        set.add(evDate);
      }
    }

    return Array.from(set).sort();
  }, [allEvents]);

  useEffect(() => {
    if (!availableDates.length) {
      setSelectedDate("");
      return;
    }
    const today = ctTodayYmd();
    setSelectedDate((prev) => {
      if (prev && availableDates.includes(prev)) return prev;
      if (availableDates.includes(today)) return today;
      return availableDates[0];
    });
  }, [availableDates]);

  const events = useMemo(() => {
    if (!selectedDate) return [];
    const todayCt = ctTodayYmd();
    const nowMs = Date.now();

    return allEvents.filter((ev) => {
      const evDate = ctYmdFromIso(ev.commenceTime);
      if (evDate !== selectedDate) return false;

      if (selectedDate === todayCt) {
        const startMs = new Date(normalizeIso(ev.commenceTime) ?? ev.commenceTime).getTime();
        if (!Number.isFinite(startMs)) return false;
        return startMs > nowMs;
      }
      return true;
    });
  }, [allEvents, selectedDate]);

  useEffect(() => {
    setMobileOpenMap((prev) => {
      const next: Record<string, boolean> = {};
      for (const ev of events) next[ev.eventId] = prev[ev.eventId] ?? false;
      return next;
    });
  }, [events]);

  const sportLabel =
    sportKey === "basketball_nba"
      ? "NBA Odds"
      : sportKey === "basketball_ncaab"
      ? "NCAAB Odds"
      : sportKey === "football_nfl"
      ? "NFL Odds"
      : sportKey === "football_ncaaf"
      ? "NCAAF Odds"
      : sportKey === "icehockey_nhl"
      ? "NHL Odds"
      : sportKey === "baseball_mlb"
      ? "MLB Odds"
      : "Odds";

  const sportChip = sportKey.toUpperCase();
  const marketLabel = market === "ml" ? "Moneyline" : market === "spread" ? "Spread" : "Total";

  const openHistory = (ev: EventOdds) => {
    setActiveEvent(ev);
    setHistoryOpen(true);
    setPropsOpen(false);
  };

  const openProps = (ev: EventOdds) => {
    setActiveEvent(ev);
    setPropsOpen(true);
    setHistoryOpen(false);
  };

  return (
    <div className="w-full">
      <div className={`${PAGE_MAX_W} mx-auto ${PAGE_X}`}>
        {/* ✅ HERO — matches Model/MonteCarlo structure */}
        <div className="pt-4 md:pt-6">
          <div className={HERO_WRAP}>
            <div className={HERO_INNER}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className={PILL}>
                    <span className={PILL_DOT} />
                    <span className={PILL_TX}>Prism Odds Board</span>
                  </div>

                  <h2 className="mt-3 text-[22px] md:text-[28px] text-white font-extrabold tracking-tight">
                    {sportLabel}
                  </h2>

                  <div className={HERO_SUB}>
                    One board per slate. Books shown side-by-side with consensus, plus History and Player Props.
                  </div>
                </div>

                {/* ✅ RIGHT SIDE — Live badge like MonteCarlo */}
                <div className="hidden md:flex flex-col items-end gap-2">
                  <div className={LIVE_BADGE}>
                    <span className={LIVE_TX}>Live</span>
                    <span className={LIVE_DOT} />
                  </div>

                  <div className="text-right">
                    <div className="text-[10px] text-[#6a6a6a] font-semibold">Last Updated (CT)</div>
                    <div className="text-xs text-white font-extrabold">{fmtCTDateTime(lastUpdatedIso)}</div>
                  </div>
                </div>
              </div>

              {/* ✅ CHIPS ROW */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Chip label="Sport" value={sportChip} />
                <Chip label="Games" value={events.length} />
                <Chip label="Market" value={marketLabel.toUpperCase()} />
                <Chip label="Books" value="5" />
                <Chip label="Refresh" value="60s" />

                <div className="md:hidden w-full" />
                <div className="md:hidden text-[11px] text-[#6a6a6a] font-semibold">
                  Last Updated (CT):{" "}
                  <span className="text-white font-extrabold">{fmtCTDateTime(lastUpdatedIso)}</span>
                </div>
              </div>

              {/* ✅ CONTROLS */}
              <div className="mt-4 flex flex-col gap-3">
                <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
                  {availableDates.map((d) => (
                    <button
                      key={d}
                      onClick={() => setSelectedDate(d)}
                      className={[BTN_BASE, selectedDate === d ? BTN_ON : BTN_OFF].join(" ")}
                      type="button"
                    >
                      {fmtDateBtn(d)}
                    </button>
                  ))}
                  {!availableDates.length && (
                    <div className="text-xs text-[#808080]">No games available.</div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Segmented value={market} onChange={setMarket} />
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="h-px bg-[#232323]" />

            {/* CONTENT */}
            <div className="p-3 md:p-4">
              {/* MOBILE */}
              <div className="md:hidden">
                {loading ? (
                  <div className="p-3 text-xs text-[#808080]">Loading odds…</div>
                ) : error ? (
                  <div className="p-3 text-xs text-red-400">Supabase error: {error}</div>
                ) : !events.length ? (
                  <div className="p-3 text-xs text-[#808080]">No games for {selectedDate || "—"}.</div>
                ) : (
                  <div className="space-y-3">
                    {events.map((ev) => (
                      <EventCardMobile
                        key={ev.eventId}
                        ev={ev}
                        market={market}
                        booksOpen={!!mobileOpenMap[ev.eventId]}
                        onToggleBooks={() =>
                          setMobileOpenMap((prev) => ({ ...prev, [ev.eventId]: !prev[ev.eventId] }))
                        }
                        onOpenHistory={openHistory}
                        onOpenProps={openProps}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* DESKTOP */}
              <div className="hidden md:block">
                {loading ? (
                  <div className="p-6 text-sm text-[#808080]">Loading odds…</div>
                ) : error ? (
                  <div className="p-6 text-sm text-red-400">Supabase error: {error}</div>
                ) : !events.length ? (
                  <div className="p-6 text-sm text-[#808080]">No games for {selectedDate || "—"}.</div>
                ) : (
                  <div className={PANEL_INNER}>
                    <div className="overflow-x-auto">
                      <table className="w-full table-fixed">
                        <colgroup>
                          <col style={{ width: COL_MATCHUP }} />
                          <col style={{ width: COL_CONSENSUS }} />
                          <col style={{ width: COL_BOOK }} />
                          <col style={{ width: COL_BOOK }} />
                          <col style={{ width: COL_BOOK }} />
                          <col style={{ width: COL_BOOK }} />
                          <col style={{ width: COL_BOOK }} />
                        </colgroup>

                        <thead className="sticky top-0 z-20">
                          <tr className={`border-b ${HDR_BORDER}`}>
                            <th
                              className={[
                                "text-left px-4 py-3",
                                HDR_LEFT_BG,
                                HDR_TEXT,
                                "sticky left-0 z-30 text-[13px] font-extrabold",
                              ].join(" ")}
                            >
                              Matchup
                            </th>

                            <th
                              className={[
                                "text-center px-3 py-3",
                                HDR_LEFT_BG,
                                HDR_TEXT,
                                "z-20 text-[13px] font-extrabold border-l",
                                HDR_BORDER,
                              ].join(" ")}
                            >
                              Consensus
                            </th>

                            <BookHeader bookKey="dk" borderLeft />
                            <BookHeader bookKey="fd" />
                            <BookHeader bookKey="mgm" />
                            <BookHeader bookKey="pin" />
                            <BookHeader bookKey="bol" />
                          </tr>
                        </thead>

                        <tbody>
                          {events.map((ev) => (
                            <EventTwoRows
                              key={ev.eventId}
                              ev={ev}
                              market={market}
                              onOpenHistory={openHistory}
                              onOpenProps={openProps}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Modals */}
        {historyOpen && activeEvent && (
          <LineMovementModal sportKey={sportKey} ev={activeEvent} onClose={() => setHistoryOpen(false)} />
        )}
        {propsOpen && activeEvent && (
          <PlayerPropsModal sportKey={sportKey} ev={activeEvent} onClose={() => setPropsOpen(false)} />
        )}

        <div className="h-12" />
      </div>
    </div>
  );
}

