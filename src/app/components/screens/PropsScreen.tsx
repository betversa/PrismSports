// src/app/screens/PropsScreen.tsx — FULL REWRITE (Mobile-safe + ModelScreen modal pattern + FP API)
// -------------------------------------------------------------------------------------------------------------
// ✅ Markets: Points, Rebounds, Assists, 3PM ONLY
// ✅ Desktop: sticky table header + sticky left Pick col (like ModelScreen)
// ✅ Mobile: NO wide table — responsive cards (no horizontal scroll needed)
// ✅ Opponent works (team_map canonical -> Abbreviation / Abbreviation2) CASE-SAFE (build lowercase map)
// ✅ Over/Under badge colors distinct
// ✅ Modal = SAME pattern as ModelScreen:
//    - Tabs: Line History + Hit Rate
//    - Line History pulls from public.player_props_history (ts/bookmaker/odds) incl PIN
//    - Hit Rate pulls from /api/fantasypros-gamelog?player_name=...
//    - Tooltip in CT, no shaded cursor, bars colored OVER/UNDER vs today line
// ✅ μ header renamed to Projection
//
// Notes for mobile correctness:
// - We avoid min-w table on small screens (cards instead)
// - Modal uses fixed header/footer + body min-h-0 so “Done” is always reachable
// - Locks background scroll when modal open

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { calcBetAmount } from "../../../lib/odds/bet";
import { clampNumber, safeNumber } from "../../../lib/odds/math";
import { formatAmerican, formatMoney, formatPercent } from "../../../lib/odds/format";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  Cell,
  ReferenceLine,
} from "recharts";
import { X } from "lucide-react";

/* =========================================================
   Types
========================================================= */

type SoftBook = "draftkings" | "fanduel" | "betmgm";
type BookFilter = "any" | SoftBook;

type UiMarket = "Points" | "Rebounds" | "Assists" | "3PM";

type AppSettingsRow = {
  bankroll: number | null;
  kelly_factor: number | null;
};

type TeamMapRow = {
  canonical: string;
  Abbreviation?: string | null;
  Abbreviation2?: string | null;
};

type PlayerPropEvLatestRow = {
  id: string;
  sport_key: string | null;
  event_id: string;
  commence_time: string | null;

  team: string | null; // canonical
  opponent: string | null; // canonical

  player_name: string | null;
  position: string | null;
  picture_url: string | null;

  market: string | null;
  side: string | null; // "over"/"under"
  line: number | null;

  book: string; // "draftkings" | "fanduel" | "betmgm"
  odds: number;

  mu?: number | null;
  quantum_fair_odds: number;
  ev_pct: number;
  kelly_fraction: number;
  score: number;
};

type AggregatedProp = {
  key: string;

  sport_key: string | null;
  event_id: string;
  commence_time: string | null;

  team_canonical: string | null;
  opp_canonical: string | null;
  team_abbr: string | null;
  opp_abbr: string | null;

  player_name: string;
  position: string | null;
  picture_url: string | null;

  ui_market: UiMarket;
  raw_market: string | null;
  side: "over" | "under";
  line: number;

  projection: number | null; // mu

  offers: Partial<
    Record<SoftBook, { odds: number; ev_pct: number; kelly_fraction: number }>
  >;

  bestBook: SoftBook;
  bestOdds: number;
  bestEvPct: number;
  bestKelly: number;
  bestScore: number;

  fairOdds: number;
};

/* =========================================================
   Constants
========================================================= */

const UI_MARKETS: UiMarket[] = ["Points", "Rebounds", "Assists", "3PM"];
const SOFT_BOOKS: SoftBook[] = ["draftkings", "fanduel", "betmgm"];

const BOOK_FILTERS: { key: BookFilter; label: string }[] = [
  { key: "any", label: "Any" },
  { key: "draftkings", label: "DK" },
  { key: "fanduel", label: "FD" },
  { key: "betmgm", label: "MGM" },
];

// History tables/cols
const PROPS_HISTORY_TABLE = "player_props_history";
const TS_COL_PROPS = "ts";
const BOOK_COL_PROPS = "bookmaker";
const ODDS_COL_PROPS = "odds";
const PLAYER_COL_PROPS = "player_name";
const MARKET_COL_PROPS = "market";
const SIDE_COL_PROPS = "side";

// History includes Pinnacle
type AnyBookHistory = "draftkings" | "fanduel" | "betmgm" | "pinnacle";
const HISTORY_BOOKS: AnyBookHistory[] = [
  "draftkings",
  "fanduel",
  "betmgm",
  "pinnacle",
];

const BOOK_COLOR: Record<AnyBookHistory, string> = {
  draftkings: "#22c55e",
  fanduel: "#3b82f6",
  betmgm: "#d4af37",
  pinnacle: "#a855f7",
};

const OVER_GREEN = "#22c55e";
const UNDER_RED = "#ef4444";

/* =========================================================
   Helpers
========================================================= */

const safeNum = safeNumber;
const clamp = clampNumber;
const american = (odds: number) => formatAmerican(odds);
const pct = (n: number, digits = 1) => {
  const x = safeNum(n, 0);
  const formatted = formatPercent(Math.abs(x), digits);
  const sign = x < 0 ? "-" : x > 0 ? "+" : "";
  return `${sign}${formatted}`;
};

function normCanon(s?: string | null) {
  return (s ?? "").trim().toLowerCase();
}

function fmtTimeCentral(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDateCentral(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtHourMinCT(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDateTimeCT(iso: string) {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} · ${time}`;
}

function fmtMu(mu: number | null | undefined) {
  if (mu == null || !Number.isFinite(mu)) return "—";
  const v = Math.round(mu * 10) / 10;
  return v.toFixed(1);
}

function bookShort(book: AnyBookHistory) {
  if (book === "draftkings") return "DK";
  if (book === "fanduel") return "FD";
  if (book === "betmgm") return "MGM";
  return "PIN";
}

function initials(name: string) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "";
  const b = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (a + b).toUpperCase();
}

function normalizeSoftBookKey(bookmaker: string): SoftBook | "other" {
  const b = (bookmaker || "").toLowerCase();
  if (b === "draftkings" || b === "dk") return "draftkings";
  if (b === "fanduel" || b === "fd") return "fanduel";
  if (b === "betmgm" || b === "mgm") return "betmgm";
  return "other";
}

function normalizeHistoryBookKey(bookmaker: string): AnyBookHistory | "other" {
  const b = (bookmaker || "").toLowerCase();
  if (b === "draftkings" || b === "dk") return "draftkings";
  if (b === "fanduel" || b === "fd") return "fanduel";
  if (b === "betmgm" || b === "mgm") return "betmgm";
  if (b === "pinnacle" || b === "pin") return "pinnacle";
  return "other";
}

// Match ModelScreen market mapping for history keys
type PropHistoryMarketKey =
  | "player_points"
  | "player_rebounds"
  | "player_assists"
  | "player_threes";

function historyPropMarketKey(marketRaw: string | null): PropHistoryMarketKey | null {
  const m = (marketRaw || "").trim().toLowerCase();
  if (!m) return null;

  if (m === "player_points") return "player_points";
  if (m === "player_rebounds") return "player_rebounds";
  if (m === "player_assists") return "player_assists";
  if (m === "player_threes") return "player_threes";

  if (m === "points" || m === "pts") return "player_points";
  if (m === "rebounds" || m === "reb") return "player_rebounds";
  if (m === "assists" || m === "ast") return "player_assists";
  if (m === "3pt" || m === "3pm" || m === "threes" || m === "3") return "player_threes";
  if (m === "three_pointers") return "player_threes";

  if (m.includes("player_points")) return "player_points";
  if (m.includes("player_rebounds")) return "player_rebounds";
  if (m.includes("player_assists")) return "player_assists";
  if (m.includes("player_threes")) return "player_threes";

  return null;
}

function uiMarketFromRaw(raw: string | null): UiMarket {
  const k = historyPropMarketKey(raw);
  if (k === "player_points") return "Points";
  if (k === "player_rebounds") return "Rebounds";
  if (k === "player_assists") return "Assists";
  return "3PM";
}

/* =========================================================
   History series builder (odds history)
========================================================= */

type HistoryPoint = {
  ts: string;
  draftkings?: number | null;
  fanduel?: number | null;
  betmgm?: number | null;
  pinnacle?: number | null;
};

function normalizeIso(raw: any): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function collapseHistory(rows: any[]): HistoryPoint[] {
  const map = new Map<string, HistoryPoint>();

  for (const r of rows) {
    const ts = normalizeIso(r?.[TS_COL_PROPS]);
    if (!ts) continue;

    const bk = normalizeHistoryBookKey(String(r?.[BOOK_COL_PROPS] ?? ""));
    if (bk === "other") continue;

    const odds = Number(r?.[ODDS_COL_PROPS]);
    if (!Number.isFinite(odds)) continue;

    const cur = map.get(ts) ?? { ts };
    (cur as any)[bk] = odds;
    map.set(ts, cur);
  }

  return Array.from(map.values()).sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
  );
}

/* =========================================================
   FantasyPros types — same as ModelScreen
========================================================= */

type FantasyProsLogRow = {
  date: string;
  opp: string;
  score: string;
  min: string;
  pts: string;
  reb: string;
  ast: string;
  threes: string;
};

type FantasyProsApiResponse =
  | { ok: true; player_name: string; slug: string; url: string; rows: FantasyProsLogRow[] }
  | { ok: false; error: string; slug?: string; url?: string };

/* =========================================================
   Screen
========================================================= */

export function PropsScreen() {
  const [selectedMarket, setSelectedMarket] = useState<UiMarket>("Points");
  const [selectedBook, setSelectedBook] = useState<BookFilter>("any");

  const [settings, setSettings] = useState<AppSettingsRow | null>(null);
  const [rows, setRows] = useState<AggregatedProp[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [selected, setSelected] = useState<AggregatedProp | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const openModal = (p: AggregatedProp) => {
    setSelected(p);
    setModalOpen(true);
  };
  const closeModal = () => setModalOpen(false);

  // ESC to close modal + lock body scroll (ModelScreen behavior)
  useEffect(() => {
    if (!modalOpen) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModalOpen(false);
    };
    window.addEventListener("keydown", onKey);

    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [modalOpen]);

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setErr(null);

      try {
        // Load settings + latest props
        const [{ data: s, error: sErr }, { data: p, error: pErr }] = await Promise.all([
          supabase.from("app_settings").select("bankroll, kelly_factor").eq("id", 1).limit(1),
          supabase
            .from("player_prop_ev_latest")
            .select(
              [
                "id",
                "sport_key",
                "event_id",
                "commence_time",
                "team",
                "opponent",
                "player_name",
                "position",
                "picture_url",
                "market",
                "side",
                "line",
                "book",
                "odds",
                "mu",
                "quantum_fair_odds",
                "ev_pct",
                "kelly_fraction",
                "score",
              ].join(",")
            )
            .in("book", SOFT_BOOKS)
            .order("ev_pct", { ascending: false })
            .limit(2500),
        ]);

        if (sErr) throw sErr;
        if (pErr) throw pErr;

        const settingsRow = (s?.[0] ?? null) as any as AppSettingsRow | null;
        const props = ((p as any) ?? []) as PlayerPropEvLatestRow[];

        // ✅ Case-safe team_map: load once, build lowercase canonical->abbr map
        const { data: tm, error: tmErr } = await supabase
          .from("team_map")
          .select("canonical, Abbreviation, Abbreviation2");

        if (tmErr) throw tmErr;

        const canonToAbbr: Record<string, string> = {};
        for (const r of (tm ?? []) as TeamMapRow[]) {
          const key = normCanon(r.canonical);
          const abbr = (r.Abbreviation ?? "").trim() || (r.Abbreviation2 ?? "").trim();
          if (key && abbr) canonToAbbr[key] = abbr;
        }

        // Aggregate 1 row per (event, player, market, side, line)
        const map = new Map<string, AggregatedProp>();

        for (const r of props) {
          const player = (r.player_name ?? "").trim();
          const sideRaw = (r.side ?? "").trim().toLowerCase();
          const side =
            sideRaw === "o" ? "over" : sideRaw === "u" ? "under" : (sideRaw as any);

          const line = r.line ?? null;
          if (!player || line == null || !Number.isFinite(line)) continue;
          if (side !== "over" && side !== "under") continue;

          // ✅ ONLY 4 markets shown
          const uiMarket = uiMarketFromRaw(r.market ?? null);
          if (!UI_MARKETS.includes(uiMarket)) continue;

          const rawMarketLower = (r.market ?? "").toLowerCase();
          const key = `p|${r.event_id}|${player.toLowerCase()}|${rawMarketLower}|${side}|${String(
            line
          )}`;

          const softBook = normalizeSoftBookKey(r.book);
          if (softBook === "other") continue;

          const teamCanon = r.team ?? null;
          const oppCanon = r.opponent ?? null;

          const teamAbbr = canonToAbbr[normCanon(teamCanon)] || null;
          const oppAbbr = canonToAbbr[normCanon(oppCanon)] || null;

          if (!map.has(key)) {
            map.set(key, {
              key,
              sport_key: r.sport_key ?? null,
              event_id: r.event_id,
              commence_time: r.commence_time ?? null,

              team_canonical: teamCanon,
              opp_canonical: oppCanon,
              team_abbr: teamAbbr,
              opp_abbr: oppAbbr,

              player_name: player,
              position: r.position ?? null,
              picture_url: r.picture_url ?? null,

              ui_market: uiMarket,
              raw_market: r.market ?? null,
              side,
              line,

              projection: r.mu ?? null,

              offers: {},
              bestBook: softBook,
              bestOdds: r.odds,
              bestEvPct: r.ev_pct ?? 0,
              bestKelly: r.kelly_fraction ?? 0,
              bestScore: clamp(safeNum(r.score, 0), 0, 100),

              fairOdds: r.quantum_fair_odds,
            });
          }

          const agg = map.get(key)!;

          agg.offers[softBook] = {
            odds: r.odds,
            ev_pct: r.ev_pct ?? 0,
            kelly_fraction: r.kelly_fraction ?? 0,
          };

          // Best offer = highest EV
          if ((r.ev_pct ?? -999) > agg.bestEvPct) {
            agg.bestEvPct = r.ev_pct ?? 0;
            agg.bestBook = softBook;
            agg.bestOdds = r.odds;
            agg.bestKelly = r.kelly_fraction ?? 0;
            agg.bestScore = clamp(safeNum(r.score, 0), 0, 100);
            agg.fairOdds = r.quantum_fair_odds;
            agg.projection = r.mu ?? agg.projection ?? null;
          }
        }

        const aggregated = Array.from(map.values()).sort((a, b) => b.bestEvPct - a.bestEvPct);

        if (!mounted) return;
        setSettings(settingsRow);
        setRows(aggregated);
      } catch (e: any) {
        if (!mounted) return;
        setErr(e?.message ?? "Failed to load props.");
      } finally {
        if (!mounted) return;
        setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const byMarket = rows.filter((r) => r.ui_market === selectedMarket);
    if (selectedBook === "any") return byMarket;
    return byMarket.filter((r) => r.bestBook === selectedBook);
  }, [rows, selectedMarket, selectedBook]);

  const bankroll = safeNum(settings?.bankroll, 0);
  const kellyFactor = clamp(safeNum(settings?.kelly_factor, 0), 0, 1);
  const settingsReady = !!(bankroll && kellyFactor);

  const playable = useMemo(
    () => filtered.filter((r) => r.bestKelly > 0).length,
    [filtered]
  );

  return (
    <div className="space-y-4">
      {/* HERO */}
      <div className="relative overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#0b0b0b] p-4 md:p-5">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(700px 260px at 18% 0%, rgba(212,175,55,0.14), transparent 60%), radial-gradient(520px 220px at 86% 10%, rgba(255,255,255,0.05), transparent 60%)",
          }}
        />
        <div className="relative flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-black/40 px-3 py-1 text-[11px] text-[#b0b0b0]">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: "#d4af37" }}
              />
              Player Props
            </div>
            <h2 className="text-lg md:text-xl text-white mt-2 tracking-tight">
              Top +EV Props
            </h2>
            <p className="text-xs text-[#a8a8a8] mt-1">
              {loading ? "Loading…" : `${filtered.length} props · ${playable} playable`}
            </p>
          </div>

          <div className="flex items-center gap-2 text-[11px] flex-wrap">
            <div className="px-2 py-1 bg-black/40 border border-[#2a2a2a] rounded text-[#9a9a9a]">
              Bankroll:{" "}
              <span className="text-white">
                {bankroll ? formatMoney(bankroll, 0) : "—"}
              </span>
            </div>
            <div className="px-2 py-1 bg-black/40 border border-[#2a2a2a] rounded text-[#9a9a9a]">
              Kelly:{" "}
              <span className="text-white">
                {settings?.kelly_factor != null ? `${(kellyFactor * 100).toFixed(1)}%` : "—"}
              </span>
            </div>
          </div>
        </div>

        {err ? (
          <div className="relative mt-3 text-xs text-red-400 px-3 py-2 bg-black/40 border border-red-900/50 rounded-lg">
            {err}
          </div>
        ) : null}

        {/* Filters */}
        <div className="relative mt-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            {UI_MARKETS.map((m) => (
              <button
                key={m}
                onClick={() => setSelectedMarket(m)}
                className={`px-3 py-1.5 text-xs rounded-full transition-colors border ${
                  selectedMarket === m
                    ? "bg-[#d4af37] text-black border-[#d4af37]"
                    : "bg-black/40 text-[#b0b0b0] border-[#2a2a2a] hover:bg-[#111] hover:text-white"
                }`}
                type="button"
              >
                {m}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-[#808080] mr-1">Book</span>
            {BOOK_FILTERS.map((b) => (
              <button
                key={b.key}
                onClick={() => setSelectedBook(b.key)}
                className={`px-3 py-1.5 text-xs rounded-full transition-colors border ${
                  selectedBook === b.key
                    ? "bg-[#ffffff] text-black border-[#ffffff]"
                    : "bg-black/40 text-[#b0b0b0] border-[#2a2a2a] hover:bg-[#111] hover:text-white"
                }`}
                type="button"
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* DESKTOP TABLE (md+) */}
      <div className="hidden md:block bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl overflow-hidden">
        <div className="relative overflow-auto" style={{ maxHeight: "calc(100vh - 360px)" }}>
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-30">
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-40 min-w-[360px]">
                  Pick
                </th>
                <th className="text-left p-3 text-[#808080]">Team</th>
                <th className="text-left p-3 text-[#808080]">Opp</th>
                <th className="text-center p-3 text-[#808080]">Projection</th>
                <th className="text-center p-3 text-[#808080]">Line</th>
                <th className="text-center p-3 text-[#808080]">Books</th>
                <th className="text-center p-3 text-[#808080]">Fair</th>
                <th className="text-center p-3 text-[#808080]">EV%</th>
                <th className="text-center p-3 text-[#808080]">Score</th>
                <th className="text-center p-3 text-[#808080]">Bet $</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#1a1a1a]">
              {loading ? (
                <tr>
                  <td className="p-4 text-[#808080]" colSpan={10}>
                    Loading props…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td className="p-4 text-[#808080]" colSpan={10}>
                    No props for this filter.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
                  <PropRowDesktop
                    key={r.key}
                    row={r}
                    bankroll={bankroll}
                    kellyFactor={kellyFactor}
                    settingsReady={settingsReady}
                    onOpen={() => openModal(r)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* MOBILE LIST (<= md) */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl p-4 text-xs text-[#808080]">
            Loading props…
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl p-4 text-xs text-[#808080]">
            No props for this filter.
          </div>
        ) : (
          filtered.map((r) => (
            <PropCardMobile
              key={r.key}
              row={r}
              bankroll={bankroll}
              kellyFactor={kellyFactor}
              settingsReady={settingsReady}
              onOpen={() => openModal(r)}
            />
          ))
        )}
      </div>

      <PropDetailsModal
        open={modalOpen}
        prop={selected}
        onClose={closeModal}
        bankroll={bankroll}
        kellyFactor={kellyFactor}
        settingsReady={settingsReady}
      />
    </div>
  );
}

/* =========================================================
   Desktop row
========================================================= */

function PropRowDesktop({
  row,
  bankroll,
  kellyFactor,
  settingsReady,
  onOpen,
}: {
  row: AggregatedProp;
  bankroll: number;
  kellyFactor: number;
  settingsReady: boolean;
  onOpen: () => void;
}) {
  const team = row.team_abbr || row.team_canonical || "—";
  const opp = row.opp_abbr || row.opp_canonical || "—";
  const betAmount = settingsReady ? calcBetAmount(bankroll, row.bestKelly, kellyFactor) : NaN;

  const over = row.side === "over";

  return (
    <tr className="transition-colors hover:bg-white/[0.02]">
      {/* Pick (ONLY clickable cell) */}
      <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10">
        <button
          onClick={onOpen}
          className="w-full text-left group"
          type="button"
          title="Open details"
        >
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0">
              {row.picture_url ? (
                <img
                  src={row.picture_url}
                  alt={row.player_name}
                  className="h-9 w-9 rounded-full object-cover border border-[#2a2a2a]"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="h-9 w-9 rounded-full border border-[#2a2a2a] bg-[#0b0b0b] flex items-center justify-center">
                  <span className="text-[11px] text-[#cfcfcf]">
                    {initials(row.player_name)}
                  </span>
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-white group-hover:text-[#d4af37] transition-colors truncate">
                    {row.player_name} — {row.ui_market} {row.side} {row.line}
                  </div>
                  <div className="text-[10px] text-[#606060] mt-0.5 truncate">
                    {team} vs {opp}
                    {row.position ? ` · ${row.position}` : ""}
                  </div>
                </div>

                <span
                  className={[
                    "text-[10px] px-2 py-0.5 rounded border font-medium",
                    over
                      ? "bg-emerald-500/15 border-emerald-400/30 text-emerald-200"
                      : "bg-red-500/15 border-red-400/30 text-red-200",
                  ].join(" ")}
                >
                  {row.side}
                </span>
              </div>
            </div>
          </div>
        </button>
      </td>

      <td className="p-3 text-[#b0b0b0]">{team}</td>
      <td className="p-3 text-[#b0b0b0]">{opp}</td>

      <td className="p-3 text-center text-white tabular-nums">{fmtMu(row.projection)}</td>
      <td className="p-3 text-center text-[#b0b0b0] tabular-nums">{row.line.toFixed(1)}</td>

      <td className="p-3 text-center">
        <div className="inline-flex items-center gap-1">
          {SOFT_BOOKS.map((b) => {
            const offer = row.offers[b];
            const isBest = row.bestBook === b;
            return (
              <span
                key={b}
                className={`px-2 py-1 rounded border text-[10px] ${
                  isBest
                    ? "bg-[#d4af37]/15 border-[#d4af37]/40 text-[#d4af37]"
                    : "bg-[#101010] border-[#2a2a2a] text-[#777777]"
                }`}
              >
                {b === "draftkings" ? "DK" : b === "fanduel" ? "FD" : "MGM"}{" "}
                {offer ? american(offer.odds) : "—"}
              </span>
            );
          })}
        </div>
      </td>

      <td className="p-3 text-center text-white tabular-nums">{american(row.fairOdds)}</td>
      <td className="p-3 text-center text-emerald-400 tabular-nums">{pct(row.bestEvPct, 1)}</td>
      <td className="p-3 text-center text-[#b0b0b0] tabular-nums">{Math.round(row.bestScore)}</td>

      <td className="p-3 text-center">
        <span className="px-2 py-1 rounded border text-[10px] bg-[#0b0b0b] border-[#2a2a2a] text-white tabular-nums">
          {settingsReady && Number.isFinite(betAmount) && betAmount > 0
            ? formatMoney(betAmount, 0)
            : "—"}
        </span>
      </td>
    </tr>
  );
}

/* =========================================================
   Mobile card (NO horizontal scroll)
========================================================= */

function PropCardMobile({
  row,
  bankroll,
  kellyFactor,
  settingsReady,
  onOpen,
}: {
  row: AggregatedProp;
  bankroll: number;
  kellyFactor: number;
  settingsReady: boolean;
  onOpen: () => void;
}) {
  const team = row.team_abbr || row.team_canonical || "—";
  const opp = row.opp_abbr || row.opp_canonical || "—";
  const betAmount = settingsReady ? calcBetAmount(bankroll, row.bestKelly, kellyFactor) : NaN;
  const over = row.side === "over";

  return (
    <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-2xl overflow-hidden">
      {/* Pick block (ONLY clickable area) */}
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left p-3 active:opacity-90"
        aria-label="Open prop details"
      >
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0">
            {row.picture_url ? (
              <img
                src={row.picture_url}
                alt={row.player_name}
                className="h-10 w-10 rounded-full object-cover border border-[#2a2a2a]"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="h-10 w-10 rounded-full border border-[#2a2a2a] bg-[#0b0b0b] flex items-center justify-center">
                <span className="text-[11px] text-[#cfcfcf]">{initials(row.player_name)}</span>
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-white truncate">
                  {row.player_name} — {row.ui_market} {row.side} {row.line}
                </div>
                <div className="text-[11px] text-[#6e6e6e] mt-0.5 truncate">
                  {team} vs {opp}
                  {row.position ? ` · ${row.position}` : ""}
                </div>
              </div>

              <span
                className={[
                  "text-[10px] px-2 py-0.5 rounded border font-medium shrink-0",
                  over
                    ? "bg-emerald-500/15 border-emerald-400/30 text-emerald-200"
                    : "bg-red-500/15 border-red-400/30 text-red-200",
                ].join(" ")}
              >
                {row.side}
              </span>
            </div>

            {/* Best strip */}
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <span className="text-[10px] px-2 py-1 rounded border bg-[#0b0b0b] border-[#2a2a2a] text-[#b0b0b0]">
                Best:{" "}
                <span className="text-white">
                  {row.bestBook === "draftkings" ? "DK" : row.bestBook === "fanduel" ? "FD" : "MGM"}{" "}
                  {american(row.bestOdds)}
                </span>
              </span>

              <span className="text-[10px] px-2 py-1 rounded border bg-[#0b0b0b] border-[#2a2a2a] text-[#b0b0b0]">
                Fair: <span className="text-white">{american(row.fairOdds)}</span>
              </span>

              <span className="text-[10px] px-2 py-1 rounded border bg-emerald-500/10 border-emerald-400/20 text-emerald-200 tabular-nums">
                EV {pct(row.bestEvPct, 1)}
              </span>

              <span className="text-[10px] px-2 py-1 rounded border bg-[#0b0b0b] border-[#2a2a2a] text-[#b0b0b0]">
                Score: <span className="text-white tabular-nums">{Math.round(row.bestScore)}</span>
              </span>
            </div>
          </div>
        </div>
      </button>

      {/* Non-clickable details (so ONLY pick block opens modal) */}
      <div className="px-3 pb-3 -mt-1">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-[#2a2a2a] bg-[#0b0b0b] p-2">
            <div className="text-[10px] text-[#6e6e6e]">Projection</div>
            <div className="text-[12px] text-white tabular-nums mt-0.5">{fmtMu(row.projection)}</div>
          </div>

          <div className="rounded-xl border border-[#2a2a2a] bg-[#0b0b0b] p-2">
            <div className="text-[10px] text-[#6e6e6e]">Bet $</div>
            <div className="text-[12px] text-[#d4af37] tabular-nums mt-0.5">
              {settingsReady && Number.isFinite(betAmount) && betAmount > 0 ? formatMoney(betAmount, 0) : "—"}
            </div>
          </div>

          <div className="col-span-2 rounded-xl border border-[#2a2a2a] bg-[#0b0b0b] p-2">
            <div className="text-[10px] text-[#6e6e6e] mb-1">Books</div>
            <div className="flex items-center gap-1 flex-wrap">
              {SOFT_BOOKS.map((b) => {
                const offer = row.offers[b];
                const isBest = row.bestBook === b;
                return (
                  <span
                    key={b}
                    className={`px-2 py-1 rounded border text-[10px] ${
                      isBest
                        ? "bg-[#d4af37]/15 border-[#d4af37]/40 text-[#d4af37]"
                        : "bg-[#101010] border-[#2a2a2a] text-[#777777]"
                    }`}
                  >
                    {b === "draftkings" ? "DK" : b === "fanduel" ? "FD" : "MGM"}{" "}
                    {offer ? american(offer.odds) : "—"}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   Modal — same structure as ModelScreen (fixed header/footer)
========================================================= */

type ModalTab = "line" | "hit";

function PropDetailsModal({
  open,
  prop,
  onClose,
  bankroll,
  kellyFactor,
  settingsReady,
}: {
  open: boolean;
  prop: AggregatedProp | null;
  onClose: () => void;
  bankroll: number;
  kellyFactor: number;
  settingsReady: boolean;
}) {
  const [tab, setTab] = useState<ModalTab>("line");

  useEffect(() => {
    if (open) setTab("line");
  }, [open, prop?.key]);

  if (!open || !prop) return null;

  const team = prop.team_abbr || prop.team_canonical || "—";
  const opp = prop.opp_abbr || prop.opp_canonical || "—";
  const betAmount = settingsReady ? calcBetAmount(bankroll, prop.bestKelly, kellyFactor) : 0;

  return (
    <div className="fixed inset-0 z-[100]">
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-black/70"
        aria-label="Close details modal"
      />

      <div
        className="absolute inset-0 flex items-end md:items-center md:justify-center"
        style={{
          paddingTop: "max(env(safe-area-inset-top), 12px)",
          paddingBottom: "max(env(safe-area-inset-bottom), 12px)",
        }}
      >
        <div
          className="relative w-full md:max-w-4xl bg-[#0b0b0b] border border-[#2a2a2a] md:rounded-2xl rounded-t-2xl overflow-hidden flex flex-col"
          style={{ maxHeight: "min(92vh, 920px)" }}
        >
          {/* Header */}
          <div className="shrink-0 p-4 border-b border-[#1f1f1f] bg-[#0a0a0a]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-white text-sm md:text-base truncate">
                  {team} vs {opp}{" "}
                  <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-[#d4af37]/15 border border-[#d4af37]/25 text-[10px] text-[#d4af37]">
                    PROP
                  </span>
                </div>

                <div className="text-[11px] text-[#808080] mt-1">
                  {fmtDateCentral(prop.commence_time)} · {fmtTimeCentral(prop.commence_time)} ·{" "}
                  <span className="text-[#606060]">{prop.event_id}</span>
                </div>

                <div className="mt-2 text-white flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[#d4af37]">{prop.ui_market}</span>
                  <span className="text-[#404040]">·</span>
                  <span className="text-white">{prop.player_name}</span>
                  <span className="text-[#808080]">
                    · {prop.side} {prop.line}
                  </span>
                </div>

                <div className="mt-1 text-[11px] text-[#b0b0b0]">
                  Projection:{" "}
                  <span className="text-white tabular-nums">{fmtMu(prop.projection)}</span>
                </div>
              </div>

              <div className="shrink-0 text-right">
                <button
                  type="button"
                  onClick={onClose}
                  className="p-2 rounded hover:bg-white/5 text-[#b0b0b0] hover:text-white ml-auto"
                  aria-label="Close"
                >
                  <X size={18} />
                </button>

                <div className="mt-2 text-[10px] text-[#606060]">Best EV</div>
                <div className="text-emerald-400 font-semibold tabular-nums">
                  {pct(prop.bestEvPct, 1)}
                </div>

                <div className="mt-1 text-[10px] text-[#606060]">Bet</div>
                <div className="text-[#d4af37] font-semibold tabular-nums">
                  {settingsReady && betAmount > 0 ? formatMoney(betAmount, 0) : "—"}
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="inline-flex items-center rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] overflow-hidden">
                <TabButton active={tab === "line"} onClick={() => setTab("line")} label="Line History" />
                <TabButton active={tab === "hit"} onClick={() => setTab("hit")} label="Hit Rate" />
              </div>

              <div className="hidden sm:flex flex-wrap items-center gap-2 text-[11px] text-[#808080]">
                <LegendDot label="DK" color={BOOK_COLOR.draftkings} />
                <LegendDot label="FD" color={BOOK_COLOR.fanduel} />
                <LegendDot label="MGM" color={BOOK_COLOR.betmgm} />
                <LegendDot label="PIN" color={BOOK_COLOR.pinnacle} />
                <span className="text-[#404040]">·</span>
                <span>Tooltip shows date + time (CT)</span>
              </div>
            </div>
          </div>

          {/* Body (scrollable if needed, but header/footer fixed) */}
          <div className="flex-1 min-h-0 p-4 overflow-auto">
            {tab === "line" ? <PropOddsHistoryPanel prop={prop} /> : <PropHitRatePanel prop={prop} />}
          </div>

          {/* Footer */}
          <div className="shrink-0 p-4 border-t border-[#1f1f1f] bg-[#0a0a0a]">
            <button
              type="button"
              onClick={onClose}
              className="w-full md:w-auto md:ml-auto md:flex md:justify-end px-4 py-2 rounded-lg bg-[#111] border border-[#2a2a2a] text-[12px] text-[#d0d0d0] hover:bg-[#141414]"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "px-3 py-2 text-xs transition-colors",
        active ? "bg-[#141414] text-white" : "bg-transparent text-[#808080] hover:text-white hover:bg-[#111]",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function LegendDot({ label, color }: { label: string; color: string }) {
  return (
    <div className="inline-flex items-center gap-1">
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

/* =========================================================
   Modal Tab: Line History (player_props_history)
========================================================= */

function PropOddsHistoryPanel({ prop }: { prop: AggregatedProp }) {
  const [series, setSeries] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [debug, setDebug] = useState("");

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setSeries([]);
      setDebug("");

      try {
        const playerName = (prop.player_name ?? "").trim();
        const marketKey = historyPropMarketKey(prop.raw_market);
        const sideCanon = (prop.side ?? "").trim().toLowerCase();

        if (!playerName || !marketKey || !["over", "under"].includes(sideCanon)) {
          if (mounted) {
            setDebug(
              `keys missing: player="${playerName || "—"}" marketKey="${marketKey || "null"}" side="${sideCanon || "null"}"`
            );
          }
          return;
        }

        const { data, error } = await supabase
          .from(PROPS_HISTORY_TABLE)
          .select(
            `${PLAYER_COL_PROPS},${MARKET_COL_PROPS},${SIDE_COL_PROPS},${BOOK_COL_PROPS},${ODDS_COL_PROPS},${TS_COL_PROPS}`
          )
          .eq(PLAYER_COL_PROPS, playerName)
          .eq(MARKET_COL_PROPS, marketKey)
          .eq(SIDE_COL_PROPS, sideCanon)
          .in(BOOK_COL_PROPS, HISTORY_BOOKS)
          .order(TS_COL_PROPS, { ascending: true });

        if (!mounted) return;

        if (error) {
          setDebug(`history error: ${error.message}`);
          setSeries([]);
          return;
        }

        const pts = collapseHistory(data ?? []);
        setSeries(pts);

        if (!pts.length) {
          setDebug(
            `no rows: player="${playerName}" market="${marketKey}" side="${sideCanon}" books=${HISTORY_BOOKS.join(",")}`
          );
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [prop.key]);

  const hasAny = (k: AnyBookHistory) => series.some((p) => Number.isFinite((p as any)[k]));

  const TooltipContent = (props_: any) => {
    const { active, payload, label } = props_;
    if (!active || !payload?.length) return null;

    const order: AnyBookHistory[] = ["draftkings", "fanduel", "betmgm", "pinnacle"];
    const rows = order
      .map((k) => {
        const found = payload.find((p: any) => p.dataKey === k);
        const v = found?.value;
        if (!Number.isFinite(Number(v))) return null;
        return { k, v: Number(v) };
      })
      .filter(Boolean) as { k: AnyBookHistory; v: number }[];

    return (
      <div
        style={{
          background: "#0b0b0b",
          border: "1px solid #2a2a2a",
          padding: "10px",
          borderRadius: 10,
          color: "#d0d0d0",
          minWidth: 250,
          boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: "#fff", marginBottom: 6 }}>
          {fmtDateTimeCT(String(label))}
        </div>

        <div style={{ fontSize: 11, color: "#b0b0b0", marginBottom: 8, lineHeight: 1.35 }}>
          <div style={{ color: "#ffffff" }}>{prop.player_name}</div>
          <div>
            <span style={{ color: "#d4af37" }}>{prop.ui_market}</span>{" "}
            <span style={{ color: "#606060" }}>·</span>{" "}
            <span style={{ color: "#d0d0d0" }}>
              {prop.side} {prop.line}
            </span>
          </div>
          <div style={{ color: "#808080" }}>
            Projection: <span style={{ color: "#fff" }}>{fmtMu(prop.projection)}</span>
          </div>
        </div>

        <div style={{ display: "grid", gap: 4 }}>
          {rows.map(({ k, v }) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span style={{ fontSize: 11, color: BOOK_COLOR[k] }}>{bookShort(k)}</span>
              <span style={{ fontSize: 11, color: "#fff", fontVariantNumeric: "tabular-nums" }}>
                {american(v)}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="text-[10px] text-[#606060] mb-2">Odds History (this side)</div>

      {loading && !series.length ? (
        <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl p-4">
          <div className="text-xs text-[#808080]">Loading line movement…</div>
        </div>
      ) : null}

      {!loading && !series.length ? (
        <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl p-4">
          <div className="text-xs text-[#808080]">No odds history available for this prop/side.</div>
          {debug ? <div className="mt-2 text-[10px] text-[#404040] break-words">{debug}</div> : null}
        </div>
      ) : null}

      {!!series.length ? (
        <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl p-3 h-[min(44vh,360px)]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series}>
              <CartesianGrid stroke="#1f1f1f" strokeDasharray="3 3" />
              <XAxis
                dataKey="ts"
                tickFormatter={fmtHourMinCT}
                tick={{ fontSize: 10, fill: "#808080" }}
                axisLine={{ stroke: "#2a2a2a" }}
                tickLine={{ stroke: "#2a2a2a" }}
                minTickGap={18}
              />
              <YAxis
                tickFormatter={(v) => american(Number(v))}
                tick={{ fontSize: 10, fill: "#808080" }}
                axisLine={{ stroke: "#2a2a2a" }}
                tickLine={{ stroke: "#2a2a2a" }}
                width={58}
                domain={["auto", "auto"]}
              />

              <Tooltip content={TooltipContent} />
              <Legend
                wrapperStyle={{ fontSize: 11, color: "#808080" }}
                formatter={(value: any) => <span style={{ color: "#b0b0b0" }}>{String(value)}</span>}
              />

              {hasAny("draftkings") ? (
                <Line
                  type="monotone"
                  dataKey="draftkings"
                  name="DK"
                  stroke={BOOK_COLOR.draftkings}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ) : null}
              {hasAny("fanduel") ? (
                <Line
                  type="monotone"
                  dataKey="fanduel"
                  name="FD"
                  stroke={BOOK_COLOR.fanduel}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ) : null}
              {hasAny("betmgm") ? (
                <Line
                  type="monotone"
                  dataKey="betmgm"
                  name="MGM"
                  stroke={BOOK_COLOR.betmgm}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ) : null}
              {hasAny("pinnacle") ? (
                <Line
                  type="monotone"
                  dataKey="pinnacle"
                  name="PIN"
                  stroke={BOOK_COLOR.pinnacle}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ) : null}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : null}
    </div>
  );
}

/* =========================================================
   Modal Tab: Hit Rate (FantasyPros API)
========================================================= */

function PropHitRatePanel({ prop }: { prop: AggregatedProp }) {
  const [rows, setRows] = useState<FantasyProsLogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [debug, setDebug] = useState("");

  useEffect(() => {
    let mounted = true;

    async function load() {
      const playerName = (prop.player_name ?? "").trim();
      if (!playerName) {
        setRows([]);
        setDebug("No player name available for FantasyPros lookup.");
        return;
      }

      setLoading(true);
      setDebug("");
      setRows([]);

      try {
        const url = `/api/fantasypros-gamelog?player_name=${encodeURIComponent(playerName)}`;
        const res = await fetch(url);
        const json = (await res.json()) as FantasyProsApiResponse;

        if (!mounted) return;

        if (!json.ok) {
          setRows([]);
          setDebug(`FantasyPros logs error: ${json.error}${json.url ? ` (${json.url})` : ""}`);
          return;
        }

        setRows(json.rows ?? []);
        if (!(json.rows ?? []).length) {
          setDebug(`FantasyPros logs: parsed 0 rows (${json.url})`);
        }
      } catch (e: any) {
        if (!mounted) return;
        setDebug(`FantasyPros logs error: ${e?.message ?? String(e)}`);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [prop.key]);

  const marketKey = historyPropMarketKey(prop.raw_market);
  const statKey: "pts" | "reb" | "ast" | "threes" =
    marketKey === "player_rebounds"
      ? "reb"
      : marketKey === "player_assists"
      ? "ast"
      : marketKey === "player_threes"
      ? "threes"
      : "pts";

  const statLabel = statKey === "reb" ? "REB" : statKey === "ast" ? "AST" : statKey === "threes" ? "3PM" : "PTS";

  const chartData = useMemo(() => {
    const last = (rows ?? []).slice(0, 10).slice().reverse();
    return last.map((r) => ({
      date: r.date,
      opp: r.opp,
      score: r.score,
      min: safeNum(r.min, 0),
      pts: safeNum(r.pts, 0),
      reb: safeNum(r.reb, 0),
      ast: safeNum(r.ast, 0),
      threes: safeNum(r.threes, 0),
    }));
  }, [rows]);

  const todayLine = prop.line;

  const LogsTooltip = (props_: any) => {
    const { active, payload, label } = props_;
    if (!active || !payload?.length) return null;

    const d = payload[0]?.payload;
    if (!d) return null;

    const v = safeNum(d[statKey], NaN);
    const line = Number.isFinite(todayLine) ? todayLine : null;
    const overUnder = line != null && Number.isFinite(v) ? (v >= line ? "OVER" : "UNDER") : undefined;

    return (
      <div
        style={{
          background: "#0b0b0b",
          border: "1px solid #2a2a2a",
          padding: "10px",
          borderRadius: 10,
          color: "#d0d0d0",
          minWidth: 240,
          boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: "#fff", marginBottom: 6 }}>{label}</div>

        <div style={{ fontSize: 11, color: "#b0b0b0", lineHeight: 1.35 }}>
          <div>
            vs <span style={{ color: "#fff" }}>{d.opp}</span> ·{" "}
            <span style={{ color: "#808080" }}>{d.score}</span>
          </div>

          <div style={{ marginTop: 8, display: "grid", gap: 2 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#808080" }}>MIN</span>
              <span style={{ color: "#fff" }}>{d.min}</span>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#808080" }}>{statLabel}</span>
              <span style={{ color: "#fff" }}>{Number.isFinite(v) ? v : "—"}</span>
            </div>

            {line != null ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#808080" }}>Today Line</span>
                  <span style={{ color: "#fff" }}>{line}</span>
                </div>
                {overUnder ? (
                  <div style={{ marginTop: 4, fontSize: 11, color: overUnder === "OVER" ? OVER_GREEN : UNDER_RED }}>
                    {overUnder}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const activeBarStyle = { stroke: "#ffffff", strokeWidth: 1, fillOpacity: 1 };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="text-[10px] text-[#606060]">FantasyPros Game Logs</div>
        {loading ? <div className="text-[10px] text-[#606060]">Loading…</div> : null}
      </div>

      {chartData.length ? (
        <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl p-3">
          <div className="text-[10px] text-[#606060] mb-2">
            Last {chartData.length} games · {statLabel} bars
            {Number.isFinite(todayLine) ? <span className="text-[#808080]"> · Today Line {todayLine}</span> : null}
          </div>

          <div className="h-[min(44vh,340px)]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} barCategoryGap={12}>
                <CartesianGrid stroke="#1f1f1f" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "#808080" }}
                  axisLine={{ stroke: "#2a2a2a" }}
                  tickLine={{ stroke: "#2a2a2a" }}
                  minTickGap={12}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "#808080" }}
                  axisLine={{ stroke: "#2a2a2a" }}
                  tickLine={{ stroke: "#2a2a2a" }}
                  width={36}
                />

                {/* ✅ no shaded cursor */}
                <Tooltip content={LogsTooltip} cursor={{ fill: "rgba(0,0,0,0)" }} />

                {Number.isFinite(todayLine) ? (
                  <ReferenceLine
                    y={todayLine}
                    stroke="#d0d0d0"
                    strokeDasharray="4 4"
                    ifOverflow="extendDomain"
                    label={{ value: "Today Line", position: "right", fill: "#808080", fontSize: 10 }}
                  />
                ) : null}

                <Bar dataKey={statKey} name={statLabel} isAnimationActive={false} activeBar={activeBarStyle}>
                  {chartData.map((d, idx) => {
                    const v = safeNum((d as any)[statKey], NaN);
                    const line = Number.isFinite(todayLine) ? todayLine : null;
                    const isOver = line != null && Number.isFinite(v) ? v >= line : true;
                    return <Cell key={idx} fill={isOver ? OVER_GREEN : UNDER_RED} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : (
        <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl p-4">
          <div className="text-xs text-[#808080]">No game logs available.</div>
          {debug ? <div className="mt-2 text-[10px] text-[#404040] break-words">{debug}</div> : null}
        </div>
      )}
    </div>
  );
}
