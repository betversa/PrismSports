// src/app/screens/PropsScreen.tsx — FULL REWRITE
// -------------------------------------------------------------------------------------------------------------
// ✅ FIX: player_prop_ev_latest.team_abbr DOES NOT EXIST -> derive abbreviations from team_map
// ✅ Uses player_prop_ev_latest.team + player_prop_ev_latest.opponent (canonical names)
// ✅ team_map lookup: canonical -> Abbreviation (fallback Abbreviation2)
// ✅ Adds player pictures via player_prop_ev_latest.picture_url (with fallback avatar)
// ✅ Aggregates to 1 row per prop, displays DK/FD/MGM strip, highlights best book
// ✅ Bet $ uses app_settings.bankroll + app_settings.kelly_factor * kelly_fraction (capped)
// ✅ Sticky filters + sticky table header
// ✅ ONLY Pick cell opens modal

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { X } from "lucide-react";

type BookKey = "draftkings" | "fanduel" | "betmgm" | "any";
type BookSoft = Exclude<BookKey, "any">;

type PropMarketKey =
  | "Points"
  | "Rebounds"
  | "Assists"
  | "3PM";

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

  team?: string | null; // canonical team name
  opponent?: string | null; // canonical opponent name
  fp_id?: number | null;

  player_name: string;
  position?: string | null;
  picture_url?: string | null;

  market: string;
  side: "Over" | "Under";
  line: number;

  // model outputs (your table uses mu + sigma)
  mu?: number | null;
  sigma?: number | null;

  // book + value
  book: string; // draftkings / fanduel / betmgm / etc
  odds: number; // american
  quantum_fair_odds?: number | null; // "Prism" fair line
  ev_pct: number; // percent (ex: 3.05)
  kelly_fraction?: number | null; // 0..1
  score?: number | null; // your score index
};

type BookQuote = {
  book: BookSoft;
  odds: number | null;
  ev_pct: number | null;
  isBest: boolean;
};

type AggRow = {
  key: string;

  // identity
  sport_key?: string | null;
  event_id: string;
  commence_time?: string | null;

  player_name: string;
  position?: string | null;
  picture_url?: string | null;

  team_canonical?: string | null;
  opp_canonical?: string | null;
  team_abbr?: string;
  opp_abbr?: string;

  market: PropMarketKey;
  side: "Over" | "Under";
  line: number;

  mu?: number | null;
  sigma?: number | null;

  // best selection among DK/FD/MGM (by highest ev_pct)
  best_book: BookSoft;
  best_odds: number;
  best_ev_pct: number;
  best_score?: number | null;
  best_kelly_fraction?: number | null;

  prism_odds?: number | null;

  // quotes strip
  quotes: Record<BookSoft, { odds: number | null; ev_pct: number | null }>;
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

const SOFT_BOOKS: BookSoft[] = ["draftkings", "fanduel", "betmgm"];

function normCanon(s?: string | null) {
  return (s ?? "").trim().toLowerCase();
}

function bookLabel(b: string) {
  if (b === "draftkings") return "DK";
  if (b === "fanduel") return "FD";
  if (b === "betmgm") return "MGM";
  return b.toUpperCase();
}

function formatAmerican(odds: number) {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function toMarketKey(m: string): PropMarketKey | null {
  // Map your DB "market" values into UI labels if needed.
  // If your DB already uses Points/Rebounds/etc, this is a straight pass-through.
  const v = (m ?? "").trim();
  if (MARKETS.includes(v as PropMarketKey)) return v as PropMarketKey;

  // Optional aliases (uncomment/extend if your DB uses snake_case):
  // const map: Record<string, PropMarketKey> = {
  //   player_points: "Points",
  //   player_rebounds: "Rebounds",
  //   player_assists: "Assists",
  //   player_threes: "3PM",
  //   player_points_rebounds_assists: "PRA",
  //   player_blocks: "Blocks",
  //   player_steals: "Steals",
  // };
  // return map[v] ?? null;

  return null;
}

function initials(name: string) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "";
  const b = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (a + b).toUpperCase();
}

function isSoftBook(b: string): b is BookSoft {
  return b === "draftkings" || b === "fanduel" || b === "betmgm";
}

export function PropsScreen() {
  const [selectedMarket, setSelectedMarket] = useState<PropMarketKey>("Points");
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
                "mu",
                "sigma",
                "book",
                "odds",
                "quantum_fair_odds",
                "ev_pct",
                "kelly_fraction",
                "score",
              ].join(",")
            )
            .order("ev_pct", { ascending: false })
            .limit(1500),
        ]);

        if (sErr) throw sErr;
        if (pErr) throw pErr;

        const quotes = ((p as any) ?? []) as PropQuoteDB[];

        // --- Build team_map lookup for abbreviations ---
        const canonSet = new Set<string>();
        for (const q of quotes) {
          const t = normCanon(q.team);
          const o = normCanon(q.opponent);
          if (t) canonSet.add(t);
          if (o) canonSet.add(o);
        }
        const canonList = Array.from(canonSet);

        const canonToAbbr: Record<string, string> = {};
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
            const abbr = (r.Abbreviation ?? "").trim() || (r.Abbreviation2 ?? "").trim();
            if (key && abbr) canonToAbbr[key] = abbr;
          }
        }

        // --- Aggregate to 1 row per (event, player, market, side, line) ---
        const map = new Map<string, AggRow>();

        for (const q of quotes) {
          const mKey = toMarketKey(q.market);
          if (!mKey) continue;

          // Only keep soft books in strip aggregation
          if (!isSoftBook(q.book)) continue;

          const key = [
            q.event_id,
            q.player_name,
            mKey,
            q.side,
            Number(q.line).toFixed(3),
          ].join("|");

          const teamCanon = q.team ?? null;
          const oppCanon = q.opponent ?? null;

          const team_abbr = canonToAbbr[normCanon(teamCanon)] || undefined;
          const opp_abbr = canonToAbbr[normCanon(oppCanon)] || undefined;

          if (!map.has(key)) {
            map.set(key, {
              key,
              sport_key: q.sport_key ?? null,
              event_id: q.event_id,
              commence_time: q.commence_time ?? null,

              player_name: q.player_name,
              position: q.position ?? null,
              picture_url: q.picture_url ?? null,

              team_canonical: teamCanon,
              opp_canonical: oppCanon,
              team_abbr,
              opp_abbr,

              market: mKey,
              side: q.side,
              line: q.line,

              mu: q.mu ?? null,
              sigma: q.sigma ?? null,

              best_book: q.book,
              best_odds: q.odds,
              best_ev_pct: q.ev_pct ?? 0,
              best_score: q.score ?? null,
              best_kelly_fraction: q.kelly_fraction ?? null,

              prism_odds: q.quantum_fair_odds ?? null,

              quotes: {
                draftkings: { odds: null, ev_pct: null },
                fanduel: { odds: null, ev_pct: null },
                betmgm: { odds: null, ev_pct: null },
              },
            });
          }

          const row = map.get(key)!;

          // Prefer keeping non-null picture_url if some rows missing it
          if (!row.picture_url && q.picture_url) row.picture_url = q.picture_url;

          // Update abbreviations if found
          if (!row.team_abbr && team_abbr) row.team_abbr = team_abbr;
          if (!row.opp_abbr && opp_abbr) row.opp_abbr = opp_abbr;

          // Fill book quote
          row.quotes[q.book] = { odds: q.odds, ev_pct: q.ev_pct ?? null };

          // Choose best among soft books by EV%
          if ((q.ev_pct ?? -999) > (row.best_ev_pct ?? -999)) {
            row.best_ev_pct = q.ev_pct ?? 0;
            row.best_book = q.book;
            row.best_odds = q.odds;
            row.best_score = q.score ?? null;
            row.best_kelly_fraction = q.kelly_fraction ?? null;
            row.prism_odds = q.quantum_fair_odds ?? row.prism_odds ?? null;
          }
        }

        // Sort by EV desc (or score if you prefer)
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
    const byMarket = rows.filter((r) => r.market === selectedMarket);
    if (selectedBook === "any") return byMarket;
    return byMarket.filter((r) => r.best_book === selectedBook);
  }, [rows, selectedMarket, selectedBook]);

  const bankroll = settings?.bankroll ?? 300;
  const kellyFactor = settings?.kelly_factor ?? 0.25;

  const summary = useMemo(() => {
    const active = filtered.filter((r) => (r.best_kelly_fraction ?? 0) > 0).length;
    const totalEV = filtered.reduce((sum, r) => sum + (r.best_ev_pct ?? 0), 0);
    return { active, totalEV };
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
                {loading ? "Loading…" : `${filtered.length} props · ${summary.active} playable`}
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
                Avg EV:{" "}
                <span className="text-[#d4af37]">
                  {filtered.length ? (summary.totalEV / filtered.length).toFixed(1) : "0.0"}%
                </span>
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

      {/* TABLE */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-[124px] sm:top-[132px] z-20">
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-30 min-w-[320px]">
                  Pick
                </th>
                <th className="text-left p-3 text-[#808080]">Team</th>
                <th className="text-left p-3 text-[#808080]">Opp</th>
                <th className="text-center p-3 text-[#808080]">μ</th>
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
                  <Row
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

function Row({
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
  const team = row.team_abbr ?? "";
  const opp = row.opp_abbr ?? "";

  const mu = row.mu ?? 0;
  const edge = mu - row.line;

  const hasPositiveEV = (row.best_ev_pct ?? 0) > 3;

  // Bet sizing: bankroll * kelly_factor * kelly_fraction (cap)
  const kf = row.best_kelly_fraction ?? 0;
  const betFrac = clamp(kf * kellyFactor, 0, 0.25);
  const betDollars = bankroll * betFrac;

  const quotesArr: BookQuote[] = SOFT_BOOKS.map((b) => ({
    book: b,
    odds: row.quotes[b]?.odds ?? null,
    ev_pct: row.quotes[b]?.ev_pct ?? null,
    isBest: row.best_book === b,
  }));

  return (
    <tr className={`hover:bg-[#0f0f0f]/50 transition-colors ${betDollars > 0 ? "bg-[#d4af37]/5" : ""}`}>
      {/* Pick (ONLY clickable area) */}
      <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10">
        <button onClick={onOpen} className="w-full text-left group" title="Open details" type="button">
          <div className="flex items-start gap-3">
            {/* Avatar */}
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
                    {row.player_name} — {row.market} {row.side} {row.line}
                  </div>
                  <div className="text-[10px] text-[#606060] mt-0.5 truncate">
                    {team && opp ? `${team} ${"vs"} ${opp}` : row.team_canonical ?? "—"}
                    {row.position ? ` · ${row.position}` : ""}
                  </div>
                </div>

                <span
                  className={`text-[10px] px-2 py-0.5 rounded border ${
                    row.side === "Over"
                      ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-300"
                      : "bg-red-500/10 border-red-500/20 text-red-300"
                  }`}
                >
                  {row.side}
                </span>
              </div>
            </div>
          </div>
        </button>
      </td>

      <td className="p-3 text-[#b0b0b0]">{team || "—"}</td>
      <td className="p-3 text-[#b0b0b0]">{opp || "—"}</td>

      <td className="p-3 text-center text-white">{mu.toFixed(1)}</td>
      <td className="p-3 text-center text-[#b0b0b0]">{row.line.toFixed(1)}</td>

      <td className={`p-3 text-center ${Math.abs(edge) > 2 ? "text-[#d4af37]" : "text-[#808080]"}`}>
        {edge > 0 ? "+" : ""}
        {edge.toFixed(1)}
      </td>

      <td className="p-3 text-center text-[#606060]">{(row.sigma ?? 0).toFixed(1)}</td>

      {/* Books strip */}
      <td className="p-3 text-center">
        <div className="inline-flex items-center gap-1">
          {quotesArr.map((q) => (
            <span
              key={q.book}
              className={`px-2 py-1 rounded border text-[10px] ${
                q.isBest
                  ? "bg-[#d4af37]/15 border-[#d4af37]/40 text-[#d4af37]"
                  : "bg-[#101010] border-[#2a2a2a] text-[#777777]"
              }`}
              title={
                q.odds != null
                  ? `${bookLabel(q.book)} ${formatAmerican(q.odds)}${q.ev_pct != null ? ` · EV ${q.ev_pct.toFixed(1)}%` : ""}`
                  : `${bookLabel(q.book)}`
              }
            >
              {bookLabel(q.book)}
            </span>
          ))}
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
            betDollars > 0
              ? "bg-[#0b0b0b] border-[#2a2a2a] text-white"
              : "bg-[#0b0b0b] border-[#1a1a1a] text-[#606060]"
          }`}
        >
          {betDollars > 0 ? `$${betDollars.toFixed(0)}` : "—"}
        </span>
      </td>
    </tr>
  );
}

function PropDetailsModal({ row, onClose }: { row: AggRow; onClose: () => void }) {
  const team = row.team_abbr ?? "";
  const opp = row.opp_abbr ?? "";

  return (
    <div className="fixed inset-0 z-[999]">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 sm:inset-0 sm:flex sm:items-center sm:justify-center p-3 sm:p-6">
        <div className="w-full sm:max-w-2xl rounded-2xl border border-[#2a2a2a] bg-[#080808] shadow-[0_30px_120px_rgba(0,0,0,0.8)] overflow-hidden">
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
                <div className="text-white text-sm sm:text-base">
                  {row.player_name} — {row.market} {row.side} {row.line}
                </div>
                <div className="text-[11px] text-[#808080] mt-1">
                  {team && opp ? `${team} vs ${opp}` : row.team_canonical ?? "—"}
                  {row.commence_time ? ` · ${row.commence_time}` : ""}
                </div>
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

          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <MiniStat label="μ" value={(row.mu ?? 0).toFixed(1)} />
              <MiniStat label="Line" value={row.line.toFixed(1)} />
              <MiniStat label="Prism" value={row.prism_odds != null ? formatAmerican(row.prism_odds) : "—"} />
              <MiniStat label="Best" value={`${bookLabel(row.best_book)} ${formatAmerican(row.best_odds)}`} />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <MiniStat label="EV%" value={`${row.best_ev_pct > 0 ? "+" : ""}${row.best_ev_pct.toFixed(1)}%`} highlight={row.best_ev_pct > 3} />
              <MiniStat label="Score" value={row.best_score != null ? row.best_score.toFixed(0) : "—"} highlight={(row.best_score ?? 0) > 80} />
              <MiniStat label="Sigma" value={(row.sigma ?? 0).toFixed(1)} />
              <MiniStat label="Edge" value={((row.mu ?? 0) - row.line).toFixed(1)} highlight={Math.abs((row.mu ?? 0) - row.line) > 2} />
            </div>
          </div>

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

function MiniStat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-2 ${highlight ? "border-[#d4af37]/40 bg-[#d4af37]/10" : "border-[#1f1f1f] bg-[#0b0b0b]"}`}>
      <div className="text-[10px] text-[#808080]">{label}</div>
      <div className={`text-xs mt-1 ${highlight ? "text-[#d4af37]" : "text-white"}`}>{value}</div>
    </div>
  );
}

