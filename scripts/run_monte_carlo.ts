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

  engine_power: number | null;
  true_hca: number | null;

  pf_points: number | null;
  pa_points: number | null;
  avg_total_points: number | null;

  sigma_margin_100: number | null;
  sigma_total_100: number | null;
};

type MarketKey = "h2h" | "spreads" | "totals";
type SideKey = "home" | "away" | "over" | "under";

type OddsSnapshotRow = {
  event_id: string;
  bookmaker: string;
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

type EvPlayInsert = {
  // ✅ NEW (Option A)
  sport_key: string;

  run_id: string;
  event_id: string;
  commence_time: string | null;
  matchup: string | null;

  team: string | null;

  market: MarketKey;
  side: SideKey;
  line: number | null;

  bookmaker: string; // soft book
  book_odds: number; // American

  quantum_prob: number;
  quantum_odds: number;
  ev_pct: number;

  confidence_score: number; // 0..100
  confidence_tier: string;

  kelly_fraction: number; // 0..1
  bet_fraction: number; // 0..1
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

// ✅ MULTI-SPORT
const SPORT_KEYS = (process.env.SPORT_KEYS || process.env.SPORT_KEY || "basketball_ncaab")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SIMS = Number(process.env.MC_SIMS ?? "10000");
const START_GRACE_MINUTES = Number(process.env.MC_START_GRACE_MINUTES ?? "0");

const SIGMA_MARGIN_FLOOR = Number(process.env.SIGMA_MARGIN_FLOOR ?? "8");
const SIGMA_TOTAL_FLOOR = Number(process.env.SIGMA_TOTAL_FLOOR ?? "13.5");

const TOTAL_FALLBACK_MODE = (process.env.TOTAL_FALLBACK_MODE || "avg_total_points") as
  | "avg_total_points"
  | "pf_pa_blend";

const WRITE_TRACE = (process.env.MC_WRITE_TRACE ?? "true").toLowerCase() === "true";

const MARGIN_HOME_WIN_NEGATIVE =
  (process.env.MARGIN_HOME_WIN_NEGATIVE ?? "true").toLowerCase() === "true";

const EPS = Number(process.env.MC_PUSH_EPS ?? "1e-9");

const SHARP_BOOKS = (process.env.EV_SHARP_BOOKS || "pinnacle,betonlineag,betonline")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const SOFT_BOOKS = (process.env.EV_SOFT_BOOKS || "draftkings,fanduel,betmgm")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const QUANTUM_SHARP_WEIGHT = Number(process.env.QUANTUM_SHARP_WEIGHT ?? "0.5");
const QUANTUM_MC_WEIGHT = Number(process.env.QUANTUM_MC_WEIGHT ?? "0.5");
const KELLY_MULTIPLIER = Number(process.env.KELLY_MULTIPLIER ?? "0.25");

const LINE_TOL = Number(process.env.LINE_TOL ?? "1e-6");
const MIN_EV_PCT = Number(process.env.MIN_EV_PCT ?? "0");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

/* =========================================================
   MAIN
========================================================= */

async function main() {
  if (!SPORT_KEYS.length) {
    throw new Error("[MC] SPORT_KEYS is empty.");
  }

  const now = new Date();
  const graceMs = START_GRACE_MINUTES * 60 * 1000;
  const startCutoff = new Date(now.getTime() - graceMs);

  console.log(
    `[MC+EV] sports=${SPORT_KEYS.join(",")} sims=${SIMS} startGraceMin=${START_GRACE_MINUTES}`
  );

  for (const sportKey of SPORT_KEYS) {
    await runForSport(sportKey, startCutoff);
  }
}

async function runForSport(sportKey: string, startCutoff: Date) {
  console.log(
    `\n[MC+EV] >>> SPORT=${sportKey} sims=${SIMS} marginHomeWinNegative=${MARGIN_HOME_WIN_NEGATIVE}`
  );

  // 1) Future events for this sport
  const events = await fetchFutureEvents(startCutoff, sportKey);
  if (!events.length) {
    console.log(`[MC] (${sportKey}) No future events found. Done.`);
    return;
  }

  const eventIds = events.map((e) => e.event_id);

  // 2) Snapshot: clear MC results for these events
  await clearMonteCarloResultsForEvents(eventIds);

  // 3) Consensus lines from odds_snapshot
  const lineMap = await fetchConsensusLinesFromOddsSnapshot(eventIds);

  // 4) Ratings
  const teamSet = new Set<string>();
  for (const e of events) {
    if (e.canon_home_team) teamSet.add(e.canon_home_team);
    if (e.canon_away_team) teamSet.add(e.canon_away_team);
  }

  const ratings = await fetchTeamRatings([...teamSet]);
  const ratingMap = new Map<string, TeamRatingRow>();
  for (const r of ratings) ratingMap.set(r.canonical, r);

  // 5) Create run
  const runId = await createMonteCarloRun({
    sport_key: sportKey,
    config: {
      sims: SIMS,
      sigma_margin_floor: SIGMA_MARGIN_FLOOR,
      sigma_total_floor: SIGMA_TOTAL_FLOOR,
      total_fallback_mode: TOTAL_FALLBACK_MODE,
      margin_home_win_negative: MARGIN_HOME_WIN_NEGATIVE,
      push_eps: EPS,
      start_grace_minutes: START_GRACE_MINUTES,
      line_source: "consensus(avg latest-per-book from odds_snapshot)",
      generated_at: new Date().toISOString(),

      quantum_sharp_weight: QUANTUM_SHARP_WEIGHT,
      quantum_mc_weight: QUANTUM_MC_WEIGHT,
      kelly_multiplier: KELLY_MULTIPLIER,

      ev_soft_books: SOFT_BOOKS,
      ev_sharp_books: SHARP_BOOKS,

      min_ev_pct: MIN_EV_PCT,
      line_tol: LINE_TOL,
    },
  });

  // 6) Simulate
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

    const spreadLineHome = lineMap.get(`${e.event_id}|spreads|home`) ?? null;
    const totalLine = lineMap.get(`${e.event_id}|totals|over`) ?? null;

    const sim = simulateGameWithProbs(SIMS, input, {
      spreadLineHome,
      totalLine,
      eps: EPS,
      marginHomeWinNegativeStore: MARGIN_HOME_WIN_NEGATIVE,
    });

    const homePts = (sim.projectedTotal / 2) + (sim.projectedMarginHome_model / 2);
    const awayPts = sim.projectedTotal - homePts;

    const trace = WRITE_TRACE
      ? {
          sport_key: sportKey,
          home,
          away,

          home_engine_power: num(homeR.engine_power, 0),
          away_engine_power: num(awayR.engine_power, 0),
          home_true_hca: num(homeR.true_hca, 0),

          margin_mean_model_home_minus_away: input.marginMean,
          total_mean: input.totalMean,
          sigma_margin_game: input.sigmaMarginGame,
          sigma_total_game: input.sigmaTotalGame,

          spread_line_home_consensus: spreadLineHome,
          total_line_consensus: totalLine,

          sims: SIMS,
          stored_margin_convention: MARGIN_HOME_WIN_NEGATIVE
            ? "negative_means_home_better"
            : "positive_means_home_better",
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
    console.log(`[MC] (${sportKey}) Skipped ${skipped.length} events (showing up to 25):`);
    for (const s of skipped.slice(0, 25)) console.log(`  - ${s.event_id}: ${s.reason}`);
    if (skipped.length > 25) console.log(`  ...and ${skipped.length - 25} more`);
  }

  if (!results.length) {
    console.log(`[MC] (${sportKey}) No results to upsert. Done.`);
    return;
  }

  await upsertMonteCarloResults(results);
  console.log(`[MC] (${sportKey}) Upserted ${results.length} rows (run_id=${runId}).`);

  // 7) EV snapshot per sport (Option A)
  await rebuildEvPlaysForSport(sportKey, runId, results, eventIds);
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

  // Clear ONLY this sport
  await clearEvPlaysForSport(sportKey);

  const oddsRows = await fetchOddsSnapshotForEvents(eventIds);

  // Latest per (event,market,side,book)
  const latest = indexLatestOddsPerBook(oddsRows);

  const inserts: EvPlayInsert[] = [];

  for (const mc of mcRows) {
    const eid = mc.event_id;

    const homeTeam = mc.home_team ?? null;
    const awayTeam = mc.away_team ?? null;

    const markets: MarketKey[] = ["h2h", "spreads", "totals"];

    for (const market of markets) {
      const sides: SideKey[] =
        market === "h2h"
          ? ["home", "away"]
          : market === "spreads"
            ? ["home", "away"]
            : ["over", "under"];

      // Reference line for strict alignment (from MC consensus lines)
      const refLine =
        market === "spreads"
          ? mc.spread_line_home
          : market === "totals"
            ? mc.total_line
            : null;

      for (const side of sides) {
        const mcProb = getMcProbForMarket(mc, market, side);
        if (mcProb == null) continue;

        const sharp = getSharpNoVigProb(latest, eid, market, side, refLine);
        if (!sharp) continue;

        const quantumProb = clamp01(
          QUANTUM_SHARP_WEIGHT * sharp.prob + QUANTUM_MC_WEIGHT * mcProb
        );
        const quantumOdds = probToAmericanOdds(quantumProb);

        for (const book of SOFT_BOOKS) {
          const offer = getOffer(latest, eid, market, side, book);
          if (!offer) continue;

          const bookOdds = toNullNum(offer.odds);
          if (bookOdds == null) continue;

          // Strict line alignment for spreads/totals
          if (market === "spreads" || market === "totals") {
            if (refLine == null) continue;

            const offerLine = toNullNum(offer.line);
            if (offerLine == null) continue;

            const expected =
              market === "spreads"
                ? (side === "home" ? refLine : -refLine)
                : refLine;

            if (!nearlyEqual(offerLine, expected, LINE_TOL)) continue;
          }

          const ev = evPct(quantumProb, bookOdds);
          if (!(ev > MIN_EV_PCT)) continue;

          const rawKelly = kellyFraction(quantumProb, bookOdds);
          const betFraction = rawKelly * KELLY_MULTIPLIER;

          const confidenceScore = computeConfidenceScore(ev, quantumProb, sharp.prob, mcProb);
          const tier = confidenceTier(confidenceScore);

          const team =
            market === "totals"
              ? (homeTeam && awayTeam ? `${awayTeam} vs ${homeTeam}` : mc.matchup ?? null)
              : (side === "home" ? homeTeam : awayTeam);

          inserts.push({
            sport_key: sportKey, // ✅ NEW
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
    .select(
      "event_id,sport_key,commence_time,api_home_team,api_away_team,canon_home_team,canon_away_team,matchup"
    )
    .eq("sport_key", sportKey)
    .gte("commence_time", startCutoff.toISOString())
    .order("commence_time", { ascending: true });

  if (error) throw new Error(`[MC] Failed to fetch events (${sportKey}): ${error.message}`);

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
    const c = canonicals.slice(i, i + chunkSize);

    const { data, error } = await supabase
      .from("team_ratings")
      .select(
        "canonical,engine_power,true_hca,pf_points,pa_points,avg_total_points,sigma_margin_100,sigma_total_100"
      )
      .in("canonical", c);

    if (error) throw new Error(`[MC] Failed to fetch team_ratings: ${error.message}`);
    out.push(...((data ?? []) as TeamRatingRow[]));
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
    if (m.has(k)) continue;
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

  // latest per (event,market,side,book)
  const latestPerBook = new Map<string, number>();

  for (const r of (data ?? []) as OddsSnapshotRow[]) {
    const lineNum = Number(r.line);
    if (!Number.isFinite(lineNum)) continue;

    const k = `${r.event_id}|${r.market}|${r.side}|${String(r.bookmaker || "").toLowerCase()}`;
    if (latestPerBook.has(k)) continue;
    latestPerBook.set(k, lineNum);
  }

  // avg across books -> consensus per (event,market,side)
  const buckets = new Map<string, number[]>();
  for (const [k, line] of latestPerBook.entries()) {
    const [eid, mkt, side] = k.split("|");
    const k2 = `${eid}|${mkt}|${side}`;
    const arr = buckets.get(k2) ?? [];
    arr.push(line);
    buckets.set(k2, arr);
  }

  for (const [k2, arr] of buckets.entries()) {
    out.set(k2, mean(arr));
  }

  // repairs
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
  const { data, error } = await supabase
    .from("monte_carlo_runs")
    .insert(payload)
    .select("id")
    .single();

  if (error) throw new Error(`[MC] Failed to insert monte_carlo_runs: ${error.message}`);
  if (!data?.id) throw new Error("[MC] Failed to create monte_carlo_runs row (no id).");
  return data.id as string;
}

async function clearMonteCarloResultsForEvents(eventIds: string[]) {
  if (!eventIds.length) return;

  const chunkSize = 500;
  for (let i = 0; i < eventIds.length; i += chunkSize) {
    const batch = eventIds.slice(i, i + chunkSize);
    const { error } = await supabase.from("monte_carlo_results").delete().in("event_id", batch);
    if (error) throw new Error(`[MC] Failed to clear monte_carlo_results: ${error.message}`);
  }
}

async function upsertMonteCarloResults(rows: MonteCarloResultUpsert[]) {
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const batch = rows.slice(i, i + chunkSize);
    const { error } = await supabase
      .from("monte_carlo_results")
      .upsert(batch, { onConflict: "run_id,event_id" });
    if (error) throw new Error(`[MC] Failed to upsert monte_carlo_results: ${error.message}`);
  }
}

async function clearEvPlaysForSport(sportKey: string) {
  // Prefer RPC (fast + clean)
  const { error: rpcErr } = await supabase.rpc("clear_ev_plays_for_sport", {
    p_sport_key: sportKey,
  });

  if (!rpcErr) return;

  // Fallback delete if RPC not created
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

    const p1 = americanOddsToProb(ao);
    const p2 = americanOddsToProb(bo);
    const [nv1] = noVigPair(p1, p2);
    probs.push(nv1);
  }

  if (!probs.length) return null;
  return { prob: mean(probs) };
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

/* ---------- Confidence + Kelly ---------- */

function computeConfidenceScore(evPctVal: number, qProb: number, sharpProb: number, mcProb: number) {
  const evScore = clamp(evPctVal * 5, 0, 100);
  const probScore = clamp(Math.abs(qProb - 0.5) * 200, 0, 100);
  const agreementScore = 100 - clamp(Math.abs(sharpProb - mcProb) * 300, 0, 100);
  return 0.45 * evScore + 0.35 * probScore + 0.2 * agreementScore;
}

function confidenceTier(score: number): string {
  if (score >= 85) return "A+";
  if (score >= 75) return "A";
  if (score >= 65) return "B";
  if (score >= 55) return "C";
  return "D";
}

/* ---------- Odds math ---------- */

function americanOddsToProb(odds: number): number {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function probToAmericanOdds(p: number): number {
  const pp = clamp01(p);
  if (pp <= 0 || pp >= 1) return 0;
  return pp >= 0.5
    ? Math.round((-100 * pp) / (1 - pp))
    : Math.round((100 * (1 - pp)) / pp);
}

function noVigPair(p1: number, p2: number): [number, number] {
  const s = p1 + p2;
  if (s <= 0) return [p1, p2];
  return [p1 / s, p2 / s];
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
   MODEL
========================================================= */

function buildInputs(home: TeamRatingRow, away: TeamRatingRow) {
  const homePower = num(home.engine_power, 0);
  const awayPower = num(away.engine_power, 0);
  const homeHca = num(home.true_hca, 0);

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

  return { marginMean, totalMean, sigmaMarginGame, sigmaTotalGame };
}

function simulateGameWithProbs(
  sims: number,
  input: ReturnType<typeof buildInputs>,
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
  return arr.reduce((a, b) => a + b, 0) / arr.length;
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
  let u = 0, v = 0;
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

