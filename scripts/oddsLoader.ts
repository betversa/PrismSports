/**
 * Odds Loader — The Odds API → Supabase
 *
 * SNAPSHOT MODE (HARD GUARANTEES):
 * - events table:
 *   • ONLY events returned by the Odds API for this sport remain
 *   • all stale events are deleted each run
 *
 * - odds_snapshot:
 *   • FULL RESET each run (per sport)
 *
 * - odds_snapshot_history:
 *   • append-only
 *   • pruned to last 10 per (sport,event,book,market,side)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

/* ===========================
   Types
=========================== */

type OddsApiEvent = {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    last_update?: string;
    markets: Array<{
      key: "h2h" | "spreads" | "totals";
      outcomes: Array<{
        name: string;
        price: number;
        point?: number;
      }>;
    }>;
  }>;
};

type SnapshotRow = {
  ts: string;
  sport_key: string;
  event_id: string;
  bookmaker: string;
  market: string;
  side: "home" | "away" | "over" | "under";
  line: number | null;
  odds: number | null;
  last_update: string | null;
};

type TeamMapRow = {
  canonical: string;
  "The Odds API"?: string | null;
  ESPN_Long?: string | null;
  SR_School?: string | null;
  SR_School_Short?: string | null;
  KenPom?: string | null;
  Elo?: string | null;
};

/* ===========================
   Config
=========================== */

const DEFAULT_SPORT_KEY = "basketball_ncaab";
const DEFAULT_MARKETS = "h2h,spreads,totals";
const DEFAULT_BOOKMAKERS =
  "draftkings,fanduel,betmgm,betrivers,hardrockbet,betonlineag,pinnacle";

/* ===========================
   Helpers
=========================== */

function normalizeTeamKey(s: string) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\u00a0/g, " ")
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9\s&'.-]/g, "")
    .replace(/\s+/g, " ");
}

function matchup(away: string, home: string) {
  return `${away} @ ${home}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, (i + 1) * size)
  );
}

function isoOrNull(s?: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function findOutcome(outcomes: any[], name: string) {
  return (outcomes || []).find((o) => o?.name === name) || null;
}

function splitHomeAwayOutcomes(
  eventHome: string,
  eventAway: string,
  outs: Array<{ name: string; price: number; point?: number }>
) {
  const home = findOutcome(outs, eventHome);
  const away = findOutcome(outs, eventAway);

  const o1 = home || outs[0] || null;
  const o2 = away || outs[1] || null;

  const o1Key = normalizeTeamKey(o1?.name || "");
  const homeKey = normalizeTeamKey(eventHome);
  const awayKey = normalizeTeamKey(eventAway);

  return {
    homeObj: o1Key === homeKey ? o1 : o2,
    awayObj: o1Key === homeKey ? o2 : o1,
  };
}

/* ===========================
   Supabase helpers
=========================== */

async function buildAliasMap(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from("team_map")
    .select(
      'canonical,"The Odds API","ESPN_Long","SR_School","SR_School_Short","KenPom","Elo"'
    );

  if (error) throw error;

  const map = new Map<string, string>();
  for (const r of (data || []) as TeamMapRow[]) {
    if (!r.canonical) continue;
    map.set(normalizeTeamKey(r.canonical), r.canonical);

    Object.values(r).forEach((v) => {
      if (typeof v === "string") {
        map.set(normalizeTeamKey(v), r.canonical);
      }
    });
  }
  return map;
}

/* ===========================
   Odds API
=========================== */

async function fetchOddsApi(
  sportKey: string,
  markets: string,
  bookmakers: string,
  apiKey: string
): Promise<OddsApiEvent[]> {
  const url =
    `https://api.the-odds-api.com/v4/sports/${sportKey}/odds` +
    `?apiKey=${apiKey}` +
    `&markets=${encodeURIComponent(markets)}` +
    `&bookmakers=${encodeURIComponent(bookmakers)}` +
    `&oddsFormat=american&dateFormat=iso`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/* ===========================
   Main
=========================== */

async function main() {
  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    ODDS_API_KEY,
    SPORT_KEY = DEFAULT_SPORT_KEY,
    MARKETS = DEFAULT_MARKETS,
    BOOKMAKERS = DEFAULT_BOOKMAKERS,
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ODDS_API_KEY) {
    throw new Error("Missing required env vars.");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  /* ---- 1) Canonical team map */
  const aliasMap = await buildAliasMap(supabase);
  const missingTeams = new Set<string>();

  const canonicalize = (name: string) => {
    const canon = aliasMap.get(normalizeTeamKey(name));
    if (!canon) missingTeams.add(name);
    return canon ?? name;
  };

  /* ---- 2) Fetch Odds API events */
  const apiEvents = await fetchOddsApi(
    SPORT_KEY,
    MARKETS,
    BOOKMAKERS,
    ODDS_API_KEY
  );

  const seenEventIds = apiEvents.map((e) => e.id);

  /* ---- 3) SNAPSHOT PRUNE: events table */
  if (seenEventIds.length === 0) {
    await supabase.rpc("clear_events_for_sport", { p_sport_key: SPORT_KEY });
  } else {
    await supabase.rpc("prune_events_not_in_ids", {
      p_sport_key: SPORT_KEY,
      p_event_ids: seenEventIds,
    });
  }

  /* ---- 4) Upsert current events */
  const eventRows = apiEvents.map((e) => ({
    event_id: e.id,
    sport_key: SPORT_KEY,
    commence_time: e.commence_time,
    api_home_team: e.home_team,
    api_away_team: e.away_team,
    canon_home_team: canonicalize(e.home_team),
    canon_away_team: canonicalize(e.away_team),
    matchup: matchup(
      canonicalize(e.away_team),
      canonicalize(e.home_team)
    ),
    updated_at: new Date().toISOString(),
  }));

  for (const batch of chunk(eventRows, 500)) {
    const { error } = await supabase
      .from("events")
      .upsert(batch, { onConflict: "event_id" });
    if (error) throw error;
  }

  /* ---- 5) Build odds_snapshot rows */
  const ts = new Date().toISOString();
  const snapshot: SnapshotRow[] = [];

  for (const e of apiEvents) {
    for (const bk of e.bookmakers || []) {
      for (const mk of bk.markets || []) {
        const outs = mk.outcomes || [];

        if (mk.key === "totals") {
          const over = findOutcome(outs, "Over");
          const under = findOutcome(outs, "Under");
          const line = over?.point ?? under?.point ?? null;

          snapshot.push(
            {
              ts,
              sport_key: SPORT_KEY,
              event_id: e.id,
              bookmaker: bk.key,
              market: "totals",
              side: "over",
              line,
              odds: over?.price ?? null,
              last_update: isoOrNull(bk.last_update),
            },
            {
              ts,
              sport_key: SPORT_KEY,
              event_id: e.id,
              bookmaker: bk.key,
              market: "totals",
              side: "under",
              line,
              odds: under?.price ?? null,
              last_update: isoOrNull(bk.last_update),
            }
          );
        }

        if (mk.key === "h2h" || mk.key === "spreads") {
          const { homeObj, awayObj } = splitHomeAwayOutcomes(
            e.home_team,
            e.away_team,
            outs
          );

          snapshot.push(
            {
              ts,
              sport_key: SPORT_KEY,
              event_id: e.id,
              bookmaker: bk.key,
              market: mk.key,
              side: "home",
              line: homeObj?.point ?? null,
              odds: homeObj?.price ?? null,
              last_update: isoOrNull(bk.last_update),
            },
            {
              ts,
              sport_key: SPORT_KEY,
              event_id: e.id,
              bookmaker: bk.key,
              market: mk.key,
              side: "away",
              line: awayObj?.point ?? null,
              odds: awayObj?.price ?? null,
              last_update: isoOrNull(bk.last_update),
            }
          );
        }
      }
    }
  }

  /* ---- 6) Reset odds_snapshot */
  await supabase.rpc("clear_odds_snapshot_for_sport", {
    p_sport_key: SPORT_KEY,
  });

  for (const batch of chunk(snapshot, 1000)) {
    const { error } = await supabase
      .from("odds_snapshot")
      .upsert(batch, {
        onConflict: "ts,event_id,bookmaker,market,side",
      });
    if (error) throw error;
  }

  /* ---- 7) Append + prune history */
  for (const batch of chunk(snapshot, 1000)) {
    const { error } = await supabase
      .from("odds_snapshot_history")
      .insert(batch);
    if (error) throw error;
  }

  await supabase.rpc("prune_odds_snapshot_history", { keep_n: 10 });

  console.log(
    JSON.stringify(
      {
        ok: true,
        sport: SPORT_KEY,
        events: apiEvents.length,
        snapshots: snapshot.length,
        missingTeams: [...missingTeams],
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

