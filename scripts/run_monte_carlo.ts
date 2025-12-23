/**
 * run_monte_carlo.ts
 *
 * Monte Carlo Results Runner (Supabase-only)
 * - Reads upcoming events from public.events (event_id, canon_home_team, canon_away_team, etc.)
 * - Reads team metrics from public.team_ratings
 * - Produces Monte Carlo projections (margin/total + sigmas + win prob)
 * - Upserts results into public.monte_carlo_results (keyed by event_id)
 *
 * NO connections to OddsScreen or odds_snapshot/history tables.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

// ===================== CONFIG =====================

const SPORT_KEY = process.env.SPORT_KEY ?? "basketball_ncaab";

// How far ahead to compute (days)
const LOOKAHEAD_DAYS = Number(process.env.MC_LOOKAHEAD_DAYS ?? 3);

// Sims
const SIMS = Number(process.env.MC_SIMS ?? 10000);

// Total projection blend:
// total_from_pfpa = homeExpPts + awayExpPts (see formula below)
// avg_total_points blend = average of the two teams' avg_total_points (if present)
const TOTAL_BLEND_W_PFPA = clamp01(Number(process.env.MC_TOTAL_BLEND_W_PFPA ?? 0.75));
const TOTAL_BLEND_W_AVG  = clamp01(1 - TOTAL_BLEND_W_PFPA);

// Table names
const EVENTS_TABLE = process.env.EVENTS_TABLE ?? "events";
const TEAM_RATINGS_TABLE = process.env.TEAM_RATINGS_TABLE ?? "team_ratings";
const OUTPUT_TABLE = process.env.MC_OUTPUT_TABLE ?? "monte_carlo_results";

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // recommended for server/GH action

if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL in env.");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY in env.");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ===================== TYPES =====================

type EventRow = {
  event_id: string;
  sport_key: string;
  commence_time: string; // ISO-ish string
  canon_home_team: string | null;
  canon_away_team: string | null;
  matchup: string | null;
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

type MCOutputRow = {
  event_id: string;
  sport_key: string;
  commence_time: string;
  matchup: string;

  home_team: string;
  away_team: string;

  projected_margin_home: number;
  sigma_margin: number;

  projected_total: number;
  sigma_total: number;

  p_home_win: number;

  sims: number;
  updated_at: string; // ISO
};

// ===================== MAIN =====================

async function main() {
  const now = new Date();
  const startIso = now.toISOString();

  const end = new Date(now.getTime() + LOOKAHEAD_DAYS * 864e5);
  const endIso = end.toISOString();

  console.log(`[MC] SPORT_KEY=${SPORT_KEY} lookaheadDays=${LOOKAHEAD_DAYS} sims=${SIMS}`);
  console.log(`[MC] Fetch events between ${startIso} and ${endIso}`);

  // 1) Load upcoming events
  const events = await fetchUpcomingEvents(startIso, endIso);

  if (!events.length) {
    console.log("[MC] No upcoming events found in window. Exiting.");
    return;
  }

  // Only those with canonical teams present
  const usableEvents = events.filter((e) => e.canon_home_team && e.canon_away_team);

  if (!usableEvents.length) {
    console.log("[MC] Events found, but none have canon_home_team/canon_away_team. Exiting.");
    return;
  }

  // 2) Load team ratings for all teams involved
  const teams = uniqueStrings(
    usableEvents.flatMap((e) => [e.canon_home_team as string, e.canon_away_team as string])
  );

  const ratingsMap = await fetchTeamRatingsMap(teams);

  // 3) Compute MC rows
  const out: MCOutputRow[] = [];

  for (const e of usableEvents) {
    const home = e.canon_home_team as string;
    const away = e.canon_away_team as string;

    const hr = ratingsMap.get(home);
    const ar = ratingsMap.get(away);

    if (!hr || !ar) {
      console.warn(
        `[MC] Missing team_ratings for event_id=${e.event_id} home=${home} away=${away} (skip)`
      );
      continue;
    }

    const mc = runMonteCarloForEvent({
      eventId: e.event_id,
      sportKey: e.sport_key,
      commenceTime: e.commence_time,
      matchup: e.matchup ?? `${away} @ ${home}`,
      homeTeam: home,
      awayTeam: away,
      home: hr,
      away: ar,
      sims: SIMS,
    });

    out.push(mc);
  }

  if (!out.length) {
    console.log("[MC] No outputs produced (likely missing team_ratings). Exiting.");
    return;
  }

  // 4) Upsert results keyed by event_id
  await upsertMonteCarloResults(out);

  // 5) Console summary
  console.log(`[MC] Upserted ${out.length} rows into ${OUTPUT_TABLE}. Sample:`);
  console.log(
    out.slice(0, 8).map((r) => ({
      event_id: r.event_id,
      matchup: r.matchup,
      margin_home: r.projected_margin_home,
      total: r.projected_total,
      p_home_win: r.p_home_win,
    }))
  );
}

// ===================== FETCHERS =====================

async function fetchUpcomingEvents(startIso: string, endIso: string): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from(EVENTS_TABLE)
    .select(
      "event_id,sport_key,commence_time,canon_home_team,canon_away_team,matchup"
    )
    .eq("sport_key", SPORT_KEY)
    .gte("commence_time", startIso)
    .lt("commence_time", endIso)
    .order("commence_time", { ascending: true });

  if (error) throw new Error(`[MC] Failed to fetch events: ${error.message}`);
  return (data ?? []) as EventRow[];
}

async function fetchTeamRatingsMap(teams: string[]): Promise<Map<string, TeamRatingRow>> {
  // Supabase "in" has practical limits; chunk to be safe
  const CHUNK = 200;
  const map = new Map<string, TeamRatingRow>();

  for (let i = 0; i < teams.length; i += CHUNK) {
    const chunk = teams.slice(i, i + CHUNK);

    const { data, error } = await supabase
      .from(TEAM_RATINGS_TABLE)
      .select(
        [
          "canonical",
          "engine_power",
          "true_hca",
          "pf_points",
          "pa_points",
          "avg_total_points",
          "sigma_margin_100",
          "sigma_total_100",
        ].join(",")
      )
      .in("canonical", chunk);

    if (error) throw new Error(`[MC] Failed to fetch team_ratings: ${error.message}`);

    for (const row of (data ?? []) as TeamRatingRow[]) {
      map.set(row.canonical, row);
    }
  }

  return map;
}

async function upsertMonteCarloResults(rows: MCOutputRow[]) {
  const { error } = await supabase
    .from(OUTPUT_TABLE)
    .upsert(rows, { onConflict: "event_id" });

  if (error) throw new Error(`[MC] Failed to upsert ${OUTPUT_TABLE}: ${error.message}`);
}

// ===================== MONTE CARLO CORE =====================

function runMonteCarloForEvent(args: {
  eventId: string;
  sportKey: string;
  commenceTime: string;
  matchup: string;
  homeTeam: string;
  awayTeam: string;
  home: TeamRatingRow;
  away: TeamRatingRow;
  sims: number;
}): MCOutputRow {
  const {
    eventId,
    sportKey,
    commenceTime,
    matchup,
    homeTeam,
    awayTeam,
    home,
    away,
    sims,
  } = args;

  // ---- Projected Margin (HOME) ----
  // You specified: canonical, engine_power, true_hca for home team
  const homePower = num(home.engine_power, 0);
  const awayPower = num(away.engine_power, 0);
  const hca = num(home.true_hca, 0);

  // Positive => home favored
  const projMarginHome = homePower + hca - awayPower;

  // ---- Projected Total ----
  // PF vs Opp PA expected points:
  // homeExp = avg(home.pf_points, away.pa_points)
  // awayExp = avg(away.pf_points, home.pa_points)
  const homePF = num(home.pf_points, NaN);
  const homePA = num(home.pa_points, NaN);
  const awayPF = num(away.pf_points, NaN);
  const awayPA = num(away.pa_points, NaN);

  const homeExp = avgIfFinite(homePF, awayPA);
  const awayExp = avgIfFinite(awayPF, homePA);

  const totalFromPfpa = finiteOrFallback(homeExp, 0) + finiteOrFallback(awayExp, 0);

  // Optional blend toward avg_total_points (team-level)
  const hAvgTot = num(home.avg_total_points, NaN);
  const aAvgTot = num(away.avg_total_points, NaN);
  const avgTotalPoints = avgIfFinite(hAvgTot, aAvgTot); // average of the two teams

  const totalMean =
    (TOTAL_BLEND_W_PFPA * totalFromPfpa) +
    (TOTAL_BLEND_W_AVG * finiteOrFallback(avgTotalPoints, totalFromPfpa));

  // ---- Sigmas ----
  // Use sigma_margin_100 and sigma_total_100 as game-level sigmas for now (no possessions scaling)
  const sigmaMargin = clampMin(avgIfFinite(num(home.sigma_margin_100, NaN), num(away.sigma_margin_100, NaN)), 8.0);
  const sigmaTotal = clampMin(avgIfFinite(num(home.sigma_total_100, NaN), num(away.sigma_total_100, NaN)), 13.5);

  // ---- Sims (Normal) ----
  let homeWins = 0;

  for (let i = 0; i < sims; i++) {
    const m = projMarginHome + randn() * sigmaMargin;
    // total can't be negative; clamp at 0
    const t = Math.max(0, totalMean + randn() * sigmaTotal);

    // Win based on margin
    if (m > 0) homeWins++;

    // (We’re not storing simulated totals distribution yet; you can later if needed)
    void t;
  }

  const pHomeWin = homeWins / sims;

  const updatedAt = new Date().toISOString();

  return {
    event_id: eventId,
    sport_key: sportKey,
    commence_time: commenceTime,
    matchup,

    home_team: homeTeam,
    away_team: awayTeam,

    projected_margin_home: round1(projMarginHome),
    sigma_margin: round1(sigmaMargin),

    projected_total: round1(totalMean),
    sigma_total: round1(sigmaTotal),

    p_home_win: round4(pHomeWin),

    sims,
    updated_at: updatedAt,
  };
}

// ===================== UTILS =====================

function uniqueStrings(arr: string[]): string[] {
  return Array.from(new Set(arr.filter(Boolean)));
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function avgIfFinite(a: number, b: number): number {
  const fa = Number.isFinite(a);
  const fb = Number.isFinite(b);
  if (fa && fb) return (a + b) / 2;
  if (fa) return a;
  if (fb) return b;
  return NaN;
}

function finiteOrFallback(v: number, fb: number): number {
  return Number.isFinite(v) ? v : fb;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function clampMin(x: number, min: number): number {
  return Number.isFinite(x) ? Math.max(x, min) : min;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// Box–Muller
function randn(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ===================== RUN =====================

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
