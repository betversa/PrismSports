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
  throw new Error(
    "[MC] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (preferred)."
  );
}

const SPORT_KEY = process.env.SPORT_KEY || "basketball_ncaab";
const LOOKAHEAD_DAYS = Number(process.env.LOOKAHEAD_DAYS ?? "3");
const SIMS = Number(process.env.MC_SIMS ?? "10000");

// Floors (keep things sane if a team is missing sigma)
const SIGMA_MARGIN_FLOOR = Number(process.env.SIGMA_MARGIN_FLOOR ?? "8");
const SIGMA_TOTAL_FLOOR = Number(process.env.SIGMA_TOTAL_FLOOR ?? "13.5");

// If avg_total_points is null, fallback to (home.pf + away.pf)/2 etc.
const TOTAL_FALLBACK_MODE = (process.env.TOTAL_FALLBACK_MODE || "avg_total_points") as
  | "avg_total_points"
  | "pf_pa_blend";

// Toggle trace payload
const WRITE_TRACE = (process.env.MC_WRITE_TRACE ?? "true").toLowerCase() === "true";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// -------------------- MAIN --------------------
async function main() {
  console.log(`[MC] SPORT_KEY=${SPORT_KEY} lookaheadDays=${LOOKAHEAD_DAYS} sims=${SIMS}`);

  const now = new Date();
  const end = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

  console.log(`[MC] Fetch events between ${now.toISOString()} and ${end.toISOString()}`);

  const events = await fetchEvents(now, end);
  if (!events.length) {
    console.log("[MC] No events found in window. Done.");
    return;
  }

  // collect canon teams
  const teamSet = new Set<string>();
  for (const e of events) {
    if (e.canon_home_team) teamSet.add(e.canon_home_team);
    if (e.canon_away_team) teamSet.add(e.canon_away_team);
  }
  const teamList = [...teamSet];

  const ratings = await fetchTeamRatings(teamList);
  const ratingMap = new Map<string, TeamRatingRow>();
  for (const r of ratings) ratingMap.set(r.canonical, r);

  // create run
  const runId = await createMonteCarloRun({
    sport_key: SPORT_KEY,
    config: {
      sims: SIMS,
      lookahead_days: LOOKAHEAD_DAYS,
      sigma_margin_floor: SIGMA_MARGIN_FLOOR,
      sigma_total_floor: SIGMA_TOTAL_FLOOR,
      total_fallback_mode: TOTAL_FALLBACK_MODE,
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
    const sim = simulateGame(SIMS, input);

    // turn mean margin/total into points
    const homePts = (sim.projectedTotal / 2) + (sim.projectedMarginHome / 2);
    const awayPts = sim.projectedTotal - homePts;

    const trace = WRITE_TRACE
      ? {
          // inputs
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

          // modeled means/sigmas
          margin_mean: input.marginMean,
          total_mean: input.totalMean,
          sigma_margin_game: input.sigmaMarginGame,
          sigma_total_game: input.sigmaTotalGame,

          // sim stats
          p_home_win: sim.pHomeWin,
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

      projected_margin_home: sim.projectedMarginHome,
      sigma_margin_game: input.sigmaMarginGame,
      projected_total: sim.projectedTotal,
      sigma_total_game: input.sigmaTotalGame,

      projected_home_points: round2(homePts),
      projected_away_points: round2(awayPts),

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
async function fetchEvents(start: Date, end: Date): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from("events")
    .select(
      "event_id,sport_key,commence_time,api_home_team,api_away_team,canon_home_team,canon_away_team,matchup"
    )
    .eq("sport_key", SPORT_KEY)
    .gte("commence_time", start.toISOString())
    .lte("commence_time", end.toISOString())
    .order("commence_time", { ascending: true });

  if (error) throw new Error(`[MC] Failed to fetch events: ${error.message}`);

  // enforce event_id existence + dedupe
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

  // Supabase has limits; chunk to be safe
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

  if (error) {
    // This is where schema-cache errors show up (missing column, etc.)
    throw new Error(`[MC] Failed to upsert monte_carlo_results: ${error.message}`);
  }
}

// -------------------- MODEL --------------------
function buildInputs(home: TeamRatingRow, away: TeamRatingRow) {
  const homePower = num(home.engine_power, 0);
  const awayPower = num(away.engine_power, 0);
  const homeHca = num(home.true_hca, 0);

  // margin mean = power diff + home HCA
  const marginMean = (homePower - awayPower) + homeHca;

  const homeAvgTotal = toNullNum(home.avg_total_points);
  const awayAvgTotal = toNullNum(away.avg_total_points);

  const homePf = toNullNum(home.pf_points);
  const homePa = toNullNum(home.pa_points);
  const awayPf = toNullNum(away.pf_points);
  const awayPa = toNullNum(away.pa_points);

  let totalMean: number;

  if (TOTAL_FALLBACK_MODE === "avg_total_points") {
    // preferred: avg of team-level avg_total_points if available
    if (homeAvgTotal != null && awayAvgTotal != null) {
      totalMean = (homeAvgTotal + awayAvgTotal) / 2;
    } else if (homeAvgTotal != null) {
      totalMean = homeAvgTotal;
    } else if (awayAvgTotal != null) {
      totalMean = awayAvgTotal;
    } else {
      // last resort
      totalMean = 140;
    }
  } else {
    // pf/pa blend fallback (simple, symmetric)
    // estimate each side points: (team PF + opp PA)/2, then sum
    if (homePf != null && awayPa != null && awayPf != null && homePa != null) {
      const homePts = (homePf + awayPa) / 2;
      const awayPts = (awayPf + homePa) / 2;
      totalMean = homePts + awayPts;
    } else if (homeAvgTotal != null || awayAvgTotal != null) {
      totalMean = ((homeAvgTotal ?? 0) + (awayAvgTotal ?? 0)) / (homeAvgTotal != null && awayAvgTotal != null ? 2 : 1);
    } else {
      totalMean = 140;
    }
  }

  // sigma game = avg sigmas, floored
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

function simulateGame(sims: number, input: ReturnType<typeof buildInputs>) {
  let sumM = 0;
  let sumT = 0;
  let homeWins = 0;

  for (let i = 0; i < sims; i++) {
    const m = input.marginMean + randn() * input.sigmaMarginGame;
    const t = Math.max(0, input.totalMean + randn() * input.sigmaTotalGame);

    sumM += m;
    sumT += t;
    if (m > 0) homeWins++;
  }

  const projectedMarginHome = sumM / sims;
  const projectedTotal = sumT / sims;

  return {
    projectedMarginHome: round2(projectedMarginHome),
    projectedTotal: round2(projectedTotal),
    pHomeWin: homeWins / sims,
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

// Box–Muller standard normal
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// --------------------
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

