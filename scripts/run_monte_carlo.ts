/**
 * run_monte_carlo.ts — MULTI-SPORT (FULL REWRITE v5.3: ENGINE_POWER Margins + TOTALS 3-WAY BLEND)
 * ----------------------------------------------------------------------------------------------
 * Snapshot tables:
 *   ✅ monte_carlo_results: one row per (sport_key, event_id), overwritten each run
 *   ✅ monte_carlo_runs: history (one row per run)
 *   ✅ ev_plays: cleared per sport each run, then rebuilt
 *
 * Margin model (spreads/ML):
 *   ✅ marginMean = (home_engine_power - away_engine_power) + home_true_hca
 *
 * Totals model:
 *   ✅ 3-way blend with auto-renormalization if a component is missing:
 *      - Off/Def + pace total (per-100 -> per-game via paceGame/100)  [default weight 0.40]
 *      - PF/PA matchup total (per-game)                              [default weight 0.10]
 *      - Avg total points (per-game)                                 [default weight 0.50]
 *
 * Retains v5.1 features:
 *   ✅ Devig method SWITCH (normalize vs MPTO/Power)
 *   ✅ Tail-safe EV blending + optional tail guardrail
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

/* =========================================================
   TYPES
========================================================= */

type EventRow = {
  event_id: string;
  sport_key: string;
  commence_time: string; // timestamptz ISO
  matchup: string | null;

  api_home_team: string | null;
  api_away_team: string | null;

  canon_home_team: string | null;
  canon_away_team: string | null;
};

type TeamRatingRow = {
  canonical: string;

  // per-100 ratings (used in totals component #1)
  engine_adj_off: number | null;
  engine_adj_def: number | null;

  // per-game power (used for margin mean)
  engine_power: number | null;

  // per-game totals components
  pf_points: number | null; // points for
  pa_points: number | null; // points against
  avg_total_points: number | null;

  true_hca: number | null; // points per game

  // per-100 sigmas (scaled by paceFactor for game sigma)
  sigma_margin_100: number | null;
  sigma_total_100: number | null;
};

type MarketKey = "h2h" | "spreads" | "totals";
type SideKey = "home" | "away" | "over" | "under";

type OddsSnapshotRow = {
  event_id: string;
  bookmaker: string | null;
  market: MarketKey;
  side: SideKey;
  line: number | string | null;
  odds: number | null;
  ts: string;
};

type MonteCarloRunInsert = {
  sport_key: string;
  config: Record<string, any>;
};

type MonteCarloResultUpsert = {
  sport_key: string;
  event_id: string;
  run_id: string;

  commence_time: string | null;
  matchup: string | null;
  home_team: string | null;
  away_team: string | null;

  projected_margin_home: number;
  sigma_margin_game: number;

  projected_total: number;
  sigma_total_game: number;

  projected_home_points: number;
  projected_away_points: number;

  home_win_prob: number;
  away_win_prob: number;

  spread_line_home: number | null;
  home_cover_prob: number | null;
  cover_push_prob: number | null;
  away_cover_prob: number | null;

  total_line: number | null;
  over_prob: number | null;
  total_push_prob: number | null;
  under_prob: number | null;

  trace: Record<string, any> | null;
};

type EvPlayInsert = {
  sport_key: string;

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
};

type PossRow = {
  sport_key: string;
  season: string;
  canonical: string;

  "2025": number | null;
  "Last 3": number | null;
  "Last 1": number | null;
  "Home": number | null;
  "Away": number | null;
  "2024": number | null;
};

/* =========================================================
   ENV / CONFIG
========================================================= */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("[MC] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (preferred).");
}

const SPORT_KEYS = (process.env.SPORT_KEYS || process.env.SPORT_KEY || "basketball_ncaab,basketball_nba")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SEASON = process.env.SEASON || "2025-26";
const POSS_SEASON = process.env.POSS_SEASON || SEASON;

const SIMS = Number(process.env.MC_SIMS ?? "10000");
const START_GRACE_MINUTES = Number(process.env.MC_START_GRACE_MINUTES ?? "0");

// Floors (PER-GAME after pace scaling)
const SIGMA_MARGIN_FLOOR_GAME = Number(process.env.SIGMA_MARGIN_FLOOR ?? "8");
const SIGMA_TOTAL_FLOOR_GAME = Number(process.env.SIGMA_TOTAL_FLOOR ?? "13.5");

const WRITE_TRACE = (process.env.MC_WRITE_TRACE ?? "true").toLowerCase() === "true";
const MARGIN_HOME_WIN_NEGATIVE = (process.env.MARGIN_HOME_WIN_NEGATIVE ?? "true").toLowerCase() === "true";
const EPS = Number(process.env.MC_PUSH_EPS ?? "1e-9");

const SHARP_BOOKS = (process.env.EV_SHARP_BOOKS || "pinnacle,betonlineag,betonline")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const SOFT_BOOKS = (process.env.EV_SOFT_BOOKS || "draftkings,fanduel,betmgm")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const KELLY_MULTIPLIER = Number(process.env.KELLY_MULTIPLIER ?? "0.25");

const LINE_TOL = Number(process.env.LINE_TOL ?? "1e-6");
const MIN_EV_PCT = Number(process.env.MIN_EV_PCT ?? "0");

/**
 * Devig switching threshold:
 * - if sides are "close" (near 50/50), use equal-margin devig (normalize)
 * - else use MPTO / Power devig
 */
const DEVIG_DIFF_SWITCH = Number(process.env.DEVIG_DIFF_SWITCH ?? "0.10");

/**
 * Tail safety:
 * - if sharp says tail (p far from 0.5), increase sharp weight
 */
const TAIL_SHARP_W_MIN = Number(process.env.TAIL_SHARP_W_MIN ?? "0.80");
const TAIL_SHARP_W_MAX = Number(process.env.TAIL_SHARP_W_MAX ?? "0.95");

/**
 * Optional tail disagreement guardrail:
 * - If long odds and model >> sharp by too much, skip.
 */
const TAIL_GUARD_ENABLED = (process.env.TAIL_GUARD_ENABLED ?? "true").toLowerCase() === "true";
const TAIL_GUARD_LONG_ODDS = Number(process.env.TAIL_GUARD_LONG_ODDS ?? "350");
const TAIL_GUARD_MAX_GAP = Number(process.env.TAIL_GUARD_MAX_GAP ?? "0.06");

/**
 * Pace weights (auto-renormalized if a component is missing)
 */
const PACE_W_2025 = Number(process.env.PACE_W_2025 ?? "0.60");
const PACE_W_LAST3 = Number(process.env.PACE_W_LAST3 ?? "0.20");
const PACE_W_LAST1 = Number(process.env.PACE_W_LAST1 ?? "0.10");
const PACE_W_SPLIT = Number(process.env.PACE_W_SPLIT ?? "0.10");

/**
 * Totals component weights (auto-renormalized if a component is missing)
 * You asked for: PF/PA=0.1 and Off/Def+pace=0.4, leaving AvgTotal=0.5.
 */
const TOTAL_W_OFFDEF_PACE = Number(process.env.TOTAL_W_OFFDEF_PACE ?? "0.40");
const TOTAL_W_PFPA = Number(process.env.TOTAL_W_PFPA ?? "0.10");
const TOTAL_W_AVG_TOTAL = Number(process.env.TOTAL_W_AVG_TOTAL ?? "0.50");

/**
 * Off/Def totals blend weights (inside the Off/Def+pace component)
 */
const PTS_BLEND_WEIGHT_OFF = Number(process.env.PTS_BLEND_WEIGHT_OFF ?? "0.50"); // 0..1
const PTS_BLEND_WEIGHT_DEF = 1 - PTS_BLEND_WEIGHT_OFF;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

/* =========================================================
   MAIN
========================================================= */

async function main() {
  if (!SPORT_KEYS.length) throw new Error("[MC] SPORT_KEYS is empty.");

  const now = new Date();
  const graceMs = START_GRACE_MINUTES * 60 * 1000;
  const startCutoff = new Date(now.getTime() - graceMs);

  console.log(
    `[MC+EV] sports=${SPORT_KEYS.join(",")} season=${SEASON} possSeason=${POSS_SEASON} sims=${SIMS} startGraceMin=${START_GRACE_MINUTES}`
  );

  for (const sportKey of SPORT_KEYS) {
    await runForSport(sportKey, startCutoff);
  }

  console.log(`[MC+EV] Done. sports=${SPORT_KEYS.join(",")}`);
}

async function runForSport(sportKey: string, startCutoff: Date) {
  console.log(`\n[MC+EV] >>> SPORT=${sportKey}`);

  // 1) Future events for this sport
  const events = await fetchFutureEvents(startCutoff, sportKey);
  if (!events.length) {
    console.log(`[MC] (${sportKey}) No future events found. Done.`);
    return;
  }

  const eventIds = events.map((e) => e.event_id);

  // 2) Create run row (history)
  const runId = await createMonteCarloRun({
    sport_key: sportKey,
    config: buildRunConfig(sportKey),
  });

  // 3) Clear snapshot rows for this sport (hard reset of current slate)
  await clearMonteCarloResultsForSport(sportKey);

  // 4) Consensus lines from odds_snapshot
  const lineMap = await fetchConsensusLinesFromOddsSnapshot(eventIds);

  // 5) Build team universe
  const teamSet = new Set<string>();
  for (const e of events) {
    if (e.canon_home_team) teamSet.add(e.canon_home_team);
    if (e.canon_away_team) teamSet.add(e.canon_away_team);
  }
  const teams = [...teamSet];

  // 6) Fetch ratings + possessions
  const ratings = await fetchTeamRatingsForSport(sportKey, teams);
  const ratingMap = new Map<string, TeamRatingRow>();
  for (const r of ratings) ratingMap.set(r.canonical, r);

  const possRows = await fetchTeamPossessionsForSportSeason(sportKey, POSS_SEASON, teams);
  const possMap = new Map<string, PossRow>();
  for (const p of possRows) possMap.set(p.canonical, p);

  // 7) Simulate games -> build snapshot rows
  const results: MonteCarloResultUpsert[] = [];
  const skipped: { event_id: string; reason: string }[] = [];

  for (const e of events) {
    const home = e.canon_home_team;
    const away = e.canon_away_team;

    if (!home || !away) {
      skipped.push({ event_id: e.event_id, reason: "missing canon_home_team or canon_away_team" });
      continue;
    }

    const homeR = ratingMap.get(home);
    const awayR = ratingMap.get(away);

    if (!homeR || !awayR) {
      skipped.push({
        event_id: e.event_id,
        reason: `missing team_ratings(${sportKey}) for ${!homeR ? home : ""}${!homeR && !awayR ? " & " : ""}${
          !awayR ? away : ""
        }`,
      });
      continue;
    }

    const homeP = possMap.get(home) ?? null;
    const awayP = possMap.get(away) ?? null;

    // Pace composite (possessions per game)
    const paceHome = computeTeamPace(sportKey, homeP, "home");
    const paceAway = computeTeamPace(sportKey, awayP, "away");
    const paceGame = averageNonNull([paceHome, paceAway]) ?? defaultPaceForSport(sportKey);

    const spreadLineHome = lineMap.get(`${e.event_id}|spreads|home`) ?? null;
    const totalLine = lineMap.get(`${e.event_id}|totals|over`) ?? null;

    const input = buildInputsPaceAware(sportKey, homeR, awayR, paceGame);

    const sim = simulateGameWithProbs(SIMS, input, {
      spreadLineHome,
      totalLine,
      eps: EPS,
      marginHomeWinNegativeStore: MARGIN_HOME_WIN_NEGATIVE,
    });

    // Convert (margin,total) to points
    const homePts = sim.projectedTotal / 2 + sim.projectedMarginHome_model / 2;
    const awayPts = sim.projectedTotal - homePts;

    const trace = WRITE_TRACE
      ? {
          sport_key: sportKey,
          season: SEASON,
          poss_season: POSS_SEASON,
          home,
          away,

          pace_home_poss_per_game: paceHome,
          pace_away_poss_per_game: paceAway,
          pace_game_poss_per_game: paceGame,

          // ratings used for totals component #1
          home_engine_adj_off_100: num(homeR.engine_adj_off, 0),
          home_engine_adj_def_100: num(homeR.engine_adj_def, 0),
          away_engine_adj_off_100: num(awayR.engine_adj_off, 0),
          away_engine_adj_def_100: num(awayR.engine_adj_def, 0),

          // ✅ rating used for margin
          home_engine_power_game: num(homeR.engine_power, 0),
          away_engine_power_game: num(awayR.engine_power, 0),
          home_true_hca_pts: num(homeR.true_hca, 0),

          // totals components #2/#3 inputs
          home_pf_points: toNullNum(homeR.pf_points),
          home_pa_points: toNullNum(homeR.pa_points),
          home_avg_total_points: toNullNum(homeR.avg_total_points),
          away_pf_points: toNullNum(awayR.pf_points),
          away_pa_points: toNullNum(awayR.pa_points),
          away_avg_total_points: toNullNum(awayR.avg_total_points),

          model: {
            margin_mean_source: "engine_power (per-game) + HCA",
            totals_source: "3-way blend: off/def+pace + pf/pa + avg_total_points",
            totals_weights: {
              w_offdef_pace: TOTAL_W_OFFDEF_PACE,
              w_pfpa: TOTAL_W_PFPA,
              w_avg_total: TOTAL_W_AVG_TOTAL,
            },
            offdef_blend: {
              pts_blend_weight_off: PTS_BLEND_WEIGHT_OFF,
              pts_blend_weight_def: PTS_BLEND_WEIGHT_DEF,
            },
          },

          totals_components: input.totalsComponents,

          margin_mean_pts: input.marginMean,
          total_mean_pts: input.totalMean,
          sigma_margin_game_pts: input.sigmaMarginGame,
          sigma_total_game_pts: input.sigmaTotalGame,

          spread_line_home_consensus: spreadLineHome,
          total_line_consensus: totalLine,

          sims: SIMS,
          stored_margin_convention: MARGIN_HOME_WIN_NEGATIVE ? "negative_means_home_better" : "positive_means_home_better",
        }
      : null;

    results.push({
      sport_key: sportKey,
      event_id: e.event_id,
      run_id: runId,

      commence_time: e.commence_time ?? null,
      matchup: e.matchup ?? null,
      home_team: home,
      away_team: away,

      projected_margin_home: sim.projectedMarginHome_stored,
      sigma_margin_game: input.sigmaMarginGame,

      projected_total: sim.projectedTotal,
      sigma_total_game: input.sigmaTotalGame,

      projected_home_points: round2(homePts),
      projected_away_points: round2(awayPts),

      home_win_prob: sim.homeWinProb,
      away_win_prob: sim.awayWinProb,

      spread_line_home: spreadLineHome,
      home_cover_prob: sim.homeCoverProb,
      cover_push_prob: sim.coverPushProb,
      away_cover_prob: sim.awayCoverProb,

      total_line: totalLine,
      over_prob: sim.overProb,
      total_push_prob: sim.totalPushProb,
      under_prob: sim.underProb,

      trace,
    });
  }

  if (skipped.length) {
    console.log(`[MC] (${sportKey}) Skipped ${skipped.length} events (showing up to 25):`);
    for (const s of skipped.slice(0, 25)) console.log(`  - ${s.event_id}: ${s.reason}`);
    if (skipped.length > 25) console.log(`  ...and ${skipped.length - 25} more`);
  }

  if (!results.length) {
    console.log(`[MC] (${sportKey}) No results to upsert. Done.`);
    await clearEvPlaysForSport(sportKey);
    return;
  }

  // 8) Upsert snapshot rows
  await upsertMonteCarloResultsSnapshot(results);
  console.log(`[MC] (${sportKey}) Snapshot upserted ${results.length} rows (run_id=${runId}).`);

  // 9) Rebuild EV per sport
  await rebuildEvPlaysForSport(sportKey, runId, results, eventIds);
}

/* =========================================================
   RUN CONFIG
========================================================= */

function buildRunConfig(sportKey: string) {
  return {
    sport_key: sportKey,
    season: SEASON,
    poss_season: POSS_SEASON,

    sims: SIMS,
    sigma_margin_floor_game: SIGMA_MARGIN_FLOOR_GAME,
    sigma_total_floor_game: SIGMA_TOTAL_FLOOR_GAME,

    pace_weights: {
      w_2025: PACE_W_2025,
      w_last3: PACE_W_LAST3,
      w_last1: PACE_W_LAST1,
      w_split: PACE_W_SPLIT,
    },

    pace_clamp: paceClampForSport(sportKey),

    rating_model: {
      margin_mean: "engine_power (per-game) + HCA",
      total_mean: "3-way blend: (off/def+pace) + (pf/pa matchup) + (avg_total_points)",
      totals_weights: {
        w_offdef_pace: TOTAL_W_OFFDEF_PACE,
        w_pfpa: TOTAL_W_PFPA,
        w_avg_total: TOTAL_W_AVG_TOTAL,
      },
      offdef_component_blend: {
        pts_blend_weight_off: PTS_BLEND_WEIGHT_OFF,
        pts_blend_weight_def: PTS_BLEND_WEIGHT_DEF,
      },
    },

    margin_home_win_negative: MARGIN_HOME_WIN_NEGATIVE,
    push_eps: EPS,
    start_grace_minutes: START_GRACE_MINUTES,

    line_source: "consensus(avg latest-per-book from odds_snapshot)",
    generated_at: new Date().toISOString(),

    ev_soft_books: SOFT_BOOKS,
    ev_sharp_books: SHARP_BOOKS,

    devig_switch: {
      diff_switch: DEVIG_DIFF_SWITCH,
      near_50_method: "equal_margin_normalize",
      lopsided_method: "mpto_power",
    },

    tail: {
      sharp_w_min: TAIL_SHARP_W_MIN,
      sharp_w_max: TAIL_SHARP_W_MAX,
      guard_enabled: TAIL_GUARD_ENABLED,
      guard_long_odds: TAIL_GUARD_LONG_ODDS,
      guard_max_gap: TAIL_GUARD_MAX_GAP,
    },

    min_ev_pct: MIN_EV_PCT,
    line_tol: LINE_TOL,
    write_trace: WRITE_TRACE,
  };
}

/* =========================================================
   POSSESSIONS (possessions per game)
========================================================= */

function paceClampForSport(sportKey: string): { lo: number; hi: number } {
  if (sportKey === "basketball_nba") return { lo: 85, hi: 110 };
  return { lo: 60, hi: 80 };
}

function computeTeamPace(sportKey: string, p: PossRow | null, homeAway: "home" | "away"): number | null {
  if (!p) return null;

  const v2025 = toNullNum((p as any)["2025"]);
  const last3 = toNullNum((p as any)["Last 3"]);
  const last1 = toNullNum((p as any)["Last 1"]);
  const split = toNullNum((p as any)[homeAway === "home" ? "Home" : "Away"]);

  const parts: Array<{ v: number | null; w: number }> = [
    { v: v2025, w: PACE_W_2025 },
    { v: last3, w: PACE_W_LAST3 },
    { v: last1, w: PACE_W_LAST1 },
    { v: split, w: PACE_W_SPLIT },
  ];

  const avail = parts.filter((x) => x.v != null && Number.isFinite(x.v!));
  if (!avail.length) return null;

  const wSum = avail.reduce((s, x) => s + x.w, 0);
  if (wSum <= 0) return avail[0].v!;

  let pace = 0;
  for (const x of avail) pace += (x.w / wSum) * (x.v as number);

  const { lo, hi } = paceClampForSport(sportKey);
  return clamp(pace, lo, hi);
}

function defaultPaceForSport(sportKey: string) {
  if (sportKey === "basketball_nba") return 99;
  return 70;
}

function averageNonNull(arr: Array<number | null | undefined>): number | null {
  const xs = arr.filter((x): x is number => x != null && Number.isFinite(x));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/* =========================================================
   MODEL
   - marginMean uses engine_power (per-game) + HCA
   - totalMean uses 3-way blend:
       (1) off/def + pace (per-100 -> per-game)
       (2) pf/pa matchup
       (3) avg_total_points
========================================================= */

function buildInputsPaceAware(sportKey: string, home: TeamRatingRow, away: TeamRatingRow, paceGame: number) {
  const paceFactor = paceGame / 100;

  // ---------- Totals component #1: Off/Def (per-100) -> per-game via pace ----------
  const homeOff100 = num(home.engine_adj_off, 0);
  const homeDef100 = num(home.engine_adj_def, 0);
  const awayOff100 = num(away.engine_adj_off, 0);
  const awayDef100 = num(away.engine_adj_def, 0);

  const defFallback = sportKey === "basketball_nba" ? 112 : 100;
  const offFallback = sportKey === "basketball_nba" ? 112 : 100;

  const homeOff = homeOff100 > 0 ? homeOff100 : offFallback;
  const awayOff = awayOff100 > 0 ? awayOff100 : offFallback;
  const homeDef = homeDef100 > 0 ? homeDef100 : defFallback;
  const awayDef = awayDef100 > 0 ? awayDef100 : defFallback;

  const wOff = clamp01(PTS_BLEND_WEIGHT_OFF);
  const wDef = 1 - wOff;

  const homePts100 = wOff * homeOff + wDef * awayDef;
  const awayPts100 = wOff * awayOff + wDef * homeDef;

  const homePts_offdef = homePts100 * paceFactor;
  const awayPts_offdef = awayPts100 * paceFactor;
  const total_offdef_pace = Math.max(0, homePts_offdef + awayPts_offdef);

  // ---------- Totals component #2: PF/PA matchup (per-game) ----------
  // home expected points ≈ avg(home PF, away PA)
  // away expected points ≈ avg(away PF, home PA)
  const homePF = toNullNum(home.pf_points);
  const homePA = toNullNum(home.pa_points);
  const awayPF = toNullNum(away.pf_points);
  const awayPA = toNullNum(away.pa_points);

  const homePts_pfpa = avgNullable(homePF, awayPA);
  const awayPts_pfpa = avgNullable(awayPF, homePA);
  const total_pfpa = homePts_pfpa != null && awayPts_pfpa != null ? Math.max(0, homePts_pfpa + awayPts_pfpa) : null;

  // ---------- Totals component #3: Avg total points (per-game) ----------
  const homeAvgTot = toNullNum(home.avg_total_points);
  const awayAvgTot = toNullNum(away.avg_total_points);
  const total_avg_total = avgNullable(homeAvgTot, awayAvgTot);

  // ---------- Blend totals components with auto-renorm ----------
  const totalMean = blendTotals({
    offdef_pace: total_offdef_pace,
    pfpa: total_pfpa,
    avg_total: total_avg_total,
    w_offdef_pace: TOTAL_W_OFFDEF_PACE,
    w_pfpa: TOTAL_W_PFPA,
    w_avg_total: TOTAL_W_AVG_TOTAL,
  });

  // ---------- Margin mean (engine_power + HCA) ----------
  const homePow = num(home.engine_power, 0);
  const awayPow = num(away.engine_power, 0);
  const hcaPts = num(home.true_hca, 0);
  const marginMean = (homePow - awayPow) + hcaPts;

  // ---------- Sigmas (still per-100 scaled by paceFactor; floors applied) ----------
  const sigmaMargin100 = avg(num(home.sigma_margin_100, 8), num(away.sigma_margin_100, 8));
  const sigmaTotal100 = avg(num(home.sigma_total_100, 13.5), num(away.sigma_total_100, 13.5));

  const sigmaMarginGame = Math.max(SIGMA_MARGIN_FLOOR_GAME, sigmaMargin100 * paceFactor);
  const sigmaTotalGame = Math.max(SIGMA_TOTAL_FLOOR_GAME, sigmaTotal100 * paceFactor);

  return {
    marginMean,
    totalMean,
    sigmaMarginGame,
    sigmaTotalGame,
    totalsComponents: {
      total_offdef_pace,
      total_pfpa,
      total_avg_total,
      weights: {
        w_offdef_pace: TOTAL_W_OFFDEF_PACE,
        w_pfpa: TOTAL_W_PFPA,
        w_avg_total: TOTAL_W_AVG_TOTAL,
      },
    },
  };
}

function blendTotals(args: {
  offdef_pace: number; // always available (we have fallbacks)
  pfpa: number | null;
  avg_total: number | null;
  w_offdef_pace: number;
  w_pfpa: number;
  w_avg_total: number;
}) {
  const parts: Array<{ v: number | null; w: number }> = [
    { v: Number.isFinite(args.offdef_pace) ? args.offdef_pace : null, w: args.w_offdef_pace },
    { v: args.pfpa, w: args.w_pfpa },
    { v: args.avg_total, w: args.w_avg_total },
  ];

  const avail = parts.filter((p) => p.v != null && Number.isFinite(p.v!) && p.w > 0);
  if (!avail.length) return Math.max(0, args.offdef_pace || 0);

  const wSum = avail.reduce((s, p) => s + p.w, 0);
  if (wSum <= 0) return avail[0].v!;

  let total = 0;
  for (const p of avail) total += (p.w / wSum) * (p.v as number);
  return Math.max(0, total);
}

function avgNullable(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return (a + b) / 2;
}

/* =========================================================
   SIMULATION
========================================================= */

function simulateGameWithProbs(
  sims: number,
  input: ReturnType<typeof buildInputsPaceAware>,
  opts: {
    spreadLineHome: number | null;
    totalLine: number | null;
    eps: number;
    marginHomeWinNegativeStore: boolean;
  }
) {
  let sumM = 0;
  let sumT = 0;

  let homeWins = 0;
  let awayWins = 0;

  let homeCovers = 0;
  let coverPushes = 0;

  let overs = 0;
  let totalPushes = 0;

  const { spreadLineHome, totalLine, eps } = opts;

  for (let i = 0; i < sims; i++) {
    const m = input.marginMean + randn() * input.sigmaMarginGame;
    const t = Math.max(0, input.totalMean + randn() * input.sigmaTotalGame);

    sumM += m;
    sumT += t;

    if (m > 0) homeWins++;
    else if (m < 0) awayWins++;

    if (spreadLineHome != null) {
      const v = m + spreadLineHome;
      if (v > eps) homeCovers++;
      else if (Math.abs(v) <= eps) coverPushes++;
    }

    if (totalLine != null) {
      const dv = t - totalLine;
      if (dv > eps) overs++;
      else if (Math.abs(dv) <= eps) totalPushes++;
    }
  }

  const projectedMarginHome_model = sumM / sims;
  const projectedTotal = sumT / sims;

  const projectedMarginHome_stored = opts.marginHomeWinNegativeStore
    ? -projectedMarginHome_model
    : projectedMarginHome_model;

  const homeWinProb = homeWins / sims;
  const awayWinProb = awayWins / sims;

  const homeCoverProb = spreadLineHome == null ? null : homeCovers / sims;
  const coverPushProb = spreadLineHome == null ? null : coverPushes / sims;
  const awayCoverProb = spreadLineHome == null ? null : 1 - (homeCoverProb ?? 0) - (coverPushProb ?? 0);

  const overProb = totalLine == null ? null : overs / sims;
  const totalPushProb = totalLine == null ? null : totalPushes / sims;
  const underProb = totalLine == null ? null : 1 - (overProb ?? 0) - (totalPushProb ?? 0);

  return {
    projectedMarginHome_model: round2(projectedMarginHome_model),
    projectedMarginHome_stored: round2(projectedMarginHome_stored),
    projectedTotal: round2(projectedTotal),

    homeWinProb,
    awayWinProb,

    homeCoverProb,
    coverPushProb,
    awayCoverProb,

    overProb,
    totalPushProb,
    underProb,
  };
}

/* =========================================================
   EV PIPELINE (PER SPORT)
========================================================= */

async function rebuildEvPlaysForSport(
  sportKey: string,
  runId: string,
  mcRows: MonteCarloResultUpsert[],
  eventIds: string[]
) {
  console.log(`[EV] (${sportKey}) Rebuilding ev_plays (run_id=${runId})...`);

  await clearEvPlaysForSport(sportKey);

  const oddsRows = await fetchOddsSnapshotForEvents(eventIds);
  const latest = indexLatestOddsPerBook(oddsRows);

  const inserts: EvPlayInsert[] = [];

  for (const mc of mcRows) {
    const eid = mc.event_id;

    const homeTeam = mc.home_team ?? null;
    const awayTeam = mc.away_team ?? null;

    const markets: MarketKey[] = ["h2h", "spreads", "totals"];

    for (const market of markets) {
      const sides: SideKey[] =
        market === "h2h" ? ["home", "away"] : market === "spreads" ? ["home", "away"] : ["over", "under"];

      const refLine = market === "spreads" ? mc.spread_line_home : market === "totals" ? mc.total_line : null;

      for (const side of sides) {
        const mcProb = getMcProbForMarket(mc, market, side);
        if (mcProb == null) continue;

        const sharp = getSharpNoVigProb(latest, eid, market, side, refLine);
        if (!sharp) continue;

        // Tail-safe blending: use sharp more in tails, and shrink MC toward sharp in tails
        const tail = tailness(sharp.prob);
        const wSharp = clamp(
          TAIL_SHARP_W_MIN + (TAIL_SHARP_W_MAX - TAIL_SHARP_W_MIN) * tail,
          TAIL_SHARP_W_MIN,
          TAIL_SHARP_W_MAX
        );
        const wMc = 1 - wSharp;

        const shrink = clamp(0.10 + 0.50 * tail, 0.10, 0.60);
        const mcAdj = clamp01(mcProb * (1 - shrink) + sharp.prob * shrink);

        const quantumProb = clamp01(wSharp * sharp.prob + wMc * mcAdj);
        const quantumOdds = probToAmericanOdds(quantumProb);

        for (const book of SOFT_BOOKS) {
          const offer = getOffer(latest, eid, market, side, book);
          if (!offer) continue;

          const bookOdds = toNullNum(offer.odds);
          if (bookOdds == null) continue;

          // line matching for spreads/totals
          if (market === "spreads" || market === "totals") {
            if (refLine == null) continue;

            const offerLine = toNullNum(offer.line);
            if (offerLine == null) continue;

            const expected = market === "spreads" ? (side === "home" ? refLine : -refLine) : refLine;
            if (!nearlyEqual(offerLine, expected, LINE_TOL)) continue;
          }

          // Tail guardrail: if long odds + model way above sharp, skip
          if (TAIL_GUARD_ENABLED) {
            const isLong = bookOdds >= TAIL_GUARD_LONG_ODDS || bookOdds <= -TAIL_GUARD_LONG_ODDS;
            const gap = Math.abs(mcProb - sharp.prob);
            if (isLong && mcProb > sharp.prob && gap > TAIL_GUARD_MAX_GAP) {
              continue;
            }
          }

          const ev = evPct(quantumProb, bookOdds);
          if (!(ev > MIN_EV_PCT)) continue;

          const rawKelly = kellyFraction(quantumProb, bookOdds);
          const betFraction = rawKelly * KELLY_MULTIPLIER;

          const confidenceScore = computeConfidenceScore(ev, quantumProb, sharp.prob, mcProb);
          const tier = confidenceTier(confidenceScore);

          const team =
            market === "totals"
              ? homeTeam && awayTeam
                ? `${awayTeam} vs ${homeTeam}`
                : mc.matchup ?? null
              : side === "home"
              ? homeTeam
              : awayTeam;

          inserts.push({
            sport_key: sportKey,

            run_id: runId,
            event_id: eid,
            commence_time: mc.commence_time,
            matchup: mc.matchup,

            team,

            market,
            side,
            line: market === "h2h" ? null : toNullNum(offer.line),

            bookmaker: book,
            book_odds: bookOdds,

            quantum_prob: quantumProb,
            quantum_odds: quantumOdds,
            ev_pct: ev,

            confidence_score: Math.round(confidenceScore),
            confidence_tier: tier,

            kelly_fraction: rawKelly,
            bet_fraction: betFraction,
          });
        }
      }
    }
  }

  if (!inserts.length) {
    console.log(`[EV] (${sportKey}) No +EV plays found.`);
    return;
  }

  const chunkSize = 1000;
  for (let i = 0; i < inserts.length; i += chunkSize) {
    const batch = inserts.slice(i, i + chunkSize);
    const { error } = await supabase.from("ev_plays").insert(batch);
    if (error) throw new Error(`[EV] (${sportKey}) Failed to insert ev_plays: ${error.message}`);
  }

  console.log(`[EV] (${sportKey}) Inserted ${inserts.length} plays into ev_plays.`);
}

/* =========================================================
   DATA FETCH
========================================================= */

async function fetchFutureEvents(startCutoff: Date, sportKey: string): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from("events")
    .select("event_id,sport_key,commence_time,api_home_team,api_away_team,canon_home_team,canon_away_team,matchup")
    .eq("sport_key", sportKey)
    .gte("commence_time", startCutoff.toISOString())
    .order("commence_time", { ascending: true });

  if (error) throw new Error(`[MC] Failed to fetch events (${sportKey}): ${error.message}`);

  const seen = new Set<string>();
  const out: EventRow[] = [];

  for (const row of data ?? []) {
    const eid = String((row as any).event_id || "");
    if (!eid) continue;
    if (seen.has(eid)) continue;
    seen.add(eid);
    out.push(row as EventRow);
  }

  return out;
}

async function fetchTeamRatingsForSport(sportKey: string, canonicals: string[]): Promise<TeamRatingRow[]> {
  if (!canonicals.length) return [];

  const chunkSize = 400;
  const out: TeamRatingRow[] = [];

  for (let i = 0; i < canonicals.length; i += chunkSize) {
    const c = canonicals.slice(i, i + chunkSize);

    const { data, error } = await supabase
      .from("team_ratings")
      .select(
        "canonical,engine_adj_off,engine_adj_def,engine_power,pf_points,pa_points,avg_total_points,true_hca,sigma_margin_100,sigma_total_100"
      )
      .eq("sport_key", sportKey)
      .in("canonical", c);

    if (error) throw new Error(`[MC] Failed to fetch team_ratings (${sportKey}): ${error.message}`);
    out.push(...((data ?? []) as TeamRatingRow[]));
  }

  return out;
}

async function fetchTeamPossessionsForSportSeason(
  sportKey: string,
  season: string,
  canonicals: string[]
): Promise<PossRow[]> {
  if (!canonicals.length) return [];

  const chunkSize = 400;
  const out: PossRow[] = [];

  for (let i = 0; i < canonicals.length; i += chunkSize) {
    const c = canonicals.slice(i, i + chunkSize);

    const { data, error } = await supabase
      .from("team_possessions")
      .select('sport_key,season,canonical,"2025","Last 3","Last 1","Home","Away","2024"')
      .eq("sport_key", sportKey)
      .eq("season", season)
      .in("canonical", c);

    if (error) throw new Error(`[MC] Failed to fetch team_possessions (${sportKey}): ${error.message}`);
    out.push(...((data ?? []) as PossRow[]));
  }

  return out;
}

async function fetchOddsSnapshotForEvents(eventIds: string[]): Promise<OddsSnapshotRow[]> {
  if (!eventIds.length) return [];

  const { data, error } = await supabase
    .from("odds_snapshot")
    .select("event_id,bookmaker,market,side,line,odds,ts")
    .in("event_id", eventIds)
    .in("market", ["h2h", "spreads", "totals"])
    .in("side", ["home", "away", "over", "under"])
    .order("ts", { ascending: false });

  if (error) throw new Error(`[EV] Failed to fetch odds_snapshot: ${error.message}`);
  return (data ?? []) as OddsSnapshotRow[];
}

function indexLatestOddsPerBook(rows: OddsSnapshotRow[]): Map<string, OddsSnapshotRow> {
  const m = new Map<string, OddsSnapshotRow>();
  for (const r of rows) {
    const k = `${r.event_id}|${r.market}|${r.side}|${String(r.bookmaker || "").toLowerCase()}`;
    if (m.has(k)) continue; // rows already ordered desc by ts
    m.set(k, r);
  }
  return m;
}

async function fetchConsensusLinesFromOddsSnapshot(eventIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!eventIds.length) return out;

  const { data, error } = await supabase
    .from("odds_snapshot")
    .select("event_id,bookmaker,market,side,line,ts")
    .in("event_id", eventIds)
    .in("market", ["spreads", "totals"])
    .in("side", ["home", "away", "over", "under"])
    .order("ts", { ascending: false });

  if (error) {
    console.warn(`[MC] Could not fetch odds_snapshot lines (${error.message}).`);
    return out;
  }

  const latestPerBook = new Map<string, number>();

  for (const r of (data ?? []) as any[]) {
    const eid = String(r.event_id || "");
    const market = String(r.market || "").toLowerCase();
    const side = String(r.side || "").toLowerCase();
    const book = String(r.bookmaker || "").toLowerCase();

    const lineNum = Number(r.line);
    if (!eid || !market || !side || !book) continue;
    if (!Number.isFinite(lineNum)) continue;

    const k = `${eid}|${market}|${side}|${book}`;
    if (latestPerBook.has(k)) continue;
    latestPerBook.set(k, lineNum);
  }

  const buckets = new Map<string, number[]>();
  for (const [k, line] of latestPerBook.entries()) {
    const [eid, market, side] = k.split("|");
    const k2 = `${eid}|${market}|${side}`;
    const arr = buckets.get(k2) ?? [];
    arr.push(line);
    buckets.set(k2, arr);
  }

  for (const [k2, arr] of buckets.entries()) out.set(k2, mean(arr));

  // Fill missing symmetric sides if possible
  for (const id of eventIds) {
    const homeKey = `${id}|spreads|home`;
    const awayKey = `${id}|spreads|away`;
    const overKey = `${id}|totals|over`;
    const underKey = `${id}|totals|under`;

    if (!out.has(homeKey) && out.has(awayKey)) out.set(homeKey, -Number(out.get(awayKey)));
    if (!out.has(overKey) && out.has(underKey)) out.set(overKey, Number(out.get(underKey)));
  }

  return out;
}

/* =========================================================
   RUN + UPSERT
========================================================= */

async function createMonteCarloRun(payload: MonteCarloRunInsert): Promise<string> {
  const { data, error } = await supabase.from("monte_carlo_runs").insert(payload).select("id").single();
  if (error) throw new Error(`[MC] Failed to insert monte_carlo_runs: ${error.message}`);
  if (!data?.id) throw new Error("[MC] Failed to create monte_carlo_runs row (no id).");
  return data.id as string;
}

async function clearMonteCarloResultsForSport(sportKey: string) {
  const { error } = await supabase.from("monte_carlo_results").delete().eq("sport_key", sportKey);
  if (error) throw new Error(`[MC] Failed to clear monte_carlo_results for sport (${sportKey}): ${error.message}`);
}

async function upsertMonteCarloResultsSnapshot(rows: MonteCarloResultUpsert[]) {
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const batch = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from("monte_carlo_results").upsert(batch, { onConflict: "sport_key,event_id" });
    if (error) throw new Error(`[MC] Failed to upsert monte_carlo_results snapshot: ${error.message}`);
  }
}

async function clearEvPlaysForSport(sportKey: string) {
  const { error: rpcErr } = await supabase.rpc("clear_ev_plays_for_sport", { p_sport_key: sportKey });
  if (!rpcErr) return;

  const code = (rpcErr as any).code;
  const msg = (rpcErr as any).message || "";
  if (code === "PGRST202" || /schema cache/i.test(msg) || /Could not find the function/i.test(msg)) {
    const { error } = await supabase.from("ev_plays").delete().eq("sport_key", sportKey);
    if (error) throw new Error(`[EV] Failed to clear ev_plays fallback: ${error.message}`);
    return;
  }

  throw new Error(`[EV] Failed to clear ev_plays via RPC: ${msg}`);
}

/* =========================================================
   EV HELPERS
========================================================= */

function getMcProbForMarket(mc: MonteCarloResultUpsert, market: MarketKey, side: SideKey): number | null {
  if (market === "h2h") return side === "home" ? mc.home_win_prob ?? null : mc.away_win_prob ?? null;
  if (market === "spreads") return side === "home" ? mc.home_cover_prob ?? null : mc.away_cover_prob ?? null;
  if (market === "totals") return side === "over" ? mc.over_prob ?? null : mc.under_prob ?? null;
  return null;
}

function oppositeSide(market: MarketKey, side: SideKey): SideKey | null {
  if (market === "h2h" || market === "spreads") return side === "home" ? "away" : side === "away" ? "home" : null;
  if (market === "totals") return side === "over" ? "under" : side === "under" ? "over" : null;
  return null;
}

function getOffer(
  latest: Map<string, OddsSnapshotRow>,
  eventId: string,
  market: MarketKey,
  side: SideKey,
  bookmaker: string
): OddsSnapshotRow | null {
  const k = `${eventId}|${market}|${side}|${bookmaker.toLowerCase()}`;
  return latest.get(k) ?? null;
}

/**
 * SHARP no-vig probability builder with devig SWITCH:
 * - If close market => equal-margin normalize
 * - If lopsided => MPTO/Power devig
 */
function getSharpNoVigProb(
  latest: Map<string, OddsSnapshotRow>,
  eventId: string,
  market: MarketKey,
  side: SideKey,
  refLine: number | null
): { prob: number } | null {
  const opp = oppositeSide(market, side);
  if (!opp) return null;

  const probs: number[] = [];

  for (const book of SHARP_BOOKS) {
    const a = getOffer(latest, eventId, market, side, book);
    const b = getOffer(latest, eventId, market, opp, book);
    if (!a || !b) continue;

    const ao = toNullNum(a.odds);
    const bo = toNullNum(b.odds);
    if (ao == null || bo == null) continue;

    if (market === "spreads" || market === "totals") {
      if (refLine == null) continue;

      const aLine = toNullNum(a.line);
      const bLine = toNullNum(b.line);
      if (aLine == null || bLine == null) continue;

      if (market === "spreads") {
        const expA = side === "home" ? refLine : -refLine;
        const expB = opp === "home" ? refLine : -refLine;

        if (!nearlyEqual(aLine, expA, LINE_TOL)) continue;
        if (!nearlyEqual(bLine, expB, LINE_TOL)) continue;
        if (!nearlyEqual(aLine + bLine, 0, 1e-4)) continue;
      } else {
        if (!nearlyEqual(aLine, refLine, LINE_TOL)) continue;
        if (!nearlyEqual(bLine, refLine, LINE_TOL)) continue;
      }
    }

    const p1 = clamp01(americanOddsToProb(ao));
    const p2 = clamp01(americanOddsToProb(bo));

    const diff = Math.abs(p1 - p2);
    const [nv1] = diff <= DEVIG_DIFF_SWITCH ? noVigEqualMargin(p1, p2) : noVigMPTO(p1, p2);
    probs.push(nv1);
  }

  if (!probs.length) return null;
  return { prob: mean(probs) };
}

/* =========================================================
   DEVIG METHODS
========================================================= */

function noVigEqualMargin(p1: number, p2: number): [number, number] {
  const s = p1 + p2;
  if (s <= 0) return [p1, p2];
  return [p1 / s, p2 / s];
}

function noVigMPTO(p1: number, p2: number): [number, number] {
  const a = clamp(p1, 1e-12, 1 - 1e-12);
  const b = clamp(p2, 1e-12, 1 - 1e-12);

  const f = (k: number) => Math.pow(a, k) + Math.pow(b, k) - 1;

  let lo = 0.01;
  let hi = 10;

  const flo = f(lo);
  const fhi = f(hi);
  if (!(Number.isFinite(flo) && Number.isFinite(fhi)) || flo * fhi > 0) {
    return noVigEqualMargin(a, b);
  }

  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (fm === 0) {
      lo = hi = mid;
      break;
    }
    if (flo * fm > 0) lo = mid;
    else hi = mid;
  }

  const k = (lo + hi) / 2;
  const na = Math.pow(a, k);
  const nb = Math.pow(b, k);
  const s = na + nb;
  if (s <= 0) return noVigEqualMargin(a, b);
  return [na / s, nb / s];
}

/* =========================================================
   CONFIDENCE
========================================================= */

function tailness(p: number) {
  return clamp(Math.abs(p - 0.5) / 0.5, 0, 1);
}

function computeConfidenceScore(evPctVal: number, qProb: number, sharpProb: number, mcProb: number) {
  const evScore = clamp(evPctVal * 5, 0, 100);
  const probScore = clamp(Math.abs(qProb - 0.5) * 200, 0, 100);

  const t = tailness(sharpProb);
  const disagreement = Math.abs(sharpProb - mcProb);
  const agreementScore = 100 - clamp(disagreement * (300 + 200 * t), 0, 100);

  return 0.45 * evScore + 0.35 * probScore + 0.2 * agreementScore;
}

function confidenceTier(score: number): string {
  if (score >= 85) return "A+";
  if (score >= 75) return "A";
  if (score >= 65) return "B";
  if (score >= 55) return "C";
  return "D";
}

/* =========================================================
   ODDS + EV MATH
========================================================= */

function americanOddsToProb(odds: number): number {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function probToAmericanOdds(p: number): number {
  const pp = clamp01(p);
  if (pp <= 0 || pp >= 1) return 0;
  return pp >= 0.5 ? Math.round((-100 * pp) / (1 - pp)) : Math.round((100 * (1 - pp)) / pp);
}

function evPct(trueProb: number, bookOdds: number): number {
  const p = clamp01(trueProb);
  const b = bookOdds > 0 ? bookOdds / 100 : 100 / Math.abs(bookOdds);
  return (p * b - (1 - p)) * 100;
}

function kellyFraction(trueProb: number, bookOdds: number): number {
  const p = clamp01(trueProb);
  const b = bookOdds > 0 ? bookOdds / 100 : 100 / Math.abs(bookOdds);
  const k = (p * b - (1 - p)) / b;
  return Math.max(0, k);
}

/* =========================================================
   UTILS
========================================================= */

function num(v: any, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toNullNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avg(a: number, b: number) {
  return (a + b) / 2;
}

function mean(arr: number[]) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function round2(x: number) {
  return Math.round(x * 100) / 100;
}

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

function clamp01(x: number) {
  return clamp(x, 0, 1);
}

function nearlyEqual(a: number, b: number, tol: number) {
  return Math.abs(a - b) <= tol;
}

// Box–Muller
function randn() {
  let u = 0,
    v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/* =========================================================
   RUN
========================================================= */

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

