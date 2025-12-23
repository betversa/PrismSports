import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Market = "ml" | "spread" | "total";

type SpreadCell = { line: number | null; odds: number | null };
type TotalCell = { line: number | null; over: number | null; under: number | null };

type SideOdds = {
  side: "AWAY" | "HOME";
  team: string;
  logoUrl: string | null;

  ml: { dk: number | null; fd: number | null; mgm: number | null; pin: number | null; bol: number | null };

  spread: { dk: SpreadCell; fd: SpreadCell; mgm: SpreadCell; pin: SpreadCell; bol: SpreadCell };

  total: { dk: TotalCell; fd: TotalCell; mgm: TotalCell; pin: TotalCell; bol: TotalCell };

  updatedAt: string | null;
};

type EventOdds = {
  eventId: string;
  commenceTime: string;
  away?: SideOdds;
  home?: SideOdds;
  latestUpdatedAt: string | null;
};

const CT_TZ = "America/Chicago";

/** Normalize Supabase timestamps so Date() parses consistently.
 * Handles:
 *  - "2025-12-22 19:00:00"  -> "2025-12-22T19:00:00Z"
 *  - "2025-12-22T19:00:00" -> "2025-12-22T19:00:00Z"
 * Leaves:
 *  - "...Z" or "...-06:00" alone
 */
function normalizeIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim();

  // Convert "YYYY-MM-DD HH:mm:ss" -> ISO-ish
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) {
    s = s.replace(" ", "T");
  }

  // If it already has timezone (Z or ±hh:mm), keep it
  if (/[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) return s;

  // If it's ISO without timezone, assume UTC
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return `${s}Z`;

  return s;
}

function fmtCTDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const n = normalizeIso(iso);
  if (!n) return "—";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

// YYYY-MM-DD in Central Time for a timestamp
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

// Today as YYYY-MM-DD in CT
function ctTodayYmd() {
  return ctYmdFromIso(new Date().toISOString());
}

function fmtML(v: number | null) {
  return v == null ? "—" : `${v}`;
}

function fmtSpread(cell: SpreadCell) {
  if (!cell || cell.line == null) return "—";
  if (cell.odds == null) return `${cell.line}`;
  return `${cell.line} (${cell.odds})`;
}

function pickLogoUrl(row: any): string | null {
  return row.logo_url ?? row.team_logo_url ?? row.logo ?? null;
}

function pickUpdatedAt(row: any): string | null {
  return row.updated_at ?? row.last_updated ?? row.updatedAt ?? null;
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

function maxIso(a: string | null, b: string | null) {
  if (!a) return b;
  if (!b) return a;
  const an = normalizeIso(a);
  const bn = normalizeIso(b);
  if (!an) return b;
  if (!bn) return a;
  return new Date(an).getTime() >= new Date(bn).getTime() ? a : b;
}

export function OddsScreen({ selectedDate }: { selectedDate: string }) {
  const [events, setEvents] = useState<EventOdds[]>([]);
  const [market, setMarket] = useState<Market>("spread");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdatedIso, setLastUpdatedIso] = useState<string | null>(null);

  async function load() {
    setError("");

    const { data, error } = await supabase
      .from("odds_wide_latest")
      .select("*")
      .in("side", ["AWAY", "HOME"])
      .order("commence_time", { ascending: true });

    if (error) {
      setError(error.message);
      setEvents([]);
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

    // Sort
    const list = Array.from(byEvent.values()).sort((a, b) => {
      const ta = new Date(normalizeIso(a.commenceTime) ?? a.commenceTime).getTime();
      const tb = new Date(normalizeIso(b.commenceTime) ?? b.commenceTime).getTime();
      return ta - tb;
    });

    // ✅ Filter by selectedDate (Central Time)
    const todayCt = ctTodayYmd();
    const nowMs = Date.now();

    const filtered = list.filter((ev) => {
      const evCtDate = ctYmdFromIso(ev.commenceTime);
      if (evCtDate !== selectedDate) return false;

      // ✅ If browsing today (CT), exclude games that already started
      if (selectedDate === todayCt) {
        const startMs = new Date(normalizeIso(ev.commenceTime) ?? ev.commenceTime).getTime();
        if (!Number.isFinite(startMs)) return false;
        return startMs > nowMs;
      }

      return true;
    });

    setEvents(filtered);
    setLastUpdatedIso(globalLatest ?? new Date().toISOString());
    setLoading(false);
  }

  useEffect(() => {
    setLoading(true);
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
    // IMPORTANT: re-run when header date changes
  }, [selectedDate]);

  const headerLabel = market === "ml" ? "Moneyline" : market === "spread" ? "Spread" : "Total";

  const body = useMemo(() => {
    if (loading) return <div className="p-4 text-xs text-[#808080]">Loading odds_wide_latest…</div>;
    if (error) return <div className="p-4 text-xs text-red-400">Supabase error: {error}</div>;
    if (!events.length) return <div className="p-4 text-xs text-[#808080]">No games for {selectedDate}.</div>;

    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
              <th className="text-center p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-10 min-w-[150px]">
                Date/Time (CT)
              </th>
              <th className="text-left p-3 text-[#808080] min-w-[220px]">Matchup</th>

              <th className="text-center p-3 text-[#d4af37] border-l border-[#2a2a2a]">DraftKings</th>
              <th className="text-center p-3 text-[#d4af37]">FanDuel</th>
              <th className="text-center p-3 text-[#d4af37]">BetMGM</th>
              <th className="text-center p-3 text-[#d4af37]">Pinnacle</th>
              <th className="text-center p-3 text-[#d4af37]">BetOnline</th>
            </tr>
          </thead>

          <tbody>
            {events.map((ev) => (
              <EventTwoRows key={ev.eventId} ev={ev} market={market} />
            ))}
          </tbody>
        </table>
      </div>
    );
  }, [events, loading, error, market, selectedDate]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl text-white mb-1">Raw Odds Feed</h2>
          <p className="text-xs text-[#808080]">
            {headerLabel} · 5 books · {selectedDate} (CT) · Updated every 60 seconds
          </p>
        </div>

        <div className="text-right">
          <div className="text-[10px] text-[#606060]">Last Updated (CT)</div>
          <div className="text-xs text-white flex items-center justify-end gap-2">
            <span>{fmtCTDateTime(lastUpdatedIso)}</span>
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <MarketButton active={market === "ml"} onClick={() => setMarket("ml")}>Moneyline</MarketButton>
        <MarketButton active={market === "spread"} onClick={() => setMarket("spread")}>Spread</MarketButton>
        <MarketButton active={market === "total"} onClick={() => setMarket("total")}>Total</MarketButton>
      </div>

      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">{body}</div>
    </div>
  );
}

function MarketButton({
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
      onClick={onClick}
      className={[
        "px-3 py-1.5 rounded-md text-xs border transition-colors",
        active ? "bg-[#d4af37] text-black border-[#d4af37]" : "bg-[#0f0f0f] text-[#cfcfcf] border-[#2a2a2a] hover:border-[#3a3a3a]",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function EventTwoRows({ ev, market }: { ev: EventOdds; market: Market }) {
  const away =
    ev.away ?? {
      side: "AWAY" as const,
      team: "Away",
      logoUrl: null,
      updatedAt: null,
      ml: { dk: null, fd: null, mgm: null, pin: null, bol: null },
      spread: { dk: { line: null, odds: null }, fd: { line: null, odds: null }, mgm: { line: null, odds: null }, pin: { line: null, odds: null }, bol: { line: null, odds: null } },
      total: { dk: { line: null, over: null, under: null }, fd: { line: null, over: null, under: null }, mgm: { line: null, over: null, under: null }, pin: { line: null, over: null, under: null }, bol: { line: null, over: null, under: null } },
    };

  const home =
    ev.home ?? {
      side: "HOME" as const,
      team: "Home",
      logoUrl: null,
      updatedAt: null,
      ml: { dk: null, fd: null, mgm: null, pin: null, bol: null },
      spread: { dk: { line: null, odds: null }, fd: { line: null, odds: null }, mgm: { line: null, odds: null }, pin: { line: null, odds: null }, bol: { line: null, odds: null } },
      total: { dk: { line: null, over: null, under: null }, fd: { line: null, over: null, under: null }, mgm: { line: null, over: null, under: null }, pin: { line: null, over: null, under: null }, bol: { line: null, over: null, under: null } },
    };

  const mk = (s: SideOdds) => {
    if (market === "ml") {
      return { dk: fmtML(s.ml.dk), fd: fmtML(s.ml.fd), mgm: fmtML(s.ml.mgm), pin: fmtML(s.ml.pin), bol: fmtML(s.ml.bol) };
    }
    if (market === "spread") {
      return { dk: fmtSpread(s.spread.dk), fd: fmtSpread(s.spread.fd), mgm: fmtSpread(s.spread.mgm), pin: fmtSpread(s.spread.pin), bol: fmtSpread(s.spread.bol) };
    }

    // total split: AWAY row shows Over, HOME row shows Under
    const fmtTotalSplit = (cell: TotalCell, which: "over" | "under") => {
      if (!cell || cell.line == null) return "—";
      const v = which === "over" ? cell.over : cell.under;
      const tag = which === "over" ? "O" : "U";
      return `${cell.line} ${tag}${v == null ? "—" : v}`;
    };

    return {
      dk: fmtTotalSplit(s.total.dk, s.side === "AWAY" ? "over" : "under"),
      fd: fmtTotalSplit(s.total.fd, s.side === "AWAY" ? "over" : "under"),
      mgm: fmtTotalSplit(s.total.mgm, s.side === "AWAY" ? "over" : "under"),
      pin: fmtTotalSplit(s.total.pin, s.side === "AWAY" ? "over" : "under"),
      bol: fmtTotalSplit(s.total.bol, s.side === "AWAY" ? "over" : "under"),
    };
  };

  const awayCells = mk(away);
  const homeCells = mk(home);

  return (
    <>
      <tr className="hover:bg-[#0f0f0f]/50 transition-colors">
        <td className="p-3 text-[#b0b0b0] sticky left-0 bg-[#0f0f0f] z-10 align-middle text-center" rowSpan={2}>
          {fmtCTDateTime(ev.commenceTime)}
        </td>

        <TeamCell team={away.team} logoUrl={away.logoUrl} side="AWAY" />

        <BookValue value={awayCells.dk} borderLeft />
        <BookValue value={awayCells.fd} />
        <BookValue value={awayCells.mgm} />
        <BookValue value={awayCells.pin} />
        <BookValue value={awayCells.bol} />
      </tr>

      <tr className="hover:bg-[#0f0f0f]/50 transition-colors border-t border-[#1a1a1a]/60 border-b-2 border-b-[#2a2a2a]">
        <TeamCell team={home.team} logoUrl={home.logoUrl} side="HOME" />

        <BookValue value={homeCells.dk} borderLeft />
        <BookValue value={homeCells.fd} />
        <BookValue value={homeCells.mgm} />
        <BookValue value={homeCells.pin} />
        <BookValue value={homeCells.bol} />
      </tr>
    </>
  );
}

function TeamCell({ team, logoUrl, side }: { team: string; logoUrl: string | null; side: "AWAY" | "HOME" }) {
  return (
    <td className="p-3 text-white">
      <div className="flex items-center gap-3">
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={`${team} logo`}
            className="w-8 h-8 rounded-sm object-contain bg-white border border-[#e5e5e5] shadow-sm"
            loading="lazy"
          />
        ) : (
          <div className="w-8 h-8 rounded-sm bg-[#0a0a0a] border border-[#2a2a2a]" />
        )}

        <div className="leading-tight">
          <div className="text-white">{team}</div>
          <div className="text-[10px] text-[#606060]">{side}</div>
        </div>
      </div>
    </td>
  );
}

function BookValue({ value, borderLeft }: { value: string; borderLeft?: boolean }) {
  return <td className={`p-3 text-white text-center tabular-nums ${borderLeft ? "border-l border-[#2a2a2a]" : ""}`}>{value}</td>;
}

