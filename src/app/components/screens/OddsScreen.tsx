// screens/OddsScreen.tsx — FULL REWRITE (Predictions spacing fixed + Last 5 Games added)
// -------------------------------------------------------------------------------------------------------------
// ✅ FIX: Predictions tab spacing + layout tightened (less dead space / better grid)
// ✅ NEW: Last 5 Games panel in Predictions (NBA: basketballref_games_nba, NCAAB: kenpom_games)
// ✅ Keeps: single Game Details button, single Market buttons ONLY in Line Movement tab
// ✅ Keeps: Player Props tab = one row per player, books in same row
// ✅ Keeps: line movement tooltip shows DATE + TIME (CT) + line+odds for spread/total
//
// NOTE: kenpom_games column names may be either literal (e.g. "Team1 (Away)") or snake_case.
//       This script attempts literal first; if you use snake_case, adjust in fetchLast5Games().

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

const PAGE_MAX_W = "max-w-[1320px]";
const PAGE_X = "px-4 md:px-8";

/** HERO + PANEL styles */
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
   FLEX COLUMN PICKERS
========================================================= */

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
   BOOK HEADER PILL
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
          onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
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
   SEGMENTED MARKET CONTROL (board)
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

function Chip({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={CHIP}>
      <div className={CHIP_L}>{label}</div>
      <div className={CHIP_V}>{value}</div>
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
  onOpenDetails,
}: {
  ev: EventOdds;
  market: Market;
  booksOpen: boolean;
  onToggleBooks: () => void;
  onOpenDetails: (ev: EventOdds) => void;
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
          <button
            type="button"
            onClick={() => onOpenDetails(ev)}
            className={[BTN_BASE, BTN_ON].join(" ")}
          >
            Game Details
          </button>
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
                <div className="text-[10px] text-[#808080] font-semibold text-center">
                  {leftLabel}
                </div>
                <div className="text-[10px] text-[#808080] font-semibold text-center">
                  {rightLabel}
                </div>
              </div>
            </div>

            <div className="px-4">
              {BOOKS.map((bk) => {
                const meta = metaFor(bk);
                return (
                  <div key={bk} className="py-2 border-b border-[#141414] last:border-b-0">
                    <div className="grid grid-cols-[110px_1fr_1fr] items-center gap-3">
                      <div className="flex justify-start">
                        <BookLogoPill src={BOOK_LOGOS[bk]} alt={meta.alt} fallbackLabel={meta.fb} size="md" />
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
  onOpenDetails,
}: {
  ev: EventOdds;
  market: Market;
  onOpenDetails: (ev: EventOdds) => void;
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
            <div className="text-[12px] text-[#cfcfcf] font-semibold">{fmtCTTimeOnly(ev.commenceTime)} CT</div>

            <button type="button" onClick={() => onOpenDetails(ev)} className={[BTN_BASE, BTN_ON].join(" ")}>
              Game Details
            </button>
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
   MODAL SHELL (with subtle background)
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

  // subtle inline "noise" overlay via SVG data-uri (very light)
  const noiseSvg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="180" height="180">
      <filter id="n">
        <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" stitchTiles="stitch"/>
        <feColorMatrix type="matrix"
          values="0 0 0 0 0.65  0 0 0 0 0.55  0 0 0 0 0.18  0 0 0 0.08 0"/>
      </filter>
      <rect width="100%" height="100%" filter="url(#n)"/>
    </svg>
  `);

  return (
    <div
      className="fixed inset-0 z-[999] flex items-center justify-center bg-black/70 p-2 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="relative w-full max-w-7xl rounded-2xl border border-[#2a2a2a] overflow-hidden max-h-[92vh] flex flex-col shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
        style={{
          background:
            "radial-gradient(1200px 700px at 15% 10%, rgba(212,175,55,0.10), transparent 55%)," +
            "radial-gradient(900px 600px at 80% 0%, rgba(16,185,129,0.06), transparent 55%)," +
            "linear-gradient(180deg, rgba(15,15,15,0.98), rgba(10,10,10,0.98))",
        }}
      >
        {/* soft noise overlay */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.10]"
          style={{
            backgroundImage: `url("data:image/svg+xml,${noiseSvg}")`,
            backgroundRepeat: "repeat",
          }}
        />

        <div className="relative px-4 py-3 border-b border-[#2a2a2a] flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <div className="text-white font-extrabold text-sm">{title}</div>
            {subtitle && <div className="text-[11px] text-[#a0a0a0] mt-0.5 break-words">{subtitle}</div>}
          </div>
          <button
            className="text-[#cfcfcf] hover:text-white text-sm font-bold px-2 py-1 rounded-md hover:bg-white/10"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>

        <div className="relative p-3 sm:p-4 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

/* =========================================================
   GAME DETAILS MODAL (tabs)
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
      onClick={onClick}
      className={[
        "px-3 py-1.5 text-xs font-extrabold rounded-lg border transition-colors",
        active
          ? "bg-[#d4af37] text-black border-[#d4af37]"
          : "bg-black/20 text-white/90 border-[#2a2a2a] hover:border-[#3a3a3a]",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

/* =========================================================
   LINE MOVEMENT (side-by-side charts)
========================================================= */

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
    <div className="rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] px-3 py-2 shadow-[0_16px_60px_rgba(0,0,0,0.45)]">
      <div className="text-[11px] text-[#d0d0d0] font-extrabold">{tsLabel} CT</div>

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

      <div className="mt-2 text-[10px] text-[#808080] font-semibold">
        {market === "ml"
          ? "Moneyline Odds History"
          : market === "spread"
          ? "Spread (line + odds) History"
          : "Total (line + odds) History"}
      </div>
    </div>
  );
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
    const bk = bookKeyFromRaw(pickBook(r));
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
    <div className="rounded-2xl border border-[#2a2a2a] bg-black/25 backdrop-blur-[2px] p-3">
      <div className="text-[12px] text-white font-extrabold mb-2">{title}</div>

      {!pts.length ? (
        <div className="text-sm text-[#a0a0a0] p-4">No odds history available for this side.</div>
      ) : (
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={pts} margin={{ top: 10, right: 18, left: 0, bottom: 10 }}>
              <CartesianGrid stroke="#222222" strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                tick={{ fill: "#b0b0b0", fontSize: 10 }}
                interval="preserveStartEnd"
                minTickGap={18}
              />
              <YAxis tick={{ fill: "#b0b0b0", fontSize: 10 }} width={40} domain={["auto", "auto"]} />
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
      )}

      <div className="mt-2 text-[11px] text-[#a0a0a0]">
        Tooltip includes <span className="text-white font-extrabold">date + time (CT)</span>
        {market === "ml" ? "." : <> and <span className="text-white font-extrabold">line + odds</span>.</>}
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {chart(leftTitle, leftPoints)}
      {chart(rightTitle, rightPoints)}
    </div>
  );
}

/* =========================================================
   PREDICTIONS (monte_carlo_results)
========================================================= */

type MonteCarloRow = {
  event_id: string;
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

  sigma_margin_game?: number | null;
  sigma_total_game?: number | null;
};

function toNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toProb01(v: number | null | undefined): number | null {
  if (v == null) return null;
  const x = v > 1.5 ? v / 100 : v; // robust for 0-100 or 0-1
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(1, x));
}

function pct(v01: number | null | undefined) {
  if (v01 == null) return "—";
  return `${(v01 * 100).toFixed(1)}%`;
}

/** Convert a probability (0..1) to "quantum fair odds" (American) */
function probToAmerican(p: number | null): string {
  if (p == null || p <= 0 || p >= 1) return "—";
  if (p >= 0.5) {
    const a = -Math.round((p / (1 - p)) * 100);
    return String(a);
  } else {
    const a = Math.round(((1 - p) / p) * 100);
    return `+${a}`;
  }
}

function winColors(awayP: number | null, homeP: number | null) {
  if (awayP == null || homeP == null)
    return {
      away: "text-white",
      home: "text-white",
      awayHex: "#d0d0d0",
      homeHex: "#d0d0d0",
    };
  if (awayP > homeP)
    return { away: "text-emerald-400", home: "text-red-400", awayHex: "#34d399", homeHex: "#f87171" };
  if (homeP > awayP)
    return { away: "text-red-400", home: "text-emerald-400", awayHex: "#f87171", homeHex: "#34d399" };
  return { away: "text-white", home: "text-white", awayHex: "#d0d0d0", homeHex: "#d0d0d0" };
}

/* =========================================================
   NEW: 100% SPLIT DONUT (Away/Home arcs) with score inside
========================================================= */

function SplitDonut({
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
  const aN = a / total;
  const hN = h / total;

  // SVG ring
  const size = 168; // slightly smaller to reduce "float"
  const cx = size / 2;
  const cy = size / 2;
  const r = 66;
  const c = 2 * Math.PI * r;
  const stroke = 14;

  const aLen = c * aN;
  const hLen = c * hN;

  // Start at 12 o'clock
  const rotate = -90;

  return (
    <div className="relative w-[168px] h-[168px]">
      <svg width={size} height={size} className="block">
        <g transform={`rotate(${rotate} ${cx} ${cy})`}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={awayColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${aLen} ${c - aLen}`}
            strokeDashoffset={0}
          />
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={homeColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${hLen} ${c - hLen}`}
            strokeDashoffset={-aLen}
          />
        </g>

        <circle cx={cx} cy={cy} r={r - stroke / 2} fill="rgba(0,0,0,0.28)" />
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-2">
        <div className="text-[10px] text-[#b0b0b0] font-semibold">Projected Score</div>
        <div className="mt-1 text-white font-extrabold tabular-nums text-[20px] leading-tight">{scoreText}</div>

        <div className="mt-2 grid grid-cols-2 gap-2 w-full px-3">
          <div className="rounded-lg border border-[#2a2a2a] bg-black/25 py-1">
            <div className="text-[10px] text-[#b0b0b0] font-semibold">{awayLabel}</div>
            <div className="text-[12px] font-extrabold tabular-nums" style={{ color: awayColor }}>
              {pct(awayP)}
            </div>
          </div>
          <div className="rounded-lg border border-[#2a2a2a] bg-black/25 py-1">
            <div className="text-[10px] text-[#b0b0b0] font-semibold">{homeLabel}</div>
            <div className="text-[12px] font-extrabold tabular-nums" style={{ color: homeColor }}>
              {pct(homeP)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   NEW: LAST 5 GAMES (NBA / NCAAB)
========================================================= */

type RecentGame = {
  date: string | null;
  opp: string;
  isHome: boolean;
  teamPts: number | null;
  oppPts: number | null;
  result: "W" | "L" | "—";
  scoreText: string;
};

function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function safeStr(v: any): string {
  return v == null ? "" : String(v).trim();
}
function fmtYmdShort(d: string | null) {
  if (!d) return "—";
  const dt = new Date(d.includes("T") ? d : `${d}T12:00:00`);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

async function fetchLast5Games({
  sportKey,
  teamName,
}: {
  sportKey: string;
  teamName: string;
}): Promise<RecentGame[]> {
  if (!teamName) return [];

  if (sportKey === "basketball_nba") {
    const { data, error } = await supabase
      .from("basketballref_games_nba")
      .select("date, away_team, home_team, away_pts, home_pts, overtime, notes")
      .or(`away_team.ilike.%${teamName}%,home_team.ilike.%${teamName}%`)
      .order("date", { ascending: false })
      .limit(5);

    if (error || !data) return [];

    return (data as any[]).map((r) => {
      const away = safeStr(r.away_team);
      const home = safeStr(r.home_team);
      const isHome = home.toLowerCase() === teamName.toLowerCase();
      const opp = isHome ? away : home;

      const awayPts = safeNum(r.away_pts);
      const homePts = safeNum(r.home_pts);

      const teamPts = isHome ? homePts : awayPts;
      const oppPts = isHome ? awayPts : homePts;

      let result: RecentGame["result"] = "—";
      if (teamPts != null && oppPts != null) result = teamPts > oppPts ? "W" : "L";

      const scoreText = teamPts == null || oppPts == null ? "—" : `${teamPts}-${oppPts}`;

      return {
        date: r.date ?? null,
        opp,
        isHome,
        teamPts,
        oppPts,
        result,
        scoreText,
      };
    });
  }

  if (sportKey === "basketball_ncaab") {
    // Attempt literal-column table (as in your CSV):
    // Date, Team1 (Away), Score1, Team2 (Home), Score2, Neutral, Location, Season
    const { data, error } = await supabase
      .from("kenpom_games")
      .select("*")
      .or(`"Team1 (Away)".ilike.%${teamName}%,"Team2 (Home)".ilike.%${teamName}%`)
      .order("Date", { ascending: false })
      .limit(5);

    // If your DB uses snake_case, replace the query above with:
    // .or(`team1_away.ilike.%${teamName}%,team2_home.ilike.%${teamName}%`)
    // .order("date", { ascending: false })

    if (error || !data) return [];

    return (data as any[]).map((r) => {
      const away = safeStr(r["Team1 (Away)"] ?? r.team1_away ?? r.away_team);
      const home = safeStr(r["Team2 (Home)"] ?? r.team2_home ?? r.home_team);
      const isHome = home.toLowerCase() === teamName.toLowerCase();
      const opp = isHome ? away : home;

      const awayPts = safeNum(r.Score1 ?? r.score1 ?? r.away_pts);
      const homePts = safeNum(r.Score2 ?? r.score2 ?? r.home_pts);

      const teamPts = isHome ? homePts : awayPts;
      const oppPts = isHome ? awayPts : homePts;

      let result: RecentGame["result"] = "—";
      if (teamPts != null && oppPts != null) result = teamPts > oppPts ? "W" : "L";

      const scoreText = teamPts == null || oppPts == null ? "—" : `${teamPts}-${oppPts}`;

      return {
        date: r.Date ?? r.date ?? null,
        opp,
        isHome,
        teamPts,
        oppPts,
        result,
        scoreText,
      };
    });
  }

  return [];
}

function Last5Panel({ title, team, games }: { title: string; team: string; games: RecentGame[] }) {
  return (
    <div className="rounded-2xl border border-[#2a2a2a] bg-black/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-white font-extrabold text-[12px]">{title}</div>
        <div className="text-[11px] text-[#b0b0b0] font-semibold truncate max-w-[70%] text-right">
          {team}
        </div>
      </div>

      <div className="mt-2 space-y-2">
        {games.map((g, i) => (
          <div
            key={`${title}-${i}`}
            className="flex items-center justify-between gap-2 rounded-xl border border-[#1f1f1f] bg-black/20 px-3 py-2"
          >
            <div className="min-w-0">
              <div className="text-[11px] text-[#b0b0b0] font-semibold truncate">
                {fmtYmdShort(g.date)} • {g.isHome ? "vs" : "@"}{" "}
                <span className="text-white font-extrabold">{g.opp}</span>
              </div>
              <div className="text-[12px] text-white font-extrabold tabular-nums">{g.scoreText}</div>
            </div>

            <div
              className={[
                "shrink-0 rounded-full px-2 py-1 text-[10px] font-extrabold border",
                g.result === "W"
                  ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/10"
                  : g.result === "L"
                  ? "text-red-300 border-red-500/40 bg-red-500/10"
                  : "text-[#d0d0d0] border-[#2a2a2a] bg-black/20",
              ].join(" ")}
            >
              {g.result}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* =========================================================
   PLAYER PROPS (aggregate 1 row per player; all books in row)
========================================================= */

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

function fmtLineOdds(line: number | null, odds: number | null) {
  if (line == null && odds == null) return "—";
  if (line == null) return `(${odds == null ? "—" : odds})`;
  if (odds == null) return String(line);
  return `${line} (${odds})`;
}

/* =========================================================
   GAME DETAILS MODAL
========================================================= */

function GameDetailsModal({ sportKey, ev, onClose }: { sportKey: string; ev: EventOdds; onClose: () => void }) {
  const [tab, setTab] = useState<DetailsTab>("line");

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

  // last 5 state
  const [last5Away, setLast5Away] = useState<RecentGame[]>([]);
  const [last5Home, setLast5Home] = useState<RecentGame[]>([]);
  const [last5Loading, setLast5Loading] = useState(false);

  // props state
  const [propMarket, setPropMarket] = useState<PropMarket>("Points");
  const [propsLoading, setPropsLoading] = useState(true);
  const [propsError, setPropsError] = useState("");
  const [propsAgg, setPropsAgg] = useState<PropAggRow[]>([]);

  const subtitle = `${ev.away?.team ?? "Away"} vs ${ev.home?.team ?? "Home"} • ${fmtCTDateTime(ev.commenceTime)} CT`;

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

  // Predictions fetch
  useEffect(() => {
    if (tab !== "pred") return;
    let alive = true;

    setPredLoading(true);
    setPredError("");
    setPredRow(null);

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

      const row: MonteCarloRow = {
        event_id: String(r.event_id ?? ev.eventId),
        commence_time: r.commence_time ?? r.commenceTime ?? null,
        matchup: r.matchup ?? null,
        home_team: r.home_team ?? r.homeTeam ?? null,
        away_team: r.away_team ?? r.awayTeam ?? null,

        projected_home_points: toNum(r.projected_home_points),
        projected_away_points: toNum(r.projected_away_points),

        home_win_prob: toNum(r.home_win_prob),
        away_win_prob: toNum(r.away_win_prob),

        projected_margin_home: toNum(r.projected_margin_home),
        projected_total: toNum(r.projected_total),

        spread_line_home: toNum(r.spread_line_home),
        home_cover_prob: toNum(r.home_cover_prob),
        cover_push_prob: toNum(r.cover_push_prob),
        away_cover_prob: toNum(r.away_cover_prob),

        total_line: toNum(r.total_line),
        over_prob: toNum(r.over_prob),
        total_push_prob: toNum(r.total_push_prob),
        under_prob: toNum(r.under_prob),

        sigma_margin_game: toNum(r.sigma_margin_game),
        sigma_total_game: toNum(r.sigma_total_game),
      };

      setPredRow(row);
      setPredLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [tab, ev.eventId]);

  // Last 5 fetch (only when Predictions tab is open)
  useEffect(() => {
    if (tab !== "pred") return;

    const awayTeamName = ev.away?.team ?? predRow?.away_team ?? "";
    const homeTeamName = ev.home?.team ?? predRow?.home_team ?? "";
    if (!awayTeamName && !homeTeamName) return;

    let alive = true;
    setLast5Loading(true);

    (async () => {
      const [a, h] = await Promise.all([
        fetchLast5Games({ sportKey, teamName: awayTeamName }),
        fetchLast5Games({ sportKey, teamName: homeTeamName }),
      ]);
      if (!alive) return;
      setLast5Away(a);
      setLast5Home(h);
      setLast5Loading(false);
    })();

    return () => {
      alive = false;
    };
  }, [tab, sportKey, ev.away?.team, ev.home?.team, predRow?.away_team, predRow?.home_team]);

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
            metaMap.set(key, { position: m.position ?? null, picture_url: m.picture_url ?? null, team: m.team ?? null });
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

  // Key Lines derived from board consensus (so it always matches what user sees)
  const consMlAway = consensusPartsForRow(ev, "ml", "AWAY");
  const consMlHome = consensusPartsForRow(ev, "ml", "HOME");
  const consSprAway = consensusPartsForRow(ev, "spread", "AWAY");
  const consSprHome = consensusPartsForRow(ev, "spread", "HOME");
  const consTotOver = consensusPartsForRow(ev, "total", "AWAY");
  const consTotUnder = consensusPartsForRow(ev, "total", "HOME");

  return (
    <ModalShell title="Game Details" subtitle={subtitle} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <TabBtn active={tab === "line"} onClick={() => setTab("line")}>
          Line Movement
        </TabBtn>
        <TabBtn active={tab === "pred"} onClick={() => setTab("pred")}>
          Predictions
        </TabBtn>
        <TabBtn active={tab === "props"} onClick={() => setTab("props")}>
          Player Props
        </TabBtn>
      </div>

      {/* LINE MOVEMENT TAB */}
      {tab === "line" && (
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="inline-flex overflow-hidden rounded-lg border border-[#2a2a2a] bg-black/20">
              <button
                type="button"
                className={`px-3 py-1.5 text-xs font-extrabold ${lmMarket === "ml" ? "bg-[#d4af37] text-black" : "text-white"}`}
                onClick={() => setLmMarket("ml")}
              >
                Moneyline
              </button>
              <div className="w-px bg-[#2a2a2a]" />
              <button
                type="button"
                className={`px-3 py-1.5 text-xs font-extrabold ${lmMarket === "spread" ? "bg-[#d4af37] text-black" : "text-white"}`}
                onClick={() => setLmMarket("spread")}
              >
                Spread
              </button>
              <div className="w-px bg-[#2a2a2a]" />
              <button
                type="button"
                className={`px-3 py-1.5 text-xs font-extrabold ${lmMarket === "total" ? "bg-[#d4af37] text-black" : "text-white"}`}
                onClick={() => setLmMarket("total")}
              >
                Total
              </button>
            </div>

            <div className="text-[11px] text-[#b0b0b0] font-semibold">
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
            <div className="text-sm text-[#b0b0b0] p-4">Loading odds history…</div>
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

      {/* PREDICTIONS TAB */}
      {tab === "pred" && (
        <div>
          {predLoading ? (
            <div className="text-sm text-[#b0b0b0] p-4">Loading Monte Carlo predictions…</div>
          ) : predError ? (
            <div className="text-sm text-red-400 p-4">Supabase error: {predError}</div>
          ) : !predRow ? (
            <div className="text-sm text-[#b0b0b0] p-4">No predictions available for this game.</div>
          ) : (
            <div className="space-y-3">
              {/* Top: key lines + model snapshot (tightened) */}
              <div className="rounded-2xl border border-[#2a2a2a] bg-black/25 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-white font-extrabold text-[13px]">Key Lines</div>
                    <div className="text-[11px] text-[#b0b0b0] font-semibold mt-0.5">
                      Consensus + Quantum fair odds (from win probabilities)
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <div className="rounded-xl border border-[#2a2a2a] bg-black/25 px-3 py-2">
                      <div className="text-[10px] text-[#b0b0b0] font-semibold">Quantum ML</div>
                      <div className="text-white font-extrabold tabular-nums text-[12px]">
                        {awayTeam}: <span style={{ color: colors.awayHex }}>{probToAmerican(awayP)}</span> •{" "}
                        {homeTeam}: <span style={{ color: colors.homeHex }}>{probToAmerican(homeP)}</span>
                      </div>
                    </div>

                    <div className="rounded-xl border border-[#2a2a2a] bg-black/25 px-3 py-2">
                      <div className="text-[10px] text-[#b0b0b0] font-semibold">Consensus ML</div>
                      <div className="text-white font-extrabold tabular-nums text-[12px]">
                        {awayTeam}: {consMlAway.top} • {homeTeam}: {consMlHome.top}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-1 lg:grid-cols-3 gap-2">
                  <div className="rounded-xl border border-[#2a2a2a] bg-black/20 p-3">
                    <div className="text-[11px] text-[#b0b0b0] font-semibold">Consensus Spread</div>
                    <div className="mt-1 text-white font-extrabold tabular-nums">
                      {awayTeam}: {consSprAway.top} <span className="text-[#b0b0b0]">{consSprAway.bottom ?? ""}</span>
                      <span className="text-[#808080] mx-2">|</span>
                      {homeTeam}: {consSprHome.top} <span className="text-[#b0b0b0]">{consSprHome.bottom ?? ""}</span>
                    </div>
                  </div>

                  <div className="rounded-xl border border-[#2a2a2a] bg-black/20 p-3">
                    <div className="text-[11px] text-[#b0b0b0] font-semibold">Consensus Total</div>
                    <div className="mt-1 text-white font-extrabold tabular-nums">
                      Over: {consTotOver.top} <span className="text-[#b0b0b0]">{consTotOver.bottom ?? ""}</span>
                      <span className="text-[#808080] mx-2">|</span>
                      Under: {consTotUnder.top} <span className="text-[#b0b0b0]">{consTotUnder.bottom ?? ""}</span>
                    </div>
                  </div>

                  <div className="rounded-xl border border-[#2a2a2a] bg-black/20 p-3">
                    <div className="text-[11px] text-[#b0b0b0] font-semibold">Model Snapshot</div>
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      <div className="rounded-lg border border-[#2a2a2a] bg-black/25 p-2 text-center">
                        <div className="text-[10px] text-[#b0b0b0] font-semibold">Proj Total</div>
                        <div className="text-white font-extrabold tabular-nums text-[12px]">
                          {predRow.projected_total == null ? "—" : predRow.projected_total.toFixed(1)}
                        </div>
                      </div>
                      <div className="rounded-lg border border-[#2a2a2a] bg-black/25 p-2 text-center">
                        <div className="text-[10px] text-[#b0b0b0] font-semibold">Margin (H)</div>
                        <div className="text-white font-extrabold tabular-nums text-[12px]">
                          {predRow.projected_margin_home == null ? "—" : predRow.projected_margin_home.toFixed(1)}
                        </div>
                      </div>
                      <div className="rounded-lg border border-[#2a2a2a] bg-black/25 p-2 text-center">
                        <div className="text-[10px] text-[#b0b0b0] font-semibold">Run</div>
                        <div className="text-white font-extrabold tabular-nums text-[12px]">
                          {fmtCTDateTime(predRow.commence_time ?? ev.commenceTime)}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Middle: donut + teams (tight grid) */}
              <div className="rounded-2xl border border-[#2a2a2a] bg-black/25 p-4">
                <div className="grid grid-cols-1 lg:grid-cols-[1fr_200px_1fr] gap-4 items-center">
                  <div className="flex items-center gap-3">
                    {awayLogo ? (
                      <img
                        src={awayLogo}
                        alt={`${awayTeam} logo`}
                        className="w-11 h-11 rounded-md object-contain bg-white border border-[#e5e5e5] p-1"
                        loading="lazy"
                        onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                      />
                    ) : (
                      <div className="w-11 h-11 rounded-md bg-white border border-[#e5e5e5]" />
                    )}
                    <div className="min-w-0">
                      <div className="text-white font-extrabold text-[14px] truncate">{awayTeam}</div>
                      <div className="text-[11px] text-[#b0b0b0] font-semibold">
                        Quantum ML:{" "}
                        <span className="text-white font-extrabold tabular-nums" style={{ color: colors.awayHex }}>
                          {probToAmerican(awayP)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-center">
                    <SplitDonut
                      awayP={awayP}
                      homeP={homeP}
                      awayLabel="Away"
                      homeLabel="Home"
                      awayColor={colors.awayHex}
                      homeColor={colors.homeHex}
                      scoreText={scoreText}
                    />
                  </div>

                  <div className="flex items-center gap-3 justify-start lg:justify-end">
                    <div className="min-w-0 text-right">
                      <div className="text-white font-extrabold text-[14px] truncate">{homeTeam}</div>
                      <div className="text-[11px] text-[#b0b0b0] font-semibold">
                        Quantum ML:{" "}
                        <span className="text-white font-extrabold tabular-nums" style={{ color: colors.homeHex }}>
                          {probToAmerican(homeP)}
                        </span>
                      </div>
                    </div>
                    {homeLogo ? (
                      <img
                        src={homeLogo}
                        alt={`${homeTeam} logo`}
                        className="w-11 h-11 rounded-md object-contain bg-white border border-[#e5e5e5] p-1"
                        loading="lazy"
                        onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                      />
                    ) : (
                      <div className="w-11 h-11 rounded-md bg-white border border-[#e5e5e5]" />
                    )}
                  </div>
                </div>
              </div>

              {/* NEW: Last 5 Games */}
              <div className="rounded-2xl border border-[#2a2a2a] bg-black/25 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-white font-extrabold text-[13px]">Last 5 Games</div>
                    <div className="text-[11px] text-[#b0b0b0] font-semibold mt-0.5">
                      Recent results for each team (from your games tables)
                    </div>
                  </div>
                  {last5Loading && <div className="text-[11px] text-[#b0b0b0] font-semibold">Loading…</div>}
                </div>

                <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Last5Panel title="Away" team={awayTeam} games={last5Away} />
                  <Last5Panel title="Home" team={homeTeam} games={last5Home} />
                </div>
              </div>

              {/* Spread / Total probability cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-2xl border border-[#2a2a2a] bg-black/25 backdrop-blur-[2px] p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-white font-extrabold text-[13px]">Spread</div>
                    <div className="text-[11px] text-[#b0b0b0] font-semibold">
                      Line (Home):{" "}
                      <span className="text-white font-extrabold tabular-nums">{predRow.spread_line_home ?? "—"}</span>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <div className="rounded-md border border-[#2a2a2a] bg-black/25 p-2 text-center">
                      <div className="text-[10px] text-[#b0b0b0] font-semibold">{homeTeam} Cover</div>
                      <div className="text-white font-extrabold tabular-nums text-[12px]">{pct(toProb01(predRow.home_cover_prob))}</div>
                    </div>
                    <div className="rounded-md border border-[#2a2a2a] bg-black/25 p-2 text-center">
                      <div className="text-[10px] text-[#b0b0b0] font-semibold">Push</div>
                      <div className="text-white font-extrabold tabular-nums text-[12px]">{pct(toProb01(predRow.cover_push_prob))}</div>
                    </div>
                    <div className="rounded-md border border-[#2a2a2a] bg-black/25 p-2 text-center">
                      <div className="text-[10px] text-[#b0b0b0] font-semibold">{awayTeam} Cover</div>
                      <div className="text-white font-extrabold tabular-nums text-[12px]">{pct(toProb01(predRow.away_cover_prob))}</div>
                    </div>
                  </div>

                  <div className="mt-3 text-[11px] text-[#b0b0b0]">
                    σ Margin:{" "}
                    <span className="text-white font-extrabold tabular-nums">{predRow.sigma_margin_game ?? "—"}</span>
                  </div>
                </div>

                <div className="rounded-2xl border border-[#2a2a2a] bg-black/25 backdrop-blur-[2px] p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-white font-extrabold text-[13px]">Total</div>
                    <div className="text-[11px] text-[#b0b0b0] font-semibold">
                      Line:{" "}
                      <span className="text-white font-extrabold tabular-nums">{predRow.total_line ?? "—"}</span>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <div className="rounded-md border border-[#2a2a2a] bg-black/25 p-2 text-center">
                      <div className="text-[10px] text-[#b0b0b0] font-semibold">Over</div>
                      <div className="text-white font-extrabold tabular-nums text-[12px]">{pct(toProb01(predRow.over_prob))}</div>
                    </div>
                    <div className="rounded-md border border-[#2a2a2a] bg-black/25 p-2 text-center">
                      <div className="text-[10px] text-[#b0b0b0] font-semibold">Push</div>
                      <div className="text-white font-extrabold tabular-nums text-[12px]">{pct(toProb01(predRow.total_push_prob))}</div>
                    </div>
                    <div className="rounded-md border border-[#2a2a2a] bg-black/25 p-2 text-center">
                      <div className="text-[10px] text-[#b0b0b0] font-semibold">Under</div>
                      <div className="text-white font-extrabold tabular-nums text-[12px]">{pct(toProb01(predRow.under_prob))}</div>
                    </div>
                  </div>

                  <div className="mt-3 text-[11px] text-[#b0b0b0]">
                    σ Total:{" "}
                    <span className="text-white font-extrabold tabular-nums">{predRow.sigma_total_game ?? "—"}</span>
                  </div>
                </div>
              </div>

              <div className="text-[11px] text-[#b0b0b0]">
                Source: <span className="text-white font-extrabold">monte_carlo_results</span> (event_id match)
              </div>
            </div>
          )}
        </div>
      )}

      {/* PLAYER PROPS TAB */}
      {tab === "props" && (
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="inline-flex overflow-hidden rounded-lg border border-[#2a2a2a] bg-black/20">
              {PROP_MARKETS.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`px-3 py-1.5 text-xs font-extrabold ${propMarket === m ? "bg-[#d4af37] text-black" : "text-white"}`}
                  onClick={() => setPropMarket(m)}
                >
                  {m}
                </button>
              ))}
            </div>
            <div className="text-[11px] text-[#b0b0b0] font-semibold">
              One row per player • Over/Under grouped • Books in columns
            </div>
          </div>

          {propsLoading ? (
            <div className="text-sm text-[#b0b0b0] p-4">Loading props…</div>
          ) : propsError ? (
            <div className="text-sm text-red-400 p-4">Supabase error: {propsError}</div>
          ) : !propsAgg.length ? (
            <div className="text-sm text-[#b0b0b0] p-4">No props found for this game/market.</div>
          ) : (
            <div className="rounded-2xl border border-[#2a2a2a] bg-black/25 backdrop-blur-[2px] overflow-hidden">
              <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-center justify-between">
                <div className="text-white font-extrabold text-sm">{propMarket}</div>
                <div className="text-[11px] text-[#b0b0b0] font-semibold">{propsAgg.length} players</div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[#232323] bg-[#0b0b0b]">
                      <th className="text-left px-4 py-3 text-[12px] text-[#d0d0d0] font-extrabold">Player</th>
                      <th className="text-left px-3 py-3 text-[12px] text-[#d0d0d0] font-extrabold">Team</th>
                      <th className="text-center px-3 py-3 text-[12px] text-[#d0d0d0] font-extrabold">Line</th>
                      <th className="text-center px-3 py-3 text-[12px] text-[#d0d0d0] font-extrabold">Over</th>
                      <th className="text-center px-3 py-3 text-[12px] text-[#d0d0d0] font-extrabold">Under</th>
                    </tr>
                    <tr className="border-b border-[#1a1a1a] bg-[#0b0b0b]">
                      <th />
                      <th />
                      <th />
                      <th className="px-3 pb-3">
                        <div className="grid grid-cols-5 gap-2 justify-items-center">
                          {BOOKS.map((b) => (
                            <div key={`ovh-${b}`} className="text-[10px] font-extrabold" style={{ color: BOOK_STROKES[b] }}>
                              {b.toUpperCase()}
                            </div>
                          ))}
                        </div>
                      </th>
                      <th className="px-3 pb-3">
                        <div className="grid grid-cols-5 gap-2 justify-items-center">
                          {BOOKS.map((b) => (
                            <div key={`unh-${b}`} className="text-[10px] font-extrabold" style={{ color: BOOK_STROKES[b] }}>
                              {b.toUpperCase()}
                            </div>
                          ))}
                        </div>
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {propsAgg.map((r) => (
                      <tr key={r.player_name} className="border-b border-[#141414] hover:bg-white/5">
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
                              <div className="text-[11px] text-[#b0b0b0] font-semibold">{r.position ?? "—"}</div>
                            </div>
                          </div>
                        </td>

                        <td className="px-3 py-3 text-white font-extrabold text-[12px]">{r.team ?? "—"}</td>

                        <td className="px-3 py-3 text-center text-white font-extrabold tabular-nums text-[12px]">
                          {r.display_line == null ? "—" : r.display_line}
                        </td>

                        <td className="px-3 py-3">
                          <div className="grid grid-cols-5 gap-2 justify-items-center">
                            {BOOKS.map((b) => (
                              <div key={`ov-${r.player_name}-${b}`} className="text-[12px] text-white font-extrabold tabular-nums">
                                {fmtLineOdds(r.over[b].line ?? r.display_line, r.over[b].odds)}
                              </div>
                            ))}
                          </div>
                        </td>

                        <td className="px-3 py-3">
                          <div className="grid grid-cols-5 gap-2 justify-items-center">
                            {BOOKS.map((b) => (
                              <div key={`un-${r.player_name}-${b}`} className="text-[12px] text-white font-extrabold tabular-nums">
                                {fmtLineOdds(r.under[b].line ?? r.display_line, r.under[b].odds)}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="px-4 py-3 text-[11px] text-[#b0b0b0]">
                Odds from <span className="text-white font-extrabold">player_props_snapshot</span>. Player photo/position/team from{" "}
                <span className="text-white font-extrabold">player_prop_ev_latest</span>. Aggregation keeps newest per (player, side, book).
              </div>
            </div>
          )}
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

  const [detailsOpen, setDetailsOpen] = useState(false);
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

    // optional: include latest props snapshot time if available (non-blocking)
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
        const r = (propsRes.data?.[0] ?? null) as
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
    setMarket("ml");
    setDetailsOpen(false);
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

  const openDetails = (ev: EventOdds) => {
    setActiveEvent(ev);
    setDetailsOpen(true);
  };

  return (
    <div className="w-full">
      <div className={`${PAGE_MAX_W} mx-auto ${PAGE_X}`}>
        {/* HERO */}
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
                    One board per slate. Books shown side-by-side with consensus. Open Game Details for movement, predictions, and props.
                  </div>
                </div>

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

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Chip label="Sport" value={sportChip} />
                <Chip label="Games" value={events.length} />
                <Chip label="Market" value={marketLabel.toUpperCase()} />
                <Chip label="Books" value="5" />
                <Chip label="Refresh" value="60s" />
                <div className="md:hidden w-full" />
                <div className="md:hidden text-[11px] text-[#6a6a6a] font-semibold">
                  Last Updated (CT): <span className="text-white font-extrabold">{fmtCTDateTime(lastUpdatedIso)}</span>
                </div>
              </div>

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
                  {!availableDates.length && <div className="text-xs text-[#808080]">No games available.</div>}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Segmented value={market} onChange={setMarket} />
                </div>
              </div>
            </div>

            <div className="h-px bg-[#232323]" />

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
                        onOpenDetails={openDetails}
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
                            <EventTwoRows key={ev.eventId} ev={ev} market={market} onOpenDetails={openDetails} />
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

        {/* Modal */}
        {detailsOpen && activeEvent && (
          <GameDetailsModal sportKey={sportKey} ev={activeEvent} onClose={() => setDetailsOpen(false)} />
        )}

        <div className="h-12" />
      </div>
    </div>
  );
}
