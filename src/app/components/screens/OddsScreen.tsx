// screens/OddsScreen.tsx — FULL REWRITE (Functional + Player Props modal + white-pill book logos)
// ✅ Filters by sport_key
// ✅ Desktop: centered max-width “web” layout (less app-like)
// ✅ Desktop: books ALWAYS shown (no toggle)
// ✅ Book header bg slightly lighter
// ✅ Date pills ONLY show dates that actually have displayable games (same filtering as list)
// ✅ Mobile cards keep “Show/Hide Books” toggle
// ✅ History modal behavior unchanged (odds-only, line shown in hover tooltip)
// ✅ Player Props modal (player_props_snapshot) + prop-type filter (PTS/REB/AST/3PT)
// ✅ Mobile button clutter fixed: Show/Hide Books + single “More” menu (History / Props)
// ✅ Odds screen defaults to Moneyline (and resets to Moneyline on sport change)
// ✅ “Last Updated” improved: uses max(updated_at/ts/inserted_at/etc) across rows + props snapshots
// ✅ FIX: props book logos appear in white pill (readable even if logo is black)
// ✅ FIX: build error "Expected identifier but found end of file" — ensures proper closing tags

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
  ReferenceLine,
} from "recharts";

/** =========================
 * TYPES / CONSTANTS
 * ========================= */

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

/** Public folder book logos */
const BOOK_LOGOS: Record<BookKey, string> = {
  dk: "/books/dk.png",
  fd: "/books/fd.png",
  mgm: "/books/mgm.png",
  pin: "/books/pin.png",
  bol: "/books/bol.png",
};
const BOOKS: BookKey[] = ["dk", "fd", "mgm", "pin", "bol"];

/** snapshot bookmaker strings (from player_props_snapshot.bookmaker) */
const BOOKMAKER_STR_BY_KEY: Record<BookKey, string> = {
  dk: "draftkings",
  fd: "fanduel",
  mgm: "betmgm",
  pin: "pinnacle",
  bol: "betonlineag",
};

function bookKeyFromBookmaker(raw: string): BookKey | null {
  const k = String(raw || "").toLowerCase();
  if (k === "draftkings") return "dk";
  if (k === "fanduel") return "fd";
  if (k === "betmgm") return "mgm";
  if (k === "pinnacle") return "pin";
  if (k === "betonlineag") return "bol";
  return null;
}

/** Desktop layout widths (web-friendly) */
const COL_MATCHUP = 420;
const COL_CONSENSUS = 190;
const COL_BOOK = 122;

const BOOK_LOGO_W = 92;
const BOOK_LOGO_H = 24;

/** Header colors */
const HDR_LEFT_BG = "bg-[#0b0b0b]";
const HDR_BOOK_BG = "bg-[#303030]";
const HDR_TEXT = "text-[#d0d0d0]";
const HDR_BORDER = "border-[#232323]";

/** Subtle glow for header logos */
const BOOK_GLOW =
  "drop-shadow(0 1px 0 rgba(0,0,0,0.55)) drop-shadow(0 0 8px rgba(255,255,255,0.10)) drop-shadow(0 0 10px rgba(212,175,55,0.16))";

/** =========================
 * TIME HELPERS
 * ========================= */

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

/** =========================
 * MAPPING HELPERS (odds wide)
 * ========================= */

function pickLogoUrl(row: any): string | null {
  return row.logo_url ?? row.team_logo_url ?? row.logo ?? row.logoUrl ?? null;
}

function pickUpdatedAt(row: any): string | null {
  return (
    row.updated_at ??
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

/** =========================
 * CONSENSUS HELPERS
 * ========================= */

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
      {parts.bottom != null ? <div className="tabular-nums opacity-95">{parts.bottom}</div> : null}
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

/** =========================
 * HEADER FALLBACK + BOOK “PILL”
 * ========================= */

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
  const pillW = size === "sm" ? "w-[92px]" : "w-[96px]";

  return (
    <div
      className={`${pillH} ${pillW} rounded-full bg-white/95 border border-[#e5e5e5] px-3 flex items-center justify-center`}
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

/** =========================
 * SMALL UI HELPERS
 * ========================= */

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

/** =========================
 * TABLE CELLS / HEADERS
 * ========================= */

function BookHeader({
  src,
  alt,
  fallbackLabel,
  borderLeft,
}: {
  src: string;
  alt: string;
  fallbackLabel: string;
  borderLeft?: boolean;
}) {
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
      <span className="sr-only">{alt}</span>
      <div className="flex items-center justify-center">
        <div style={{ width: BOOK_LOGO_W, height: BOOK_LOGO_H }} className="flex items-center justify-center">
          <img
            src={src}
            alt={alt}
            style={{ width: BOOK_LOGO_W, height: BOOK_LOGO_H, filter: BOOK_GLOW }}
            className="object-contain opacity-95"
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).src = headerFallbackPillDataUri(fallbackLabel);
            }}
          />
        </div>
      </div>
    </th>
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

/** =========================
 * CELL GETTERS
 * ========================= */

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

/** =========================
 * HISTORY / CHARTS (ODDS ONLY)
 * ========================= */

type HistMarket = "h2h" | "spreads" | "totals";
type HistSide = "home" | "away" | "over" | "under";

type HistoryRow = {
  id: number;
  ts: string;
  event_id: string;
  bookmaker: string;
  market: HistMarket;
  side: HistSide;
  line: number | null;
  odds: number | null;
  last_update?: string | null;
  inserted_at?: string | null;
};

const HISTORY_TABLE = "odds_snapshot_history";

const BOOK_SERIES_COLOR: Record<string, string> = {
  draftkings: "#34d399",
  fanduel: "#60a5fa",
  betmgm: "#d4af37",
  pinnacle: "#f97316",
  betonlineag: "#a78bfa",
};

function seriesColor(bookmaker: string) {
  const k = String(bookmaker || "").toLowerCase();
  return BOOK_SERIES_COLOR[k] ?? "#9ca3af";
}

function fmtCTShortLabel(iso: string) {
  const n = normalizeIso(iso) ?? iso;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function impliedProbFromAmerican(odds: number) {
  if (!Number.isFinite(odds) || odds === 0) return NaN;
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

function floorToMinuteIso(iso: string) {
  const n = normalizeIso(iso) ?? iso;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return iso;
  d.setSeconds(0, 0);
  return d.toISOString();
}

function medianProbOfKeys(point: any, keys: string[]) {
  const probs: number[] = [];
  for (const k of keys) {
    const odds = point?.[k];
    if (typeof odds === "number" && Number.isFinite(odds)) {
      const p = impliedProbFromAmerican(odds);
      if (Number.isFinite(p)) probs.push(p);
    }
  }
  return median(probs);
}

type ChartPoint = {
  ts: string;
  t: string;
  mw: number | null;
  sharp: boolean;
  pinProb?: number | null;
  [k: string]: any;
};

function buildChartSeriesOddsOnly(rows: HistoryRow[], uiMarket: Market, books: string[]) {
  const binMap = new Map<string, Map<string, HistoryRow>>();

  for (const r of rows) {
    const bin = floorToMinuteIso(r.ts);
    const byBook = binMap.get(bin) ?? new Map<string, HistoryRow>();
    const prev = byBook.get(r.bookmaker);

    if (!prev) byBook.set(r.bookmaker, r);
    else {
      const pt = new Date(normalizeIso(prev.ts) ?? prev.ts).getTime();
      const rt = new Date(normalizeIso(r.ts) ?? r.ts).getTime();
      if (rt >= pt) byBook.set(r.bookmaker, r);
    }

    binMap.set(bin, byBook);
  }

  const bins = Array.from(binMap.keys()).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  const points: ChartPoint[] = bins.map((bin) => {
    const byBook = binMap.get(bin)!;
    const p: ChartPoint = { ts: bin, t: fmtCTShortLabel(bin), mw: null, sharp: false };

    for (const b of books) {
      const row = byBook.get(b);
      if (!row) continue;

      if (typeof row.odds === "number" && Number.isFinite(row.odds)) p[b] = row.odds;
      if (typeof row.line === "number" && Number.isFinite(row.line)) p[`${b}__line`] = row.line;
    }

    const probs = books
      .map((b) => p[b])
      .filter((v) => typeof v === "number" && Number.isFinite(v))
      .map((odds: number) => impliedProbFromAmerican(odds))
      .filter((q) => Number.isFinite(q));

    if (probs.length >= 2) p.mw = +(Math.max(...probs) - Math.min(...probs)).toFixed(4);

    const pinOdds = p["pinnacle"];
    if (typeof pinOdds === "number" && Number.isFinite(pinOdds)) {
      const pp = impliedProbFromAmerican(pinOdds);
      p.pinProb = Number.isFinite(pp) ? pp : null;
    } else {
      p.pinProb = null;
    }

    return p;
  });

  const PROB_MOVE = 0.02;
  const widthTight = uiMarket === "ml" ? 0.03 : uiMarket === "spread" ? 0.02 : 0.02;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];

    const widthOk = cur.mw != null ? cur.mw <= widthTight : false;

    let sharp = false;

    if (prev.pinProb != null && cur.pinProb != null) {
      if (Math.abs(cur.pinProb - prev.pinProb) >= PROB_MOVE) sharp = true;
    }

    if (!sharp && widthOk) {
      const consPrev = medianProbOfKeys(prev, books);
      const consCur = medianProbOfKeys(cur, books);
      if (consPrev != null && consCur != null) {
        if (Math.abs(consCur - consPrev) >= PROB_MOVE) sharp = true;
      }
    }

    cur.sharp = sharp;
  }

  return points;
}

function useIsMobile(bp = 640) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${bp}px)`);
    const on = () => setIsMobile(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [bp]);
  return isMobile;
}

/** =========================
 * MODAL SHELL
 * ========================= */

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
      <div className="w-full max-w-7xl rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden max-h-[92vh] flex flex-col">
        <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <div className="text-white font-extrabold text-sm">{title}</div>
            {subtitle && <div className="text-[11px] text-[#808080] mt-0.5 break-words">{subtitle}</div>}
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

/** =========================
 * PLAYER PROPS MODAL
 * ========================= */

type PropType = "player_points" | "player_rebounds" | "player_assists" | "player_threes";

const PROP_LABEL: Record<PropType, string> = {
  player_points: "Points",
  player_rebounds: "Rebounds",
  player_assists: "Assists",
  player_threes: "3 Pointers",
};

type PlayerPropSnapshotRow = {
  id: number;
  ts: string;
  run_id: string | null;
  sport_key: string;
  event_id: string | null;
  commence_time: string | null;

  home_team: string | null;
  away_team: string | null;

  player_name: string | null;
  player_id: string | null;
  team: string | null;
  opponent: string | null;

  market: string;
  side: "over" | "under" | string;
  line: number | null;
  odds: number | null;
  bookmaker: string;

  source?: string | null;
  inserted_at?: string | null;
};

type PropCell = {
  line: number | null;
  over: number | null;
  under: number | null;
};

type PlayerPropWide = {
  player: string;
  team?: string | null;
  opponent?: string | null;
  lineConsensus: number | null;
  byBook: Record<BookKey, PropCell>;
};

function initPropCell(): PropCell {
  return { line: null, over: null, under: null };
}

function propsMedianLine(rows: PlayerPropSnapshotRow[]) {
  const nums: number[] = [];
  for (const r of rows) if (typeof r.line === "number" && Number.isFinite(r.line)) nums.push(r.line);
  return median(nums);
}

function PlayerPropsModal({
  ev,
  sportKey,
  onClose,
  onLastUpdated,
}: {
  ev: EventOdds;
  sportKey: string;
  onClose: () => void;
  onLastUpdated?: (iso: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [propType, setPropType] = useState<PropType>("player_points");

  const [latestTs, setLatestTs] = useState<string | null>(null);
  const [rows, setRows] = useState<PlayerPropWide[]>([]);

  useEffect(() => {
    let alive = true;

    async function fetchRows() {
      setLoading(true);
      setErr("");
      setLatestTs(null);
      setRows([]);

      // 1) try event_id
      const r1 = await supabase
        .from("player_props_snapshot")
        .select(
          "id,ts,run_id,sport_key,event_id,commence_time,home_team,away_team,player_name,player_id,team,opponent,market,side,line,odds,bookmaker,source,inserted_at"
        )
        .eq("sport_key", sportKey)
        .eq("market", propType)
        .eq("event_id", ev.eventId)
        .order("ts", { ascending: false })
        .limit(5000);

      if (!alive) return;

      let raw = (r1.data ?? []) as PlayerPropSnapshotRow[];
      let error = r1.error;

      // 2) fallback to team match (either orientation) if no event rows
      if (!error && (!raw || raw.length === 0)) {
        const home = ev.home?.team ?? "";
        const away = ev.away?.team ?? "";

        const orFilter = [`and(home_team.eq.${home},away_team.eq.${away})`, `and(home_team.eq.${away},away_team.eq.${home})`].join(
          ","
        );

        const r2 = await supabase
          .from("player_props_snapshot")
          .select(
            "id,ts,run_id,sport_key,event_id,commence_time,home_team,away_team,player_name,player_id,team,opponent,market,side,line,odds,bookmaker,source,inserted_at"
          )
          .eq("sport_key", sportKey)
          .eq("market", propType)
          .or(orFilter)
          .order("ts", { ascending: false })
          .limit(5000);

        if (!alive) return;
        raw = (r2.data ?? []) as PlayerPropSnapshotRow[];
        error = r2.error;
      }

      if (error) {
        setErr(error.message);
        setLoading(false);
        return;
      }

      if (!raw.length) {
        setLatestTs(null);
        setRows([]);
        setLoading(false);
        return;
      }

      const newest = raw[0]?.ts ?? null;
      setLatestTs(newest);
      if (newest && onLastUpdated) onLastUpdated(newest);

      const latestOnly = raw.filter((x) => String(x.ts) === String(newest));

      const byPlayer = new Map<string, PlayerPropSnapshotRow[]>();
      for (const r of latestOnly) {
        const name = (r.player_name ?? "").trim();
        if (!name) continue;
        const arr = byPlayer.get(name) ?? [];
        arr.push(r);
        byPlayer.set(name, arr);
      }

      const wide: PlayerPropWide[] = Array.from(byPlayer.entries()).map(([player, prs]) => {
        const byBook: Record<BookKey, PropCell> = {
          dk: initPropCell(),
          fd: initPropCell(),
          mgm: initPropCell(),
          pin: initPropCell(),
          bol: initPropCell(),
        };

        for (const r of prs) {
          const bk = bookKeyFromBookmaker(r.bookmaker);
          if (!bk) continue;

          if (typeof r.line === "number" && Number.isFinite(r.line)) {
            byBook[bk].line = r.line;
          }

          const side = String(r.side || "").toLowerCase();
          if (side === "over") byBook[bk].over = typeof r.odds === "number" ? r.odds : null;
          if (side === "under") byBook[bk].under = typeof r.odds === "number" ? r.odds : null;
        }

        const lineConsensus = propsMedianLine(prs);

        return {
          player,
          team: prs[0]?.team ?? null,
          opponent: prs[0]?.opponent ?? null,
          lineConsensus,
          byBook,
        };
      });

      wide.sort((a, b) => a.player.localeCompare(b.player));
      setRows(wide);
      setLoading(false);
    }

    fetchRows();
    return () => {
      alive = false;
    };
  }, [ev.eventId, ev.home?.team, ev.away?.team, propType, sportKey, onLastUpdated]);

  const subtitle = [ev.commenceTime ? `Commence: ${fmtCTDateTime(ev.commenceTime)}` : null, latestTs ? `Snapshot: ${fmtCTDateTime(latestTs)}` : "Snapshot: —"]
    .filter(Boolean)
    .join(" · ");

  function PropTypeSelect() {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[11px] text-[#9a9a9a] font-extrabold">Prop:</div>
        <select
          value={propType}
          onChange={(e) => setPropType(e.target.value as PropType)}
          className="bg-black/30 border border-[#2a2a2a] text-white text-xs font-extrabold rounded-lg px-3 py-2"
        >
          <option value="player_points">Points</option>
          <option value="player_rebounds">Rebounds</option>
          <option value="player_assists">Assists</option>
          <option value="player_threes">3 Pointers</option>
        </select>
      </div>
    );
  }

  function PropBookCell({ cell }: { cell: PropCell }) {
    return (
      <div className="flex flex-col items-center justify-center leading-tight">
        <div className="text-[12px] text-white font-extrabold tabular-nums">{cell.line == null ? "—" : cell.line}</div>
        <div className="text-[11px] text-[#cfcfcf] font-bold tabular-nums mt-0.5">O: {cell.over == null ? "—" : cell.over}</div>
        <div className="text-[11px] text-[#cfcfcf] font-bold tabular-nums">U: {cell.under == null ? "—" : cell.under}</div>
      </div>
    );
  }

  function bookMeta(bk: BookKey) {
    return bk === "dk"
      ? { alt: "DraftKings", fb: "DK" }
      : bk === "fd"
      ? { alt: "FanDuel", fb: "FD" }
      : bk === "mgm"
      ? { alt: "BetMGM", fb: "MGM" }
      : bk === "pin"
      ? { alt: "Pinnacle", fb: "PIN" }
      : { alt: "BetOnline", fb: "BOL" };
  }

  return (
    <ModalShell title="Player Props" subtitle={subtitle} onClose={onClose}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <PropTypeSelect />
        <div className="text-[11px] text-[#808080] font-semibold">
          {rows.length ? `${rows.length} players · books: DK/FD/MGM/PIN/BOL` : "—"}
        </div>
      </div>

      {loading ? (
        <div className="text-xs text-[#808080]">Loading player props…</div>
      ) : err ? (
        <div className="text-xs text-red-400">Supabase error: {err}</div>
      ) : !rows.length ? (
        <div className="text-xs text-[#808080]">
          No rows found for <span className="text-white font-extrabold">{PROP_LABEL[propType]}</span> for this event.
        </div>
      ) : (
        <>
          {/* Desktop/tablet */}
          <div className="hidden sm:block">
            <div className="overflow-x-auto rounded-xl border border-[#2a2a2a] bg-black/20">
              <table className="min-w-[980px] w-full">
                <thead className="sticky top-0 z-10">
                  <tr className={`border-b ${HDR_BORDER}`}>
                    <th className={`text-left px-4 py-3 ${HDR_LEFT_BG} ${HDR_TEXT} text-[12px] font-extrabold`}>Player</th>
                    <th className={`text-center px-3 py-3 ${HDR_LEFT_BG} ${HDR_TEXT} text-[12px] font-extrabold border-l ${HDR_BORDER}`}>
                      Cons Line
                    </th>

                    {BOOKS.map((bk, i) => {
                      const meta = bookMeta(bk);
                      return (
                        <th
                          key={bk}
                          className={[
                            "text-center px-2 py-3",
                            HDR_BOOK_BG,
                            "border-b",
                            HDR_BORDER,
                            i === 0 ? `border-l ${HDR_BORDER}` : "",
                          ].join(" ")}
                        >
                          <div className="flex items-center justify-center">
                            <BookLogoPill src={BOOK_LOGOS[bk]} alt={meta.alt} fallbackLabel={meta.fb} size="md" />
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>

                <tbody>
                  {rows.map((r) => (
                    <tr key={r.player} className={`border-b ${HDR_BORDER} last:border-b-0 hover:bg-white/5`}>
                      <td className="px-4 py-3">
                        <div className="min-w-0">
                          <div className="text-white font-extrabold text-[13px] truncate">{r.player}</div>
                          {(r.team || r.opponent) && (
                            <div className="text-[11px] text-[#8a8a8a] font-semibold mt-0.5 truncate">
                              {r.team ?? "—"} {r.opponent ? <span className="text-[#6f6f6f]">vs {r.opponent}</span> : null}
                            </div>
                          )}
                        </div>
                      </td>

                      <td className={`px-3 py-3 text-center font-extrabold text-white tabular-nums border-l ${HDR_BORDER}`}>
                        {r.lineConsensus == null ? "—" : r.lineConsensus}
                      </td>

                      {BOOKS.map((bk, i) => (
                        <td key={bk} className={["px-2 py-3 text-center", i === 0 ? `border-l ${HDR_BORDER}` : ""].join(" ")}>
                          <PropBookCell cell={r.byBook[bk]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 text-[11px] text-[#808080]">
              Each book cell shows: <span className="text-white font-bold">Line</span> + <span className="text-white font-bold">O/U odds</span>{" "}
              (latest snapshot only).
            </div>
          </div>

          {/* Mobile */}
          <div className="sm:hidden space-y-3">
            {rows.map((r) => (
              <div key={r.player} className="rounded-xl border border-[#2a2a2a] bg-black/20 overflow-hidden">
                <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-white font-extrabold text-[13px] truncate">{r.player}</div>
                    {(r.team || r.opponent) && (
                      <div className="text-[11px] text-[#8a8a8a] font-semibold mt-0.5 truncate">
                        {r.team ?? "—"} {r.opponent ? <span className="text-[#6f6f6f]">vs {r.opponent}</span> : null}
                      </div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] text-[#808080] font-semibold">Cons</div>
                    <div className="text-white font-extrabold tabular-nums">{r.lineConsensus == null ? "—" : r.lineConsensus}</div>
                  </div>
                </div>

                <div className="p-3 grid grid-cols-2 gap-3">
                  {BOOKS.map((bk) => {
                    const meta = bookMeta(bk);
                    return (
                      <div key={bk} className="rounded-lg border border-[#2a2a2a] bg-black/10 p-3">
                        <div className="flex items-center justify-between mb-2">
                          <BookLogoPill src={BOOK_LOGOS[bk]} alt={meta.alt} fallbackLabel={meta.fb} size="sm" />
                          <div className="text-[10px] text-[#808080] font-bold">{bk.toUpperCase()}</div>
                        </div>
                        <PropBookCell cell={r.byBook[bk]} />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </ModalShell>
  );
}

/** =========================
 * HISTORY CHART PAIR (ODDS ONLY)
 * ========================= */

function HistoryChartPairOddsOnly({
  title,
  uiMarket,
  books,
  seriesA,
  seriesB,
  panelTitleA,
  panelTitleB,
}: {
  title: string;
  uiMarket: Market;
  books: string[];
  seriesA: ChartPoint[];
  seriesB: ChartPoint[];
  panelTitleA: string;
  panelTitleB: string;
}) {
  const isMobile = useIsMobile();
  const chartHeight = isMobile ? 420 : 520;

  const leftTopLabel = uiMarket === "ml" ? "Moneyline Odds" : uiMarket === "spread" ? "Spread Odds" : "Total Odds";
  const rightTopLabel = "Market Width (Prob)";

  const margin = isMobile ? { top: 8, right: 14, left: 36, bottom: 14 } : { top: 8, right: 16, left: 38, bottom: 16 };

  const legendWrapperStyle = {
    fontSize: isMobile ? 10 : 11,
    fontWeight: 700,
    color: "#cfcfcf",
  } as React.CSSProperties;

  const xTickSize = isMobile ? 10 : 11;
  const yTickSize = isMobile ? 10 : 11;

  const empty = !seriesA.length && !seriesB.length;

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-black/20 overflow-hidden">
      <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-center justify-between gap-3">
        <div className="text-white font-extrabold text-sm">{title}</div>
      </div>

      {empty ? (
        <div className="p-4 text-xs text-[#808080]">No history rows found in this window for this market.</div>
      ) : (
        <div className="p-3 sm:p-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
          {[
            { title: panelTitleA, data: seriesA } as const,
            { title: panelTitleB, data: seriesB } as const,
          ].map((panel) => (
            <div key={panel.title} className="rounded-lg border border-[#2a2a2a] bg-black/20 p-3">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="text-white font-bold text-xs">{panel.title}</div>
                <div className="flex items-center gap-3">
                  <div className="text-[10px] text-[#cfcfcf] font-extrabold">{leftTopLabel}</div>
                  <div className="text-[10px] text-[#cfcfcf] font-extrabold">{rightTopLabel}</div>
                </div>
              </div>

              <div style={{ height: chartHeight }} className="w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={panel.data} margin={margin}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="t" tick={{ fontSize: xTickSize }} interval="preserveStartEnd" />

                    <YAxis yAxisId="main" tick={{ fontSize: yTickSize }} tickMargin={8} width={isMobile ? 36 : 40} />
                    <YAxis yAxisId="mw" orientation="right" tick={{ fontSize: yTickSize }} tickMargin={8} width={isMobile ? 42 : 46} />

                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;

                        const row: any = payload[0]?.payload;

                        const series = (payload ?? [])
                          .filter((p) => p?.dataKey && typeof p.value === "number")
                          .map((p) => ({ key: String(p.dataKey), val: p.value as number }))
                          .filter((x) => x.key !== "mw");

                        const pretty = series.map((s) => {
                          const ln = row?.[`${s.key}__line`];
                          return { book: s.key, odds: s.val, line: typeof ln === "number" ? ln : null };
                        });

                        return (
                          <div className="bg-[#0a0a0a] border border-[#2a2a2a] rounded-md p-2 text-[11px] text-[#cfcfcf] max-w-[340px]">
                            <div className="font-extrabold text-white mb-1">{label}</div>

                            {row?.mw != null && (
                              <div className="mb-1">
                                <span className="font-bold">Width:</span> {row.mw}
                              </div>
                            )}

                            <div className="space-y-0.5">
                              {pretty.slice(0, 12).map((x) => (
                                <div key={x.book} className="flex items-center justify-between gap-2">
                                  <span className="text-[#9a9a9a] font-semibold">{x.book}</span>
                                  <span className="text-white font-extrabold tabular-nums">
                                    {x.odds}
                                    {x.line != null ? <span className="text-white/80"> · {x.line}</span> : null}
                                  </span>
                                </div>
                              ))}
                            </div>

                            <div className="mt-2">
                              {row?.sharp ? (
                                <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-red-500 text-white">
                                  Sharp Move
                                </span>
                              ) : (
                                <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-[#2a2a2a] text-[#cfcfcf]">
                                  —
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      }}
                    />

                    <Legend wrapperStyle={legendWrapperStyle} />

                    {books.map((b) => (
                      <Line
                        key={b}
                        yAxisId="main"
                        type="monotone"
                        dataKey={b}
                        name={b}
                        dot={false}
                        strokeWidth={2}
                        connectNulls
                        stroke={seriesColor(b)}
                      />
                    ))}

                    <Line
                      yAxisId="mw"
                      type="monotone"
                      dataKey="mw"
                      name="Market Width"
                      dot={false}
                      strokeWidth={2}
                      connectNulls
                      stroke="#e5e7eb"
                      strokeDasharray="6 6"
                    />

                    {panel.data
                      .filter((p) => p.sharp)
                      .map((p) => (
                        <ReferenceLine
                          key={`sharp-${panel.title}-${p.ts}`}
                          x={p.t}
                          stroke="rgba(239,68,68,0.55)"
                          strokeDasharray="3 3"
                          yAxisId="main"
                        />
                      ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LineMovementModal({
  ev,
  uiMarket,
  onClose,
}: {
  ev: EventOdds;
  uiMarket: Market;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [activeMarket, setActiveMarket] = useState<Market>(uiMarket);
  useEffect(() => setActiveMarket(uiMarket), [uiMarket]);

  const hoursBack = 24;
  const [books, setBooks] = useState<string[]>([]);

  const [mlAway, setMlAway] = useState<ChartPoint[]>([]);
  const [mlHome, setMlHome] = useState<ChartPoint[]>([]);
  const [spAway, setSpAway] = useState<ChartPoint[]>([]);
  const [spHome, setSpHome] = useState<ChartPoint[]>([]);
  const [toOver, setToOver] = useState<ChartPoint[]>([]);
  const [toUnder, setToUnder] = useState<ChartPoint[]>([]);

  useEffect(() => {
    let alive = true;

    async function run() {
      setLoading(true);
      setErr("");

      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from(HISTORY_TABLE)
        .select("id,ts,event_id,bookmaker,market,side,line,odds,last_update,inserted_at")
        .eq("event_id", ev.eventId)
        .gte("ts", since)
        .order("ts", { ascending: true });

      if (!alive) return;

      if (error) {
        setErr(error.message);
        setBooks([]);
        setMlAway([]);
        setMlHome([]);
        setSpAway([]);
        setSpHome([]);
        setToOver([]);
        setToUnder([]);
        setLoading(false);
        return;
      }

      const rows = (data ?? []) as HistoryRow[];

      const set = new Set<string>();
      for (const r of rows) set.add(String(r.bookmaker || "").toLowerCase());
      const bookList = Array.from(set).sort((a, b) => a.localeCompare(b));
      setBooks(bookList);

      const pick = (m: HistMarket, s: HistSide) =>
        rows.filter((r) => String(r.market).toLowerCase() === m && String(r.side).toLowerCase() === s);

      setMlAway(buildChartSeriesOddsOnly(pick("h2h", "away"), "ml", bookList));
      setMlHome(buildChartSeriesOddsOnly(pick("h2h", "home"), "ml", bookList));

      setSpAway(buildChartSeriesOddsOnly(pick("spreads", "away"), "spread", bookList));
      setSpHome(buildChartSeriesOddsOnly(pick("spreads", "home"), "spread", bookList));

      setToOver(buildChartSeriesOddsOnly(pick("totals", "over"), "total", bookList));
      setToUnder(buildChartSeriesOddsOnly(pick("totals", "under"), "total", bookList));

      setLoading(false);
    }

    run();
    return () => {
      alive = false;
    };
  }, [ev.eventId]);

  const subtitle = [ev.commenceTime ? `Commence: ${fmtCTDateTime(ev.commenceTime)}` : null, `Window: last ${hoursBack}h`, "Bucket: 1-min", "Chart: odds (line in hover)"]
    .filter(Boolean)
    .join(" · ");

  return (
    <ModalShell title="Line Movement" subtitle={subtitle} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          className={`px-3 py-1.5 rounded-lg text-xs font-extrabold border ${
            activeMarket === "ml" ? "bg-[#d4af37] text-black border-[#d4af37]" : "bg-black/20 text-[#d0d0d0] border-[#2a2a2a]"
          }`}
          onClick={() => setActiveMarket("ml")}
          type="button"
        >
          Moneyline
        </button>
        <button
          className={`px-3 py-1.5 rounded-lg text-xs font-extrabold border ${
            activeMarket === "spread" ? "bg-[#d4af37] text-black border-[#d4af37]" : "bg-black/20 text-[#d0d0d0] border-[#2a2a2a]"
          }`}
          onClick={() => setActiveMarket("spread")}
          type="button"
        >
          Spread
        </button>
        <button
          className={`px-3 py-1.5 rounded-lg text-xs font-extrabold border ${
            activeMarket === "total" ? "bg-[#d4af37] text-black border-[#d4af37]" : "bg-black/20 text-[#d0d0d0] border-[#2a2a2a]"
          }`}
          onClick={() => setActiveMarket("total")}
          type="button"
        >
          Total
        </button>
      </div>

      {loading ? (
        <div className="text-xs text-[#808080]">Loading snapshots…</div>
      ) : err ? (
        <div className="text-xs text-red-400">Supabase error: {err}</div>
      ) : (
        <div className="space-y-4">
          {activeMarket === "ml" && (
            <HistoryChartPairOddsOnly title="Moneyline (Odds)" uiMarket="ml" books={books} seriesA={mlAway} seriesB={mlHome} panelTitleA="AWAY" panelTitleB="HOME" />
          )}
          {activeMarket === "spread" && (
            <HistoryChartPairOddsOnly title="Spread (Odds)" uiMarket="spread" books={books} seriesA={spAway} seriesB={spHome} panelTitleA="AWAY" panelTitleB="HOME" />
          )}
          {activeMarket === "total" && (
            <HistoryChartPairOddsOnly title="Total (Odds)" uiMarket="total" books={books} seriesA={toOver} seriesB={toUnder} panelTitleA="OVER" panelTitleB="UNDER" />
          )}
        </div>
      )}
    </ModalShell>
  );
}

/** =========================
 * MOBILE “MORE” MENU (fix clutter)
 * ========================= */

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
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] font-extrabold text-white/90 hover:text-white px-2.5 py-1 rounded-md border border-[#2a2a2a] hover:border-[#3a3a3a]"
      >
        More ▾
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-40 rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] shadow-[0_16px_60px_rgba(0,0,0,0.45)] overflow-hidden z-20">
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

/** =========================
 * MOBILE CARD
 * ========================= */

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

  const leftPartsByBook = (b: BookKey) => partsForBookSide(ev, market, "AWAY", b);
  const rightPartsByBook = (b: BookKey) => partsForBookSide(ev, market, "HOME", b);

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
    <div className="rounded-xl border border-[#2a2a2a] bg-black/20 overflow-hidden">
      <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-center justify-between gap-3">
        <div className="text-[12px] text-[#cfcfcf] font-semibold">{fmtCTTimeOnly(ev.commenceTime)} CT</div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleBooks}
            className="text-[11px] font-extrabold text-white/90 hover:text-white px-2.5 py-1 rounded-md border border-[#2a2a2a] hover:border-[#3a3a3a]"
          >
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
        <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[12px] text-white font-extrabold">Consensus</div>
            <div className="text-[11px] text-[#808080] font-semibold">{market === "ml" ? "Moneyline" : market === "spread" ? "Spread" : "Total"}</div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-[#1f1f1f] bg-black/20 p-2">
              <div className="text-[10px] text-[#808080] font-semibold mb-0.5 text-center">{leftLabel}</div>
              <div className="text-[14px] text-white font-extrabold tabular-nums text-center">{renderCellParts(awayCons)}</div>
            </div>
            <div className="rounded-md border border-[#1f1f1f] bg-black/20 p-2">
              <div className="text-[10px] text-[#808080] font-semibold mb-0.5 text-center">{rightLabel}</div>
              <div className="text-[14px] text-white font-extrabold tabular-nums text-center">{renderCellParts(homeCons)}</div>
            </div>
          </div>
        </div>

        {booksOpen && (
          <div className="mt-3 rounded-lg border border-[#2a2a2a] bg-black/10 overflow-hidden">
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
                        <BookLogoPill src={BOOK_LOGOS[bk]} alt={meta.alt} fallbackLabel={meta.fb} size="md" />
                      </div>

                      <div className="text-center text-white font-extrabold tabular-nums text-[13px] leading-tight">{renderCellParts(leftPartsByBook(bk))}</div>
                      <div className="text-center text-white font-extrabold tabular-nums text-[13px] leading-tight">{renderCellParts(rightPartsByBook(bk))}</div>
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

/** =========================
 * DESKTOP ROWS (always books)
 * ========================= */

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
        <td className={["p-4 sticky left-0 bg-[#0f0f0f] z-10 align-middle", `border-r ${HDR_BORDER}`].join(" ")} rowSpan={2}>
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="text-[12px] text-[#cfcfcf] font-semibold">{fmtCTTimeOnly(ev.commenceTime)} CT</div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onOpenHistory(ev)}
                className="text-[11px] font-extrabold text-[#d4af37] hover:underline"
                title="View line movement history"
              >
                History
              </button>

              <button
                type="button"
                onClick={() => onOpenProps(ev)}
                className="text-[11px] font-extrabold text-white/90 hover:text-white px-2 py-1 rounded-md border border-[#2a2a2a] hover:border-[#3a3a3a]"
                title="View player props"
              >
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

/** =========================
 * SCREEN
 * ========================= */

export function OddsScreen({ sportKey }: { sportKey: string }) {
  const [allEvents, setAllEvents] = useState<EventOdds[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [market, setMarket] = useState<Market>("ml");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdatedIso, setLastUpdatedIso] = useState<string | null>(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEvent, setHistoryEvent] = useState<EventOdds | null>(null);

  const [propsOpen, setPropsOpen] = useState(false);
  const [propsEvent, setPropsEvent] = useState<EventOdds | null>(null);

  const [mobileOpenMap, setMobileOpenMap] = useState<Record<string, boolean>>({});

  function openHistory(ev: EventOdds) {
    setHistoryEvent(ev);
    setHistoryOpen(true);
  }
  function closeHistory() {
    setHistoryOpen(false);
    setHistoryEvent(null);
  }

  function openProps(ev: EventOdds) {
    setPropsEvent(ev);
    setPropsOpen(true);
  }
  function closeProps() {
    setPropsOpen(false);
    setPropsEvent(null);
  }

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
      setLoading(false);
      return;
    }

    const byEvent = new Map<string, EventOdds>();
    let globalLatest: string | null = null;

    for (const row of data ?? []) {
      const eventId = row.event_id;
      if (!eventId) continue;

      const cur =
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

    setAllEvents(list);
    setLastUpdatedIso(globalLatest);
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

  const headerLabel = market === "ml" ? "Moneyline" : market === "spread" ? "Spread" : "Total";
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

  return (
    <div className="w-full">
      <div className="max-w-[1320px] mx-auto px-4 md:px-8">
        <div className="pt-4 md:pt-6">
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
            <div>
              <h2 className="text-[22px] md:text-[28px] text-white font-extrabold tracking-tight">{sportLabel}</h2>
              <div className="text-xs text-[#8a8a8a] mt-1">{headerLabel} · 5 books · refresh 60s</div>

              <div className="md:hidden mt-2 text-[11px] text-[#6a6a6a] font-semibold">
                Last Updated (CT): <span className="text-white font-extrabold">{fmtCTDateTime(lastUpdatedIso)}</span>
              </div>
            </div>

            <div className="hidden md:block text-right">
              <div className="text-[10px] text-[#6a6a6a] font-semibold">Last Updated (CT)</div>
              <div className="text-xs text-white flex items-center justify-end gap-2">
                <span className="font-extrabold">{fmtCTDateTime(lastUpdatedIso)}</span>
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3">
            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
              {availableDates.map((d) => (
                <button
                  key={d}
                  onClick={() => setSelectedDate(d)}
                  className={[
                    "px-3 py-1.5 rounded-lg text-xs border transition-colors whitespace-nowrap font-extrabold",
                    selectedDate === d ? "bg-[#d4af37] text-black border-[#d4af37]" : "bg-black/20 text-[#d0d0d0] border-[#2a2a2a] hover:border-[#3a3a3a]",
                  ].join(" ")}
                  title={d}
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

        <div className="mt-5 rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden shadow-[0_16px_60px_rgba(0,0,0,0.38)]">
          {/* MOBILE */}
          <div className="md:hidden">
            {loading ? (
              <div className="p-4 text-xs text-[#808080]">Loading odds…</div>
            ) : error ? (
              <div className="p-4 text-xs text-red-400">Supabase error: {error}</div>
            ) : !events.length ? (
              <div className="p-4 text-xs text-[#808080]">No games for {selectedDate || "—"}.</div>
            ) : (
              <div className="p-3 space-y-3">
                {events.map((ev) => (
                  <EventCardMobile
                    key={ev.eventId}
                    ev={ev}
                    market={market}
                    booksOpen={!!mobileOpenMap[ev.eventId]}
                    onToggleBooks={() => setMobileOpenMap((prev) => ({ ...prev, [ev.eventId]: !prev[ev.eventId] }))}
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
              <div className="p-8 text-sm text-[#808080]">Loading odds…</div>
            ) : error ? (
              <div className="p-8 text-sm text-red-400">Supabase error: {error}</div>
            ) : !events.length ? (
              <div className="p-8 text-sm text-[#808080]">No games for {selectedDate || "—"}.</div>
            ) : (
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
                      <th className={["text-left px-4 py-3", HDR_LEFT_BG, HDR_TEXT, "sticky left-0 z-30 text-[13px] font-extrabold"].join(" ")}>
                        Matchup
                      </th>

                      <th className={["text-center px-3 py-3", HDR_LEFT_BG, HDR_TEXT, "z-20 text-[13px] font-extrabold border-l", HDR_BORDER].join(" ")}>
                        Consensus
                      </th>

                      <BookHeader src={BOOK_LOGOS.dk} alt="DraftKings" fallbackLabel="DK" borderLeft />
                      <BookHeader src={BOOK_LOGOS.fd} alt="FanDuel" fallbackLabel="FD" />
                      <BookHeader src={BOOK_LOGOS.mgm} alt="BetMGM" fallbackLabel="MGM" />
                      <BookHeader src={BOOK_LOGOS.pin} alt="Pinnacle" fallbackLabel="PIN" />
                      <BookHeader src={BOOK_LOGOS.bol} alt="BetOnline" fallbackLabel="BOL" />
                    </tr>
                  </thead>

                  <tbody>
                    {events.map((ev) => (
                      <EventTwoRows key={ev.eventId} ev={ev} market={market} onOpenHistory={openHistory} onOpenProps={openProps} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* History modal */}
        {historyOpen && historyEvent?.eventId && <LineMovementModal ev={historyEvent} uiMarket={market} onClose={closeHistory} />}

        {/* Player Props modal */}
        {propsOpen && propsEvent?.eventId && (
          <PlayerPropsModal
            ev={propsEvent}
            sportKey={sportKey}
            onClose={closeProps}
            onLastUpdated={(iso) => setLastUpdatedIso((prev) => maxIso(prev, iso))}
          />
        )}

        <div className="h-12" />
      </div>
    </div>
  );
}






