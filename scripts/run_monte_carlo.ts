// scripts/run_monte_carlo.ts
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

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
  engine_power: number | null;
  true_hca: number | null;

  pf_points: number | null;
  pa_points: number | null;
  avg_total_points: number | null;

  sigma_margin_100: number | null;
  sigma_total_100: number | null;
};

type OddsLatestRow = {
  event_id: string;
  bookmaker: string;
  market: string;
  side: string;
  line: number | null;
  ts: string;
};

type MonteCarloRunInsert = {
  sport_key: string;
  config: Record<string, any>;
};

type MonteCarloResultUpsert = {
  run_id: string;
  event_id: string;
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

  // probs
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

// -------------------- ENV / CONFIG --------------------
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("[MC] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (preferred).");
}

const SPORT_KEY = process.env.SPORT_KEY || "basketball_ncaab";
const SIMS = Number(process.env.MC_SIMS ?? "10000");

// grace window: treat games as "not started" if commence_time is within last X minutes
// helps avoid clock skew + edge cases
const START_GRACE_MINUTES = Number(process.env.MC_START_GRACE_MINUTES ?? "0");

const SIGMA_MARGIN_FLOOR = Number(process.env.SIGMA_MARGIN_FLOOR ?? "8");
const SIGMA_TOTAL_FLOOR = Number(process.env.SIGMA_TOTAL_FLOOR ?? "13.5");

const TOTAL_FALLBACK_MODE = (process.env.TOTAL_FALLBACK_MODE || "avg_total_points") as
  | "avg_total_points"
  | "pf_pa_blend";

const WRITE_TRACE = (process.env.MC_WRITE_TRACE ?? "true").toLowerCase() === "true";

// true = store projected_margin_home as negative when home is stronger/wins
const MARGIN_HOME_WIN_NEGATIVE =
  (process.env.MARGIN_HOME_WIN_NEGATIVE ?? "true").toLowerCase() === "true";

// which book to grade lines from (must match odds_snapshot_latest.bookmaker)
const LINE_BOOK = (process.env.LINE_BOOK ?? "draftkings").toLowerCase();

// float equality tolerance (for push detection)
const EPS = Number(process.env.MC_PUSH_EPS ?? "1e-9");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// -------------------- MAIN --------------------
async function main() {
  console.log(
    `[MC] SPORT_KEY=${SPORT_KEY} sims=${SIMS} marginHomeWinNegative=${MARGIN_HOME_WIN_NEGATIVE} ` +
      `lineBook=${LINE_BOOK} startGraceMin=${START_GRACE_MINUTES}`
  );

  const now = new Date();
  const graceMs = START_GRACE_MINUTES * 60 * 1000;
  const startCutoff = new Date(now.getTime() - graceMs);

  const events = await fetchFutureEvents(startCutoff);
  if (!events.length) {
    console.log("[MC] No future (not-started) events found. Done.");
    return;
  }

  const eventIds = events.map((e) => e.event_id);

  // Clear results for these event_ids so UI doesn't show multiple versions
  // (monte_carlo_results is treated as a "snapshot" table)
  await clearMonteCarloResultsForEvents(eventIds);

  // Pull latest spread/total lines for these events from chosen book
  const lineMap = await fetchLatestLines(eventIds, LINE_BOOK);

  // collect canon teams
  const teamSet = new Set<string>();
  for (const e of events) {
    if (e.canon_home_team) teamSet.add(e.canon_home_team);
    if (e.canon_away_team) teamSet.add(e.canon_away_team);
  }

  const ratings = await fetchTeamRatings([...teamSet]);
  const ratingMap = new Map<string, TeamRatingRow>();
  for (const r of ratings) ratingMap.set(r.canonical, r);

  const runId = await createMonteCarloRun({
    sport_key: SPORT_KEY,
    config: {
      sims: SIMS,
      sigma_margin_floor: SIGMA_MARGIN_FLOOR,
      sigma_total_floor: SIGMA_TOTAL_FLOOR,
      total_fallback_mode: TOTAL_FALLBACK_MODE,
      margin_home_win_negative: MARGIN_HOME_WIN_NEGATIVE,
      line_book: LINE_BOOK,
      push_eps: EPS,
      start_grace_minutes: START_GRACE_MINUTES,
      generated_at: new Date().toISOString(),
    },
  });

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
        reason: `missing team_ratings for ${!homeR ? home : ""}${!homeR && !awayR ? " & " : ""}${!awayR ? away : ""}`,
      });
      continue;
    }

    const input = buildInputs(homeR, awayR);

    // lines (nullable)
    const spreadLineHome = lineMap.get(`${e.event_id}|spreads|home`) ?? null;
    const totalLine = lineMap.get(`${e.event_id}|totals|over`) ?? null;

    const sim = simulateGameWithProbs(SIMS, input, {
      marginHomeWinNegativeStore: MARGIN_HOME_WIN_NEGATIVE,
      spreadLineHome,
      totalLine,
      eps: EPS,
    });

    // Convert mean margin/total into points using the MODEL-NATIVE margin (home-away).
    // We use sim.projectedMarginHome_model for points, then store margin with desired sign convention.
    const homePts = (sim.projectedTotal / 2) + (sim.projectedMarginHome_model / 2);
    const awayPts = sim.projectedTotal - homePts;

    const trace = WRITE_TRACE
      ? {
          home,
          away,
          home_engine_power: input.homePower,
          away_engine_power: input.awayPower,
          home_true_hca: input.homeHca,

          home_pf_points: input.homePf,
          home_pa_points: input.homePa,
          home_avg_total_points: input.homeAvgTotal,

          away_pf_points: input.awayPf,
          away_pa_points: input.awayPa,
          away_avg_total_points: input.awayAvgTotal,

          margin_mean_model_home_minus_away: input.marginMean,
          total_mean: input.totalMean,
          sigma_margin_game: input.sigmaMarginGame,
          sigma_total_game: input.sigmaTotalGame,

          stored_margin_convention: MARGIN_HOME_WIN_NEGATIVE ? "negative_means_home_better" : "positive_means_home_better",

          spread_line_home: spreadLineHome,
          total_line: totalLine,

          p_home_win: sim.homeWinProb,
          p_home_cover: sim.homeCoverProb,
          p_cover_push: sim.coverPushProb,
          p_over: sim.overProb,
          p_total_push: sim.totalPushProb,

          sims: SIMS,
        }
      : null;

    results.push({
      run_id: runId,
      event_id: e.event_id,
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
    console.log(`[MC] Skipped ${skipped.length} events:`);
    for (const s of skipped.slice(0, 25)) console.log(`  - ${s.event_id}: ${s.reason}`);
    if (skipped.length > 25) console.log(`  ...and ${skipped.length - 25} more`);
  }

  if (!results.length) {
    console.log("[MC] No results to upsert. Done.");
    return;
  }

  await upsertMonteCarloResults(results);
  console.log(`[MC] Upserted ${results.length} rows into monte_carlo_results (run_id=${runId}).`);
}

// -------------------- DATA FETCH --------------------
async function fetchFutureEvents(startCutoff: Date): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from("events")
    .select(
      "event_id,sport_key,commence_time,api_home_team,api_away_team,canon_home_team,canon_away_team,matchup"
    )
    .eq("sport_key", SPORT_KEY)
    .gte("commence_time", startCutoff.toISOString())
    .order("commence_time", { ascending: true });

  if (error) throw new Error(`[MC] Failed to fetch events: ${error.message}`);

  const seen = new Set<string>();
  const out: EventRow[] = [];
  for (const row of data ?? []) {
    if (!row.event_id) continue;
    if (seen.has(row.event_id)) continue;
    seen.add(row.event_id);
    out.push(row as EventRow);
  }
  return out;
}

async function fetchTeamRatings(canonicals: string[]): Promise<TeamRatingRow[]> {
  if (!canonicals.length) return [];

  const chunkSize = 400;
  const out: TeamRatingRow[] = [];

  for (let i = 0; i < canonicals.length; i += chunkSize) {
    const chunk = canonicals.slice(i, i + chunkSize);

    const { data, error } = await supabase
      .from("team_ratings")
      .select(
        "canonical,engine_power,true_hca,pf_points,pa_points,avg_total_points,sigma_margin_100,sigma_total_100"
      )
      .in("canonical", chunk);

    if (error) throw new Error(`[MC] Failed to fetch team_ratings: ${error.message}`);
    out.push(...((data ?? []) as TeamRatingRow[]));
  }

  return out;
}

async function clearMonteCarloResultsForEvents(eventIds: string[]) {
  if (!eventIds.length) return;

  const chunkSize = 500;
  for (let i = 0; i < eventIds.length; i += chunkSize) {
    const chunk = eventIds.slice(i, i + chunkSize);

    const { error } = await supabase.from("monte_carlo_results").delete().in("event_id", chunk);
    if (error) throw new Error(`[MC] Failed to clear monte_carlo_results rows: ${error.message}`);
  }
}

// Pull latest spread/total lines from odds_snapshot_latest (view)
async function fetchLatestLines(eventIds: string[], book: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!eventIds.length) return out;

  const { data, error } = await supabase
    .from("odds_snapshot_latest")
    .select("event_id,bookmaker,market,side,line,ts")
    .in("event_id", eventIds)
    .eq("bookmaker", book)
    .in("market", ["spreads", "totals"])
    .in("side", ["home", "over"]);

  if (error) {
    console.warn(`[MC] Could not fetch odds_snapshot_latest lines (${error.message}). Line-based probs will be null.`);
    return out;
  }

  for (const r of (data ?? []) as OddsLatestRow[]) {
    const line = Number(r.line);
    if (!Number.isFinite(line)) continue;
    out.set(`${r.event_id}|${r.market}|${r.side}`, line);
  }

  return out;
}

// -------------------- RUN + UPSERT --------------------
async function createMonteCarloRun(payload: MonteCarloRunInsert): Promise<string> {
  const { data, error } = await supabase
    .from("monte_carlo_runs")
    .insert(payload)
    .select("id")
    .single();

  if (error) throw new Error(`[MC] Failed to insert monte_carlo_runs: ${error.message}`);
  if (!data?.id) throw new Error("[MC] Failed to create monte_carlo_runs row (no id returned).");

  return data.id as string;
}

async function upsertMonteCarloResults(rows: MonteCarloResultUpsert[]) {
  const { error } = await supabase
    .from("monte_carlo_results")
    .upsert(rows, { onConflict: "run_id,event_id" });

  if (error) throw new Error(`[MC] Failed to upsert monte_carlo_results: ${error.message}`);
}

// -------------------- MODEL --------------------
function buildInputs(home: TeamRatingRow, away: TeamRatingRow) {
  const homePower = num(home.engine_power, 0);
  const awayPower = num(away.engine_power, 0);
  const homeHca = num(home.true_hca, 0);

  // MODEL-NATIVE: marginMean is (home - away) (positive = home better)
  const marginMean = (homePower - awayPower) + homeHca;

  const homeAvgTotal = toNullNum(home.avg_total_points);
  const awayAvgTotal = toNullNum(away.avg_total_points);

  const homePf = toNullNum(home.pf_points);
  const homePa = toNullNum(home.pa_points);
  const awayPf = toNullNum(away.pf_points);
  const awayPa = toNullNum(away.pa_points);

  let totalMean: number;

  if (TOTAL_FALLBACK_MODE === "avg_total_points") {
    if (homeAvgTotal != null && awayAvgTotal != null) totalMean = (homeAvgTotal + awayAvgTotal) / 2;
    else if (homeAvgTotal != null) totalMean = homeAvgTotal;
    else if (awayAvgTotal != null) totalMean = awayAvgTotal;
    else totalMean = 140;
  } else {
    if (homePf != null && awayPa != null && awayPf != null && homePa != null) {
      const homePts = (homePf + awayPa) / 2;
      const awayPts = (awayPf + homePa) / 2;
      totalMean = homePts + awayPts;
    } else if (homeAvgTotal != null || awayAvgTotal != null) {
      totalMean =
        ((homeAvgTotal ?? 0) + (awayAvgTotal ?? 0)) /
        (homeAvgTotal != null && awayAvgTotal != null ? 2 : 1);
    } else totalMean = 140;
  }

  const sigmaMarginGame = Math.max(
    avg(num(home.sigma_margin_100, SIGMA_MARGIN_FLOOR), num(away.sigma_margin_100, SIGMA_MARGIN_FLOOR)),
    SIGMA_MARGIN_FLOOR
  );

  const sigmaTotalGame = Math.max(
    avg(num(home.sigma_total_100, SIGMA_TOTAL_FLOOR), num(away.sigma_total_100, SIGMA_TOTAL_FLOOR)),
    SIGMA_TOTAL_FLOOR
  );

  return {
    homePower,
    awayPower,
    homeHca,
    homePf,
    homePa,
    homeAvgTotal,
    awayPf,
    awayPa,
    awayAvgTotal,
    marginMean,
    totalMean,
    sigmaMarginGame,
    sigmaTotalGame,
  };
}

function simulateGameWithProbs(
  sims: number,
  input: ReturnType<typeof buildInputs>,
  opts: {
    marginHomeWinNegativeStore: boolean;
    spreadLineHome: number | null;
    totalLine: number | null;
    eps: number;
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
    // MODEL-NATIVE m: home - away (positive = home better)
    const m = input.marginMean + randn() * input.sigmaMarginGame;
    const t = Math.max(0, input.totalMean + randn() * input.sigmaTotalGame);

    sumM += m;
    sumT += t;

    if (m > 0) homeWins++;
    else if (m < 0) awayWins++;

    // Spread: home covers if (home - away + line_home) > 0
    if (spreadLineHome != null) {
      const v = m + spreadLineHome;
      if (v > eps) homeCovers++;
      else if (Math.abs(v) <= eps) coverPushes++;
    }

    // Total: over if (total - line) > 0
    if (totalLine != null) {
      const dv = t - totalLine;
      if (dv > eps) overs++;
      else if (Math.abs(dv) <= eps) totalPushes++;
    }
  }

  const projectedMarginHome_model = sumM / sims; // home - away
  const projectedTotal = sumT / sims;

  // Stored margin convention (what you display/store)
  const projectedMarginHome_stored = opts.marginHomeWinNegativeStore
    ? -projectedMarginHome_model
    : projectedMarginHome_model;

  const homeWinProb = homeWins / sims;
  const awayWinProb = awayWins / sims;

  const homeCoverProb = spreadLineHome == null ? null : homeCovers / sims;
  const coverPushProb = spreadLineHome == null ? null : coverPushes / sims;
  const awayCoverProb =
    spreadLineHome == null ? null : 1 - (homeCoverProb ?? 0) - (coverPushProb ?? 0);

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

// -------------------- UTILS --------------------
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
function round2(x: number) {
  return Math.round(x * 100) / 100;
}
function randn() {
  let u = 0,
    v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// --------------------
main().catch((e) => {
  console.error(e);
  process.exit(1);
});


