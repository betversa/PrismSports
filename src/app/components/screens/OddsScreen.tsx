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
  Legend,
  ReferenceLine,
} from "recharts";

/**
 * ODDS SCREEN — FULL REWRITE (Desktop + Mobile)
 *
 * ✅ Mobile:
 * - Cards are CLEAN: consensus always visible, books start collapsed
 * - One books list (no Away/ Home separate blocks)
 * - Each book row shows: [logo] | Away value | Home value (or Over/Under)
 * - NO sportsbook name text (logo only)
 * - Logos are always readable via white pill
 *
 * ✅ Desktop:
 * - Table starts "clean": Matchup + Consensus only
 * - Toggle "Show Books" reveals the 5 book columns
 *
 * ✅ History modal:
 * - Mobile-friendly sizing: max height, scrollable content area
 * - Backdrop click + Esc close preserved
 */

type Market = "ml" | "spread" | "total";
type BookKey = "dk" | "fd" | "mgm" | "pin" | "bol";

type SpreadCell = { line: number | null; odds: number | null };
type TotalCell = { line: number | null; over: number | null; under: number | null };

type SideOdds = {
  side: "AWAY" | "HOME";
  team: string;
  logoUrl: string | null;

  ml: { dk: number | null; fd: number | null; mgm: number | null; pin: number | null; bol: number | null };
  spread: { dk: SpreadCell; fd: SpreadCell; mgm: SpreadCell; pin: SpreadCell; bol: SpreadCell };
  total: { dk: TotalCell; fd: TotalCell; mgm: TotalCell; pin: TotalCell; bol: TotalCell };

  updatedAt: string | null;
};

type EventOdds = {
  eventId: string;
  commenceTime: string;
  away?: SideOdds;
  home?: SideOdds;
  latestUpdatedAt: string | null;
};

const CT_TZ = "America/Chicago";

/** Public folder book logos (FULL-COLOR assets) */
const BOOK_LOGOS: Record<BookKey, string> = {
  dk: "/books/dk.png",
  fd: "/books/fd.png",
  mgm: "/books/mgm.png",
  pin: "/books/pin.png",
  bol: "/books/bol.png",
};

const BOOKS: BookKey[] = ["dk", "fd", "mgm", "pin", "bol"];

/** Desktop layout */
const COL_MATCHUP = 440;
const COL_CONSENSUS = 190;
const COL_BOOK = 132;

const BOOK_LOGO_W = 104;
const BOOK_LOGO_H = 26;

/** Header colors */
const HDR_LEFT_BG = "bg-[#0a0a0a]";
const HDR_BOOK_BG = "bg-[#3f3f3f]";
const HDR_TEXT = "text-[#cfcfcf]";
const HDR_BORDER = "border-[#2a2a2a]";

/** Subtle glow for header logos */
const BOOK_GLOW =
  "drop-shadow(0 1px 0 rgba(0,0,0,0.65)) drop-shadow(0 0 8px rgba(255,255,255,0.12)) drop-shadow(0 0 8px rgba(212,175,55,0.18))";

/** ---------- time helpers ---------- */
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
  return new Intl.DateTimeFormat("en-US", { timeZone: CT_TZ, hour: "numeric", minute: "2-digit" }).format(d);
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

/** ---------- formatting helpers ---------- */
function fmtML(v: number | null) {
  return v == null ? "—" : `${v}`;
}
function fmtSpread(cell: SpreadCell) {
  if (!cell || cell.line == null) return "—";
  if (cell.odds == null) return `${cell.line}`;
  return `${cell.line} (${cell.odds})`;
}
function fmtTotalSplit(cell: TotalCell, which: "over" | "under") {
  if (!cell || cell.line == null) return "—";
  const v = which === "over" ? cell.over : cell.under;
  const tag = which === "over" ? "O" : "U";
  return `${cell.line} ${tag}${v == null ? "—" : v}`;
}

/** ---------- mapping helpers ---------- */
function pickLogoUrl(row: any): string | null {
  return row.logo_url ?? row.team_logo_url ?? row.logo ?? null;
}
function pickUpdatedAt(row: any): string | null {
  return row.updated_at ?? row.last_updated ?? row.updatedAt ?? null;
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
      dk: { line: row.dk_total_line ?? null, over: row.dk_total_over_odds ?? null, under: row.dk_total_under_odds ?? null },
      fd: { line: row.fd_total_line ?? null, over: row.fd_total_over_odds ?? null, under: row.fd_total_under_odds ?? null },
      mgm: { line: row.mgm_total_line ?? null, over: row.mgm_total_over_odds ?? null, under: row.mgm_total_under_odds ?? null },
      pin: { line: row.pin_total_line ?? null, over: row.pin_total_over_odds ?? null, under: row.pin_total_under_odds ?? null },
      bol: { line: row.bol_total_line ?? null, over: row.bol_total_over_odds ?? null, under: row.bol_total_under_odds ?? null },
    },
  };
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

/** ---------- consensus helpers ---------- */
function median(nums: number[]) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * Consensus rendered like a book cell for selected market.
 * Total: AWAY row shows Over; HOME row shows Under.
 */
function consensusValueForRow(ev: EventOdds, market: Market, side: "AWAY" | "HOME") {
  const a = ev.away;
  const h = ev.home;
  const src = side === "AWAY" ? a : h;

  if (market === "ml") {
    const odds: number[] = [];
    if (src) for (const b of BOOKS) if (typeof src.ml[b] === "number") odds.push(src.ml[b] as number);
    return fmtML(median(odds) as any);
  }

  if (market === "spread") {
    const lines: number[] = [];
    const odds: number[] = [];
    if (src) {
      for (const b of BOOKS) {
        const line = src.spread[b]?.line;
        const o = src.spread[b]?.odds;
        if (typeof line === "number") lines.push(line);
        if (typeof o === "number") odds.push(o);
      }
    }
    const mLine = median(lines);
    const mOdds = median(odds);
    if (mLine == null) return "—";
    if (mOdds == null) return `${mLine}`;
    return `${mLine} (${mOdds})`;
  }

  const lines: number[] = [];
  const overOdds: number[] = [];
  const underOdds: number[] = [];

  if (a) {
    for (const b of BOOKS) {
      const line = a.total[b]?.line;
      const o = a.total[b]?.over;
      if (typeof line === "number") lines.push(line);
      if (typeof o === "number") overOdds.push(o);
    }
  }
  if (h) {
    for (const b of BOOKS) {
      const u = h.total[b]?.under;
      if (typeof u === "number") underOdds.push(u);
    }
  }

  const mLine = median(lines);
  const mOver = median(overOdds);
  const mUnder = median(underOdds);

  if (mLine == null) return "—";
  return side === "AWAY"
    ? `${mLine} O${mOver == null ? "—" : mOver}`
    : `${mLine} U${mUnder == null ? "—" : mUnder}`;
}

/** ---------- header logo fallback ---------- */
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

/** ---------- UI components ---------- */
function MarketButton({
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
      onClick={onClick}
      className={[
        "px-3 py-1.5 rounded-md text-xs border transition-colors",
        active
          ? "bg-[#d4af37] text-black border-[#d4af37]"
          : "bg-[#0f0f0f] text-[#cfcfcf] border-[#2a2a2a] hover:border-[#3a3a3a]",
      ].join(" ")}
      type="button"
    >
      {children}
    </button>
  );
}

/** Mobile: white logo pill so black logo text is readable */
function BookLogoPill({ src, alt, fallbackLabel }: { src: string; alt: string; fallbackLabel: string }) {
  return (
    <div
      className="h-8 w-[96px] rounded-full bg-white/95 border border-[#e5e5e5] px-3 flex items-center justify-center"
      style={{
        boxShadow:
          "0 0 0 1px rgba(0,0,0,0.15), 0 8px 18px rgba(0,0,0,0.35), 0 0 10px rgba(212,175,55,0.10)",
      }}
    >
      <img
        src={src}
        alt={alt}
        className="h-5 w-auto object-contain"
        loading="lazy"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).src = headerFallbackPillDataUri(fallbackLabel);
        }}
      />
    </div>
  );
}

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

function BookValue({ value, borderLeft }: { value: string; borderLeft?: boolean }) {
  return (
    <td
      className={[
        "p-3 text-white text-center tabular-nums font-bold text-[13.5px]",
        borderLeft ? `border-l ${HDR_BORDER}` : "",
      ].join(" ")}
    >
      {value}
    </td>
  );
}

function ConsensusValue({ value }: { value: string }) {
  return (
    <td className={["p-3 text-white text-center tabular-nums font-bold text-[13.5px]", `border-r ${HDR_BORDER}`].join(" ")}>
      {value}
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
          className="w-12 h-12 rounded-md object-contain bg-white border border-[#e5e5e5] p-1"
          loading="lazy"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <div className="w-12 h-12 rounded-md bg-white border border-[#e5e5e5]" />
      )}

      <div className="leading-tight">
        <div className="text-white font-extrabold text-[16px]">{team}</div>
        <div className="text-[11px] text-[#7a7a7a] font-semibold">{side}</div>
      </div>
    </div>
  );
}

/** =========================================
 * HISTORY MODAL (mobile-friendly sizing)
 * ========================================= */

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

const UI_TO_HIST_MARKET: Record<Market, HistMarket> = {
  ml: "h2h",
  spread: "spreads",
  total: "totals",
};

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

function medianOfKeys(point: any, keys: string[], valueMode: "line" | "odds") {
  const vals: number[] = [];
  for (const k of keys) {
    const v = point?.[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      if (valueMode === "odds") {
        const p = impliedProbFromAmerican(v);
        if (Number.isFinite(p)) vals.push(p);
      } else {
        vals.push(v);
      }
    }
  }
  return median(vals);
}

type ChartPoint = {
  ts: string;
  t: string;
  mw: number | null;
  sharp: boolean;
  shade: boolean;
  pin?: number;
  [book: string]: any;
};

function buildChartSeries(
  rows: HistoryRow[],
  uiMarket: Market,
  valueMode: "line" | "odds",
  books: string[],
  enableWidth: boolean,
  enableShading: boolean,
  enableSharp: boolean
): ChartPoint[] {
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
    const p: ChartPoint = { ts: bin, t: fmtCTShortLabel(bin), mw: null, sharp: false, shade: false };

    for (const b of books) {
      const row = byBook.get(b);
      if (!row) continue;
      if (valueMode === "line") {
        if (typeof row.line === "number" && Number.isFinite(row.line)) p[b] = row.line;
      } else {
        if (typeof row.odds === "number" && Number.isFinite(row.odds)) p[b] = row.odds;
      }
    }

    if (typeof p["pinnacle"] === "number") p.pin = p["pinnacle"];

    if (enableWidth) {
      if (valueMode === "line") {
        const vals = books.map((b) => p[b]).filter((v) => typeof v === "number" && Number.isFinite(v));
        if (vals.length >= 2) p.mw = +(Math.max(...vals) - Math.min(...vals)).toFixed(2);
      } else {
        const probs = books
          .map((b) => p[b])
          .filter((v) => typeof v === "number" && Number.isFinite(v))
          .map((odds: number) => impliedProbFromAmerican(odds))
          .filter((q) => Number.isFinite(q));
        if (probs.length >= 2) p.mw = +(Math.max(...probs) - Math.min(...probs)).toFixed(4);
      }
    }

    return p;
  });

  const SHADE_DP = 0.02;

  if (enableShading) {
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const cur = points[i];

      let shaded = false;
      for (const b of books) {
        const pv = prev[b];
        const cv = cur[b];
        if (typeof pv !== "number" || typeof cv !== "number") continue;

        if (valueMode === "odds") {
          const pp = impliedProbFromAmerican(pv);
          const cp = impliedProbFromAmerican(cv);
          if (!Number.isFinite(pp) || !Number.isFinite(cp)) continue;
          if (Math.abs(cp - pp) >= SHADE_DP) {
            shaded = true;
            break;
          }
        }
      }

      cur.shade = shaded;
    }
  }

  const LINE_MOVE = uiMarket === "spread" ? 0.5 : uiMarket === "total" ? 1.0 : 0.0;
  const PROB_MOVE = 0.02;

  if (enableSharp) {
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const cur = points[i];

      const widthOk =
        cur.mw != null &&
        (valueMode === "line"
          ? uiMarket === "spread"
            ? cur.mw <= 0.5
            : uiMarket === "total"
            ? cur.mw <= 1.0
            : true
          : cur.mw <= 0.02);

      let sharp = false;

      if (typeof prev.pin === "number" && typeof cur.pin === "number") {
        if (valueMode === "line") {
          if (Math.abs(cur.pin - prev.pin) >= LINE_MOVE) sharp = true;
        } else {
          const pp = impliedProbFromAmerican(prev.pin);
          const cp = impliedProbFromAmerican(cur.pin);
          if (Number.isFinite(pp) && Number.isFinite(cp) && Math.abs(cp - pp) >= PROB_MOVE) sharp = true;
        }
      }

      if (!sharp && widthOk) {
        const consPrev = medianOfKeys(prev, books, valueMode);
        const consCur = medianOfKeys(cur, books, valueMode);
        if (consPrev != null && consCur != null) {
          if (valueMode === "line") {
            if (Math.abs(consCur - consPrev) >= LINE_MOVE) sharp = true;
          } else {
            if (Math.abs(consCur - consPrev) >= PROB_MOVE) sharp = true;
          }
        }
      }

      cur.sharp = sharp;
    }
  }

  return points;
}

function Badge({ label, kind }: { label: string; kind: "gold" | "red" | "gray" }) {
  const cls =
    kind === "gold"
      ? "bg-[#d4af37] text-black"
      : kind === "red"
      ? "bg-red-500 text-white"
      : "bg-[#2a2a2a] text-[#cfcfcf]";
  return <span className={`px-2 py-0.5 rounded-md text-[10px] font-extrabold ${cls}`}>{label}</span>;
}

function TogglePill({
  on,
  onClick,
  label,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "px-2.5 py-1 rounded-md text-[11px] font-extrabold border",
        on
          ? "bg-[#d4af37] text-black border-[#d4af37]"
          : "bg-[#0f0f0f] text-[#cfcfcf] border-[#2a2a2a] hover:border-[#3a3a3a]",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

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
      <div className="w-full max-w-6xl rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden max-h-[92vh] flex flex-col">
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

        {/* scrollable body */}
        <div className="p-3 sm:p-4 overflow-y-auto">{children}</div>
      </div>
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

  const [hoursBack] = useState(24);
  const [showWidth, setShowWidth] = useState(true);
  const [showShading, setShowShading] = useState(true);
  const [showSharp, setShowSharp] = useState(true);

  const [valueMode, setValueMode] = useState<"line" | "odds">(
    uiMarket === "ml" ? "odds" : uiMarket === "total" ? "odds" : "line"
  );

  useEffect(() => {
    setValueMode(uiMarket === "ml" ? "odds" : uiMarket === "total" ? "odds" : "line");
  }, [uiMarket]);

  const [books, setBooks] = useState<string[]>([]);
  const [seriesA, setSeriesA] = useState<ChartPoint[]>([]);
  const [seriesB, setSeriesB] = useState<ChartPoint[]>([]);

  const panelA: HistSide = uiMarket === "total" ? "over" : "away";
  const panelB: HistSide = uiMarket === "total" ? "under" : "home";

  useEffect(() => {
    let alive = true;

    async function run() {
      setLoading(true);
      setErr("");

      const histMarket = UI_TO_HIST_MARKET[uiMarket];
      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from(HISTORY_TABLE)
        .select("id,ts,event_id,bookmaker,market,side,line,odds,last_update,inserted_at")
        .eq("event_id", ev.eventId)
        .eq("market", histMarket)
        .gte("ts", since)
        .order("ts", { ascending: true });

      if (!alive) return;

      if (error) {
        setErr(error.message);
        setBooks([]);
        setSeriesA([]);
        setSeriesB([]);
        setLoading(false);
        return;
      }

      const rows = (data ?? []) as HistoryRow[];

      const set = new Set<string>();
      for (const r of rows) set.add(String(r.bookmaker || "").toLowerCase());
      const bookList = Array.from(set).sort((a, b) => a.localeCompare(b));
      setBooks(bookList);

      const aRows = rows.filter((r) => String(r.side).toLowerCase() === panelA);
      const bRows = rows.filter((r) => String(r.side).toLowerCase() === panelB);

      const A = buildChartSeries(aRows, uiMarket, valueMode, bookList, showWidth, showShading, showSharp);
      const B = buildChartSeries(bRows, uiMarket, valueMode, bookList, showWidth, showShading, showSharp);

      setSeriesA(A);
      setSeriesB(B);

      setLoading(false);
    }

    run();
    return () => {
      alive = false;
    };
  }, [ev.eventId, uiMarket, hoursBack, valueMode, showWidth, showShading, showSharp]);

  const subtitle = [
    ev.commenceTime ? `Commence: ${fmtCTDateTime(ev.commenceTime)}` : null,
    `Market: ${uiMarket.toUpperCase()} (${UI_TO_HIST_MARKET[uiMarket]})`,
    `Mode: ${valueMode === "line" ? "Line" : "Odds"}`,
    `Window: last ${hoursBack}h`,
    "Bucket: 1-min",
  ]
    .filter(Boolean)
    .join(" · ");

  const yLabel =
    valueMode === "line"
      ? uiMarket === "spread"
        ? "Spread Line"
        : uiMarket === "total"
        ? "Total Line"
        : "Line"
      : uiMarket === "ml"
      ? "ML Odds"
      : "Odds";

  const mwLabel = valueMode === "line" ? "Market Width (Pts)" : "Market Width (Prob)";
  const panelTitleA = uiMarket === "total" ? "OVER" : "AWAY";
  const panelTitleB = uiMarket === "total" ? "UNDER" : "HOME";

  const anySharpA = seriesA.some((p) => p.sharp);
  const anyShadeA = seriesA.some((p) => p.shade);
  const anySharpB = seriesB.some((p) => p.sharp);
  const anyShadeB = seriesB.some((p) => p.shade);

  return (
    <ModalShell title="Line Movement" subtitle={subtitle} onClose={onClose}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap items-center gap-2">
          {uiMarket !== "ml" && (
            <>
              <TogglePill on={valueMode === "line"} onClick={() => setValueMode("line")} label="Line" />
              <TogglePill on={valueMode === "odds"} onClick={() => setValueMode("odds")} label="Odds" />
            </>
          )}
          <TogglePill on={showWidth} onClick={() => setShowWidth((v) => !v)} label="Market Width" />
          <TogglePill on={showShading} onClick={() => setShowShading((v) => !v)} label="Soft Shading" />
          <TogglePill on={showSharp} onClick={() => setShowSharp((v) => !v)} label="Sharp Moves" />
        </div>

        <div className="flex items-center gap-2">
          {(showSharp && (anySharpA || anySharpB)) && <Badge label="Sharp Move Detected" kind="red" />}
          {(showShading && (anyShadeA || anyShadeB)) && <Badge label="Soft Shading" kind="gold" />}
          {!anySharpA && !anySharpB && !anyShadeA && !anyShadeB && <Badge label="No Alerts" kind="gray" />}
        </div>
      </div>

      {loading ? (
        <div className="text-xs text-[#808080]">Loading snapshots…</div>
      ) : err ? (
        <div className="text-xs text-red-400">Supabase error: {err}</div>
      ) : !seriesA.length && !seriesB.length ? (
        <div className="text-xs text-[#808080]">No history rows found for this event/market in the selected window.</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[
            { title: panelTitleA, data: seriesA, anySharp: anySharpA, anyShade: anyShadeA } as const,
            { title: panelTitleB, data: seriesB, anySharp: anySharpB, anyShade: anyShadeB } as const,
          ].map((panel) => (
            <div key={panel.title} className="rounded-lg border border-[#2a2a2a] bg-black/20 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-white font-bold text-xs">{panel.title}</div>
                <div className="flex items-center gap-2">
                  {showSharp && panel.anySharp && <Badge label="Sharp" kind="red" />}
                  {showShading && panel.anyShade && <Badge label="Shading" kind="gold" />}
                </div>
              </div>

              <div className="h-[320px] sm:h-[360px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={panel.data}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="t" tick={{ fontSize: 11 }} />
                    <YAxis
                      yAxisId="main"
                      tick={{ fontSize: 11 }}
                      label={{ value: yLabel, angle: -90, position: "insideLeft" }}
                    />
                    {showWidth && (
                      <YAxis
                        yAxisId="mw"
                        orientation="right"
                        tick={{ fontSize: 11 }}
                        label={{ value: mwLabel, angle: 90, position: "insideRight" }}
                      />
                    )}

                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        const row: any = payload[0]?.payload;
                        const lines = (payload ?? [])
                          .filter((p) => p?.dataKey && typeof p.value === "number")
                          .map((p) => ({ k: String(p.dataKey), v: p.value as number }))
                          .filter((x) => x.k !== "mw");

                        return (
                          <div className="bg-[#0a0a0a] border border-[#2a2a2a] rounded-md p-2 text-[11px] text-[#cfcfcf] max-w-[260px]">
                            <div className="font-extrabold text-white mb-1">{label}</div>

                            {showWidth && row?.mw != null && (
                              <div className="mb-1">
                                <span className="font-bold">Width:</span> {row.mw}
                              </div>
                            )}

                            <div className="space-y-0.5">
                              {lines.slice(0, 8).map((x) => (
                                <div key={x.k} className="flex items-center justify-between gap-2">
                                  <span className="text-[#9a9a9a] font-semibold">{x.k}</span>
                                  <span className="text-white font-extrabold tabular-nums">{x.v}</span>
                                </div>
                              ))}
                            </div>

                            <div className="flex gap-2 mt-2">
                              {showSharp && row?.sharp && <Badge label="Sharp" kind="red" />}
                              {showShading && row?.shade && <Badge label="Shading" kind="gold" />}
                            </div>
                          </div>
                        );
                      }}
                    />

                    <Legend />

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

                    {showWidth && (
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
                    )}

                    {showSharp &&
                      panel.data
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
    </ModalShell>
  );
}

/** ---------- Desktop two-row renderer (supports hide/show books) ---------- */
function EventTwoRows({
  ev,
  market,
  showBooks,
  onOpenHistory,
}: {
  ev: EventOdds;
  market: Market;
  showBooks: boolean;
  onOpenHistory: (ev: EventOdds) => void;
}) {
  const away = ev.away;
  const home = ev.home;

  const mk = (s: SideOdds | undefined) => {
    if (!s) return { dk: "—", fd: "—", mgm: "—", pin: "—", bol: "—" };
    if (market === "ml") {
      return { dk: fmtML(s.ml.dk), fd: fmtML(s.ml.fd), mgm: fmtML(s.ml.mgm), pin: fmtML(s.ml.pin), bol: fmtML(s.ml.bol) };
    }
    if (market === "spread") {
      return { dk: fmtSpread(s.spread.dk), fd: fmtSpread(s.spread.fd), mgm: fmtSpread(s.spread.mgm), pin: fmtSpread(s.spread.pin), bol: fmtSpread(s.spread.bol) };
    }
    return {
      dk: fmtTotalSplit(s.total.dk, s.side === "AWAY" ? "over" : "under"),
      fd: fmtTotalSplit(s.total.fd, s.side === "AWAY" ? "over" : "under"),
      mgm: fmtTotalSplit(s.total.mgm, s.side === "AWAY" ? "over" : "under"),
      pin: fmtTotalSplit(s.total.pin, s.side === "AWAY" ? "over" : "under"),
      bol: fmtTotalSplit(s.total.bol, s.side === "AWAY" ? "over" : "under"),
    };
  };

  const awayCells = mk(away);
  const homeCells = mk(home);

  const awayConsensus = consensusValueForRow(ev, market, "AWAY");
  const homeConsensus = consensusValueForRow(ev, market, "HOME");

  return (
    <>
      <tr className="hover:bg-[#0f0f0f]/50 transition-colors">
        <td className={["p-4 sticky left-0 bg-[#0f0f0f] z-10 align-middle", `border-r ${HDR_BORDER}`].join(" ")} rowSpan={2}>
          <div className="text-[12px] text-[#cfcfcf] font-semibold mb-3 flex items-center justify-between gap-3">
            <span>{fmtCTTimeOnly(ev.commenceTime)} CT</span>
            <button
              type="button"
              onClick={() => onOpenHistory(ev)}
              className="text-[11px] font-extrabold text-[#d4af37] hover:underline"
              title="View line movement history"
            >
              History
            </button>
          </div>

          <div className="space-y-3">
            <MiniTeamRow team={away?.team ?? "Away"} logoUrl={away?.logoUrl ?? null} side="AWAY" />
            <MiniTeamRow team={home?.team ?? "Home"} logoUrl={home?.logoUrl ?? null} side="HOME" />
          </div>
        </td>

        <ConsensusValue value={awayConsensus} />

        {showBooks && (
          <>
            <BookValue value={awayCells.dk} borderLeft />
            <BookValue value={awayCells.fd} />
            <BookValue value={awayCells.mgm} />
            <BookValue value={awayCells.pin} />
            <BookValue value={awayCells.bol} />
          </>
        )}
      </tr>

      <tr className={["hover:bg-[#0f0f0f]/50 transition-colors", `border-t border-[#1a1a1a]/60 border-b-2 ${HDR_BORDER}`].join(" ")}>
        <ConsensusValue value={homeConsensus} />

        {showBooks && (
          <>
            <BookValue value={homeCells.dk} borderLeft />
            <BookValue value={homeCells.fd} />
            <BookValue value={homeCells.mgm} />
            <BookValue value={homeCells.pin} />
            <BookValue value={homeCells.bol} />
          </>
        )}
      </tr>
    </>
  );
}

/** ---------- Mobile: one book row with two values (logo only) ---------- */
function BookRowMobile2Col({
  book,
  leftLabel,
  leftValue,
  rightLabel,
  rightValue,
}: {
  book: BookKey;
  leftLabel: string;
  leftValue: string;
  rightLabel: string;
  rightValue: string;
}) {
  const meta =
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
    <div className="py-2 border-b border-[#141414] last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <BookLogoPill src={BOOK_LOGOS[book]} alt={meta.alt} fallbackLabel={meta.fb} />

        <div className="flex items-center gap-4 shrink-0">
          <div className="text-right">
            <div className="text-[10px] text-[#808080] font-semibold leading-none">{leftLabel}</div>
            <div className="text-[13px] text-white font-extrabold tabular-nums leading-tight">{leftValue}</div>
          </div>
          <div className="w-px h-8 bg-[#1f1f1f]" />
          <div className="text-right">
            <div className="text-[10px] text-[#808080] font-semibold leading-none">{rightLabel}</div>
            <div className="text-[13px] text-white font-extrabold tabular-nums leading-tight">{rightValue}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** ---------- Mobile card renderer (books collapsible; consensus always visible) ---------- */
function EventCardMobile({
  ev,
  market,
  booksOpen,
  onToggleBooks,
  onOpenHistory,
}: {
  ev: EventOdds;
  market: Market;
  booksOpen: boolean;
  onToggleBooks: () => void;
  onOpenHistory: (ev: EventOdds) => void;
}) {
  const away = ev.away;
  const home = ev.home;

  const mkRow = (s: SideOdds | undefined) => {
    if (!s) return { dk: "—", fd: "—", mgm: "—", pin: "—", bol: "—" };
    if (market === "ml") {
      return { dk: fmtML(s.ml.dk), fd: fmtML(s.ml.fd), mgm: fmtML(s.ml.mgm), pin: fmtML(s.ml.pin), bol: fmtML(s.ml.bol) };
    }
    if (market === "spread") {
      return { dk: fmtSpread(s.spread.dk), fd: fmtSpread(s.spread.fd), mgm: fmtSpread(s.spread.mgm), pin: fmtSpread(s.spread.pin), bol: fmtSpread(s.spread.bol) };
    }
    return {
      dk: fmtTotalSplit(s.total.dk, s.side === "AWAY" ? "over" : "under"),
      fd: fmtTotalSplit(s.total.fd, s.side === "AWAY" ? "over" : "under"),
      mgm: fmtTotalSplit(s.total.mgm, s.side === "AWAY" ? "over" : "under"),
      pin: fmtTotalSplit(s.total.pin, s.side === "AWAY" ? "over" : "under"),
      bol: fmtTotalSplit(s.total.bol, s.side === "AWAY" ? "over" : "under"),
    };
  };

  const awayCells = mkRow(away);
  const homeCells = mkRow(home);

  const awayCons = consensusValueForRow(ev, market, "AWAY");
  const homeCons = consensusValueForRow(ev, market, "HOME");

  const leftLabel = market === "total" ? "Over" : "Away";
  const rightLabel = market === "total" ? "Under" : "Home";

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-black/20 overflow-hidden">
      {/* top bar */}
      <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-center justify-between gap-3">
        <div className="text-[12px] text-[#cfcfcf] font-semibold">{fmtCTTimeOnly(ev.commenceTime)} CT</div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onToggleBooks}
            className="text-[11px] font-extrabold text-white/90 hover:text-white px-2 py-1 rounded-md border border-[#2a2a2a] hover:border-[#3a3a3a]"
          >
            {booksOpen ? "Hide Books" : "Show Books"}
          </button>

          <button
            type="button"
            onClick={() => onOpenHistory(ev)}
            className="text-[11px] font-extrabold text-[#d4af37] hover:underline"
          >
            History
          </button>
        </div>
      </div>

      {/* teams */}
      <div className="px-4 py-3 space-y-3">
        <MiniTeamRow team={away?.team ?? "Away"} logoUrl={away?.logoUrl ?? null} side="AWAY" />
        <MiniTeamRow team={home?.team ?? "Home"} logoUrl={home?.logoUrl ?? null} side="HOME" />
      </div>

      {/* consensus always visible */}
      <div className="px-4 pb-4">
        <div
          className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] p-3"
          style={{
            background:
              "radial-gradient(700px 160px at 20% 0%, rgba(212,175,55,0.12), transparent 60%), rgba(11,11,11,1)",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="text-[12px] text-white font-extrabold">Consensus</div>
            <div className="text-[11px] text-[#808080] font-semibold">
              {market === "ml" ? "Moneyline" : market === "spread" ? "Spread" : "Total"}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-[#1f1f1f] bg-black/20 p-2">
              <div className="text-[10px] text-[#808080] font-semibold mb-0.5">{leftLabel}</div>
              <div className="text-[14px] text-white font-extrabold tabular-nums">{awayCons}</div>
            </div>
            <div className="rounded-md border border-[#1f1f1f] bg-black/20 p-2">
              <div className="text-[10px] text-[#808080] font-semibold mb-0.5">{rightLabel}</div>
              <div className="text-[14px] text-white font-extrabold tabular-nums">{homeCons}</div>
            </div>
          </div>
        </div>

        {/* books collapsible */}
        {booksOpen && (
          <div className="mt-3 rounded-lg border border-[#2a2a2a] bg-black/10 overflow-hidden">
            <div className="px-4 py-2 border-b border-[#141414] text-[12px] text-white font-extrabold">
              Books
            </div>
            <div className="px-4">
              <BookRowMobile2Col book="dk" leftLabel={leftLabel} leftValue={awayCells.dk} rightLabel={rightLabel} rightValue={homeCells.dk} />
              <BookRowMobile2Col book="fd" leftLabel={leftLabel} leftValue={awayCells.fd} rightLabel={rightLabel} rightValue={homeCells.fd} />
              <BookRowMobile2Col book="mgm" leftLabel={leftLabel} leftValue={awayCells.mgm} rightLabel={rightLabel} rightValue={homeCells.mgm} />
              <BookRowMobile2Col book="pin" leftLabel={leftLabel} leftValue={awayCells.pin} rightLabel={rightLabel} rightValue={homeCells.pin} />
              <BookRowMobile2Col book="bol" leftLabel={leftLabel} leftValue={awayCells.bol} rightLabel={rightLabel} rightValue={homeCells.bol} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** ---------- Screen ---------- */
export function OddsScreen() {
  const [allEvents, setAllEvents] = useState<EventOdds[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [market, setMarket] = useState<Market>("spread");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdatedIso, setLastUpdatedIso] = useState<string | null>(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEvent, setHistoryEvent] = useState<EventOdds | null>(null);

  // Desktop: start clean
  const [showBooksDesktop, setShowBooksDesktop] = useState(false);

  // Mobile: per-event collapsed state (default collapsed)
  const [mobileOpenMap, setMobileOpenMap] = useState<Record<string, boolean>>({});

  function openHistory(ev: EventOdds) {
    setHistoryEvent(ev);
    setHistoryOpen(true);
  }
  function closeHistory() {
    setHistoryOpen(false);
    setHistoryEvent(null);
  }

  async function load() {
    setError("");

    const { data, error } = await supabase
      .from("odds_wide_latest")
      .select("*")
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
          commenceTime: row.commence_time ?? "",
          latestUpdatedAt: null,
        };

      cur.commenceTime = cur.commenceTime || row.commence_time || "";

      const sideOdds = mapWideRowToSideOdds(row);
      if (sideOdds.side === "AWAY") cur.away = sideOdds;
      if (sideOdds.side === "HOME") cur.home = sideOdds;

      cur.latestUpdatedAt = maxIso(cur.latestUpdatedAt, sideOdds.updatedAt);
      globalLatest = maxIso(globalLatest, sideOdds.updatedAt);

      byEvent.set(eventId, cur);
    }

    const list = Array.from(byEvent.values()).sort((a, b) => {
      const ta = new Date(normalizeIso(a.commenceTime) ?? a.commenceTime).getTime();
      const tb = new Date(normalizeIso(b.commenceTime) ?? b.commenceTime).getTime();
      return ta - tb;
    });

    setAllEvents(list);
    setLastUpdatedIso(globalLatest ?? new Date().toISOString());
    setLoading(false);
  }

  useEffect(() => {
    setLoading(true);
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, []);

  const availableDates = useMemo(() => {
    const set = new Set<string>();
    for (const ev of allEvents) {
      const d = ctYmdFromIso(ev.commenceTime);
      if (d) set.add(d);
    }
    return Array.from(set).sort();
  }, [allEvents]);

  useEffect(() => {
    if (!availableDates.length) return;
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

  const headerLabel = market === "ml" ? "Moneyline" : market === "spread" ? "Spread" : "Total";

  // keep map clean if slate changes
  useEffect(() => {
    setMobileOpenMap((prev) => {
      const next: Record<string, boolean> = {};
      for (const ev of events) next[ev.eventId] = prev[ev.eventId] ?? false; // default collapsed
      return next;
    });
  }, [events]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl text-white mb-1">Raw Odds Feed</h2>
          <p className="text-xs text-[#808080]">{headerLabel} · 5 books · Updated every 60 seconds</p>
        </div>

        <div className="text-right hidden sm:block">
          <div className="text-[10px] text-[#606060]">Last Updated (CT)</div>
          <div className="text-xs text-white flex items-center justify-end gap-2">
            <span>{fmtCTDateTime(lastUpdatedIso)}</span>
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
        {availableDates.map((d) => (
          <button
            key={d}
            onClick={() => setSelectedDate(d)}
            className={[
              "px-3 py-1.5 rounded-md text-xs border transition-colors whitespace-nowrap",
              selectedDate === d
                ? "bg-[#d4af37] text-black border-[#d4af37]"
                : "bg-[#0f0f0f] text-[#cfcfcf] border-[#2a2a2a] hover:border-[#3a3a3a]",
            ].join(" ")}
            title={d}
            type="button"
          >
            {fmtDateBtn(d)}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <MarketButton active={market === "ml"} onClick={() => setMarket("ml")}>
          Moneyline
        </MarketButton>
        <MarketButton active={market === "spread"} onClick={() => setMarket("spread")}>
          Spread
        </MarketButton>
        <MarketButton active={market === "total"} onClick={() => setMarket("total")}>
          Total
        </MarketButton>

        {/* Desktop-only: start clean, let you show books when you want */}
        <div className="hidden md:flex items-center ml-2">
          <button
            type="button"
            onClick={() => setShowBooksDesktop((v) => !v)}
            className={[
              "px-3 py-1.5 rounded-md text-xs border transition-colors",
              showBooksDesktop
                ? "bg-[#d4af37] text-black border-[#d4af37]"
                : "bg-[#0f0f0f] text-[#cfcfcf] border-[#2a2a2a] hover:border-[#3a3a3a]",
            ].join(" ")}
          >
            {showBooksDesktop ? "Hide Books" : "Show Books"}
          </button>
        </div>
      </div>

      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">
        {/* MOBILE: cards */}
        <div className="md:hidden">
          {loading ? (
            <div className="p-4 text-xs text-[#808080]">Loading odds_wide_latest…</div>
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
                  onToggleBooks={() =>
                    setMobileOpenMap((prev) => ({ ...prev, [ev.eventId]: !prev[ev.eventId] }))
                  }
                  onOpenHistory={openHistory}
                />
              ))}
            </div>
          )}
        </div>

        {/* DESKTOP: table */}
        <div className="hidden md:block overflow-x-auto">
          {loading ? (
            <div className="p-4 text-xs text-[#808080]">Loading odds_wide_latest…</div>
          ) : error ? (
            <div className="p-4 text-xs text-red-400">Supabase error: {error}</div>
          ) : !events.length ? (
            <div className="p-4 text-xs text-[#808080]">No games for {selectedDate || "—"}.</div>
          ) : (
            <table className="w-full table-fixed">
              <colgroup>
                <col style={{ width: COL_MATCHUP }} />
                <col style={{ width: COL_CONSENSUS }} />
                {showBooksDesktop && (
                  <>
                    <col style={{ width: COL_BOOK }} />
                    <col style={{ width: COL_BOOK }} />
                    <col style={{ width: COL_BOOK }} />
                    <col style={{ width: COL_BOOK }} />
                    <col style={{ width: COL_BOOK }} />
                  </>
                )}
              </colgroup>

              <thead className="sticky top-0 z-20">
                <tr className={`border-b ${HDR_BORDER}`}>
                  <th className={["text-left px-3 py-3", HDR_LEFT_BG, HDR_TEXT, "sticky left-0 z-30 text-sm font-extrabold"].join(" ")}>
                    Matchup
                  </th>

                  <th className={["text-center px-3 py-3", HDR_LEFT_BG, HDR_TEXT, "z-20 text-sm font-extrabold border-l", HDR_BORDER].join(" ")}>
                    Consensus
                  </th>

                  {showBooksDesktop && (
                    <>
                      <BookHeader src={BOOK_LOGOS.dk} alt="DraftKings" fallbackLabel="DK" borderLeft />
                      <BookHeader src={BOOK_LOGOS.fd} alt="FanDuel" fallbackLabel="FD" />
                      <BookHeader src={BOOK_LOGOS.mgm} alt="BetMGM" fallbackLabel="MGM" />
                      <BookHeader src={BOOK_LOGOS.pin} alt="Pinnacle" fallbackLabel="PIN" />
                      <BookHeader src={BOOK_LOGOS.bol} alt="BetOnline" fallbackLabel="BOL" />
                    </>
                  )}
                </tr>
              </thead>

              <tbody>
                {events.map((ev) => (
                  <EventTwoRows
                    key={ev.eventId}
                    ev={ev}
                    market={market}
                    showBooks={showBooksDesktop}
                    onOpenHistory={openHistory}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {historyOpen && historyEvent?.eventId && (
        <LineMovementModal ev={historyEvent} uiMarket={market} onClose={closeHistory} />
      )}
    </div>
  );
}
