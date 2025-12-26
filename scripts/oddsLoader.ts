/**
 * Odds Loader — The Odds API → Supabase
 *
 * Supports split workflows via LOADER_MODE:
 *   - LOADER_MODE=games  → ONLY featured game markets (h2h/spreads/totals)
 *   - LOADER_MODE=props  → ONLY NBA player props (points/reb/ast/3PM) via event endpoint
 *   - LOADER_MODE=all    → both (useful for manual runs)
 *
 * SNAPSHOT MODE (HARD GUARANTEES):
 * - events:
 *   • ONLY events returned by featured Odds API call remain (per sport)
 *   • stale events pruned via RPC if available
 *
 * - odds_snapshot (GAME markets):
 *   • FULL RESET each run (per sport)
 * - odds_snapshot_history:
 *   • append-only
 *   • pruned via RPC if available
 *
 * - player_props_snapshot (NBA props):
 *   • FULL RESET each run (per sport)
 * - player_props_history:
 *   • append-only
 *   • pruned via RPC if available
 *
 * IMPORTANT:
 * Player props markets are NOT supported on the main /odds endpoint.
 * They must be fetched per event via /events/{eventId}/odds.
 */

import "dotenv/config"; // safe for local; GitHub Actions injects env vars regardless
import { createClient } from "@supabase/supabase-js";

/* ===========================
   Types
=========================== */

type OddsApiOutcome = {
  name: string; // "Over"/"Under" OR team names for h2h/spreads
  price: number; // american odds
  point?: number; // line
  description?: string; // usually player name for props
};

type OddsApiMarket = {
  key: string;
  outcomes: OddsApiOutcome[];
};

type OddsApiBookmaker = {
  key: string;
  last_update?: string;
  markets: OddsApiMarket[];
};

type OddsApiEvent = {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
};

// /events/{eventId}/odds returns a single event object (same-ish shape)
type OddsApiEventOdds = OddsApiEvent;

type TeamMapRow = {
  canonical: string;
  "The Odds API"?: string | null;
  ESPN_Long?: string | null;
  SR_School?: string | null;
  SR_School_Short?: string | null;
  KenPom?: string | null;
  Elo?: string | null;
};

type GameSnapshotRow = {
  ts: string;
  sport_key: string;
  event_id: string;
  bookmaker: string;
  market: string; // h2h | spreads | totals
  side: "home" | "away" | "over" | "under";
  line: number | null;
  odds: number | null;
  last_update: string | null;
};

type PlayerPropsRow = {
  ts: string;
  run_id?: string | null;

  sport_key: string;
  event_id: string;
  commence_time?: string | null;

  home_team?: string | null;
  away_team?: string | null;

  player_name: string;
  player_id?: string | null;

  team?: string | null;
  opponent?: string | null;

  market: string; // player_points | player_rebounds | player_assists | player_threes
  side: "over" | "under";
  line: number;
  odds: number;

  bookmaker: string;
  source?: string | null;
};

/* ===========================
   Defaults
=========================== */

const DEFAULT_SPORT_KEYS = "basketball_ncaab,basketball_nba";
const DEFAULT_GAME_MARKETS = "h2h,spreads,totals";
const DEFAULT_PROPS_MARKETS =
  "player_points,player_rebounds,player_assists,player_threes";
const DEFAULT_BOOKMAKERS = "draftkings,fanduel,betmgm,betonlineag,pinnacle";

const SUPPORTED_GAME_MARKETS = new Set(["h2h", "spreads", "totals"]);
const SUPPORTED_PROP_MARKETS = new Set([
  "player_points",
  "player_rebounds",
  "player_assists",
  "player_threes",
]);

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

function findOutcome(outcomes: OddsApiOutcome[], name: string) {
  return (outcomes || []).find((o) => o?.name === name) || null;
}

function splitHomeAwayOutcomes(
  eventHome: string,
  eventAway: string,
  outs: OddsApiOutcome[]
) {
  const home = findOutcome(outs, eventHome);
  const away = findOutcome(outs, eventAway);

  const o1 = home || outs[0] || null;
  const o2 = away || outs[1] || null;

  const o1Key = normalizeTeamKey(o1?.name || "");
  const homeKey = normalizeTeamKey(eventHome);

  return {
    homeObj: o1Key === homeKey ? o1 : o2,
    awayObj: o1Key === homeKey ? o2 : o1,
  };
}

function safeRunId(): string {
  // Node 18+ has global crypto.randomUUID()
  // @ts-ignore
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `run_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isNBA(sportKey: string) {
  return sportKey === "basketball_nba";
}

function parseList(s?: string): string[] {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// Small concurrency limiter for per-event props calls
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }

  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

/* ===========================
   Supabase helpers
=========================== */

async function tryRpc(
  supabase: ReturnType<typeof createClient>,
  fn: string,
  args: Record<string, any>
) {
  const { error } = await supabase.rpc(fn, args);
  if (!error) return;

  const code = (error as any).code;
  const msg = (error as any).message || String(error);

  // RPC missing → skip gracefully
  if (code === "42883" || /does not exist/i.test(msg)) {
    console.warn(`[warn] RPC missing, skipped: ${fn}`);
    return;
  }
  throw error;
}

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
      if (typeof v === "string" && v.trim()) {
        map.set(normalizeTeamKey(v), r.canonical);
      }
    });
  }
  return map;
}

/* ===========================
   Odds API fetchers
=========================== */

async function fetchOddsApiFeatured(params: {
  sportKey: string;
  markets: string;
  bookmakers: string;
  apiKey: string;
}): Promise<OddsApiEvent[]> {
  const { sportKey, markets, bookmakers, apiKey } = params;

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

async function fetchOddsApiEventOdds(params: {
  sportKey: string;
  eventId: string;
  markets: string;
  bookmakers: string;
  apiKey: string;
}): Promise<OddsApiEventOdds | null> {
  const { sportKey, eventId, markets, bookmakers, apiKey } = params;

  const url =
    `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${eventId}/odds` +
    `?apiKey=${apiKey}` +
    `&markets=${encodeURIComponent(markets)}` +
    `&bookmakers=${encodeURIComponent(bookmakers)}` +
    `&oddsFormat=american&dateFormat=iso`;

  const res = await fetch(url);

  // event could vanish; ignore quietly
  if (res.status === 404) return null;

  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/* ===========================
   Builders
=========================== */

function buildGameSnapshotRows(params: {
  ts: string;
  sportKey: string;
  events: OddsApiEvent[];
}): GameSnapshotRow[] {
  const { ts, sportKey, events } = params;
  const snapshot: GameSnapshotRow[] = [];

  for (const e of events) {
    for (const bk of e.bookmakers || []) {
      for (const mk of bk.markets || []) {
        if (!SUPPORTED_GAME_MARKETS.has(mk.key)) continue;

        const outs = mk.outcomes || [];

        if (mk.key === "totals") {
          const over = findOutcome(outs, "Over");
          const under = findOutcome(outs, "Under");
          const line = (over?.point ?? under?.point ?? null) as number | null;

          snapshot.push(
            {
              ts,
              sport_key: sportKey,
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
              sport_key: sportKey,
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
              sport_key: sportKey,
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
              sport_key: sportKey,
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

  return snapshot;
}

// Props outcomes are usually keyed by player in `description`
function buildPlayerPropsRows(params: {
  ts: string;
  run_id: string;
  sportKey: string;
  event: OddsApiEventOdds;
  bookmaker: OddsApiBookmaker;
  market: OddsApiMarket;
}): PlayerPropsRow[] {
  const { ts, run_id, sportKey, event, bookmaker, market } = params;

  const outs = market.outcomes || [];

  const byPlayer = new Map<
    string,
    { over?: OddsApiOutcome; under?: OddsApiOutcome }
  >();

  for (const o of outs) {
    const nm = (o?.name || "").toLowerCase();
    const isOver = nm === "over";
    const isUnder = nm === "under";
    if (!isOver && !isUnder) continue;

    const player = (o.description || "").trim();
    if (!player) continue;

    if (!byPlayer.has(player)) byPlayer.set(player, {});
    const entry = byPlayer.get(player)!;

    if (isOver) entry.over = o;
    if (isUnder) entry.under = o;
  }

  const rows: PlayerPropsRow[] = [];

  for (const [player_name, pair] of byPlayer.entries()) {
    const over = pair.over;
    const under = pair.under;

    const lineRaw = over?.point ?? under?.point;
    const line = Number(lineRaw);
    if (!Number.isFinite(line)) continue;

    if (over?.price !== undefined && over?.price !== null) {
      rows.push({
        ts,
        run_id,
        sport_key: sportKey,
        event_id: event.id,
        commence_time: isoOrNull(event.commence_time),
        home_team: event.home_team,
        away_team: event.away_team,
        player_name,
        market: market.key,
        side: "over",
        line,
        odds: Number(over.price),
        bookmaker: bookmaker.key,
        source: "oddsapi",
      });
    }

    if (under?.price !== undefined && under?.price !== null) {
      rows.push({
        ts,
        run_id,
        sport_key: sportKey,
        event_id: event.id,
        commence_time: isoOrNull(event.commence_time),
        home_team: event.home_team,
        away_team: event.away_team,
        player_name,
        market: market.key,
        side: "under",
        line,
        odds: Number(under.price),
        bookmaker: bookmaker.key,
        source: "oddsapi",
      });
    }
  }

  return rows;
}

/* ===========================
   Loaders (games / props)
=========================== */

async function loadGamesForSport(params: {
  supabase: ReturnType<typeof createClient>;
  aliasMap: Map<string, string>;
  sportKey: string;
  gameMarkets: string;
  bookmakers: string;
  apiKey: string;
  ts: string;
}) {
  const { supabase, aliasMap, sportKey, gameMarkets, bookmakers, apiKey, ts } =
    params;

  const missingTeams = new Set<string>();
  const canonicalize = (name: string) => {
    const canon = aliasMap.get(normalizeTeamKey(name));
    if (!canon) missingTeams.add(name);
    return canon ?? name;
  };

  // Featured markets
  const apiEventsGame = await fetchOddsApiFeatured({
    sportKey,
    markets: gameMarkets,
    bookmakers,
    apiKey,
  });

  const seenEventIds = apiEventsGame.map((e) => e.id);

  // Prune events to only those seen
  if (seenEventIds.length === 0) {
    await tryRpc(supabase, "clear_events_for_sport", { p_sport_key: sportKey });
  } else {
    await tryRpc(supabase, "prune_events_not_in_ids", {
      p_sport_key: sportKey,
      p_event_ids: seenEventIds,
    });
  }

  // Upsert events
  const eventRows = apiEventsGame.map((e) => ({
    event_id: e.id,
    sport_key: sportKey,
    commence_time: e.commence_time,

    api_home_team: e.home_team,
    api_away_team: e.away_team,

    canon_home_team: canonicalize(e.home_team),
    canon_away_team: canonicalize(e.away_team),

    matchup: matchup(canonicalize(e.away_team), canonicalize(e.home_team)),

    updated_at: new Date().toISOString(),
  }));

  for (const batch of chunk(eventRows, 500)) {
    const { error } = await supabase
      .from("events")
      .upsert(batch, { onConflict: "event_id" });
    if (error) throw error;
  }

  // Build + write snapshots
  const gameSnapshot = buildGameSnapshotRows({
    ts,
    sportKey,
    events: apiEventsGame,
  });

  // Reset current snapshot (prefer RPC, fallback delete by sport)
  try {
    await tryRpc(supabase, "clear_odds_snapshot_for_sport", {
      p_sport_key: sportKey,
    });
  } catch {
    const { error } = await supabase
      .from("odds_snapshot")
      .delete()
      .eq("sport_key", sportKey);
    if (error) throw error;
  }

  for (const batch of chunk(gameSnapshot, 1000)) {
    const { error } = await supabase.from("odds_snapshot").upsert(batch, {
      onConflict: "ts,event_id,bookmaker,market,side",
    });
    if (error) throw error;
  }

  for (const batch of chunk(gameSnapshot, 1000)) {
    const { error } = await supabase.from("odds_snapshot_history").insert(batch);
    if (error) throw error;
  }

  await tryRpc(supabase, "prune_odds_snapshot_history", { keep_n: 432 });

  return {
    events_game: apiEventsGame.length,
    game_snapshots: gameSnapshot.length,
    seenEventIds,
    missingTeams: [...missingTeams],
  };
}

async function loadPropsForNBA(params: {
  supabase: ReturnType<typeof createClient>;
  sportKey: string; // must be basketball_nba
  propsMarkets: string;
  bookmakers: string;
  apiKey: string;
  ts: string;
  run_id: string;

  // we need event IDs for the per-event calls
  nbaEventIds: string[];
}) {
  const {
    supabase,
    sportKey,
    propsMarkets,
    bookmakers,
    apiKey,
    ts,
    run_id,
    nbaEventIds,
  } = params;

  if (!isNBA(sportKey)) {
    return { events_props: 0, props_snapshots: 0 };
  }

  const marketsList = parseList(propsMarkets).filter((m) =>
    SUPPORTED_PROP_MARKETS.has(m)
  );

  if (marketsList.length === 0 || nbaEventIds.length === 0) {
    // Still hard-reset current snapshot so UI doesn't show stale props forever
    const { error: delErr } = await supabase
      .from("player_props_snapshot")
      .delete()
      .eq("sport_key", sportKey);
    if (delErr) throw delErr;

    return { events_props: 0, props_snapshots: 0 };
  }

  const marketsParam = marketsList.join(",");

  // Pull per event (limit concurrency to protect quota)
  const concurrency = Number(process.env.PROPS_CONCURRENCY || "4");
  const eventOdds = await mapLimit(nbaEventIds, concurrency, async (eventId) => {
    return fetchOddsApiEventOdds({
      sportKey,
      eventId,
      markets: marketsParam,
      bookmakers,
      apiKey,
    });
  });

  const propsSnapshot: PlayerPropsRow[] = [];

  for (const ev of eventOdds) {
    if (!ev) continue;

    for (const bk of ev.bookmakers || []) {
      for (const mk of bk.markets || []) {
        if (!SUPPORTED_PROP_MARKETS.has(mk.key)) continue;

        propsSnapshot.push(
          ...buildPlayerPropsRows({
            ts,
            run_id,
            sportKey,
            event: ev,
            bookmaker: bk,
            market: mk,
          })
        );
      }
    }
  }

  // FULL RESET current props board (per sport)
  {
    const { error: delErr } = await supabase
      .from("player_props_snapshot")
      .delete()
      .eq("sport_key", sportKey);
    if (delErr) throw delErr;
  }

  // Insert current + history
  for (const batch of chunk(propsSnapshot, 1000)) {
    const { error } = await supabase.from("player_props_snapshot").upsert(batch, {
      onConflict: "event_id,bookmaker,market,player_name,side,line",
    });
    if (error) throw error;
  }

  for (const batch of chunk(propsSnapshot, 1000)) {
    const { error } = await supabase.from("player_props_history").insert(batch);
    if (error) throw error;
  }

  // Optional pruning RPC (skip if not created)
  await tryRpc(supabase, "prune_player_props_history", { keep_n: 10 });

  return { events_props: nbaEventIds.length, props_snapshots: propsSnapshot.length };
}

/* ===========================
   Entrypoint
=========================== */

async function main() {
  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    ODDS_API_KEY,

    SPORT_KEYS = DEFAULT_SPORT_KEYS,
    GAME_MARKETS = DEFAULT_GAME_MARKETS,
    PROPS_MARKETS = DEFAULT_PROPS_MARKETS,
    BOOKMAKERS = DEFAULT_BOOKMAKERS,

    LOADER_MODE = "all", // games | props | all
  } = process.env as Record<string, string>;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ODDS_API_KEY) {
    throw new Error(
      "Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ODDS_API_KEY"
    );
  }

  const mode = String(LOADER_MODE || "all").toLowerCase();
  const doGames = mode === "games" || mode === "all";
  const doProps = mode === "props" || mode === "all";

  const sportKeys = parseList(SPORT_KEYS);
  if (sportKeys.length === 0) throw new Error("No SPORT_KEYS provided.");

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const aliasMap = await buildAliasMap(supabase);

  // Single timestamp per run for consistent snapshots
  const ts = new Date().toISOString();
  const run_id = safeRunId();

  // We want NBA event IDs for props. Best source: events from the featured NBA fetch.
  let nbaEventIdsForProps: string[] = [];

  // Run games for each sport (this populates / prunes events as well)
  for (const sportKey of sportKeys) {
    if (!doGames) break;

    const out = await loadGamesForSport({
      supabase,
      aliasMap,
      sportKey,
      gameMarkets: GAME_MARKETS,
      bookmakers: BOOKMAKERS,
      apiKey: ODDS_API_KEY,
      ts,
    });

    if (isNBA(sportKey)) {
      nbaEventIdsForProps = out.seenEventIds;
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "games",
          sport: sportKey,
          ts,
          run_id,
          events_game: out.events_game,
          events_props: 0,
          game_snapshots: out.game_snapshots,
          props_snapshots: 0,
          missingTeams: out.missingTeams,
        },
        null,
        2
      )
    );
  }

  // Run props only (NBA)
  if (doProps) {
    const nbaKey = "basketball_nba";
    const useIds =
      nbaEventIdsForProps.length > 0
        ? nbaEventIdsForProps
        : // If this is a props-only workflow, we still need event IDs.
          // Fetch featured NBA events quickly (no write), then props.
          (await fetchOddsApiFeatured({
            sportKey: nbaKey,
            markets: "h2h", // lightest call just to get event IDs
            bookmakers: "pinnacle", // lightest; just need event ids
            apiKey: ODDS_API_KEY,
          })).map((e) => e.id);

    const propsOut = await loadPropsForNBA({
      supabase,
      sportKey: nbaKey,
      propsMarkets: PROPS_MARKETS,
      bookmakers: BOOKMAKERS,
      apiKey: ODDS_API_KEY,
      ts,
      run_id,
      nbaEventIds: useIds,
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "props",
          sport: nbaKey,
          ts,
          run_id,
          events_game: 0,
          events_props: propsOut.events_props,
          game_snapshots: 0,
          props_snapshots: propsOut.props_snapshots,
          missingTeams: [],
        },
        null,
        2
      )
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});



