// src/app/screens/PropsScreen.tsx — FULL REWRITE (Fix: remove player_prop_ev_latest.team_abbr)
// -------------------------------------------------------------------------------------------------------------
// ✅ FIX: DOES NOT select team_abbr/opp_abbr from player_prop_ev_latest
// ✅ Instead: select canonical fields, then map to abbreviations using team_map.Abbreviation / Abbreviation2
// ✅ Data: public.player_prop_ev_latest
// ✅ Settings: public.app_settings (bankroll + kelly_factor) for Bet $ sizing
// ✅ Filters: Market + Book
// ✅ Sticky: market pills stay visible; table header stays visible
// ✅ ONLY Pick cell opens modal
// ✅ Prism black/gold style
//
// IMPORTANT: set TEAM_CANON_COL / OPP_CANON_COL to your actual column names in player_prop_ev_latest.
// If your table uses "team" + "opponent" or "team_canonical" + "opp_canonical", set them below.

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

// 🔧 CHANGE THESE TWO if your schema uses different names
const TEAM_CANON_COL = "team_canonical";
const OPP_CANON_COL = "opp_canonical";

type TeamMapRow = {
  canonical: string;
  Abbreviation?: string | null;
  Abbreviation2?: string | null;
};

type PropRowDB = {
  id: string;

  sport_key?: string | null;
  event_id: string;
  commence_time?: string | null;

  player_name: string;
  position?: string | null;

  // canonical values from player_prop_ev_latest (NOT abbreviations)
  team_canonical?: string | null;
  opp_canonical?: string | null;
  is_home?: boolean | null;

  market: string;
  side: "Over" | "Under";
  line: number;

  projection: number | null;
  season_avg?: number | null;
  sigma?: number | null;

  hit_7d?: number | null;
  hit_14d?: number | null;
  hit_30d?: number | null;
  hit_season?: number | null;

  best_book: "draftkings" | "fanduel" | "betmgm";
  best_odds: number;
  prism_odds: number;
  ev_pct: number;
  prism_score?: number | null;

  units?: number | null;
};

type DerivedRow = PropRowDB & {
  team_abbr?: string;
  opp_abbr?: string;
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

function americanToProfitPer1(odds: number) {
  if (odds > 0) return odds / 100;
  return 100 / Math.abs(odds);
}

function americanToImpliedProb(odds: number) {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

function kellyFraction(pFair: number, oddsAmerican: number) {
  const b = americanToProfitPer1(oddsAmerican);
  const q = 1 - pFair;
  const f = (b * pFair - q) / b;
  return Math.max(0, f);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function normCanon(s?: string | null) {
  return (s ?? "").trim().toLowerCase();
}

export function PropsScreen() {
  const [selectedMarket, setSelectedMarket] = useState<PropMarketKey>("Points");
  const [selectedBook, setSelectedBook] = useState<BookKey>("any");

  const [settings, setSettings] = useState<AppSettingsRow | null>(null);
  const [rows, setRows] = useState<DerivedRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [activeModal, setActiveModal] = useState<DerivedRow | null>(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setErr(null);

      try {
        // 1) settings + props
        //    IMPORTANT: do NOT select team_abbr/opp_abbr here.
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
                "player_name",
                "position",
                // canonical fields ONLY (use constants)
                `${TEAM_CANON_COL}`,
                `${OPP_CANON_COL}`,
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

        const raw = ((p as any) ?? []) as any[];

        // 2) collect unique canonicals
        const canonSet = new Set<string>();
        for (const r of raw) {
          const tc = normCanon(r?.[TEAM_CANON_COL]);
          const oc = normCanon(r?.[OPP_CANON_COL]);
          if (tc) canonSet.add(tc);
          if (oc) canonSet.add(oc);
        }
        const canonList = Array.from(canonSet);

        // 3) lookup in team_map via canonical
        const teamMap: Record<string, string> = {};
        const CHUNK = 200;

        for (let i = 0; i < canonList.length; i += CHUNK) {
          const chunk = canonList.slice(i, i + CHUNK);

          const { data: tm, error: tmErr } = await supabase
            .from("team_map")
            .select("canonical, Abbreviation, Abbreviation2")
            .in("canonical", chunk);

          if (tmErr) throw tmErr;

          for (const r of (tm ?? []) as TeamMapRow[]) {
            const key = normCanon(r.canonical);
            if (!key) continue;
            const abbr = (r.Abbreviation ?? "").trim() || (r.Abbreviation2 ?? "").trim();
            if (abbr) teamMap[key] = abbr;
          }
        }

        // 4) hydrate abbreviations onto prop rows
        const derived: DerivedRow[] = raw.map((r) => {
          const teamCanon = (r?.[TEAM_CANON_COL] ?? null) as string | null;
          const oppCanon = (r?.[OPP_CANON_COL] ?? null) as string | null;

          const team_abbr = teamMap[normCanon(teamCanon)] || undefined;
          const opp_abbr = teamMap[normCanon(oppCanon)] || undefined;

          return {
            ...(r as any),
            team_canonical: teamCanon,
            opp_canonical: oppCanon,
            team_abbr,
            opp_abbr,
          } as DerivedRow;
        });

        if (!mounted) return;
        setSettings((s as any) ?? null);
        setRows(derived);
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

      {/* MODAL */}
      {activeModal ? <PropDetailsModal row={activeModal} onClose={() => setActiveModal(null)} /> : null}
    </div>
  );
}

function Row({
  row,
  bankroll,
  kellyFactor,
  onOpen,
}: {
  row: DerivedRow;
  bankroll: number;
  kellyFactor: number;
  onOpen: () => void;
}) {
  const hasPlay = (row.units ?? 0) > 0;
  const hasPositiveEV = (row.ev_pct ?? 0) > 3;

  const edge = (row.projection ?? 0) - row.line;

  const pFair = americanToImpliedProb(row.prism_odds);
  const fKelly = kellyFraction(pFair, row.best_odds);
  const betFrac = clamp(fKelly * kellyFactor, 0, 0.25);
  const betDollars = bankroll * betFrac;

  const quotes: BookQuote[] = [
    { book: "draftkings", odds: row.best_book === "draftkings" ? row.best_odds : NaN, isBest: row.best_book === "draftkings" },
    { book: "fanduel", odds: row.best_book === "fanduel" ? row.best_odds : NaN, isBest: row.best_book === "fanduel" },
    { book: "betmgm", odds: row.best_book === "betmgm" ? row.best_odds : NaN, isBest: row.best_book === "betmgm" },
  ];

  const team = row.team_abbr ?? "";
  const opp = row.opp_abbr ?? "";

  return (
    <tr className={`hover:bg-[#0f0f0f]/50 transition-colors ${hasPlay ? "bg-[#d4af37]/5" : ""}`}>
      <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10">
        <button onClick={onOpen} className="w-full text-left group" type="button">
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col">
              <span className="text-white group-hover:text-[#d4af37] transition-colors">
                {row.player_name} — {row.market} {row.side} {row.line}
              </span>
              <span className="text-[10px] text-[#606060] mt-0.5">
                {team && opp ? `${team} ${row.is_home ? "vs" : "@"} ${opp}` : "—"}
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
        {(row.hit_7d ?? 0).toFixed(0)}% <span className="text-[#606060]">/</span>{" "}
        {(row.hit_14d ?? 0).toFixed(0)}% <span className="text-[#606060]">/</span>{" "}
        {(row.hit_30d ?? 0).toFixed(0)}% <span className="text-[#606060]">/</span>{" "}
        {(row.hit_season ?? 0).toFixed(0)}%
      </td>

      <td className="p-3 text-center text-[#808080]">{(row.season_avg ?? 0).toFixed(1)}</td>
      <td className="p-3 text-center text-[#606060]">{(row.sigma ?? 0).toFixed(1)}</td>

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

      <td className="p-3 text-center text-[#b0b0b0]">{row.prism_score ?? "—"}</td>

      <td className="p-3 text-center">
        <span className="px-2 py-1 rounded border text-[10px] bg-[#0b0b0b] border-[#2a2a2a] text-white">
          {betDollars > 0 ? `$${betDollars.toFixed(0)}` : "—"}
        </span>
      </td>
    </tr>
  );
}

function PropDetailsModal({ row, onClose }: { row: DerivedRow; onClose: () => void }) {
  const team = row.team_abbr ?? "";
  const opp = row.opp_abbr ?? "";

  return (
    <div className="fixed inset-0 z-[999]">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 sm:inset-0 sm:flex sm:items-center sm:justify-center p-3 sm:p-6">
        <div className="w-full sm:max-w-2xl rounded-2xl border border-[#2a2a2a] bg-[#080808] overflow-hidden">
          <div className="p-4 border-b border-[#1f1f1f] flex items-start justify-between gap-3">
            <div>
              <div className="text-white text-sm sm:text-base">
                {row.player_name} — {row.market} {row.side} {row.line}
              </div>
              <div className="text-[11px] text-[#808080] mt-1">
                {team && opp ? `${team} ${row.is_home ? "vs" : "@"} ${opp}` : "—"}
                {row.commence_time ? ` · ${row.commence_time}` : ""}
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

          <div className="p-4">
            <div className="text-[11px] text-[#808080]">
              Abbreviations are resolved from <span className="text-white">team_map</span> by matching{" "}
              <span className="text-white">canonical</span> → <span className="text-white">Abbreviation</span>{" "}
              (fallback <span className="text-white">Abbreviation2</span>).
            </div>
          </div>

          <div className="p-4 border-t border-[#1f1f1f] flex justify-end">
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

