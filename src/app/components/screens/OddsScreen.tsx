import { useEffect, useMemo, useState } from "react";
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
 * ODDS SCREEN (FULL REWRITE + HISTORY MODAL v2)
 *
 * ✅ Base screen (unchanged behavior):
 * - Book logos loaded from /public/books/*.png (pin.png)
 * - Header: Matchup + Consensus use original dark; Books use charcoal
 * - Subtle glow on logos for contrast
 * - Matchup column contains time + BOTH teams (logos + away/home labels) in one field
 * - Consensus column shows ONLY the selected market, rendered exactly like book cells
 * - Table scrolls inside the panel (page does NOT scroll)
 * - Bigger team logos + bold team names; odds slightly bigger + bold
 *
 * ✅ History modal upgrades:
 * - Click "History" in matchup cell to open modal
 * - Graphs line movement / odds movement for ALL books found in history table
 * - Per-book color mapping
 * - Market Width overlay (line-width or prob-width depending on mode)
 * - Option: Soft Book Shading detection
 * - Option: Sharp Move Detected (anchors on Pinnacle + consensus)
 * - Buckets snapshots into 1-minute bins for cleaner graphs
 *
 * IMPORTANT:
 * - Set HISTORY_TABLE to your actual history table/view name in Supabase.
 * - Install recharts: npm i recharts
 */

type Market = "ml" | "spread" | "total";

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

/** ✅ Public folder book logos */
const BOOK_LOGOS = {
  dk: "/books/dk.png",
  fd: "/books/fd.png",
  mgm: "/books/mgm.png",
  pin: "/books/pin.png",
  bol: "/books/bol.png",
} as const;

const BOOKS = ["dk", "fd", "mgm", "pin", "bol"] as const;
type BookKey = (typeof BOOKS)[number];

/** Layout */
const COL_MATCHUP = 440; // time + both teams
const COL_CONSENSUS = 190;
const COL_BOOK = 132;

const BOOK_LOGO_W = 104;
const BOOK_LOGO_H = 26;

/** Header colors */
const HDR_LEFT_BG = "bg-[#0a0a0a]"; // original
const HDR_BOOK_BG = "bg-[#4a4a4a]"; // charcoal
const HDR_TEXT = "text-[#cfcfcf]";
const HDR_BORDER = "border-[#2a2a2a]";

/** Subtle glow so low-contrast logos pop on charcoal */
const BOOK_GLOW =
  "drop-shadow(0 1px 0 rgba(0,0,0,0.65)) drop-shadow(0 0 8px rgba(255,255,255,0.14)) drop-shadow(0 0 8px rgba(212,175,55,0.22))";

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
 * Consensus (median) rendered EXACTLY like book cells for selected market.
 * - ML: odds
 * - Spread: line (odds)
 * - Total: AWAY row shows Over (line Oodds), HOME row shows Under (line Uodds)
 */
function consensusValueForRow(ev: EventOdds, market: Market, side: "AWAY" | "HOME") {
  const a = ev.away;
  const h = ev.home;
  const src = side === "AWAY" ? a : h;

  if (market === "ml") {
    const odds: number[] = [];
    if (src) for (const b of BOOKS) if (typeof src.ml[b] === "number") odds.push(src.ml[b] as number);
    return fmtML(median(odds));
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

  // total: AWAY over, HOME under
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
    <rect x="0" y="0" width="${BOOK_LOGO_W}" height="${BOOK_LOGO_H}" rx="13" ry="13" fill="#2A2A2A"/>
    <text x="${BOOK_LOGO_W / 2}" y="${Math.floor(BOOK_LOGO_H * 0.70)}"
      font-family="Arial, sans-serif" font-size="12" font-weight="700"
      text-anchor="middle" fill="#F5F5F5">${label}</text>
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
    >
      {children}
    </button>
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

/** =========================
 * HISTORY MODAL + DETECTION
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

// ✅ set this to your actual name
const HISTORY_TABLE = "odds_snapshot_history";

const UI_TO_HIST_MARKET: Record<Market, HistMarket> = {
  ml: "h2h",
  spread: "spreads",
  total: "totals",
};

// Per-book line color mapping (history bookmaker keys)
const BOOK_SERIES_COLOR: Record<string, string> = {
  draftkings: "#34d399", // emerald
  fanduel: "#60a5fa", // blue
  betmgm: "#d4af37", // gold
  pinnacle: "#f97316", // orange
  betonlineag: "#a78bfa", // violet
  hardrockbet: "#fb7185", // rose
  betrivers: "#22c55e", // green
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
  ts: string;          // bucket timestamp (ISO)
  t: string;           // CT label
  mw: number | null;   // market width overlay
  sharp: boolean;      // sharp move detected (bucket)
  shade: boolean;      // soft shading detected (bucket)
  pin?: number;        // pinnacle value (line or odds) if present
  [book: string]: any; // book values
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
  // 1) bucket to 1-minute bins, keep latest per (bin, book)
  const binMap = new Map<string, Map<string, HistoryRow>>();

  for (const r of rows) {
    const bin = floorToMinuteIso(r.ts);
    const byBook = binMap.get(bin) ?? new Map<string, HistoryRow>();

    const prev = byBook.get(r.bookmaker);
    if (!prev) {
      byBook.set(r.bookmaker, r);
    } else {
      // keep the later ts within the same minute
      const pt = new Date(normalizeIso(prev.ts) ?? prev.ts).getTime();
      const rt = new Date(normalizeIso(r.ts) ?? r.ts).getTime();
      if (rt >= pt) byBook.set(r.bookmaker, r);
    }

    binMap.set(bin, byBook);
  }

  const bins = Array.from(binMap.keys()).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  // 2) build points
  const points: ChartPoint[] = bins.map((bin) => {
    const byBook = binMap.get(bin)!;
    const p: ChartPoint = {
      ts: bin,
      t: fmtCTShortLabel(bin),
      mw: null,
      sharp: false,
      shade: false,
    };

    for (const b of books) {
      const row = byBook.get(b);
      if (!row) continue;
      if (valueMode === "line") {
        if (typeof row.line === "number" && Number.isFinite(row.line)) p[b] = row.line;
      } else {
        if (typeof row.odds === "number" && Number.isFinite(row.odds)) p[b] = row.odds;
      }
    }

    // convenience: pinnacle series value
    if (typeof p["pinnacle"] === "number") p.pin = p["pinnacle"];

    // 3) width overlay
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

  // 4) soft shading detection (simple + effective)
  // “soft shading” = line unchanged for the book, but implied probability shifts by >= 2% (0.02)
  // For totals, this is usually the best signal (books move price more than line).
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

          // if line is tracked separately in table, we can’t “same line” check in odds-mode,
          // so we approximate by only flagging shading when consensus line is stable (spreads/totals),
          // or for totals always allow (odds tends to be the signal).
          const dp = Math.abs(cp - pp);
          if (dp >= SHADE_DP) {
            shaded = true;
            break;
          }
        } else {
          // line mode shading is less useful; keep it off unless you turn odds-mode.
        }
      }

      cur.shade = shaded;
    }
  }

  // 5) sharp move detection
  // “sharp move” = Pinnacle moves materially OR consensus moves materially with tight width.
  // Thresholds:
  // - spreads: 0.5 points
  // - totals : 1.0 points
  // In odds mode, use prob movement threshold 0.02 with tight width.
  const LINE_MOVE = uiMarket === "spread" ? 0.5 : uiMarket === "total" ? 1.0 : 0.0;
  const PROB_MOVE = 0.02;

  if (enableSharp) {
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const cur = points[i];

      const widthOk =
        cur.mw != null &&
        (valueMode === "line"
          ? (uiMarket === "spread" ? cur.mw <= 0.5 : uiMarket === "total" ? cur.mw <= 1.0 : true)
          : cur.mw <= 0.02);

      let sharp = false;

      // A) Pinnacle anchor movement
      if (typeof prev.pin === "number" && typeof cur.pin === "number") {
        if (valueMode === "line") {
          if (Math.abs(cur.pin - prev.pin) >= LINE_MOVE) sharp = true;
        } else {
          const pp = impliedProbFromAmerican(prev.pin);
          const cp = impliedProbFromAmerican(cur.pin);
          if (Number.isFinite(pp) && Number.isFinite(cp) && Math.abs(cp - pp) >= PROB_MOVE) sharp = true;
        }
      }

      // B) Consensus movement with tight width (books clustering = “real move”)
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

/** ---------- Modal shell ---------- */
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
      className="fixed inset-0 z-[999] flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-6xl rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden">
        <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-start justify-between gap-4">
          <div>
            <div className="text-white font-extrabold text-sm">{title}</div>
            {subtitle && <div className="text-[11px] text-[#808080] mt-0.5">{subtitle}</div>}
          </div>
          <button
            className="text-[#cfcfcf] hover:text-white text-sm font-bold px-2 py-1 rounded-md hover:bg-white/10"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>

        <div className="p-4">{children}</div>
      </div>
    </div>
  );
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

function Badge({ label, kind }: { label: string; kind: "gold" | "red" | "gray" }) {
  const cls =
    kind === "gold"
      ? "bg-[#d4af37] text-black"
      : kind === "red"
      ? "bg-red-500 text-white"
      : "bg-[#2a2a2a] text-[#cfcfcf]";
  return <span className={`px-2 py-0.5 rounded-md text-[10px] font-extrabold ${cls}`}>{label}</span>;
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

  // mode toggles
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

      const aRows = rows.filter((r) => String(r.bookmaker || "").toLowerCase() && String(r.side).toLowerCase() === panelA);
      const bRows = rows.filter((r) => String(r.bookmaker || "").toLowerCase() && String(r.side).toLowerCase() === panelB);

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
        <div className="flex items-center gap-2">
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
      ) : (!seriesA.length && !seriesB.length) ? (
        <div className="text-xs text-[#808080]">No history rows found for this event/market in the selected window.</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Panel A */}
          <div className="rounded-lg border border-[#2a2a2a] bg-black/20 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-white font-bold text-xs">{panelTitleA}</div>
              <div className="flex items-center gap-2">
                {showSharp && anySharpA && <Badge label="Sharp" kind="red" />}
                {showShading && anyShadeA && <Badge label="Shading" kind="gold" />}
              </div>
            </div>

            <div className="h-[360px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={seriesA}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="t" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="main" tick={{ fontSize: 11 }} label={{ value: yLabel, angle: -90, position: "insideLeft" }} />
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
                      return (
                        <div className="bg-[#0a0a0a] border border-[#2a2a2a] rounded-md p-2 text-[11px] text-[#cfcfcf]">
                          <div className="font-extrabold text-white mb-1">{label}</div>
                          {showWidth && row?.mw != null && (
                            <div className="mb-1">
                              <span className="font-bold">Width:</span> {row.mw}
                            </div>
                          )}
                          <div className="flex gap-2">
                            {showSharp && row?.sharp && <Badge label="Sharp" kind="red" />}
                            {showShading && row?.shade && <Badge label="Shading" kind="gold" />}
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Legend />

                  {/* book series */}
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

                  {/* width overlay */}
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

                  {/* sharp markers */}
                  {showSharp &&
                    seriesA
                      .filter((p) => p.sharp)
                      .map((p) => (
                        <ReferenceLine
                          key={`sharp-${p.ts}`}
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

          {/* Panel B */}
          <div className="rounded-lg border border-[#2a2a2a] bg-black/20 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-white font-bold text-xs">{panelTitleB}</div>
              <div className="flex items-center gap-2">
                {showSharp && anySharpB && <Badge label="Sharp" kind="red" />}
                {showShading && anyShadeB && <Badge label="Shading" kind="gold" />}
              </div>
            </div>

            <div className="h-[360px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={seriesB}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="t" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="main" tick={{ fontSize: 11 }} label={{ value: yLabel, angle: -90, position: "insideLeft" }} />
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
                      return (
                        <div className="bg-[#0a0a0a] border border-[#2a2a2a] rounded-md p-2 text-[11px] text-[#cfcfcf]">
                          <div className="font-extrabold text-white mb-1">{label}</div>
                          {showWidth && row?.mw != null && (
                            <div className="mb-1">
                              <span className="font-bold">Width:</span> {row.mw}
                            </div>
                          )}
                          <div className="flex gap-2">
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
                    seriesB
                      .filter((p) => p.sharp)
                      .map((p) => (
                        <ReferenceLine
                          key={`sharp-${p.ts}`}
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
        </div>
      )}

      {/* book color legend */}
      {!!books.length && (
        <div className="mt-3 flex flex-wrap gap-2">
          {books.map((b) => (
            <div
              key={b}
              className="flex items-center gap-2 text-[11px] text-[#cfcfcf] border border-[#2a2a2a] rounded-md px-2 py-1 bg-black/20"
            >
              <span className="inline-block w-3 h-3 rounded-sm" style={{ background: seriesColor(b) }} />
              <span className="font-semibold">{b}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 text-[11px] text-[#808080] leading-snug">
        <span className="font-bold text-[#cfcfcf]">Soft Shading</span>: price (implied probability) shifts meaningfully without an obvious “line move” signal (especially useful for totals).
        &nbsp;|&nbsp;
        <span className="font-bold text-[#cfcfcf]">Sharp Move</span>: Pinnacle or consensus moves materially with tight market width (books clustering).
      </div>
    </ModalShell>
  );
}

/** ---------- Two-row event renderer ---------- */
function EventTwoRows({
  ev,
  market,
  onOpenHistory,
}: {
  ev: EventOdds;
  market: Market;
  onOpenHistory: (ev: EventOdds) => void;
}) {
  const away =
    ev.away ?? {
      side: "AWAY" as const,
      team: "Away",
      logoUrl: null,
      updatedAt: null,
      ml: { dk: null, fd: null, mgm: null, pin: null, bol: null },
      spread: { dk: { line: null, odds: null }, fd: { line: null, odds: null }, mgm: { line: null, odds: null }, pin: { line: null, odds: null }, bol: { line: null, odds: null } },
      total: { dk: { line: null, over: null, under: null }, fd: { line: null, over: null, under: null }, mgm: { line: null, over: null, under: null }, pin: { line: null, over: null, under: null }, bol: { line: null, over: null, under: null } },
    };

  const home =
    ev.home ?? {
      side: "HOME" as const,
      team: "Home",
      logoUrl: null,
      updatedAt: null,
      ml: { dk: null, fd: null, mgm: null, pin: null, bol: null },
      spread: { dk: { line: null, odds: null }, fd: { line: null, odds: null }, mgm: { line: null, odds: null }, pin: { line: null, odds: null }, bol: { line: null, odds: null } },
      total: { dk: { line: null, over: null, under: null }, fd: { line: null, over: null, under: null }, mgm: { line: null, over: null, under: null }, pin: { line: null, over: null, under: null }, bol: { line: null, over: null, under: null } },
    };

  const mk = (s: SideOdds) => {
    if (market === "ml") {
      return {
        dk: fmtML(s.ml.dk),
        fd: fmtML(s.ml.fd),
        mgm: fmtML(s.ml.mgm),
        pin: fmtML(s.ml.pin),
        bol: fmtML(s.ml.bol),
      };
    }
    if (market === "spread") {
      return {
        dk: fmtSpread(s.spread.dk),
        fd: fmtSpread(s.spread.fd),
        mgm: fmtSpread(s.spread.mgm),
        pin: fmtSpread(s.spread.pin),
        bol: fmtSpread(s.spread.bol),
      };
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
            <MiniTeamRow team={away.team} logoUrl={away.logoUrl} side="AWAY" />
            <MiniTeamRow team={home.team} logoUrl={home.logoUrl} side="HOME" />
          </div>
        </td>

        <ConsensusValue value={awayConsensus} />

        <BookValue value={awayCells.dk} borderLeft />
        <BookValue value={awayCells.fd} />
        <BookValue value={awayCells.mgm} />
        <BookValue value={awayCells.pin} />
        <BookValue value={awayCells.bol} />
      </tr>

      <tr className={["hover:bg-[#0f0f0f]/50 transition-colors", `border-t border-[#1a1a1a]/60 border-b-2 ${HDR_BORDER}`].join(" ")}>
        <ConsensusValue value={homeConsensus} />

        <BookValue value={homeCells.dk} borderLeft />
        <BookValue value={homeCells.fd} />
        <BookValue value={homeCells.mgm} />
        <BookValue value={homeCells.pin} />
        <BookValue value={homeCells.bol} />
      </tr>
    </>
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

  // modal state
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEvent, setHistoryEvent] = useState<EventOdds | null>(null);

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

      // exclude already-started games for "today"
      if (selectedDate === todayCt) {
        const startMs = new Date(normalizeIso(ev.commenceTime) ?? ev.commenceTime).getTime();
        if (!Number.isFinite(startMs)) return false;
        return startMs > nowMs;
      }
      return true;
    });
  }, [allEvents, selectedDate]);

  const headerLabel = market === "ml" ? "Moneyline" : market === "spread" ? "Spread" : "Total";

  return (
    <div className="h-[calc(100vh-72px)] flex flex-col gap-4 overflow-hidden">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl text-white mb-1">Raw Odds Feed</h2>
          <p className="text-xs text-[#808080]">{headerLabel} · 5 books · Updated every 60 seconds</p>
        </div>

        <div className="text-right">
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
          >
            {fmtDateBtn(d)}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <MarketButton active={market === "ml"} onClick={() => setMarket("ml")}>
          Moneyline
        </MarketButton>
        <MarketButton active={market === "spread"} onClick={() => setMarket("spread")}>
          Spread
        </MarketButton>
        <MarketButton active={market === "total"} onClick={() => setMarket("total")}>
          Total
        </MarketButton>
      </div>

      <div className="flex-1 bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">
        <div className="h-full overflow-y-auto overflow-x-auto">
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
                <col style={{ width: COL_BOOK }} />
                <col style={{ width: COL_BOOK }} />
                <col style={{ width: COL_BOOK }} />
                <col style={{ width: COL_BOOK }} />
                <col style={{ width: COL_BOOK }} />
              </colgroup>

              <thead className="sticky top-0 z-20">
                <tr className={`border-b ${HDR_BORDER}`}>
                  <th className={["text-left px-3 py-3", HDR_LEFT_BG, HDR_TEXT, "sticky left-0 z-30 text-sm font-extrabold"].join(" ")}>
                    Matchup
                  </th>

                  <th className={["text-center px-3 py-3", HDR_LEFT_BG, HDR_TEXT, "z-20 text-sm font-extrabold border-l", HDR_BORDER].join(" ")}>
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
                  <EventTwoRows key={ev.eventId} ev={ev} market={market} onOpenHistory={openHistory} />
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

