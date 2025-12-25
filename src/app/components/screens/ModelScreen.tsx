// screens/Model/ModelScreen.tsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

/**
 * MODEL PICKS (EV PLAYS) — FINAL REWRITE
 *
 * ✅ Uses public.ev_plays (no mock data)
 * ✅ One row per +EV play
 * ✅ Filter: sportsbook (SOFT books only) — default = All
 * ✅ Book column uses square logos in /public/books/
 *    - dksquare.png, fdsquare.png, mgmsquare.png
 * ✅ No sharp logos shown
 *
 * Columns: Matchup | Market | Pick | Line | Quantum | Book | SpectrumEV | Score | Stake %
 */

type MarketKey = "h2h" | "spreads" | "totals";
type SideKey = "home" | "away" | "over" | "under";

type EvPlayRow = {
  run_id: string;
  event_id: string;
  commence_time: string | null;
  matchup: string | null;

  team: string | null;

  market: MarketKey;
  side: SideKey;
  line: number | null;

  bookmaker: string;
  book_odds: number;

  quantum_prob: number;
  quantum_odds: number;
  ev_pct: number;

  confidence_score: number;
  confidence_tier: string;

  kelly_fraction: number;
  bet_fraction: number;

  created_at?: string;
};

type SoftBookKey = "all" | "draftkings" | "fanduel" | "betmgm";

// Only show/filter these in the dropdown (soft books only)
const SOFT_BOOKS: { key: SoftBookKey; label: string }[] = [
  { key: "all", label: "All Books" },
  { key: "draftkings", label: "DraftKings" },
  { key: "fanduel", label: "FanDuel" },
  { key: "betmgm", label: "BetMGM" },
];

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

function american(odds: number) {
  if (!Number.isFinite(odds)) return "—";
  return odds > 0 ? `+${Math.round(odds)}` : `${Math.round(odds)}`;
}

function marketLabel(market: MarketKey) {
  if (market === "h2h") return "Moneyline";
  if (market === "spreads") return "Spread";
  return "Total";
}

function sideLabelForDisplay(market: MarketKey, side: SideKey) {
  if (market === "totals") return side === "over" ? "Over" : "Under";
  return side === "home" ? "Home" : "Away";
}

function fmtLine(market: MarketKey, line: number | null) {
  if (market === "h2h") return "—";
  if (line == null || !Number.isFinite(line)) return "—";
  if (market === "spreads") return `${line > 0 ? "+" : ""}${line}`;
  return `${line}`;
}

function sumBetFraction(rows: EvPlayRow[]) {
  return rows.reduce((a, r) => a + Math.max(0, Number(r.bet_fraction ?? 0)), 0);
}

function normalizeBookKey(bookmaker: string): SoftBookKey | "other" {
  const b = (bookmaker || "").toLowerCase();
  if (b === "draftkings") return "draftkings";
  if (b === "fanduel") return "fanduel";
  if (b === "betmgm") return "betmgm";
  return "other";
}

function bookLogoSrc(bookmaker: string): string | null {
  const b = (bookmaker || "").toLowerCase();
  if (b === "draftkings") return "/books/dksquare.png";
  if (b === "fanduel") return "/books/fdsquare.png";
  if (b === "betmgm") return "/books/mgmsquare.png";
  return null;
}

function bookFallbackLabel(bookmaker: string) {
  const b = (bookmaker || "").toLowerCase();
  if (b === "draftkings") return "DK";
  if (b === "fanduel") return "FD";
  if (b === "betmgm") return "MGM";
  return (bookmaker || "BOOK").toUpperCase();
}

export function ModelScreen() {
  const [bookFilter, setBookFilter] = useState<SoftBookKey>("all");
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<EvPlayRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError(null);

      const nowIso = new Date().toISOString();

      const q = supabase
        .from("ev_plays")
        .select(
          "run_id,event_id,commence_time,matchup,team,market,side,line,bookmaker,book_odds,quantum_prob,quantum_odds,ev_pct,confidence_score,confidence_tier,kelly_fraction,bet_fraction,created_at"
        )
        .gte("commence_time", nowIso)
        // only soft books (and only those we have square logos for)
        .in("bookmaker", ["draftkings", "fanduel", "betmgm"])
        .order("commence_time", { ascending: true })
        .order("ev_pct", { ascending: false });

      const { data, error: evErr } = await q;

      if (!mounted) return;

      if (evErr) {
        setError(evErr.message);
        setRows([]);
        setLoading(false);
        return;
      }

      const evRows = (data ?? []) as EvPlayRow[];

      // Book filter (default = all soft books)
      const filtered =
        bookFilter === "all"
          ? evRows
          : evRows.filter((r) => normalizeBookKey(r.bookmaker) === bookFilter);

      setRows(filtered);
      setLoading(false);
    }

    load();
    return () => {
      mounted = false;
    };
  }, [bookFilter]);

  const updatedText = useMemo(() => {
    const latest = rows
      .map((r) => r.created_at)
      .filter(Boolean)
      .sort()
      .slice(-1)[0];
    if (!latest) return "Updated —";
    const d = new Date(latest);
    const t = d.toLocaleTimeString("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "2-digit",
    });
    return `Updated ${t} CT`;
  }, [rows]);

  const totalStakePct = useMemo(() => sumBetFraction(rows) * 100, [rows]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl text-white mb-1">Model Picks</h2>
          <p className="text-xs text-[#808080]">
            {rows.length} plays · {updatedText}
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs">
          {/* Book filter (soft books only) */}
          <select
            value={bookFilter}
            onChange={(e) => setBookFilter(e.target.value as SoftBookKey)}
            className="px-2 py-1 bg-[#111] border border-[#2a2a2a] rounded text-[#d0d0d0] outline-none"
            title="Filter by sportsbook"
          >
            {SOFT_BOOKS.map((b) => (
              <option key={b.key} value={b.key}>
                {b.label}
              </option>
            ))}
          </select>

          <div className="px-2 py-1 bg-[#1a1a1a] rounded text-[#808080]">
            Total Stake:{" "}
            <span className="text-[#d4af37]">{totalStakePct.toFixed(2)}%</span>
          </div>
        </div>
      </div>

      {/* Status */}
      {loading && (
        <div className="text-xs text-[#808080] px-3 py-2 bg-[#0f0f0f] border border-[#2a2a2a] rounded">
          Loading EV plays…
        </div>
      )}
      {error && (
        <div className="text-xs text-red-400 px-3 py-2 bg-[#0f0f0f] border border-red-900/50 rounded">
          Failed to load ev_plays: {error}
        </div>
      )}

      {/* Table */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-10 min-w-[320px]">
                  Matchup
                </th>

                <th className="text-left p-3 text-[#808080] min-w-[110px]">
                  Market
                </th>
                <th className="text-left p-3 text-[#808080] min-w-[190px]">
                  Pick
                </th>
                <th className="text-center p-3 text-[#808080] min-w-[80px]">
                  Line
                </th>

                <th className="text-center p-3 text-[#808080] min-w-[110px]">
                  <div className="flex items-center justify-center">
                    <img
                      src="/logos/Quantum.png"
                      alt="Quantum"
                      className="h-5 md:h-7 w-auto opacity-90"
                      draggable={false}
                    />
                  </div>
                </th>

                <th className="text-center p-3 text-[#808080] min-w-[120px]">
                  Book
                </th>

                <th className="text-center p-3 text-[#808080] min-w-[110px]">
                  <div className="flex items-center justify-center">
                    <img
                      src="/logos/SpectrumEV.png"
                      alt="SpectrumEV"
                      className="h-5 md:h-7 w-auto opacity-90"
                      draggable={false}
                    />
                  </div>
                </th>

                <th className="text-center p-3 text-[#808080] min-w-[90px]">
                  Score
                </th>
                <th className="text-center p-3 text-[#808080] min-w-[100px]">
                  Stake %
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#1a1a1a]">
              {rows.map((r) => (
                <PlayRow
                  key={`${r.event_id}|${r.market}|${r.side}|${r.bookmaker}|${r.line ?? "x"}`}
                  row={r}
                />
              ))}

              {!loading && !rows.length && (
                <tr>
                  <td colSpan={9} className="p-6 text-center text-xs text-[#808080]">
                    No positive EV plays found for this book filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-6 text-[10px] text-[#606060] pt-2">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-[#d4af37]/20 border border-[#d4af37]/40 rounded" />
          <span>Positive EV (ev_plays)</span>
        </div>
        <div>
          <span className="text-[#808080]">Stake %:</span> fractional Kelly (bet_fraction × 100)
        </div>
      </div>
    </div>
  );
}

function PlayRow({ row }: { row: EvPlayRow }) {
  const isTotal = row.market === "totals";

  const pickLabel = isTotal
    ? row.matchup ?? row.team ?? "Total"
    : row.team ?? "—";

  const sideTxt = sideLabelForDisplay(row.market, row.side);

  const logoSrc = bookLogoSrc(row.bookmaker);

  return (
    <tr className="hover:bg-[#0f0f0f]/50 transition-colors">
      {/* Matchup */}
      <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10 min-w-[320px]">
        <div className="text-white">
          {row.matchup ?? "—"}
          <span className="text-[#606060]"> · </span>
          <span className="text-[#b0b0b0]">{fmtDateCentral(row.commence_time)}</span>
          <span className="text-[#606060]"> </span>
          <span className="text-[#b0b0b0]">{fmtTimeCentral(row.commence_time)}</span>
        </div>
        <div className="text-[10px] text-[#606060] mt-0.5">
          Event: <span className="text-[#404040]">{row.event_id}</span>
        </div>
      </td>

      {/* Market */}
      <td className="p-3 text-left">
        <div className="text-white">{marketLabel(row.market)}</div>
        <div className="text-[10px] text-[#606060] mt-0.5">{sideTxt}</div>
      </td>

      {/* Pick */}
      <td className="p-3 text-left">
        <div className="text-white">{pickLabel}</div>
      </td>

      {/* Line */}
      <td className="p-3 text-center">
        <div className="text-white">{fmtLine(row.market, row.line)}</div>
      </td>

      {/* Quantum */}
      <td className="p-3 text-center">
        <div className="text-white font-semibold">{american(row.quantum_odds)}</div>
      </td>

      {/* Book (logo + odds) */}
      <td className="p-3 text-center">
        <div className="inline-flex items-center justify-center gap-2">
          {logoSrc ? (
            <img
              src={logoSrc}
              alt={bookFallbackLabel(row.bookmaker)}
              className="h-5 w-5 md:h-6 md:w-6 opacity-95 shrink-0"
              draggable={false}
            />
          ) : (
            <div className="h-5 w-5 md:h-6 md:w-6 rounded bg-[#1a1a1a] border border-[#2a2a2a] flex items-center justify-center text-[10px] text-[#808080] shrink-0">
              {bookFallbackLabel(row.bookmaker)}
            </div>
          )}

          <div className="text-white font-semibold tabular-nums">
            {american(row.book_odds)}
          </div>
        </div>
      </td>

      {/* SpectrumEV */}
      <td className="p-3 text-center">
        <div className="text-[#d4af37] tabular-nums">
          {row.ev_pct > 0 ? "+" : ""}
          {Number(row.ev_pct).toFixed(1)}%
        </div>
      </td>

      {/* Score */}
      <td className="p-3 text-center">
        <ScoreValue value={row.confidence_score} tier={row.confidence_tier} />
      </td>

      {/* Stake % */}
      <td className="p-3 text-center">
        <StakeValue frac={row.bet_fraction} />
      </td>
    </tr>
  );
}

function ScoreValue({ value, tier }: { value: number; tier?: string }) {
  const v = Number(value ?? 0);
  let color = "text-[#606060]";
  if (v >= 85) color = "text-[#d4af37]";
  else if (v >= 70) color = "text-white";

  return (
    <div className={color}>
      {Math.round(v)}
      {tier ? <span className="text-[10px] text-[#606060]"> {tier}</span> : null}
    </div>
  );
}

function StakeValue({ frac }: { frac: number }) {
  const pct = Math.max(0, Number(frac ?? 0)) * 100;
  if (pct <= 0) return <div className="text-[#404040]">—</div>;

  return (
    <div className="inline-flex items-center justify-center px-2 py-0.5 bg-[#d4af37]/20 border border-[#d4af37]/40 rounded text-[#d4af37] tabular-nums">
      {pct.toFixed(2)}%
    </div>
  );
}

