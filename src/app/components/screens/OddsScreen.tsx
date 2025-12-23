import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type SpreadCell = { line: number | null; odds: number | null };
type TotalCell = { line: number | null; over: number | null; under: number | null };

type SideOdds = {
  side: "AWAY" | "HOME";
  team: string;
  ml: {
    dk: number | null;
    fd: number | null;
    mgm: number | null;
    pin: number | null;
    bol: number | null;
  };
  spread: {
    dk: SpreadCell;
    fd: SpreadCell;
    mgm: SpreadCell;
    pin: SpreadCell;
    bol: SpreadCell;
  };
  total: {
    dk: TotalCell;
    fd: TotalCell;
    mgm: TotalCell;
    pin: TotalCell;
    bol: TotalCell;
  };
};

type EventOdds = {
  eventId: string;
  matchup: string;
  commenceTime: string;
  away?: SideOdds;
  home?: SideOdds;
};

function fmtSpread(cell: SpreadCell) {
  if (!cell || cell.line == null) return "—";
  if (cell.odds == null) return `${cell.line}`;
  return `${cell.line} (${cell.odds})`;
}

function fmtTotal(cell: TotalCell) {
  if (!cell || cell.line == null) return "—";
  const o = cell.over == null ? "O—" : `O${cell.over}`;
  const u = cell.under == null ? "U—" : `U${cell.under}`;
  return `${cell.line} ${o} / ${u}`;
}

function fmtML(v: number | null) {
  return v == null ? "—" : `${v}`;
}

function mapWideRowToSideOdds(row: any): SideOdds {
  const team =
    row.team ??
    row.canonical_team ??
    row.canonical ??
    row.team_name ??
    row.side; // last resort

  return {
    side: row.side,
    team,

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

export function OddsScreen() {
  const [events, setEvents] = useState<EventOdds[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setError("");

    const { data, error } = await supabase
      .from("odds_wide_latest")
      .select(
        [
          "event_id",
          "matchup",
          "commence_time",
          "side",
          // team/canonical columns vary; include a few common ones:
          "team",

          "dk_ml_odds","fd_ml_odds","mgm_ml_odds","pin_ml_odds","bol_ml_odds",

          "dk_spread_line","dk_spread_odds",
          "fd_spread_line","fd_spread_odds",
          "mgm_spread_line","mgm_spread_odds",
          "pin_spread_line","pin_spread_odds",
          "bol_spread_line","bol_spread_odds",

          "dk_total_line","dk_total_over_odds","dk_total_under_odds",
          "fd_total_line","fd_total_over_odds","fd_total_under_odds",
          "mgm_total_line","mgm_total_over_odds","mgm_total_under_odds",
          "pin_total_line","pin_total_over_odds","pin_total_under_odds",
          "bol_total_line","bol_total_over_odds","bol_total_under_odds",
        ].join(",")
      )
      .in("side", ["AWAY", "HOME"])
      .order("commence_time", { ascending: true });

    if (error) {
      setError(error.message);
      setEvents([]);
      setLoading(false);
      return;
    }

    const byEvent = new Map<string, EventOdds>();

    for (const row of data ?? []) {
      const eventId = row.event_id;
      if (!eventId) continue;

      const cur =
        byEvent.get(eventId) ??
        {
          eventId,
          matchup: row.matchup ?? "",
          commenceTime: row.commence_time ?? "",
        };

      // ensure base fields filled even if first row missing them
      cur.matchup = cur.matchup || row.matchup || "";
      cur.commenceTime = cur.commenceTime || row.commence_time || "";

      const sideOdds = mapWideRowToSideOdds(row);

      if (sideOdds.side === "AWAY") cur.away = sideOdds;
      if (sideOdds.side === "HOME") cur.home = sideOdds;

      byEvent.set(eventId, cur);
    }

    // Sort and ensure Away first in UI by always rendering away row then home row
    setEvents(Array.from(byEvent.values()));
    setLoading(false);
  }

  useEffect(() => {
    setLoading(true);
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, []);

  const body = useMemo(() => {
    if (loading) return <div className="p-4 text-xs text-[#808080]">Loading odds_wide_latest…</div>;
    if (error) return <div className="p-4 text-xs text-red-400">Supabase error: {error}</div>;
    if (!events.length) return <div className="p-4 text-xs text-[#808080]">No rows found.</div>;

    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
              <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-10 min-w-[100px]">Event ID</th>
              <th className="text-left p-3 text-[#808080] min-w-[180px]">Matchup</th>
              <th className="text-left p-3 text-[#808080] min-w-[160px]">Commence</th>
              <th className="text-left p-3 text-[#d4af37] border-l border-[#2a2a2a]">DraftKings</th>
              <th className="text-left p-3 text-[#d4af37]">FanDuel</th>
              <th className="text-left p-3 text-[#d4af37]">BetMGM</th>
              <th className="text-left p-3 text-[#d4af37]">Pinnacle</th>
              <th className="text-left p-3 text-[#d4af37]">BetOnline</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-[#1a1a1a]">
            {events.map((ev) => (
              <EventOddsRows key={ev.eventId} ev={ev} />
            ))}
          </tbody>
        </table>
      </div>
    );
  }, [events, loading, error]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl text-white mb-1">Raw Odds Feed</h2>
        <p className="text-xs text-[#808080]">Live sportsbook lines · 5 books · Updated every 60 seconds</p>
      </div>

      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">{body}</div>

      <div className="flex items-center justify-between text-[10px] text-[#606060] pt-2">
        <div>Data provided by OddsAPI · Lines may vary by location</div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
          <span>Live Feed Active</span>
        </div>
      </div>
    </div>
  );
}

function EventOddsRows({ ev }: { ev: EventOdds }) {
  const away = ev.away ?? { side: "AWAY", team: "Away", ml: { dk: null, fd: null, mgm: null, pin: null, bol: null }, spread: { dk: {line:null,odds:null}, fd:{line:null,odds:null}, mgm:{line:null,odds:null}, pin:{line:null,odds:null}, bol:{line:null,odds:null} }, total: { dk:{line:null,over:null,under:null}, fd:{line:null,over:null,under:null}, mgm:{line:null,over:null,under:null}, pin:{line:null,over:null,under:null}, bol:{line:null,over:null,under:null} } };
  const home = ev.home ?? { side: "HOME", team: "Home", ml: { dk: null, fd: null, mgm: null, pin: null, bol: null }, spread: { dk: {line:null,odds:null}, fd:{line:null,odds:null}, mgm:{line:null,odds:null}, pin:{line:null,odds:null}, bol:{line:null,odds:null} }, total: { dk:{line:null,over:null,under:null}, fd:{line:null,over:null,under:null}, mgm:{line:null,over:null,under:null}, pin:{line:null,over:null,under:null}, bol:{line:null,over:null,under:null} } };

  // 6 rows per event: Away then Home for ML/SPR/TOT
  const rowSpan = 6;

  return (
    <>
      {/* ML AWAY */}
      <tr className="hover:bg-[#0f0f0f]/50 transition-colors">
        <td className="p-3 text-[#808080] sticky left-0 bg-[#0f0f0f] z-10 align-top" rowSpan={rowSpan}>
          {ev.eventId}
        </td>
        <td className="p-3 text-white align-top" rowSpan={rowSpan}>
          {ev.matchup}
        </td>
        <td className="p-3 text-[#b0b0b0] align-top" rowSpan={rowSpan}>
          {ev.commenceTime}
        </td>

        <BookCell label={`ML (${away.team})`} value={fmtML(away.ml.dk)} borderLeft />
        <BookCell label={`ML (${away.team})`} value={fmtML(away.ml.fd)} />
        <BookCell label={`ML (${away.team})`} value={fmtML(away.ml.mgm)} />
        <BookCell label={`ML (${away.team})`} value={fmtML(away.ml.pin)} />
        <BookCell label={`ML (${away.team})`} value={fmtML(away.ml.bol)} />
      </tr>

      {/* ML HOME */}
      <tr className="hover:bg-[#0f0f0f]/50 transition-colors border-t border-[#1a1a1a]/50">
        <BookCell label={`ML (${home.team})`} value={fmtML(home.ml.dk)} borderLeft />
        <BookCell label={`ML (${home.team})`} value={fmtML(home.ml.fd)} />
        <BookCell label={`ML (${home.team})`} value={fmtML(home.ml.mgm)} />
        <BookCell label={`ML (${home.team})`} value={fmtML(home.ml.pin)} />
        <BookCell label={`ML (${home.team})`} value={fmtML(home.ml.bol)} />
      </tr>

      {/* SPR AWAY */}
      <tr className="hover:bg-[#0f0f0f]/50 transition-colors border-t border-[#1a1a1a]/50">
        <BookCell label={`SPR (${away.team})`} value={fmtSpread(away.spread.dk)} borderLeft />
        <BookCell label={`SPR (${away.team})`} value={fmtSpread(away.spread.fd)} />
        <BookCell label={`SPR (${away.team})`} value={fmtSpread(away.spread.mgm)} />
        <BookCell label={`SPR (${away.team})`} value={fmtSpread(away.spread.pin)} />
        <BookCell label={`SPR (${away.team})`} value={fmtSpread(away.spread.bol)} />
      </tr>

      {/* SPR HOME */}
      <tr className="hover:bg-[#0f0f0f]/50 transition-colors border-t border-[#1a1a1a]/50">
        <BookCell label={`SPR (${home.team})`} value={fmtSpread(home.spread.dk)} borderLeft />
        <BookCell label={`SPR (${home.team})`} value={fmtSpread(home.spread.fd)} />
        <BookCell label={`SPR (${home.team})`} value={fmtSpread(home.spread.mgm)} />
        <BookCell label={`SPR (${home.team})`} value={fmtSpread(home.spread.pin)} />
        <BookCell label={`SPR (${home.team})`} value={fmtSpread(home.spread.bol)} />
      </tr>

      {/* TOT AWAY */}
      <tr className="hover:bg-[#0f0f0f]/50 transition-colors border-t border-[#1a1a1a]/50">
        <BookCell label="TOT" value={fmtTotal(away.total.dk)} borderLeft />
        <BookCell label="TOT" value={fmtTotal(away.total.fd)} />
        <BookCell label="TOT" value={fmtTotal(away.total.mgm)} />
        <BookCell label="TOT" value={fmtTotal(away.total.pin)} />
        <BookCell label="TOT" value={fmtTotal(away.total.bol)} />
      </tr>

      {/* TOT HOME */}
      <tr className="hover:bg-[#0f0f0f]/50 transition-colors border-t border-[#1a1a1a]/50">
        <BookCell label="TOT" value={fmtTotal(home.total.dk)} borderLeft />
        <BookCell label="TOT" value={fmtTotal(home.total.fd)} />
        <BookCell label="TOT" value={fmtTotal(home.total.mgm)} />
        <BookCell label="TOT" value={fmtTotal(home.total.pin)} />
        <BookCell label="TOT" value={fmtTotal(home.total.bol)} />
      </tr>
    </>
  );
}

function BookCell({ label, value, borderLeft }: { label: string; value: string; borderLeft?: boolean }) {
  return (
    <td className={`p-3 text-white ${borderLeft ? "border-l border-[#2a2a2a]" : ""}`}>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-[#606060] w-[72px]">{label}:</span>
        <span>{value}</span>
      </div>
    </td>
  );
}
