// screens/Model/ModelScreen.tsx — FULL REWRITE
// --------------------------------------------------------------------------------------
// ✅ Main Model Picks table uses public.ev_plays (ML/Spread/Total)
// ✅ Props table uses public.player_prop_ev_latest
// ✅ History modal:
//    - ML/Spread/Total => odds_snapshot_history (uses ts)
//    - Props => player_props_history (lookup: event_id + player_name + market + side + line)
// ✅ History graphs are ODDS-ONLY (line shown in hover tooltip), same logic as OddsScreen
// ✅ Desktop: centered max-width “web” layout, sticky matchup column
// ✅ Mobile: card layout (no sticky table issues)
// ✅ Books: DK/FD/MGM/PIN/BOL logos from /public/books/
// ✅ Filters: sport_key + date pills (only dates with displayable future games for today)
// ✅ No “sections” for ML/Spread/Total — just a Market column

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

/* =========================================================
   TYPES / CONSTANTS
========================================================= */

type BookKey = "dk" | "fd" | "mgm" | "pin" | "bol";
type MarketUI = "ml" | "spread" | "total" | "prop";

const CT_TZ = "America/Chicago";

const BOOK_LOGOS: Record<BookKey, string> = {
  dk: "/books/dk.png",
  fd: "/books/fd.png",
  mgm: "/books/mgm.png",
  pin: "/books/pin.png",
  bol: "/books/bol.png",
};
const BOOKS: BookKey[] = ["dk", "fd", "mgm", "pin", "bol"];

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

function bookKeyFromBookmaker(raw: string): BookKey | null {
  const k = String(raw || "").toLowerCase();
  if (k === "draftkings") return "dk";
  if (k === "fanduel") return "fd";
  if (k === "betmgm") return "mgm";
  if (k === "pinnacle") return "pin";
  if (k === "betonlineag") return "bol";
  return null;
}

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

function median(nums: number[]) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
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

/* =========================================================
   FALLBACK BOOK “PILL”
========================================================= */

const BOOK_LOGO_W = 92;
const BOOK_LOGO_H = 24;

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

/* =========================================================
   DATA TYPES
========================================================= */

// ev_plays schema varies a bit across builds — this is intentionally loose.
// Adjust pickers below if your column names differ.
type EVPlayRow = {
  id?: string | number;
  run_id?: string | null;

  sport_key?: string | null;

  event_id?: string | null;
  commence_time?: string | null;
  home_team?: string | null;
  away_team?: string | null;

  // market & side
  market?: string | null; // "h2h" | "spreads" | "totals" OR "ml/spread/total"
  side?: string | null; // "home/away/over/under"

  // bet details
  line?: number | null;
  odds?: number | null; // sportsbook odds
  bookmaker?: string | null;

  // model fields
  quantum_odds?: number | null;
  ev_percent?: number | null;
  spectrum_ev?: number | null; // some builds use this
  score?: number | null;
  bet_fraction?: number | null;

  // optional timestamps
  ts?: string | null;
  updated_at?: string | null;
  inserted_at?: string | null;
};

type PropLatestRow = {
  id?: string | number;

  sport_key?: string | null;
  event_id?: string | null;
  commence_time?: string | null;
  home_team?: string | null;
  away_team?: string | null;

  player_name?: string | null;
  player_id?: string | null;
  team?: string | null;
  opponent?: string | null;

  position?: string | null;
  picture_url?: string | null;

  // prop selection
  market?: string | null; // "player_points" etc
  side?: string | null; // "over" | "under"
  line?: number | null;

  // best book info (depends on your table)
  bookmaker?: string | null;
  odds?: number | null;

  quantum_odds?: number | null;
  ev_percent?: number | null;
  score?: number | null;

  updated_at?: string | null;
  ts?: string | null;
  inserted_at?: string | null;
};

/* =========================================================
   MARKET LABELS / NORMALIZATION
========================================================= */

function normalizeMarketFromEv(row: EVPlayRow): MarketUI {
  const m = String(row.market || "").toLowerCase();

  // common snapshots naming
  if (m === "h2h" || m === "moneyline" || m === "ml") return "ml";
  if (m === "spreads" || m === "spread") return "spread";
  if (m === "totals" || m === "total") return "total";

  // fallback: try infer from side
  const s = String(row.side || "").toLowerCase();
  if (s === "over" || s === "under") return "total";
  if (s === "home" || s === "away") return "ml";

  return "ml";
}

function marketLabel(ui: MarketUI, propMarket?: string | null) {
  if (ui === "ml") return "Moneyline";
  if (ui === "spread") return "Spread";
  if (ui === "total") return "Total";
  // props:
  const pm = String(propMarket || "").toLowerCase();
  if (pm === "player_points") return "PTS";
  if (pm === "player_rebounds") return "REB";
  if (pm === "player_assists") return "AST";
  if (pm === "player_threes") return "3PM";
  return "PROP";
}

function sideLabel(ui: MarketUI, sideRaw: string | null | undefined, awayTeam?: string | null, homeTeam?: string | null) {
  const s = String(sideRaw || "").toLowerCase();
  if (ui === "ml" || ui === "spread") {
    if (s === "away") return awayTeam ?? "AWAY";
    if (s === "home") return homeTeam ?? "HOME";
    return s.toUpperCase() || "—";
  }
  if (ui === "total") {
    if (s === "over") return "Over";
    if (s === "under") return "Under";
    return s.toUpperCase() || "—";
  }
  // props
  if (s === "over") return "Over";
  if (s === "under") return "Under";
  return s.toUpperCase() || "—";
}

function pickUpdatedAt(row: any): string | null {
  return (
    row.updated_at ??
    row.last_update ??
    row.last_updated ??
    row.ts ??
    row.inserted_at ??
    row.created_at ??
    null
  );
}

/* =========================================================
   AVATAR
========================================================= */

function safeNameKey(x: string | null | undefined) {
  return (x ?? "").trim().toLowerCase();
}

function PlayerAvatar({
  url,
  name,
  size = 34,
}: {
  url: string | null | undefined;
  name: string;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);

  const initials = useMemo(() => {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "—";
    const a = parts[0]?.[0] ?? "";
    const b = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
    return (a + b).toUpperCase();
  }, [name]);

  if (!url || broken) {
    return (
      <div
        className="rounded-full bg-white/10 border border-[#2a2a2a] flex items-center justify-center text-[11px] font-extrabold text-[#cfcfcf]"
        style={{ width: size, height: size }}
        title={name}
      >
        {initials}
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={name}
      width={size}
      height={size}
      className="rounded-full object-cover border border-[#2a2a2a] bg-black/40"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      title={name}
      style={{ width: size, height: size }}
    />
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

/* =========================================================
   HISTORY SERIES BUILD (ODDS ONLY, LINE IN HOVER)
   (Same idea as OddsScreen)
========================================================= */

type HistMarket = "h2h" | "spreads" | "totals";
type HistSide = "home" | "away" | "over" | "under";

type OddsHistRow = {
  id: number;
  ts: string; // IMPORTANT: odds_snapshot_history uses ts (NOT snapshot_ts)
  event_id: string;
  bookmaker: string;
  market: HistMarket;
  side: HistSide;
  line: number | null;
  odds: number | null;
  last_update?: string | null;
  inserted_at?: string | null;
};

type PropsHistRow = {
  id: number;
  ts: string;
  run_id?: string | null;
  sport_key?: string | null;

  event_id: string | null;
  commence_time?: string | null;

  home_team?: string | null;
  away_team?: string | null;

  player_name: string | null;
  player_id?: string | null;

  team?: string | null;
  opponent?: string | null;

  market: string;
  side: string;
  line: number | null;
  odds: number | null;
  bookmaker: string;

  source?: string | null;
  inserted_at?: string | null;
};

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

function buildChartSeriesOddsOnlyGeneric(
  rows: Array<{ ts: string; bookmaker: string; odds: number | null; line: number | null }>,
  uiMarket: MarketUI,
  books: string[]
) {
  // bucket 1-min, keep newest per book per minute
  const binMap = new Map<string, Map<string, { ts: string; bookmaker: string; odds: number | null; line: number | null }>>();

  for (const r of rows) {
    const bin = floorToMinuteIso(r.ts);
    const byBook = binMap.get(bin) ?? new Map<string, any>();
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

  // sharp move heuristic
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

/* =========================================================
   HISTORY CHART UI (PAIR)
========================================================= */

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
  uiMarket: MarketUI;
  books: string[];
  seriesA: ChartPoint[];
  seriesB: ChartPoint[];
  panelTitleA: string;
  panelTitleB: string;
}) {
  const isMobile = useIsMobile();
  const chartHeight = isMobile ? 420 : 520;

  const leftTopLabel =
    uiMarket === "ml" ? "Moneyline Odds" : uiMarket === "spread" ? "Spread Odds" : uiMarket === "total" ? "Total Odds" : "Odds";
  const rightTopLabel = "Market Width (Prob)";

  const margin = isMobile ? { top: 8, right: 14, left: 36, bottom: 14 } : { top: 8, right: 16, left: 38, bottom: 16 };
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
                    <YAxis
                      yAxisId="mw"
                      orientation="right"
                      tick={{ fontSize: yTickSize }}
                      tickMargin={8}
                      width={isMobile ? 42 : 46}
                    />

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

/* =========================================================
   PROPS HISTORY CHART (single side)
========================================================= */

function HistoryChartSingleOddsOnly({
  title,
  uiMarket,
  books,
  series,
}: {
  title: string;
  uiMarket: MarketUI;
  books: string[];
  series: ChartPoint[];
}) {
  const isMobile = useIsMobile();
  const chartHeight = isMobile ? 420 : 520;

  const margin = isMobile ? { top: 8, right: 14, left: 36, bottom: 14 } : { top: 8, right: 16, left: 38, bottom: 16 };
  const xTickSize = isMobile ? 10 : 11;
  const yTickSize = isMobile ? 10 : 11;

  const empty = !series.length;

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-black/20 overflow-hidden">
      <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-center justify-between gap-3">
        <div className="text-white font-extrabold text-sm">{title}</div>
      </div>

      {empty ? (
        <div className="p-4 text-xs text-[#808080]">No prop history rows found in this window for this key.</div>
      ) : (
        <div className="p-3 sm:p-4">
          <div style={{ height: chartHeight }} className="w-full rounded-lg border border-[#2a2a2a] bg-black/20 p-3">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={margin}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="t" tick={{ fontSize: xTickSize }} interval="preserveStartEnd" />
                <YAxis yAxisId="main" tick={{ fontSize: yTickSize }} tickMargin={8} width={isMobile ? 36 : 40} />
                <YAxis
                  yAxisId="mw"
                  orientation="right"
                  tick={{ fontSize: yTickSize }}
                  tickMargin={8}
                  width={isMobile ? 42 : 46}
                />

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
                          {pretty.slice(0, 14).map((x) => (
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

                {series
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
      )}
    </div>
  );
}

/* =========================================================
   HISTORY MODAL
========================================================= */

type HistoryModalKind = "game" | "prop";

type GameHistoryCtx = {
  kind: "game";
  event_id: string;
  commence_time?: string | null;
  away_team?: string | null;
  home_team?: string | null;
};

type PropHistoryCtx = {
  kind: "prop";
  sport_key: string;
  event_id: string;
  commence_time?: string | null;

  player_name: string;
  market: string;
  side: string; // over/under
  line: number | null;

  away_team?: string | null;
  home_team?: string | null;
};

type HistoryCtx = GameHistoryCtx | PropHistoryCtx;

function HistoryModal({
  ctx,
  defaultTab,
  onClose,
}: {
  ctx: HistoryCtx;
  defaultTab: MarketUI;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [activeMarket, setActiveMarket] = useState<MarketUI>(defaultTab);
  useEffect(() => setActiveMarket(defaultTab), [defaultTab]);

  const hoursBack = 24;

  const [books, setBooks] = useState<string[]>([]);

  // game series
  const [mlAway, setMlAway] = useState<ChartPoint[]>([]);
  const [mlHome, setMlHome] = useState<ChartPoint[]>([]);
  const [spAway, setSpAway] = useState<ChartPoint[]>([]);
  const [spHome, setSpHome] = useState<ChartPoint[]>([]);
  const [toOver, setToOver] = useState<ChartPoint[]>([]);
  const [toUnder, setToUnder] = useState<ChartPoint[]>([]);

  // prop series (single)
  const [propSeries, setPropSeries] = useState<ChartPoint[]>([]);

  useEffect(() => {
    let alive = true;

    async function run() {
      setLoading(true);
      setErr("");
      setBooks([]);
      setMlAway([]);
      setMlHome([]);
      setSpAway([]);
      setSpHome([]);
      setToOver([]);
      setToUnder([]);
      setPropSeries([]);

      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

      if (ctx.kind === "game") {
        // ---------------------------
        // GAME HISTORY: odds_snapshot_history (ts)
        // ---------------------------
        const { data, error } = await supabase
          .from("odds_snapshot_history")
          .select("id,ts,event_id,bookmaker,market,side,line,odds,last_update,inserted_at")
          .eq("event_id", ctx.event_id)
          .gte("ts", since)
          .order("ts", { ascending: true });

        if (!alive) return;

        if (error) {
          setErr(error.message);
          setLoading(false);
          return;
        }

        const rows = (data ?? []) as OddsHistRow[];

        const set = new Set<string>();
        for (const r of rows) set.add(String(r.bookmaker || "").toLowerCase());
        const bookList = Array.from(set).sort((a, b) => a.localeCompare(b));
        setBooks(bookList);

        const pick = (m: HistMarket, s: HistSide) =>
          rows.filter((r) => String(r.market).toLowerCase() === m && String(r.side).toLowerCase() === s);

        setMlAway(buildChartSeriesOddsOnlyGeneric(pick("h2h", "away"), "ml", bookList));
        setMlHome(buildChartSeriesOddsOnlyGeneric(pick("h2h", "home"), "ml", bookList));

        setSpAway(buildChartSeriesOddsOnlyGeneric(pick("spreads", "away"), "spread", bookList));
        setSpHome(buildChartSeriesOddsOnlyGeneric(pick("spreads", "home"), "spread", bookList));

        setToOver(buildChartSeriesOddsOnlyGeneric(pick("totals", "over"), "total", bookList));
        setToUnder(buildChartSeriesOddsOnlyGeneric(pick("totals", "under"), "total", bookList));

        setLoading(false);
        return;
      }

      // ---------------------------
      // PROP HISTORY: player_props_history
      // Key: event_id + player_name + market + side + line
      // IMPORTANT: pull ALL bookmakers
      // ---------------------------
      const { data, error } = await supabase
        .from("player_props_history")
        .select("id,ts,run_id,sport_key,event_id,commence_time,home_team,away_team,player_name,player_id,team,opponent,market,side,line,odds,bookmaker,source,inserted_at")
        .eq("sport_key", ctx.sport_key)
        .eq("event_id", ctx.event_id)
        .eq("player_name", ctx.player_name)
        .eq("market", ctx.market)
        .eq("side", ctx.side)
        .eq("line", ctx.line)
        .gte("ts", since)
        .order("ts", { ascending: true });

      if (!alive) return;

      if (error) {
        setErr(error.message);
        setLoading(false);
        return;
      }

      const rows = (data ?? []) as PropsHistRow[];

      const set = new Set<string>();
      for (const r of rows) set.add(String(r.bookmaker || "").toLowerCase());
      const bookList = Array.from(set).sort((a, b) => a.localeCompare(b));
      setBooks(bookList);

      const genericRows = rows.map((r) => ({
        ts: r.ts,
        bookmaker: String(r.bookmaker || "").toLowerCase(),
        odds: typeof r.odds === "number" ? r.odds : null,
        line: typeof r.line === "number" ? r.line : null,
      }));

      setPropSeries(buildChartSeriesOddsOnlyGeneric(genericRows, "prop", bookList));

      setLoading(false);
    }

    run();
    return () => {
      alive = false;
    };
  }, [ctx]);

  const subtitle =
    ctx.kind === "game"
      ? [
          ctx.commence_time ? `Commence: ${fmtCTDateTime(ctx.commence_time)}` : null,
          `Window: last ${hoursBack}h`,
          "Bucket: 1-min",
          "Chart: odds (line in hover)",
        ]
          .filter(Boolean)
          .join(" · ")
      : [
          ctx.commence_time ? `Commence: ${fmtCTDateTime(ctx.commence_time)}` : null,
          `Key: ${ctx.player_name} · ${ctx.market} · ${ctx.side} · ${ctx.line ?? "—"}`,
          `Window: last ${hoursBack}h`,
          "Bucket: 1-min",
          "Chart: odds (line in hover)",
        ]
          .filter(Boolean)
          .join(" · ");

  const title =
    ctx.kind === "game"
      ? "Line Movement"
      : `Prop Movement — ${ctx.player_name} (${ctx.side.toUpperCase()} ${ctx.line ?? "—"})`;

  return (
    <ModalShell title={title} subtitle={subtitle} onClose={onClose}>
      {ctx.kind === "game" && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <button
            className={`px-3 py-1.5 rounded-lg text-xs font-extrabold border ${
              activeMarket === "ml"
                ? "bg-[#d4af37] text-black border-[#d4af37]"
                : "bg-black/20 text-[#d0d0d0] border-[#2a2a2a]"
            }`}
            onClick={() => setActiveMarket("ml")}
            type="button"
          >
            Moneyline
          </button>
          <button
            className={`px-3 py-1.5 rounded-lg text-xs font-extrabold border ${
              activeMarket === "spread"
                ? "bg-[#d4af37] text-black border-[#d4af37]"
                : "bg-black/20 text-[#d0d0d0] border-[#2a2a2a]"
            }`}
            onClick={() => setActiveMarket("spread")}
            type="button"
          >
            Spread
          </button>
          <button
            className={`px-3 py-1.5 rounded-lg text-xs font-extrabold border ${
              activeMarket === "total"
                ? "bg-[#d4af37] text-black border-[#d4af37]"
                : "bg-black/20 text-[#d0d0d0] border-[#2a2a2a]"
            }`}
            onClick={() => setActiveMarket("total")}
            type="button"
          >
            Total
          </button>
        </div>
      )}

      {loading ? (
        <div className="text-xs text-[#808080]">Loading snapshots…</div>
      ) : err ? (
        <div className="text-xs text-red-400">Supabase error: {err}</div>
      ) : ctx.kind === "game" ? (
        <div className="space-y-4">
          {activeMarket === "ml" && (
            <HistoryChartPairOddsOnly
              title="Moneyline (Odds)"
              uiMarket="ml"
              books={books}
              seriesA={mlAway}
              seriesB={mlHome}
              panelTitleA="AWAY"
              panelTitleB="HOME"
            />
          )}
          {activeMarket === "spread" && (
            <HistoryChartPairOddsOnly
              title="Spread (Odds)"
              uiMarket="spread"
              books={books}
              seriesA={spAway}
              seriesB={spHome}
              panelTitleA="AWAY"
              panelTitleB="HOME"
            />
          )}
          {activeMarket === "total" && (
            <HistoryChartPairOddsOnly
              title="Total (Odds)"
              uiMarket="total"
              books={books}
              seriesA={toOver}
              seriesB={toUnder}
              panelTitleA="OVER"
              panelTitleB="UNDER"
            />
          )}
        </div>
      ) : (
        <HistoryChartSingleOddsOnly title="Player Prop (Odds)" uiMarket="prop" books={books} series={propSeries} />
      )}
    </ModalShell>
  );
}

/* =========================================================
   UI: small cells
========================================================= */

function pill(text: string, tone: "gold" | "gray" | "green" | "red" = "gray") {
  const cls =
    tone === "gold"
      ? "bg-[#d4af37] text-black"
      : tone === "green"
      ? "bg-emerald-500 text-black"
      : tone === "red"
      ? "bg-red-500 text-white"
      : "bg-white/10 text-[#d0d0d0]";
  return <span className={`px-2 py-0.5 rounded-md text-[10px] font-extrabold ${cls}`}>{text}</span>;
}

function fmtPct(x: number | null | undefined) {
  if (x == null || !Number.isFinite(x)) return "—";
  // some tables store 0.034 vs 3.4 — we’ll handle both by assuming <=1 is fraction
  const v = Math.abs(x) <= 1 ? x * 100 : x;
  return `${v.toFixed(1)}%`;
}

function fmtNum(x: number | null | undefined, d = 1) {
  if (x == null || !Number.isFinite(x)) return "—";
  return x.toFixed(d);
}

function pickEvPct(r: any): number | null {
  const a = r.ev_percent;
  const b = r.spectrum_ev;
  const c = r.ev;
  const v = (typeof a === "number" ? a : typeof b === "number" ? b : typeof c === "number" ? c : null) as number | null;
  return v;
}

/* =========================================================
   MOBILE CARD
========================================================= */

function PlayCardMobile({
  title,
  subtitle,
  left,
  right,
  onHistory,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  left: React.ReactNode;
  right: React.ReactNode;
  onHistory?: () => void;
}) {
  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-black/20 overflow-hidden">
      <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-white font-extrabold text-[13px]">{title}</div>
          {subtitle ? <div className="text-[11px] text-[#8a8a8a] font-semibold mt-0.5">{subtitle}</div> : null}
        </div>

        {onHistory ? (
          <button
            type="button"
            onClick={onHistory}
            className="text-[11px] font-extrabold text-[#d4af37] hover:underline shrink-0"
          >
            History
          </button>
        ) : null}
      </div>

      <div className="px-4 py-3 grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-[#2a2a2a] bg-black/10 p-3">{left}</div>
        <div className="rounded-lg border border-[#2a2a2a] bg-black/10 p-3">{right}</div>
      </div>
    </div>
  );
}

/* =========================================================
   SCREEN
========================================================= */

export function ModelScreen({ sportKey }: { sportKey: string }) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [evPlays, setEvPlays] = useState<EVPlayRow[]>([]);
  const [propPlays, setPropPlays] = useState<PropLatestRow[]>([]);

  const [selectedDate, setSelectedDate] = useState<string>("");
  const [lastUpdatedIso, setLastUpdatedIso] = useState<string | null>(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyCtx, setHistoryCtx] = useState<HistoryCtx | null>(null);
  const [historyDefaultTab, setHistoryDefaultTab] = useState<MarketUI>("ml");

  function openGameHistory(row: EVPlayRow) {
    const event_id = String(row.event_id || "");
    if (!event_id) return;

    setHistoryCtx({
      kind: "game",
      event_id,
      commence_time: row.commence_time ?? null,
      away_team: row.away_team ?? null,
      home_team: row.home_team ?? null,
    });
    setHistoryDefaultTab(normalizeMarketFromEv(row));
    setHistoryOpen(true);
  }

  function openPropHistory(row: PropLatestRow) {
    const event_id = String(row.event_id || "");
    const player_name = String(row.player_name || "");
    const market = String(row.market || "");
    const side = String(row.side || "");
    if (!event_id || !player_name || !market || !side) return;

    setHistoryCtx({
      kind: "prop",
      sport_key: sportKey,
      event_id,
      commence_time: row.commence_time ?? null,
      player_name,
      market,
      side,
      line: typeof row.line === "number" ? row.line : null,
      away_team: row.away_team ?? null,
      home_team: row.home_team ?? null,
    });
    setHistoryDefaultTab("prop");
    setHistoryOpen(true);
  }

  function closeHistory() {
    setHistoryOpen(false);
    setHistoryCtx(null);
  }

  async function load() {
    setErr("");

    // 1) ev_plays — ML/Spread/Total
    const evRes = await supabase
      .from("ev_plays")
      .select("*")
      .eq("sport_key", sportKey)
      .order("commence_time", { ascending: true })
      .limit(5000);

    if (evRes.error) {
      setErr(evRes.error.message);
      setEvPlays([]);
      setPropPlays([]);
      setLastUpdatedIso(null);
      setLoading(false);
      return;
    }

    const evRows = (evRes.data ?? []) as EVPlayRow[];

    // 2) player_prop_ev_latest — props
    const propsRes = await supabase
      .from("player_prop_ev_latest")
      .select("*")
      .eq("sport_key", sportKey)
      .order("commence_time", { ascending: true })
      .limit(5000);

    if (propsRes.error) {
      setErr(propsRes.error.message);
      setEvPlays(evRows);
      setPropPlays([]);
      setLoading(false);
      return;
    }

    const propRows = (propsRes.data ?? []) as PropLatestRow[];

    // 3) last updated heuristic: max(updated/ts/inserted across both sets)
    let latest: string | null = null;
    for (const r of evRows) latest = maxIso(latest, pickUpdatedAt(r));
    for (const r of propRows) latest = maxIso(latest, pickUpdatedAt(r));

    setEvPlays(evRows);
    setPropPlays(propRows);
    setLastUpdatedIso(latest);

    setLoading(false);
  }

  useEffect(() => {
    setLoading(true);
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sportKey]);

  // Only show games/props that haven't started yet (today) + date pills like OddsScreen
  const allEventsTime = useMemo(() => {
    const out: Array<{ event_id: string; commence_time: string | null }> = [];
    for (const r of evPlays) {
      if (r.event_id && r.commence_time) out.push({ event_id: String(r.event_id), commence_time: r.commence_time });
    }
    for (const r of propPlays) {
      if (r.event_id && r.commence_time) out.push({ event_id: String(r.event_id), commence_time: r.commence_time });
    }
    return out;
  }, [evPlays, propPlays]);

  const availableDates = useMemo(() => {
    const todayCt = ctTodayYmd();
    const nowMs = Date.now();
    const set = new Set<string>();

    for (const ev of allEventsTime) {
      const evDate = ctYmdFromIso(ev.commence_time);
      if (!evDate) continue;

      if (evDate === todayCt) {
        const startMs = new Date(normalizeIso(ev.commence_time) ?? String(ev.commence_time)).getTime();
        if (Number.isFinite(startMs) && startMs > nowMs) set.add(evDate);
      } else {
        set.add(evDate);
      }
    }

    return Array.from(set).sort();
  }, [allEventsTime]);

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

  const filteredEvPlays = useMemo(() => {
    if (!selectedDate) return [];
    const todayCt = ctTodayYmd();
    const nowMs = Date.now();

    return evPlays.filter((r) => {
      const evDate = ctYmdFromIso(r.commence_time ?? null);
      if (evDate !== selectedDate) return false;

      if (selectedDate === todayCt) {
        const startMs = new Date(normalizeIso(r.commence_time ?? "") ?? String(r.commence_time ?? "")).getTime();
        if (!Number.isFinite(startMs)) return false;
        return startMs > nowMs;
      }
      return true;
    });
  }, [evPlays, selectedDate]);

  const filteredPropPlays = useMemo(() => {
    if (!selectedDate) return [];
    const todayCt = ctTodayYmd();
    const nowMs = Date.now();

    return propPlays.filter((r) => {
      const evDate = ctYmdFromIso(r.commence_time ?? null);
      if (evDate !== selectedDate) return false;

      if (selectedDate === todayCt) {
        const startMs = new Date(normalizeIso(r.commence_time ?? "") ?? String(r.commence_time ?? "")).getTime();
        if (!Number.isFinite(startMs)) return false;
        return startMs > nowMs;
      }
      return true;
    });
  }, [propPlays, selectedDate]);

  // Group by event_id for nicer layout (one game -> multiple plays)
  const evByEvent = useMemo(() => {
    const m = new Map<string, EVPlayRow[]>();
    for (const r of filteredEvPlays) {
      const id = String(r.event_id || "");
      if (!id) continue;
      const arr = m.get(id) ?? [];
      arr.push(r);
      m.set(id, arr);
    }
    // stable sort inside
    for (const [k, arr] of m.entries()) {
      arr.sort((a, b) => {
        const ma = normalizeMarketFromEv(a);
        const mb = normalizeMarketFromEv(b);
        if (ma !== mb) return ma.localeCompare(mb);
        const ea = pickEvPct(a) ?? -9999;
        const eb = pickEvPct(b) ?? -9999;
        return eb - ea;
      });
      m.set(k, arr);
    }
    return m;
  }, [filteredEvPlays]);

  const propsByEvent = useMemo(() => {
    const m = new Map<string, PropLatestRow[]>();
    for (const r of filteredPropPlays) {
      const id = String(r.event_id || "");
      if (!id) continue;
      const arr = m.get(id) ?? [];
      arr.push(r);
      m.set(id, arr);
    }
    for (const [k, arr] of m.entries()) {
      arr.sort((a, b) => {
        const ea = (typeof a.score === "number" ? a.score : pickEvPct(a) ?? -9999) as number;
        const eb = (typeof b.score === "number" ? b.score : pickEvPct(b) ?? -9999) as number;
        return eb - ea;
      });
      m.set(k, arr);
    }
    return m;
  }, [filteredPropPlays]);

  const sportLabel =
    sportKey === "basketball_nba"
      ? "NBA Model Picks"
      : sportKey === "basketball_ncaab"
      ? "NCAAB Model Picks"
      : sportKey === "football_nfl"
      ? "NFL Model Picks"
      : sportKey === "football_ncaaf"
      ? "NCAAF Model Picks"
      : sportKey === "icehockey_nhl"
      ? "NHL Model Picks"
      : sportKey === "baseball_mlb"
      ? "MLB Model Picks"
      : "Model Picks";

  const isMobile = useIsMobile(768);

  return (
    <div className="w-full">
      <div className="max-w-[1320px] mx-auto px-4 md:px-8">
        <div className="pt-4 md:pt-6">
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
            <div>
              <h2 className="text-[22px] md:text-[28px] text-white font-extrabold tracking-tight">{sportLabel}</h2>
              <div className="text-xs text-[#8a8a8a] mt-1">EV Plays + Player Props · refresh 60s</div>

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
                    selectedDate === d
                      ? "bg-[#d4af37] text-black border-[#d4af37]"
                      : "bg-black/20 text-[#d0d0d0] border-[#2a2a2a] hover:border-[#3a3a3a]",
                  ].join(" ")}
                  title={d}
                  type="button"
                >
                  {fmtDateBtn(d)}
                </button>
              ))}

              {!availableDates.length && <div className="text-xs text-[#808080]">No games available.</div>}
            </div>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          {/* EV PLAYS */}
          <div className="rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden shadow-[0_16px_60px_rgba(0,0,0,0.38)]">
            <div className="px-4 md:px-6 py-4 border-b border-[#2a2a2a] flex items-center justify-between">
              <div className="text-white font-extrabold">EV Plays (ML / Spread / Total)</div>
              <div className="text-[11px] text-[#8a8a8a] font-semibold">
                {filteredEvPlays.length ? `${filteredEvPlays.length} plays` : "—"}
              </div>
            </div>

            {loading ? (
              <div className="p-4 text-xs text-[#808080]">Loading EV plays…</div>
            ) : err ? (
              <div className="p-4 text-xs text-red-400">Supabase error: {err}</div>
            ) : !filteredEvPlays.length ? (
              <div className="p-4 text-xs text-[#808080]">No EV plays for {selectedDate || "—"}.</div>
            ) : isMobile ? (
              <div className="p-3 space-y-3">
                {Array.from(evByEvent.entries()).map(([eventId, plays]) => {
                  const h = plays[0];
                  const away = h.away_team ?? "Away";
                  const home = h.home_team ?? "Home";
                  const ct = fmtCTTimeOnly(h.commence_time ?? null);

                  return (
                    <div key={eventId} className="space-y-3">
                      <div className="px-1">
                        <div className="text-[12px] text-[#cfcfcf] font-semibold">
                          {ct} CT · <span className="text-white font-extrabold">{away}</span> @{" "}
                          <span className="text-white font-extrabold">{home}</span>
                        </div>
                      </div>

                      {plays.map((p, i) => {
                        const uiM = normalizeMarketFromEv(p);
                        const pick = sideLabel(uiM, p.side ?? null, p.away_team ?? null, p.home_team ?? null);
                        const line = p.line;
                        const odds = p.odds;
                        const book = String(p.bookmaker || "").toLowerCase();
                        const evp = pickEvPct(p);
                        const score = typeof p.score === "number" ? p.score : null;
                        const q = typeof p.quantum_odds === "number" ? p.quantum_odds : null;

                        return (
                          <PlayCardMobile
                            key={`${eventId}-${i}`}
                            title={
                              <div className="flex items-center gap-2">
                                {pill(marketLabel(uiM))}
                                <span className="text-white font-extrabold">{pick}</span>
                              </div>
                            }
                            subtitle={
                              <span>
                                Line: <span className="text-white font-extrabold">{line == null ? "—" : line}</span> · Odds:{" "}
                                <span className="text-white font-extrabold">{odds == null ? "—" : odds}</span> ·{" "}
                                <span className="text-[#d4af37] font-extrabold">{book || "—"}</span>
                              </span>
                            }
                            left={
                              <div className="space-y-1">
                                <div className="text-[10px] text-[#808080] font-semibold">Quantum</div>
                                <div className="text-white font-extrabold tabular-nums text-[16px]">{q == null ? "—" : q}</div>
                                <div className="text-[10px] text-[#808080] font-semibold mt-2">EV%</div>
                                <div className="text-white font-extrabold tabular-nums">{fmtPct(evp)}</div>
                              </div>
                            }
                            right={
                              <div className="space-y-1">
                                <div className="text-[10px] text-[#808080] font-semibold">Score</div>
                                <div className="text-white font-extrabold tabular-nums text-[16px]">{score == null ? "—" : fmtNum(score, 0)}</div>
                                <div className="text-[10px] text-[#808080] font-semibold mt-2">Event</div>
                                <div className="text-[11px] text-[#cfcfcf] font-semibold break-all">{eventId}</div>
                              </div>
                            }
                            onHistory={() => openGameHistory(p)}
                          />
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full table-fixed">
                  <colgroup>
                    <col style={{ width: 420 }} />
                    <col style={{ width: 110 }} />
                    <col style={{ width: 220 }} />
                    <col style={{ width: 120 }} />
                    <col style={{ width: 130 }} />
                    <col style={{ width: 120 }} />
                    <col style={{ width: 110 }} />
                    <col style={{ width: 120 }} />
                  </colgroup>

                  <thead className="sticky top-0 z-20">
                    <tr className="border-b border-[#232323]">
                      <th className="text-left px-4 py-3 bg-[#0b0b0b] text-[#d0d0d0] sticky left-0 z-30 text-[13px] font-extrabold">
                        Matchup
                      </th>
                      <th className="text-left px-3 py-3 bg-[#0b0b0b] text-[#d0d0d0] text-[13px] font-extrabold border-l border-[#232323]">
                        Market
                      </th>
                      <th className="text-left px-3 py-3 bg-[#0b0b0b] text-[#d0d0d0] text-[13px] font-extrabold">
                        Pick
                      </th>
                      <th className="text-center px-3 py-3 bg-[#0b0b0b] text-[#d0d0d0] text-[13px] font-extrabold">
                        Line
                      </th>
                      <th className="text-center px-3 py-3 bg-[#0b0b0b] text-[#d0d0d0] text-[13px] font-extrabold">
                        Odds / Book
                      </th>
                      <th className="text-center px-3 py-3 bg-[#0b0b0b] text-[#d0d0d0] text-[13px] font-extrabold">
                        Quantum
                      </th>
                      <th className="text-center px-3 py-3 bg-[#0b0b0b] text-[#d0d0d0] text-[13px] font-extrabold">
                        EV%
                      </th>
                      <th className="text-center px-3 py-3 bg-[#0b0b0b] text-[#d0d0d0] text-[13px] font-extrabold">
                        Score
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {Array.from(evByEvent.entries()).map(([eventId, plays]) => {
                      const head = plays[0];
                      const away = head.away_team ?? "Away";
                      const home = head.home_team ?? "Home";
                      const time = fmtCTTimeOnly(head.commence_time ?? null);

                      return plays.map((p, idx) => {
                        const uiM = normalizeMarketFromEv(p);
                        const pick = sideLabel(uiM, p.side ?? null, p.away_team ?? null, p.home_team ?? null);
                        const line = p.line;
                        const odds = p.odds;
                        const book = String(p.bookmaker || "").toLowerCase();

                        const q = typeof p.quantum_odds === "number" ? p.quantum_odds : null;
                        const evp = pickEvPct(p);
                        const score = typeof p.score === "number" ? p.score : null;

                        return (
                          <tr key={`${eventId}-${idx}`} className="border-b border-[#232323] hover:bg-white/5">
                            {idx === 0 ? (
                              <td className="px-4 py-3 sticky left-0 bg-[#0f0f0f] z-10 align-top" rowSpan={plays.length}>
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <div className="text-[12px] text-[#cfcfcf] font-semibold">{time} CT</div>
                                    <div className="text-white font-extrabold text-[14px] mt-1">
                                      {away} <span className="text-[#6f6f6f]">@</span> {home}
                                    </div>
                                  </div>

                                  <button
                                    type="button"
                                    onClick={() => openGameHistory(p)}
                                    className="text-[11px] font-extrabold text-[#d4af37] hover:underline shrink-0"
                                    title="View line movement history"
                                  >
                                    History
                                  </button>
                                </div>

                                <div className="text-[10px] text-[#6a6a6a] mt-2 break-all">{eventId}</div>
                              </td>
                            ) : null}

                            <td className="px-3 py-3 text-[12px] font-extrabold text-white border-l border-[#232323]">
                              {marketLabel(uiM)}
                            </td>
                            <td className="px-3 py-3 text-[12px] font-extrabold text-white">
                              <span className="text-[#d4af37]">{pick}</span>
                            </td>
                            <td className="px-3 py-3 text-center text-white font-extrabold tabular-nums">{line == null ? "—" : line}</td>
                            <td className="px-3 py-3 text-center text-white font-extrabold tabular-nums">
                              <div className="flex flex-col items-center leading-tight">
                                <div>{odds == null ? "—" : odds}</div>
                                <div className="text-[10px] text-[#cfcfcf] font-bold mt-0.5">{book || "—"}</div>
                              </div>
                            </td>
                            <td className="px-3 py-3 text-center text-white font-extrabold tabular-nums">{q == null ? "—" : q}</td>
                            <td className="px-3 py-3 text-center text-white font-extrabold tabular-nums">{fmtPct(evp)}</td>
                            <td className="px-3 py-3 text-center text-white font-extrabold tabular-nums">{score == null ? "—" : fmtNum(score, 0)}</td>
                          </tr>
                        );
                      });
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* PROPS */}
          <div className="rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden shadow-[0_16px_60px_rgba(0,0,0,0.38)]">
            <div className="px-4 md:px-6 py-4 border-b border-[#2a2a2a] flex items-center justify-between">
              <div className="text-white font-extrabold">Player Props (from player_prop_ev_latest)</div>
              <div className="text-[11px] text-[#8a8a8a] font-semibold">
                {filteredPropPlays.length ? `${filteredPropPlays.length} props` : "—"}
              </div>
            </div>

            {loading ? (
              <div className="p-4 text-xs text-[#808080]">Loading props…</div>
            ) : err ? (
              <div className="p-4 text-xs text-red-400">Supabase error: {err}</div>
            ) : !filteredPropPlays.length ? (
              <div className="p-4 text-xs text-[#808080]">No props for {selectedDate || "—"}.</div>
            ) : isMobile ? (
              <div className="p-3 space-y-3">
                {Array.from(propsByEvent.entries()).map(([eventId, plays]) => {
                  const h = plays[0];
                  const away = h.away_team ?? "Away";
                  const home = h.home_team ?? "Home";
                  const ct = fmtCTTimeOnly(h.commence_time ?? null);

                  return (
                    <div key={eventId} className="space-y-3">
                      <div className="px-1">
                        <div className="text-[12px] text-[#cfcfcf] font-semibold">
                          {ct} CT · <span className="text-white font-extrabold">{away}</span> @{" "}
                          <span className="text-white font-extrabold">{home}</span>
                        </div>
                      </div>

                      {plays.map((p, i) => {
                        const player = String(p.player_name || "—");
                        const pos = p.position ? String(p.position) : null;
                        const pm = String(p.market || "");
                        const side = String(p.side || "");
                        const line = typeof p.line === "number" ? p.line : null;

                        const book = String(p.bookmaker || "").toLowerCase();
                        const odds = typeof p.odds === "number" ? p.odds : null;
                        const evp = pickEvPct(p);
                        const score = typeof p.score === "number" ? p.score : null;
                        const q = typeof p.quantum_odds === "number" ? p.quantum_odds : null;

                        return (
                          <div key={`${eventId}-prop-${i}`} className="rounded-xl border border-[#2a2a2a] bg-black/20 overflow-hidden">
                            <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-start justify-between gap-3">
                              <div className="flex items-center gap-3 min-w-0">
                                <PlayerAvatar url={p.picture_url ?? null} name={player} size={34} />
                                <div className="min-w-0">
                                  <div className="text-white font-extrabold text-[13px] truncate flex items-center gap-2">
                                    <span className="truncate">{player}</span>
                                    {pos ? (
                                      <span className="shrink-0 text-[10px] font-extrabold px-2 py-0.5 rounded-md bg-white/10 border border-[#2a2a2a] text-[#d0d0d0]">
                                        {pos}
                                      </span>
                                    ) : null}
                                    {pill(marketLabel("prop", pm), "gray")}
                                  </div>
                                  <div className="text-[11px] text-[#8a8a8a] font-semibold mt-0.5 truncate">
                                    {side.toUpperCase()} {line == null ? "—" : line} · {book || "—"} {odds == null ? "" : `(${odds})`}
                                  </div>
                                </div>
                              </div>

                              <button
                                type="button"
                                onClick={() => openPropHistory(p)}
                                className="text-[11px] font-extrabold text-[#d4af37] hover:underline shrink-0"
                              >
                                History
                              </button>
                            </div>

                            <div className="px-4 py-3 grid grid-cols-3 gap-3">
                              <div className="rounded-lg border border-[#2a2a2a] bg-black/10 p-3">
                                <div className="text-[10px] text-[#808080] font-semibold">Quantum</div>
                                <div className="text-white font-extrabold tabular-nums text-[16px]">{q == null ? "—" : q}</div>
                              </div>
                              <div className="rounded-lg border border-[#2a2a2a] bg-black/10 p-3">
                                <div className="text-[10px] text-[#808080] font-semibold">EV%</div>
                                <div className="text-white font-extrabold tabular-nums text-[16px]">{fmtPct(evp)}</div>
                              </div>
                              <div className="rounded-lg border border-[#2a2a2a] bg-black/10 p-3">
                                <div className="text-[10px] text-[#808080] font-semibold">Score</div>
                                <div className="text-white font-extrabold tabular-nums text-[16px]">{score == null ? "—" : fmtNum(score, 0)}</div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full table-fixed">
                  <colgroup>
                    <col style={{ width: 420 }} />
                    <col style={{ width: 250 }} />
                    <col style={{ width: 110 }} />
                    <col style={{ width: 110 }} />
                    <col style={{ width: 140 }} />
                    <col style={{ width: 110 }} />
                    <col style={{ width: 110 }} />
                  </colgroup>

                  <thead className="sticky top-0 z-20">
                    <tr className="border-b border-[#232323]">
                      <th className="text-left px-4 py-3 bg-[#0b0b0b] text-[#d0d0d0] sticky left-0 z-30 text-[13px] font-extrabold">
                        Matchup
                      </th>
                      <th className="text-left px-3 py-3 bg-[#0b0b0b] text-[#d0d0d0] text-[13px] font-extrabold border-l border-[#232323]">
                        Player / Prop
                      </th>
                      <th className="text-center px-3 py-3 bg-[#0b0b0b] text-[#d0d0d0] text-[13px] font-extrabold">
                        Side
                      </th>
                      <th className="text-center px-3 py-3 bg-[#0b0b0b] text-[#d0d0d0] text-[13px] font-extrabold">
                        Line
                      </th>
                      <th className="text-center px-3 py-3 bg-[#0b0b0b] text-[#d0d0d0] text-[13px] font-extrabold">
                        Odds / Book
                      </th>
                      <th className="text-center px-3 py-3 bg-[#0b0b0b] text-[#d0d0d0] text-[13px] font-extrabold">
                        EV%
                      </th>
                      <th className="text-center px-3 py-3 bg-[#0b0b0b] text-[#d0d0d0] text-[13px] font-extrabold">
                        Score
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {Array.from(propsByEvent.entries()).map(([eventId, plays]) => {
                      const head = plays[0];
                      const away = head.away_team ?? "Away";
                      const home = head.home_team ?? "Home";
                      const time = fmtCTTimeOnly(head.commence_time ?? null);

                      return plays.map((p, idx) => {
                        const player = String(p.player_name || "—");
                        const pm = String(p.market || "");
                        const side = String(p.side || "");
                        const line = typeof p.line === "number" ? p.line : null;

                        const book = String(p.bookmaker || "").toLowerCase();
                        const odds = typeof p.odds === "number" ? p.odds : null;

                        const evp = pickEvPct(p);
                        const score = typeof p.score === "number" ? p.score : null;

                        return (
                          <tr key={`${eventId}-prop-${idx}`} className="border-b border-[#232323] hover:bg-white/5">
                            {idx === 0 ? (
                              <td className="px-4 py-3 sticky left-0 bg-[#0f0f0f] z-10 align-top" rowSpan={plays.length}>
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <div className="text-[12px] text-[#cfcfcf] font-semibold">{time} CT</div>
                                    <div className="text-white font-extrabold text-[14px] mt-1">
                                      {away} <span className="text-[#6f6f6f]">@</span> {home}
                                    </div>
                                  </div>
                                </div>

                                <div className="text-[10px] text-[#6a6a6a] mt-2 break-all">{eventId}</div>
                              </td>
                            ) : null}

                            <td className="px-3 py-3 border-l border-[#232323]">
                              <div className="flex items-center gap-3 min-w-0">
                                <PlayerAvatar url={p.picture_url ?? null} name={player} size={30} />
                                <div className="min-w-0">
                                  <div className="text-white font-extrabold text-[12px] truncate flex items-center gap-2">
                                    <span className="truncate">{player}</span>
                                    {p.position ? pill(String(p.position), "gray") : null}
                                  </div>
                                  <div className="text-[11px] text-[#8a8a8a] font-semibold mt-0.5">
                                    {pill(marketLabel("prop", pm))}
                                  </div>
                                </div>
                              </div>
                            </td>

                            <td className="px-3 py-3 text-center text-white font-extrabold">{side.toUpperCase()}</td>
                            <td className="px-3 py-3 text-center text-white font-extrabold tabular-nums">{line == null ? "—" : line}</td>
                            <td className="px-3 py-3 text-center text-white font-extrabold tabular-nums">
                              <div className="flex items-center justify-center gap-2">
                                <span>{odds == null ? "—" : odds}</span>
                                <span className="text-[10px] text-[#cfcfcf] font-bold">{book || "—"}</span>
                                <button
                                  type="button"
                                  onClick={() => openPropHistory(p)}
                                  className="text-[11px] font-extrabold text-[#d4af37] hover:underline ml-2"
                                >
                                  History
                                </button>
                              </div>
                            </td>
                            <td className="px-3 py-3 text-center text-white font-extrabold tabular-nums">{fmtPct(evp)}</td>
                            <td className="px-3 py-3 text-center text-white font-extrabold tabular-nums">{score == null ? "—" : fmtNum(score, 0)}</td>
                          </tr>
                        );
                      });
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* History modal */}
        {historyOpen && historyCtx && (
          <HistoryModal ctx={historyCtx} defaultTab={historyDefaultTab} onClose={closeHistory} />
        )}

        <div className="h-12" />
      </div>
    </div>
  );
}
