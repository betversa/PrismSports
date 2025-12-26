/**
 * Odds Loader — The Odds API → Supabase
 *
 * SNAPSHOT MODE (HARD GUARANTEES):
 * - events table:
 *   • ONLY events returned by the Odds API for this sport remain
 *   • all stale events are deleted each run (via RPC if available)
 *
 * - odds_snapshot (GAME markets):
 *   • FULL RESET each run (per sport)
 *
 * - odds_snapshot_history:
 *   • append-only
 *   • pruned via RPC if available
 *
 * - player_props_snapshot (NBA props):
 *   • FULL RESET each run (per sport)
 *
 * - player_props_history:
 *   • append-only
 *   • pruned via RPC if available
 */

import "dotenv/config"; // safe to keep for local; ignored in GitHub Actions if no .env
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
   Config defaults
=========================== */

const DEFAULT_SPORT_KEYS = "basketball_ncaab,basketball_nba";
const DEFAULT_GAME_MARKETS = "h2h,spreads,totals";
const DEFAULT_PROPS_MARKETS =
  "player_points,player_rebounds,player_assists,player_threes";
const DEFAULT_BOOKMAKERS = "draftkings,fanduel,betmgm,betonlineag,pinnacle";

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

async function tryRpc(
  supabase: ReturnType<typeof createClient>,
  fn: string,
  args: Record<string, any>
) {
  const { error } = await supabase.rpc(fn, args);
  if (!error) return;

  const code = (error as any).code;
  const msg = (error as any).message || String(error);

  // Undefined function (RPC missing) → skip gracefully
  if (code === "42883" || /does not exist/i.test(msg)) {
    console.warn(`[warn] RPC missing, skipped: ${fn}`);
    return;
  }
  throw error;
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

    // map all variation fields → canonical
    Object.values(r).forEach((v) => {
      if (typeof v === "string" && v.trim()) {
        map.set(normalizeTeamKey(v), r.canonical);
      }
    });
  }
  return map;
}

/* ===========================
   Odds API fetch
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
   Props parsing
=========================== */

// Expectation from Odds API for props outcomes:
// { name: "Over"/"Under", point: 24.5, price: -110, description: "Player Name" }
function buildPlayerPropsRows(params: {
  ts: string;
  run_id: string;
  sport_key: string;
  event: OddsApiEvent;
  bookmaker: OddsApiBookmaker;
  market: OddsApiMarket;
}): PlayerPropsRow[] {
  const { ts, run_id, sport_key, event, bookmaker, market } = params;

  const outs = market.outcomes || [];
  const byPlayer = new Map<string, { over?: OddsApiOutcome; under?: OddsApiOutcome }>();

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
        sport_key,
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
        sport_key,
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
   Core runner per sport
=========================== */

async function runForSport(params: {
  supabase: ReturnType<typeof createClient>;
  aliasMap: Map<string, string>;
  sportKey: string;
  gameMarkets: string;
  propsMarkets: string;
  bookmakers: string;
  apiKey: string;
}) {
  const { supabase, aliasMap, sportKey, gameMarkets, propsMarkets, bookmakers, apiKey } =
    params;

  const ts = new Date().toISOString();
  const run_id = safeRunId();

  const missingTeams = new Set<string>();
  const canonicalize = (name: string) => {
    const canon = aliasMap.get(normalizeTeamKey(name));
    if (!canon) missingTeams.add(name);
    return canon ?? name;
  };

  // 1) Fetch game odds
  const apiEventsGame = await fetchOddsApi(sportKey, gameMarkets, bookmakers, apiKey);

  // 2) Fetch props (NBA only)
  const includeProps = isNBA(sportKey) && propsMarkets.trim().length > 0;
  const apiEventsProps = includeProps
    ? await fetchOddsApi(sportKey, propsMarkets, bookmakers, apiKey)
    : [];

  // Union events for pruning/upserting events table
  const eventsById = new Map<string, OddsApiEvent>();
  for (const e of apiEventsGame) eventsById.set(e.id, e);
  for (const e of apiEventsProps) if (!eventsById.has(e.id)) eventsById.set(e.id, e);
  const apiEventsAll = [...eventsById.values()];
  const seenEventIds = apiEventsAll.map((e) => e.id);

  // 3) Prune events (RPC if you have it)
  if (seenEventIds.length === 0) {
    await tryRpc(supabase, "clear_events_for_sport", { p_sport_key: sportKey });
  } else {
    await tryRpc(supabase, "prune_events_not_in_ids", {
      p_sport_key: sportKey,
      p_event_ids: seenEventIds,
    });
  }

  // 4) Upsert events
  const eventRows = apiEventsAll.map((e) => ({
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
    const { error } = await supabase.from("events").upsert(batch, { onConflict: "event_id" });
    if (error) throw error;
  }

  // 5) Build GAME snapshot rows
  const gameSnapshot: GameSnapshotRow[] = [];

  for (const e of apiEventsGame) {
    for (const bk of e.bookmakers || []) {
      for (const mk of bk.markets || []) {
        const outs = mk.outcomes || [];

        if (mk.key === "totals") {
          const over = findOutcome(outs, "Over");
          const under = findOutcome(outs, "Under");
          const line = (over?.point ?? under?.point ?? null) as number | null;

          gameSnapshot.push(
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
          const { homeObj, awayObj } = splitHomeAwayOutcomes(e.home_team, e.away_team, outs);

          gameSnapshot.push(
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

  // 6) Build PROPS snapshot rows
  const propsSnapshot: PlayerPropsRow[] = [];

  if (includeProps) {
    for (const e of apiEventsProps) {
      for (const bk of e.bookmakers || []) {
        for (const mk of bk.markets || []) {
          if (
            mk.key !== "player_points" &&
            mk.key !== "player_rebounds" &&
            mk.key !== "player_assists" &&
            mk.key !== "player_threes"
          ) {
            continue;
          }

          propsSnapshot.push(
            ...buildPlayerPropsRows({
              ts,
              run_id,
              sport_key: sportKey,
              event: e,
              bookmaker: bk,
              market: mk,
            })
          );
        }
      }
    }
  }

  // 7) Reset + write odds_snapshot (GAME)
  // Use your existing reset RPC if you have it; else delete by sport_key
  await tryRpc(supabase, "clear_odds_snapshot_for_sport", { p_sport_key: sportKey }).catch(
    async (e) => {
      // If your RPC is missing, we fallback to delete directly
      console.warn(`[warn] clear_odds_snapshot_for_sport fallback to delete: ${sportKey}`);
      const { error } = await supabase.from("odds_snapshot").delete().eq("sport_key", sportKey);
      if (error) throw error;
      return;
    }
  );

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

  // 8) Reset + write props snapshot/history (NBA only)
  if (includeProps) {
    // FULL RESET per sport each run
    const { error: delErr } = await supabase
      .from("player_props_snapshot")
      .delete()
      .eq("sport_key", sportKey);
    if (delErr) throw delErr;

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

    // Optional RPC (if you create it). If missing, it just warns + continues.
    await tryRpc(supabase, "prune_player_props_history", { keep_n: 10 });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        sport: sportKey,
        ts,
        run_id,
        events_game: apiEventsGame.length,
        events_props: apiEventsProps.length,
        game_snapshots: gameSnapshot.length,
        props_snapshots: propsSnapshot.length,
        missingTeams: [...missingTeams],
      },
      null,
      2
    )
  );
}

/* ===========================
   Entrypoint
=========================== */

async function main() {
  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    ODDS_API_KEY,

    // GitHub Variables
    SPORT_KEYS = DEFAULT_SPORT_KEYS,
    GAME_MARKETS = DEFAULT_GAME_MARKETS,
    PROPS_MARKETS = DEFAULT_PROPS_MARKETS,
    BOOKMAKERS = DEFAULT_BOOKMAKERS,
  } = process.env as Record<string, string>;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ODDS_API_KEY) {
    throw new Error(
      "Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ODDS_API_KEY"
    );
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Canonical team map (shared)
  const aliasMap = await buildAliasMap(supabase);

  const sportKeys = String(SPORT_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (sportKeys.length === 0) {
    throw new Error("No SPORT_KEYS provided.");
  }

  for (const sportKey of sportKeys) {
    await runForSport({
      supabase,
      aliasMap,
      sportKey,
      gameMarkets: GAME_MARKETS,
      propsMarkets: PROPS_MARKETS,
      bookmakers: BOOKMAKERS,
      apiKey: ODDS_API_KEY,
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


