// screens/OddsScreen.tsx — FULL REWRITE (Player Props logos fixed: always readable)
// ✅ Player Props: book logos ALWAYS inside white pill badge (desktop + mobile)
// ✅ Mobile: Show Books + (⋯) overflow -> History / Props (bottom sheet)
// ✅ Default market = Moneyline (always)
// ✅ Last Updated derived from latestUpdatedAt across rows (no fake "now" fallback)

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
  return row.logo_url ?? row.team_logo_url ?? row.logo ?? null;
}
function pickUpdatedAt(row: any): string | null {
  return row.updated_at ?? row.last_updated ?? row.updatedAt ?? row.last_updated_ct ?? null;
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
 * LOGO PILL (NEW: used everywhere in Player Props)
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
  bk,
  size = "md",
}: {
  bk: BookKey;
  size?: "sm" | "md";
}) {
  const pillClass =
    size === "sm"
      ? "h-7 w-[88px] px-3"
      : "h-8 w-[96px] px-3";

  return (
    <div
      className={[
        pillClass,
        "rounded-full bg-white/95 border border-[#e5e5e5]",
        "flex items-center justify-center",
        "shadow-[0_2px_10px_rgba(0,0,0,0.35)]",
      ].join(" ")}
    >
      <img
        src={BOOK_LOGOS[bk]}
        alt={bk}
        className={size === "sm" ? "h-4 w-auto object-contain" : "h-5 w-auto object-contain"}
        loading="lazy"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).src = headerFallbackPillDataUri(bk.toUpperCase());
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

function MiniTeamRow({ team, logoUrl, side }: { team: string; logoUrl: string | null; side: "AWAY" | "HOME" }) {
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

function cellMlParts(odds: number | null): CellParts {
  return { top: odds == null ? "—" : String(odds) };
}
function cellLineOddsParts(line: number | null, odds: number | null): CellParts {
  if (line == null) return { top: "—" };
  return { top: String(line), bottom: odds == null ? "—" : `(${odds})` };
}

function partsForBookSide(ev: EventOdds, market: Market, side: "AWAY" | "HOME", book: BookKey): CellParts {
  const src = side === "AWAY" ? ev.away : ev.home;
  if (!src) return { top: "—" };

  if (market === "ml") return cellMlParts(src.ml[book] ?? null);

  if (market === "spread") {
    const c = src.spread[book];
    return cellLineOddsParts(c?.line ?? null, c?.odds ?? null);
  }

  // total: AWAY is Over, HOME is Under
  const t = src.total[book];
  const odds = side === "AWAY" ? t?.over ?? null : t?.under ?? null;
  return cellLineOddsParts(t?.line ?? null, odds);
}

/** =========================
 * MOBILE OVERFLOW (BOTTOM SHEET)
 * ========================= */

function MobileOverflowSheet({
  open,
  onClose,
  onHistory,
  onProps,
}: {
  open: boolean;
  onClose: () => void;
  onHistory: () => void;
  onProps: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[998] bg-black/70 flex items-end sm:items-center justify-center p-2"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden">
        <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-center justify-between">
          <div className="text-white font-extrabold text-sm">Actions</div>
          <button
            type="button"
            onClick={onClose}
            className="text-[#cfcfcf] hover:text-white text-sm font-bold px-2 py-1 rounded-md hover:bg-white/10"
          >
            ✕
          </button>
        </div>

        <div className="p-2">
          <button
            type="button"
            onClick={() => {
              onClose();
              onHistory();
            }}
            className="w-full text-left px-4 py-3 rounded-xl border border-[#2a2a2a] bg-black/20 hover:bg-white/5 transition-colors"
          >
            <div className="text-white font-extrabold text-[13px]">History</div>
            <div className="text-[#808080] text-[11px] font-semibold mt-0.5">
              Odds movement (line shown on hover)
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              onClose();
              onProps();
            }}
            className="w-full text-left px-4 py-3 rounded-xl border border-[#2a2a2a] bg-black/20 hover:bg-white/5 transition-colors mt-2"
          >
            <div className="text-white font-extrabold text-[13px]">Player Props</div>
            <div className="text-[#808080] text-[11px] font-semibold mt-0.5">
              Points / Rebounds / Assists / 3PT
            </div>
          </button>
        </div>

        <div className="px-4 pb-4">
          <div className="h-1 w-10 bg-white/10 rounded-full mx-auto" />
        </div>
      </div>
    </div>
  );
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
 * PLAYER PROPS MODAL (LOGOS FIXED)
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
}: {
  ev: EventOdds;
  sportKey: string;
  onClose: () => void;
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

      const q1 = supabase
        .from("player_props_snapshot")
        .select(
          "id,ts,run_id,sport_key,event_id,commence_time,home_team,away_team,player_name,player_id,team,opponent,market,side,line,odds,bookmaker,source,inserted_at"
        )
        .eq("sport_key", sportKey)
        .eq("market", propType)
        .eq("event_id", ev.eventId)
        .order("ts", { ascending: false })
        .limit(5000);

      const r1 = await q1;
      if (!alive) return;

      let raw = (r1.data ?? []) as PlayerPropSnapshotRow[];
      let error = r1.error;

      if (!error && (!raw || raw.length === 0)) {
        const home = ev.home?.team ?? "";
        const away = ev.away?.team ?? "";

        const orFilter = [
          `and(home_team.eq.${home},away_team.eq.${away})`,
          `and(home_team.eq.${away},away_team.eq.${home})`,
        ].join(",");

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
  }, [ev.eventId, ev.home?.team, ev.away?.team, propType, sportKey]);

  const subtitle = [
    ev.commenceTime ? `Commence: ${fmtCTDateTime(ev.commenceTime)}` : null,
    latestTs ? `Snapshot: ${fmtCTDateTime(latestTs)}` : "Snapshot: —",
  ]
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
        <div className="text-[12px] text-white font-extrabold tabular-nums">
          {cell.line == null ? "—" : cell.line}
        </div>
        <div className="text-[11px] text-[#cfcfcf] font-bold tabular-nums mt-0.5">
          O: {cell.over == null ? "—" : cell.over}
        </div>
        <div className="text-[11px] text-[#cfcfcf] font-bold tabular-nums">
          U: {cell.under == null ? "—" : cell.under}
        </div>
      </div>
    );
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
                    <th className={`text-left px-4 py-3 ${HDR_LEFT_BG} ${HDR_TEXT} text-[12px] font-extrabold`}>
                      Player
                    </th>

                    <th
                      className={`text-center px-3 py-3 ${HDR_LEFT_BG} ${HDR_TEXT} text-[12px] font-extrabold border-l ${HDR_BORDER}`}
                    >
                      Cons Line
                    </th>

                    {BOOKS.map((bk, i) => (
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
                        {/* ✅ FIX: always render logo on white pill */}
                        <div className="flex items-center justify-center">
                          <BookLogoPill bk={bk} size="md" />
                        </div>
                      </th>
                    ))}
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
                              {r.team ?? "—"}{" "}
                              {r.opponent ? <span className="text-[#6f6f6f]">vs {r.opponent}</span> : null}
                            </div>
                          )}
                        </div>
                      </td>

                      <td className={`px-3 py-3 text-center font-extrabold text-white tabular-nums border-l ${HDR_BORDER}`}>
                        {r.lineConsensus == null ? "—" : r.lineConsensus}
                      </td>

                      {BOOKS.map((bk, i) => (
                        <td
                          key={bk}
                          className={["px-2 py-3 text-center", i === 0 ? `border-l ${HDR_BORDER}` : ""].join(" ")}
                        >
                          <PropBookCell cell={r.byBook[bk]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 text-[11px] text-[#808080]">
              Each book cell shows: <span className="text-white font-bold">Line</span> +{" "}
              <span className="text-white font-bold">O/U odds</span> (latest snapshot only).
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
                        {r.team ?? "—"}{" "}
                        {r.opponent ? <span className="text-[#6f6f6f]">vs {r.opponent}</span> : null}
                      </div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] text-[#808080] font-semibold">Cons</div>
                    <div className="text-white font-extrabold tabular-nums">
                      {r.lineConsensus == null ? "—" : r.lineConsensus}
                    </div>
                  </div>
                </div>

                <div className="p-3 grid grid-cols-2 gap-3">
                  {BOOKS.map((bk) => (
                    <div key={bk} className="rounded-lg border border-[#2a2a2a] bg-black/10 p-3">
                      <div className="flex items-center justify-between mb-2">
                        {/* ✅ FIX: use white pill here too (this was the main issue) */}
                        <BookLogoPill bk={bk} size="sm" />
                        <div className="text-[10px] text-[#808080] font-bold">{bk.toUpperCase()}</div>
                      </div>
                      <PropBookCell cell={r.byBook[bk]} />
                    </div>
                  ))}
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
 * HISTORY / MODALS (KEEP YOUR EXISTING IMPLEMENTATIONS)
 * ========================= */

function HistoryChartPairOddsOnly(props: any) {
  // paste your existing implementation here
  return null;
}
function LineMovementModal(props: any) {
  // paste your existing implementation here
  return null;
}

/** =========================
 * MOBILE CARD (UPDATED ACTIONS)
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
  const [sheetOpen, setSheetOpen] = useState(false);

  const leftLabel = market === "total" ? "Over" : "Away";
  const rightLabel = market === "total" ? "Under" : "Home";

  const awayCons = consensusPartsForRow(ev, market, "AWAY");
  const homeCons = consensusPartsForRow(ev, market, "HOME");

  const leftPartsByBook = (b: BookKey) => partsForBookSide(ev, market, "AWAY", b);
  const rightPartsByBook = (b: BookKey) => partsForBookSide(ev, market, "HOME", b);

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-black/20 overflow-hidden">
      <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-center justify-between gap-3">
        <div className="text-[12px] text-[#cfcfcf] font-semibold">{fmtCTTimeOnly(ev.commenceTime)} CT</div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleBooks}
            className="text-[11px] font-extrabold text-white/90 hover:text-white px-3 py-1.5 rounded-md border border-[#2a2a2a] hover:border-[#3a3a3a]"
          >
            {booksOpen ? "Hide Books" : "Show Books"}
          </button>

          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="w-9 h-9 rounded-md border border-[#2a2a2a] hover:border-[#3a3a3a] bg-black/20 hover:bg-white/5 flex items-center justify-center text-white font-extrabold"
            aria-label="More actions"
            title="More"
          >
            ⋯
          </button>
        </div>

        <MobileOverflowSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          onHistory={() => onOpenHistory(ev)}
          onProps={() => onOpenProps(ev)}
        />
      </div>

      <div className="px-4 py-3 space-y-3">
        <MiniTeamRow team={ev.away?.team ?? "Away"} logoUrl={ev.away?.logoUrl ?? null} side="AWAY" />
        <MiniTeamRow team={ev.home?.team ?? "Home"} logoUrl={ev.home?.logoUrl ?? null} side="HOME" />
      </div>

      <div className="px-4 pb-4">
        <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[12px] text-white font-extrabold">Consensus</div>
            <div className="text-[11px] text-[#808080] font-semibold">
              {market === "ml" ? "Moneyline" : market === "spread" ? "Spread" : "Total"}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-[#1f1f1f] bg-black/20 p-2">
              <div className="text-[10px] text-[#808080] font-semibold mb-0.5 text-center">{leftLabel}</div>
              <div className="text-[14px] text-white font-extrabold tabular-nums text-center">
                {renderCellParts(awayCons)}
              </div>
            </div>
            <div className="rounded-md border border-[#1f1f1f] bg-black/20 p-2">
              <div className="text-[10px] text-[#808080] font-semibold mb-0.5 text-center">{rightLabel}</div>
              <div className="text-[14px] text-white font-extrabold tabular-nums text-center">
                {renderCellParts(homeCons)}
              </div>
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
              {BOOKS.map((bk) => (
                <div key={bk} className="py-2 border-b border-[#141414] last:border-b-0">
                  <div className="grid grid-cols-[110px_1fr_1fr] items-center gap-3">
                    <div className="flex justify-start">
                      <BookLogoPill bk={bk} size="md" />
                    </div>

                    <div className="text-center text-white font-extrabold tabular-nums text-[13px] leading-tight">
                      {renderCellParts(partsForBookSide(ev, market, "AWAY", bk))}
                    </div>
                    <div className="text-center text-white font-extrabold tabular-nums text-[13px] leading-tight">
                      {renderCellParts(partsForBookSide(ev, market, "HOME", bk))}
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

/** =========================
 * DESKTOP ROWS
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

  // ✅ Default to ML
  const [market, setMarket] = useState<Market>("ml");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // ✅ Correct: actual latest timestamp from data; null if unknown
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
      setLastUpdatedIso(null);
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

      byEvent.set(eventId, cur);
    }

    const list = Array.from(byEvent.values()).sort((a, b) => {
      const ta = new Date(normalizeIso(a.commenceTime) ?? a.commenceTime).getTime();
      const tb = new Date(normalizeIso(b.commenceTime) ?? b.commenceTime).getTime();
      return ta - tb;
    });

    setAllEvents(list);

    // ✅ no fake fallback
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

  // ✅ when sport changes: reset and default back to ML
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
              <div className="text-xs text-[#8a8a8a] mt-1">
                {headerLabel} · 5 books · refresh 60s
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

          <div className="md:hidden mt-2">
            <div className="text-[10px] text-[#6a6a6a] font-semibold">Last Updated (CT)</div>
            <div className="text-xs text-white flex items-center gap-2">
              <span className="font-extrabold">{fmtCTDateTime(lastUpdatedIso)}</span>
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
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

                      <BookHeader src={BOOK_LOGOS.dk} alt="DraftKings" fallbackLabel="DK" borderLeft />
                      <BookHeader src={BOOK_LOGOS.fd} alt="FanDuel" fallbackLabel="FD" />
                      <BookHeader src={BOOK_LOGOS.mgm} alt="BetMGM" fallbackLabel="MGM" />
                      <BookHeader src={BOOK_LOGOS.pin} alt="Pinnacle" fallbackLabel="PIN" />
                      <BookHeader src={BOOK_LOGOS.bol} alt="BetOnline" fallbackLabel="BOL" />
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
            )}
          </div>
        </div>

        {/* History modal */}
        {historyOpen && historyEvent?.eventId && (
          <LineMovementModal ev={historyEvent} uiMarket={market} onClose={closeHistory} />
        )}

        {/* Player Props modal */}
        {propsOpen && propsEvent?.eventId && (
          <PlayerPropsModal ev={propsEvent} sportKey={sportKey} onClose={closeProps} />
        )}

        <div className="h-12" />
      </div>
    </div>
  );
}


