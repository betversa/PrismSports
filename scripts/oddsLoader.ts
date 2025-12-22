/**
 * Odds Loader — The Odds API -> Supabase (events + odds_snapshot)
 *
 * - Fetches odds for SPORT_KEY from The Odds API
 * - Canonicalizes team names via Supabase table: public.team_map
 *   New schema (no aliases[]):
 *     team_map.canonical (PK)
 *     team_map."The Odds API" (preferred match for this feed)
 *     team_map."ESPN_Long", "SR_School", "SR_School_Short", "KenPom", "Elo" (optional fallbacks)
 *
 * - Upserts events into public.events
 * - Logs unmapped teams into public.team_missing_log
 * - Upserts snapshot rows into public.odds_snapshot (unique by ts,event_id,bookmaker,market,side)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

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
        name: string; // team name OR "Over"/"Under"
        price: number; // american odds (int)
        point?: number; // spread/total line
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

const DEFAULT_SPORT_KEY = "basketball_ncaab";
const DEFAULT_MARKETS = "h2h,spreads,totals";
const DEFAULT_BOOKMAKERS =
  "draftkings,fanduel,betmgm,betrivers,hardrockbet,betonlineag,pinnacle";

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

/**
 * Determine which outcome corresponds to home vs away even if the API returns
 * outcomes in a different order or uses slightly different team strings.
 */
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

async function buildAliasMap(supabase: ReturnType<typeof createClient>) {
  // New schema: no aliases[] — use source columns
  const { data, error } = await supabase
    .from("team_map")
    .select('canonical,"The Odds API","ESPN_Long","SR_School","SR_School_Short","KenPom","Elo"');

  if (error) throw error;

  const aliasMap = new Map<string, string>();
  const rows = (data || []) as TeamMapRow[];

  for (const r of rows) {
    const canon = r.canonical;
    if (!canon) continue;

    // Always map canonical to itself
    aliasMap.set(normalizeTeamKey(canon), canon);

    // Primary feed column for this loader:
    if (r["The Odds API"]) aliasMap.set(normalizeTeamKey(r["The Odds API"]!), canon);

    // Optional fallbacks (helpful across sources)
    if (r.ESPN_Long) aliasMap.set(normalizeTeamKey(r.ESPN_Long), canon);
    if (r.SR_School) aliasMap.set(normalizeTeamKey(r.SR_School), canon);
    if (r.SR_School_Short) aliasMap.set(normalizeTeamKey(r.SR_School_Short), canon);
    if (r.KenPom) aliasMap.set(normalizeTeamKey(r.KenPom), canon);
    if (r.Elo) aliasMap.set(normalizeTeamKey(r.Elo), canon);
  }

  return aliasMap;
}

async function upsertMissingTeams(
  supabase: ReturnType<typeof createClient>,
  missingTeams: Set<string>
) {
  // Simple (and safe) per-row upsert-ish behavior
  for (const team of missingTeams) {
    const { data: existing, error: readErr } = await supabase
      .from("team_missing_log")
      .select("team_name, seen_count")
      .eq("team_name", team)
      .maybeSingle();

    if (readErr) throw readErr;

    if (!existing) {
      const { error } = await supabase
        .from("team_missing_log")
        .insert({ team_name: team });
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("team_missing_log")
        .update({
          last_seen: new Date().toISOString(),
          seen_count: (existing.seen_count || 1) + 1,
        })
        .eq("team_name", team);
      if (error) throw error;
    }
  }
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
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Odds API error ${res.status}: ${txt}`);
  }
  return (await res.json()) as OddsApiEvent[];
}

async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL!;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const ODDS_API_KEY = process.env.ODDS_API_KEY!;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ODDS_API_KEY) {
    throw new Error(
      "Missing env vars: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ODDS_API_KEY"
    );
  }

  const sportKey = process.env.SPORT_KEY || DEFAULT_SPORT_KEY;
  const markets = process.env.MARKETS || DEFAULT_MARKETS;
  const bookmakers = process.env.BOOKMAKERS || DEFAULT_BOOKMAKERS;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ---- 1) Build canonicalization map from team_map
  const aliasMap = await buildAliasMap(supabase);

  const missingTeams = new Set<string>();
  const canonicalize = (name: string) => {
    const raw = String(name || "").trim();
    const key = normalizeTeamKey(raw);
    const canon = aliasMap.get(key);
    if (canon) return canon;

    if (raw) missingTeams.add(raw);
    return raw; // fallback: still store something
  };

  // ---- 2) Fetch from The Odds API
  const events = await fetchOddsApi(sportKey, markets, bookmakers, ODDS_API_KEY);

  // ---- 3) Upsert events
  const eventUpserts = events.map((e) => {
    const canonHome = canonicalize(e.home_team);
    const canonAway = canonicalize(e.away_team);

    return {
      event_id: e.id,
      sport_key: sportKey,
      commence_time: e.commence_time,
      api_home_team: e.home_team,
      api_away_team: e.away_team,
      canon_home_team: canonHome,
      canon_away_team: canonAway,
      matchup: matchup(canonAway, canonHome),
      updated_at: new Date().toISOString(),
    };
  });

  for (const batch of chunk(eventUpserts, 500)) {
    const { error } = await supabase.from("events").upsert(batch, {
      onConflict: "event_id",
    });
    if (error) throw error;
  }

  // ---- 4) Log missing teams
  await upsertMissingTeams(supabase, missingTeams);

  // ---- 5) Build odds_snapshot rows
  const nowTs = new Date().toISOString();
  const snapshotRows: SnapshotRow[] = [];

  for (const e of events) {
    for (const bk of e.bookmakers || []) {
      const bookmakerKey = bk.key;
      const lastUpdate = isoOrNull(bk.last_update);

      for (const mk of bk.markets || []) {
        const market = mk.key;
        const outs = mk.outcomes || [];

        if (market === "totals") {
          const over = findOutcome(outs, "Over");
          const under = findOutcome(outs, "Under");
          const totalLine =
            typeof over?.point === "number"
              ? over.point
              : typeof under?.point === "number"
                ? under.point
                : null;

          snapshotRows.push({
            ts: nowTs,
            sport_key: sportKey,
            event_id: e.id,
            bookmaker: bookmakerKey,
            market,
            side: "over",
            line: totalLine,
            odds: typeof over?.price === "number" ? over.price : null,
            last_update: lastUpdate,
          });

          snapshotRows.push({
            ts: nowTs,
            sport_key: sportKey,
            event_id: e.id,
            bookmaker: bookmakerKey,
            market,
            side: "under",
            line: totalLine,
            odds: typeof under?.price === "number" ? under.price : null,
            last_update: lastUpdate,
          });
        }

        if (market === "h2h") {
          const { homeObj, awayObj } = splitHomeAwayOutcomes(
            e.home_team,
            e.away_team,
            outs
          );

          snapshotRows.push({
            ts: nowTs,
            sport_key: sportKey,
            event_id: e.id,
            bookmaker: bookmakerKey,
            market,
            side: "home",
            line: null,
            odds: typeof homeObj?.price === "number" ? homeObj.price : null,
            last_update: lastUpdate,
          });

          snapshotRows.push({
            ts: nowTs,
            sport_key: sportKey,
            event_id: e.id,
            bookmaker: bookmakerKey,
            market,
            side: "away",
            line: null,
            odds: typeof awayObj?.price === "number" ? awayObj.price : null,
            last_update: lastUpdate,
          });
        }

        if (market === "spreads") {
          const { homeObj, awayObj } = splitHomeAwayOutcomes(
            e.home_team,
            e.away_team,
            outs
          );

          snapshotRows.push({
            ts: nowTs,
            sport_key: sportKey,
            event_id: e.id,
            bookmaker: bookmakerKey,
            market,
            side: "home",
            line: typeof homeObj?.point === "number" ? homeObj.point : null,
            odds: typeof homeObj?.price === "number" ? homeObj.price : null,
            last_update: lastUpdate,
          });

          snapshotRows.push({
            ts: nowTs,
            sport_key: sportKey,
            event_id: e.id,
            bookmaker: bookmakerKey,
            market,
            side: "away",
            line: typeof awayObj?.point === "number" ? awayObj.point : null,
            odds: typeof awayObj?.price === "number" ? awayObj.price : null,
            last_update: lastUpdate,
          });
        }
      }
    }
  }

  // ---- 6) Upsert snapshots (avoid conflicts if job reruns quickly)
  for (const batch of chunk(snapshotRows, 1000)) {
    const { error } = await supabase
      .from("odds_snapshot")
      .upsert(batch, { onConflict: "ts,event_id,bookmaker,market,side" });
    if (error) throw error;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        sportKey,
        markets,
        bookmakers,
        events: events.length,
        snapshots: snapshotRows.length,
        missingTeams: missingTeams.size,
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

