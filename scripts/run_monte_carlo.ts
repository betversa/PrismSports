// scripts/run_monte_carlo.ts
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type TeamRating = {
  canonical: string;
  engine_power: number;
  true_hca: number;
  pf_points: number;
  pa_points: number;
  avg_total_points: number;
  sigma_margin_100: number;
  sigma_total_100: number;
};

type EventRow = {
  event_id: string; // or event_id
  commence_time: string;
  home_team: string;
  away_team: string;
  matchup?: string | null;
};

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const MC_CONFIG = {
  SPORT_KEY: "basketball_ncaab",
  SIMS: 10000,

  // Simple v1: no possessions, so treat sigma_*_100 as game-scale directly (with floors)
  SIGMA_MARGIN_FLOOR: 8.0,
  SIGMA_TOTAL_FLOOR: 13.5,

  // Optional: use PF/PA to nudge margin/total a bit (keep small)
  USE_PFPA_NUDGE: true,
  PFPA_MARGIN_W: 0.20, // 0..0.35 recommended
  PFPA_TOTAL_W: 0.15,  // 0..0.35 recommended

  // Time window for upcoming slate
  HOURS_AHEAD: 36,
};

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

function randnBM() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function safeNum(x: any, fb: number) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fb;
}

// --- Optional canonicalization using team_map ---
// We’ll load team_map once into a dictionary of: normalized(alias)->canonical
function normalizeKey(s: string) {
  return String(s)
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadTeamMap(): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from("team_map")
    .select('canonical,"The Odds API", "ESPN_Long", "SR_School", "SR_School_Short", "KenPom", "Elo", "TR"');

  if (error) throw error;

  const map: Record<string, string> = {};
  for (const row of data || []) {
    const canonical = row.canonical;
    if (!canonical) continue;

    const add = (val: any) => {
      if (!val) return;
      const k = normalizeKey(String(val));
      if (!map[k]) map[k] = canonical;
    };

    add(canonical);
    add((row as any)["The Odds API"]);
    add((row as any)["ESPN_Long"]);
    add((row as any)["SR_School"]);
    add((row as any)["SR_School_Short"]);
    add((row as any)["KenPom"]);
    add((row as any)["Elo"]);
    add((row as any)["TR"]);
  }
  return map;
}

function toCanonical(raw: string, teamMap: Record<string, string>) {
  if (!raw) return null;
  return teamMap[normalizeKey(raw)] || null;
}

// --- Pull team_ratings into map ---
async function loadTeamRatings(): Promise<Record<string, TeamRating>> {
  const { data, error } = await supabase
    .from("team_ratings")
    .select(
      "canonical, engine_power, true_hca, pf_points, pa_points, avg_total_points, sigma_margin_100, sigma_total_100"
    );

  if (error) throw error;

  const map: Record<string, TeamRating> = {};
  for (const r of data || []) {
    const canonical = (r as any).canonical;
    if (!canonical) continue;

    map[canonical] = {
      canonical,
      engine_power: safeNum((r as any).engine_power, 0),
      true_hca: safeNum((r as any).true_hca, 0),
      pf_points: safeNum((r as any).pf_points, 0),
      pa_points: safeNum((r as any).pa_points, 0),
      avg_total_points: safeNum((r as any).avg_total_points, 0),
      sigma_margin_100: safeNum((r as any).sigma_margin_100, MC_CONFIG.SIGMA_MARGIN_FLOOR),
      sigma_total_100: safeNum((r as any).sigma_total_100, MC_CONFIG.SIGMA_TOTAL_FLOOR),
    };
  }
  return map;
}

// --- Pull upcoming events ---
// Adjust column names here if yours differ.
async function loadUpcomingEvents(): Promise<EventRow[]> {
  const now = new Date();
  const max = new Date(now.getTime() + MC_CONFIG.HOURS_AHEAD * 3600 * 1000);

  const { data, error } = await supabase
    .from("events")
    .select("event_id, commence_time, home_team, away_team, matchup")
    .gte("commence_time", now.toISOString())
    .lt("commence_time", max.toISOString())
    .order("commence_time", { ascending: true });

  if (error) throw error;
  return (data || []) as any;
}

function simulateGameV1(home: TeamRating, away: TeamRating) {
  // Base margin from power + HCA
  let marginMean = (home.engine_power - away.engine_power) + (home.true_hca || 0);

  // Base total from the “avg_total_points” (team-level) — simplest v1:
  // take midpoint of both teams' avg_total_points
  let totalMean = (home.avg_total_points + away.avg_total_points) / 2;

  // Optional PF/PA nudge (small)
  const trace: any = {
    marginMean_base: marginMean,
    totalMean_base: totalMean,
  };

  if (MC_CONFIG.USE_PFPA_NUDGE) {
    // Margin nudge based on net points (PF-PA)
    const homeNet = home.pf_points - home.pa_points;
    const awayNet = away.pf_points - away.pa_points;
    const netDiff = homeNet - awayNet;

    const wM = clamp(MC_CONFIG.PFPA_MARGIN_W, 0, 0.35);
    marginMean = (1 - wM) * marginMean + wM * netDiff;

    // Total nudge based on combined PF (simple heuristic)
    const totalPf = home.pf_points + away.pf_points;
    const wT = clamp(MC_CONFIG.PFPA_TOTAL_W, 0, 0.35);
    totalMean = (1 - wT) * totalMean + wT * totalPf;

    trace.homeNet = homeNet;
    trace.awayNet = awayNet;
    trace.netDiff = netDiff;
    trace.wM = wM;
    trace.wT = wT;
    trace.marginMean_after_pfpa = marginMean;
    trace.totalMean_after_pfpa = totalMean;
  }

  // Sigmas treated as game-scale (since we’re not using possessions right now)
  let sigmaMarginGame = (home.sigma_margin_100 + away.sigma_margin_100) / 2;
  let sigmaTotalGame = (home.sigma_total_100 + away.sigma_total_100) / 2;

  sigmaMarginGame = Math.max(sigmaMarginGame, MC_CONFIG.SIGMA_MARGIN_FLOOR);
  sigmaTotalGame = Math.max(sigmaTotalGame, MC_CONFIG.SIGMA_TOTAL_FLOOR);

  let sumM = 0;
  let sumT = 0;

  for (let i = 0; i < MC_CONFIG.SIMS; i++) {
    const m = marginMean + randnBM() * sigmaMarginGame;
    const t = Math.max(0, totalMean + randnBM() * sigmaTotalGame);
    sumM += m;
    sumT += t;
  }

  const projectedMarginHome = sumM / MC_CONFIG.SIMS;
  const projectedTotal = sumT / MC_CONFIG.SIMS;

  trace.sigmaMarginGame = sigmaMarginGame;
  trace.sigmaTotalGame = sigmaTotalGame;

  return { projectedMarginHome, projectedTotal, sigmaMarginGame, sigmaTotalGame, trace };
}

async function main() {
  const teamMap = await loadTeamMap();
  const ratings = await loadTeamRatings();
  const events = await loadUpcomingEvents();

  // Create run row
  const { data: runRow, error: runErr } = await supabase
    .from("monte_carlo_runs")
    .insert({
      sport_key: MC_CONFIG.SPORT_KEY,
      config: MC_CONFIG,
    })
    .select("id")
    .single();

  if (runErr) throw runErr;
  const runId = runRow.id as string;

  const results: any[] = [];

  for (const ev of events) {
    // events table might already store canonical — but we canonicalize safely anyway
    const homeCanon = toCanonical(ev.home_team, teamMap) || ev.home_team;
    const awayCanon = toCanonical(ev.away_team, teamMap) || ev.away_team;

    const home = ratings[homeCanon];
    const away = ratings[awayCanon];

    if (!home || !away) {
      // skip if missing ratings
      continue;
    }

    const matchup = ev.matchup || `${awayCanon} @ ${homeCanon}`;
    const sim = simulateGameV1(home, away);

    results.push({
      run_id: runId,
      event_id: ev.id,
      commence_time: ev.commence_time,
      matchup,
      home_team: homeCanon,
      away_team: awayCanon,
      projected_margin_home: sim.projectedMarginHome,
      sigma_margin_game: sim.sigmaMarginGame,
      projected_total: sim.projectedTotal,
      sigma_total_game: sim.sigmaTotalGame,
      trace: sim.trace,
    });
  }

  if (results.length) {
    // bulk insert results
    const { error: insErr } = await supabase.from("monte_carlo_results").insert(results);
    if (insErr) throw insErr;
  }

  console.log(`Monte Carlo run complete. run_id=${runId}, events=${results.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
