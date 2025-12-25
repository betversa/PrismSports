// screens/Model/ModelScreen.tsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

/**
 * MODEL PICKS (EV PLAYS)
 *
 * ✅ Uses public.ev_plays (no mock data)
 * ✅ One row per +EV play
 * ✅ Filter: sportsbook (SOFT books only) — default = All
 * ✅ Book column uses square logos in /public/books/
 *    - dksquare.png, fdsquare.png, mgmsquare.png
 * ✅ Bet Amount uses Settings:
 *    - app_settings.bankroll (dollars)
 *    - app_settings.kelly_factor (multiplier)
 *   Bet Amount = bankroll * (bet_fraction * kelly_factor)
 *
 * Columns: Matchup | Market | Pick | Line | Quantum | Book | SpectrumEV | Score | Bet $
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

type AppSettingsRow = {
  id: number;
  bankroll: number | null;
  kelly_factor: number | null;
  max_units_per_play?: number | null; // optional if you want to cap by units later
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

function safeNum(n: any, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function formatMoney(n: number) {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function ModelScreen() {
  const [bookFilter, setBookFilter] = useState<SoftBookKey>("all");
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<EvPlayRow[]>([]);
  const [settings, setSettings] = useState<AppSettingsRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load EV plays + settings (bankroll/kelly)
  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError(null);

      const nowIso = new Date().toISOString();

      const evQ = supabase
        .from("ev_plays")
        .select(
          "run_id,event_id,commence_time,matchup,team,market,side,line,bookmaker,book_odds,quantum_prob,quantum_odds,ev_pct,confidence_score,confidence_tier,kelly_fraction,bet_fraction,created_at"
        )
        .gte("commence_time", nowIso)
        .in("bookmaker", ["draftkings", "fanduel", "betmgm"])
        .order("commence_time", { ascending: true })
        .order("ev_pct", { ascending: false });

      const settingsQ = supabase
        .from("app_settings")
        .select("id,bankroll,kelly_factor,max_units_per_play,updated_at")
        .eq("id", 1)
        .limit(1);

      const [evRes, sRes] = await Promise.all([evQ, settingsQ]);

      if (!mounted) return;

      if (evRes.error) {
        setError(evRes.error.message);
        setRows([]);
        setLoading(false);
        return;
      }

      const evRows = (evRes.data ?? []) as EvPlayRow[];

      const filtered =
        bookFilter === "all"
          ? evRows
          : evRows.filter((r) => normalizeBookKey(r.bookmaker) === bookFilter);

      setRows(filtered);

      if (sRes.error) {
        // still render, but bet amounts will be "—"
        console.warn("[ModelScreen] app_settings error:", sRes.error.message);
        setSettings(null);
      } else {
        setSettings((sRes.data?.[0] ?? null) as AppSettingsRow | null);
      }

      setLoading(false);
    }

    load();
    return () => {
      mounted = false;
    };
  }, [bookFilter]);

  // Optional: also live-refresh if user changes settings
  useEffect(() => {
    const channel = supabase
      .channel("model-screen-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, () => {
        // lightweight: just re-fetch settings
        supabase
          .from("app_settings")
          .select("id,bankroll,kelly_factor,max_units_per_play,updated_at")
          .eq("id", 1)
          .limit(1)
          .then(({ data, error }) => {
            if (error) return;
            setSettings((data?.[0] ?? null) as AppSettingsRow | null);
          });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

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

  const bankroll = safeNum(settings?.bankroll, 0);
  const kellyFactorRaw = safeNum(settings?.kelly_factor, 0);
  const kellyFactor = clamp(kellyFactorRaw, 0, 1);

  const totalBetDollars = useMemo(() => {
    if (!bankroll || !kellyFactor) return 0;
    return rows.reduce((sum, r) => {
      const frac = Math.max(0, safeNum(r.bet_fraction, 0));
      return sum + bankroll * frac * kellyFactor;
    }, 0);
  }, [rows, bankroll, kellyFactor]);

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
            Bankroll:{" "}
            <span className="text-[#d4af37]">{bankroll ? formatMoney(bankroll) : "—"}</span>
          </div>

          <div className="px-2 py-1 bg-[#1a1a1a] rounded text-[#808080]">
            Kelly:{" "}
            <span className="text-[#d4af37]">{settings?.kelly_factor != null ? `${(kellyFactor * 100).toFixed(1)}%` : "—"}</span>
          </div>

          <div className="px-2 py-1 bg-[#1a1a1a] rounded text-[#808080]">
            Total Bet:{" "}
            <span className="text-[#d4af37]">{totalBetDollars ? formatMoney(totalBetDollars) : "—"}</span>
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

                <th className="text-left p-3 text-[#808080] min-w-[110px]">Market</th>
                <th className="text-left p-3 text-[#808080] min-w-[190px]">Pick</th>
                <th className="text-center p-3 text-[#808080] min-w-[80px]">Line</th>

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

                <th className="text-center p-3 text-[#808080] min-w-[120px]">Book</th>

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

                <th className="text-center p-3 text-[#808080] min-w-[90px]">Score</th>
                <th className="text-center p-3 text-[#808080] min-w-[120px]">Bet $</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#1a1a1a]">
              {rows.map((r) => (
                <PlayRow
                  key={`${r.event_id}|${r.market}|${r.side}|${r.bookmaker}|${r.line ?? "x"}`}
                  row={r}
                  bankroll={bankroll}
                  kellyFactor={kellyFactor}
                  settingsReady={!!(bankroll && kellyFactor)}
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
          <span className="text-[#808080]">Bet $:</span>{" "}
          bankroll × bet_fraction × kelly_factor
        </div>

        {!bankroll || !kellyFactor ? (
          <div className="text-[#808080]">
            Set <span className="text-white">Bankroll</span> and <span className="text-white">Kelly Factor</span> in Settings to enable bet amounts.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PlayRow({
  row,
  bankroll,
  kellyFactor,
  settingsReady,
}: {
  row: EvPlayRow;
  bankroll: number;
  kellyFactor: number;
  settingsReady: boolean;
}) {
  const isTotal = row.market === "totals";

  const pickLabel = isTotal ? row.matchup ?? row.team ?? "Total" : row.team ?? "—";
  const sideTxt = sideLabelForDisplay(row.market, row.side);
  const logoSrc = bookLogoSrc(row.bookmaker);

  const frac = Math.max(0, safeNum(row.bet_fraction, 0));
  const betAmount = settingsReady ? bankroll * frac * kellyFactor : NaN;

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

      {/* Bet $ */}
      <td className="p-3 text-center">
        <BetAmountValue amount={betAmount} frac={frac} bankroll={bankroll} kellyFactor={kellyFactor} ready={settingsReady} />
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

function BetAmountValue({
  amount,
  frac,
  bankroll,
  kellyFactor,
  ready,
}: {
  amount: number;
  frac: number;
  bankroll: number;
  kellyFactor: number;
  ready: boolean;
}) {
  if (!ready || !Number.isFinite(amount) || amount <= 0) {
    return <div className="text-[#404040]">—</div>;
  }

  // Show dollars prominently; tiny breakdown below so users understand it’s configurable
  return (
    <div className="inline-flex flex-col items-center justify-center">
      <div className="inline-flex items-center justify-center px-2 py-0.5 bg-[#d4af37]/20 border border-[#d4af37]/40 rounded text-[#d4af37] tabular-nums">
        {formatMoney(amount)}
      </div>
      <div className="text-[10px] text-[#606060] mt-1 tabular-nums">
        {(frac * 100).toFixed(2)}% × {Math.round(kellyFactor * 100)}% × {formatMoney(bankroll)}
      </div>
    </div>
  );
}

