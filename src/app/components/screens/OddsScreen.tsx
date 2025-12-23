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

/** ✅ Book logos from /public/books */
const BOOK_LOGOS = {
  dk: "/books/dk.png",
  fd: "/books/fd.png",
  mgm: "/books/mgm.png",
  pin: "/books/pin.png", // or "/books/pin.png"
  bol: "/books/bol.png",
} as const;

// ✅ uniform book-logo slot size
const BOOK_LOGO_W = 110;
const BOOK_LOGO_H = 28;

/** --------------------- helpers --------------------- */
function normalizeIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(" ", "T");
  if (/[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return `${s}Z`;
  return s;
}

function fmtCTTimeOnly(iso: string | null | undefined) {
  if (!iso) return "—";
  const n = normalizeIso(iso);
  if (!n) return "—";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function fmtCTDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const n = normalizeIso(iso);
  if (!n) return "—";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

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

function ctTodayYmd() {
  return ctYmdFromIso(new Date().toISOString());
}

function fmtDateBtn(ymd: string) {
  const d = new Date(`${ymd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtML(v: number | null) {
  return v == null ? "—" : `${v}`;
}

function fmtSpread(cell: SpreadCell) {
  if (!cell || cell.line == null) return "—";
  if (cell.odds == null) return `${cell.line}`;
  return `${cell.line} (${cell.odds})`;
}

function fmtTotalSplit(cell: TotalCell, which: "over" | "under") {
  if (!cell || cell.line == null) return "—";
  const v = which === "over" ? cell.over : cell.under;
  const tag = which === "over" ? "O" : "U";
  return `${cell.line} ${tag}${v == null ? "—" : v}`;
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

function headerFallbackPillDataUri(label: string) {
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="${BOOK_LOGO_W}" height="${BOOK_LOGO_H}">
    <rect x="0" y="0" width="${BOOK_LOGO_W}" height="${BOOK_LOGO_H}" rx="14" ry="14" fill="#EDEDED"/>
    <text x="${BOOK_LOGO_W / 2}" y="${Math.floor(BOOK_LOGO_H * 0.70)}"
      font-family="Arial, sans-serif" font-size="12" font-weight="700"
      text-anchor="middle" fill="#111111">${label}</text>
  </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg.trim())}`;
}

/** --------------------- consensus (derived) --------------------- */
type Consensus = {
  spreadLine: number | null;
  totalLine: number | null;
  mlHome: number | null;
  mlAway: number | null;
};

// consensus = median of available lines/odds across books (robust)
function median(nums: number[]) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function buildConsensus(ev: EventOdds): Consensus {
  const a = ev.away;
  const h = ev.home;

  const spreadLines: number[] = [];
  const totalLines: number[] = [];
  const mlHome: number[] = [];
  const mlAway: number[] = [];

  // spread lines (use away row to read “the spread line” per book; should be symmetric)
  if (a) {
    for (const b of ["dk", "fd", "mgm", "pin", "bol"] as const) {
      const line = a.spread[b]?.line;
      if (typeof line === "number") spreadLines.push(line);
    }
    for (const b of ["dk", "fd", "mgm", "pin", "bol"] as const) {
      const line = a.total[b]?.line;
      if (typeof line === "number") totalLines.push(line);
    }
    for (const b of ["dk", "fd", "mgm", "pin", "bol"] as const) {
      const o = a.ml[b];
      if (typeof o === "number") mlAway.push(o);
    }
  }
  if (h) {
    for (const b of ["dk", "fd", "mgm", "pin", "bol"] as const) {
      const o = h.ml[b];
      if (typeof o === "number") mlHome.push(o);
    }
  }

  return {
    spreadLine: median(spreadLines),
    totalLine: median(totalLines),
    mlHome: median(mlHome),
    mlAway: median(mlAway),
  };
}

/** --------------------- UI components --------------------- */
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
        active
          ? "bg-[#d4af37] text-black border-[#d4af37]"
          : "bg-[#0f0f0f] text-[#cfcfcf] border-[#2a2a2a] hover:border-[#3a3a3a]",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function BookHeader({
  src,
  alt,
  fallbackLabel,
  borderLeft,
}: {
  src: string;
  alt: string;
  fallbackLabel: string;
  borderLeft?: boolean;
}) {
  return (
    <th
      className={["text-center px-2 py-3", borderLeft ? "border-l border-black/10" : ""].join(" ")}
      style={{ width: 128 }}
    >
      <span className="sr-only">{alt}</span>
      <div className="flex items-center justify-center">
        <div style={{ width: BOOK_LOGO_W, height: BOOK_LOGO_H }} className="flex items-center justify-center">
          <img
            src={src}
            alt={alt}
            style={{ width: BOOK_LOGO_W, height: BOOK_LOGO_H }}
            className="object-contain"
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).src = headerFallbackPillDataUri(fallbackLabel);
            }}
          />
        </div>
      </div>
    </th>
  );
}

function BookValue({ value, borderLeft }: { value: string; borderLeft?: boolean }) {
  return (
    <td
      className={[
        "p-3 text-white text-center tabular-nums font-semibold", // ✅ slightly bigger + bold
        "text-[13px]", // ✅ up from text-xs
        borderLeft ? "border-l border-[#2a2a2a]" : "",
      ].join(" ")}
    >
      {value}
    </td>
  );
}

function MiniTeamRow({ team, logoUrl, side }: { team: string; logoUrl: string | null; side: "AWAY" | "HOME" }) {
  return (
    <div className="flex items-center gap-3">
      {logoUrl ? (
        <img
          src={logoUrl}
          alt={`${team} logo`}
          className="w-10 h-10 rounded-md object-contain bg-white border border-[#e5e5e5] p-1" // ✅ bigger logo
          loading="lazy"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <div className="w-10 h-10 rounded-md bg-white border border-[#e5e5e5]" />
      )}

      <div className="leading-tight">
        <div className="text-white font-bold text-[15px]"> {/* ✅ bigger + bold name */}
          {team}
        </div>
        <div className="text-[11px] text-[#7a7a7a] font-semibold">{side}</div>
      </div>
    </div>
  );
}

function ConsensusCell({ ev }: { ev: EventOdds }) {
  const c = useMemo(() => buildConsensus(ev), [ev]);

  return (
    <td className="p-3 bg-[#0f0f0f] border-r border-[#2a2a2a] align-middle">
      <div className="text-[11px] text-[#808080] mb-1">Consensus</div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-[#cfcfcf]">Spread</span>
          <span className="text-[13px] text-white font-bold tabular-nums">
            {c.spreadLine == null ? "—" : c.spreadLine}
          </span>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-[#cfcfcf]">Total</span>
          <span className="text-[13px] text-white font-bold tabular-nums">
            {c.totalLine == null ? "—" : c.totalLine}
          </span>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-[#cfcfcf]">ML (A/H)</span>
          <span className="text-[13px] text-white font-bold tabular-nums">
            {c.mlAway == null ? "—" : c.mlAway} / {c.mlHome == null ? "—" : c.mlHome}
          </span>
        </div>
      </div>
    </td>
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
        {/* Matchup (sticky) */}
        <td className="p-4 sticky left-0 bg-[#0f0f0f] z-10 align-middle border-r border-[#2a2a2a]" rowSpan={2}>
          <div className="text-[12px] text-[#cfcfcf] font-semibold mb-3">{fmtCTTimeOnly(ev.commenceTime)} CT</div>
          <div className="space-y-3">
            <MiniTeamRow team={away.team} logoUrl={away.logoUrl} side="AWAY" />
            <MiniTeamRow team={home.team} logoUrl={home.logoUrl} side="HOME" />
          </div>
        </td>

        {/* ✅ NEW: Consensus column (not sticky) */}
        <ConsensusCell ev={ev} />

        <BookValue value={awayCells.dk} borderLeft />
        <BookValue value={awayCells.fd} />
        <BookValue value={awayCells.mgm} />
        <BookValue value={awayCells.pin} />
        <BookValue value={awayCells.bol} />
      </tr>

      <tr className="hover:bg-[#0f0f0f]/50 transition-colors border-t border-[#1a1a1a]/60 border-b-2 border-b-[#2a2a2a]">
        <BookValue value={homeCells.dk} borderLeft />
        <BookValue value={homeCells.fd} />
        <BookValue value={homeCells.mgm} />
        <BookValue value={homeCells.pin} />
        <BookValue value={homeCells.bol} />
      </tr>
    </>
  );
}

/** --------------------- main screen --------------------- */
export function OddsScreen() {
  const [allEvents, setAllEvents] = useState<EventOdds[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>("");
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
      setAllEvents([]);
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

    const list = Array.from(byEvent.values()).sort((a, b) => {
      const ta = new Date(normalizeIso(a.commenceTime) ?? a.commenceTime).getTime();
      const tb = new Date(normalizeIso(b.commenceTime) ?? b.commenceTime).getTime();
      return ta - tb;
    });

    setAllEvents(list);
    setLastUpdatedIso(globalLatest ?? new Date().toISOString());
    setLoading(false);
  }

  useEffect(() => {
    setLoading(true);
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, []);

  const availableDates = useMemo(() => {
    const set = new Set<string>();
    for (const ev of allEvents) {
      const d = ctYmdFromIso(ev.commenceTime);
      if (d) set.add(d);
    }
    return Array.from(set).sort();
  }, [allEvents]);

  useEffect(() => {
    if (!availableDates.length) return;
    const today = ctTodayYmd();
    setSelectedDate((prev) => {
      if (prev && availableDates.includes(prev)) return prev;
      if (availableDates.includes(today)) return today;
      return availableDates[0];
    });
  }, [availableDates]);

  const events = useMemo(() => {
    if (!selectedDate) return [];
    const todayCt = ctTodayYmd();
    const nowMs = Date.now();

    return allEvents.filter((ev) => {
      const evDate = ctYmdFromIso(ev.commenceTime);
      if (evDate !== selectedDate) return false;

      if (selectedDate === todayCt) {
        const startMs = new Date(normalizeIso(ev.commenceTime) ?? ev.commenceTime).getTime();
        if (!Number.isFinite(startMs)) return false;
        return startMs > nowMs;
      }
      return true;
    });
  }, [allEvents, selectedDate]);

  const headerLabel = market === "ml" ? "Moneyline" : market === "spread" ? "Spread" : "Total";

  return (
    <div className="h-[calc(100vh-72px)] flex flex-col gap-4 overflow-hidden">
      {/* title + last updated */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl text-white mb-1">Raw Odds Feed</h2>
          <p className="text-xs text-[#808080]">{headerLabel} · 5 books · Updated every 60 seconds</p>
        </div>

        <div className="text-right">
          <div className="text-[10px] text-[#606060]">Last Updated (CT)</div>
          <div className="text-xs text-white flex items-center justify-end gap-2">
            <span>{fmtCTDateTime(lastUpdatedIso)}</span>
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
          </div>
        </div>
      </div>

      {/* date buttons */}
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
        {availableDates.map((d) => (
          <button
            key={d}
            onClick={() => setSelectedDate(d)}
            className={[
              "px-3 py-1.5 rounded-md text-xs border transition-colors whitespace-nowrap",
              selectedDate === d
                ? "bg-[#d4af37] text-black border-[#d4af37]"
                : "bg-[#0f0f0f] text-[#cfcfcf] border-[#2a2a2a] hover:border-[#3a3a3a]",
            ].join(" ")}
            title={d}
          >
            {fmtDateBtn(d)}
          </button>
        ))}
      </div>

      {/* market toggle */}
      <div className="flex items-center gap-2">
        <MarketButton active={market === "ml"} onClick={() => setMarket("ml")}>
          Moneyline
        </MarketButton>
        <MarketButton active={market === "spread"} onClick={() => setMarket("spread")}>
          Spread
        </MarketButton>
        <MarketButton active={market === "total"} onClick={() => setMarket("total")}>
          Total
        </MarketButton>
      </div>

      {/* scrollable table card */}
      <div className="flex-1 bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">
        <div className="h-full overflow-y-auto overflow-x-auto">
          {loading ? (
            <div className="p-4 text-xs text-[#808080]">Loading odds_wide_latest…</div>
          ) : error ? (
            <div className="p-4 text-xs text-red-400">Supabase error: {error}</div>
          ) : !events.length ? (
            <div className="p-4 text-xs text-[#808080]">No games for {selectedDate || "—"}.</div>
          ) : (
            <table className="w-full table-fixed">
              <colgroup>
                <col style={{ width: 420 }} /> {/* Matchup */}
                <col style={{ width: 220 }} /> {/* Consensus */}
                <col style={{ width: 128 }} />
                <col style={{ width: 128 }} />
                <col style={{ width: 128 }} />
                <col style={{ width: 128 }} />
                <col style={{ width: 128 }} />
              </colgroup>

              <thead className="sticky top-0 z-20">
                <tr className="bg-[#E7E3D6] border-b border-black/10">
                  <th className="text-left px-3 py-3 text-[#1a1a1a] sticky left-0 bg-[#E7E3D6] z-30 text-sm font-bold">
                    Matchup
                  </th>
                  <th className="text-left px-3 py-3 text-[#1a1a1a] bg-[#E7E3D6] z-20 text-sm font-bold border-l border-black/10">
                    Consensus
                  </th>

                  <BookHeader src={BOOK_LOGOS.dk} alt="DraftKings" fallbackLabel="DK" borderLeft />
                  <BookHeader src={BOOK_LOGOS.fd} alt="FanDuel" fallbackLabel="FD" />
                  <BookHeader src={BOOK_LOGOS.mgm} alt="BetMGM" fallbackLabel="MGM" />
                  <BookHeader src={BOOK_LOGOS.pin} alt="Pinnacle" fallbackLabel="PIN" />
                  <BookHeader src={BOOK_LOGOS.bol} alt="BetOnline" fallbackLabel="BOL" />
                </tr>
              </thead>

              <tbody>
                {events.map((ev) => (
                  <EventTwoRows key={ev.eventId} ev={ev} market={market} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
