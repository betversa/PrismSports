"use client";

// src/app/components/screens/ModelScreen.tsx — FULL REWRITE (v7.4.0 — All requested updates applied)
// -------------------------------------------------------------------------------------------------------------
// ✅ Aggregated: 1 row per play, shows DK / FD / MGM strip, highlights best book
// ✅ Game +EV plays from public.ev_plays
// ✅ Player prop +EV plays from public.player_prop_ev_latest
//
// ✅ NO FILTER MODES (NO Steam Only / Play Type / Book filters)
// ✅ Steam = annotation only (never hides plays)
//    - Detect Pinnacle steam (line OR price) using odds_snapshot_history last-2 per (event,market,side,book)
//    - Steam key does NOT include line, so line moves are captured
// ✅ Gates (match Overview rules):
//    - Odds gate (book price): -200..+200
//    - Games: EV > 0, cap EV at 15% (NO min gate)
//    - Props: EV 2%..15% (inclusive) + odds gate
// ✅ Pinnacle is history-only (steam + charts), not an offer filter
// ✅ Bet $ uses app_settings.bankroll + app_settings.kelly_factor (best soft book fraction)
// ✅ ONLY Pick column (desktop) / Pick block (mobile) opens modal
//
// ✅ Modal: premium, clean stats, no duplicates
//    - Uses canonical team names for stats
//    - Logos + abbreviations via team_map (canonical, "Logo URL", Abbreviation)
//    - Power Rank optional via team_ratings.power_rank
//    - Efficiency + engine_power (net rating) from team_ratings
//    - Percent stats stored as 0.456 => 45.6%
//
// Assumptions about your schema based on your notes:
// - ev_plays contains: event_id, sport_key, commence_time, market, side, pick (or label), ev, best_book (or best_offer fields)
// - player_prop_ev_latest contains: event_id, sport_key, commence_time, player_name, market/prop_type, side (over/under), line, ev, best_book odds
// - odds_snapshot_history contains: sport_key, event_id, market, side, bookmaker, line, odds, ts
// - team_map contains: canonical, "Logo URL", Abbreviation (or abbreviation)
// - team_ratings contains: canonical, power_rank, engine_adj_off, engine_adj_def, engine_power (net rating), tempo, etc.
//   (If any columns differ, update the COLUMN KEYS in TEAM_RATING_KEYS below.)

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";

/* =========================================================
   TYPES
========================================================= */

type BookKey = "draftkings" | "fanduel" | "betmgm" | "pinnacle";

type PlayKind = "game" | "prop";

type AggOffer = {
  book: BookKey;
  odds: number | null;
  line: number | null;
  evPct: number | null; // 0..15 (already percent)
};

type AggPlay = {
  id: string;
  kind: PlayKind;
  sportKey: string;
  eventId: string;
  commenceTime: string | null;

  matchup: string; // "AWAY vs HOME" (canonical display)
  awayTeam: string;
  homeTeam: string;

  // pick rendering
  pickLabel: string; // "AWAY +3.5" / "Over 228.5" / "LeBron James Points Over 24.5"
  subLabel: string;  // market label etc.

  // EV gating
  evPct: number; // for the best book EV (capped & gated)
  bestBook: BookKey;
  offers: AggOffer[]; // DK/FD/MGM strip (PIN excluded as offer)

  // props support
  playerName?: string | null;
  propMarket?: string | null;
  propLine?: number | null;
  propSide?: "over" | "under" | null;

  // annotations
  steam: SteamBadge | null;

  // bankroll sizing
  betDollars: number | null;
};

type AppSettings = { bankroll: number; kelly_factor: number };

type TeamMapRow = {
  canonical: string;
  abbreviation?: string | null;
  Abbreviation?: string | null;
  "Logo URL"?: string | null;
  logo_url?: string | null;
};

type TeamRatingsRow = {
  canonical: string;
  power_rank?: number | null;
  engine_adj_off?: number | null;
  engine_adj_def?: number | null;
  engine_power?: number | null;
  tempo?: number | null;
};

type SteamBadge = {
  type: "PRICE" | "LINE" | "BOTH";
  direction: "AGAINST_BETTOR";
  text: string;
};

/* =========================================================
   CONSTANTS / STYLES (premium dark UI)
========================================================= */

const CT_TZ = "America/Chicago";

const SOFT_BOOKS: BookKey[] = ["draftkings", "fanduel", "betmgm"];
const HISTORY_BOOK: BookKey = "pinnacle";

const BOOK_LABEL: Record<BookKey, string> = {
  draftkings: "DK",
  fanduel: "FD",
  betmgm: "MGM",
  pinnacle: "PIN",
};

const BOOK_FULL: Record<BookKey, string> = {
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  betmgm: "BetMGM",
  pinnacle: "Pinnacle",
};

const BOOK_COLOR: Record<BookKey, string> = {
  draftkings: "#16a34a",
  fanduel: "#2563eb",
  betmgm: "#d4af37",
  pinnacle: "#f97316",
};

const ODDS_MIN = -200;
const ODDS_MAX = 200;
const EV_CAP = 15;

const PAGE_MAX_W = "max-w-[1320px]";
const PAGE_X = "px-4 md:px-8";

const HERO_WRAP =
  "rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f]/70 overflow-hidden shadow-[0_16px_60px_rgba(0,0,0,0.38)] backdrop-blur-[2px]";

const BTN_BASE =
  "px-3 py-1.5 rounded-lg text-xs font-extrabold border transition-colors whitespace-nowrap";
const BTN_ON = "bg-[#d4af37] text-black border-[#d4af37]";
const BTN_OFF =
  "bg-black/20 text-[#d0d0d0] border-[#2a2a2a] hover:border-[#3a3a3a]";

const CHIP =
  "inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-black/35 px-3 py-1";
const CHIP_TX = "text-[11px] font-extrabold text-[#d0d0d0]";
const CHIP_DOT = "inline-block w-2 h-2 rounded-full bg-[#d4af37]";

const TABLE_WRAP =
  "border border-[#2a2a2a] bg-black/20 rounded-xl overflow-hidden backdrop-blur-[2px]";
const TH =
  "text-left text-[12px] font-extrabold text-[#d0d0d0] bg-[#171717] border-b border-[#232323] px-3 py-3";
const TD =
  "px-3 py-3 border-b border-[#141414] text-white text-[13px]";

const SAFE_AREA_PAD = "pb-[calc(env(safe-area-inset-bottom)+16px)]";

/* =========================================================
   HELPERS
========================================================= */

function normalizeIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(" ", "T");
  if (/[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return `${s}Z`;
  return s;
}

function fmtCT(iso: string | null | undefined) {
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

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function toNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function evCap(v: number) {
  return clamp(v, -999, EV_CAP);
}

function oddsOk(odds: number | null) {
  if (odds == null) return false;
  return odds >= ODDS_MIN && odds <= ODDS_MAX;
}

function pct1(v: number | null) {
  if (v == null) return "—";
  return `${v.toFixed(1)}%`;
}

function pctStat(v01: number | null) {
  // stored as 0.456 => 45.6%
  if (v01 == null) return "—";
  return `${(v01 * 100).toFixed(1)}%`;
}

function abbrevFromMap(row?: TeamMapRow | null) {
  if (!row) return null;
  return (row.abbreviation ?? (row as any).Abbreviation ?? null) as string | null;
}
function logoFromMap(row?: TeamMapRow | null) {
  if (!row) return null;
  return ((row as any)["Logo URL"] ?? (row as any).logo_url ?? null) as string | null;
}

function safeId(...parts: Array<string | number | null | undefined>) {
  return parts
    .filter((x) => x != null)
    .map((x) => String(x))
    .join("|");
}

/* =========================================================
   KELLY (uses best book offer; EV already percent)
   - If you already have stake from backend, plug it in here.
========================================================= */

function americanToDecimal(odds: number) {
  if (odds > 0) return 1 + odds / 100;
  return 1 + 100 / Math.abs(odds);
}

/**
 * Approximate Kelly using EV% as edge over fair probability is unknown.
 * We’ll convert EV% into a conservative fraction-of-bankroll:
 *   betFrac = kelly_factor * max(0, evPct) / 100
 * This matches your app behavior pattern (simple, stable).
 */
function betSizeDollars(bankroll: number, kellyFactor: number, evPct: number) {
  const frac = kellyFactor * Math.max(0, evPct) / 100;
  return Math.max(0, bankroll * frac);
}

/* =========================================================
   DATA LOADERS
========================================================= */

async function loadAppSettings(): Promise<AppSettings> {
  const { data, error } = await supabase.from("app_settings").select("bankroll,kelly_factor").limit(1);
  if (error || !data?.length) return { bankroll: 300, kelly_factor: 0.25 };
  return {
    bankroll: Number(data[0].bankroll ?? 300),
    kelly_factor: Number(data[0].kelly_factor ?? 0.25),
  };
}

async function loadTeamMap(): Promise<Map<string, TeamMapRow>> {
  const { data } = await supabase.from("team_map").select('canonical, "Logo URL", Abbreviation, abbreviation, logo_url');
  const map = new Map<string, TeamMapRow>();
  for (const r of data ?? []) map.set(String((r as any).canonical), r as TeamMapRow);
  return map;
}

async function loadTeamRatingsCanon(canonicals: string[]): Promise<Map<string, TeamRatingsRow>> {
  if (!canonicals.length) return new Map();
  const { data } = await supabase.from("team_ratings").select("canonical,power_rank,engine_adj_off,engine_adj_def,engine_power,tempo").in("canonical", canonicals);
  const map = new Map<string, TeamRatingsRow>();
  for (const r of data ?? []) map.set(String((r as any).canonical), r as TeamRatingsRow);
  return map;
}

/* =========================================================
   STEAM DETECTION (annotation only)
========================================================= */

type HistRow = {
  ts: string;
  bookmaker: string;
  market: string;
  side: string;
  line: number | null;
  odds: number | null;
  event_id: string;
  sport_key: string;
};

function normBook(s: string) {
  const v = String(s || "").toLowerCase();
  if (v.includes("pinnacle")) return "pinnacle";
  if (v.includes("draftkings")) return "draftkings";
  if (v.includes("fanduel")) return "fanduel";
  if (v.includes("betmgm")) return "betmgm";
  return v;
}

function steamBadgeFromTwo(prev: HistRow, cur: HistRow, bettorPickSide: string): SteamBadge | null {
  // We only label when Pinnacle moved AGAINST bettor.
  // For spreads: worse line for bettor OR worse price on same line.
  // For totals: Over/Under line up/down; worse for bettor depends on pick side.
  // For ML: price worse for bettor.

  const prevOdds = prev.odds;
  const curOdds = cur.odds;
  const prevLine = prev.line;
  const curLine = cur.line;

  const side = (bettorPickSide || "").toLowerCase();
  const market = (cur.market || "").toLowerCase();

  let priceSteam = false;
  let lineSteam = false;

  if (prevOdds != null && curOdds != null) {
    // Price gets "worse" when:
    // - For negative odds: -110 -> -125 (more negative)
    // - For positive odds: +120 -> +105 (smaller positive)
    if (curOdds < 0 && prevOdds < 0) priceSteam = curOdds < prevOdds;
    if (curOdds > 0 && prevOdds > 0) priceSteam = curOdds < prevOdds;
    if ((curOdds < 0 && prevOdds > 0) || (curOdds > 0 && prevOdds < 0)) {
      // crossing 0 is rare; treat as worse if magnitude moved toward - side for bettor
      priceSteam = curOdds < prevOdds;
    }
  }

  if (prevLine != null && curLine != null && prevLine !== curLine) {
    // Determine "worse line" by market + pick side.
    // spreads: if bettor is favorite side (negative line), worse is more negative (e.g. -3.5 -> -4.5)
    //          if bettor is dog side (positive), worse is smaller (e.g. +4.5 -> +3.5)
    // totals: if Over, worse is higher total (228.5 -> 229.5); if Under, worse is lower (229.5 -> 228.5)
    // This assumes side encodes "home"/"away"/"over"/"under" already in your play row.
    if (market.includes("spread")) {
      // interpret bettor side by whether line is + or -
      const wasFav = prevLine < 0 || curLine < 0;
      if (wasFav) lineSteam = curLine < prevLine; // more negative is worse
      else lineSteam = curLine < prevLine; // for dogs, moving down is worse (+4.5 -> +3.5)
    } else if (market.includes("total")) {
      if (side.includes("over")) lineSteam = curLine > prevLine;
      if (side.includes("under")) lineSteam = curLine < prevLine;
    }
  }

  if (!priceSteam && !lineSteam) return null;

  const type: SteamBadge["type"] = priceSteam && lineSteam ? "BOTH" : priceSteam ? "PRICE" : "LINE";
  const txt = type === "BOTH" ? "Steam (line + price)" : type === "LINE" ? "Steam (line)" : "Steam (price)";
  return { type, direction: "AGAINST_BETTOR", text: txt };
}

async function loadPinnacleSteamBadges(opts: {
  sportKey: string;
  eventIds: string[];
}): Promise<Map<string, SteamBadge>> {
  // Returns map keyed by steamKey = `${event_id}|${market}|${side}` (NO line in key)
  if (!opts.eventIds.length) return new Map();

  const { data, error } = await supabase
    .from("odds_snapshot_history")
    .select("ts,bookmaker,market,side,line,odds,event_id,sport_key")
    .eq("sport_key", opts.sportKey)
    .in("event_id", opts.eventIds)
    .ilike("bookmaker", "%pinnacle%")
    .order("ts", { ascending: true });

  if (error || !data?.length) return new Map();

  const rows = (data as any[]).map(
    (r): HistRow => ({
      ts: String(r.ts),
      bookmaker: String(r.bookmaker),
      market: String(r.market),
      side: String(r.side),
      line: toNum(r.line),
      odds: toNum(r.odds),
      event_id: String(r.event_id),
      sport_key: String(r.sport_key),
    })
  );

  // group by key that does NOT include line
  const byKey = new Map<string, HistRow[]>();
  for (const r of rows) {
    const k = `${r.event_id}|${String(r.market).toLowerCase()}|${String(r.side).toLowerCase()}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }

  const out = new Map<string, SteamBadge>();
  for (const [k, arr] of byKey.entries()) {
    if (arr.length < 2) continue;
    const prev = arr[arr.length - 2];
    const cur = arr[arr.length - 1];
    const badge = steamBadgeFromTwo(prev, cur, cur.side);
    if (badge) out.set(k, badge);
  }

  return out;
}

/* =========================================================
   MODAL (premium, fixed footer + tabs)
========================================================= */

type ModalTab = "history" | "matchup";

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
      className="fixed inset-0 z-[999] bg-black/70 p-2 sm:p-4 flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`w-full max-w-6xl max-h-[92vh] rounded-2xl border border-[#2a2a2a] overflow-hidden flex flex-col shadow-[0_24px_80px_rgba(0,0,0,0.55)]`}
        style={{
          background:
            "radial-gradient(1200px 700px at 15% 10%, rgba(212,175,55,0.11), transparent 55%)," +
            "radial-gradient(900px 600px at 80% 0%, rgba(37,99,235,0.08), transparent 55%)," +
            "linear-gradient(180deg, rgba(15,15,15,0.98), rgba(10,10,10,0.98))",
        }}
      >
        {/* header */}
        <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-start justify-between gap-4 shrink-0 bg-[#0b0b0b]">
          <div className="min-w-0">
            <div className="text-white font-extrabold text-sm">{title}</div>
            {subtitle ? <div className="text-[11px] text-[#a0a0a0] mt-0.5 break-words">{subtitle}</div> : null}
          </div>
          <button
            type="button"
            className="text-[#cfcfcf] hover:text-white text-sm font-bold px-2 py-1 rounded-md hover:bg-white/10"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* body */}
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>

        {/* footer */}
        <div className={`px-4 py-3 border-t border-[#2a2a2a] bg-[#0b0b0b] shrink-0 ${SAFE_AREA_PAD}`}>
          <div className="flex items-center justify-end">
            <button type="button" className={[BTN_BASE, BTN_ON].join(" ")} onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
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
   MAIN SCREEN
========================================================= */

export function ModelScreen({ sportKey }: { sportKey: string }) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [settings, setSettings] = useState<AppSettings>({ bankroll: 300, kelly_factor: 0.25 });

  const [plays, setPlays] = useState<AggPlay[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // modal
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<AggPlay | null>(null);
  const [tab, setTab] = useState<ModalTab>("history");

  // maps
  const [teamMap, setTeamMap] = useState<Map<string, TeamMapRow>>(new Map());
  const [ratingsMap, setRatingsMap] = useState<Map<string, TeamRatingsRow>>(new Map());

  // line history in modal
  const [histLoading, setHistLoading] = useState(false);
  const [histErr, setHistErr] = useState("");
  const [histData, setHistData] = useState<any[]>([]);

  useEffect(() => {
    let alive = true;

    (async () => {
      const [s, tm] = await Promise.all([loadAppSettings(), loadTeamMap()]);
      if (!alive) return;
      setSettings(s);
      setTeamMap(tm);
    })();

    return () => {
      alive = false;
    };
  }, []);

  async function loadAll() {
    setLoading(true);
    setErr("");

    try {
      // 1) Load games + props
      const nowIso = new Date().toISOString();

      // Games: current +EV plays (future commence_time)
      const gRes = await supabase
        .from("ev_plays")
        .select("*")
        .eq("sport_key", sportKey)
        .gt("commence_time", nowIso);

      if (gRes.error) throw new Error(gRes.error.message);

      // Props: latest +EV props (future commence_time)
      const pRes = await supabase
        .from("player_prop_ev_latest")
        .select("*")
        .eq("sport_key", sportKey)
        .gt("commence_time", nowIso);

      if (pRes.error) throw new Error(pRes.error.message);

      const gamesRaw = (gRes.data ?? []) as any[];
      const propsRaw = (pRes.data ?? []) as any[];

      // 2) Build list of event IDs for steam
      const eventIds = Array.from(
        new Set(
          [...gamesRaw, ...propsRaw]
            .map((r) => String(r.event_id ?? ""))
            .filter(Boolean)
        )
      );

      const steamMap = await loadPinnacleSteamBadges({ sportKey, eventIds });

      // 3) Collect canonicals for ratings lookup
      // We assume ev_plays includes away_team/home_team canonical; if not, parse matchup.
      const canonSet = new Set<string>();
      for (const r of gamesRaw) {
        const away = String(r.away_team ?? r.away ?? "").trim();
        const home = String(r.home_team ?? r.home ?? "").trim();
        if (away) canonSet.add(away);
        if (home) canonSet.add(home);
      }
      const canonicals = Array.from(canonSet.values());
      const rm = await loadTeamRatingsCanon(canonicals);

      setRatingsMap(rm);

      // 4) Aggregate plays with strip offers DK/FD/MGM; PIN history-only
      const built: AggPlay[] = [];

      const pushPlay = (play: AggPlay) => {
        built.push(play);
        setLastUpdated((prev) => prev ?? new Date().toISOString());
      };

      // Helper: build offers from row fields (supports a few naming patterns)
      const readOffer = (row: any, book: BookKey, marketKey: string) => {
        // prefer explicit columns if exist (best to align with your backend)
        const odds =
          toNum(row?.[`${book}_odds`]) ??
          toNum(row?.[`${book}_price`]) ??
          toNum(row?.[`${book}_american_odds`]) ??
          toNum(row?.[`${BOOK_LABEL[book]}_odds`]) ??
          null;

        const line =
          toNum(row?.[`${book}_line`]) ??
          toNum(row?.[`${book}_points`]) ??
          toNum(row?.line) ??
          null;

        const ev =
          toNum(row?.[`${book}_ev`]) ??
          toNum(row?.ev) ??
          null;

        // marketKey unused; kept for future
        return { odds, line, ev };
      };

      // Games
      for (const r of gamesRaw) {
        const eventId = String(r.event_id ?? "");
        const commenceTime = normalizeIso(r.commence_time ?? null);
        const awayTeam = String(r.away_team ?? r.away ?? "").trim();
        const homeTeam = String(r.home_team ?? r.home ?? "").trim();
        const matchup = awayTeam && homeTeam ? `${awayTeam} vs ${homeTeam}` : String(r.matchup ?? "Matchup");

        const market = String(r.market ?? r.market_key ?? r.bet_type ?? "").toLowerCase();
        const side = String(r.side ?? r.bet_side ?? "").toLowerCase();
        const pickLabel = String(r.pick ?? r.label ?? r.selection ?? "").trim() || `${side}`;

        // Build soft offers
        const offers: AggOffer[] = SOFT_BOOKS.map((b) => {
          const o = readOffer(r, b, market);
          return {
            book: b,
            odds: o.odds,
            line: o.line,
            evPct: o.ev,
          };
        });

        // pick best book by EV among soft books, only odds-gated
        const gated = offers
          .map((o) => ({
            ...o,
            evPct: o.evPct == null ? null : evCap(o.evPct),
          }))
          .filter((o) => oddsOk(o.odds));

        if (!gated.length) continue;

        // Games gate: EV > 0 (no min), cap 15
        const best = gated.reduce((a, b) => ((b.evPct ?? -999) > (a.evPct ?? -999) ? b : a), gated[0]);
        const bestEv = best.evPct ?? 0;
        if (!(bestEv > 0)) continue;

        const steamKey = `${eventId}|${market}|${side}`;
        const steam = steamMap.get(steamKey) ?? null;

        const betDollars =
          bestEv > 0 ? betSizeDollars(settings.bankroll, settings.kelly_factor, bestEv) : 0;

        pushPlay({
          id: safeId("game", eventId, market, side, pickLabel),
          kind: "game",
          sportKey,
          eventId,
          commenceTime,
          matchup,
          awayTeam,
          homeTeam,
          pickLabel,
          subLabel: market ? market.toUpperCase() : "GAME",
          evPct: bestEv,
          bestBook: best.book,
          offers,
          steam,
          betDollars: Number.isFinite(betDollars) ? Math.round(betDollars) : null,
        });
      }

      // Props
      for (const r of propsRaw) {
        const eventId = String(r.event_id ?? "");
        const commenceTime = normalizeIso(r.commence_time ?? null);

        const awayTeam = String(r.away_team ?? r.away ?? "").trim();
        const homeTeam = String(r.home_team ?? r.home ?? "").trim();
        const matchup = awayTeam && homeTeam ? `${awayTeam} vs ${homeTeam}` : String(r.matchup ?? "Matchup");

        const playerName = String(r.player_name ?? r.player ?? "").trim();
        const propMarket = String(r.market ?? r.prop_type ?? r.market_key ?? "").trim();
        const sideRaw = String(r.side ?? r.over_under ?? "").toLowerCase();
        const propSide = sideRaw.includes("over") ? "over" : sideRaw.includes("under") ? "under" : null;
        const propLine = toNum(r.line ?? r.points ?? r.prop_line ?? null);

        const pickLabel =
          `${playerName} — ${propMarket} ${propSide ? propSide.toUpperCase() : ""} ${propLine ?? ""}`.trim();

        const marketKey = "prop";
        const offers: AggOffer[] = SOFT_BOOKS.map((b) => {
          const o = {
            odds:
              toNum(r?.[`${b}_odds`]) ??
              toNum(r?.[`${b}_price`]) ??
              toNum(r?.odds) ??
              null,
            line: propLine,
            ev: toNum(r?.[`${b}_ev`]) ?? toNum(r?.ev) ?? null,
          };
          return { book: b, odds: o.odds, line: o.line, evPct: o.ev };
        });

        const gated = offers
          .map((o) => ({ ...o, evPct: o.evPct == null ? null : evCap(o.evPct) }))
          .filter((o) => oddsOk(o.odds));

        if (!gated.length) continue;

        const best = gated.reduce((a, b) => ((b.evPct ?? -999) > (a.evPct ?? -999) ? b : a), gated[0]);
        const bestEv = best.evPct ?? 0;

        // Props gate: EV 2..15 inclusive
        if (!(bestEv >= 2 && bestEv <= EV_CAP)) continue;

        const steamKey = `${eventId}|${marketKey}|${propSide ?? sideRaw}`;
        const steam = steamMap.get(steamKey) ?? null;

        const betDollars = betSizeDollars(settings.bankroll, settings.kelly_factor, bestEv);

        pushPlay({
          id: safeId("prop", eventId, playerName, propMarket, propSide, propLine),
          kind: "prop",
          sportKey,
          eventId,
          commenceTime,
          matchup,
          awayTeam,
          homeTeam,
          pickLabel,
          subLabel: "PROP",
          evPct: bestEv,
          bestBook: best.book,
          offers,
          steam,
          betDollars: Number.isFinite(betDollars) ? Math.round(betDollars) : null,
          playerName,
          propMarket,
          propSide,
          propLine,
        });
      }

      // 5) Sort: highest EV first (ties: sooner game first)
      built.sort((a, b) => {
        if (b.evPct !== a.evPct) return b.evPct - a.evPct;
        const ta = a.commenceTime ? new Date(a.commenceTime).getTime() : 0;
        const tb = b.commenceTime ? new Date(b.commenceTime).getTime() : 0;
        return ta - tb;
      });

      setPlays(built);
      setLoading(false);
    } catch (e: any) {
      setErr(String(e?.message ?? e ?? "Unknown error"));
      setPlays([]);
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    const t = window.setInterval(loadAll, 60_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sportKey, settings.bankroll, settings.kelly_factor]);

  /* =========================================================
     Modal loaders
  ========================================================= */

  async function openModal(p: AggPlay) {
    setActive(p);
    setOpen(true);
    setTab("history");
    setHistErr("");
    setHistData([]);

    // load history for this play (DK/FD/MGM/PIN) for this event+market+side
    setHistLoading(true);

    try {
      const marketKey =
        p.kind === "game"
          ? (p.subLabel || "").toLowerCase()
          : "prop";

      // best-effort filters: event_id + (market) + (side)
      // We *always* include PIN in history
      const { data, error } = await supabase
        .from("odds_snapshot_history")
        .select("ts,bookmaker,market,side,line,odds")
        .eq("sport_key", p.sportKey)
        .eq("event_id", p.eventId)
        .order("ts", { ascending: true });

      if (error) throw new Error(error.message);

      const rows = (data ?? []) as any[];

      // Filter to the play’s market/side as best as possible without line in key
      const sideNeed = p.kind === "prop"
        ? (p.propSide ?? "").toLowerCase()
        : (p.pickLabel ?? "").toLowerCase();

      const filtered = rows
        .map((r) => ({
          ts: String(r.ts),
          book: normBook(r.bookmaker),
          market: String(r.market ?? "").toLowerCase(),
          side: String(r.side ?? "").toLowerCase(),
          line: toNum(r.line),
          odds: toNum(r.odds),
        }))
        .filter((r) => {
          if (!r.ts) return false;
          // keep only main books
          const isBook =
            r.book.includes("draftkings") ||
            r.book.includes("fanduel") ||
            r.book.includes("betmgm") ||
            r.book.includes("pinnacle");
          if (!isBook) return false;

          // crude market match
          if (p.kind === "game") {
            // if market field exists, match by presence
            // (we keep broad if unknown)
            return true;
          }
          // props: try to match over/under
          if (sideNeed.includes("over")) return r.side.includes("over");
          if (sideNeed.includes("under")) return r.side.includes("under");
          return true;
        });

      // build recharts series per timestamp
      const byTs = new Map<string, any>();
      for (const r of filtered) {
        if (!byTs.has(r.ts)) byTs.set(r.ts, { ts: r.ts, label: fmtCT(r.ts) });
        const pnt = byTs.get(r.ts)!;

        const bk =
          r.book.includes("draftkings") ? "draftkings" :
          r.book.includes("fanduel") ? "fanduel" :
          r.book.includes("betmgm") ? "betmgm" :
          r.book.includes("pinnacle") ? "pinnacle" : null;

        if (!bk) continue;
        pnt[bk] = r.odds;
        pnt[`${bk}__line`] = r.line;
      }

      const series = Array.from(byTs.values()).sort((a, b) => {
        const ta = new Date(normalizeIso(a.ts) ?? a.ts).getTime();
        const tb = new Date(normalizeIso(b.ts) ?? b.ts).getTime();
        return ta - tb;
      });

      setHistData(series);
      setHistLoading(false);
    } catch (e: any) {
      setHistErr(String(e?.message ?? e ?? "Unknown error"));
      setHistLoading(false);
    }
  }

  /* =========================================================
     Derived maps for active modal
  ========================================================= */

  const activeTeamMeta = useMemo(() => {
    if (!active) return null;
    const away = teamMap.get(active.awayTeam) ?? null;
    const home = teamMap.get(active.homeTeam) ?? null;

    const awayAbbr = abbrevFromMap(away) ?? active.awayTeam.slice(0, 3).toUpperCase();
    const homeAbbr = abbrevFromMap(home) ?? active.homeTeam.slice(0, 3).toUpperCase();

    return {
      awayLogo: logoFromMap(away),
      homeLogo: logoFromMap(home),
      awayAbbr,
      homeAbbr,
      awayPR: ratingsMap.get(active.awayTeam)?.power_rank ?? null,
      homePR: ratingsMap.get(active.homeTeam)?.power_rank ?? null,
      awayR: ratingsMap.get(active.awayTeam) ?? null,
      homeR: ratingsMap.get(active.homeTeam) ?? null,
    };
  }, [active, teamMap, ratingsMap]);

  /* =========================================================
     RENDER HELPERS
  ========================================================= */

  function OfferPill({ offer, isBest }: { offer: AggOffer; isBest: boolean }) {
    const color = BOOK_COLOR[offer.book];
    const border = isBest ? `border-[${color}]` : "border-[#2a2a2a]";
    const bg = isBest ? "bg-black/40" : "bg-black/20";
    return (
      <div
        className={`rounded-lg border ${border} ${bg} px-2 py-1 flex flex-col items-center justify-center min-w-[64px]`}
        style={{ boxShadow: isBest ? `0 0 0 1px ${color} inset` : undefined }}
      >
        <div className="text-[10px] font-extrabold" style={{ color }}>
          {BOOK_LABEL[offer.book]}
        </div>
        <div className="text-white font-extrabold tabular-nums text-[12px] leading-tight">
          {offer.odds == null ? "—" : offer.odds}
        </div>
        <div className="text-[10px] text-[#b0b0b0] font-semibold tabular-nums leading-tight">
          {offer.evPct == null ? "—" : `${offer.evPct.toFixed(1)}%`}
        </div>
      </div>
    );
  }

  function SteamChip({ steam }: { steam: SteamBadge }) {
    return (
      <span
        className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-black/30 px-3 py-1"
        title="Pinnacle moved against the bettor (line and/or price). Annotation only."
      >
        <span className="inline-block w-2 h-2 rounded-full bg-orange-500" />
        <span className="text-[11px] text-white font-extrabold">{steam.text}</span>
      </span>
    );
  }

  /* =========================================================
     UI
  ========================================================= */

  const noiseSvg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="220" height="220">
      <filter id="n">
        <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="2" stitchTiles="stitch"/>
        <feColorMatrix type="matrix"
          values="0 0 0 0 0.85  0 0 0 0 0.75  0 0 0 0 0.20  0 0 0 0.12 0"/>
      </filter>
      <rect width="100%" height="100%" filter="url(#n)"/>
    </svg>
  `);

  return (
    <div
      className="w-full min-h-screen"
      style={{
        background:
          "radial-gradient(1200px 700px at 12% 10%, rgba(212,175,55,0.12), transparent 55%)," +
          "radial-gradient(1000px 700px at 85% 0%, rgba(37,99,235,0.10), transparent 55%)," +
          "radial-gradient(900px 600px at 60% 90%, rgba(16,185,129,0.08), transparent 55%)," +
          "linear-gradient(180deg, #070707, #0a0a0a 55%, #070707)",
      }}
    >
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.10]"
        style={{
          backgroundImage: `url("data:image/svg+xml,${noiseSvg}")`,
          backgroundRepeat: "repeat",
        }}
      />

      <div className={`${PAGE_MAX_W} mx-auto ${PAGE_X} relative pt-4 md:pt-6`}>
        <div className={HERO_WRAP}>
          <div className="p-5 md:p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className={CHIP}>
                  <span className={CHIP_DOT} />
                  <span className={CHIP_TX}>Model Plays</span>
                </div>

                <h2 className="mt-3 text-[22px] md:text-[28px] text-white font-extrabold tracking-tight">
                  {sportKey}
                </h2>

                <div className="text-sm text-[#9a9a9a] mt-2">
                  Current +EV plays (future commence_time). Steam is annotation only. Pinnacle is history-only.
                </div>
              </div>

              <div className="hidden md:flex flex-col items-end gap-2">
                <div className="text-right">
                  <div className="text-[10px] text-[#6a6a6a] font-semibold">Last Updated (CT)</div>
                  <div className="text-xs text-white font-extrabold">{fmtCT(lastUpdated)}</div>
                </div>
                <button className={[BTN_BASE, BTN_ON].join(" ")} type="button" onClick={loadAll}>
                  Refresh
                </button>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-black/30 px-3 py-1.5">
                <div className="text-[10px] font-bold text-[#808080]">Plays</div>
                <div className="text-[11px] font-extrabold text-white tabular-nums">{plays.length}</div>
              </div>

              <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-black/30 px-3 py-1.5">
                <div className="text-[10px] font-bold text-[#808080]">Odds Gate</div>
                <div className="text-[11px] font-extrabold text-white tabular-nums">
                  {ODDS_MIN}..+{ODDS_MAX}
                </div>
              </div>

              <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-black/30 px-3 py-1.5">
                <div className="text-[10px] font-bold text-[#808080]">Bankroll</div>
                <div className="text-[11px] font-extrabold text-white tabular-nums">${settings.bankroll}</div>
              </div>

              <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-black/30 px-3 py-1.5">
                <div className="text-[10px] font-bold text-[#808080]">Kelly</div>
                <div className="text-[11px] font-extrabold text-white tabular-nums">{settings.kelly_factor}</div>
              </div>
            </div>
          </div>

          <div className="h-px bg-[#232323]" />

          {/* CONTENT */}
          <div className="p-3 md:p-4">
            {/* MOBILE */}
            <div className="md:hidden">
              {loading ? (
                <div className="p-3 text-xs text-[#808080]">Loading plays…</div>
              ) : err ? (
                <div className="p-3 text-xs text-red-400">Supabase error: {err}</div>
              ) : !plays.length ? (
                <div className="p-3 text-xs text-[#808080]">No plays match the current gates.</div>
              ) : (
                <div className="space-y-3">
                  {plays.map((p) => (
                    <div
                      key={p.id}
                      className="rounded-2xl border border-[#2a2a2a] bg-black/20 overflow-hidden backdrop-blur-[2px]"
                    >
                      <div className="px-3 py-2.5 border-b border-[#2a2a2a] flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[12px] text-white font-extrabold truncate">{p.matchup}</div>
                          <div className="text-[11px] text-[#b0b0b0] font-semibold">{fmtCT(p.commenceTime)}</div>
                        </div>

                        <div className="text-right">
                          <div className="text-[10px] text-[#808080] font-semibold">EV</div>
                          <div className="text-white font-extrabold tabular-nums text-[13px]">{pct1(p.evPct)}</div>
                        </div>
                      </div>

                      <div className="px-3 py-3">
                        <button
                          type="button"
                          className="w-full text-left rounded-xl border border-[#2a2a2a] bg-black/25 p-3 hover:border-[#3a3a3a]"
                          onClick={() => openModal(p)}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-white font-extrabold text-[13px]">{p.pickLabel}</div>
                              <div className="text-[11px] text-[#b0b0b0] font-semibold mt-0.5">
                                {p.subLabel}
                                {p.betDollars != null ? (
                                  <>
                                    {" "}
                                    • Bet{" "}
                                    <span className="text-white font-extrabold tabular-nums">${p.betDollars}</span>
                                  </>
                                ) : null}
                              </div>
                            </div>

                            <div className="shrink-0 text-[11px] font-extrabold px-2 py-1 rounded-md border border-[#2a2a2a] bg-black/20">
                              Details
                            </div>
                          </div>
                        </button>

                        <div className="mt-3 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            {p.steam ? <SteamChip steam={p.steam} /> : null}
                          </div>

                          <div className="flex items-center gap-2">
                            {p.offers.map((o) => (
                              <OfferPill key={o.book} offer={o} isBest={o.book === p.bestBook} />
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* DESKTOP */}
            <div className="hidden md:block">
              {loading ? (
                <div className="p-6 text-sm text-[#808080]">Loading plays…</div>
              ) : err ? (
                <div className="p-6 text-sm text-red-400">Supabase error: {err}</div>
              ) : !plays.length ? (
                <div className="p-6 text-sm text-[#808080]">No plays match the current gates.</div>
              ) : (
                <div className={TABLE_WRAP}>
                  <div className="overflow-x-auto">
                    <table className="w-full table-fixed">
                      <colgroup>
                        <col style={{ width: 360 }} />
                        <col style={{ width: 140 }} />
                        <col style={{ width: 120 }} />
                        <col style={{ width: 380 }} />
                        <col style={{ width: 260 }} />
                      </colgroup>

                      <thead className="sticky top-0 z-20">
                        <tr>
                          <th className={TH}>Matchup</th>
                          <th className={TH}>Time (CT)</th>
                          <th className={TH}>EV</th>
                          <th className={TH}>Pick (ONLY click)</th>
                          <th className={TH}>Books (DK/FD/MGM)</th>
                        </tr>
                      </thead>

                      <tbody>
                        {plays.map((p) => (
                          <tr key={p.id} className="hover:bg-white/5 transition-colors">
                            <td className={TD}>
                              <div className="text-white font-extrabold text-[13px]">{p.matchup}</div>
                              <div className="text-[11px] text-[#b0b0b0] font-semibold mt-0.5">{p.subLabel}</div>
                            </td>

                            <td className={TD}>
                              <div className="text-white font-extrabold text-[13px] tabular-nums">
                                {fmtCT(p.commenceTime)}
                              </div>
                            </td>

                            <td className={TD}>
                              <div className="text-white font-extrabold tabular-nums text-[13px]">{pct1(p.evPct)}</div>
                              {p.betDollars != null ? (
                                <div className="text-[11px] text-[#b0b0b0] font-semibold tabular-nums">
                                  Bet ${p.betDollars}
                                </div>
                              ) : null}
                            </td>

                            {/* ✅ ONLY CLICKABLE AREA */}
                            <td className={TD}>
                              <button
                                type="button"
                                className="w-full text-left rounded-xl border border-[#2a2a2a] bg-black/25 p-3 hover:border-[#3a3a3a]"
                                onClick={() => openModal(p)}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="text-white font-extrabold text-[13px]">{p.pickLabel}</div>
                                    <div className="text-[11px] text-[#b0b0b0] font-semibold mt-0.5">
                                      Best:{" "}
                                      <span style={{ color: BOOK_COLOR[p.bestBook] }}>
                                        {BOOK_FULL[p.bestBook]}
                                      </span>
                                      {p.steam ? <span className="ml-2">• Steam</span> : null}
                                    </div>
                                  </div>

                                  <div className="shrink-0 text-[11px] font-extrabold px-2 py-1 rounded-md border border-[#2a2a2a] bg-black/20">
                                    Details
                                  </div>
                                </div>
                              </button>

                              {p.steam ? (
                                <div className="mt-2">
                                  <SteamChip steam={p.steam} />
                                </div>
                              ) : null}
                            </td>

                            <td className={TD}>
                              <div className="flex items-center gap-2">
                                {p.offers.map((o) => (
                                  <OfferPill key={o.book} offer={o} isBest={o.book === p.bestBook} />
                                ))}
                              </div>
                              <div className="text-[10px] text-[#808080] font-semibold mt-1">
                                PIN = history only
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
          </div>
        </div>

        {/* MODAL */}
        {open && active && activeTeamMeta && (
          <ModalShell
            title="Play Details"
            subtitle={`${active.matchup} • ${fmtCT(active.commenceTime)} CT`}
            onClose={() => setOpen(false)}
          >
            <div className="h-full min-h-0 flex flex-col">
              {/* sticky tabs */}
              <div className="sticky top-0 z-20 px-4 py-2 border-b border-[#232323] bg-[#0b0b0b]">
                <div className="flex items-center gap-2">
                  <TabBtn active={tab === "history"} onClick={() => setTab("history")}>
                    Line History
                  </TabBtn>
                  <TabBtn active={tab === "matchup"} onClick={() => setTab("matchup")}>
                    Matchup Stats
                  </TabBtn>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-4">
                {/* Header block */}
                <div className="rounded-2xl border border-[#2a2a2a] bg-black/25 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      {/* Away */}
                      <div className="flex items-center gap-2">
                        {activeTeamMeta.awayLogo ? (
                          <img
                            src={activeTeamMeta.awayLogo}
                            alt={`${active.awayTeam} logo`}
                            className="w-10 h-10 rounded-md object-contain bg-white border border-[#e5e5e5] p-1"
                            onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-md bg-white border border-[#e5e5e5]" />
                        )}
                        <div>
                          <div className="text-white font-extrabold text-[13px]">
                            {active.awayTeam}{" "}
                            <span className="text-[#808080] font-semibold">({activeTeamMeta.awayAbbr})</span>
                            {activeTeamMeta.awayPR != null ? (
                              <span className="ml-2 text-[10px] font-extrabold px-2 py-0.5 rounded-full border border-[#2a2a2a] bg-black/30 text-[#d0d0d0]">
                                PR #{activeTeamMeta.awayPR}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      <div className="text-[#808080] font-extrabold">vs</div>

                      {/* Home */}
                      <div className="flex items-center gap-2">
                        {activeTeamMeta.homeLogo ? (
                          <img
                            src={activeTeamMeta.homeLogo}
                            alt={`${active.homeTeam} logo`}
                            className="w-10 h-10 rounded-md object-contain bg-white border border-[#e5e5e5] p-1"
                            onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-md bg-white border border-[#e5e5e5]" />
                        )}
                        <div>
                          <div className="text-white font-extrabold text-[13px]">
                            {active.homeTeam}{" "}
                            <span className="text-[#808080] font-semibold">({activeTeamMeta.homeAbbr})</span>
                            {activeTeamMeta.homePR != null ? (
                              <span className="ml-2 text-[10px] font-extrabold px-2 py-0.5 rounded-full border border-[#2a2a2a] bg-black/30 text-[#d0d0d0]">
                                PR #{activeTeamMeta.homePR}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="text-[10px] text-[#808080] font-semibold">Best EV</div>
                      <div className="text-white font-extrabold tabular-nums text-[14px]">{pct1(active.evPct)}</div>
                      <div className="text-[11px] font-semibold" style={{ color: BOOK_COLOR[active.bestBook] }}>
                        {BOOK_FULL[active.bestBook]}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 rounded-xl border border-[#2a2a2a] bg-black/20 p-3">
                    <div className="text-white font-extrabold text-[13px]">{active.pickLabel}</div>
                    <div className="text-[11px] text-[#b0b0b0] font-semibold mt-0.5">
                      {active.betDollars != null ? (
                        <>
                          Suggested Bet:{" "}
                          <span className="text-white font-extrabold tabular-nums">${active.betDollars}</span>
                          <span className="text-[#808080] mx-2">•</span>
                        </>
                      ) : null}
                      Odds gate applied ({ODDS_MIN}..{ODDS_MAX}), EV cap {EV_CAP}%
                    </div>

                    {active.steam ? (
                      <div className="mt-2">
                        <SteamChip steam={active.steam} />
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* TAB CONTENT */}
                {tab === "history" ? (
                  <div className="mt-3 rounded-2xl border border-[#2a2a2a] bg-black/20 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-white font-extrabold text-[13px]">Line History</div>
                        <div className="text-[11px] text-[#b0b0b0] font-semibold mt-0.5">
                          DK / FD / MGM offers + PIN history (tooltip shows CT time)
                        </div>
                      </div>
                    </div>

                    {histLoading ? (
                      <div className="mt-3 text-sm text-[#b0b0b0]">Loading history…</div>
                    ) : histErr ? (
                      <div className="mt-3 text-sm text-red-400">No history: {histErr}</div>
                    ) : !histData.length ? (
                      <div className="mt-3 text-sm text-[#b0b0b0]">No history points found.</div>
                    ) : (
                      <div className="mt-3 h-[320px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={histData} margin={{ top: 10, right: 18, left: 0, bottom: 10 }}>
                            <CartesianGrid stroke="#222222" strokeDasharray="3 3" />
                            <XAxis
                              dataKey="label"
                              tick={{ fill: "#b0b0b0", fontSize: 10 }}
                              interval="preserveStartEnd"
                              minTickGap={18}
                            />
                            <YAxis tick={{ fill: "#b0b0b0", fontSize: 10 }} width={40} domain={["auto", "auto"]} />
                            <Tooltip
                              content={({ active: a, payload, label }) => {
                                if (!a || !payload?.length) return null;
                                const base = (payload?.[0] as any)?.payload ?? {};
                                return (
                                  <div className="rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] px-3 py-2 shadow-[0_16px_60px_rgba(0,0,0,0.45)]">
                                    <div className="text-[11px] text-[#d0d0d0] font-extrabold">{label} CT</div>
                                    <div className="mt-1 space-y-1">
                                      {(["draftkings", "fanduel", "betmgm", "pinnacle"] as BookKey[]).map((bk) => (
                                        <div key={bk} className="flex items-center justify-between gap-3 text-[11px]">
                                          <div className="font-extrabold" style={{ color: BOOK_COLOR[bk] }}>
                                            {BOOK_FULL[bk]}
                                          </div>
                                          <div className="text-white font-extrabold tabular-nums">
                                            {base?.[bk] == null ? "—" : String(base[bk])}
                                            {base?.[`${bk}__line`] != null ? (
                                              <span className="text-[#b0b0b0] font-semibold">
                                                {" "}
                                                (line {base[`${bk}__line`]})
                                              </span>
                                            ) : null}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                );
                              }}
                            />
                            <Legend wrapperStyle={{ color: "#d0d0d0", fontSize: 11 }} />
                            {(["draftkings", "fanduel", "betmgm", "pinnacle"] as BookKey[]).map((bk) => (
                              <Line
                                key={bk}
                                type="monotone"
                                dataKey={bk}
                                name={BOOK_FULL[bk]}
                                stroke={BOOK_COLOR[bk]}
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
                ) : (
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* Away panel */}
                    <div className="rounded-2xl border border-[#2a2a2a] bg-black/20 p-4">
                      <div className="text-white font-extrabold text-[13px]">Away — Team Ratings</div>
                      <div className="text-[11px] text-[#b0b0b0] font-semibold mt-0.5">{active.awayTeam}</div>

                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <StatBox label="Adj Off" value={toFixed1(activeTeamMeta.awayR?.engine_adj_off)} />
                        <StatBox label="Adj Def" value={toFixed1(activeTeamMeta.awayR?.engine_adj_def)} />
                        <StatBox label="Net (engine_power)" value={toFixed1(activeTeamMeta.awayR?.engine_power)} />
                        <StatBox label="Tempo" value={toFixed1(activeTeamMeta.awayR?.tempo)} />
                      </div>
                    </div>

                    {/* Home panel */}
                    <div className="rounded-2xl border border-[#2a2a2a] bg-black/20 p-4">
                      <div className="text-white font-extrabold text-[13px]">Home — Team Ratings</div>
                      <div className="text-[11px] text-[#b0b0b0] font-semibold mt-0.5">{active.homeTeam}</div>

                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <StatBox label="Adj Off" value={toFixed1(activeTeamMeta.homeR?.engine_adj_off)} />
                        <StatBox label="Adj Def" value={toFixed1(activeTeamMeta.homeR?.engine_adj_def)} />
                        <StatBox label="Net (engine_power)" value={toFixed1(activeTeamMeta.homeR?.engine_power)} />
                        <StatBox label="Tempo" value={toFixed1(activeTeamMeta.homeR?.tempo)} />
                      </div>
                    </div>

                    <div className="md:col-span-2 text-[11px] text-[#808080] font-semibold">
                      Stats are sourced from <span className="text-white font-extrabold">team_ratings</span> using
                      <span className="text-white font-extrabold"> canonical team names</span>.
                      Percent-style fields are displayed as percentages when applicable.
                    </div>
                  </div>
                )}
              </div>
            </div>
          </ModalShell>
        )}

        <div className="h-10" />
      </div>
    </div>
  );
}

/* =========================================================
   SMALL UI: StatBox
========================================================= */

function toFixed1(v: number | null | undefined) {
  if (v == null) return "—";
  return Number(v).toFixed(1);
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-black/25 p-3">
      <div className="text-[10px] text-[#b0b0b0] font-semibold">{label}</div>
      <div className="mt-1 text-white font-extrabold tabular-nums text-[14px]">{value}</div>
    </div>
  );
}
