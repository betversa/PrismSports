"use client";

// src/app/components/screens/OddsScreen.tsx — FULL REWRITE (Premium Odds Board UI — matches reference layout + Prism black/gold theme)
// -------------------------------------------------------------------------------------------------------------
// ✅ UI updated to match the reference odds-board layout:
//    - Top sport tabs bar (visual only; uses your existing sportKey prop as the active tab)
//    - Filters toolbar: Market / View / Date / Search / Odds Format / Sportsbooks / Refresh
//    - Sticky book header row with logo “pills”
//    - Date section separators like the reference board
//    - Odds cells rendered as compact “chips” (line + price) inside gray rounded boxes
//
// ✅ KEEP: Game Details modal (triggered by icon actions)
// ✅ KEEP: Predictions “Key Lines”: remove Quantum ML block (consensus only)
// ✅ KEEP: Mobile Predictions: smaller logos + team names ABOVE the win% bar
// ✅ KEEP: Player Props modal: sticky headers + its OWN scroll container (no blank gap jump)
// ✅ Build-safe: GameDetailsModal correctly closed
//
// NOTE:
// - Data source remains public.odds_wide_latest (your existing wide table).
// - Optional history/projections/props tables are queried the same way as last version.
// - The “Sportsbooks” dropdown is UI-only (we show all books you currently have: DK/FD/MGM/PIN/BOL).
// - Odds format switch supports American + Decimal display for prices only.

import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { supabase } from "../../lib/supabaseClient";
import { americanToDecimal, median, probToAmerican, safeNumberOrNull, toProb01 } from "../../../lib/odds/math";
import { formatOddsPrice, formatPercent } from "../../../lib/odds/format";
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
type OddsFormat = "american" | "decimal";
type BoardView = "pregame" | "live";
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

// Prism Theme (black / gold)
const PRISM_BORDER = "rgba(255,255,255,0.08)";
const PRISM_GOLD = "#d4af37";
const PRISM_GOLD_SOFT = "rgba(212,175,55,0.18)";
const PRISM_MUTED = "rgba(232,232,232,0.60)";
const BOARD_BG = "linear-gradient(180deg, rgba(10,10,10,0.88), rgba(8,8,8,0.96))";
const BOARD_STICKY_BG = BOARD_BG;
const TABLE_HEADER_BG = "#0b0b0b";
const FILTER_ROW_HEIGHT = 48;
const FILTERS_BAR_HEIGHT = FILTER_ROW_HEIGHT * 2;
const DATE_BAR_HEIGHT = 44;
const HEADER_ROW_HEIGHT = 40;
const BOARD_BG = "linear-gradient(180deg, rgba(10,10,10,0.86), rgba(8,8,8,0.96))";
const BOARD_STICKY_BG = "linear-gradient(180deg, rgba(12,12,12,0.98), rgba(10,10,10,0.96))";

const BOOKS: BookKey[] = ["dk", "fd", "mgm", "pin", "bol"];
const BOOK_ORDER_STORAGE_KEY = "prism.odds.bookOrder";
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
  dk: "/books/dksquare.png",
  fd: "/books/fdsquare.png",
  mgm: "/books/mgmsquare.png",
  pin: "/books/pinsquare.png",
  bol: "/books/bolsquare.png",
};

const COL_GAME = 380;
const COL_BOOK = 120;

const PAGE_MAX_W = "max-w-[1500px]";
const PAGE_X = "px-3 md:px-6";

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
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
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

function minutesSinceIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const n = normalizeIso(iso);
  if (!n) return null;
  const ts = new Date(n).getTime();
  if (!Number.isFinite(ts)) return null;
  const diffMs = Date.now() - ts;
  return diffMs >= 0 ? Math.round(diffMs / 60000) : 0;
}

/* =========================================================
   PICKERS (wide table)
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
   ODDS FORMATTERS
========================================================= */

const fmtPrice = (odds: number | null, fmt: OddsFormat) => formatOddsPrice(odds, fmt);

/* =========================================================
   CONSENSUS HELPERS
========================================================= */

type CellParts = { top: string; bottom?: string };

function cellMl(price: string): CellParts {
  return { top: price };
}
function cellLineOdds(line: number | null, price: string): CellParts {
  if (line == null) return { top: "—" };
  return { top: String(line), bottom: price === "—" ? "—" : price };
}

function consensusPartsForRow(
  ev: EventOdds,
  market: Market,
  side: "AWAY" | "HOME",
  oddsFormat: OddsFormat
): CellParts {
  const src = side === "AWAY" ? ev.away : ev.home;

  if (market === "ml") {
    const odds: number[] = [];
    if (src) for (const b of BOOKS) if (typeof src.ml[b] === "number") odds.push(src.ml[b] as number);
    const mOdds = median(odds);
    return cellMl(fmtPrice(mOdds == null ? null : mOdds, oddsFormat));
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
    return cellLineOdds(mLine == null ? null : mLine, fmtPrice(mOdds == null ? null : mOdds, oddsFormat));
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

  if (side === "AWAY") return cellLineOdds(mLine == null ? null : mLine, fmtPrice(mOver == null ? null : mOver, oddsFormat));
  return cellLineOdds(mLine == null ? null : mLine, fmtPrice(mUnder == null ? null : mUnder, oddsFormat));
}

function partsForBookSide(
  ev: EventOdds,
  market: Market,
  side: "AWAY" | "HOME",
  book: BookKey,
  oddsFormat: OddsFormat
): CellParts {
  const src = side === "AWAY" ? ev.away : ev.home;
  if (!src) return { top: "—" };

  if (market === "ml") return { top: fmtPrice(src.ml[book], oddsFormat) };

  if (market === "spread") {
    const c = src.spread[book];
    if (c?.line == null) return { top: "—" };
    return { top: String(c.line), bottom: fmtPrice(c?.odds ?? null, oddsFormat) };
  }

  // total: AWAY is Over, HOME is Under
  const t = src.total[book];
  const odds = side === "AWAY" ? t?.over ?? null : t?.under ?? null;
  if (t?.line == null) return { top: "—" };
  return { top: String(t.line), bottom: fmtPrice(odds, oddsFormat) };
}

/* =========================================================
   UI PRIMITIVES (board look)
========================================================= */

function BookLogoPill({
  src,
  alt,
  className,
  imgClassName,
  textClassName,
}: {
  src: string;
  alt: string;
  className?: string;
  imgClassName?: string;
  textClassName?: string;
}) {
  return (
    <div
      className={[
        "h-7 w-full max-w-[120px] rounded-lg bg-black/40 border border-white/10 px-2 flex items-center gap-2 shadow-[0_12px_32px_rgba(0,0,0,0.35)] transition-colors hover:border-[rgba(212,175,55,0.45)]",
        className ?? "",
      ].join(" ")}
      title={alt}
    >
      <img
        src={src}
        alt={alt}
        className={[
          "h-5 w-5 rounded-md object-contain bg-black/50 p-0.5 opacity-85",
          imgClassName ?? "",
        ].join(" ")}
        loading="lazy"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
      <span className={["text-[11px] font-semibold text-white/75 truncate", textClassName ?? ""].join(" ")}>
        {alt}
      </span>
    </div>
  );
}

function TeamCell({
  team,
  logoUrl,
  sub,
}: {
  team: string;
  logoUrl: string | null;
  sub: string;
}) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      {logoUrl ? (
        <img
          src={logoUrl}
          alt={`${team} logo`}
          className="w-9 h-9 rounded-md object-contain bg-white border border-[#e5e5e5] p-1 shadow-[0_10px_35px_rgba(0,0,0,0.35)]"
          loading="lazy"
          onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
        />
      ) : (
        <div className="w-9 h-9 rounded-md bg-white/5 border border-white/10" />
      )}

      <div className="min-w-0 leading-tight">
        <div className="text-white font-extrabold text-[13px] truncate">{team}</div>
        <div className="text-[11px] text-white/60 font-semibold">{sub}</div>
      </div>
    </div>
  );
}

function OddsChip({
  parts,
  className,
}: {
  parts: CellParts;
  className?: string;
}) {
  // chip like reference: gray box, two-line
  return (
    <div
      className={[
        "w-[104px] h-[42px] rounded-md border border-white/10 bg-white/5 flex flex-col items-center justify-center shadow-[0_10px_30px_rgba(0,0,0,0.30)]",
        className ?? "",
      ].join(" ")}
    >
    <div className="w-[104px] h-[42px] rounded-md border border-white/10 bg-white/5 flex flex-col items-center justify-center shadow-[0_10px_30px_rgba(0,0,0,0.30)]">
      <div className="text-white font-extrabold tabular-nums text-[12px] leading-none">
        {parts.top}
      </div>
      <div className="text-white/70 font-semibold tabular-nums text-[11px] leading-none mt-1">
        {parts.bottom ?? " "}
      </div>
    </div>
  );
}

function SelectPill({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  label?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      {label ? <div className="text-[12px] text-white/55 font-semibold">{label}</div> : null}
      <select
        className="h-8 rounded-lg border border-white/10 bg-black/35 text-white text-[13px] font-extrabold px-2.5 outline-none focus:border-[rgba(212,175,55,0.55)]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-[#0b0b0b]">
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  onClear,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onClear?: () => void;
}) {
  const showClear = Boolean(onClear && value);
  return (
    <div className="relative">
      <input
        className="h-8 w-full md:w-[320px] rounded-lg border border-white/10 bg-black/35 text-white text-[13px] font-semibold px-2.5 pr-9 outline-none focus:border-[rgba(212,175,55,0.55)]"
        className="h-9 w-[240px] md:w-[320px] rounded-lg border border-white/10 bg-black/35 text-white text-sm font-semibold px-3 pr-10 outline-none focus:border-[rgba(212,175,55,0.55)]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {showClear ? (
        <button
          type="button"
          onClick={onClear}
          className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 rounded-md text-white/70 hover:text-white hover:bg-white/10 border border-transparent hover:border-white/10 text-xs font-bold"
          aria-label="Clear search"
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}

function Btn({
  onClick,
  children,
  variant = "gold",
  disabled = false,
}: {
  onClick: () => void;
  children: React.ReactNode;
  variant?: "gold" | "ghost";
  disabled?: boolean;
}) {
  const base =
    "h-8 px-3 rounded-lg border text-[12px] font-extrabold transition-colors shadow-[0_12px_32px_rgba(0,0,0,0.35)]";
  const gold =
    "bg-[#d4af37] text-black border-[#d4af37] hover:bg-[#e2c257] hover:border-[#e2c257]";
  const ghost =
    "bg-black/30 text-white border-white/10 hover:border-white/20 hover:bg-black/40";
  const disabledStyles = "opacity-60 cursor-not-allowed hover:bg-[#d4af37] hover:border-[#d4af37]";
  return (
    <button
      className={`${base} ${variant === "gold" ? gold : ghost} ${disabled ? disabledStyles : ""}`}
      onClick={onClick}
      type="button"
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function DateReminder({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="text-[12px] text-white/55 font-semibold">Selected date</div>
      <div className="h-8 px-2.5 rounded-lg border border-white/10 bg-black/35 text-white text-[13px] font-extrabold flex items-center">
      <div className="text-[11px] text-white/60 font-semibold">Selected date</div>
      <div className="h-9 px-3 rounded-lg border border-white/10 bg-black/35 text-white text-sm font-extrabold flex items-center">
        {label}
      </div>
    </div>
  );
}

function SegmentedToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-white/10 bg-black/35 p-1">
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={[
              "h-7 px-3 rounded-md text-[12px] font-extrabold transition-colors",
              "h-7 px-3 rounded-md text-[11px] font-extrabold transition-colors",
              active
                ? "bg-[rgba(212,175,55,0.22)] text-white border border-[rgba(212,175,55,0.55)]"
                : "text-white/70 hover:text-white",
            ].join(" ")}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  icon,
  active = false,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={[
        "h-8 w-8 flex items-center justify-center rounded-lg border text-white/80 transition-colors",
        "hover:border-white/30 hover:bg-white/10 hover:text-white",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(212,175,55,0.35)]",
        active ? "border-[rgba(212,175,55,0.6)] bg-[rgba(212,175,55,0.18)] text-white" : "border-white/10 bg-black/30",
      ].join(" ")}
    >
      {icon}
    </button>
  );
}

function IconInfo() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 10.5v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="7.5" r="1.2" fill="currentColor" />
    </svg>
  );
}

function IconTrend() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 16l6-6 4 4 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M16 7h4v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconPlayers() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="17" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4.5 18c.6-2.3 2.7-4 4.5-4s3.9 1.7 4.5 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M14.5 18c.4-1.6 1.8-2.7 3.5-2.7 1.4 0 2.6.7 3.2 1.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconBooks() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6h8a3 3 0 0 1 3 3v9H9a3 3 0 0 0-3 3z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M6 6v15" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 6h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function EmptyState({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="p-6 text-center text-white/70">
      <div className="text-sm font-extrabold text-white">{title}</div>
      {subtitle ? <div className="text-xs mt-1 text-white/60">{subtitle}</div> : null}
    </div>
  );
}

/* =========================================================
   MODAL SHELL (premium)
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
      <div
        className="relative w-full max-w-7xl rounded-2xl border border-white/10 overflow-hidden max-h-[92vh] flex flex-col shadow-[0_28px_90px_rgba(0,0,0,0.65)]"
        style={{
          background:
            `radial-gradient(1200px 700px at 15% 10%, ${PRISM_GOLD_SOFT}, transparent 55%),` +
            "radial-gradient(900px 700px at 70% 95%, rgba(212,175,55,0.12), transparent 58%)," +
            "linear-gradient(180deg, rgba(15,15,15,0.98), rgba(10,10,10,0.98))",
        }}
      >
        <div className="px-4 py-2.5 border-b border-white/10 flex items-start justify-between gap-4 shrink-0 bg-black/30 backdrop-blur-[6px]">
          <div className="min-w-0">
            <div className="text-white font-extrabold text-sm">{title}</div>
            {subtitle ? (
              <div className="text-[11px] text-white/60 mt-0.5 break-words">{subtitle}</div>
            ) : null}
          </div>
          <button
            className="text-white/80 hover:text-white text-sm font-bold px-2 py-1 rounded-md hover:bg-white/10 border border-transparent hover:border-white/10"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>

        <div className="relative overflow-y-auto" style={{ scrollPaddingTop: 140 }}>
          <div className="relative p-3 sm:p-4">{children}</div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   GAME DETAILS MODAL — (same behavior as your last rewrite)
========================================================= */

type DetailsTab = "line" | "pred" | "props";

function TabBtn({
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
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        onClick();
        (e.currentTarget as HTMLButtonElement).blur();
      }}
      className={[
        "px-3 py-1.5 text-xs font-extrabold rounded-lg border transition-colors",
        "shadow-[0_10px_35px_rgba(0,0,0,0.35)]",
        active
          ? "bg-[#d4af37] text-black border-[#d4af37]"
          : "bg-black/30 text-white border-white/10 hover:border-white/20",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

/* -------------------------
   Line Movement (history)
------------------------- */

type HistoryRow = { ts: string; book: BookKey; odds: number | null; line: number | null };
type HistoryPoint = { ts: string; label: string; [key: string]: any };

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

  const base = payload?.[0]?.payload ?? {};
  const tsLabel = label || base?.label || "—";

  return (
    <div className="rounded-xl border border-white/10 bg-[#0f0f0f] px-3 py-2 shadow-[0_16px_60px_rgba(0,0,0,0.55)]">
      <div className="text-[11px] text-white font-extrabold">{tsLabel} CT</div>

      <div className="mt-1 space-y-1">
        {payload
          .filter((p: any) => BOOKS.includes(p.dataKey))
          .map((p: any) => {
            const bk = p.dataKey as BookKey;
            const odds = p.value as number | null | undefined;
            const line = base?.[`${bk}__line`] ?? null;

            return (
              <div key={bk} className="flex items-center justify-between gap-3 text-[11px]">
                <div className="font-extrabold" style={{ color: BOOK_STROKES[bk] }}>
                  {BOOK_LABEL[bk]}
                </div>
                <div className="text-white font-extrabold tabular-nums">
                  {market === "ml"
                    ? odds == null
                      ? "—"
                      : String(odds)
                    : line == null && odds == null
                    ? "—"
                    : `${line == null ? "—" : String(line)}  (${odds == null ? "—" : String(odds)})`}
                </div>
              </div>
            );
          })}
      </div>

      <div className="mt-2 text-[10px] text-white/60 font-semibold">
        {market === "ml"
          ? "Moneyline Odds History"
          : market === "spread"
          ? "Spread (line + odds) History"
          : "Total (line + odds) History"}
      </div>
    </div>
  );
}

function pickAny(row: any, keys: string[]) {
  for (const k of keys) if (row?.[k] != null) return row[k];
  return null;
}
function pickTs(row: any): string | null {
  return normalizeIso(
    pickAny(row, [
      "ts",
      "timestamp",
      "snapshot_ts",
      "inserted_at",
      "created_at",
      "time",
      "date",
    ])
  );
}
function pickOdds(row: any): number | null {
  const raw = pickAny(row, [
    "odds",
    "price",
    "american_odds",
    "odds_american",
    "book_odds",
  ]);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function pickLine(row: any): number | null {
  const raw = pickAny(row, [
    "line",
    "points",
    "point",
    "total",
    "spread_line",
    "total_line",
    "prop_line",
    "value",
  ]);
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

async function fetchOddsHistoryAnyTable({
  sportKey,
  eventId,
}: {
  sportKey: string;
  eventId: string;
}): Promise<{ rows: any[]; table: string | null; error: string | null }> {
  const candidates = ["odds_history", "odds_log", "odds_snapshots", "odds_snapshot_history"];
  let lastErr: string | null = null;

  for (const t of candidates) {
    const { data, error } = await supabase
      .from(t)
      .select("*")
      .eq("sport_key", sportKey)
      .eq("event_id", eventId)
      .order("ts", { ascending: true });

    if (!error && data) return { rows: data, table: t, error: null };
    lastErr = error?.message ?? lastErr;
  }

  return { rows: [], table: null, error: lastErr ?? "No matching history table found." };
}

function parseHistoryRows({
  raw,
  market,
  wantSide,
}: {
  raw: any[];
  market: Market;
  wantSide: "AWAY" | "HOME";
}): HistoryRow[] {
  const sideKey = wantSide.toLowerCase();
  const wantOverUnder = market === "total";
  const parsed: HistoryRow[] = [];

  for (const r of raw) {
    const ts = pickTs(r);
    const bk = bookKeyFromRaw(pickBook(r) ? String(pickBook(r)) : null);
    if (!ts || !bk) continue;

    const marketRaw = String(pickAny(r, ["market", "market_key", "bet_type", "type"]) ?? "").toLowerCase();
    const isMl = marketRaw.includes("h2h") || marketRaw.includes("moneyline") || marketRaw === "ml";
    const isSpread = marketRaw.includes("spread");
    const isTotal = marketRaw.includes("total") || marketRaw.includes("ou") || marketRaw.includes("over_under");

    if (marketRaw) {
      if (market === "ml" && !isMl) continue;
      if (market === "spread" && !isSpread) continue;
      if (market === "total" && !isTotal) continue;
    }

    const sideRaw = pickSide(r);
    const ouRaw = pickOU(r);

    let sideOk = true;

    if (wantOverUnder) {
      const need = wantSide === "AWAY" ? "over" : "under";
      if (ouRaw) sideOk = ouRaw.includes(need);
      else if (sideRaw) sideOk = sideRaw.includes(need);
    } else {
      if (sideRaw) sideOk = sideRaw.includes(sideKey);
    }

    if (!sideOk) continue;

    parsed.push({ ts, book: bk, odds: pickOdds(r), line: pickLine(r) });
  }

  return parsed;
}

function SideBySideLineCharts({
  leftTitle,
  rightTitle,
  leftPoints,
  rightPoints,
  market,
}: {
  leftTitle: string;
  rightTitle: string;
  leftPoints: HistoryPoint[];
  rightPoints: HistoryPoint[];
  market: Market;
}) {
  const chart = (title: string, pts: HistoryPoint[]) => (
    <div className="rounded-2xl border border-white/10 bg-black/35 backdrop-blur-[4px] p-3 shadow-[0_14px_55px_rgba(0,0,0,0.40)]">
      <div className="text-[12px] text-white font-extrabold mb-2">{title}</div>

      {!pts.length ? (
        <div className="text-sm text-white/60 p-4">No odds history available for this side.</div>
      ) : (
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={pts} margin={{ top: 10, right: 18, left: 0, bottom: 10 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.10)" strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                tick={{ fill: "rgba(255,255,255,0.65)", fontSize: 10 }}
                interval="preserveStartEnd"
                minTickGap={18}
              />
              <YAxis tick={{ fill: "rgba(255,255,255,0.65)", fontSize: 10 }} width={40} domain={["auto", "auto"]} />
              <Tooltip content={<HistoryTooltip market={market} />} />
              <Legend wrapperStyle={{ color: "rgba(255,255,255,0.75)", fontSize: 11 }} />
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
      )}
    </div>
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {chart(leftTitle, leftPoints)}
      {chart(rightTitle, rightPoints)}
    </div>
  );
}

/* -------------------------
   Predictions
------------------------- */

type MonteCarloRow = {
  event_id: string;
  run_id?: string | null;
  commence_time?: string | null;
  matchup?: string | null;
  home_team?: string | null;
  away_team?: string | null;

  projected_home_points?: number | null;
  projected_away_points?: number | null;

  home_win_prob?: number | null;
  away_win_prob?: number | null;

  projected_margin_home?: number | null;
  projected_total?: number | null;

  spread_line_home?: number | null;
  home_cover_prob?: number | null;
  cover_push_prob?: number | null;
  away_cover_prob?: number | null;

  total_line?: number | null;
  over_prob?: number | null;
  total_push_prob?: number | null;
  under_prob?: number | null;
};

type MlAdjustmentRow = {
  event_id: string;
  run_id: string;
  base_home_win_prob: number | null;
  base_away_win_prob: number | null;
  adj_home_win_prob: number | null;
  adj_away_win_prob: number | null;
  base_home_cover_prob: number | null;
  base_away_cover_prob: number | null;
  adj_home_cover_prob: number | null;
  adj_away_cover_prob: number | null;
  base_over_prob: number | null;
  base_under_prob: number | null;
  adj_over_prob: number | null;
  adj_under_prob: number | null;
};

const pct = (v01: number | null | undefined) => (v01 == null ? "—" : formatPercent(v01 * 100, 1));
const fmtBaseAdj = (base: number | null | undefined, adj: number | null | undefined) => {
  const baseTxt = pct(toProb01(base ?? null));
  if (adj == null || !Number.isFinite(adj)) return `Base ${baseTxt}`;
  return `Base ${baseTxt} • AI ${pct(toProb01(adj))}`;
};
function winColors(awayP: number | null, homeP: number | null) {
  if (awayP == null || homeP == null) return { awayHex: "rgba(255,255,255,0.85)", homeHex: "rgba(255,255,255,0.85)" };
  if (awayP > homeP) return { awayHex: "#34d399", homeHex: "#f87171" };
  if (homeP > awayP) return { awayHex: "#f87171", homeHex: "#34d399" };
  return { awayHex: "rgba(255,255,255,0.85)", homeHex: "rgba(255,255,255,0.85)" };
}

function WinSplitMeter({
  awayP,
  homeP,
  awayLabel,
  homeLabel,
  awayColor,
  homeColor,
  scoreText,
}: {
  awayP: number | null;
  homeP: number | null;
  awayLabel: string;
  homeLabel: string;
  awayColor: string;
  homeColor: string;
  scoreText: string;
}) {
  const a = awayP ?? 0.5;
  const h = homeP ?? 0.5;
  const total = a + h || 1;
  const aN = Math.max(0, Math.min(1, a / total));
  const hN = Math.max(0, Math.min(1, h / total));

  return (
    <div className="w-full">
      <div className="flex items-center justify-between text-[11px] font-extrabold">
        <div className="truncate" style={{ color: awayColor }}>
          {awayLabel} <span className="text-white/70 font-semibold">({pct(awayP)})</span>
        </div>
        <div className="truncate text-right" style={{ color: homeColor }}>
          {homeLabel} <span className="text-white/70 font-semibold">({pct(homeP)})</span>
        </div>
      </div>

      <div className="mt-2 relative h-4 rounded-full border border-white/10 bg-black/35 overflow-hidden shadow-[0_10px_35px_rgba(0,0,0,0.35)]">
        <div className="absolute inset-y-0 left-0" style={{ width: `${aN * 100}%`, background: awayColor, opacity: 0.9 }} />
        <div className="absolute inset-y-0 right-0" style={{ width: `${hN * 100}%`, background: homeColor, opacity: 0.9 }} />

        <div className="absolute top-[-4px] bottom-[-4px] left-1/2 w-[2px] bg-white/85" />
        <div className="absolute top-[-2px] left-1/2 -translate-x-1/2 w-3 h-3 rounded-full border border-white/70 bg-[#0f0f0f]" />
      </div>

      <div className="mt-2 flex items-center justify-between">
        <div className="text-[11px] text-white/60 font-semibold">Projected Score</div>
        <div className="text-white font-extrabold tabular-nums text-[14px]">{scoreText}</div>
      </div>
    </div>
  );
}

/* -------------------------
   Last 5 (same as prior rewrite)
------------------------- */

type TeamGameRow = {
  dateIso: string;
  opponent: string;
  isHome: boolean;
  teamPts: number;
  oppPts: number;
  result: "W" | "L";
};

function parseYmdToIso(ymdLike: any): string | null {
  if (ymdLike == null) return null;
  const s = String(ymdLike).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return null;
}

function fmtGameDateShort(dateIso: string) {
  const d = new Date(`${dateIso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateIso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isCompletedScore(a: any, b: any) {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0);
}

function mapTeamGameRowsFromAny({
  raw,
  team,
}: {
  raw: any[];
  team: string;
}): TeamGameRow[] {
  const out: TeamGameRow[] = [];
  const nowYmd = ctTodayYmd();
  const nowMs = new Date(`${nowYmd}T23:59:59Z`).getTime();

  for (const r of raw) {
    const dateIso =
      parseYmdToIso(pickAny(r, ["date", "game_date", "Date", "dt", "gameDay", "day"])) ?? null;
    if (!dateIso) continue;

    const dateMs = new Date(`${dateIso}T12:00:00Z`).getTime();
    if (!Number.isFinite(dateMs)) continue;
    if (dateMs > nowMs) continue;

    const away = pickAny(r, ["away_team", "away", "team1", "team1_away", "Team1 (Away)", "team1 (away)"]) ?? "";
    const home = pickAny(r, ["home_team", "home", "team2", "team2_home", "Team2 (Home)", "team2 (home)"]) ?? "";

    const awayTeam = String(away ?? "").trim();
    const homeTeam = String(home ?? "").trim();
    if (!awayTeam && !homeTeam) continue;

    const teamLc = team.trim().toLowerCase();
    const isAway = awayTeam.trim().toLowerCase() === teamLc;
    const isHome = homeTeam.trim().toLowerCase() === teamLc;
    if (!isAway && !isHome) continue;

    const awayPts = pickAny(r, ["away_pts", "away_points", "score1", "Score1", "pts_away", "points_away"]);
    const homePts = pickAny(r, ["home_pts", "home_points", "score2", "Score2", "pts_home", "points_home"]);
    if (!isCompletedScore(awayPts, homePts)) continue;

    const a = Number(awayPts);
    const h = Number(homePts);

    const teamPts = isAway ? a : h;
    const oppPts = isAway ? h : a;
    const opponent = isAway ? homeTeam : awayTeam;

    const result: "W" | "L" = teamPts > oppPts ? "W" : "L";
    out.push({ dateIso, opponent, isHome, teamPts, oppPts, result });
  }

  out.sort((x, y) => (x.dateIso < y.dateIso ? 1 : x.dateIso > y.dateIso ? -1 : 0));
  return out;
}

async function fetchLast5ForTeam({
  sportKey,
  team,
}: {
  sportKey: string;
  team: string;
}): Promise<{ games: TeamGameRow[]; sourceTable: string | null; error: string | null }> {
  const teamSafe = team?.trim();
  if (!teamSafe) return { games: [], sourceTable: null, error: "Missing team name." };

  const candidates: Array<{ table: string; dateCol: string; colA: string; colB: string }> =
    sportKey === "basketball_nba"
      ? [{ table: "basketballref_games_nba", dateCol: "date", colA: "away_team", colB: "home_team" }]
      : sportKey === "basketball_ncaab"
      ? [
          { table: "kenpom_games", dateCol: "date", colA: "team1", colB: "team2" },
          { table: "kenpom_games", dateCol: "date", colA: "team1_away", colB: "team2_home" },
          { table: "kenpom_games", dateCol: "Date", colA: "Team1 (Away)", colB: "Team2 (Home)" },
        ]
      : [
          { table: "basketballref_games_nba", dateCol: "date", colA: "away_team", colB: "home_team" },
          { table: "kenpom_games", dateCol: "date", colA: "team1", colB: "team2" },
        ];

  let lastErr: string | null = null;

  for (const c of candidates) {
    try {
      const { data, error } = await supabase
        .from(c.table)
        .select("*")
        .or(`${c.colA}.eq.${teamSafe},${c.colB}.eq.${teamSafe}`)
        .order(c.dateCol as any, { ascending: false })
        .limit(60);

      if (error) {
        lastErr = error.message;
        continue;
      }

      const rows = data ?? [];
      const mapped = mapTeamGameRowsFromAny({ raw: rows, team: teamSafe }).slice(0, 5);
      if (mapped.length) return { games: mapped, sourceTable: c.table, error: null };
    } catch (e: any) {
      lastErr = String(e?.message ?? e ?? "Unknown error");
      continue;
    }
  }

  return { games: [], sourceTable: null, error: lastErr ?? "No recent games found." };
}

function Last5Panel({
  title,
  teamName,
  games,
  loading,
  error,
}: {
  title: string;
  teamName: string;
  games: TeamGameRow[];
  loading: boolean;
  error: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/35 backdrop-blur-[4px] p-4 shadow-[0_14px_55px_rgba(0,0,0,0.40)]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-white font-extrabold text-[13px]">{title}</div>
          <div className="text-[11px] text-white/60 font-semibold mt-0.5 truncate">{teamName}</div>
        </div>
        <div className="text-[10px] text-white/50 font-semibold">Last 5</div>
      </div>

      {loading ? (
        <div className="mt-3 text-sm text-white/60">Loading recent games…</div>
      ) : error ? (
        <div className="mt-3 text-sm text-red-400">Couldn’t load: {error}</div>
      ) : !games.length ? (
        <div className="mt-3 text-sm text-white/60">No completed games found.</div>
      ) : (
        <div className="mt-3 space-y-2">
          {games.map((g) => {
            const badge =
              g.result === "W"
                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                : "bg-red-500/15 text-red-300 border-red-500/30";
            const at = g.isHome ? "vs" : "@";
            return (
              <div key={`${g.dateIso}-${g.opponent}-${g.result}`} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[12px] text-white font-extrabold">
                    {fmtGameDateShort(g.dateIso)}{" "}
                    <span className="text-white/40 font-semibold">•</span>{" "}
                    <span className="text-white/75 font-semibold">
                      {at} {g.opponent}
                    </span>
                  </div>
                  <div className="text-[11px] text-white/60 font-semibold tabular-nums">
                    {g.teamPts}-{g.oppPts}
                  </div>
                </div>

                <div className={`shrink-0 px-2 py-1 rounded-md border text-[11px] font-extrabold ${badge}`}>
                  {g.result}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* -------------------------
   Player Props aggregation (same as prior rewrite)
------------------------- */

type PropMarket = "Points" | "Rebounds" | "Assists" | "3 Pointers";
const PROP_MARKETS: PropMarket[] = ["Points", "Rebounds", "Assists", "3 Pointers"];

function canonPropMarket(m: PropMarket) {
  if (m === "Points") return ["points", "player_points", "pts"];
  if (m === "Rebounds") return ["rebounds", "player_rebounds", "reb"];
  if (m === "Assists") return ["assists", "player_assists", "ast"];
  return ["threes", "3pm", "player_threes", "3_pointers", "3-pointers"];
}
function normalizeSideOU(s: string | null): "over" | "under" | null {
  if (!s) return null;
  const v = s.toLowerCase();
  if (v.includes("over")) return "over";
  if (v.includes("under")) return "under";
  return null;
}

type PropCell = { odds: number | null; line: number | null; ts: string | null };
type PropAggRow = {
  player_name: string;
  team: string | null;
  position: string | null;
  picture_url: string | null;

  over: Record<BookKey, PropCell>;
  under: Record<BookKey, PropCell>;

  display_line: number | null;
};

function emptyPropCell(): PropCell {
  return { odds: null, line: null, ts: null };
}
function emptyPropSide(): Record<BookKey, PropCell> {
  return { dk: emptyPropCell(), fd: emptyPropCell(), mgm: emptyPropCell(), pin: emptyPropCell(), bol: emptyPropCell() };
}
function bestCell(a: PropCell, b: PropCell): PropCell {
  const ta = a.ts ? new Date(a.ts).getTime() : 0;
  const tb = b.ts ? new Date(b.ts).getTime() : 0;
  if (tb > ta) return b;
  if (ta > tb) return a;
  if (b.odds != null && a.odds == null) return b;
  return a;
}
function fmtLineOdds(line: number | null, odds: number | null, fmt: OddsFormat) {
  if (line == null && odds == null) return "—";
  const price = fmtPrice(odds, fmt);
  if (line == null) return price === "—" ? "—" : price;
  if (price === "—") return String(line);
  return `${line} (${price})`;
}

/* =========================================================
   GAME DETAILS MODAL (tabs)
========================================================= */

function GameDetailsModal({
  sportKey,
  ev,
  oddsFormat,
  useAiAdjusted,
  initialTab = "pred",
  mode,
  showTabs = true,
  initialTab = "pred",
  onClose,
}: {
  sportKey: string;
  ev: EventOdds;
  oddsFormat: OddsFormat;
  useAiAdjusted: boolean;
  initialTab?: DetailsTab;
  mode?: DetailsTab;
  showTabs?: boolean;
  onClose: () => void;
}) {
  const forcedTab = mode ?? initialTab;
  const [tab, setTab] = useState<DetailsTab>(forcedTab);

  useEffect(() => {
    setTab(forcedTab);
  }, [forcedTab]);
  initialTab?: DetailsTab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DetailsTab>(initialTab);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  // line movement state
  const [lmMarket, setLmMarket] = useState<Market>("ml");
  const [lmLoading, setLmLoading] = useState(true);
  const [lmError, setLmError] = useState("");
  const [lmAwayRows, setLmAwayRows] = useState<HistoryRow[]>([]);
  const [lmHomeRows, setLmHomeRows] = useState<HistoryRow[]>([]);

  // predictions state
  const [predLoading, setPredLoading] = useState(true);
  const [predError, setPredError] = useState("");
  const [predRow, setPredRow] = useState<MonteCarloRow | null>(null);
  const [basePredRow, setBasePredRow] = useState<MonteCarloRow | null>(null);
  const [adjPredRow, setAdjPredRow] = useState<MonteCarloRow | null>(null);

  // last-5 state
  const [l5AwayLoading, setL5AwayLoading] = useState(false);
  const [l5HomeLoading, setL5HomeLoading] = useState(false);
  const [l5AwayErr, setL5AwayErr] = useState("");
  const [l5HomeErr, setL5HomeErr] = useState("");
  const [l5Away, setL5Away] = useState<TeamGameRow[]>([]);
  const [l5Home, setL5Home] = useState<TeamGameRow[]>([]);

  // props state
  const [propMarket, setPropMarket] = useState<PropMarket>("Points");
  const [propsLoading, setPropsLoading] = useState(true);
  const [propsError, setPropsError] = useState("");
  const [propsAgg, setPropsAgg] = useState<PropAggRow[]>([]);

  const subtitle = `${ev.away?.team ?? "Away"} vs ${ev.home?.team ?? "Home"} • ${fmtCTDateTime(ev.commenceTime)} CT`;

  // sticky stacking support for prop market bar
  const tabsBarRef = useRef<HTMLDivElement | null>(null);
  const [tabsBarH, setTabsBarH] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      const tabsH = tabsBarRef.current?.getBoundingClientRect().height ?? 0;
      setTabsBarH(Math.ceil(tabsH));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (tabsBarRef.current) ro.observe(tabsBarRef.current);
    return () => ro.disconnect();
  }, []);

  // Line movement fetch
  useEffect(() => {
    if (tab !== "line") return;
    let alive = true;

    setLmLoading(true);
    setLmError("");

    (async () => {
      const res = await fetchOddsHistoryAnyTable({ sportKey, eventId: ev.eventId });
      if (!alive) return;

      if (res.error || !res.table) {
        setLmAwayRows([]);
        setLmHomeRows([]);
        setLmError(res.error ?? "No odds history available.");
        setLmLoading(false);
        return;
      }

      const away = parseHistoryRows({ raw: res.rows, market: lmMarket, wantSide: "AWAY" });
      const home = parseHistoryRows({ raw: res.rows, market: lmMarket, wantSide: "HOME" });

      setLmAwayRows(away);
      setLmHomeRows(home);
      setLmLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [tab, sportKey, ev.eventId, lmMarket]);

  // Predictions fetch (+ last 5)
  useEffect(() => {
    if (tab !== "pred") return;
    let alive = true;

    setPredLoading(true);
    setPredError("");
    setPredRow(null);
    setBasePredRow(null);
    setAdjPredRow(null);

    (async () => {
      const { data, error } = await supabase
        .from("monte_carlo_results")
        .select("*")
        .eq("event_id", ev.eventId)
        .limit(1);

      if (!alive) return;

      if (error) {
        setPredError(error.message);
        setPredLoading(false);
        return;
      }

      const r = (data?.[0] ?? null) as any;
      if (!r) {
        setPredError("No Monte Carlo row found for this event.");
        setPredLoading(false);
        return;
      }

      const baseRow: MonteCarloRow = {
        event_id: String(r.event_id ?? ev.eventId),
        run_id: r.run_id ?? null,
        commence_time: r.commence_time ?? r.commenceTime ?? null,
        matchup: r.matchup ?? null,
        home_team: r.home_team ?? r.homeTeam ?? null,
        away_team: r.away_team ?? r.awayTeam ?? null,

        projected_home_points: safeNumberOrNull(r.projected_home_points),
        projected_away_points: safeNumberOrNull(r.projected_away_points),

        home_win_prob: safeNumberOrNull(r.home_win_prob),
        away_win_prob: safeNumberOrNull(r.away_win_prob),

        projected_margin_home: safeNumberOrNull(r.projected_margin_home),
        projected_total: safeNumberOrNull(r.projected_total),

        spread_line_home: safeNumberOrNull(r.spread_line_home),
        home_cover_prob: safeNumberOrNull(r.home_cover_prob),
        cover_push_prob: safeNumberOrNull(r.cover_push_prob),
        away_cover_prob: safeNumberOrNull(r.away_cover_prob),

        total_line: safeNumberOrNull(r.total_line),
        over_prob: safeNumberOrNull(r.over_prob),
        total_push_prob: safeNumberOrNull(r.total_push_prob),
        under_prob: safeNumberOrNull(r.under_prob),
      };

      setBasePredRow(baseRow);

      let adjustedRow: MonteCarloRow | null = null;
      if (baseRow.run_id) {
        const { data: mlData, error: mlErr } = await supabase
          .from("model_ml_adjustments")
          .select(
            [
              "event_id",
              "run_id",
              "adj_home_win_prob",
              "adj_away_win_prob",
              "adj_home_cover_prob",
              "adj_away_cover_prob",
              "adj_over_prob",
              "adj_under_prob",
            ].join(",")
          )
          .eq("event_id", baseRow.event_id)
          .eq("run_id", baseRow.run_id)
          .limit(1);

        if (!mlErr && mlData?.[0]) {
          const ml = mlData[0] as MlAdjustmentRow;
          adjustedRow = {
            ...baseRow,
            home_win_prob: ml.adj_home_win_prob ?? baseRow.home_win_prob,
            away_win_prob: ml.adj_away_win_prob ?? baseRow.away_win_prob,
            home_cover_prob: ml.adj_home_cover_prob ?? baseRow.home_cover_prob,
            away_cover_prob: ml.adj_away_cover_prob ?? baseRow.away_cover_prob,
            over_prob: ml.adj_over_prob ?? baseRow.over_prob,
            under_prob: ml.adj_under_prob ?? baseRow.under_prob,
          };
        }
      }

      setAdjPredRow(adjustedRow);
      setPredRow(useAiAdjusted ? adjustedRow ?? baseRow : baseRow);
      setPredLoading(false);

      const awayTeam = (ev.away?.team ?? baseRow.away_team ?? "").trim();
      const homeTeam = (ev.home?.team ?? baseRow.home_team ?? "").trim();

      if (awayTeam) {
        setL5AwayLoading(true);
        setL5AwayErr("");
        fetchLast5ForTeam({ sportKey, team: awayTeam })
          .then((res) => {
            if (!alive) return;
            setL5Away(res.games);
            setL5AwayErr(res.error ?? "");
          })
          .catch((e: any) => {
            if (!alive) return;
            setL5Away([]);
            setL5AwayErr(String(e?.message ?? e ?? "Unknown error"));
          })
          .finally(() => {
            if (!alive) return;
            setL5AwayLoading(false);
          });
      } else {
        setL5Away([]);
        setL5AwayErr("Missing away team name.");
      }

      if (homeTeam) {
        setL5HomeLoading(true);
        setL5HomeErr("");
        fetchLast5ForTeam({ sportKey, team: homeTeam })
          .then((res) => {
            if (!alive) return;
            setL5Home(res.games);
            setL5HomeErr(res.error ?? "");
          })
          .catch((e: any) => {
            if (!alive) return;
            setL5Home([]);
            setL5HomeErr(String(e?.message ?? e ?? "Unknown error"));
          })
          .finally(() => {
            if (!alive) return;
            setL5HomeLoading(false);
          });
      } else {
        setL5Home([]);
        setL5HomeErr("Missing home team name.");
      }
    })();

    return () => {
      alive = false;
    };
  }, [tab, ev.eventId, sportKey, ev.away?.team, ev.home?.team, useAiAdjusted]);

  // Props fetch
  useEffect(() => {
    if (tab !== "props") return;
    let alive = true;

    setPropsLoading(true);
    setPropsError("");
    setPropsAgg([]);

    (async () => {
      const snap = await supabase
        .from("player_props_snapshot")
        .select("*")
        .eq("sport_key", sportKey)
        .eq("event_id", ev.eventId);

      if (!alive) return;

      if (snap.error) {
        setPropsError(snap.error.message);
        setPropsLoading(false);
        return;
      }

      const raw = snap.data ?? [];
      const wanted = canonPropMarket(propMarket);

      const norm = raw
        .map((r: any) => {
          const player_name = String(r.player_name ?? r.player ?? r.name ?? "").trim();
          if (!player_name) return null;

          const mRaw = String(r.market ?? r.market_key ?? r.marketRaw ?? r.prop_type ?? "").toLowerCase();
          if (!mRaw) return null;
          if (!wanted.some((k) => mRaw.includes(k))) return null;

          const book = bookKeyFromRaw(String(r.bookmaker ?? r.book ?? r.sportsbook ?? r.provider ?? ""));
          if (!book) return null;

          const side = normalizeSideOU(String(r.side ?? r.bet_side ?? r.over_under ?? r.ou ?? "")) ?? null;
          if (!side) return null;

          const line = pickLine(r);
          const odds = pickOdds(r);
          const ts = normalizeIso(r.ts ?? r.snapshot_ts ?? r.inserted_at ?? null);

          const team = (r.team ?? r.player_team ?? null) as string | null;

          return { player_name, team, book, side, line, odds, ts };
        })
        .filter(Boolean) as Array<{
        player_name: string;
        team: string | null;
        book: BookKey;
        side: "over" | "under";
        line: number | null;
        odds: number | null;
        ts: string | null;
      }>;

      const names = Array.from(new Set(norm.map((x) => x.player_name)));
      const metaMap = new Map<string, { position: string | null; picture_url: string | null; team: string | null }>();

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

      const byPlayer = new Map<string, PropAggRow>();

      for (const r of norm) {
        const cur =
          byPlayer.get(r.player_name) ??
          ({
            player_name: r.player_name,
            team: metaMap.get(r.player_name)?.team ?? r.team ?? null,
            position: metaMap.get(r.player_name)?.position ?? null,
            picture_url: metaMap.get(r.player_name)?.picture_url ?? null,
            over: emptyPropSide(),
            under: emptyPropSide(),
            display_line: null,
          } as PropAggRow);

        const mm = metaMap.get(r.player_name);
        if (mm) {
          cur.team = mm.team ?? cur.team;
          cur.position = mm.position ?? cur.position;
          cur.picture_url = mm.picture_url ?? cur.picture_url;
        }

        const cell: PropCell = { odds: r.odds, line: r.line, ts: r.ts };

        if (r.side === "over") cur.over[r.book] = bestCell(cur.over[r.book], cell);
        else cur.under[r.book] = bestCell(cur.under[r.book], cell);

        byPlayer.set(r.player_name, cur);
      }

      const out = Array.from(byPlayer.values()).map((row) => {
        const lines: number[] = [];
        for (const bk of BOOKS) {
          const ol = row.over[bk]?.line;
          const ul = row.under[bk]?.line;
          if (typeof ol === "number") lines.push(ol);
          if (typeof ul === "number") lines.push(ul);
        }
        row.display_line = median(lines) ?? (lines[0] ?? null);
        return row;
      });

      out.sort((a, b) => a.player_name.localeCompare(b.player_name));

      if (!alive) return;
      setPropsAgg(out);
      setPropsLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [tab, sportKey, ev.eventId, propMarket]);

  const awayTeam = ev.away?.team ?? predRow?.away_team ?? "Away";
  const homeTeam = ev.home?.team ?? predRow?.home_team ?? "Home";
  const awayLogo = ev.away?.logoUrl ?? null;
  const homeLogo = ev.home?.logoUrl ?? null;

  const awayP = toProb01(predRow?.away_win_prob ?? null);
  const homeP = toProb01(predRow?.home_win_prob ?? null);
  const colors = winColors(awayP, homeP);

  const scoreText =
    predRow?.projected_away_points == null || predRow?.projected_home_points == null
      ? "—"
      : `${predRow.projected_away_points.toFixed(1)} - ${predRow.projected_home_points.toFixed(1)}`;

  const lmAwayPoints = useMemo(() => buildSeries(lmAwayRows), [lmAwayRows]);
  const lmHomePoints = useMemo(() => buildSeries(lmHomeRows), [lmHomeRows]);

  // Key Lines derived from board consensus (no Quantum ML block)
  const consMlAway = consensusPartsForRow(ev, "ml", "AWAY", oddsFormat);
  const consMlHome = consensusPartsForRow(ev, "ml", "HOME", oddsFormat);
  const consSprAway = consensusPartsForRow(ev, "spread", "AWAY", oddsFormat);
  const consSprHome = consensusPartsForRow(ev, "spread", "HOME", oddsFormat);
  const consTotOver = consensusPartsForRow(ev, "total", "AWAY", oddsFormat);
  const consTotUnder = consensusPartsForRow(ev, "total", "HOME", oddsFormat);

  const modalTitle =
    mode === "line" ? "Line Movement" : mode === "props" ? "Player Props" : "Game Details";

  return (
    <ModalShell title={modalTitle} subtitle={subtitle} onClose={onClose}>
      {showTabs ? (
        <div
          className="sticky top-0 z-50 -mx-3 sm:-mx-4 px-3 sm:px-4 pt-2 pb-2 border-b border-white/10
                     bg-black/70 backdrop-blur-[8px] shadow-[0_14px_40px_rgba(0,0,0,0.65)]"
        >
          <div ref={tabsBarRef} className="flex flex-wrap items-center gap-2">
            <TabBtn active={tab === "pred"} onClick={() => setTab("pred")}>
              Predictions
            </TabBtn>
            <TabBtn active={tab === "line"} onClick={() => setTab("line")}>
              Line Movement
            </TabBtn>
            <TabBtn active={tab === "props"} onClick={() => setTab("props")}>
              Player Props
            </TabBtn>
          </div>
        </div>
      ) : null}

      {/* LINE MOVEMENT */}
      {tab === "line" && (
        <div className="pt-3">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <SelectPill
              value={lmMarket}
              onChange={(v) => setLmMarket(v as Market)}
              options={[
                { value: "ml", label: "Moneyline" },
                { value: "spread", label: "Spread" },
                { value: "total", label: "Total" },
              ]}
              label="Market"
            />
            <div className="text-[11px] text-white/60 font-semibold">
              {lmMarket === "total" ? (
                <>
                  Left = <span className="text-white font-extrabold">Over</span>, Right ={" "}
                  <span className="text-white font-extrabold">Under</span>
                </>
              ) : (
                <>
                  Left = <span className="text-white font-extrabold">Away</span>, Right ={" "}
                  <span className="text-white font-extrabold">Home</span>
                </>
              )}
            </div>
          </div>

          {lmLoading ? (
            <div className="text-sm text-white/60 p-4">Loading odds history…</div>
          ) : lmError ? (
            <div className="text-sm text-red-400 p-4">No odds history available: {lmError}</div>
          ) : (
            <SideBySideLineCharts
              leftTitle={lmMarket === "total" ? `Over • ${awayTeam}` : `Away • ${awayTeam}`}
              rightTitle={lmMarket === "total" ? `Under • ${homeTeam}` : `Home • ${homeTeam}`}
              leftPoints={lmAwayPoints}
              rightPoints={lmHomePoints}
              market={lmMarket}
            />
          )}
        </div>
      )}

      {/* PREDICTIONS */}
      {tab === "pred" && (
        <div className="pt-3 space-y-3">
          {predLoading ? (
            <div className="text-sm text-white/60 p-4">Loading Monte Carlo predictions…</div>
          ) : predError ? (
            <div className="text-sm text-red-400 p-4">Supabase error: {predError}</div>
          ) : !predRow ? (
            <div className="text-sm text-white/60 p-4">No predictions available for this game.</div>
          ) : (
            <>
              {/* Key Lines (consensus only) */}
              <div className="rounded-2xl border border-white/10 bg-black/35 backdrop-blur-[4px] p-4 shadow-[0_14px_55px_rgba(0,0,0,0.40)]">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-white font-extrabold text-[13px]">Key Lines</div>
                    <div className="text-[11px] text-white/60 font-semibold mt-0.5">
                      Consensus lines in one place
                    </div>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-1 lg:grid-cols-3 gap-2">
                  <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] text-white/60 font-semibold">Consensus ML</div>
                    <div className="mt-1 text-white font-extrabold tabular-nums text-[12px]">
                      {awayTeam}: {consMlAway.top} • {homeTeam}: {consMlHome.top}
                    </div>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] text-white/60 font-semibold">Consensus Spread</div>
                    <div className="mt-1 text-white font-extrabold tabular-nums text-[12px]">
                      {awayTeam}: {consSprAway.top}{" "}
                      {consSprAway.bottom ? <span className="text-white/60">({consSprAway.bottom})</span> : null}
                      <span className="text-white/30 mx-2">|</span>
                      {homeTeam}: {consSprHome.top}{" "}
                      {consSprHome.bottom ? <span className="text-white/60">({consSprHome.bottom})</span> : null}
                    </div>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] text-white/60 font-semibold">Consensus Total</div>
                    <div className="mt-1 text-white font-extrabold tabular-nums text-[12px]">
                      Over: {consTotOver.top}{" "}
                      {consTotOver.bottom ? <span className="text-white/60">({consTotOver.bottom})</span> : null}
                      <span className="text-white/30 mx-2">|</span>
                      Under: {consTotUnder.top}{" "}
                      {consTotUnder.bottom ? <span className="text-white/60">({consTotUnder.bottom})</span> : null}
                    </div>
                  </div>
                </div>
              </div>

              {/* Win% meter */}
              <div className="rounded-2xl border border-white/10 bg-black/35 backdrop-blur-[4px] p-4 shadow-[0_14px_55px_rgba(0,0,0,0.40)]">
                {/* MOBILE: compact row above bar */}
                <div className="lg:hidden">
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div className="flex items-center gap-2 min-w-0">
                      {awayLogo ? (
                        <img
                          src={awayLogo}
                          alt={`${awayTeam} logo`}
                          className="w-8 h-8 rounded-md object-contain bg-white border border-[#e5e5e5] p-1 shadow-[0_10px_35px_rgba(0,0,0,0.35)]"
                          loading="lazy"
                          onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-md bg-white/5 border border-white/10" />
                      )}
                      <div className="min-w-0">
                        <div className="text-white font-extrabold text-[12px] truncate">{awayTeam}</div>
                        <div className="text-[10px] text-white/60 font-semibold">
                          QML:{" "}
                          <span className="font-extrabold tabular-nums" style={{ color: colors.awayHex }}>
                            {probToAmerican(awayP)}
                          </span>
                        </div>
                        <div className="text-[10px] text-white/50 font-semibold">{fmtBaseAdj(basePredRow?.away_win_prob, adjPredRow?.away_win_prob)}</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 justify-end min-w-0">
                      <div className="min-w-0 text-right">
                        <div className="text-white font-extrabold text-[12px] truncate">{homeTeam}</div>
                        <div className="text-[10px] text-white/60 font-semibold">
                          QML:{" "}
                          <span className="font-extrabold tabular-nums" style={{ color: colors.homeHex }}>
                            {probToAmerican(homeP)}
                          </span>
                        </div>
                        <div className="text-[10px] text-white/50 font-semibold">{fmtBaseAdj(basePredRow?.home_win_prob, adjPredRow?.home_win_prob)}</div>
                      </div>
                      {homeLogo ? (
                        <img
                          src={homeLogo}
                          alt={`${homeTeam} logo`}
                          className="w-8 h-8 rounded-md object-contain bg-white border border-[#e5e5e5] p-1 shadow-[0_10px_35px_rgba(0,0,0,0.35)]"
                          loading="lazy"
                          onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-md bg-white/5 border border-white/10" />
                      )}
                    </div>
                  </div>

                  <WinSplitMeter
                    awayP={awayP}
                    homeP={homeP}
                    awayLabel="Away"
                    homeLabel="Home"
                    awayColor={colors.awayHex}
                    homeColor={colors.homeHex}
                    scoreText={scoreText}
                  />
                </div>

                {/* DESKTOP */}
                <div className="hidden lg:grid grid-cols-[1fr_520px_1fr] gap-4 items-center">
                  <div className="flex items-center gap-3">
                    {awayLogo ? (
                      <img
                        src={awayLogo}
                        alt={`${awayTeam} logo`}
                        className="w-12 h-12 rounded-md object-contain bg-white border border-[#e5e5e5] p-1 shadow-[0_10px_35px_rgba(0,0,0,0.35)]"
                        loading="lazy"
                        onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-md bg-white/5 border border-white/10" />
                    )}
                    <div className="min-w-0">
                      <div className="text-white font-extrabold text-[14px] truncate">{awayTeam}</div>
                      <div className="text-[11px] text-white/60 font-semibold">
                        Quantum ML:{" "}
                        <span className="text-white font-extrabold tabular-nums" style={{ color: colors.awayHex }}>
                          {probToAmerican(awayP)}
                        </span>
                      </div>
                      <div className="text-[10px] text-white/50 font-semibold">{fmtBaseAdj(basePredRow?.away_win_prob, adjPredRow?.away_win_prob)}</div>
                    </div>
                  </div>

                  <WinSplitMeter
                    awayP={awayP}
                    homeP={homeP}
                    awayLabel="Away"
                    homeLabel="Home"
                    awayColor={colors.awayHex}
                    homeColor={colors.homeHex}
                    scoreText={scoreText}
                  />

                  <div className="flex items-center gap-3 justify-end">
                    <div className="min-w-0 text-right">
                      <div className="text-white font-extrabold text-[14px] truncate">{homeTeam}</div>
                      <div className="text-[11px] text-white/60 font-semibold">
                        Quantum ML:{" "}
                        <span className="text-white font-extrabold tabular-nums" style={{ color: colors.homeHex }}>
                          {probToAmerican(homeP)}
                        </span>
                      </div>
                      <div className="text-[10px] text-white/50 font-semibold">{fmtBaseAdj(basePredRow?.home_win_prob, adjPredRow?.home_win_prob)}</div>
                    </div>
                    {homeLogo ? (
                      <img
                        src={homeLogo}
                        alt={`${homeTeam} logo`}
                        className="w-12 h-12 rounded-md object-contain bg-white border border-[#e5e5e5] p-1 shadow-[0_10px_35px_rgba(0,0,0,0.35)]"
                        loading="lazy"
                        onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-md bg-white/5 border border-white/10" />
                    )}
                  </div>
                </div>
              </div>

              {/* Spread + Total probabilities */}
              <div className="rounded-2xl border border-white/10 bg-black/35 backdrop-blur-[4px] p-4 shadow-[0_14px_55px_rgba(0,0,0,0.40)]">
                <div className="text-white font-extrabold text-[13px]">Model Probabilities</div>

                <div className="mt-3">
                  <div className="flex items-center justify-between">
                    <div className="text-white font-extrabold text-[12px]">Spread</div>
                    <div className="text-[11px] text-white/60 font-semibold">
                      Line (H): <span className="text-white font-extrabold tabular-nums">{predRow.spread_line_home ?? "—"}</span>
                      <span className="mx-2 text-white/30">|</span>
                      Proj Margin (H):{" "}
                      <span className="text-white font-extrabold tabular-nums">
                        {predRow.projected_margin_home == null ? "—" : predRow.projected_margin_home.toFixed(1)}
                      </span>
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <div className="rounded-md border border-white/10 bg-black/30 p-2 text-center">
                      <div className="text-[10px] text-white/60 font-semibold">{homeTeam}</div>
                      <div className="text-white font-extrabold tabular-nums text-[12px]">{pct(toProb01(predRow.home_cover_prob))}</div>
                      <div className="text-[9px] text-white/50 font-semibold mt-1">{fmtBaseAdj(basePredRow?.home_cover_prob, adjPredRow?.home_cover_prob)}</div>
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/30 p-2 text-center">
                      <div className="text-[10px] text-white/60 font-semibold">Push</div>
                      <div className="text-white font-extrabold tabular-nums text-[12px]">{pct(toProb01(predRow.cover_push_prob))}</div>
                      <div className="text-[9px] text-white/50 font-semibold mt-1">{fmtBaseAdj(basePredRow?.cover_push_prob, null)}</div>
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/30 p-2 text-center">
                      <div className="text-[10px] text-white/60 font-semibold">{awayTeam}</div>
                      <div className="text-white font-extrabold tabular-nums text-[12px]">{pct(toProb01(predRow.away_cover_prob))}</div>
                      <div className="text-[9px] text-white/50 font-semibold mt-1">{fmtBaseAdj(basePredRow?.away_cover_prob, adjPredRow?.away_cover_prob)}</div>
                    </div>
                  </div>
                </div>

                <div className="my-4 h-px bg-white/10" />

                <div>
                  <div className="flex items-center justify-between">
                    <div className="text-white font-extrabold text-[12px]">Total</div>
                    <div className="text-[11px] text-white/60 font-semibold">
                      Line: <span className="text-white font-extrabold tabular-nums">{predRow.total_line ?? "—"}</span>
                      <span className="mx-2 text-white/30">|</span>
                      Proj:{" "}
                      <span className="text-white font-extrabold tabular-nums">
                        {predRow.projected_total == null ? "—" : predRow.projected_total.toFixed(1)}
                      </span>
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <div className="rounded-md border border-white/10 bg-black/30 p-2 text-center">
                      <div className="text-[10px] text-white/60 font-semibold">Over</div>
                      <div className="text-white font-extrabold tabular-nums text-[12px]">{pct(toProb01(predRow.over_prob))}</div>
                      <div className="text-[9px] text-white/50 font-semibold mt-1">{fmtBaseAdj(basePredRow?.over_prob, adjPredRow?.over_prob)}</div>
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/30 p-2 text-center">
                      <div className="text-[10px] text-white/60 font-semibold">Push</div>
                      <div className="text-white font-extrabold tabular-nums text-[12px]">{pct(toProb01(predRow.total_push_prob))}</div>
                      <div className="text-[9px] text-white/50 font-semibold mt-1">{fmtBaseAdj(basePredRow?.total_push_prob, null)}</div>
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/30 p-2 text-center">
                      <div className="text-[10px] text-white/60 font-semibold">Under</div>
                      <div className="text-white font-extrabold tabular-nums text-[12px]">{pct(toProb01(predRow.under_prob))}</div>
                      <div className="text-[9px] text-white/50 font-semibold mt-1">{fmtBaseAdj(basePredRow?.under_prob, adjPredRow?.under_prob)}</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Last 5 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Last5Panel title="Away" teamName={awayTeam} games={l5Away} loading={l5AwayLoading} error={l5AwayErr} />
                <Last5Panel title="Home" teamName={homeTeam} games={l5Home} loading={l5HomeLoading} error={l5HomeErr} />
              </div>
            </>
          )}
        </div>
      )}

      {/* PROPS */}
      {tab === "props" && (
        <div className="pt-3">
          <div
            className="sticky z-40 -mx-3 sm:-mx-4 px-3 sm:px-4 pt-2 pb-2 border-b border-white/10
                     bg-black/70 backdrop-blur-[8px] shadow-[0_14px_40px_rgba(0,0,0,0.65)]"
            style={{ top: tabsBarH }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex overflow-hidden rounded-lg border border-white/10 bg-black/35">
                {PROP_MARKETS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`px-3 py-1.5 text-xs font-extrabold ${
                      propMarket === m ? "bg-[#d4af37] text-black" : "text-white"
                    }`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      setPropMarket(m);
                      (e.currentTarget as HTMLButtonElement).blur();
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>

              <div className="text-[11px] text-white/60 font-semibold">
                Odds shown in <span className="text-white font-extrabold">{oddsFormat === "american" ? "American" : "Decimal"}</span>
              </div>
            </div>
          </div>

          {propsLoading ? (
            <div className="text-sm text-white/60 p-4">Loading props…</div>
          ) : propsError ? (
            <div className="text-sm text-red-400 p-4">Supabase error: {propsError}</div>
          ) : !propsAgg.length ? (
            <div className="text-sm text-white/60 p-4">No props found for this game/market.</div>
          ) : (
            <div className="rounded-2xl border border-white/10 bg-black/35 backdrop-blur-[4px] overflow-hidden shadow-[0_14px_55px_rgba(0,0,0,0.40)]">
              {/* ✅ Props table owns vertical scroll so sticky header never “floats” with gaps */}
              <div className="overflow-auto" style={{ maxHeight: "calc(92vh - 240px)" }}>
                <table className="table-fixed min-w-[1100px] w-[1100px]">
                  <colgroup>
                    <col style={{ width: 260 }} />
                    <col style={{ width: 110 }} />
                    <col style={{ width: 90 }} />
                    <col style={{ width: 320 }} />
                    <col style={{ width: 320 }} />
                  </colgroup>

                  <thead className="sticky top-0 z-30 bg-black/80 backdrop-blur-[8px]">
                    <tr className="border-b border-white/10">
                      <th colSpan={5} className="px-4 py-2">
                        <div className="flex items-center justify-between min-w-[1100px]">
                          <div className="text-white font-extrabold text-sm">{propMarket}</div>
                          <div className="text-[11px] text-white/60 font-semibold">{propsAgg.length} players</div>
                        </div>
                      </th>
                    </tr>

                    <tr className="border-b border-white/10">
                      <th className="text-left px-4 py-2 text-[12px] text-white font-extrabold">Player</th>
                      <th className="text-left px-3 py-2 text-[12px] text-white font-extrabold">Team</th>
                      <th className="text-center px-3 py-2 text-[12px] text-white font-extrabold">Line</th>
                      <th className="text-center px-3 py-2 text-[12px] text-white font-extrabold">Over</th>
                      <th className="text-center px-3 py-2 text-[12px] text-white font-extrabold">Under</th>
                    </tr>

                    <tr className="border-b border-white/10">
                      <th />
                      <th />
                      <th />
                      <th className="px-3 pb-2">
                        <div className="grid grid-cols-5 gap-2 justify-items-center">
                          {BOOKS.map((b) => (
                            <div key={`ovh-${b}`} className="text-[10px] font-extrabold leading-none" style={{ color: BOOK_STROKES[b] }}>
                              {b.toUpperCase()}
                            </div>
                          ))}
                        </div>
                      </th>
                      <th className="px-3 pb-2">
                        <div className="grid grid-cols-5 gap-2 justify-items-center">
                          {BOOKS.map((b) => (
                            <div key={`unh-${b}`} className="text-[10px] font-extrabold leading-none" style={{ color: BOOK_STROKES[b] }}>
                              {b.toUpperCase()}
                            </div>
                          ))}
                        </div>
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {propsAgg.map((r) => (
                      <tr key={r.player_name} className="border-b border-white/10 hover:bg-white/6">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-3 min-w-0">
                            {r.picture_url ? (
                              <img
                                src={r.picture_url}
                                alt={r.player_name}
                                className="w-9 h-9 rounded-full object-cover border border-white/10 shadow-[0_10px_35px_rgba(0,0,0,0.35)]"
                                loading="lazy"
                                onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                              />
                            ) : (
                              <div className="w-9 h-9 rounded-full bg-white/5 border border-white/10" />
                            )}

                            <div className="min-w-0">
                              <div className="text-white font-extrabold text-[13px] truncate">{r.player_name}</div>
                              <div className="text-[11px] text-white/60 font-semibold">{r.position ?? "—"}</div>
                            </div>
                          </div>
                        </td>

                        <td className="px-3 py-2.5 text-white font-extrabold text-[12px]">{r.team ?? "—"}</td>

                        <td className="px-3 py-2.5 text-center text-white font-extrabold tabular-nums text-[12px]">
                          {r.display_line == null ? "—" : r.display_line}
                        </td>

                        <td className="px-3 py-2.5">
                          <div className="grid grid-cols-5 gap-2 justify-items-center">
                            {BOOKS.map((b) => (
                              <div key={`ov-${r.player_name}-${b}`} className="text-[12px] text-white font-extrabold tabular-nums">
                                {fmtLineOdds(r.over[b].line ?? r.display_line, r.over[b].odds, oddsFormat)}
                              </div>
                            ))}
                          </div>
                        </td>

                        <td className="px-3 py-2.5">
                          <div className="grid grid-cols-5 gap-2 justify-items-center">
                            {BOOKS.map((b) => (
                              <div key={`un-${r.player_name}-${b}`} className="text-[12px] text-white font-extrabold tabular-nums">
                                {fmtLineOdds(r.under[b].line ?? r.display_line, r.under[b].odds, oddsFormat)}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </ModalShell>
  );
} // ✅ CRITICAL: closes GameDetailsModal

/* =========================================================
   TOP NAV (sports tabs like reference)
========================================================= */

type SportTab = { key: string; label: string };
const SPORT_TABS: SportTab[] = [
  { key: "baseball_mlb", label: "MLB" },
  { key: "football_nfl", label: "NFL" },
  { key: "football_ncaaf", label: "NCAAF" },
  { key: "basketball_nba", label: "NBA" },
  { key: "basketball_ncaab", label: "NCAAM" },
  { key: "soccer", label: "Soccer" },
  { key: "mma_mixed_martial_arts", label: "UFC" },
];

const ODDS_SPORT_KEYS = new Set([
  "baseball_mlb",
  "football_nfl",
  "football_ncaaf",
  "basketball_nba",
  "basketball_ncaab",
  "icehockey_nhl",
]);

function isOddsSportKey(key: string): boolean {
  return ODDS_SPORT_KEYS.has(key);
}

function sportLabelForKey(sportKey: string) {
  if (sportKey === "basketball_nba") return "NBA";
  if (sportKey === "basketball_ncaab") return "NCAAM";
  if (sportKey === "football_nfl") return "NFL";
  if (sportKey === "football_ncaaf") return "NCAAF";
  if (sportKey === "icehockey_nhl") return "NHL";
  if (sportKey === "baseball_mlb") return "MLB";
  return "Sport";
}

/* =========================================================
   BOARD TABLE (reference-style)
========================================================= */

function DateSectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <tr>
      <td
        colSpan={BOOKS.length + 2}
        className="p-0"
        style={{
          position: "sticky",
          top: "var(--thead-h, 0px)",
          zIndex: 60,
          background: BOARD_STICKY_BG,
        }}
      >
        <div
          className="px-4 py-2 flex items-center justify-between border-y"
          style={{
            borderColor: PRISM_BORDER,
            background: BOARD_STICKY_BG,
            height: DATE_BAR_HEIGHT,
          }}
        >
          <div className="text-[11px] font-extrabold text-white/90">
            {label}
            <span className="text-white/50 font-semibold ml-2">({count} games)</span>
          </div>
          <div className="text-[10px] font-semibold text-white/45">Pre-Game</div>
      <td colSpan={BOOKS.length + 2} className="p-0">
        <div
          className="sticky top-0 z-20 px-4 py-2 flex items-center justify-between border-y"
          style={{
            borderColor: PRISM_BORDER,
            background: BOARD_STICKY_BG,
            backdropFilter: "blur(10px)",
          }}
        >
          <div className="text-[12px] font-extrabold text-white/90">
            {label}
            <span className="text-white/50 font-semibold ml-2">({count} games)</span>
          </div>
          <div className="text-[11px] font-semibold text-white/45">Pre-Game</div>
        </div>
        <div className="h-[2px]" style={{ background: `linear-gradient(90deg, transparent, ${PRISM_GOLD}, transparent)` }} />
      </td>
    </tr>
  );
}

function TableHeaderRow({
  oddsFormat,
  displayBooks,
  draggingKey,
  onBookPointerDown,
  onBookPointerUp,
  onBookPointerCancel,
  headerRef,
}: {
  oddsFormat: OddsFormat;
  displayBooks: BookKey[];
  draggingKey: BookKey | null;
  onBookPointerDown: (bk: BookKey) => (e: React.PointerEvent<HTMLButtonElement>) => void;
  onBookPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onBookPointerCancel: (e: React.PointerEvent<HTMLButtonElement>) => void;
  headerRef?: React.RefObject<HTMLTableSectionElement>;
}) {
  const stickyCellStyle: React.CSSProperties = {
    position: "sticky",
    top: 0,
    zIndex: 101,
    background: TABLE_HEADER_BG,
    backgroundClip: "padding-box",
  };
  return (
    <thead
      ref={headerRef}
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        background: TABLE_HEADER_BG,
      }}
    >
    <thead>
      <tr
        className="border-y"
        style={{
          borderColor: PRISM_BORDER,
          background: TABLE_HEADER_BG,
          height: HEADER_ROW_HEIGHT,
        }}
      >
        <th
          className="text-left px-4 py-2.5 text-[11px] font-extrabold text-white/80 align-middle"
          style={{ ...stickyCellStyle, width: COL_GAME }}
        >
          background: BOARD_BG,
          backdropFilter: "blur(10px)",
        }}
      >
        <th className="text-left px-4 py-2.5 text-[12px] font-extrabold text-white/80" style={{ width: COL_GAME }}>
          Game
        </th>

        {/* Consensus column like reference (subtle) */}
        <th
          className="text-center px-2 py-2.5 text-[11px] font-extrabold text-white/70 align-middle"
          style={{ ...stickyCellStyle, width: COL_BOOK }}
        >
        <th className="text-center px-2 py-2.5 text-[12px] font-extrabold text-white/70" style={{ width: COL_BOOK }}>
          Cons
          <div className="text-[9px] font-semibold text-white/45 mt-0.5">
            {oddsFormat === "american" ? "AM" : "DEC"}
          </div>
        </th>

        {displayBooks.map((bk) => (
          <th
            key={bk}
            className="text-center px-2 py-2.5 align-middle"
            style={{ ...stickyCellStyle, width: COL_BOOK }}
          >
            <div className="flex items-center justify-center">
              <button
                type="button"
                data-book={bk}
                onPointerDown={onBookPointerDown(bk)}
                onPointerUp={onBookPointerUp}
                onPointerCancel={onBookPointerCancel}
                className={[
                  "rounded-lg transition-colors cursor-grab active:cursor-grabbing",
                  draggingKey === bk ? "ring-2 ring-[rgba(212,175,55,0.5)]" : "",
                ].join(" ")}
                style={{ touchAction: "none" }}
                title="Drag to reorder"
                aria-label={`Reorder ${BOOK_LABEL[bk]}`}
              >
                <BookLogoPill src={BOOK_LOGOS[bk]} alt={BOOK_LABEL[bk]} />
              </button>
            </div>
          </th>
        ))}
        {displayBooks.map((bk) => {
          const fb = bk === "dk" ? "DK" : bk === "fd" ? "FD" : bk === "mgm" ? "MGM" : bk === "pin" ? "PIN" : "BOL";
          return (
            <th key={bk} className="text-center px-2 py-2.5" style={{ width: COL_BOOK }}>
              <div className="flex items-center justify-center">
                <button
                  type="button"
                  data-book={bk}
                  onPointerDown={onBookPointerDown(bk)}
                  onPointerUp={onBookPointerUp}
                  onPointerCancel={onBookPointerCancel}
                  className={[
                    "rounded-full transition-colors",
                    draggingKey === bk ? "ring-2 ring-[rgba(212,175,55,0.5)]" : "",
                  ].join(" ")}
                  style={{ touchAction: "none" }}
                  title="Drag to reorder"
                  aria-label={`Reorder ${BOOK_LABEL[bk]}`}
                >
                  <BookLogoPill src={BOOK_LOGOS[bk]} alt={BOOK_LABEL[bk]} fallbackLabel={fb} />
                </button>
              </div>
            </th>
          );
        })}
      </tr>
    </thead>
  );
}

function EventRowTwoLines({
  ev,
  market,
  oddsFormat,
  displayBooks,
  onOpenDetails,
}: {
  ev: EventOdds;
  market: Market;
  oddsFormat: OddsFormat;
  displayBooks: BookKey[];
  onOpenDetails: (ev: EventOdds, tab?: DetailsTab) => void;
}) {
  const leftLabel = market === "total" ? "Over" : "Away";
  const rightLabel = market === "total" ? "Under" : "Home";

  const awayCons = consensusPartsForRow(ev, market, "AWAY", oddsFormat);
  const homeCons = consensusPartsForRow(ev, market, "HOME", oddsFormat);

  return (
    <>
      {/* AWAY / OVER */}
      <tr className="border-b border-white/10 hover:bg-white/6">
        <td className="px-4 py-2.5 align-middle" rowSpan={2}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <TeamCell team={ev.away?.team ?? "Away"} logoUrl={ev.away?.logoUrl ?? null} sub={leftLabel} />
              <div className="mt-2">
                <TeamCell team={ev.home?.team ?? "Home"} logoUrl={ev.home?.logoUrl ?? null} sub={rightLabel} />
              </div>
            </div>

            <div className="shrink-0 flex flex-col items-end gap-2">
              <div className="text-[11px] text-white/60 font-semibold">{fmtCTTimeOnly(ev.commenceTime)} CT</div>
              <div className="flex items-center gap-2">
                <IconButton label="Game details" onClick={() => onOpenDetails(ev, "pred")} icon={<IconInfo />} />
                <IconButton label="Line movement" onClick={() => onOpenDetails(ev, "line")} icon={<IconTrend />} />
                <IconButton label="Player props" onClick={() => onOpenDetails(ev, "props")} icon={<IconPlayers />} />
              </div>
            </div>
          </div>
        </td>

        {/* Consensus chip */}
        <td className="px-2 py-2.5">
          <div className="flex justify-center">
            <OddsChip parts={awayCons} />
          </div>
        </td>

        {/* Books */}
        {displayBooks.map((bk) => (
          <td key={`a-${ev.eventId}-${bk}`} className="px-2 py-2.5">
            <div className="flex justify-center">
              <OddsChip parts={partsForBookSide(ev, market, "AWAY", bk, oddsFormat)} />
            </div>
          </td>
        ))}
      </tr>

      {/* HOME / UNDER */}
      <tr className="border-b border-white/10 hover:bg-white/6">
        <td className="px-2 py-2.5">
          <div className="flex justify-center">
            <OddsChip parts={homeCons} />
          </div>
        </td>

        {displayBooks.map((bk) => (
          <td key={`h-${ev.eventId}-${bk}`} className="px-2 py-2.5">
            <div className="flex justify-center">
              <OddsChip parts={partsForBookSide(ev, market, "HOME", bk, oddsFormat)} />
            </div>
          </td>
        ))}
      </tr>
    </>
  );
}

/* =========================================================
   MOBILE CARD (kept; styled closer to reference)
========================================================= */

function EventCardMobile({
  ev,
  market,
  oddsFormat,
  displayBooks,
  booksOpen,
  onToggleBooks,
  onOpenDetails,
}: {
  ev: EventOdds;
  market: Market;
  oddsFormat: OddsFormat;
  displayBooks: BookKey[];
  booksOpen: boolean;
  onToggleBooks: () => void;
  onOpenDetails: (ev: EventOdds, tab?: DetailsTab) => void;
}) {
  const leftLabel = market === "total" ? "Over" : "Away";
  const rightLabel = market === "total" ? "Under" : "Home";

  const awayCons = consensusPartsForRow(ev, market, "AWAY", oddsFormat);
  const homeCons = consensusPartsForRow(ev, market, "HOME", oddsFormat);

  return (
    <div className="rounded-2xl border border-white/10 bg-black/35 backdrop-blur-[4px] overflow-hidden shadow-[0_14px_55px_rgba(0,0,0,0.45)]">
      <div className="px-3 py-2.5 border-b border-white/10 flex items-center justify-between gap-3 bg-black/30">
        <div className="text-[12px] text-white/70 font-semibold">
          {fmtCTTimeOnly(ev.commenceTime)} CT
        </div>

        <div className="flex items-center gap-2">
          <IconButton
            label={booksOpen ? "Hide books" : "Show books"}
            onClick={onToggleBooks}
            icon={<IconBooks />}
            active={booksOpen}
          />
          <IconButton label="Game details" onClick={() => onOpenDetails(ev, "pred")} icon={<IconInfo />} />
          <IconButton label="Line movement" onClick={() => onOpenDetails(ev, "line")} icon={<IconTrend />} />
          <IconButton label="Player props" onClick={() => onOpenDetails(ev, "props")} icon={<IconPlayers />} />
        </div>
      </div>

      <div className="px-3 py-2.5 space-y-2.5">
        <TeamCell team={ev.away?.team ?? "Away"} logoUrl={ev.away?.logoUrl ?? null} sub={leftLabel} />
        <TeamCell team={ev.home?.team ?? "Home"} logoUrl={ev.home?.logoUrl ?? null} sub={rightLabel} />
      </div>

      <div className="px-3 pb-3">
        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[12px] text-white font-extrabold">Consensus</div>
            <div className="text-[11px] text-white/60 font-semibold">
              {market === "ml" ? "Moneyline" : market === "spread" ? "Spread" : "Total"}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-white/10 bg-black/25 p-2 flex items-center justify-center">
              <OddsChip parts={awayCons} className="w-full max-w-[140px]" />
            </div>
            <div className="rounded-md border border-white/10 bg-black/25 p-2 flex items-center justify-center">
              <OddsChip parts={homeCons} className="w-full max-w-[140px]" />
            </div>
          </div>
        </div>

        {booksOpen && (
          <div className="mt-3 rounded-xl border border-white/10 bg-black/25 overflow-hidden">
            <div className="px-3 py-2 border-b border-white/10 bg-black/30">
              <div className="text-[12px] text-white font-extrabold">Books</div>
              <div className="mt-2 grid grid-cols-[88px_1fr_1fr] gap-2 items-center">
                <div />
                <div className="text-[10px] text-white/60 font-semibold text-center">{leftLabel}</div>
                <div className="text-[10px] text-white/60 font-semibold text-center">{rightLabel}</div>
              </div>
            </div>

            <div className="px-3">
              {displayBooks.map((bk) => (
                <div key={bk} className="py-2 border-b border-white/10 last:border-b-0">
                  <div className="grid grid-cols-[96px_1fr_1fr] items-center gap-2">
                    <div className="flex justify-start">
                      <BookLogoPill
                        src={BOOK_LOGOS[bk]}
                        alt={BOOK_LABEL[bk]}
                        className="h-6 max-w-[96px] px-1.5"
                        imgClassName="h-4 w-4"
                        textClassName="text-[10px]"
                      />
                    </div>
              {displayBooks.map((bk) => {
                const fb = bk === "dk" ? "DK" : bk === "fd" ? "FD" : bk === "mgm" ? "MGM" : bk === "pin" ? "PIN" : "BOL";
                return (
                  <div key={bk} className="py-2 border-b border-white/10 last:border-b-0">
                    <div className="grid grid-cols-[100px_1fr_1fr] items-center gap-3">
                      <div className="flex justify-start">
                        <BookLogoPill src={BOOK_LOGOS[bk]} alt={BOOK_LABEL[bk]} fallbackLabel={fb} />
                      </div>

                    <div className="flex justify-center">
                      <OddsChip parts={partsForBookSide(ev, market, "AWAY", bk, oddsFormat)} className="w-full max-w-[120px]" />
                    </div>
                    <div className="flex justify-center">
                      <OddsChip parts={partsForBookSide(ev, market, "HOME", bk, oddsFormat)} className="w-full max-w-[120px]" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* =========================================================
   SCREEN
========================================================= */

export function OddsScreen({
  sportKey,
  onPickSport,
}: {
  sportKey: string;
  onPickSport?: (key: string) => void;
}) {
  const [allEvents, setAllEvents] = useState<EventOdds[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [market, setMarket] = useState<Market>("spread");
  const [view, setView] = useState<BoardView>("pregame");
  const [oddsFormat, setOddsFormat] = useState<OddsFormat>("american");
  const [useAiAdjusted, setUseAiAdjusted] = useState(false);
  const [query, setQuery] = useState<string>("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [lastUpdatedIso, setLastUpdatedIso] = useState<string | null>(null);

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [activeEvent, setActiveEvent] = useState<EventOdds | null>(null);
  const [detailsTab, setDetailsTab] = useState<DetailsTab>("pred");

  const [mobileOpenMap, setMobileOpenMap] = useState<Record<string, boolean>>({});
  const [bookOrder, setBookOrder] = useState<BookKey[]>(BOOKS);
  const [draggingBook, setDraggingBook] = useState<BookKey | null>(null);
  const dragBookRef = useRef<BookKey | null>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const tableHeadRef = useRef<HTMLTableSectionElement>(null);

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

    // include latest props snapshot time if available (non-blocking)
    let propsLatest: string | null = null;
    try {
      const propsRes = await supabase
        .from("player_props_snapshot")
        .select("ts,snapshot_ts,inserted_at")
        .eq("sport_key", sportKey)
        .order("ts", { ascending: false })
        .order("snapshot_ts", { ascending: false })
        .order("inserted_at", { ascending: false })
        .limit(1);

      if (!propsRes.error) {
        const r =
          (propsRes.data?.[0] ?? null) as
            | { ts?: string | null; snapshot_ts?: string | null; inserted_at?: string | null }
            | null;
        propsLatest = normalizeIso(r?.ts ?? r?.snapshot_ts ?? r?.inserted_at ?? null);
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
    setMarket("spread");
    setDetailsOpen(false);
    setActiveEvent(null);
  }, [sportKey]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(BOOK_ORDER_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const next = parsed.filter((b) => BOOKS.includes(b));
      if (next.length !== BOOKS.length) return;
      setBookOrder(next);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(BOOK_ORDER_STORAGE_KEY, JSON.stringify(bookOrder));
    } catch {
      // ignore
    }
  }, [bookOrder]);

  useLayoutEffect(() => {
    if (!tableScrollRef.current || !tableHeadRef.current) return;
    const scrollEl = tableScrollRef.current;
    const headEl = tableHeadRef.current;

    const update = () => {
      const height = headEl.getBoundingClientRect().height;
      scrollEl.style.setProperty("--thead-h", `${height}px`);
    };

    update();

    const ro = new ResizeObserver(update);
    ro.observe(headEl);
    window.addEventListener("resize", update);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

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

  const eventsForView = useMemo(() => {
    const todayCt = ctTodayYmd();
    const nowMs = Date.now();

    return allEvents.filter((ev) => {
      if (view === "live") {
        // NOTE: If you have live flags, plug them in here. For now, live view shows none.
        return false;
      }

      // pregame: future games
      const evDate = ctYmdFromIso(ev.commenceTime);
      if (evDate === todayCt) {
        const startMs = new Date(normalizeIso(ev.commenceTime) ?? ev.commenceTime).getTime();
        if (!Number.isFinite(startMs)) return false;
        return startMs > nowMs;
      }
      return true;
    });
  }, [allEvents, view]);

  const events = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return eventsForView;
    return eventsForView.filter((ev) => {
      const a = (ev.away?.team ?? "").toLowerCase();
      const h = (ev.home?.team ?? "").toLowerCase();
      return a.includes(q) || h.includes(q);
    });
  }, [eventsForView, query]);

  const eventsByDaySection = useMemo(() => {
    const grouped = new Map<string, EventOdds[]>();
    for (const ev of events) {
      const ymd = ctYmdFromIso(ev.commenceTime);
      if (!ymd) continue;
      const list = grouped.get(ymd) ?? [];
      list.push(ev);
      grouped.set(ymd, list);
    }

    return Array.from(grouped.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ymd, list]) => ({
        ymd,
        label: fmtDateBtn(ymd),
        count: list.length,
        events: list,
      }));
  }, [events]);

  useEffect(() => {
    setMobileOpenMap((prev) => {
      const next: Record<string, boolean> = {};
      for (const ev of events) next[ev.eventId] = prev[ev.eventId] ?? false;
      return next;
    });
  }, [events]);

  const openDetails = (ev: EventOdds, tab: DetailsTab = "pred") => {
    setActiveEvent(ev);
    setDetailsTab(tab);
    setDetailsOpen(true);
  };

  const handleBookPointerDown = (bk: BookKey) => (e: React.PointerEvent<HTMLButtonElement>) => {
    dragBookRef.current = bk;
    setDraggingBook(bk);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleBookPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const from = dragBookRef.current;
    dragBookRef.current = null;
    setDraggingBook(null);
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (!from) return;
    const targetEl = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const targetKey = targetEl?.closest("[data-book]")?.getAttribute("data-book") as BookKey | null;
    if (!targetKey || targetKey === from) return;
    setBookOrder((prev) => {
      const next = prev.slice();
      const fromIdx = next.indexOf(from);
      const toIdx = next.indexOf(targetKey);
      if (fromIdx === -1 || toIdx === -1) return prev;
      next.splice(fromIdx, 1);
      next.splice(toIdx, 0, from);
      return next;
    });
  };

  const handleBookPointerCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    dragBookRef.current = null;
    setDraggingBook(null);
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const handleResetBookOrder = () => {
    setBookOrder(BOOKS);
    try {
      window.localStorage.removeItem(BOOK_ORDER_STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  // “Top bar” height for sticky header computations:
  // - Sports tabs bar ~ 44px
  // - Filters bar ~ 60px
  // => sticky header row uses top-[104px] in TableHeaderRow.
  const topSport = sportLabelForKey(sportKey);
  const lastUpdatedAge = useMemo(() => minutesSinceIso(lastUpdatedIso), [lastUpdatedIso]);
  const freshness = useMemo(() => {
    if (lastUpdatedAge == null) {
      return { label: "No recent update", tone: "text-white/50", dot: "bg-white/30" };
    }
    if (lastUpdatedAge <= 5) {
      return { label: `${lastUpdatedAge}m ago`, tone: "text-emerald-300", dot: "bg-emerald-400" };
    }
    if (lastUpdatedAge <= 15) {
      return { label: `${lastUpdatedAge}m ago`, tone: "text-amber-300", dot: "bg-amber-400" };
    }
    return { label: `${lastUpdatedAge}m ago`, tone: "text-red-300", dot: "bg-red-400" };
  }, [lastUpdatedAge]);

  const emptyState = useMemo(() => {
    if (view === "live") {
      return {
        title: "No live games available yet.",
        subtitle: "Live odds will appear when your feed supports in-game updates.",
      };
    }
    if (!availableDates.length) {
      return {
        title: "No upcoming games.",
        subtitle: "Check back later for the next slate.",
      };
    }
    if (query.trim() && !events.length && eventsForView.length) {
      return {
        title: `No matches for “${query.trim()}”.`,
        subtitle: "Try a different team name or clear the search.",
      };
    }
    return {
      title: "No games available.",
      subtitle: "Pick another market or refresh the feed.",
    };
  }, [availableDates.length, events.length, eventsForView.length, query, view]);

  const selectedDateLabel = useMemo(() => {
    if (!selectedDate) return "—";
    return fmtDateBtn(selectedDate);
  }, [selectedDate]);

  return (
    <div className="w-full min-h-screen" style={{ background: BOARD_BG }}>
      <div className="w-full">
        <div className={`${PAGE_X} relative`}>
          <div
            className={`${PAGE_MAX_W} mx-auto`}
            style={{
              background:
                `radial-gradient(1200px 700px at 12% 10%, ${PRISM_GOLD_SOFT}, transparent 55%),` +
                "radial-gradient(1000px 700px at 85% 0%, rgba(255,255,255,0.04), transparent 58%)," +
                "linear-gradient(180deg, #050505, #0c0c0c 50%, #060606)",
            }}
          >
            {/* ===========================
                TOP SPORTS + FILTERS BAR
            =========================== */}
            <div className="flex flex-col" style={{ height: FILTERS_BAR_HEIGHT }}>
              <div
                className="px-2 md:px-0"
                style={{
                  height: FILTER_ROW_HEIGHT,
                  background: BOARD_BG,
                  borderBottom: `1px solid ${PRISM_BORDER}`,
                  backdropFilter: "blur(10px)",
                }}
              >
                <div className="h-full flex flex-col md:flex-row md:items-center gap-2">
                  <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
                    {SPORT_TABS.map((t) => {
                      const active =
                        t.key === sportKey ||
                        (t.key === "soccer" && sportKey.includes("soccer")) ||
                        (t.key === "mma_mixed_martial_arts" && sportKey.includes("mma"));
                      const enabled = isOddsSportKey(t.key) && Boolean(onPickSport);
                      return (
                        <button
                          key={t.key}
                          type="button"
                          onClick={() => {
                            if (enabled && onPickSport) onPickSport(t.key);
                          }}
                          disabled={!enabled}
                          className={[
                            "shrink-0 px-3 py-2 text-[12px] font-extrabold rounded-md border transition-colors",
                            enabled ? "cursor-pointer" : "cursor-not-allowed opacity-60",
                            active ? "shadow-[0_0_0_1px_rgba(212,175,55,0.25)]" : "",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(212,175,55,0.4)]",
                          ].join(" ")}
                          style={{
                            borderColor: active ? "rgba(212,175,55,0.55)" : "rgba(255,255,255,0.10)",
                            background: active ? "rgba(212,175,55,0.16)" : "transparent",
                            color: active ? PRISM_GOLD : "rgba(255,255,255,0.75)",
                          }}
                          title={
                            !enabled
                              ? `${t.label} (not wired)`
                              : active
                                ? `${t.label} (active)`
                                : `Switch to ${t.label}`
                          }
                        >
                          {t.label}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex flex-1 items-center gap-2 md:ml-auto">
                    <div className="w-full md:w-auto">
                      <TextInput
                        value={query}
                        onChange={setQuery}
                        placeholder="Search teams..."
                        onClear={() => setQuery("")}
                      />
                    </div>
                    <div className="hidden lg:flex items-center gap-2">
                      <div className="text-[11px] text-white/60 font-semibold">Last updated:</div>
                      <div className="text-[11px] text-white font-extrabold">{fmtCTDateTime(lastUpdatedIso)}</div>
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                        <span className={`h-2 w-2 rounded-full ${freshness.dot}`} />
                        <span className={freshness.tone}>{freshness.label}</span>
                      </div>
                      <div className="h-7 w-7 rounded-full border border-white/10 bg-white/5" />
                    </div>
                  </div>
                </div>
              </div>

              <div
                className="px-2 md:px-0"
                style={{
                  height: FILTER_ROW_HEIGHT,
                  background: BOARD_BG,
                  borderBottom: `1px solid ${PRISM_BORDER}`,
                  backdropFilter: "blur(10px)",
    <div
      className="w-full min-h-screen"
      style={{
        background:
          `radial-gradient(1200px 700px at 12% 10%, ${PRISM_GOLD_SOFT}, transparent 55%),` +
          "radial-gradient(1000px 700px at 85% 0%, rgba(255,255,255,0.04), transparent 58%)," +
          "linear-gradient(180deg, #050505, #0c0c0c 50%, #060606)",
      }}
    >
      <div className={`${PAGE_MAX_W} mx-auto ${PAGE_X} relative`}>
        {/* ===========================
            TOP SPORTS TABS BAR
        =========================== */}
        <div className="sticky top-0 z-50">
          <div
            className="h-[42px] flex items-center justify-between px-2 md:px-0"
            style={{
              background: "linear-gradient(180deg, rgba(10,10,10,0.92), rgba(8,8,8,0.86))",
              borderBottom: `1px solid ${PRISM_BORDER}`,
              backdropFilter: "blur(10px)",
            }}
          >
            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
              {SPORT_TABS.map((t) => {
                const active =
                  t.key === sportKey ||
                  (t.key === "soccer" && sportKey.includes("soccer")) ||
                  (t.key === "mma_mixed_martial_arts" && sportKey.includes("mma"));
                const enabled = isOddsSportKey(t.key) && Boolean(onPickSport);
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => {
                      if (enabled && onPickSport) onPickSport(t.key);
                    }}
                    disabled={!enabled}
                    className={[
                      "shrink-0 px-3 py-2 text-[12px] font-extrabold rounded-md border transition-colors",
                      enabled ? "cursor-pointer" : "cursor-not-allowed opacity-60",
                      active ? "shadow-[0_0_0_1px_rgba(212,175,55,0.25)]" : "",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(212,175,55,0.4)]",
                    ].join(" ")}
                    style={{
                      borderColor: active ? "rgba(212,175,55,0.55)" : "rgba(255,255,255,0.10)",
                      background: active ? "rgba(212,175,55,0.16)" : "transparent",
                      color: active ? PRISM_GOLD : "rgba(255,255,255,0.75)",
                    }}
                    title={
                      !enabled
                        ? `${t.label} (not wired)`
                        : active
                          ? `${t.label} (active)`
                          : `Switch to ${t.label}`
                    }
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <div className="hidden md:flex items-center gap-2">
                <div className="text-[11px] text-white/60 font-semibold">Last updated:</div>
                <div className="text-[11px] text-white font-extrabold">{fmtCTDateTime(lastUpdatedIso)}</div>
                <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                  <span className={`h-2 w-2 rounded-full ${freshness.dot}`} />
                  <span className={freshness.tone}>{freshness.label}</span>
                </div>
              </div>
              <div className="h-8 w-8 rounded-full border border-white/10 bg-white/5" />
            </div>
          </div>

          {/* ===========================
              FILTERS TOOLBAR
          =========================== */}
          <div
            className="h-[56px] flex items-center justify-between gap-3 px-2 md:px-0"
            style={{
              background: "linear-gradient(180deg, rgba(12,12,12,0.85), rgba(9,9,9,0.78))",
              borderBottom: `1px solid ${PRISM_BORDER}`,
              backdropFilter: "blur(10px)",
            }}
          >
            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
              <SelectPill
                value={market}
                onChange={(v) => setMarket(v as Market)}
                label="Market"
                options={[
                  { value: "spread", label: "Point Spread" },
                  { value: "total", label: "Total" },
                  { value: "ml", label: "Moneyline" },
                ]}
              />

              <div className="flex items-center gap-2">
                <div className="text-[11px] text-white/60 font-semibold">View</div>
                <SegmentedToggle
                  value={view}
                  options={[
                    { value: "pregame", label: "Pre-Game" },
                    { value: "live", label: "Live" },
                  ]}
                  onChange={(next) => setView(next as BoardView)}
                />
              </div>

              <DateReminder label={selectedDateLabel} />

              <div className="hidden md:block">
                <TextInput value={query} onChange={setQuery} placeholder="Search teams..." onClear={() => setQuery("")} />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="md:hidden">
                <TextInput value={query} onChange={setQuery} placeholder="Search..." onClear={() => setQuery("")} />
              </div>

              <SelectPill
                value={oddsFormat}
                onChange={(v) => setOddsFormat(v as OddsFormat)}
                label="Odds"
                options={[
                  { value: "american", label: "American" },
                  { value: "decimal", label: "Decimal" },
                ]}
              />

              <SelectPill
                value={"all"}
                onChange={() => {}}
                label="Sportsbooks"
                options={[{ value: "all", label: `All (${BOOKS.length})` }]}
              />
              <button
                type="button"
                onClick={handleResetBookOrder}
                className="text-[11px] font-semibold text-white/60 hover:text-white"
              >
                Reset order
              </button>

              <Btn
                onClick={() => {
                  setLoading(true);
                  load();
                }}
                disabled={loading}
              >
                <div className="h-full flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <SelectPill
                      value={market}
                      onChange={(v) => setMarket(v as Market)}
                      label="Market"
                      options={[
                        { value: "spread", label: "Point Spread" },
                        { value: "total", label: "Total" },
                        { value: "ml", label: "Moneyline" },
                      ]}
                    />

                    <div className="flex items-center gap-2">
                      <div className="text-[12px] text-white/55 font-semibold">View</div>
                      <SegmentedToggle
                        value={view}
                        options={[
                          { value: "pregame", label: "Pre-Game" },
                          { value: "live", label: "Live" },
                        ]}
                        onChange={(next) => setView(next as BoardView)}
                      />
                    </div>
                {loading ? "Refreshing…" : "Refresh"}
              </Btn>
            </div>
          </div>
        </div>

        {/* ===========================
            BOARD BODY
        =========================== */}
        <div className="pt-2.5 pb-6">
          <div
            className="rounded-3xl border overflow-hidden shadow-[0_18px_80px_rgba(0,0,0,0.6)]"
            style={{
              borderColor: PRISM_BORDER,
              background: BOARD_BG,
              backdropFilter: "blur(6px)",
            }}
          >
            <div className="px-4 py-2.5 border-b" style={{ borderColor: PRISM_BORDER }}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-white font-extrabold text-[14px]">
                    {view === "pregame" ? "Upcoming Games" : "Live Games"} •{" "}
                    <span style={{ color: PRISM_GOLD }}>{topSport}</span>
                  </div>
                  <div className="text-[11px] font-semibold mt-0.5" style={{ color: PRISM_MUTED }}>
                    Odds Board • {market === "ml" ? "Moneyline" : market === "spread" ? "Point Spread" : "Total"} •{" "}
                    {oddsFormat === "american" ? "American" : "Decimal"}
                  </div>
                </div>

                    <DateReminder label={selectedDateLabel} />
                  </div>

                  <div className="flex flex-wrap items-center gap-3 md:justify-end">
                    <SelectPill
                      value={oddsFormat}
                      onChange={(v) => setOddsFormat(v as OddsFormat)}
                      label="Odds"
                      options={[
                        { value: "american", label: "American" },
                        { value: "decimal", label: "Decimal" },
                      ]}
                    />

                    <button
                      type="button"
                      onClick={() => setUseAiAdjusted((prev) => !prev)}
                      className={[
                        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] transition",
                        useAiAdjusted ? "text-[#d4af37]" : "text-white/60",
                      ].join(" ")}
                      style={{
                        borderColor: useAiAdjusted ? "rgba(212,175,55,0.55)" : "rgba(255,255,255,0.12)",
                        background: useAiAdjusted ? "rgba(212,175,55,0.12)" : "rgba(0,0,0,0.35)",
                      }}
                    >
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: useAiAdjusted ? "#d4af37" : "#3a3a3a" }} />
                      ML Adjusted
                    </button>

                    <SelectPill
                      value={"all"}
                      onChange={() => {}}
                      label="Sportsbooks"
                      options={[{ value: "all", label: `All (${BOOKS.length})` }]}
                    />

                    <div className="flex items-center gap-2 md:ml-1">
                      <button
                        type="button"
                        onClick={handleResetBookOrder}
                        className="text-[11px] font-semibold text-white/50 hover:text-white"
                      >
                        Reset order
                      </button>

                      <Btn
                        onClick={() => {
                          setLoading(true);
                          load();
                        }}
                        disabled={loading}
                      >
                        {loading ? "Refreshing…" : "Refresh"}
                      </Btn>
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2 text-[11px] font-extrabold text-white">
                    <span>Updated: {fmtCTDateTime(lastUpdatedIso)}</span>
                    <span className={`h-2 w-2 rounded-full ${freshness.dot}`} />
                    <span className={freshness.tone}>{freshness.label}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* MOBILE */}
            <div className="md:hidden p-3">
              {loading ? (
                <div className="p-3 text-xs text-white/60">Loading odds…</div>
              ) : error ? (
                <div className="p-3 text-xs text-red-400">Supabase error: {error}</div>
              ) : !events.length ? (
                <EmptyState title={emptyState.title} subtitle={emptyState.subtitle} />
              ) : (
                <div className="space-y-3">
                  {eventsByDaySection.map((sec) => (
                    <div key={sec.ymd} className="space-y-3">
                      <div
                        className="sticky top-0 z-20 rounded-xl border border-white/10 px-3 py-2 backdrop-blur-[8px]"
                        style={{ background: BOARD_STICKY_BG, boxShadow: "0 10px 30px rgba(0,0,0,0.45)" }}
                      >
                        <div className="text-[12px] font-extrabold text-white/90">
                          {sec.label}
                          <span className="text-white/50 font-semibold ml-2">({sec.count} games)</span>
                        </div>
                      </div>
                      {sec.events.map((ev) => (
                        <EventCardMobile
                          key={ev.eventId}
                          ev={ev}
                          market={market}
                          oddsFormat={oddsFormat}
                          displayBooks={bookOrder}
                          booksOpen={!!mobileOpenMap[ev.eventId]}
                          onToggleBooks={() => setMobileOpenMap((prev) => ({ ...prev, [ev.eventId]: !prev[ev.eventId] }))}
                          onOpenDetails={openDetails}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* ===========================
                BOARD BODY
            =========================== */}
            <div className="pt-2.5 pb-6">
              <div
                className="rounded-3xl border overflow-hidden shadow-[0_18px_80px_rgba(0,0,0,0.6)]"
                style={{
                  borderColor: PRISM_BORDER,
                  background: BOARD_BG,
                  backdropFilter: "blur(6px)",
                }}
              >
                <div className="px-4 py-2 border-b" style={{ borderColor: PRISM_BORDER }}>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-white font-extrabold text-[13px] leading-tight">
                        {view === "pregame" ? "Upcoming Games" : "Live Games"} •{" "}
                        <span style={{ color: PRISM_GOLD }}>{topSport}</span>
                      </div>
                      <div className="text-[10px] font-semibold mt-0.5" style={{ color: PRISM_MUTED }}>
                        Odds Board • {market === "ml" ? "Moneyline" : market === "spread" ? "Point Spread" : "Total"} •{" "}
                        {oddsFormat === "american" ? "American" : "Decimal"}
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="text-[10px] font-semibold" style={{ color: PRISM_MUTED }}>
                        {events.length} games
                      </div>
                      <div className="flex items-center justify-end gap-2 text-[10px] font-extrabold text-white">
                        <span>Updated: {fmtCTDateTime(lastUpdatedIso)}</span>
                        <span className={`h-2 w-2 rounded-full ${freshness.dot}`} />
                        <span className={freshness.tone}>{freshness.label}</span>
                      </div>
                    </div>
                  </div>
                </div>
            {/* DESKTOP */}
            <div className="hidden md:block">
              {loading ? (
                <div className="p-6 text-sm text-white/60">Loading odds…</div>
              ) : error ? (
                <div className="p-6 text-sm text-red-400">Supabase error: {error}</div>
              ) : !events.length ? (
                <EmptyState title={emptyState.title} subtitle={emptyState.subtitle} />
              ) : (
                <div className="max-h-[calc(100vh-240px)] overflow-auto" style={{ scrollPaddingTop: 56 }}>
                  <table className="w-full table-fixed min-w-[1080px]">
                    <colgroup>
                      <col style={{ width: COL_GAME }} />
                      <col style={{ width: COL_BOOK }} />
                      {BOOKS.map((_, i) => (
                        <col key={i} style={{ width: COL_BOOK }} />
                      ))}
                    </colgroup>

                    <TableHeaderRow
                      oddsFormat={oddsFormat}
                      displayBooks={bookOrder}
                      draggingKey={draggingBook}
                      onBookPointerDown={handleBookPointerDown}
                      onBookPointerUp={handleBookPointerUp}
                      onBookPointerCancel={handleBookPointerCancel}
                    />

                {/* MOBILE */}
                <div className="md:hidden p-3">
                  {loading ? (
                    <div className="p-3 text-xs text-white/60">Loading odds…</div>
                  ) : error ? (
                    <div className="p-3 text-xs text-red-400">Supabase error: {error}</div>
                  ) : !events.length ? (
                    <EmptyState title={emptyState.title} subtitle={emptyState.subtitle} />
                  ) : (
                    <div className="space-y-3">
                      {eventsByDaySection.map((sec) => (
                        <div key={sec.ymd} className="space-y-3">
                          <div
                            className="sticky z-20 rounded-xl border border-white/10 px-3 py-2 backdrop-blur-[8px]"
                            style={{
                              top: 0,
                              background: BOARD_STICKY_BG,
                              boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
                            }}
                          >
                            <div className="text-[12px] font-extrabold text-white/90">
                              {sec.label}
                              <span className="text-white/50 font-semibold ml-2">({sec.count} games)</span>
                            </div>
                          </div>
                        <React.Fragment key={sec.ymd}>
                          <DateSectionHeader label={sec.label} count={sec.count} />
                          {sec.events.map((ev) => (
                            <EventCardMobile
                              key={ev.eventId}
                              ev={ev}
                              market={market}
                              oddsFormat={oddsFormat}
                              displayBooks={bookOrder}
                              booksOpen={!!mobileOpenMap[ev.eventId]}
                              onToggleBooks={() =>
                                setMobileOpenMap((prev) => ({ ...prev, [ev.eventId]: !prev[ev.eventId] }))
                              }
                              onOpenDetails={openDetails}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* DESKTOP */}
                <div className="hidden md:block">
                  {loading ? (
                    <div className="p-6 text-sm text-white/60">Loading odds…</div>
                  ) : error ? (
                    <div className="p-6 text-sm text-red-400">Supabase error: {error}</div>
                  ) : !events.length ? (
                    <EmptyState title={emptyState.title} subtitle={emptyState.subtitle} />
                  ) : (
                    <div
                      ref={tableScrollRef}
                      className="max-h-[calc(100vh-240px)] overflow-auto"
                      style={{
                        scrollPaddingTop: DATE_BAR_HEIGHT + HEADER_ROW_HEIGHT + 24,
                        background: BOARD_BG,
                      }}
                    >
                      <table
                        className="w-full table-fixed min-w-[1080px]"
                        style={{ background: BOARD_BG, borderCollapse: "separate", borderSpacing: 0 }}
                      >
                        <colgroup>
                          <col style={{ width: COL_GAME }} />
                          <col style={{ width: COL_BOOK }} />
                          {bookOrder.map((_, i) => (
                            <col key={i} style={{ width: COL_BOOK }} />
                          ))}
                        </colgroup>

                        <TableHeaderRow
                          oddsFormat={oddsFormat}
                          displayBooks={bookOrder}
                          draggingKey={draggingBook}
                          onBookPointerDown={handleBookPointerDown}
                          onBookPointerUp={handleBookPointerUp}
                          onBookPointerCancel={handleBookPointerCancel}
                          headerRef={tableHeadRef}
                        />

                        <tbody>
                          {eventsByDaySection.map((sec) => (
                            <React.Fragment key={sec.ymd}>
                              <DateSectionHeader label={sec.label} count={sec.count} />
                              {sec.events.map((ev) => (
                                <EventRowTwoLines
                                  key={ev.eventId}
                                  ev={ev}
                                  market={market}
                                  oddsFormat={oddsFormat}
                                  displayBooks={bookOrder}
                                  onOpenDetails={openDetails}
                                />
                              ))}
                            </React.Fragment>
                          ))}
                        </tbody>
                      </table>

                      <div className="h-3" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Modal */}
        {detailsOpen && activeEvent && (
          <GameDetailsModal
            sportKey={sportKey}
            ev={activeEvent}
            oddsFormat={oddsFormat}
            initialTab={detailsTab}
            onClose={() => setDetailsOpen(false)}
          />
        )}
      </div>

      {/* Modal */}
      {detailsOpen && activeEvent && (
        <GameDetailsModal
          sportKey={sportKey}
          ev={activeEvent}
          oddsFormat={oddsFormat}
          useAiAdjusted={useAiAdjusted}
          initialTab={detailsTab}
          mode={detailsTab}
          showTabs={false}
          onClose={() => setDetailsOpen(false)}
        />
      )}
    </div>
  );
}
 
