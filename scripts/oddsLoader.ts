/**
 * Odds Loader — The Odds API -> Supabase (events + odds_snapshot)
 *
 * SAFE GUARANTEES:
 * - DOES NOT rename or modify any existing tables
 * - DOES NOT change odds_snapshot behavior
 * - ONLY ADDS:
 *   • odds_snapshot_history (append-only)
 *   • pruning to last 10 snapshots per thing
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
    .replace(/\u00A0/g, " ")
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

  const homeObj =
    o1Key === homeKey ? o1 : o1Key === awayKey ? o2 : o1;
  const awayObj =
    o1Key === homeKey ? o2 : o1Key === awayKey ? o1 : o2;

  return { homeObj, awayObj };
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

  const aliasMap = new Map<string, string>();

  for (const r of data as TeamMapRow[]) {
    if (!r.canonical) continue;

    aliasMap.set(normalizeTeamKey(r.canonical), r.canonical);

    if (r["The Odds API"])
      aliasMap.set(normalizeTeamKey(r["The Odds API"]), r.canonical);
    if (r.ESPN_Long)
      aliasMap.set(normalizeTeamKey(r.ESPN_Long), r.canonical);
    if (r.SR_School)
      aliasMap.set(normalizeTeamKey(r.SR_School), r.canonical);
    if (r.SR_School_Short)
      aliasMap.set(normalizeTeamKey(r.SR_School_Short), r.canonical);
    if (r.KenPom)
      aliasMap.set(normalizeTeamKey(r.KenPom), r.canonical);
    if (r.Elo)
      aliasMap.set(normalizeTeamKey(r.Elo), r.canonical);
  }

  return aliasMap;
}

async function fetchOddsApi(
  sportKey: string,
  markets: string,
  bookmakers: string,
  apiKey: string
): Promise<OddsApiEvent[]> {
  const url =
    `https://api.the-odds-api.com/v4/sports/${sportKey}/odds` +
    `?apiKey=${apiKey}` +
    `&bookmakers=${encodeURIComponent(bookmakers)}` +
    `&markets=${encodeURIComponent(markets)}` +
    `&oddsFormat=american&dateFormat=iso`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/* ===========================
   Main
=========================== */

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const sportKey = process.env.SPORT_KEY || DEFAULT_SPORT_KEY;
  const markets = process.env.MARKETS || DEFAULT_MARKETS;
  const bookmakers = process.env.BOOKMAKERS || DEFAULT_BOOKMAKERS;

  const aliasMap = await buildAliasMap(supabase);
  const missingTeams = new Set<string>();

  const canonicalize = (name: string) => {
    const key = normalizeTeamKey(name);
    const canon = aliasMap.get(key);
    if (!canon) missingTeams.add(name);
    return canon || name;
  };

  const events = await fetchOddsApi(
    sportKey,
    markets,
    bookmakers,
    process.env.ODDS_API_KEY!
  );

  /* ---- Events upsert (unchanged) ---- */
  const eventRows = events.map((e) => ({
    event_id: e.id,
    sport_key: sportKey,
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
    await supabase.from("events").upsert(batch, { onConflict: "event_id" });
  }

  /* ---- Build snapshot rows ---- */
  const ts = new Date().toISOString();
  const snapshotRows: SnapshotRow[] = [];

  for (const e of events) {
    for (const bk of e.bookmakers || []) {
      for (const mk of bk.markets || []) {
        const outs = mk.outcomes || [];
        const lastUpdate = isoOrNull(bk.last_update);

        if (mk.key === "totals") {
          const over = findOutcome(outs, "Over");
          const under = findOutcome(outs, "Under");
          const line =
            typeof over?.point === "number"
              ? over.point
              : typeof under?.point === "number"
              ? under.point
              : null;

          snapshotRows.push(
            { ts, sport_key: sportKey, event_id: e.id, bookmaker: bk.key, market: mk.key, side: "over", line, odds: over?.price ?? null, last_update: lastUpdate },
            { ts, sport_key: sportKey, event_id: e.id, bookmaker: bk.key, market: mk.key, side: "under", line, odds: under?.price ?? null, last_update: lastUpdate }
          );
        }

        if (mk.key === "h2h" || mk.key === "spreads") {
          const { homeObj, awayObj } = splitHomeAwayOutcomes(
            e.home_team,
            e.away_team,
            outs
          );

          snapshotRows.push(
            {
              ts,
              sport_key: sportKey,
              event_id: e.id,
              bookmaker: bk.key,
              market: mk.key,
              side: "home",
              line: mk.key === "spreads" ? homeObj?.point ?? null : null,
              odds: homeObj?.price ?? null,
              last_update: lastUpdate,
            },
            {
              ts,
              sport_key: sportKey,
              event_id: e.id,
              bookmaker: bk.key,
              market: mk.key,
              side: "away",
              line: mk.key === "spreads" ? awayObj?.point ?? null : null,
              odds: awayObj?.price ?? null,
              last_update: lastUpdate,
            }
          );
        }
      }
    }
  }

  /* ---- Existing snapshot upsert (UNCHANGED) ---- */
  for (const batch of chunk(snapshotRows, 1000)) {
    await supabase
      .from("odds_snapshot")
      .upsert(batch, { onConflict: "ts,event_id,bookmaker,market,side" });
  }

  /* ---- NEW: history append + prune ---- */
  for (const batch of chunk(snapshotRows, 1000)) {
    await supabase.from("odds_snapshot_history").insert(batch);
  }

  await supabase.rpc("prune_odds_snapshot_history", { keep_n: 10 });

  console.log({
    ok: true,
    events: events.length,
    snapshots: snapshotRows.length,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
