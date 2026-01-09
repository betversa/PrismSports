// screens/Overview/OverviewScreen.tsx — FULL REWRITE (Top Plays: soft-book filters only + EV gates by type)
// -----------------------------------------------------------------------------------------------------
// ✅ Keeps: Mobile Top Plays compact + Prism black/gold/slate styling
// ✅ Gates (Top Plays):
//    - ALL: Odds must be between -200 and +200 (book price)
//    - Games: max EV 15% (NO min EV gate)
//    - Props: EV must be 2% to 15%
//    - Score >= 50
//    - Future-ish commence_time
//    - Dedupe: one card per play (best book shown)
// ✅ Book filter (Top Plays):
//    - ONLY SOFT books shown as options: DraftKings / FanDuel / BetMGM / Any
//    - Filter applies AFTER dedupe so "one card per play" stays true
//
// Notes:
// - "Soft books" defined as DK/FD/MGM. Any shows all books (including sharp) that pass gates.
// - If you want "Any" to still exclude sharps, tell me and I’ll flip that in one line.

import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Calculator,
  Database,
  Flame,
  RefreshCw,
  Search,
  Sparkles,
  Target,
  Trophy,
} from "lucide-react";
import { supabase } from "../../lib/supabaseClient";

/* =========================================================
   TYPES
========================================================= */

type MonteCarloRunRow = {
  id: string;
  created_at: string;
  sport_key: string;
};

type ModelVersionRow = {
  version: string;
  release_date: string | null;
  status: string | null;
  simulations: number | null;
  updated_at: string | null;
};

type ChangeLogRow = {
  version: string;
  date: string | null;
  changes: string[];
};

type TeamMapRow = {
  canonical: string | null;
  abbreviation: string | null;
  Abbreviation?: string | null;
};

type EvPlayRow = {
  id?: string;
  run_id?: string;
  sport_key?: string;
  event_id?: string;
  commence_time?: string | null;

  matchup?: string | null;
  market?: string | null;
  side?: string | null;
  team?: string | null;
  line?: number | null;

  bookmaker?: string | null;
  book_odds?: number | null;
  odds?: number | null;

  quantum_fair_odds?: number | null;
  fair_odds?: number | null;
  quantum_odds?: number | null;

  ev_pct?: number | null;
  ev?: number | null;
  confidence_score?: number | null;
  score?: number | null;
};

type PropEvRow = {
  id?: string;
  sport_key?: string;
  event_id?: string;
  commence_time?: string | null;

  player_name?: string | null;
  team?: string | null;
  opponent?: string | null;
  position?: string | null;
  picture_url?: string | null;

  market?: string | null;
  side?: string | null;
  line?: number | null;

  book?: string | null;
  bookmaker?: string | null;
  odds?: number | null;

  quantum_fair_odds?: number | null;
  fair_odds?: number | null;
  quantum_odds?: number | null;

  ev_pct?: number | null;
  ev?: number | null;
  score?: number | null;
};

/* =========================================================
   THEME / FILTERS
========================================================= */

const GOLD = "#d89211";
const PANEL = "#0b0b0b";
const BORDER = "#252525";
const SLATE = "rgba(87,90,98,0.26)";
const SURFACE = "#070707";

const LABEL_CLASS = "text-[10px] tracking-[0.16em] uppercase text-[#8a8a8a] font-semibold";
const VALUE_CLASS = "text-white font-extrabold tabular-nums";

type PlayTab = "all" | "game" | "props";

const TOP_SCORE_MIN = 50;

// Top Plays gates
const TOP_MAX_EV_PCT = 15; // %
const TOP_MIN_EV_PCT_PROPS = 2; // %
const TOP_MIN_ODDS = -200;
const TOP_MAX_ODDS = 200;

// Soft-book filter options ONLY
type SoftBookFilter = "any" | "draftkings" | "fanduel" | "betmgm";

/* =========================================================
   HELPERS
========================================================= */

function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function isFutureish(ts?: string | null) {
  if (!ts) return true;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return true;
  return d.getTime() > Date.now() - 3 * 60 * 60 * 1000;
}

function normalizeBook(b?: string | null) {
  if (!b) return "—";
  const x = String(b).toLowerCase();
  if (x.includes("draft")) return "DraftKings";
  if (x.includes("fanduel")) return "FanDuel";
  if (x.includes("mgm")) return "BetMGM";
  if (x.includes("pinnacle") || x === "pin") return "Pinnacle";
  if (x.includes("betonline")) return "BetOnline";
  return b;
}

function softBookKey(b?: string | null): SoftBookFilter | "other" {
  const x = String(b ?? "").toLowerCase();
  if (x.includes("draft")) return "draftkings";
  if (x.includes("fanduel")) return "fanduel";
  if (x.includes("mgm")) return "betmgm";
  return "other";
}

/** /public/books/ → "/books/..." */
function bookSquareLogoSrc(bookName: string) {
  const x = (bookName || "").toLowerCase();
  if (x.includes("draft")) return "/books/dksquare.png";
  if (x.includes("fanduel")) return "/books/fdsquare.png";
  if (x.includes("mgm")) return "/books/mgmsquare.png";
  if (x.includes("pinnacle") || x === "pin") return "/books/pinsquare.png";
  if (x.includes("betonline")) return "/books/betonlinesquare.png";
  return null;
}

function marketLabel(m?: string | null) {
  const x = (m ?? "").toLowerCase();
  if (x === "h2h" || x.includes("money")) return "Moneyline";
  if (x.includes("spread")) return "Spread";
  if (x.includes("total")) return "Total";
  if (x.includes("points")) return "Points";
  if (x.includes("reb")) return "Rebounds";
  if (x.includes("ast")) return "Assists";
  if (x.includes("three")) return "3PT";
  return m ?? "Market";
}

function titleCase(s: string) {
  return String(s)
    .replace(/_/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function fmtOdds(odds?: number | null) {
  if (odds == null) return "—";
  const n = Math.trunc(Number(odds));
  if (!Number.isFinite(n) || n === 0) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtLine(line?: number | null) {
  const n = safeNum(line);
  if (n == null) return "";
  return n > 0 ? `+${n}` : `${n}`;
}

function formatTsShort(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getEvPct(row: { ev_pct?: number | null; ev?: number | null }) {
  const v = row.ev_pct ?? row.ev ?? null;
  if (v == null) return null;
  const n = safeNum(v);
  if (n == null) return null;
  if (Math.abs(n) <= 1) return n * 100; // supports 0.0212
  return n;
}

function getGameScore(row: EvPlayRow) {
  const s = row.confidence_score ?? row.score ?? null;
  const n = safeNum(s);
  if (n == null) return null;
  return clamp(n, 0, 100);
}

function getPropScore(row: PropEvRow) {
  const s = row.score ?? null;
  const n = safeNum(s);
  if (n == null) return null;
  return clamp(n, 0, 100);
}

function getGameOdds(row: EvPlayRow) {
  const o = row.book_odds ?? row.odds ?? null;
  const n = safeNum(o);
  if (n == null) return null;
  return Math.trunc(n);
}

function getPropOdds(row: PropEvRow) {
  const n = safeNum(row.odds);
  if (n == null) return null;
  return Math.trunc(n);
}

function getGameFairOdds(row: EvPlayRow) {
  const o = row.quantum_fair_odds ?? row.fair_odds ?? row.quantum_odds ?? null;
  const n = safeNum(o);
  if (n == null) return null;
  return Math.trunc(n);
}

function getPropFairOdds(row: PropEvRow) {
  const o = row.quantum_fair_odds ?? row.fair_odds ?? row.quantum_odds ?? null;
  const n = safeNum(o);
  if (n == null) return null;
  return Math.trunc(n);
}

function evTextClass(ev: number | null) {
  if (ev == null) return "text-white";
  if (ev >= 7) return "text-emerald-300";
  if (ev >= 3) return "text-[#d89211]";
  return "text-[#b0b0b0]";
}

function evBarStyle(ev: number | null): React.CSSProperties {
  if (ev == null) return { width: "0%" };
  const mag = clamp(ev, 0, 12);
  const w = (mag / 12) * 100;

  const color =
    ev >= 7
      ? "rgba(52, 211, 153, 0.28)"
      : ev >= 3
      ? "rgba(216, 146, 17, 0.34)"
      : "rgba(255,255,255,0.10)";

  return { width: `${w}%`, background: color };
}

function withinOddsGate(odds: number | null) {
  if (odds == null) return false;
  return odds >= TOP_MIN_ODDS && odds <= TOP_MAX_ODDS;
}

function withinMaxEvGate(ev: number | null) {
  if (ev == null) return false;
  return ev <= TOP_MAX_EV_PCT;
}

function withinPropEvRange(ev: number | null) {
  if (ev == null) return false;
  return ev >= TOP_MIN_EV_PCT_PROPS && ev <= TOP_MAX_EV_PCT;
}

/* =========================================================
   TEAM ABBREVIATIONS (exact + substring)
========================================================= */

function canonKey(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,()]/g, "")
    .trim();
}

function buildAbbrevMap(rows: TeamMapRow[]) {
  const m = new Map<string, string>();
  for (const r of rows || []) {
    const canonical = (r.canonical ?? "").trim();
    const abbr = ((r.abbreviation ?? r.Abbreviation ?? "") as string).trim();
    if (!canonical || !abbr) continue;
    m.set(canonKey(canonical), abbr);
  }
  return m;
}

function abbreviateTeamName(
  name: string | null | undefined,
  abbrevMap: Map<string, string>
) {
  const raw = (name ?? "").trim();
  if (!raw) return "";

  const key = canonKey(raw);
  const exact = abbrevMap.get(key);
  if (exact) return exact;

  for (const [canon, abbr] of abbrevMap.entries()) {
    if (!canon) continue;
    if (key.includes(canon) || canon.includes(key)) return abbr;
  }

  return raw;
}

function abbreviateMatchup(
  matchup: string | null | undefined,
  abbrevMap: Map<string, string>
) {
  const raw = (matchup ?? "").trim();
  if (!raw) return "—";

  const candidates = [
    { sep: " vs ", nice: " vs " },
    { sep: " VS ", nice: " vs " },
    { sep: " @ ", nice: " @ " },
    { sep: " at ", nice: " @ " },
    { sep: " AT ", nice: " @ " },
  ];

  for (const c of candidates) {
    if (raw.includes(c.sep)) {
      const parts = raw.split(c.sep);
      if (parts.length >= 2) {
        const left = parts[0].trim();
        const right = parts.slice(1).join(c.sep).trim();
        const L = abbreviateTeamName(left, abbrevMap) || left;
        const R = abbreviateTeamName(right, abbrevMap) || right;
        return `${L}${c.nice}${R}`;
      }
    }
  }

  return abbreviateTeamName(raw, abbrevMap) || raw;
}

function matchesSearchQuery(haystack: Array<string | null | undefined>, query: string) {
  if (!query) return true;
  const q = query.toLowerCase();
  return haystack.some((item) => (item ?? "").toLowerCase().includes(q));
}

/* =========================================================
   DEDUPE
========================================================= */

function keyGamePlay(r: EvPlayRow) {
  return [
    r.event_id ?? "",
    r.matchup ?? "",
    (r.market ?? "").toLowerCase(),
    (r.side ?? "").toLowerCase(),
    r.team ?? "",
    r.line ?? "",
  ].join("|");
}

function keyPropPlay(r: PropEvRow) {
  return [
    r.event_id ?? "",
    (r.player_name ?? "").toLowerCase(),
    (r.market ?? "").toLowerCase(),
    (r.side ?? "").toLowerCase(),
    r.line ?? "",
  ].join("|");
}

function pickBestGame(rows: EvPlayRow[]) {
  return rows
    .slice()
    .sort((a, b) => {
      const sa = getGameScore(a) ?? -999;
      const sb = getGameScore(b) ?? -999;
      if (sb !== sa) return sb - sa;

      const ea = getEvPct(a) ?? -999;
      const eb = getEvPct(b) ?? -999;
      if (eb !== ea) return eb - ea;

      const oa = getGameOdds(a) != null ? 1 : 0;
      const ob = getGameOdds(b) != null ? 1 : 0;
      if (ob !== oa) return ob - oa;

      const fa = getGameFairOdds(a) != null ? 1 : 0;
      const fb = getGameFairOdds(b) != null ? 1 : 0;
      return fb - fa;
    })[0];
}

function pickBestProp(rows: PropEvRow[]) {
  return rows
    .slice()
    .sort((a, b) => {
      const sa = getPropScore(a) ?? -999;
      const sb = getPropScore(b) ?? -999;
      if (sb !== sa) return sb - sa;

      const ea = getEvPct(a) ?? -999;
      const eb = getEvPct(b) ?? -999;
      if (eb !== ea) return eb - ea;

      const oa = getPropOdds(a) != null ? 1 : 0;
      const ob = getPropOdds(b) != null ? 1 : 0;
      if (ob !== oa) return ob - oa;

      const fa = getPropFairOdds(a) != null ? 1 : 0;
      const fb = getPropFairOdds(b) != null ? 1 : 0;
      return fb - fa;
    })[0];
}

/* =========================================================
   CARD STRING BUILDERS
========================================================= */

function gameSubtitle(r: EvPlayRow) {
  const m = marketLabel(r.market ?? "");
  const side = (r.side ?? "").toUpperCase();
  const line = fmtLine(r.line ?? null);
  const team = (r.team ?? "").trim();
  const pick = team ? `${team}${line ? ` ${line}` : ""}` : `${side}${line ? ` ${line}` : ""}`;
  return `${m} • ${pick}`;
}

function propTitle(r: PropEvRow, abbrevMap: Map<string, string>) {
  const pn = (r.player_name ?? "Unknown Player").trim();
  const t = abbreviateTeamName(r.team ?? "", abbrevMap);
  const o = abbreviateTeamName(r.opponent ?? "", abbrevMap);
  const vs = t && o ? `${t} vs ${o}` : t || o ? t || o : "";
  return vs ? `${pn} (${vs})` : pn;
}

function propSubtitle(r: PropEvRow) {
  const m = titleCase(marketLabel(r.market ?? "Prop"));
  const side = (r.side ?? "").toUpperCase();
  const line = fmtLine(r.line ?? null);
  return `${m} • ${side}${line ? ` ${line}` : ""}`;
}

/* =========================================================
   UI BITS
========================================================= */

function PremiumPanel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={[
        "relative overflow-hidden rounded-2xl border p-4 md:p-5",
        className ?? "",
      ].join(" ")}
      style={{ borderColor: BORDER, background: PANEL }}
    >
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0"
          style={{
            background: [
              "radial-gradient(800px 260px at 18% 0%, rgba(216,146,17,0.14), transparent 60%)",
              `radial-gradient(760px 260px at 86% 10%, ${SLATE}, transparent 62%)`,
              "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.012) 55%, rgba(0,0,0,0.0) 100%)",
              "linear-gradient(180deg, rgba(0,0,0,0.22), rgba(0,0,0,0.62) 55%, rgba(0,0,0,0.86) 100%)",
            ].join(", "),
          }}
        />
        <div
          className="absolute left-0 right-0 top-0 h-[1px] opacity-80"
          style={{
            background:
              "linear-gradient(90deg, rgba(255,255,255,0.0), rgba(255,255,255,0.10), rgba(255,255,255,0.0))",
          }}
        />
      </div>
      <div className="relative">{children}</div>
    </div>
  );
}

function QuickAction({
  title,
  sub,
  icon: Icon,
  href,
}: {
  title: string;
  sub: string;
  icon: any;
  href: string;
}) {
  return (
    <button
      type="button"
      onClick={() => (window.location.href = href)}
      className={[
        "group text-left rounded-xl border p-4 transition-all",
        "hover:border-[#3b3b3b] hover:-translate-y-0.5",
      ].join(" ")}
      style={{
        borderColor: BORDER,
        background: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.22))",
      }}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm text-white font-semibold">{title}</div>
          <div className="text-xs text-[#a7a7a7] mt-0.5">{sub}</div>
        </div>

        <div
          className="w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 transition-colors"
          style={{
            borderColor: "rgba(216,146,17,0.22)",
            background: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.12))",
            boxShadow: "0 10px 28px rgba(0,0,0,0.35)",
          }}
        >
          <Icon className="w-4 h-4" style={{ color: GOLD }} />
        </div>
      </div>
    </button>
  );
}

function Segmented({ value, onChange }: { value: PlayTab; onChange: (v: PlayTab) => void }) {
  const btn = (v: PlayTab, label: string) => {
    const active = value === v;
    return (
      <button
        type="button"
        onClick={() => onChange(v)}
        className={[
          "px-3 py-1.5 rounded-full text-[11px] border transition-colors",
          active ? "text-white" : "text-[#cfcfcf] hover:text-white",
        ].join(" ")}
        style={{
          borderColor: active ? "rgba(216,146,17,0.34)" : BORDER,
          background: active
            ? "linear-gradient(180deg, rgba(216,146,17,0.14), rgba(0,0,0,0.25))"
            : "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.18))",
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="flex items-center gap-2">
      {btn("all", "All")}
      {btn("game", "Games")}
      {btn("props", "Props")}
    </div>
  );
}

function Chip({
  active,
  label,
  onClick,
  leftIconSrc,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  leftIconSrc?: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] transition-colors",
        active ? "text-white" : "text-[#cfcfcf] hover:text-white",
      ].join(" ")}
      style={{
        borderColor: active ? "rgba(216,146,17,0.34)" : BORDER,
        background: active
          ? "linear-gradient(180deg, rgba(216,146,17,0.14), rgba(0,0,0,0.24))"
          : "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.18))",
      }}
    >
      {leftIconSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={leftIconSrc}
          alt=""
          className="w-4 h-4 rounded-[6px] border"
          style={{ borderColor: "rgba(255,255,255,0.10)" }}
        />
      ) : null}
      {label}
    </button>
  );
}

function StatTile({ label, value }: { label: string; value?: string }) {
  return (
    <div
      className="rounded-xl border bg-black/30 px-3 py-2"
      style={{ borderColor: BORDER }}
    >
      <div className={LABEL_CLASS}>{label}</div>
      <div className={[VALUE_CLASS, "text-sm"].join(" ")}>{value ?? "—"}</div>
    </div>
  );
}

/**
 * MiniStat (mobile-compact)
 */
function MiniStat({
  label,
  value,
  valueClassName,
  accent,
  barValue,
  iconBelowLabelSrc,
  showValue = true,
}: {
  label: string;
  value?: string;
  valueClassName?: string;
  accent?: boolean;
  barValue?: number | null;
  iconBelowLabelSrc?: string | null;
  showValue?: boolean;
}) {
  const bar = barValue != null;

  return (
    <div
      className={["rounded-lg border overflow-hidden text-center aspect-square", "p-1.5", "sm:p-2.5"].join(" ")}
      style={{
        borderColor: BORDER,
        background: [
          "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.012) 55%, rgba(0,0,0,0.20))",
          `radial-gradient(240px 120px at 50% 0%, rgba(216,146,17,0.06), transparent 60%)`,
        ].join(", "),
      }}
    >
      <div className="h-full flex flex-col items-center justify-center gap-0.5 sm:gap-1">
        <div className={LABEL_CLASS}>{label}</div>

        {iconBelowLabelSrc ? (
          <div className="flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={iconBelowLabelSrc}
              alt=""
              className="w-6 h-6 sm:w-7 sm:h-7 rounded-[8px] object-cover border"
              style={{ borderColor: "rgba(255,255,255,0.10)" }}
            />
          </div>
        ) : null}

        {showValue ? (
          <div
            className={[
              "text-[11px] sm:text-xs whitespace-normal break-words leading-snug",
              valueClassName ? valueClassName : accent ? "text-[#d89211]" : "text-white",
            ].join(" ")}
          >
            {value ?? "—"}
          </div>
        ) : null}
      </div>

      {bar ? (
        <div className="mt-1.5 sm:mt-2 h-[4px] sm:h-[5px] w-full rounded-full bg-white/10 overflow-hidden">
          <div className="h-full rounded-full" style={evBarStyle(barValue)} />
        </div>
      ) : null}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div
      className="rounded-xl border p-3 sm:p-4"
      style={{
        borderColor: BORDER,
        background: "linear-gradient(180deg, rgba(255,255,255,0.03), rgba(0,0,0,0.20))",
      }}
    >
      <div className="animate-pulse space-y-3">
        <div className="h-4 w-2/3 bg-[#141414] rounded mx-auto" />
        <div className="h-3 w-1/2 bg-[#141414] rounded mx-auto" />
        <div className="grid grid-cols-4 gap-2">
          <div className="h-10 bg-[#141414] rounded" />
          <div className="h-10 bg-[#141414] rounded" />
          <div className="h-10 bg-[#141414] rounded" />
          <div className="h-10 bg-[#141414] rounded" />
        </div>
      </div>
    </div>
  );
}

function HowRow({
  icon: Icon,
  title,
  sub,
}: {
  icon: any;
  title: string;
  sub: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border px-3 py-2" style={{ borderColor: BORDER }}>
      <div
        className="w-9 h-9 rounded-lg border flex items-center justify-center shrink-0"
        style={{
          borderColor: "rgba(216,146,17,0.18)",
          background: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.12))",
        }}
      >
        <Icon className="w-4 h-4" style={{ color: GOLD }} />
      </div>
      <div className="min-w-0">
        <div className="text-sm text-white font-semibold">{title}</div>
        <div className="text-xs text-[#a7a7a7]">{sub}</div>
      </div>
    </div>
  );
}

/* =========================================================
   TOP PLAY CARD
========================================================= */

function TopPlayCard({
  kind,
  rank,
  isTop3,
  title,
  subtitle,
  score,
  ev,
  bookLogoSrc,
  odds,
  fairOdds,
  commence,
  pictureUrl,
}: {
  kind: "game" | "prop";
  rank: number;
  isTop3: boolean;
  title: string;
  subtitle: string;
  score: number | null;
  ev: number | null;
  bookLogoSrc: string | null;
  odds: number | null;
  fairOdds: number | null;
  commence: string | null;
  pictureUrl?: string | null;
}) {
  const scoreRounded = score == null ? null : Math.round(score);
  const scoreText = scoreRounded == null ? "—" : `${scoreRounded}`;
  const evText = ev == null ? "—" : `${ev.toFixed(1)}%`;
  const showFlame = scoreRounded === 100;

  return (
    <div
      className="relative overflow-hidden rounded-xl border p-3 sm:p-4"
      style={{
        borderColor: isTop3 ? "rgba(216,146,17,0.55)" : BORDER,
        boxShadow: isTop3 ? "0 0 0 1px rgba(216,146,17,0.15), 0 16px 40px rgba(0,0,0,0.35)" : undefined,
        background: [
          "linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.014) 55%, rgba(0,0,0,0.20))",
          `radial-gradient(680px 240px at 50% 0%, rgba(216,146,17,${isTop3 ? "0.18" : "0.10"}), transparent 62%)`,
          `radial-gradient(720px 260px at 85% 20%, ${SLATE}, transparent 64%)`,
          "linear-gradient(180deg, rgba(0,0,0,0.22), rgba(0,0,0,0.62) 55%, rgba(0,0,0,0.82) 100%)",
        ].join(", "),
      }}
    >
      <div className="pointer-events-none absolute left-0 right-0 top-0 h-[1px] bg-white/10" />
      {isTop3 ? (
        <div className="pointer-events-none absolute left-0 right-0 top-0 h-[2px] bg-[#d89211]/60" />
      ) : null}

      <div className="absolute top-2 left-2">
        <div
          className="text-[10px] px-2 py-0.5 rounded-full border"
          style={{
            borderColor: isTop3 ? "rgba(216,146,17,0.30)" : "rgba(255,255,255,0.10)",
            background: "rgba(0,0,0,0.35)",
            color: "rgba(255,255,255,0.78)",
          }}
        >
          #{rank}
        </div>
      </div>

      {isTop3 ? (
        <div className="absolute top-2 right-2 text-[10px] px-2 py-0.5 rounded-full border bg-black/40" style={{ borderColor: "rgba(216,146,17,0.30)", color: "#f2d08a" }}>
          🔥 Top 3
        </div>
      ) : null}

      <div className="relative space-y-2 sm:space-y-3">
        <div className="flex items-start gap-2.5 sm:gap-3">
          <div className="flex items-center gap-2 shrink-0">
            <div
              className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg border flex items-center justify-center"
              style={{
                borderColor: isTop3 ? "rgba(216,146,17,0.22)" : BORDER,
                background: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.12))",
              }}
            >
              {showFlame ? (
                <Flame className="w-4 h-4" style={{ color: GOLD }} />
              ) : (
                <Trophy
                  className={[
                    "w-4 h-4",
                    isTop3 ? "text-[#d89211]" : "text-[#9a9a9a]",
                  ].join(" ")}
                />
              )}
            </div>

            {kind === "prop" ? (
              <div
                className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg border overflow-hidden"
                style={{
                  borderColor: BORDER,
                  background: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.12))",
                }}
              >
                {pictureUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={pictureUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[10px] text-[#a7a7a7]">
                    —
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="flex-1 min-w-0 text-center">
            <div className="text-[10px] sm:text-[11px] text-[#a7a7a7]">
              {kind === "prop" ? "Player prop" : "Game"}
              {commence ? (
                <span className="hidden sm:inline">
                  {" "}
                  <span className="text-[#6f6f6f]">•</span> {commence}
                </span>
              ) : null}
            </div>

            <div className="text-[13px] sm:text-sm text-white leading-snug whitespace-normal break-words font-semibold">
              {title}
            </div>

            <div className="text-[11px] sm:text-xs text-[#c7c7c7] leading-snug sm:leading-relaxed mt-0.5 sm:mt-1 whitespace-normal break-words">
              {subtitle}
            </div>

            {commence ? (
              <div className="sm:hidden text-[10px] text-[#a7a7a7] mt-1">{commence}</div>
            ) : null}
          </div>

          <div className="shrink-0 text-right">
            <div className={LABEL_CLASS}>Score</div>
            <div className="text-[13px] sm:text-sm text-white leading-none font-bold">{scoreText}</div>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-1.5 sm:gap-2 text-xs">
          <MiniStat label="Edge" value={evText} valueClassName={evTextClass(ev)} barValue={ev} />
          <MiniStat label="Book" iconBelowLabelSrc={bookLogoSrc} showValue={false} />
          <MiniStat label="Book price" value={fmtOdds(odds)} />
          <MiniStat label="Fair price" value={fmtOdds(fairOdds)} accent />
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   SCREEN
========================================================= */

export function OverviewScreen() {
  const [loading, setLoading] = useState(true);
  const [loadingSoft, setLoadingSoft] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [latestRun, setLatestRun] = useState<MonteCarloRunRow | null>(null);
  const [latestVersion, setLatestVersion] = useState<ModelVersionRow | null>(null);
  const [changelog, setChangelog] = useState<ChangeLogRow[]>([]);

  const [evPlays, setEvPlays] = useState<EvPlayRow[]>([]);
  const [propPlays, setPropPlays] = useState<PropEvRow[]>([]);

  const [teamMapRows, setTeamMapRows] = useState<TeamMapRow[]>([]);
  const abbrevMap = useMemo(() => buildAbbrevMap(teamMapRows), [teamMapRows]);

  const [tab, setTab] = useState<PlayTab>("all");

  // ✅ Soft-book filter ONLY
  const [bookFilter, setBookFilter] = useState<SoftBookFilter>("any");
  const [search, setSearch] = useState("");

  async function loadAll({ soft }: { soft?: boolean } = {}) {
    try {
      soft ? setLoadingSoft(true) : setLoading(true);
      setError(null);

      const runQ = supabase
        .from("monte_carlo_runs")
        .select("id,created_at,sport_key")
        .order("created_at", { ascending: false })
        .limit(1);

      const versionQ = supabase
        .from("model_versions")
        .select("version,status,simulations,updated_at,release_date")
        .order("release_date", { ascending: false })
        .limit(1);

      const changelogQ = supabase
        .from("model_changelog")
        .select("version,date,changes")
        .order("date", { ascending: false })
        .limit(5);

      const evQ = supabase.from("ev_plays").select("*").order("created_at", { ascending: false }).limit(250);

      const propsQ = supabase
        .from("player_prop_ev_latest")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(250);

      const teamMapQ = supabase.from("team_map").select("canonical,abbreviation,Abbreviation").limit(5000);

      const [runRes, versionRes, changelogRes, evRes, propsRes, teamMapRes] = await Promise.all([
        runQ,
        versionQ,
        changelogQ,
        evQ,
        propsQ,
        teamMapQ,
      ]);

      if (runRes.error) throw runRes.error;
      setLatestRun((runRes.data?.[0] ?? null) as any);

      if (versionRes.error) {
        console.warn("[Overview] model_versions query failed:", versionRes.error.message);
        setLatestVersion(null);
      } else {
        setLatestVersion((versionRes.data?.[0] ?? null) as any);
      }

      if (changelogRes.error) {
        console.warn("[Overview] model_changelog query failed:", changelogRes.error.message);
        setChangelog([]);
      } else {
        setChangelog((changelogRes.data ?? []) as any);
      }

      if (evRes.error) {
        console.warn("[Overview] ev_plays query failed:", evRes.error.message);
        setEvPlays([]);
      } else {
        setEvPlays((evRes.data ?? []) as any);
      }

      if (propsRes.error) {
        console.warn("[Overview] player_prop_ev_latest query failed:", propsRes.error.message);
        setPropPlays([]);
      } else {
        setPropPlays((propsRes.data ?? []) as any);
      }

      if (teamMapRes.error) {
        console.warn("[Overview] team_map query failed:", teamMapRes.error.message);
        setTeamMapRows([]);
      } else {
        setTeamMapRows((teamMapRes.data ?? []) as any);
      }
    } catch (e: any) {
      setError(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
      setLoadingSoft(false);
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("overview-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "monte_carlo_runs" }, () =>
        loadAll({ soft: true })
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "model_versions" }, () =>
        loadAll({ soft: true })
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "model_changelog" }, () =>
        loadAll({ soft: true })
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "ev_plays" }, () => loadAll({ soft: true }))
      .on("postgres_changes", { event: "*", schema: "public", table: "player_prop_ev_latest" }, () =>
        loadAll({ soft: true })
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "team_map" }, () => loadAll({ soft: true }))
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeSport = latestRun?.sport_key ?? null;

  const evFiltered = useMemo(() => {
    return (evPlays ?? [])
      .filter((r) => (activeSport ? r.sport_key === activeSport : true))
      .filter((r) => isFutureish(r.commence_time ?? null));
  }, [evPlays, activeSport]);

  const propsFiltered = useMemo(() => {
    return (propPlays ?? [])
      .filter((r) => (activeSport ? r.sport_key === activeSport : true))
      .filter((r) => isFutureish(r.commence_time ?? null));
  }, [propPlays, activeSport]);

  // Games: odds gate + max EV gate only (no min EV)
  const topGames = useMemo(() => {
    const map = new Map<string, EvPlayRow[]>();

    for (const r of evFiltered) {
      const ev = getEvPct(r);
      const odds = getGameOdds(r);

      if (!withinOddsGate(odds)) continue;
      if (!withinMaxEvGate(ev)) continue;

      const k = keyGamePlay(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }

    const unique = Array.from(map.values()).map(pickBestGame);

    unique.sort((a, b) => {
      const sa = getGameScore(a) ?? -999;
      const sb = getGameScore(b) ?? -999;
      if (sb !== sa) return sb - sa;
      const ea = getEvPct(a) ?? -999;
      const eb = getEvPct(b) ?? -999;
      return eb - ea;
    });

    return unique.filter((r) => (getGameScore(r) ?? -999) >= TOP_SCORE_MIN);
  }, [evFiltered]);

  // Props: odds gate + EV 2..15 gate
  const topProps = useMemo(() => {
    const map = new Map<string, PropEvRow[]>();

    for (const r of propsFiltered) {
      const ev = getEvPct(r);
      const odds = getPropOdds(r);

      if (!withinOddsGate(odds)) continue;
      if (!withinPropEvRange(ev)) continue;

      const k = keyPropPlay(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }

    const unique = Array.from(map.values()).map(pickBestProp);

    unique.sort((a, b) => {
      const sa = getPropScore(a) ?? -999;
      const sb = getPropScore(b) ?? -999;
      if (sb !== sa) return sb - sa;
      const ea = getEvPct(a) ?? -999;
      const eb = getEvPct(b) ?? -999;
      return eb - ea;
    });

    return unique.filter((r) => (getPropScore(r) ?? -999) >= TOP_SCORE_MIN);
  }, [propsFiltered]);

  // Book filter applies after dedupe; only soft book choices are offered.
  const topGamesByBook = useMemo(() => {
    if (bookFilter === "any") return topGames;
    return topGames.filter((r) => softBookKey(r.bookmaker) === bookFilter);
  }, [topGames, bookFilter]);

  const topPropsByBook = useMemo(() => {
    if (bookFilter === "any") return topProps;
    return topProps.filter((r) => softBookKey(r.book ?? r.bookmaker) === bookFilter);
  }, [topProps, bookFilter]);

  const topAll = useMemo(() => {
    const merged: Array<{ kind: "game"; row: EvPlayRow } | { kind: "prop"; row: PropEvRow }> = [
      ...topGamesByBook.map((r) => ({ kind: "game" as const, row: r })),
      ...topPropsByBook.map((r) => ({ kind: "prop" as const, row: r })),
    ];

    merged.sort((a, b) => {
      const A = a.kind === "game" ? getGameScore(a.row) : getPropScore(a.row as any);
      const B = b.kind === "game" ? getGameScore(b.row as any) : getPropScore(b.row as any);
      if ((B ?? -999) !== (A ?? -999)) return (B ?? -999) - (A ?? -999);
      const ea = getEvPct(a.row as any) ?? -999;
      const eb = getEvPct(b.row as any) ?? -999;
      return eb - ea;
    });

    return merged.slice(0, 8);
  }, [topGamesByBook, topPropsByBook]);

  const playsToRender = useMemo(() => {
    if (tab === "game") {
      return topGamesByBook.slice(0, 6).map((r) => ({ kind: "game" as const, row: r }));
    }
    if (tab === "props") {
      return topPropsByBook.slice(0, 6).map((r) => ({ kind: "prop" as const, row: r }));
    }
    return topAll;
  }, [tab, topAll, topGamesByBook, topPropsByBook]);

  const searchQuery = useMemo(() => search.trim(), [search]);

  const visiblePlays = useMemo(() => {
    return playsToRender.filter((p) => {
      if (p.kind === "game") {
        const r = p.row as EvPlayRow;
        const matchupAbbrev = abbreviateMatchup(r.matchup ?? "", abbrevMap);
        const teamAbbrev = abbreviateTeamName(r.team ?? "", abbrevMap);
        return matchesSearchQuery(
          [r.matchup, matchupAbbrev, r.team, teamAbbrev],
          searchQuery
        );
      }

      const r = p.row as PropEvRow;
      const teamAbbrev = abbreviateTeamName(r.team ?? "", abbrevMap);
      const opponentAbbrev = abbreviateTeamName(r.opponent ?? "", abbrevMap);
      return matchesSearchQuery(
        [r.player_name, r.team, teamAbbrev, r.opponent, opponentAbbrev],
        searchQuery
      );
    });
  }, [playsToRender, searchQuery, abbrevMap]);

  const activeSportLabel = latestRun?.sport_key ?? "—";
  const mcRunLabel = latestRun?.created_at ? formatTsShort(latestRun.created_at) : "—";
  const modelLabel = latestVersion?.version
    ? `${latestVersion.version}${latestVersion.status ? ` • ${latestVersion.status}` : ""}`
    : "—";
  const lastUpdatedLabel = latestVersion?.updated_at
    ? formatTsShort(latestVersion.updated_at)
    : latestRun?.created_at
    ? formatTsShort(latestRun.created_at)
    : "—";

  return (
    <div className="px-3 md:px-5 py-4 md:py-6 space-y-4 md:space-y-5">
      {/* HERO */}
      <PremiumPanel>
        <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
          <div className="min-w-0 space-y-3">
            <div
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px]"
              style={{
                borderColor: "rgba(216,146,17,0.22)",
                background: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.18))",
                color: "rgba(255,255,255,0.82)",
              }}
            >
              <Sparkles className="w-3 h-3" style={{ color: GOLD }} />
              Prism Command Center
            </div>

            <div>
              <h2 className="text-[22px] md:text-[28px] font-black tracking-tight text-white">
                Command Center
              </h2>
              <p className="text-sm text-[#bdbdbd] leading-relaxed mt-2 max-w-2xl">
                A premium snapshot of live model edges, score strength, and fair pricing across the board.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => loadAll({ soft: false })}
                className="inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors"
                style={{
                  borderColor: BORDER,
                  background: "linear-gradient(180deg, rgba(255,255,255,0.05), rgba(0,0,0,0.18))",
                  color: "rgba(255,255,255,0.86)",
                }}
                title="Refresh"
              >
                <RefreshCw className={["w-4 h-4", loadingSoft ? "animate-spin" : ""].join(" ")} />
                Refresh
              </button>

              {error ? (
                <div
                  className="rounded-lg border px-3 py-2 text-xs"
                  style={{
                    borderColor: "rgba(255,255,255,0.10)",
                    background: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.18))",
                    color: "rgba(255,140,140,0.92)",
                  }}
                >
                  Supabase error: {error}
                </div>
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
            <StatTile label="Active Sport" value={activeSportLabel} />
            <StatTile label="MC Run" value={mcRunLabel} />
            <StatTile label="Model Version" value={modelLabel} />
            <StatTile label="Last Updated" value={lastUpdatedLabel} />
          </div>
        </div>
      </PremiumPanel>

      {/* STICKY CONTROLS */}
      <div
        className="sticky top-0 z-40 rounded-2xl border px-3 py-2 backdrop-blur"
        style={{ borderColor: BORDER, background: "rgba(11,11,11,0.92)" }}
      >
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented value={tab} onChange={setTab} />
            <div className="h-5 w-px bg-[#141414] hidden sm:block" />
            <div className="flex flex-wrap items-center gap-2">
              <Chip active={bookFilter === "any"} label="Any" onClick={() => setBookFilter("any")} />
              <Chip
                active={bookFilter === "draftkings"}
                label="DK"
                leftIconSrc="/books/dksquare.png"
                onClick={() => setBookFilter("draftkings")}
              />
              <Chip
                active={bookFilter === "fanduel"}
                label="FD"
                leftIconSrc="/books/fdsquare.png"
                onClick={() => setBookFilter("fanduel")}
              />
              <Chip
                active={bookFilter === "betmgm"}
                label="MGM"
                leftIconSrc="/books/mgmsquare.png"
                onClick={() => setBookFilter("betmgm")}
              />
            </div>
          </div>

          <div className="flex flex-1 flex-col sm:flex-row items-stretch gap-2">
            <div
              className="flex items-center gap-2 rounded-xl border px-3 py-2 flex-1"
              style={{ borderColor: BORDER, background: SURFACE }}
            >
              <Search className="w-4 h-4 text-[#8a8a8a]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search matchup, team, or player"
                className="bg-transparent text-sm text-white placeholder:text-[#6f6f6f] outline-none w-full"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setTab("all");
                setBookFilter("any");
              }}
              className="rounded-xl border px-3 py-2 text-xs text-[#cfcfcf] hover:text-white transition-colors"
              style={{ borderColor: BORDER, background: "rgba(255,255,255,0.02)" }}
            >
              Reset
            </button>
          </div>
        </div>
      </div>

      {/* QUICK ACTIONS */}
      <PremiumPanel>
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm text-white font-semibold">Quick Actions</div>
            <div className="text-xs text-[#a7a7a7]">Jump into core workflows.</div>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
          <QuickAction title="Odds" sub="See lines + history" icon={Database} href="/odds" />
          <QuickAction title="Projections" sub="Scores + win%" icon={Calculator} href="/monte-carlo" />
          <QuickAction title="All Plays" sub="Full list of picks" icon={Trophy} href="/model" />
        </div>
      </PremiumPanel>

      {/* TOP PLAYS */}
      <PremiumPanel>
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-4">
          <div>
            <h3 className="text-base text-white font-semibold">Top Plays</h3>
            <div className="text-xs text-[#b0b0b0]">One card per play (best book shown).</div>
          </div>

          <div
            className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px]"
            style={{
              borderColor: "rgba(216,146,17,0.26)",
              background: "rgba(0,0,0,0.35)",
              color: "rgba(255,255,255,0.78)",
            }}
            title={`Odds ${TOP_MIN_ODDS}..${TOP_MAX_ODDS} • Score ≥ ${TOP_SCORE_MIN} • Games EV ≤ ${TOP_MAX_EV_PCT}% • Props EV ${TOP_MIN_EV_PCT_PROPS}–${TOP_MAX_EV_PCT}%`}
          >
            Gates
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2 sm:gap-3">
          {loading ? (
            <>
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </>
          ) : visiblePlays.length === 0 ? (
            <div
              className="col-span-1 md:col-span-2 xl:col-span-4 rounded-xl border p-5 text-sm"
              style={{
                borderColor: "rgba(255,255,255,0.10)",
                background: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.18))",
                color: "rgba(255,255,255,0.78)",
              }}
            >
              No plays found for this filter.
            </div>
          ) : (
            visiblePlays.map((p, idx) => {
              const isTop3 = idx < 3;

              if (p.kind === "game") {
                const r = p.row as EvPlayRow;
                const bookName = normalizeBook(r.bookmaker);
                const titleShort = abbreviateMatchup(r.matchup ?? "—", abbrevMap);

                return (
                  <TopPlayCard
                    key={`game-${r.id ?? idx}`}
                    kind="game"
                    rank={idx + 1}
                    isTop3={isTop3}
                    title={titleShort}
                    subtitle={gameSubtitle(r)}
                    score={getGameScore(r)}
                    ev={getEvPct(r)}
                    bookLogoSrc={bookSquareLogoSrc(bookName)}
                    odds={getGameOdds(r)}
                    fairOdds={getGameFairOdds(r)}
                    commence={r.commence_time ? formatTsShort(r.commence_time) : null}
                  />
                );
              }

              const r = p.row as PropEvRow;
              const bookName = normalizeBook(r.book ?? r.bookmaker);

              return (
                <TopPlayCard
                  key={`prop-${r.id ?? idx}`}
                  kind="prop"
                  rank={idx + 1}
                  isTop3={isTop3}
                  title={propTitle(r, abbrevMap)}
                  subtitle={propSubtitle(r)}
                  score={getPropScore(r)}
                  ev={getEvPct(r)}
                  bookLogoSrc={bookSquareLogoSrc(bookName)}
                  odds={getPropOdds(r)}
                  fairOdds={getPropFairOdds(r)}
                  commence={r.commence_time ? formatTsShort(r.commence_time) : null}
                  pictureUrl={r.picture_url ?? null}
                />
              );
            })
          )}
        </div>
      </PremiumPanel>

      {/* HOW IT WORKS */}
      <PremiumPanel>
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm text-white font-semibold">How it works</div>
            <div className="text-xs text-[#a7a7a7]">Understand the core signals behind each play.</div>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 sm:gap-3">
          <HowRow icon={Target} title="Edge" sub="Price edge vs fair odds." />
          <HowRow icon={Activity} title="Score" sub="0–100 strength rating." />
          <HowRow icon={Calculator} title="Fair Price" sub="Model-implied value." />
        </div>
      </PremiumPanel>
    </div>
  );
}
