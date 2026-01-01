// src/app/screens/PropsScreen.tsx — FULL REWRITE (Supabase + Prism UI + Sticky filters + Best-book strip + Pick-only modal)
// -------------------------------------------------------------------------------------------------------------
// ✅ Data: pulls from public.player_prop_ev_latest (swap if your table differs)
// ✅ Settings: pulls from public.app_settings (bankroll + kelly_factor) for Bet $ sizing
// ✅ 1 row per play, shows DK / FD / MGM strip, highlights best book
// ✅ Filters: Market + Book
// ✅ Sticky: market pills stay visible; table header stays visible
// ✅ ONLY the Pick cell opens the modal
// ✅ Visual: matches Prism black/gold glass style
//
// NOTE: Replace field names if your schema differs.

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { X } from "lucide-react";

type BookKey = "draftkings" | "fanduel" | "betmgm" | "any";
type PropMarketKey =
  | "Points"
  | "Rebounds"
  | "Assists"
  | "3PM"
  | "PRA"
  | "Blocks"
  | "Steals";

type AppSettingsRow = {
  bankroll: number | null;
  kelly_factor: number | null;
};

type PropRowDB = {
  id: string;

  // identity
  sport_key?: string | null;
  event_id: string;
  commence_time?: string | null;

  player_name: string;
  position?: string | null;

  team_abbr?: string | null;
  opp_abbr?: string | null;
  is_home?: boolean | null;

  market: string; // maps to PropMarketKey
  side: "Over" | "Under";
  line: number;

  projection: number | null; // model projection
  season_avg?: number | null;
  sigma?: number | null;

  // hit rates
  hit_7d?: number | null;
  hit_14d?: number | null;
  hit_30d?: number | null;
  hit_season?: number | null;

  // best book + value
  best_book: "draftkings" | "fanduel" | "betmgm";
  best_odds: number; // american
  prism_odds: number; // american fair line
  ev_pct: number; // already percent (e.g. 6.2)
  prism_score?: number | null;

  // optional precomputed units; we’ll compute bet $ anyway
  units?: number | null;
};

type BookQuote = {
  book: Exclude<BookKey, "any">;
  odds: number;
  isBest: boolean;
};

const MARKETS: PropMarketKey[] = [
  "Points",
  "Rebounds",
  "Assists",
  "3PM",
  "PRA",
  "Blocks",
  "Steals",
];

const BOOKS: { key: BookKey; label: string }[] = [
  { key: "any", label: "Any" },
  { key: "draftkings", label: "DK" },
  { key: "fanduel", label: "FD" },
  { key: "betmgm", label: "MGM" },
];

function bookLabel(b: string) {
  if (b === "draftkings") return "DK";
  if (b === "fanduel") return "FD";
  if (b === "betmgm") return "MGM";
  return b.toUpperCase();
}

function formatAmerican(odds: number) {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

// Convert American odds to decimal payout (profit per 1 stake) for EV sizing helpers
function americanToProfitPer1(odds: number) {
  if (odds > 0) return odds / 100;
  return 100 / Math.abs(odds);
}

// Convert American odds to implied probability
function americanToImpliedProb(odds: number) {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

// Kelly fraction using fair prob vs best book odds
function kellyFraction(pFair: number, oddsAmerican: number) {
  const b = americanToProfitPer1(oddsAmerican);
  const q = 1 - pFair;
  // f* = (bp - q) / b
  const f = (b * pFair - q) / b;
  return Math.max(0, f);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export function PropsScreen() {
  const [selectedMarket, setSelectedMarket] = useState<PropMarketKey>("Points");
  const [selectedBook, setSelectedBook] = useState<BookKey>("any");

  const [settings, setSettings] = useState<AppSettingsRow | null>(null);
  const [rows, setRows] = useState<PropRowDB[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [activeModal, setActiveModal] = useState<PropRowDB | null>(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setErr(null);

      try {
        const [{ data: s, error: sErr }, { data: p, error: pErr }] = await Promise.all([
          supabase
            .from("app_settings")
            .select("bankroll, kelly_factor")
            .limit(1)
            .maybeSingle(),
          supabase
            .from("player_prop_ev_latest")
            .select(
              [
                "id",
                "sport_key",
                "event_id",
                "commence_time",
                "player_name",
                "position",
                "team_abbr",
                "opp_abbr",
                "is_home",
                "market",
                "side",
                "line",
                "projection",
                "season_avg",
                "sigma",
                "hit_7d",
                "hit_14d",
                "hit_30d",
                "hit_season",
                "best_book",
                "best_odds",
                "prism_odds",
                "ev_pct",
                "prism_score",
                "units",
              ].join(",")
            )
            .order("ev_pct", { ascending: false })
            .limit(500),
        ]);

        if (sErr) throw sErr;
        if (pErr) throw pErr;

        if (!mounted) return;

        setSettings((s as any) ?? null);
        setRows((p as any) ?? []);
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
    const byMarket = rows.filter((r) => (r.market ?? "") === selectedMarket);
    if (selectedBook === "any") return byMarket;
    return byMarket.filter((r) => r.best_book === selectedBook);
  }, [rows, selectedMarket, selectedBook]);

  const bankroll = settings?.bankroll ?? 300;
  const kellyFactor = settings?.kelly_factor ?? 0.25;

  const summary = useMemo(() => {
    const active = filtered.filter((r) => (r.units ?? 0) > 0).length;
    const totalUnits = filtered.reduce((sum, r) => sum + (r.units ?? 0), 0);
    return { active, totalUnits };
  }, [filtered]);

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
                {loading ? "Loading…" : `${filtered.length} props · ${summary.active} active bets`}
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
                Total Units: <span className="text-[#d4af37]">{summary.totalUnits.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {err ? (
            <div className="mt-3 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded p-2">
              {err}
            </div>
          ) : null}
        </div>

        {/* STICKY FILTER BAR */}
        <div className="sticky top-0 z-30 border-t border-[#1f1f1f] bg-[#060606]/90 backdrop-blur supports-[backdrop-filter]:bg-[#060606]/70">
          <div className="p-3 sm:p-4 flex flex-col gap-3">
            {/* Market pills */}
            <div className="flex items-center gap-2 flex-wrap">
              {MARKETS.map((m) => (
                <button
                  key={m}
                  onClick={() => setSelectedMarket(m)}
                  className={`px-3 py-1.5 text-xs rounded-full transition-colors border ${
                    selectedMarket === m
                      ? "bg-[#d4af37] text-black border-[#d4af37]"
                      : "bg-[#101010] text-[#b0b0b0] border-[#2a2a2a] hover:bg-[#1a1a1a] hover:text-white"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>

            {/* Book filter */}
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
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* TABLE */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-[124px] sm:top-[132px] z-20">
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-30 min-w-[240px]">
                  Pick
                </th>
                <th className="text-left p-3 text-[#808080]">Team</th>
                <th className="text-left p-3 text-[#808080]">Opp</th>
                <th className="text-center p-3 text-[#808080]">Proj</th>
                <th className="text-center p-3 text-[#808080]">Line</th>
                <th className="text-center p-3 text-[#808080]">Edge</th>
                <th className="text-center p-3 text-[#808080]">Hit% (7/14/30/Seas)</th>
                <th className="text-center p-3 text-[#808080]">Avg</th>
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
                  <td className="p-4 text-[#808080]" colSpan={14}>
                    Loading props…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td className="p-4 text-[#808080]" colSpan={14}>
                    No props for this filter.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
                  <Row
                    key={r.id}
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

      {/* LEGEND */}
      <div className="flex items-center gap-6 text-[10px] text-[#606060] pt-2 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-[#d4af37]/20 border border-[#d4af37]/40 rounded" />
          <span>Active bet (units &gt; 0)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-emerald-500/20 border border-emerald-500/40 rounded" />
          <span>Positive EV (&gt;3%)</span>
        </div>
        <div>
          <span className="text-[#808080]">Edge:</span> Projection − Line
        </div>
      </div>

      {/* MODAL */}
      {activeModal ? (
        <PropDetailsModal row={activeModal} onClose={() => setActiveModal(null)} />
      ) : null}
    </div>
  );
}

function Row({
  row,
  bankroll,
  kellyFactor,
  onOpen,
}: {
  row: PropRowDB;
  bankroll: number;
  kellyFactor: number;
  onOpen: () => void;
}) {
  const hasPositiveEV = (row.ev_pct ?? 0) > 3;
  const hasPlay = (row.units ?? 0) > 0;

  const edge = (row.projection ?? 0) - row.line;

  // fair probability implied from prism_odds (your “fair” line)
  const pFair = americanToImpliedProb(row.prism_odds);
  const fKelly = kellyFraction(pFair, row.best_odds);
  const betFrac = clamp(fKelly * kellyFactor, 0, 0.25); // safety cap (25% of bankroll)
  const betDollars = bankroll * betFrac;

  // We only have best book in this table; if you later add dk_odds/fd_odds/mgm_odds columns,
  // you can populate all three. For now we show best in a 3-pill strip.
  const quotes: BookQuote[] = [
    { book: "draftkings", odds: row.best_book === "draftkings" ? row.best_odds : NaN, isBest: row.best_book === "draftkings" },
    { book: "fanduel", odds: row.best_book === "fanduel" ? row.best_odds : NaN, isBest: row.best_book === "fanduel" },
    { book: "betmgm", odds: row.best_book === "betmgm" ? row.best_odds : NaN, isBest: row.best_book === "betmgm" },
  ];

  const team = row.team_abbr ?? "";
  const opp = row.opp_abbr ?? "";

  return (
    <tr className={`hover:bg-[#0f0f0f]/50 transition-colors ${hasPlay ? "bg-[#d4af37]/5" : ""}`}>
      {/* Pick (ONLY clickable area) */}
      <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10">
        <button
          onClick={onOpen}
          className="w-full text-left group"
          title="Open details"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col">
              <span className="text-white group-hover:text-[#d4af37] transition-colors">
                {row.player_name} — {row.market} {row.side} {row.line}
              </span>
              <span className="text-[10px] text-[#606060] mt-0.5">
                {team && opp ? `${team} ${row.is_home ? "vs" : "@"} ${opp}` : ""}
                {row.position ? ` · ${row.position}` : ""}
              </span>
            </div>
            <span className={`text-[10px] px-2 py-0.5 rounded ${hasPlay ? "bg-[#d4af37] text-black" : "bg-[#141414] text-[#808080]"}`}>
              {row.side}
            </span>
          </div>
        </button>
      </td>

      <td className="p-3 text-[#b0b0b0]">{team || "—"}</td>
      <td className="p-3 text-[#b0b0b0]">{opp || "—"}</td>

      <td className="p-3 text-center text-white">{(row.projection ?? 0).toFixed(1)}</td>
      <td className="p-3 text-center text-[#b0b0b0]">{row.line.toFixed(1)}</td>

      <td className={`p-3 text-center ${Math.abs(edge) > 2 ? "text-[#d4af37]" : "text-[#808080]"}`}>
        {edge > 0 ? "+" : ""}
        {edge.toFixed(1)}
      </td>

      <td className="p-3 text-center text-[#b0b0b0]">
        <span className={row.hit_7d && row.hit_7d > 60 ? "text-emerald-400" : ""}>{(row.hit_7d ?? 0).toFixed(0)}%</span>
        <span className="text-[#606060]"> / </span>
        <span className={row.hit_14d && row.hit_14d > 60 ? "text-emerald-400" : ""}>{(row.hit_14d ?? 0).toFixed(0)}%</span>
        <span className="text-[#606060]"> / </span>
        <span className={row.hit_30d && row.hit_30d > 60 ? "text-emerald-400" : ""}>{(row.hit_30d ?? 0).toFixed(0)}%</span>
        <span className="text-[#606060]"> / </span>
        <span className={row.hit_season && row.hit_season > 60 ? "text-emerald-400" : ""}>{(row.hit_season ?? 0).toFixed(0)}%</span>
      </td>

      <td className="p-3 text-center text-[#808080]">{(row.season_avg ?? 0).toFixed(1)}</td>
      <td className="p-3 text-center text-[#606060]">{(row.sigma ?? 0).toFixed(1)}</td>

      {/* Books strip (best highlighted) */}
      <td className="p-3 text-center">
        <div className="inline-flex items-center gap-1">
          {quotes.map((q) => (
            <span
              key={q.book}
              className={`px-2 py-1 rounded border text-[10px] ${
                q.isBest
                  ? "bg-[#d4af37]/15 border-[#d4af37]/40 text-[#d4af37]"
                  : "bg-[#101010] border-[#2a2a2a] text-[#666666]"
              }`}
              title={q.isBest ? `Best: ${bookLabel(q.book)} ${formatAmerican(row.best_odds)}` : `${bookLabel(q.book)}`}
            >
              {bookLabel(q.book)}
            </span>
          ))}
        </div>
      </td>

      <td className="p-3 text-center text-white">{formatAmerican(row.prism_odds)}</td>

      <td className={`p-3 text-center ${hasPositiveEV ? "text-emerald-400" : "text-[#808080]"}`}>
        {row.ev_pct > 0 ? "+" : ""}
        {row.ev_pct.toFixed(1)}%
      </td>

      <td className={`p-3 text-center ${
        (row.prism_score ?? 0) > 75 ? "text-[#d4af37]" : (row.prism_score ?? 0) > 60 ? "text-white" : "text-[#808080]"
      }`}>
        {row.prism_score ?? "—"}
      </td>

      <td className="p-3 text-center">
        <span className={`px-2 py-1 rounded border text-[10px] ${
          betDollars > 0 ? "bg-[#0b0b0b] border-[#2a2a2a] text-white" : "bg-[#0b0b0b] border-[#1a1a1a] text-[#606060]"
        }`}>
          {betDollars > 0 ? `$${betDollars.toFixed(0)}` : "—"}
        </span>
      </td>
    </tr>
  );
}

function PropDetailsModal({ row, onClose }: { row: PropRowDB; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[999]">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 sm:inset-0 sm:flex sm:items-center sm:justify-center p-3 sm:p-6">
        <div className="w-full sm:max-w-2xl rounded-2xl border border-[#2a2a2a] bg-[#080808] shadow-[0_30px_120px_rgba(0,0,0,0.8)] overflow-hidden">
          {/* Header */}
          <div className="p-4 border-b border-[#1f1f1f] flex items-start justify-between gap-3">
            <div>
              <div className="text-white text-sm sm:text-base">
                {row.player_name} — {row.market} {row.side} {row.line}
              </div>
              <div className="text-[11px] text-[#808080] mt-1">
                {row.team_abbr ? row.team_abbr : ""} {row.is_home ? "vs" : "@"} {row.opp_abbr ? row.opp_abbr : ""}
                {row.commence_time ? ` · ${row.commence_time}` : ""}
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded hover:bg-white/5 text-[#b0b0b0] hover:text-white"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          {/* Body */}
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="Proj" value={(row.projection ?? 0).toFixed(1)} />
              <Stat label="Line" value={row.line.toFixed(1)} />
              <Stat label="Prism" value={formatAmerican(row.prism_odds)} />
              <Stat label="Best" value={`${bookLabel(row.best_book)} ${formatAmerican(row.best_odds)}`} />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="EV%" value={`${row.ev_pct > 0 ? "+" : ""}${row.ev_pct.toFixed(1)}%`} highlight={row.ev_pct > 3} />
              <Stat label="Score" value={`${row.prism_score ?? "—"}`} highlight={(row.prism_score ?? 0) > 75} />
              <Stat label="Hit 30D" value={`${(row.hit_30d ?? 0).toFixed(0)}%`} />
              <Stat label="Hit Seas" value={`${(row.hit_season ?? 0).toFixed(0)}%`} />
            </div>

            <div className="text-[11px] text-[#808080] leading-relaxed">
              This modal is intentionally minimal right now (no scroll trap). If you want, we can add the same
              tabbed layout you used on ModelScreen: <span className="text-white">Line History</span> +{" "}
              <span className="text-white">Hit Rate</span>.
            </div>
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-[#1f1f1f] flex items-center justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-[#d4af37] text-black text-xs font-semibold hover:opacity-90"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-2 ${highlight ? "border-[#d4af37]/40 bg-[#d4af37]/10" : "border-[#1f1f1f] bg-[#0b0b0b]"}`}>
      <div className="text-[10px] text-[#808080]">{label}</div>
      <div className={`text-xs mt-1 ${highlight ? "text-[#d4af37]" : "text-white"}`}>{value}</div>
    </div>
  );
}
