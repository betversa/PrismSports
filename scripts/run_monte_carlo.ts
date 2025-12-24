// scripts/run_monte_carlo.ts
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

/* ===========================
   Types
=========================== */

type EventRow = {
  event_id: string;
  sport_key: string;
  commence_time: string;
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

type OddsRow = {
  event_id: string;
  bookmaker: string;
  market: "spreads" | "totals";
  side: "home" | "away" | "over" | "under";
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

/* ===========================
   ENV / CONFIG
=========================== */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SPORT_KEY = process.env.SPORT_KEY || "basketball_ncaab";

const SIMS = Number(process.env.MC_SIMS ?? "10000");
const START_GRACE_MINUTES = Number(process.env.MC_START_GRACE_MINUTES ?? "0");

const SIGMA_MARGIN_FLOOR = Number(process.env.SIGMA_MARGIN_FLOOR ?? "8");
const SIGMA_TOTAL_FLOOR = Number(process.env.SIGMA_TOTAL_FLOOR ?? "13.5");

const TOTAL_FALLBACK_MODE =
  (process.env.TOTAL_FALLBACK_MODE || "avg_total_points") as
    | "avg_total_points"
    | "pf_pa_blend";

const MARGIN_HOME_WIN_NEGATIVE =
  (process.env.MARGIN_HOME_WIN_NEGATIVE ?? "true").toLowerCase() === "true";

const LINE_BOOK = (process.env.LINE_BOOK ?? "draftkings").toLowerCase();
const EPS = Number(process.env.MC_PUSH_EPS ?? "1e-9");

const WRITE_TRACE =
  (process.env.MC_WRITE_TRACE ?? "true").toLowerCase() === "true";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

/* ===========================
   MAIN
=========================== */

async function main() {
  console.log(
    `[MC] SPORT=${SPORT_KEY} sims=${SIMS} lineBook=${LINE_BOOK} marginNeg=${MARGIN_HOME_WIN_NEGATIVE}`
  );

  const startCutoff = new Date(Date.now() - START_GRACE_MINUTES * 60 * 1000);

  const events = await fetchFutureEvents(startCutoff);
  if (!events.length) {
    console.log("[MC] No future events.");
    return;
  }

  const eventIds = events.map(e => e.event_id);

  await clearMonteCarloResultsForEvents(eventIds);

  const lineMap = await fetchLatestLinesFromSnapshot(eventIds);
  const ratings = await fetchTeamRatingsFromEvents(events);

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

  for (const e of events) {
    const home = e.canon_home_team;
    const away = e.canon_away_team;
    if (!home || !away) continue;

    const homeR = ratings.get(home);
    const awayR = ratings.get(away);
    if (!homeR || !awayR) continue;

    const input = buildInputs(homeR, awayR);

    const spreadLineHome =
      lineMap.get(`${e.event_id}|spreads|home`) ?? null;
    const totalLine =
      lineMap.get(`${e.event_id}|totals|over`) ?? null;

    const sim = simulateGameWithProbs(
      SIMS,
      input,
      spreadLineHome,
      totalLine
    );

    const homePts =
      sim.projectedTotal / 2 + sim.projectedMarginHome_model / 2;
    const awayPts = sim.projectedTotal - homePts;

    results.push({
      run_id: runId,
      event_id: e.event_id,
      commence_time: e.commence_time,
      matchup: e.matchup,
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

      trace: WRITE_TRACE ? sim.trace : null,
    });
  }

  await upsertMonteCarloResults(results);
  console.log(`[MC] Upserted ${results.length} rows.`);
}

/* ===========================
   LINE FETCH (FIXED)
=========================== */

async function fetchLatestLinesFromSnapshot(eventIds: string[]) {
  const out = new Map<string, number>();

  const { data } = await supabase
    .from("odds_snapshot")
    .select("event_id,market,side,line,ts")
    .eq("bookmaker", LINE_BOOK)
    .in("event_id", eventIds)
    .order("ts", { ascending: false });

  const seen = new Set<string>();

  for (const r of (data ?? []) as OddsRow[]) {
    const key = `${r.event_id}|${r.market}|${r.side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (Number.isFinite(r.line)) out.set(key, r.line!);
  }

  for (const id of eventIds) {
    const a = out.get(`${id}|spreads|away`);
    if (!out.has(`${id}|spreads|home`) && a != null)
      out.set(`${id}|spreads|home`, -a);

    const u = out.get(`${id}|totals|under`);
    if (!out.has(`${id}|totals|over`) && u != null)
      out.set(`${id}|totals|over`, u);
  }

  return out;
}

/* ===========================
   FETCH HELPERS
=========================== */

async function fetchFutureEvents(startCutoff: Date): Promise<EventRow[]> {
  const { data } = await supabase
    .from("events")
    .select("*")
    .eq("sport_key", SPORT_KEY)
    .gte("commence_time", startCutoff.toISOString())
    .order("commence_time", { ascending: true });

  return (data ?? []) as EventRow[];
}

async function fetchTeamRatingsFromEvents(events: EventRow[]) {
  const teams = [...new Set(events.flatMap(e => [e.canon_home_team, e.canon_away_team]).filter(Boolean))];
  const { data } = await supabase
    .from("team_ratings")
    .select("*")
    .in("canonical", teams);

  return new Map((data ?? []).map((r: TeamRatingRow) => [r.canonical, r]));
}

async function clearMonteCarloResultsForEvents(eventIds: string[]) {
  const CHUNK = 500;
  for (let i = 0; i < eventIds.length; i += CHUNK) {
    await supabase
      .from("monte_carlo_results")
      .delete()
      .in("event_id", eventIds.slice(i, i + CHUNK));
  }
}

async function createMonteCarloRun(payload: MonteCarloRunInsert) {
  const { data } = await supabase
    .from("monte_carlo_runs")
    .insert(payload)
    .select("id")
    .single();
  return data!.id as string;
}

async function upsertMonteCarloResults(rows: MonteCarloResultUpsert[]) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await supabase
      .from("monte_carlo_results")
      .upsert(rows.slice(i, i + CHUNK), {
        onConflict: "run_id,event_id",
      });
  }
}

/* ===========================
   MODEL
=========================== */

function buildInputs(h: TeamRatingRow, a: TeamRatingRow) {
  const marginMean = (num(h.engine_power) - num(a.engine_power)) + num(h.true_hca);

  const totalMean =
    TOTAL_FALLBACK_MODE === "avg_total_points"
      ? avg(num(h.avg_total_points, 140), num(a.avg_total_points, 140))
      : avg(num(h.pf_points), num(a.pa_points)) +
        avg(num(a.pf_points), num(h.pa_points));

  return {
    marginMean,
    totalMean,
    sigmaMarginGame: Math.max(
      avg(num(h.sigma_margin_100), num(a.sigma_margin_100)),
      SIGMA_MARGIN_FLOOR
    ),
    sigmaTotalGame: Math.max(
      avg(num(h.sigma_total_100), num(a.sigma_total_100)),
      SIGMA_TOTAL_FLOOR
    ),
  };
}

function simulateGameWithProbs(
  sims: number,
  input: any,
  spreadLine: number | null,
  totalLine: number | null
) {
  let mSum = 0,
    tSum = 0,
    win = 0,
    cover = 0,
    coverPush = 0,
    over = 0,
    totalPush = 0;

  for (let i = 0; i < sims; i++) {
    const m = input.marginMean + randn() * input.sigmaMarginGame;
    const t = input.totalMean + randn() * input.sigmaTotalGame;

    mSum += m;
    tSum += t;

    if (m > 0) win++;

    if (spreadLine != null) {
      const v = m + spreadLine;
      if (v > EPS) cover++;
      else if (Math.abs(v) <= EPS) coverPush++;
    }

    if (totalLine != null) {
      const v = t - totalLine;
      if (v > EPS) over++;
      else if (Math.abs(v) <= EPS) totalPush++;
    }
  }

  const marginModel = mSum / sims;
  const marginStore = MARGIN_HOME_WIN_NEGATIVE ? -marginModel : marginModel;

  return {
    projectedMarginHome_model: round2(marginModel),
    projectedMarginHome_stored: round2(marginStore),
    projectedTotal: round2(tSum / sims),

    homeWinProb: win / sims,
    awayWinProb: 1 - win / sims,

    homeCoverProb: spreadLine == null ? null : cover / sims,
    coverPushProb: spreadLine == null ? null : coverPush / sims,
    awayCoverProb:
      spreadLine == null ? null : 1 - cover / sims - coverPush / sims,

    overProb: totalLine == null ? null : over / sims,
    totalPushProb: totalLine == null ? null : totalPush / sims,
    underProb:
      totalLine == null ? null : 1 - over / sims - totalPush / sims,

    trace: {
      margin_mean: input.marginMean,
      total_mean: input.totalMean,
      sims,
    },
  };
}

/* ===========================
   UTILS
=========================== */

function num(v: any, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}
function avg(a: number, b: number) {
  return (a + b) / 2;
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}
function randn() {
  let u = 0,
    v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

