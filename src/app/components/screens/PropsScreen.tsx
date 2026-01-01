// src/app/screens/PropsScreen.tsx — FULL REWRITE
// -------------------------------------------------------------------------------------------------------------
// ✅ Fix: opponent + team abbreviations now resolve correctly via team_map (canonical -> Abbreviation OR Abbreviation2)
// ✅ Markets: Points, Rebounds, Assists, 3PM (DB: points/rebounds/assists/threes)
// ✅ Table sticky header FIX: header sticks to TOP of table scroll container (not mid-screen)
// ✅ Over/Under badges have distinct colors
// ✅ Modal: Tabs ("Line History" + "Game Log")
//    - Line History: DK/FD/MGM/PIN line chart w/ tooltip showing DATE + TIME (CT)
//    - Game Log: FantasyPros bars (single stat) + reference line at TODAY'S prop line
// ✅ Header column "μ" renamed to "Projection"
// ✅ Player pictures show (picture_url) with initials fallback

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { X } from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  ReferenceLine,
} from "recharts";

type BookKey = "draftkings" | "fanduel" | "betmgm" | "any";
type SoftBook = Exclude<BookKey, "any">;
type SharpBook = "pinnacle";

type UiMarket = "Points" | "Rebounds" | "Assists" | "3PM";
type DbMarket = "points" | "rebounds" | "assists" | "threes";

type AppSettingsRow = {
  bankroll: number | null;
  kelly_factor: number | null;
};

type TeamMapRow = {
  canonical: string;
  Abbreviation?: string | null;
  Abbreviation2?: string | null;
};

type PropQuoteDB = {
  id: string;
  sport_key?: string | null;
  event_id: string;
  commence_time?: string | null;

  team?: string | null; // canonical
  opponent?: string | null; // canonical (this is the field you said exists)
  fp_id?: number | null;

  player_name: string;
  position?: string | null;
  picture_url?: string | null;

  market: DbMarket;
  side: "Over" | "Under";
  line: number;

  book: SoftBook;
  odds: number;

  mu?: number | null; // projection
  sigma?: number | null;

  quantum_fair_odds?: number | null;
  ev_pct: number;
  kelly_fraction?: number | null;
  score?: number | null;

  has_sharp?: boolean | null;
  sharp_source?: string | null;
};

type AggRow = {
  key: string;

  sport_key?: string | null;
  event_id: string;
  commence_time?: string | null;

  team_canonical?: string | null;
  opp_canonical?: string | null;
  team_abbr?: string | null;
  opp_abbr?: string | null;

  player_name: string;
  position?: string | null;
  picture_url?: string | null;
  fp_id?: number | null;

  market: UiMarket;
  db_market: DbMarket;
  side: "Over" | "Under";
  line: number;

  projection?: number | null;
  sigma?: number | null;

  quotes: Record<SoftBook, { odds: number | null; ev_pct: number | null }>;

  best_book: SoftBook;
  best_odds: number;
  best_ev_pct: number;
  best_kelly_fraction: number;
  best_score?: number | null;

  prism_odds?: number | null;

  has_sharp?: boolean | null;
  sharp_source?: string | null;
};

const UI_MARKETS: UiMarket[] = ["Points", "Rebounds", "Assists", "3PM"];
const DB_MARKETS: DbMarket[] = ["points", "rebounds", "assists", "threes"];

const SOFT_BOOKS: SoftBook[] = ["draftkings", "fanduel", "betmgm"];
const BOOKS: { key: BookKey; label: string }[] = [
  { key: "any", label: "Any" },
  { key: "draftkings", label: "DK" },
  { key: "fanduel", label: "FD" },
  { key: "betmgm", label: "MGM" },
];

// ✅ You can change these if your schema uses different names
const LINE_HISTORY_TABLE = "player_props_snapshot";
const FP_GAMELOGS_TABLE = "fantasypros_player_gamelogs_nba"; // adjust if needed

const CT_TZ = "America/Chicago";

function dbMarketToUi(m: DbMarket): UiMarket {
  if (m === "points") return "Points";
  if (m === "rebounds") return "Rebounds";
  if (m === "assists") return "Assists";
  return "3PM";
}

function uiMarketToDb(m: UiMarket): DbMarket {
  if (m === "Points") return "points";
  if (m === "Rebounds") return "rebounds";
  if (m === "Assists") return "assists";
  return "threes";
}

function bookLabel(b: string) {
  if (b === "draftkings") return "DK";
  if (b === "fanduel") return "FD";
  if (b === "betmgm") return "MGM";
  if (b === "pinnacle") return "PIN";
  return b.toUpperCase();
}

function formatAmerican(odds: number) {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function normCanon(s?: string | null) {
  return (s ?? "").trim().toLowerCase();
}

function initials(name: string) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "";
  const b = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (a + b).toUpperCase();
}

function fmtCt(dateIso: string) {
  const d = new Date(dateIso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(d);

  const mm = parts.find((p) => p.type === "month")?.value ?? "01";
  const dd = parts.find((p) => p.type === "day")?.value ?? "01";
  const hh = parts.find((p) => p.type === "hour")?.value ?? "12";
  const mi = parts.find((p) => p.type === "minute")?.value ?? "00";
  const ap = parts.find((p) => p.type === "dayPeriod")?.value ?? "AM";
  return `${mm}/${dd} ${hh}:${mi} ${ap} CT`;
}

export function PropsScreen() {
  const [selectedMarket, setSelectedMarket] = useState<UiMarket>("Points");
  const [selectedBook, setSelectedBook] = useState<BookKey>("any");

  const [settings, setSettings] = useState<AppSettingsRow | null>(null);
  const [rows, setRows] = useState<AggRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [activeModal, setActiveModal] = useState<AggRow | null>(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setErr(null);

      try {
        const [{ data: s, error: sErr }, { data: p, error: pErr }] = await Promise.all([
          supabase.from("app_settings").select("bankroll, kelly_factor").limit(1).maybeSingle(),
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
                "fp_id",
                "player_name",
                "position",
                "picture_url",
                "market",
                "side",
                "line",
                "book",
                "odds",
                "mu",
                "sigma",
                "quantum_fair_odds",
                "ev_pct",
                "kelly_fraction",
                "score",
                "has_sharp",
                "sharp_source",
              ].join(",")
            )
            .in("market", DB_MARKETS)
            .in("book", SOFT_BOOKS)
            .order("ev_pct", { ascending: false })
            .limit(2500),
        ]);

        if (sErr) throw sErr;
        if (pErr) throw pErr;

        const quotes = ((p as any) ?? []) as PropQuoteDB[];

        // ✅ IMPORTANT FIX:
        // We query team_map with *original canonical strings* (case-sensitive exact match),
        // but we store the mapping with normalized keys for reliable lookup.
        const canonOriginalSet = new Set<string>();
        for (const q of quotes) {
          const t = (q.team ?? "").trim();
          const o = (q.opponent ?? "").trim();
          if (t) canonOriginalSet.add(t);
          if (o) canonOriginalSet.add(o);
        }

        const canonOriginalList = Array.from(canonOriginalSet);
        const canonToAbbr: Record<string, string> = {};

        const CHUNK = 200;
        for (let i = 0; i < canonOriginalList.length; i += CHUNK) {
          const chunk = canonOriginalList.slice(i, i + CHUNK);

          const { data: tm, error: tmErr } = await supabase
            .from("team_map")
            .select("canonical, Abbreviation, Abbreviation2")
            .in("canonical", chunk);

          if (tmErr) throw tmErr;

          for (const r of (tm ?? []) as TeamMapRow[]) {
            const key = normCanon(r.canonical);
            const abbr = (r.Abbreviation ?? "").trim() || (r.Abbreviation2 ?? "").trim();
            if (key && abbr) canonToAbbr[key] = abbr;
          }
        }

        // ---- Aggregate 1 row per play ----
        const map = new Map<string, AggRow>();

        for (const q of quotes) {
          const key = [q.event_id, q.player_name, q.market, q.side, Number(q.line).toFixed(3)].join("|");

          const teamCanon = q.team ?? null;
          const oppCanon = q.opponent ?? null;

          const teamAbbr = canonToAbbr[normCanon(teamCanon)] || null;
          const oppAbbr = canonToAbbr[normCanon(oppCanon)] || null;

          if (!map.has(key)) {
            map.set(key, {
              key,
              sport_key: q.sport_key ?? null,
              event_id: q.event_id,
              commence_time: q.commence_time ?? null,

              team_canonical: teamCanon,
              opp_canonical: oppCanon,
              team_abbr: teamAbbr,
              opp_abbr: oppAbbr,

              player_name: q.player_name,
              position: q.position ?? null,
              picture_url: q.picture_url ?? null,
              fp_id: q.fp_id ?? null,

              market: dbMarketToUi(q.market),
              db_market: q.market,
              side: q.side,
              line: q.line,

              projection: q.mu ?? null,
              sigma: q.sigma ?? null,

              quotes: {
                draftkings: { odds: null, ev_pct: null },
                fanduel: { odds: null, ev_pct: null },
                betmgm: { odds: null, ev_pct: null },
              },

              best_book: q.book,
              best_odds: q.odds,
              best_ev_pct: q.ev_pct ?? 0,
              best_kelly_fraction: q.kelly_fraction ?? 0,
              best_score: q.score ?? null,

              prism_odds: q.quantum_fair_odds ?? null,

              has_sharp: q.has_sharp ?? null,
              sharp_source: q.sharp_source ?? null,
            });
          }

          const row = map.get(key)!;

          // keep the first non-null picture
          if (!row.picture_url && q.picture_url) row.picture_url = q.picture_url;

          // ensure abbreviations populate if mapping available later
          if (!row.team_abbr && teamAbbr) row.team_abbr = teamAbbr;
          if (!row.opp_abbr && oppAbbr) row.opp_abbr = oppAbbr;

          // store per-book quote
          row.quotes[q.book] = { odds: q.odds, ev_pct: q.ev_pct ?? null };

          // best book = highest ev_pct
          if ((q.ev_pct ?? -999) > (row.best_ev_pct ?? -999)) {
            row.best_ev_pct = q.ev_pct ?? 0;
            row.best_book = q.book;
            row.best_odds = q.odds;
            row.best_kelly_fraction = q.kelly_fraction ?? 0;
            row.best_score = q.score ?? null;
            row.prism_odds = q.quantum_fair_odds ?? row.prism_odds ?? null;
          }
        }

        const aggregated = Array.from(map.values()).sort((a, b) => (b.best_ev_pct ?? 0) - (a.best_ev_pct ?? 0));

        if (!mounted) return;
        setSettings((s as any) ?? null);
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
    const dbMarket = uiMarketToDb(selectedMarket);
    const byMarket = rows.filter((r) => r.db_market === dbMarket);
    if (selectedBook === "any") return byMarket;
    return byMarket.filter((r) => r.best_book === selectedBook);
  }, [rows, selectedMarket, selectedBook]);

  const bankroll = settings?.bankroll ?? 300;
  const kellyFactor = settings?.kelly_factor ?? 0.25;

  const playable = useMemo(() => filtered.filter((r) => (r.best_kelly_fraction ?? 0) > 0).length, [filtered]);

  return (
    <div className="space-y-4">
      {/* HERO */}
      <div className="rounded-2xl border border-[#2a2a2a] bg-gradient-to-b from-[#101010] to-[#070707] shadow-[0_0_0_1px_rgba(255,255,255,0.03),0_20px_60px_rgba(0,0,0,0.55)] overflow-hidden">
        <div className="p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-full bg-[#d4af37] shadow-[0_0_18px_rgba(212,175,55,0.35)]" />
                <h2 className="text-white text-lg sm:text-xl leading-tight">Player Props</h2>
              </div>
              <p className="text-xs text-[#808080] mt-1">
                {loading ? "Loading…" : `${filtered.length} props · ${playable} playable`}
              </p>
            </div>

            <div className="flex items-center gap-2 text-[11px]">
              <div className="px-2 py-1 bg-[#0b0b0b] border border-[#1f1f1f] rounded text-[#9a9a9a]">
                Bankroll: <span className="text-white">${bankroll.toFixed(0)}</span>
              </div>
              <div className="px-2 py-1 bg-[#0b0b0b] border border-[#1f1f1f] rounded text-[#9a9a9a]">
                Kelly: <span className="text-white">{(kellyFactor * 100).toFixed(0)}%</span>
              </div>
              <div className="px-2 py-1 bg-[#0b0b0b] border border-[#1f1f1f] rounded text-[#9a9a9a]">
                Plays: <span className="text-[#d4af37]">{rows.length}</span>
              </div>
            </div>
          </div>

          {err ? (
            <div className="mt-3 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded p-2">{err}</div>
          ) : null}
        </div>

        {/* FILTER BAR */}
        <div className="border-t border-[#1f1f1f] bg-[#060606]/90 backdrop-blur supports-[backdrop-filter]:bg-[#060606]/70">
          <div className="p-3 sm:p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              {UI_MARKETS.map((m) => (
                <button
                  key={m}
                  onClick={() => setSelectedMarket(m)}
                  className={`px-3 py-1.5 text-xs rounded-full transition-colors border ${
                    selectedMarket === m
                      ? "bg-[#d4af37] text-black border-[#d4af37]"
                      : "bg-[#101010] text-[#b0b0b0] border-[#2a2a2a] hover:bg-[#1a1a1a] hover:text-white"
                  }`}
                  type="button"
                >
                  {m}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-[#808080] mr-1">Book</span>
              {BOOKS.map((b) => (
                <button
                  key={b.key}
                  onClick={() => setSelectedBook(b.key)}
                  className={`px-3 py-1.5 text-xs rounded-full transition-colors border ${
                    selectedBook === b.key
                      ? "bg-[#ffffff] text-black border-[#ffffff]"
                      : "bg-[#101010] text-[#b0b0b0] border-[#2a2a2a] hover:bg-[#1a1a1a] hover:text-white"
                  }`}
                  type="button"
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* TABLE PANEL */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl overflow-hidden">
        <div className="relative overflow-auto" style={{ maxHeight: "calc(100vh - 360px)" }}>
          <table className="w-full text-xs min-w-[1100px]">
            <thead className="sticky top-0 z-30">
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-40 min-w-[360px]">
                  Pick
                </th>
                <th className="text-left p-3 text-[#808080]">Team</th>
                <th className="text-left p-3 text-[#808080]">Opp</th>
                <th className="text-center p-3 text-[#808080]">Projection</th>
                <th className="text-center p-3 text-[#808080]">Line</th>
                <th className="text-center p-3 text-[#808080]">Edge</th>
                <th className="text-center p-3 text-[#808080]">Sigma</th>
                <th className="text-center p-3 text-[#808080]">Books</th>
                <th className="text-center p-3 text-[#808080]">Prism</th>
                <th className="text-center p-3 text-[#808080]">EV%</th>
                <th className="text-center p-3 text-[#808080]">Score</th>
                <th className="text-center p-3 text-[#808080]">Bet $</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#1a1a1a]">
              {loading ? (
                <tr>
                  <td className="p-4 text-[#808080]" colSpan={12}>
                    Loading props…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td className="p-4 text-[#808080]" colSpan={12}>
                    No props for this filter.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
                  <PropRow
                    key={r.key}
                    row={r}
                    bankroll={bankroll}
                    kellyFactor={kellyFactor}
                    onOpen={() => setActiveModal(r)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {activeModal ? <PropDetailsModal row={activeModal} onClose={() => setActiveModal(null)} /> : null}
    </div>
  );
}

function PropRow({
  row,
  bankroll,
  kellyFactor,
  onOpen,
}: {
  row: AggRow;
  bankroll: number;
  kellyFactor: number;
  onOpen: () => void;
}) {
  // Prefer abbreviations, fallback to canonicals, fallback to —
  const team = row.team_abbr || row.team_canonical || "—";
  const opp = row.opp_abbr || row.opp_canonical || "—";

  const projection = row.projection ?? 0;
  const edge = projection - row.line;

  const hasPositiveEV = (row.best_ev_pct ?? 0) > 3;

  const betFrac = clamp((row.best_kelly_fraction ?? 0) * kellyFactor, 0, 0.25);
  const betDollars = bankroll * betFrac;

  const over = row.side === "Over";

  return (
    <tr className={`hover:bg-[#0f0f0f]/50 transition-colors ${betDollars > 0 ? "bg-[#d4af37]/5" : ""}`}>
      <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10">
        <button onClick={onOpen} className="w-full text-left group" title="Open details" type="button">
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
                  <span className="text-[11px] text-[#cfcfcf]">{initials(row.player_name)}</span>
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-white group-hover:text-[#d4af37] transition-colors truncate">
                    {row.player_name} — {row.market} {row.side.toLowerCase()} {row.line}
                  </div>
                  <div className="text-[10px] text-[#606060] mt-0.5 truncate">
                    {team} vs {opp}
                    {row.position ? ` · ${row.position}` : ""}
                  </div>
                </div>

                {/* ✅ Stronger Over/Under color contrast */}
                <span
                  className={[
                    "text-[10px] px-2 py-0.5 rounded border font-medium",
                    over
                      ? "bg-emerald-500/15 border-emerald-400/30 text-emerald-200"
                      : "bg-red-500/15 border-red-400/30 text-red-200",
                  ].join(" ")}
                >
                  {row.side.toLowerCase()}
                </span>
              </div>
            </div>
          </div>
        </button>
      </td>

      <td className="p-3 text-[#b0b0b0]">{team}</td>
      <td className="p-3 text-[#b0b0b0]">{opp}</td>

      <td className="p-3 text-center text-white">{projection.toFixed(1)}</td>
      <td className="p-3 text-center text-[#b0b0b0]">{row.line.toFixed(1)}</td>

      <td className={`p-3 text-center ${Math.abs(edge) > 2 ? "text-[#d4af37]" : "text-[#808080]"}`}>
        {edge > 0 ? "+" : ""}
        {edge.toFixed(1)}
      </td>

      <td className="p-3 text-center text-[#606060]">{(row.sigma ?? 0).toFixed(1)}</td>

      <td className="p-3 text-center">
        <div className="inline-flex items-center gap-1">
          {SOFT_BOOKS.map((b) => {
            const q = row.quotes[b];
            const isBest = row.best_book === b;
            const has = q?.odds != null;

            return (
              <span
                key={b}
                className={`px-2 py-1 rounded border text-[10px] ${
                  isBest
                    ? "bg-[#d4af37]/15 border-[#d4af37]/40 text-[#d4af37]"
                    : "bg-[#101010] border-[#2a2a2a] text-[#777777]"
                }`}
                title={
                  has
                    ? `${bookLabel(b)} ${formatAmerican(q.odds!)}${q.ev_pct != null ? ` · EV ${q.ev_pct.toFixed(1)}%` : ""}`
                    : `${bookLabel(b)} —`
                }
              >
                {bookLabel(b)} {has ? formatAmerican(q.odds!) : "—"}
              </span>
            );
          })}
        </div>
      </td>

      <td className="p-3 text-center text-white">{row.prism_odds != null ? formatAmerican(row.prism_odds) : "—"}</td>

      <td className={`p-3 text-center ${hasPositiveEV ? "text-emerald-400" : "text-[#808080]"}`}>
        {row.best_ev_pct > 0 ? "+" : ""}
        {row.best_ev_pct.toFixed(1)}%
      </td>

      <td className="p-3 text-center text-[#b0b0b0]">{row.best_score != null ? row.best_score.toFixed(0) : "—"}</td>

      <td className="p-3 text-center">
        <span
          className={`px-2 py-1 rounded border text-[10px] ${
            betDollars > 0 ? "bg-[#0b0b0b] border-[#2a2a2a] text-white" : "bg-[#0b0b0b] border-[#1a1a1a] text-[#606060]"
          }`}
        >
          {betDollars > 0 ? `$${betDollars.toFixed(0)}` : "—"}
        </span>
      </td>
    </tr>
  );
}

/* =========================
   MODAL (Tabs + Charts)
   ========================= */

type LinePoint = {
  ts: string; // ISO
  label: string; // formatted CT
  dk?: number | null;
  fd?: number | null;
  mgm?: number | null;
  pin?: number | null;
};

type GameLogRow = {
  game_date: string; // ISO or YYYY-MM-DD
  value: number;
};

function dbStatKey(market: UiMarket): "points" | "rebounds" | "assists" | "threes" {
  if (market === "Points") return "points";
  if (market === "Rebounds") return "rebounds";
  if (market === "Assists") return "assists";
  return "threes";
}

function PropDetailsModal({ row, onClose }: { row: AggRow; onClose: () => void }) {
  const [tab, setTab] = useState<"history" | "gamelog">("history");
  const [history, setHistory] = useState<LinePoint[]>([]);
  const [gamelog, setGamelog] = useState<GameLogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const team = row.team_abbr || row.team_canonical || "—";
  const opp = row.opp_abbr || row.opp_canonical || "—";

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setErr(null);

      try {
        // --- Line history (player_props_snapshot) ---
        // Expected columns in snapshot:
        // event_id, player_name, market, side, line, book, odds, ts (or inserted_at), created_at
        const { data: snap, error: snapErr } = await supabase
          .from(LINE_HISTORY_TABLE)
          .select("event_id, player_name, market, side, line, book, odds, ts, inserted_at, created_at")
          .eq("event_id", row.event_id)
          .eq("player_name", row.player_name)
          .eq("market", row.db_market)
          .eq("side", row.side)
          // optional: constrain to same line (keeps chart clean)
          .eq("line", row.line)
          .order("ts", { ascending: true })
          .limit(500);

        if (snapErr) throw snapErr;

        const pointsMap = new Map<string, LinePoint>();

        for (const r of (snap ?? []) as any[]) {
          const ts: string =
            r.ts ??
            r.inserted_at ??
            r.created_at ??
            new Date().toISOString();

          const key = ts;
          if (!pointsMap.has(key)) {
            pointsMap.set(key, { ts, label: fmtCt(ts), dk: null, fd: null, mgm: null, pin: null });
          }

          const p = pointsMap.get(key)!;
          const b = (r.book ?? "").toLowerCase();

          // chart uses the LINE (not odds) — if your snapshot stores "line" movement separately, swap here.
          // If you want ODDS movement instead, replace `r.line` below with `r.odds`.
          const val = typeof r.line === "number" ? r.line : null;

          if (b === "draftkings") p.dk = val;
          if (b === "fanduel") p.fd = val;
          if (b === "betmgm") p.mgm = val;
          if (b === "pinnacle") p.pin = val;
        }

        const series = Array.from(pointsMap.values()).sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

        // --- FantasyPros game logs ---
        // Expected columns:
        // fp_id, game_date, points, rebounds, assists, threes
        const statCol = dbStatKey(row.market);
        let gl: any[] = [];

        if (row.fp_id != null) {
          const { data: glData, error: glErr } = await supabase
            .from(FP_GAMELOGS_TABLE)
            .select(`fp_id, game_date, ${statCol}`)
            .eq("fp_id", row.fp_id)
            .order("game_date", { ascending: true })
            .limit(82);

          if (glErr) {
            // don't fail the whole modal for gamelog
            gl = [];
          } else {
            gl = glData as any[];
          }
        }

        const bars: GameLogRow[] = (gl ?? [])
          .filter((x) => x?.game_date)
          .map((x) => ({
            game_date: x.game_date,
            value: typeof x[statCol] === "number" ? x[statCol] : Number(x[statCol] ?? 0),
          }));

        if (!mounted) return;
        setHistory(series);
        setGamelog(bars);
      } catch (e: any) {
        if (!mounted) return;
        setErr(e?.message ?? "Failed to load modal data.");
      } finally {
        if (!mounted) return;
        setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [row.event_id, row.player_name, row.db_market, row.side, row.line, row.fp_id, row.market]);

  const title = `${row.player_name} — ${row.market} ${row.side.toLowerCase()} ${row.line}`;
  const subtitle = `${team} vs ${opp}${row.commence_time ? ` · ${row.commence_time}` : ""}`;

  return (
    <div className="fixed inset-0 z-[999]">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div className="absolute inset-x-0 bottom-0 sm:inset-0 sm:flex sm:items-center sm:justify-center p-3 sm:p-6">
        <div className="w-full sm:max-w-4xl rounded-2xl border border-[#2a2a2a] bg-[#080808] shadow-[0_30px_120px_rgba(0,0,0,0.8)] overflow-hidden">
          {/* Header */}
          <div className="p-4 border-b border-[#1f1f1f] flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
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
                  <span className="text-[12px] text-[#cfcfcf]">{initials(row.player_name)}</span>
                </div>
              )}

              <div>
                <div className="text-white text-sm sm:text-base">{title}</div>
                <div className="text-[11px] text-[#808080] mt-1">{subtitle}</div>
              </div>
            </div>

            <button
              onClick={onClose}
              className="p-2 rounded hover:bg-white/5 text-[#b0b0b0] hover:text-white"
              aria-label="Close"
              type="button"
            >
              <X size={18} />
            </button>
          </div>

          {/* Tabs */}
          <div className="px-4 pt-3">
            <div className="inline-flex items-center gap-2 rounded-xl border border-[#1f1f1f] bg-[#0b0b0b] p-1">
              <button
                type="button"
                onClick={() => setTab("history")}
                className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                  tab === "history" ? "bg-[#d4af37] text-black" : "text-[#b0b0b0] hover:text-white hover:bg-white/5"
                }`}
              >
                Line History
              </button>
              <button
                type="button"
                onClick={() => setTab("gamelog")}
                className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                  tab === "gamelog" ? "bg-[#d4af37] text-black" : "text-[#b0b0b0] hover:text-white hover:bg-white/5"
                }`}
              >
                FantasyPros Game Log
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="p-4">
            {err ? (
              <div className="mb-3 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded p-2">{err}</div>
            ) : null}

            {loading ? (
              <div className="text-xs text-[#808080]">Loading…</div>
            ) : tab === "history" ? (
              <div className="rounded-xl border border-[#1f1f1f] bg-[#0b0b0b] p-3">
                <div className="text-[11px] text-[#808080] mb-2">Line movement (by book)</div>

                {history.length === 0 ? (
                  <div className="text-xs text-[#606060]">No line history available for this prop yet.</div>
                ) : (
                  <div className="h-[260px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={history} margin={{ top: 10, right: 10, left: 0, bottom: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                        <XAxis dataKey="label" tick={{ fill: "rgba(242,241,243,0.55)", fontSize: 10 }} interval="preserveStartEnd" />
                        <YAxis tick={{ fill: "rgba(242,241,243,0.55)", fontSize: 10 }} domain={["auto", "auto"]} />
                        <Tooltip
                          contentStyle={{ background: "#0b0b0b", border: "1px solid #1f1f1f", borderRadius: 10 }}
                          labelStyle={{ color: "rgba(242,241,243,0.75)" }}
                          formatter={(v: any, name: any) => [v != null ? String(v) : "—", name]}
                        />
                        {/* No custom colors requested; default recharts colors are fine */}
                        <Line type="monotone" dataKey="dk" name="DK" dot={false} strokeWidth={2} connectNulls />
                        <Line type="monotone" dataKey="fd" name="FD" dot={false} strokeWidth={2} connectNulls />
                        <Line type="monotone" dataKey="mgm" name="MGM" dot={false} strokeWidth={2} connectNulls />
                        <Line type="monotone" dataKey="pin" name="PIN" dot={false} strokeWidth={2} connectNulls />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}

                <div className="mt-2 text-[10px] text-[#606060]">
                  Tooltip shows Central Time. (If you want odds movement instead of line movement, tell me and we’ll swap the plotted value.)
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-[#1f1f1f] bg-[#0b0b0b] p-3">
                <div className="text-[11px] text-[#808080] mb-2">
                  Last games (bars) — reference line at today’s prop line ({row.line})
                </div>

                {gamelog.length === 0 ? (
                  <div className="text-xs text-[#606060]">
                    No FantasyPros game logs found (check table name/columns or fp_id availability).
                  </div>
                ) : (
                  <div className="h-[260px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={gamelog} margin={{ top: 10, right: 10, left: 0, bottom: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                        <XAxis
                          dataKey="game_date"
                          tick={{ fill: "rgba(242,241,243,0.55)", fontSize: 10 }}
                          tickFormatter={(v) => String(v).slice(5)} // MM-DD
                          interval="preserveStartEnd"
                        />
                        <YAxis tick={{ fill: "rgba(242,241,243,0.55)", fontSize: 10 }} />
                        <Tooltip
                          contentStyle={{ background: "#0b0b0b", border: "1px solid #1f1f1f", borderRadius: 10 }}
                          labelStyle={{ color: "rgba(242,241,243,0.75)" }}
                        />
                        <ReferenceLine y={row.line} stroke="rgba(212,175,55,0.9)" strokeWidth={2} />
                        {/* Color is determined per-bar via Cell is possible, but you didn’t ask — keeping clean & readable. */}
                        <Bar dataKey="value" name="Stat" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                <div className="mt-2 text-[10px] text-[#606060]">
                  If you want bars colored green/red for over/under vs today’s line (like ModelScreen), say the word and I’ll add the per-bar coloring + no shaded cursor.
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-[#1f1f1f] flex items-center justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-[#d4af37] text-black text-xs font-semibold hover:opacity-90"
              type="button"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

