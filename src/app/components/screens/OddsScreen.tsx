"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import {
  ChevronDown,
  RefreshCcw,
  Search,
  CalendarDays,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";

/* =========================================================
   PREMIUM ODDS BOARD (Black/Gold theme + feed-safe)
   ---------------------------------------------------------
   ✅ Board look matches screenshot
   ✅ Does NOT "lose feed data" — uses adapter that supports:
      A) events + odds_snapshot (row-based offers)
      B) odds_snapshot_latest / odds_board_latest style views

   ✅ team_map integration (logos + abbreviations)
   ✅ lastUpdated pulled from DB (max ts)
   ✅ multi-sport tabs
========================================================= */

/* ---------------------------
   THEME (Pittsburgh)
---------------------------- */
const THEME = {
  bg: "#070a0f", // deep black
  panel: "#0b1018",
  panel2: "#0a0f17",
  border: "#1b2430",
  border2: "#141c27",
  text: "#e7eef8",
  muted: "#95a6bb",
  dim: "#607289",
  gold: "#d4af37",
  gold2: "#b08a1c",
  teal: "#2dd4bf", // optional accent for separators
  blue: "#2b8cff",
};

const CT = "America/Chicago";

/* ---------------------------
   Types
---------------------------- */
type MarketMode = "spreads" | "h2h" | "totals";
type PhaseMode = "pregame" | "live";
type OddsFormat = "american";

type BookKey =
  | "pinnacle"
  | "betmgm"
  | "circa"
  | "fanduel"
  | "draftkings"
  | "betonlineag"
  | "caesars"
  | "espnbet"
  | "betrivers";

type SportTab =
  | "basketball_nba"
  | "basketball_ncaab"
  | "americanfootball_nfl"
  | "americanfootball_ncaaf"
  | "soccer_epl"
  | "mma_mixed_martial_arts"
  | "ufc"; // optional alias; you can map it

type EventRow = {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
};

type SnapshotRow = {
  sport_key?: string | null;
  event_id: string;
  commence_time: string;

  home_team: string;
  away_team: string;

  market_key: string;
  bookmaker_key: string;

  outcome_name: string;
  price: number | null;
  point: number | null;

  ts?: string | null; // if your table has it
};

type TeamMapRow = {
  canonical: string;
  abbreviation?: string | null;
  abbreviation2?: string | null;
  logo_url?: string | null;
};

type TeamSide = "away" | "home";

type CellOffer = {
  line?: number | null;
  price?: number | null;
  ts?: string | null;
};

type BoardRow = {
  event_id: string;
  commence_time: string;
  dateKey: string;

  rowType: "team" | "total";
  side: TeamSide | null;
  totalSide: "over" | "under" | null;

  teamCanonical: string; // for logo + abbr lookup
  labelLeft: string; // main label (team / Over / Under)
  labelRight: string; // sub label (matchup)
  timeLabel: string;

  offersByBook: Record<BookKey, CellOffer | null>;
};

type EventMeta = {
  event_id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
};

/* ---------------------------
   Books (columns)
---------------------------- */
const BOOKS: { key: BookKey; label: string }[] = [
  { key: "pinnacle", label: "Pinnacle" },
  { key: "betmgm", label: "BetMGM" },
  { key: "circa", label: "Circa" },
  { key: "fanduel", label: "FanDuel" },
  { key: "draftkings", label: "DraftKings" },
  { key: "betonlineag", label: "BetOnline" },
  { key: "caesars", label: "Caesars" },
  { key: "espnbet", label: "ESPNBET" },
  { key: "betrivers", label: "BetRivers" },
];

const BOOK_ICON: Partial<Record<BookKey, string>> = {
  pinnacle: "/books/pinnacle.png",
  betmgm: "/books/betmgm.png",
  circa: "/books/circa.png",
  fanduel: "/books/fanduel.png",
  draftkings: "/books/draftkings.png",
  betonlineag: "/books/betonline.png",
  caesars: "/books/caesars.png",
  espnbet: "/books/espnbet.png",
  betrivers: "/books/betrivers.png",
};

/* ---------------------------
   Sports tabs (top)
   (Adjust labels + keys to match your app)
---------------------------- */
const SPORT_TABS: { key: SportTab; label: string }[] = [
  { key: "americanfootball_nfl", label: "NFL" },
  { key: "americanfootball_ncaaf", label: "NCAAF" },
  { key: "basketball_nba", label: "NBA" },
  { key: "basketball_ncaab", label: "NCAAM" },
  { key: "soccer_epl", label: "Soccer" },
  { key: "mma_mixed_martial_arts", label: "UFC" },
];

/* ---------------------------
   Helpers
---------------------------- */
function fmtAmerican(n?: number | null) {
  if (n == null) return "";
  if (n > 0) return `+${n}`;
  return `${n}`;
}

function fmtLine(n?: number | null) {
  if (n == null) return "";
  const s = Number.isInteger(n) ? `${n}` : n.toFixed(1);
  return s.startsWith("-") ? s : `+${s}`;
}

function fmtTimeCT(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function fmtDateHeaderCT(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

function ymdCT(iso: string) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CT,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "00";
  const day = parts.find((p) => p.type === "day")?.value ?? "00";
  return `${y}-${m}-${day}`;
}

function normalizeBookKey(raw: string): BookKey | null {
  const k = raw.toLowerCase();

  // fast path (exact)
  if (
    k === "pinnacle" ||
    k === "betmgm" ||
    k === "circa" ||
    k === "fanduel" ||
    k === "draftkings" ||
    k === "betonlineag" ||
    k === "caesars" ||
    k === "espnbet" ||
    k === "betrivers"
  ) return k as BookKey;

  if (k.includes("pinnacle")) return "pinnacle";
  if (k.includes("betmgm")) return "betmgm";
  if (k.includes("circa")) return "circa";
  if (k.includes("fanduel")) return "fanduel";
  if (k.includes("draftkings")) return "draftkings";
  if (k.includes("betonline")) return "betonlineag";
  if (k.includes("caesars")) return "caesars";
  if (k.includes("espn")) return "espnbet";
  if (k.includes("betrivers")) return "betrivers";

  return null;
}

function isLiveHeuristic(commence_time: string) {
  // your old feed likely had a status column; if you do, replace this.
  // this is just a safe fallback.
  return new Date(commence_time).getTime() < Date.now() - 5 * 60 * 1000;
}

/* ---------------------------
   UI atoms
---------------------------- */
function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded-md px-3 py-2 pr-9 text-sm focus:outline-none focus:ring-1"
        style={{
          background: THEME.panel2,
          color: THEME.text,
          border: `1px solid ${THEME.border}`,
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.02)",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2"
        style={{ color: THEME.dim }}
      />
    </div>
  );
}

function Chip({ icon, label }: { icon?: React.ReactNode; label: string }) {
  return (
    <div
      className="flex items-center gap-2 rounded-md px-3 py-2 text-sm"
      style={{
        background: THEME.panel2,
        border: `1px solid ${THEME.border}`,
        color: THEME.text,
      }}
    >
      {icon}
      <span className="whitespace-nowrap">{label}</span>
    </div>
  );
}

/* =========================================================
   MAIN SCREEN
========================================================= */

export function OddsScreen({
  defaultSportKey = "americanfootball_nfl",
}: {
  defaultSportKey?: string;
}) {
  const [sportKey, setSportKey] = useState<string>(defaultSportKey);

  const [market, setMarket] = useState<MarketMode>("spreads");
  const [phase, setPhase] = useState<PhaseMode>("pregame");
  const [format, setFormat] = useState<OddsFormat>("american");
  const [search, setSearch] = useState("");

  const [selectedDate, setSelectedDate] = useState<string>(() => {
    const now = new Date().toISOString();
    return ymdCT(now);
  });

  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // feed payloads
  const [events, setEvents] = useState<EventRow[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [teamMap, setTeamMap] = useState<Record<string, TeamMapRow>>({});

  const metaByEvent = useMemo(() => {
    const meta: Record<string, EventMeta> = {};
    for (const e of events) {
      meta[e.id] = {
        event_id: e.id,
        commence_time: e.commence_time,
        home_team: e.home_team,
        away_team: e.away_team,
      };
    }
    // fill missing from snapshots if events feed is empty (Pattern B support)
    for (const s of snapshots) {
      if (!meta[s.event_id]) {
        meta[s.event_id] = {
          event_id: s.event_id,
          commence_time: s.commence_time,
          home_team: s.home_team,
          away_team: s.away_team,
        };
      }
    }
    return meta;
  }, [events, snapshots]);

  /* =========================================================
     FEED LOADER (adapter)
     - Loads team_map
     - Loads events (if available)
     - Loads odds snapshots (either from odds_snapshot OR odds_snapshot_latest/view)
     - Loads lastUpdated from DB using max(ts) if available
  ========================================================= */

  const refresh = async () => {
    setLoading(true);
    try {
      const dayStart = new Date(`${selectedDate}T00:00:00.000Z`);
      const dayEnd = new Date(`${selectedDate}T23:59:59.999Z`);

      // 1) team_map (logos/abbr)
      // Supports either canonical column names or your existing mapping.
      const tmRes = await supabase
        .from("team_map")
        .select(`canonical, "Logo URL", "Abbreviation", "Abbreviation2"`)
        .limit(5000);

      if (!tmRes.error && tmRes.data) {
        const map: Record<string, TeamMapRow> = {};
        for (const r of tmRes.data as any[]) {
          const canonical = (r.canonical ?? "").toString();
          if (!canonical) continue;
          map[canonical] = {
            canonical,
            logo_url: r["Logo URL"] ?? null,
            abbreviation: r["Abbreviation"] ?? null,
            abbreviation2: r["Abbreviation2"] ?? null,
          };
        }
        setTeamMap(map);
      } else {
        setTeamMap({});
      }

      // 2) events feed (Pattern A)
      // If your old script used a view like events_today, swap the table name here.
      const evRes = await supabase
        .from("events")
        .select("id,sport_key,commence_time,home_team,away_team")
        .eq("sport_key", sportKey)
        .gte("commence_time", dayStart.toISOString())
        .lte("commence_time", dayEnd.toISOString())
        .order("commence_time", { ascending: true });

      const eventsData = (evRes.data ?? []) as any[];
      const eventsClean: EventRow[] = eventsData.map((e) => ({
        id: e.id,
        sport_key: e.sport_key,
        commence_time: e.commence_time,
        home_team: e.home_team,
        away_team: e.away_team,
      }));
      setEvents(eventsClean);

      // 3) snapshots feed
      // Try "odds_snapshot_latest" first (many apps already use a latest view),
      // then fall back to "odds_snapshot" if the view doesn't exist.
      // This prevents losing your old feed if it was using a view.
      let snap: SnapshotRow[] = [];
      let lastTs: string | null = null;

      // Attempt latest view
      const snapLatest = await supabase
        .from("odds_snapshot_latest")
        .select(
          "sport_key,event_id,commence_time,home_team,away_team,market_key,bookmaker_key,outcome_name,price,point,ts"
        )
        .eq("sport_key", sportKey)
        .gte("commence_time", dayStart.toISOString())
        .lte("commence_time", dayEnd.toISOString())
        .in("market_key", ["h2h", "spreads", "totals"]);

      if (!snapLatest.error && snapLatest.data) {
        snap = snapLatest.data as SnapshotRow[];
        // true last updated from DB max(ts)
        lastTs =
          snap
            .map((r) => r.ts)
            .filter(Boolean)
            .sort()
            .at(-1) ?? null;
      } else {
        // Fall back to odds_snapshot
        const snapRes = await supabase
          .from("odds_snapshot")
          .select(
            "sport_key,event_id,commence_time,home_team,away_team,market_key,bookmaker_key,outcome_name,price,point,ts"
          )
          .eq("sport_key", sportKey)
          .gte("commence_time", dayStart.toISOString())
          .lte("commence_time", dayEnd.toISOString())
          .in("market_key", ["h2h", "spreads", "totals"]);

        if (snapRes.error) throw snapRes.error;
        snap = (snapRes.data ?? []) as SnapshotRow[];

        lastTs =
          snap
            .map((r) => r.ts)
            .filter(Boolean)
            .sort()
            .at(-1) ?? null;
      }

      // Apply phase (live/pregame) filtering without destroying feed
      const filtered = snap.filter((r) => {
        const live = isLiveHeuristic(r.commence_time);
        return phase === "live" ? live : !live;
      });

      setSnapshots(filtered);

      // lastUpdated display (prefer db ts, else local clock)
      if (lastTs) {
        setLastUpdated(
          new Intl.DateTimeFormat("en-US", {
            timeZone: CT,
            hour: "numeric",
            minute: "2-digit",
          }).format(new Date(lastTs))
        );
      } else {
        setLastUpdated(
          new Intl.DateTimeFormat("en-US", {
            timeZone: CT,
            hour: "numeric",
            minute: "2-digit",
          }).format(new Date())
        );
      }
    } catch (e) {
      console.error(e);
      setEvents([]);
      setSnapshots([]);
      setLastUpdated(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sportKey, selectedDate, phase]);

  /* =========================================================
     BOARD BUILD (pivot snapshots -> matrix rows)
     - Uses events feed if present (best)
     - Falls back to snapshot-derived meta (still works)
  ========================================================= */

  const boardRows: BoardRow[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    const marketKey = market;

    const rows = snapshots.filter((r) => r.market_key === marketKey);

    // group snapshot rows by event_id
    const byEvent: Record<string, SnapshotRow[]> = {};
    for (const r of rows) {
      if (!byEvent[r.event_id]) byEvent[r.event_id] = [];
      byEvent[r.event_id].push(r);
    }

    // choose event order:
    // - if events feed exists, use it (preserves your old feed ordering)
    // - else order by commence_time from meta
    const orderedEventIds: string[] =
      events.length > 0
        ? events.map((e) => e.id).filter((id) => byEvent[id] || metaByEvent[id])
        : Object.keys(byEvent).sort((a, b) => {
            const ta = new Date(metaByEvent[a]?.commence_time ?? 0).getTime();
            const tb = new Date(metaByEvent[b]?.commence_time ?? 0).getTime();
            return ta - tb;
          });

    const out: BoardRow[] = [];

    for (const event_id of orderedEventIds) {
      const meta = metaByEvent[event_id];
      if (!meta) continue;

      // search filter
      if (q) {
        const hit =
          meta.home_team.toLowerCase().includes(q) ||
          meta.away_team.toLowerCase().includes(q);
        if (!hit) continue;
      }

      const dateKey = ymdCT(meta.commence_time);
      const timeLabel = fmtTimeCT(meta.commence_time);
      const chunk = byEvent[event_id] ?? [];

      if (market === "totals") {
        const makeTotalsRow = (totalSide: "over" | "under"): BoardRow => {
          const offersByBook = {} as Record<BookKey, CellOffer | null>;
          for (const b of BOOKS) offersByBook[b.key] = null;

          for (const r of chunk) {
            const bk = normalizeBookKey(r.bookmaker_key);
            if (!bk) continue;

            const name = (r.outcome_name ?? "").toLowerCase();
            const want = totalSide === "over" ? "over" : "under";
            if (!name.includes(want)) continue;

            offersByBook[bk] = {
              line: r.point,
              price: r.price,
              ts: r.ts ?? null,
            };
          }

          return {
            event_id,
            commence_time: meta.commence_time,
            dateKey,
            rowType: "total",
            side: null,
            totalSide,
            teamCanonical: "", // totals row
            labelLeft: totalSide === "over" ? "Over" : "Under",
            labelRight: `${meta.away_team} vs ${meta.home_team}`,
            timeLabel,
            offersByBook,
          };
        };

        out.push(makeTotalsRow("over"));
        out.push(makeTotalsRow("under"));
        continue;
      }

      const makeTeamRow = (side: TeamSide): BoardRow => {
        const team = side === "away" ? meta.away_team : meta.home_team;

        const offersByBook = {} as Record<BookKey, CellOffer | null>;
        for (const b of BOOKS) offersByBook[b.key] = null;

        for (const r of chunk) {
          const bk = normalizeBookKey(r.bookmaker_key);
          if (!bk) continue;

          const on = (r.outcome_name ?? "").toLowerCase();
          const teamLower = team.toLowerCase();

          // outcome matching: supports team names, "Home"/"Away", etc.
          const isMatch =
            on === teamLower ||
            (side === "away" && on === "away") ||
            (side === "home" && on === "home") ||
            on.includes(teamLower);

          if (!isMatch) continue;

          offersByBook[bk] = {
            line: market === "spreads" ? r.point : null,
            price: r.price,
            ts: r.ts ?? null,
          };
        }

        return {
          event_id,
          commence_time: meta.commence_time,
          dateKey,
          rowType: "team",
          side,
          totalSide: null,
          teamCanonical: team,
          labelLeft: team,
          labelRight: "",
          timeLabel,
          offersByBook,
        };
      };

      out.push(makeTeamRow("away"));
      out.push(makeTeamRow("home"));
    }

    return out;
  }, [snapshots, events, metaByEvent, market, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, BoardRow[]>();
    for (const r of boardRows) {
      if (!map.has(r.dateKey)) map.set(r.dateKey, []);
      map.get(r.dateKey)!.push(r);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [boardRows]);

  const sportsbookCount = BOOKS.length;

  // Abbr + logo helpers
  const getAbbr = (canonical: string) => {
    const m = teamMap[canonical];
    return (m?.abbreviation || m?.abbreviation2 || canonical.slice(0, 3)).toUpperCase();
  };
  const getLogo = (canonical: string) => {
    const m = teamMap[canonical];
    return m?.logo_url || null;
  };

  /* =========================================================
     RENDER
========================================================= */

  return (
    <div
      className="min-h-screen"
      style={{
        background: THEME.bg,
        color: THEME.text,
      }}
    >
      {/* Top sport tabs */}
      <div
        className="px-4 pt-3"
        style={{
          borderBottom: `1px solid ${THEME.border2}`,
          background: "linear-gradient(180deg, rgba(212,175,55,0.10), rgba(0,0,0,0))",
        }}
      >
        <div className="flex items-center gap-2 overflow-x-auto pb-2">
          {SPORT_TABS.map((t) => {
            const active = sportKey === t.key || (t.key === "ufc" && sportKey === "mma_mixed_martial_arts");
            return (
              <button
                key={t.key}
                onClick={() =>
                  setSportKey(t.key === "ufc" ? "mma_mixed_martial_arts" : t.key)
                }
                className="px-3 py-2 rounded-md text-sm font-semibold whitespace-nowrap"
                style={{
                  background: active ? `rgba(212,175,55,0.16)` : "transparent",
                  border: `1px solid ${active ? THEME.gold2 : "transparent"}`,
                  color: active ? THEME.gold : THEME.text,
                }}
              >
                {t.label}
              </button>
            );
          })}

          <div className="ml-auto flex items-center gap-2">
            <div
              className="text-xs"
              style={{ color: THEME.dim }}
            >
              {lastUpdated ? `Last updated ${lastUpdated} CT` : "—"}
            </div>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="px-4 pt-4">
        <div
          className="rounded-xl overflow-hidden"
          style={{
            border: `1px solid ${THEME.border}`,
            background: `linear-gradient(180deg, ${THEME.panel}, ${THEME.bg})`,
          }}
        >
          <div className="p-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={market}
                onChange={(v) => setMarket(v as MarketMode)}
                options={[
                  { value: "spreads", label: "Point Spread" },
                  { value: "h2h", label: "Moneyline" },
                  { value: "totals", label: "Total" },
                ]}
              />

              <button
                onClick={() => setPhase((p) => (p === "pregame" ? "live" : "pregame"))}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm"
                style={{
                  background: THEME.panel2,
                  border: `1px solid ${THEME.border}`,
                  color: THEME.text,
                }}
                title="Toggle Pre Game / Live"
              >
                {phase === "pregame" ? (
                  <>
                    <ToggleLeft className="w-4 h-4" style={{ color: THEME.dim }} />
                    <span>Pre Game</span>
                  </>
                ) : (
                  <>
                    <ToggleRight className="w-4 h-4" style={{ color: THEME.gold }} />
                    <span>Live</span>
                  </>
                )}
              </button>

              <Chip
                icon={<CalendarDays className="w-4 h-4" style={{ color: THEME.dim }} />}
                label={selectedDate}
              />

              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1"
                style={{
                  background: THEME.panel2,
                  border: `1px solid ${THEME.border}`,
                  color: THEME.text,
                }}
              />

              <div className="flex-1" />

              <div className="relative w-full sm:w-[340px]">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: THEME.dim }} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search teams…"
                  className="w-full rounded-md pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1"
                  style={{
                    background: THEME.panel2,
                    border: `1px solid ${THEME.border}`,
                    color: THEME.text,
                  }}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={format}
                onChange={(v) => setFormat(v as OddsFormat)}
                options={[{ value: "american", label: "American" }]}
              />
              <Chip label={`Sportsbooks (${sportsbookCount})`} />

              <button
                onClick={refresh}
                className="ml-auto flex items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold"
                style={{
                  background: `linear-gradient(180deg, rgba(212,175,55,0.22), rgba(212,175,55,0.10))`,
                  border: `1px solid ${THEME.gold2}`,
                  color: THEME.text,
                }}
              >
                <RefreshCcw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>

            <div className="flex items-center justify-between text-xs" style={{ color: THEME.dim }}>
              <div>
                {boardRows.length} rows ·{" "}
                {market === "spreads" ? "Point spreads" : market === "h2h" ? "Moneylines" : "Totals"}
              </div>
              <div>
                Feed: {events.length > 0 ? "events + odds" : "odds-only"} · {snapshots.length} offers
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Board */}
      <div className="px-4 pb-6 pt-3">
        <div
          className="rounded-xl overflow-hidden"
          style={{
            border: `1px solid ${THEME.border}`,
            background: THEME.bg,
          }}
        >
          <div className="overflow-x-auto">
            <table className="min-w-[1100px] w-full border-collapse">
              <thead
                className="sticky top-0 z-10"
                style={{
                  background: THEME.panel,
                  borderBottom: `1px solid ${THEME.border}`,
                }}
              >
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold w-[380px]" style={{ color: THEME.muted }}>
                    Game
                  </th>
                  <th className="text-left px-3 py-3 text-xs font-semibold w-[90px]" style={{ color: THEME.muted }}>
                    Time
                  </th>

                  {BOOKS.map((b) => (
                    <th
                      key={b.key}
                      className="px-2 py-3 text-center text-xs font-semibold w-[120px]"
                      style={{ color: THEME.muted }}
                    >
                      <div className="flex items-center justify-center gap-2">
                        {BOOK_ICON[b.key] ? (
                          <img src={BOOK_ICON[b.key]} alt={b.label} className="h-4 w-auto opacity-95" />
                        ) : (
                          <span className="opacity-90">{b.label}</span>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {grouped.length === 0 && (
                  <tr>
                    <td colSpan={2 + BOOKS.length} className="px-4 py-10 text-center text-sm" style={{ color: THEME.dim }}>
                      No games found for this date/phase.
                    </td>
                  </tr>
                )}

                {grouped.map(([dateKey, rowsForDate]) => {
                  const dateHeaderLabel =
                    rowsForDate.length > 0 ? fmtDateHeaderCT(rowsForDate[0].commence_time) : dateKey;

                  return (
                    <React.Fragment key={dateKey}>
                      <tr style={{ background: THEME.panel2 }}>
                        <td
                          colSpan={2 + BOOKS.length}
                          className="px-4 py-2 text-xs font-semibold"
                          style={{ color: THEME.gold }}
                        >
                          {dateHeaderLabel}
                        </td>
                      </tr>

                      {rowsForDate.map((r, idx) => {
                        const showGameDivider =
                          idx > 0 && rowsForDate[idx - 1].event_id !== r.event_id;

                        const meta = metaByEvent[r.event_id];
                        const matchup = meta ? `${getAbbr(meta.away_team)} vs ${getAbbr(meta.home_team)}` : "";

                        const logo = r.rowType === "team" ? getLogo(r.teamCanonical) : null;
                        const abbr = r.rowType === "team" ? getAbbr(r.teamCanonical) : "";

                        return (
                          <React.Fragment
                            key={`${r.event_id}-${r.rowType}-${r.side ?? r.totalSide}`}
                          >
                            {showGameDivider && (
                              <tr>
                                <td
                                  colSpan={2 + BOOKS.length}
                                  className="h-[8px]"
                                  style={{
                                    background: THEME.bg,
                                    borderTop: `1px solid ${THEME.border2}`,
                                  }}
                                />
                              </tr>
                            )}

                            <tr
                              style={{
                                borderTop: `1px solid ${THEME.border2}`,
                              }}
                            >
                              {/* Team cell */}
                              <td className="px-4 py-3 align-middle">
                                <div className="flex items-center gap-3">
                                  {r.rowType === "team" ? (
                                    <div className="flex items-center gap-2 min-w-0">
                                      {logo ? (
                                        <img
                                          src={logo}
                                          alt={abbr}
                                          className="h-6 w-6 rounded-sm"
                                          style={{ objectFit: "contain" }}
                                        />
                                      ) : (
                                        <div
                                          className="h-6 w-6 rounded-sm"
                                          style={{
                                            background: THEME.panel2,
                                            border: `1px solid ${THEME.border}`,
                                          }}
                                        />
                                      )}
                                      <div className="min-w-0">
                                        <div className="text-sm font-semibold truncate" style={{ color: THEME.text }}>
                                          {r.labelLeft}
                                        </div>
                                        <div className="text-xs truncate" style={{ color: THEME.dim }}>
                                          {matchup}
                                        </div>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="min-w-0">
                                      <div className="text-sm font-semibold" style={{ color: THEME.text }}>
                                        {r.labelLeft}
                                      </div>
                                      <div className="text-xs truncate" style={{ color: THEME.dim }}>
                                        {r.labelRight}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </td>

                              {/* Time */}
                              <td className="px-3 py-3 text-xs" style={{ color: THEME.muted }}>
                                {r.timeLabel}
                              </td>

                              {/* Book columns */}
                              {BOOKS.map((b) => {
                                const offer = r.offersByBook[b.key];
                                const has = offer && (offer.price != null || offer.line != null);

                                return (
                                  <td key={b.key} className="px-2 py-2 text-center align-middle">
                                    <div
                                      className="mx-auto w-[104px] rounded-md px-2 py-2"
                                      style={{
                                        background: THEME.panel2,
                                        border: `1px solid ${THEME.border}`,
                                        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.02)",
                                      }}
                                    >
                                      {!has ? (
                                        <div className="text-xs" style={{ color: "#3b4a5b" }}>
                                          —
                                        </div>
                                      ) : market === "h2h" ? (
                                        <div className="text-xs font-semibold tabular-nums" style={{ color: THEME.text }}>
                                          {fmtAmerican(offer?.price)}
                                        </div>
                                      ) : (
                                        <div className="space-y-[2px] text-xs font-semibold tabular-nums">
                                          <div style={{ color: THEME.text }}>
                                            {offer?.line != null
                                              ? market === "totals"
                                                ? offer.line.toFixed(1)
                                                : fmtLine(offer.line)
                                              : ""}
                                          </div>
                                          <div style={{ color: THEME.muted }}>
                                            {fmtAmerican(offer?.price)}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </td>
                                );
                              })}
                            </tr>
                          </React.Fragment>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div
            className="flex items-center justify-between px-4 py-3 text-xs"
            style={{
              borderTop: `1px solid ${THEME.border}`,
              background: THEME.panel,
              color: THEME.dim,
            }}
          >
            <div>Showing {boardRows.length} rows</div>
            <div className="italic">Market Board · Pittsburgh Theme</div>
          </div>
        </div>
      </div>
    </div>
  );
}

