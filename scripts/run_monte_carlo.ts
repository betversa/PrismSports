/**
 * scripts/run_monte_carlo.ts — MULTI-SPORT (FULL REWRITE v6.5.0: CONFIDENCE NORMALIZATION vB + OE/DE FROM team_ratings)
 * ------------------------------------------------------------------------------------------------------
 * ✅ Duplicate-safe: single declarations only
 * ✅ Uses public.model_calibration (no fitting on the fly)
 * ✅ Correlated margin+total sims (rho)
 * ✅ SIGN-SAFE margin:
 *      - MODEL space is ALWAYS: +margin = home better
 *      - Calibration margin_scale forced POSITIVE (abs)
 * ✅ Totals anchoring via total_anchor_w:
 *      totalMean = (1-w)*modelTotal + w*(consensus total line)   (only when total line exists)
 * ✅ Robust consensus lines: median of latest-per-book from odds_snapshot, symmetric fills
 * ✅ Rebuilds ev_plays per sport after snapshot write
 *
 * ✅ NCAAB:
 *      - Pace still allowed to prefer ncaab_stats ("possessions-per-game"/aliases) over team_possessions (optional)
 *      - Style modifiers from public.ncaab_stats (eFG%, TO%, ORB%, FTR, 3P rate, avg scoring margin)
 *      - IMPORTANT: OE/DE used for totals are ALWAYS from team_ratings (engine_adj_off/engine_adj_def)
 *
 * ✅ STAT SAFETY:
 *      - ONLY reads: stat_key + home_score + away_score from ncaab_stats (avoids “column does not exist” issues)
 *      - Never uses v_2025/last_3/etc for modeling in this script
 *
 * ✅ CONFIDENCE NORMALIZATION (Option B):
 *      - Confidence is normalized per “market family” (props vs h2h vs spreads vs totals)
 *      - Uses rolling mean/std from last N days of ev_plays (or fallback to current run)
 *      - z-score each component (EV, tail, disagreement), combine, then sigmoid→0–100
 *      - Makes ML/spread/total comparable to props on the same 0–100 scale
 *
 * Tables used:
 *   - events
 *   - team_ratings
 *   - team_possessions
 *   - ncaab_stats            (NCAAB only; style + optional pace)
 *   - odds_snapshot
 *   - monte_carlo_results (snapshot overwrite per sport)
 *   - monte_carlo_runs (history)
 *   - ev_plays (cleared per sport each run, then rebuilt)
 *   - model_calibration
 *
 * Optional (recommended):
 *   - confidence_norm (rolling stats cache per sport + market_family)
 *       columns:
 *         sport_key text
 *         market_family text  ('props'|'h2h'|'spreads'|'totals')
 *         window_days int
 *         n int
 *         mu_ev float8, sd_ev float8
 *         mu_tail float8, sd_tail float8
 *         mu_disagree float8, sd_disagree float8
 *         updated_at timestamptz
 *       PK/unique: (sport_key, market_family)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

/* =========================================================
   UTIL
========================================================= */

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}
function clamp01(x: number) {
  return clamp(x, 0, 1);
}
function round2(x: number) {
  return Math.round(x * 100) / 100;
}
function round3(x: number) {
  return Math.round(x * 1000) / 1000;
}
function mean(arr: number[]) {
  return arr.reduce((s, x) => s + x, 0) / (arr.length || 1);
}
function median(arr: number[]) {
  const xs = arr.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!xs.length) return NaN;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}
function nearlyEqual(a: number, b: number, tol: number) {
  return Math.abs(a - b) <= tol;
}
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
function avgNullable(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return (a + b) / 2;
}
function averageNonNull(arr: Array<number | null | undefined>): number | null {
  const xs = arr.filter((x): x is number => x != null && Number.isFinite(x));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function safeStd(xs: number[], mu: number) {
  if (xs.length < 2) return 0;
  const v = xs.reduce((s, x) => s + (x - mu) * (x - mu), 0) / (xs.length - 1);
  return Math.sqrt(Math.max(0, v));
}
function sigmoid(x: number) {
  // numerically stable-ish for typical ranges
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  } else {
    const z = Math.exp(x);
    return z / (1 + z);
  }
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

  engine_adj_off: number | null;
  engine_adj_def: number | null;

  engine_power: number | null;

  pf_points: number | null;
  pa_points: number | null;
  avg_total_points: number | null;

  true_hca: number | null;

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

type StatRow = {
  sport_key: string;
  season: string;
  canonical: string;
  stat_key: string;
  home_score: number | null;
  away_score: number | null;
  updated_at: string;
};

type ModelCalibrationRow = {
  sport_key: string;
  window_days: number;
  min_sample: number;
  n_games: number;

  margin_scale: number;
  margin_intercept: number;
  hca_scale: number;

  sigma_margin_mult: number;
  sigma_total_mult: number;

  total_anchor_w: number;
  rho_margin_total: number;

  updated_at: string;
};

type MarketFamily = "props" | "h2h" | "spreads" | "totals";

type ConfidenceNormRow = {
  sport_key: string;
  market_family: MarketFamily;
  window_days: number;
  n: number;

  mu_ev: number;
  sd_ev: number;

  mu_tail: number;
  sd_tail: number;

  mu_disagree: number;
  sd_disagree: number;

  updated_at: string;
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
const WRITE_TRACE = (process.env.MC_WRITE_TRACE ?? "true").toLowerCase() === "true";

// Storage convention
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

const SIGMA_MARGIN_FLOOR_GAME = Number(process.env.SIGMA_MARGIN_FLOOR ?? "8");
const SIGMA_TOTAL_FLOOR_GAME = Number(process.env.SIGMA_TOTAL_FLOOR ?? "13.5");

const DEVIG_DIFF_SWITCH = Number(process.env.DEVIG_DIFF_SWITCH ?? "0.10");

const TAIL_SHARP_W_MIN = Number(process.env.TAIL_SHARP_W_MIN ?? "0.80");
const TAIL_SHARP_W_MAX = Number(process.env.TAIL_SHARP_W_MAX ?? "0.95");

const TAIL_GUARD_ENABLED = (process.env.TAIL_GUARD_ENABLED ?? "true").toLowerCase() === "true";
const TAIL_GUARD_LONG_ODDS = Number(process.env.TAIL_GUARD_LONG_ODDS ?? "350");
const TAIL_GUARD_MAX_GAP = Number(process.env.TAIL_GUARD_MAX_GAP ?? "0.06");

const PACE_W_2025 = Number(process.env.PACE_W_2025 ?? "0.60");
const PACE_W_LAST3 = Number(process.env.PACE_W_LAST3 ?? "0.20");
const PACE_W_LAST1 = Number(process.env.PACE_W_LAST1 ?? "0.10");
const PACE_W_SPLIT = Number(process.env.PACE_W_SPLIT ?? "0.10");

const TOTAL_W_OFFDEF_PACE = Number(process.env.TOTAL_W_OFFDEF_PACE ?? "0.40");
const TOTAL_W_PFPA = Number(process.env.TOTAL_W_PFPA ?? "0.10");
const TOTAL_W_AVG_TOTAL = Number(process.env.TOTAL_W_AVG_TOTAL ?? "0.50");

const PTS_BLEND_WEIGHT_OFF = Number(process.env.PTS_BLEND_WEIGHT_OFF ?? "0.50");
const PTS_BLEND_WEIGHT_DEF = 1 - PTS_BLEND_WEIGHT_OFF;

const RHO_MT_DEFAULT = clamp(Number(process.env.MC_RHO_MT ?? "0.18"), -0.75, 0.75);

const MARGIN_INTERCEPT_DEFAULT = Number(process.env.MC_MARGIN_ALPHA ?? "0");
const MARGIN_SCALE_DEFAULT = Number(process.env.MC_MARGIN_BETA ?? "1.00");
const HCA_SCALE_DEFAULT = Number(process.env.MC_MARGIN_HCA_BETA ?? "1.00");

const SIGMA_MARGIN_MULT_DEFAULT = Number(process.env.MC_SIGMA_MARGIN_MULT ?? "1.00");
const SIGMA_TOTAL_MULT_DEFAULT = Number(process.env.MC_SIGMA_TOTAL_MULT ?? "1.00");

const TOTAL_ANCHOR_W_DEFAULT = clamp(Number(process.env.MC_TOTAL_ANCHOR_W ?? "0.00"), 0, 0.85);

/**
 * NCAAB style knobs (all are intentionally small + clamped)
 */
const NCAAB_MARGIN_BUMP_W = clamp(Number(process.env.NCAAB_MARGIN_BUMP_W ?? "0.15"), 0, 0.5);
const NCAAB_MARGIN_BUMP_CLAMP = Number(process.env.NCAAB_MARGIN_BUMP_CLAMP ?? "3");

const NCAAB_STYLE_TOTAL_ADD_CLAMP = Number(process.env.NCAAB_STYLE_TOTAL_ADD_CLAMP ?? "6");
const NCAAB_STYLE_SIGMA_MULT_MIN = Number(process.env.NCAAB_STYLE_SIGMA_MULT_MIN ?? "0.92");
const NCAAB_STYLE_SIGMA_MULT_MAX = Number(process.env.NCAAB_STYLE_SIGMA_MULT_MAX ?? "1.15");
const NCAAB_STYLE_PACE_MULT_MIN = Number(process.env.NCAAB_STYLE_PACE_MULT_MIN ?? "0.93");
const NCAAB_STYLE_PACE_MULT_MAX = Number(process.env.NCAAB_STYLE_PACE_MULT_MAX ?? "1.07");

// Baselines (used only for SMALL deltas)
const NCAAB_BASE_EFG = Number(process.env.NCAAB_BASE_EFG ?? "0.50");
const NCAAB_BASE_TOV = Number(process.env.NCAAB_BASE_TOV ?? "0.18");
const NCAAB_BASE_ORB = Number(process.env.NCAAB_BASE_ORB ?? "0.30");
const NCAAB_BASE_FTR = Number(process.env.NCAAB_BASE_FTR ?? "0.30");
const NCAAB_BASE_3PR = Number(process.env.NCAAB_BASE_3PR ?? "0.38");

// Scales
const NCAAB_EFG_TOTAL_SCALE = Number(process.env.NCAAB_EFG_TOTAL_SCALE ?? "40");
const NCAAB_FTR_TOTAL_SCALE = Number(process.env.NCAAB_FTR_TOTAL_SCALE ?? "12");
const NCAAB_ORB_TOTAL_SCALE = Number(process.env.NCAAB_ORB_TOTAL_SCALE ?? "10");
const NCAAB_TOV_PACE_SCALE = Number(process.env.NCAAB_TOV_PACE_SCALE ?? "0.30");
const NCAAB_3PR_SIGMA_SCALE = Number(process.env.NCAAB_3PR_SIGMA_SCALE ?? "0.35");
const NCAAB_TOV_MARGIN_SCALE = Number(process.env.NCAAB_TOV_MARGIN_SCALE ?? "18");

/**
 * Confidence normalization window
 */
const CONF_NORM_WINDOW_DAYS = Number(process.env.CONF_NORM_WINDOW_DAYS ?? "30");
const CONF_MIN_SD = Number(process.env.CONF_MIN_SD ?? "1e-6");
// optional shaping: divide score_raw by this to reduce saturation; 1.0–1.5 typical
const CONF_SIGMOID_TEMP = Number(process.env.CONF_SIGMOID_TEMP ?? "1.25");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

/* =========================================================
   MODEL_CALIBRATION
========================================================= */

type EffectiveCalibration = {
  margin_intercept: number;
  margin_scale: number;
  hca_scale: number;

  sigma_margin_mult: number;
  sigma_total_mult: number;

  total_anchor_w: number;
  rho_margin_total: number;

  window_days: number;
  min_sample: number;
  n_games: number;
  updated_at: string;

  __not_ready?: true;
};

function calibrationIsReady(row: ModelCalibrationRow | EffectiveCalibration | null): boolean {
  if (!row) return false;
  const n = Number((row as any).n_games);
  const min = Number((row as any).min_sample);
  if (!Number.isFinite(n) || !Number.isFinite(min)) return false;
  return n >= min;
}

async function fetchModelCalibrationForSport(sportKey: string): Promise<EffectiveCalibration | null> {
  const { data, error } = await supabase
    .from("model_calibration")
    .select(
      "sport_key,window_days,min_sample,n_games,margin_scale,margin_intercept,hca_scale,sigma_margin_mult,sigma_total_mult,total_anchor_w,rho_margin_total,updated_at"
    )
    .eq("sport_key", sportKey)
    .limit(1);

  if (error) {
    console.warn(`[CALIB] (${sportKey}) model_calibration not available: ${error.message}`);
    return null;
  }
  const row = (data ?? [])[0] as any as ModelCalibrationRow | undefined;
  if (!row) {
    console.warn(`[CALIB] (${sportKey}) model_calibration row missing. Using defaults.`);
    return null;
  }

  const ready = calibrationIsReady(row);

  const eff: EffectiveCalibration = {
    margin_intercept: num((row as any).margin_intercept, MARGIN_INTERCEPT_DEFAULT),
    margin_scale: num((row as any).margin_scale, MARGIN_SCALE_DEFAULT),
    hca_scale: num((row as any).hca_scale, HCA_SCALE_DEFAULT),

    sigma_margin_mult: clamp(num((row as any).sigma_margin_mult, SIGMA_MARGIN_MULT_DEFAULT), 0.25, 3.0),
    sigma_total_mult: clamp(num((row as any).sigma_total_mult, SIGMA_TOTAL_MULT_DEFAULT), 0.25, 3.0),

    total_anchor_w: clamp(num((row as any).total_anchor_w, TOTAL_ANCHOR_W_DEFAULT), 0, 0.85),
    rho_margin_total: clamp(num((row as any).rho_margin_total, RHO_MT_DEFAULT), -0.75, 0.75),

    window_days: num((row as any).window_days, 60),
    min_sample: num((row as any).min_sample, 80),
    n_games: num((row as any).n_games, 0),
    updated_at: String((row as any).updated_at || ""),
  };

  if (!ready) {
    console.warn(
      `[CALIB] (${sportKey}) NOT READY n_games=${eff.n_games} < min_sample=${eff.min_sample}. Using defaults (keeping row for trace).`
    );
    return { ...eff, __not_ready: true };
  }

  console.log(
    `[CALIB] (${sportKey}) READY n_games=${eff.n_games} margin(i=${round3(eff.margin_intercept)}, scale=${round3(
      eff.margin_scale
    )}, hca=${round3(eff.hca_scale)}) sigma(mult_m=${round3(eff.sigma_margin_mult)}, mult_t=${round3(
      eff.sigma_total_mult
    )}) total_anchor_w=${round3(eff.total_anchor_w)} rho=${round3(eff.rho_margin_total)}`
  );

  return eff;
}

/* =========================================================
   RUN CONFIG
========================================================= */

function paceClampForSport(sportKey: string): { lo: number; hi: number } {
  if (sportKey === "basketball_nba") return { lo: 85, hi: 110 };
  return { lo: 60, hi: 80 };
}

function buildRunConfig(sportKey: string, calib: EffectiveCalibration | null) {
  const ready = calib ? calibrationIsReady(calib) && !calib.__not_ready : false;

  return {
    sport_key: sportKey,
    season: SEASON,
    poss_season: POSS_SEASON,
    sims: SIMS,
    start_grace_minutes: START_GRACE_MINUTES,
    push_eps: EPS,
    write_trace: WRITE_TRACE,

    margin_conventions: {
      model: "positive_means_home_better",
      stored: MARGIN_HOME_WIN_NEGATIVE ? "negative_means_home_better" : "positive_means_home_better",
    },

    calibration: {
      source: "model_calibration",
      ready,
      row: calib
        ? {
            window_days: calib.window_days,
            min_sample: calib.min_sample,
            n_games: calib.n_games,
            updated_at: calib.updated_at,
            margin_intercept: calib.margin_intercept,
            margin_scale: calib.margin_scale,
            hca_scale: calib.hca_scale,
            sigma_margin_mult: calib.sigma_margin_mult,
            sigma_total_mult: calib.sigma_total_mult,
            total_anchor_w: calib.total_anchor_w,
            rho_margin_total: calib.rho_margin_total,
            __not_ready: calib.__not_ready ?? false,
          }
        : null,
      defaults: {
        margin_intercept: MARGIN_INTERCEPT_DEFAULT,
        margin_scale: MARGIN_SCALE_DEFAULT,
        hca_scale: HCA_SCALE_DEFAULT,
        sigma_margin_mult: SIGMA_MARGIN_MULT_DEFAULT,
        sigma_total_mult: SIGMA_TOTAL_MULT_DEFAULT,
        total_anchor_w: TOTAL_ANCHOR_W_DEFAULT,
        rho: RHO_MT_DEFAULT,
      },
    },

    ncaab_stats:
      sportKey === "basketball_ncaab"
        ? {
            enabled: true,
            style_keys: [
              "possessions-per-game",
              "effective-field-goal-pct",
              "turnover-pct",
              "offensive-rebounding-pct",
              "free-throw-rate",
              "three-point-rate",
              "average-scoring-margin",
            ],
            note: "Uses stat_key + home_score/away_score ONLY. OE/DE come from team_ratings.",
          }
        : { enabled: false },

    pace_weights: { w_2025: PACE_W_2025, w_last3: PACE_W_LAST3, w_last1: PACE_W_LAST1, w_split: PACE_W_SPLIT },
    pace_clamp: paceClampForSport(sportKey),

    totals_defaults: {
      w_offdef_pace: TOTAL_W_OFFDEF_PACE,
      w_pfpa: TOTAL_W_PFPA,
      w_avg_total: TOTAL_W_AVG_TOTAL,
      offdef_blend: { w_off: PTS_BLEND_WEIGHT_OFF, w_def: PTS_BLEND_WEIGHT_DEF },
    },

    confidence_norm: {
      mode: "zscore+sigmoid",
      window_days: CONF_NORM_WINDOW_DAYS,
      sigmoid_temp: CONF_SIGMOID_TEMP,
      note: "Normalizes EV/tail/disagreement per market family to align games with props.",
    },

    line_source: "consensus(median latest-per-book from odds_snapshot)",
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

    sigma_floors: { margin_game: SIGMA_MARGIN_FLOOR_GAME, total_game: SIGMA_TOTAL_FLOOR_GAME },
    min_ev_pct: MIN_EV_PCT,
    line_tol: LINE_TOL,
  };
}

/* =========================================================
   POSSESSIONS
========================================================= */

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

/* =========================================================
   NCAAB_STATS helpers + style model
========================================================= */

type TeamStatIndex = Map<string, Map<string, StatRow>>;

function buildTeamStatIndex(rows: StatRow[]): TeamStatIndex {
  const idx: TeamStatIndex = new Map();
  for (const r of rows) {
    const team = String(r.canonical || "").trim();
    const key = String(r.stat_key || "").trim().toLowerCase();
    if (!team || !key) continue;
    const m = idx.get(team) ?? new Map<string, StatRow>();
    m.set(key, r);
    idx.set(team, m);
  }
  return idx;
}

function getTeamStatSplit(idx: TeamStatIndex, canonical: string, statKey: string) {
  const m = idx.get(canonical);
  if (!m) return { home: null as number | null, away: null as number | null, found_key: null as string | null };
  const row = m.get(statKey.toLowerCase());
  if (!row) return { home: null, away: null, found_key: null };
  return { home: toNullNum(row.home_score), away: toNullNum(row.away_score), found_key: statKey.toLowerCase() };
}

function getTeamStatSplitAliases(idx: TeamStatIndex, canonical: string, keys: string[]) {
  for (const k of keys) {
    const v = getTeamStatSplit(idx, canonical, k);
    if (v.home != null || v.away != null) return { ...v, used_alias: k };
  }
  return {
    home: null as number | null,
    away: null as number | null,
    found_key: null as string | null,
    used_alias: null as string | null,
  };
}

function preferNcaabStatPace(
  sportKey: string,
  idx: TeamStatIndex | null,
  homeCanon: string,
  awayCanon: string,
  paceHomeFromPoss: number | null,
  paceAwayFromPoss: number | null
) {
  let paceHome = paceHomeFromPoss;
  let paceAway = paceAwayFromPoss;

  if (sportKey === "basketball_ncaab" && idx) {
    const h = getTeamStatSplitAliases(idx, homeCanon, ["possessions-per-game", "pace", "adjusted-tempo"]);
    const a = getTeamStatSplitAliases(idx, awayCanon, ["possessions-per-game", "pace", "adjusted-tempo"]);
    paceHome = h.home ?? paceHome;
    paceAway = a.away ?? paceAway;
  }

  return { paceHome, paceAway };
}

function computeNcaabMarginBump(idx: TeamStatIndex | null, homeCanon: string, awayCanon: string) {
  if (!idx) return 0;

  const h = getTeamStatSplitAliases(idx, homeCanon, ["average-scoring-margin", "scoring-margin"]);
  const a = getTeamStatSplitAliases(idx, awayCanon, ["average-scoring-margin", "scoring-margin"]);

  const hSm = h.home;
  const aSm = a.away;
  if (hSm == null || aSm == null) return 0;

  const raw = (hSm - aSm) * NCAAB_MARGIN_BUMP_W;
  return clamp(raw, -NCAAB_MARGIN_BUMP_CLAMP, NCAAB_MARGIN_BUMP_CLAMP);
}

type NcaabStyle = {
  paceMult: number;
  totalAdd: number;
  sigmaMultStyle: number;
  marginAdd: number;
  used: {
    efg?: { home: number | null; away: number | null; avg: number | null; alias: string | null };
    tov?: { home: number | null; away: number | null; avg: number | null; alias: string | null };
    orb?: { home: number | null; away: number | null; avg: number | null; alias: string | null };
    ftr?: { home: number | null; away: number | null; avg: number | null; alias: string | null };
    three?: { home: number | null; away: number | null; avg: number | null; alias: string | null };
  };
};

function computeNcaabStyleModifiers(idx: TeamStatIndex | null, homeCanon: string, awayCanon: string): NcaabStyle {
  const base: NcaabStyle = { paceMult: 1, totalAdd: 0, sigmaMultStyle: 1, marginAdd: 0, used: {} };
  if (!idx) return base;

  const efgKeys = ["effective-field-goal-pct", "efg-pct", "effective-fg-pct"];
  const tovKeys = ["turnover-pct", "turnovers-per-possession", "turnover-rate"];
  const orbKeys = ["offensive-rebounding-pct", "off-reb-pct", "offensive-rebound-pct"];
  const ftrKeys = ["free-throw-rate", "ft-rate", "free-throw-rate-ftr"];
  const threeKeys = ["three-point-rate", "3pt-rate", "three-pt-rate", "3p-rate"];

  const hEfg = getTeamStatSplitAliases(idx, homeCanon, efgKeys);
  const aEfg = getTeamStatSplitAliases(idx, awayCanon, efgKeys);

  const hTov = getTeamStatSplitAliases(idx, homeCanon, tovKeys);
  const aTov = getTeamStatSplitAliases(idx, awayCanon, tovKeys);

  const hOrb = getTeamStatSplitAliases(idx, homeCanon, orbKeys);
  const aOrb = getTeamStatSplitAliases(idx, awayCanon, orbKeys);

  const hFtr = getTeamStatSplitAliases(idx, homeCanon, ftrKeys);
  const aFtr = getTeamStatSplitAliases(idx, awayCanon, ftrKeys);

  const h3 = getTeamStatSplitAliases(idx, homeCanon, threeKeys);
  const a3 = getTeamStatSplitAliases(idx, awayCanon, threeKeys);

  const efgHome = hEfg.home;
  const efgAway = aEfg.away;
  const efgAvg = averageNonNull([efgHome, efgAway]);

  const tovHome = hTov.home;
  const tovAway = aTov.away;
  const tovAvg = averageNonNull([tovHome, tovAway]);

  const orbHome = hOrb.home;
  const orbAway = aOrb.away;
  const orbAvg = averageNonNull([orbHome, orbAway]);

  const ftrHome = hFtr.home;
  const ftrAway = aFtr.away;
  const ftrAvg = averageNonNull([ftrHome, ftrAway]);

  const threeHome = h3.home;
  const threeAway = a3.away;
  const threeAvg = averageNonNull([threeHome, threeAway]);

  if (tovAvg != null) {
    const raw = 1 - (tovAvg - NCAAB_BASE_TOV) * NCAAB_TOV_PACE_SCALE;
    base.paceMult = clamp(raw, NCAAB_STYLE_PACE_MULT_MIN, NCAAB_STYLE_PACE_MULT_MAX);
  }

  let totalAdd = 0;
  if (efgAvg != null) totalAdd += (efgAvg - NCAAB_BASE_EFG) * NCAAB_EFG_TOTAL_SCALE;
  if (ftrAvg != null) totalAdd += (ftrAvg - NCAAB_BASE_FTR) * NCAAB_FTR_TOTAL_SCALE;
  if (orbAvg != null) totalAdd += (orbAvg - NCAAB_BASE_ORB) * NCAAB_ORB_TOTAL_SCALE;
  if (threeAvg != null) totalAdd += (threeAvg - NCAAB_BASE_3PR) * 6;
  base.totalAdd = clamp(totalAdd, -NCAAB_STYLE_TOTAL_ADD_CLAMP, NCAAB_STYLE_TOTAL_ADD_CLAMP);

  let sigmaMult = 1;
  if (threeAvg != null) sigmaMult *= 1 + (threeAvg - NCAAB_BASE_3PR) * NCAAB_3PR_SIGMA_SCALE;
  if (orbAvg != null) sigmaMult *= 1 + (orbAvg - NCAAB_BASE_ORB) * 0.15;
  base.sigmaMultStyle = clamp(sigmaMult, NCAAB_STYLE_SIGMA_MULT_MIN, NCAAB_STYLE_SIGMA_MULT_MAX);

  if (tovHome != null && tovAway != null) {
    base.marginAdd = clamp((tovAway - tovHome) * NCAAB_TOV_MARGIN_SCALE, -2.5, 2.5);
  }

  base.used.efg = { home: efgHome, away: efgAway, avg: efgAvg, alias: (hEfg.used_alias || aEfg.used_alias || null) };
  base.used.tov = { home: tovHome, away: tovAway, avg: tovAvg, alias: (hTov.used_alias || aTov.used_alias || null) };
  base.used.orb = { home: orbHome, away: orbAway, avg: orbAvg, alias: (hOrb.used_alias || aOrb.used_alias || null) };
  base.used.ftr = { home: ftrHome, away: ftrAway, avg: ftrAvg, alias: (hFtr.used_alias || aFtr.used_alias || null) };
  base.used.three = { home: threeHome, away: threeAway, avg: threeAvg, alias: (h3.used_alias || a3.used_alias || null) };

  return base;
}

/* =========================================================
   MODEL (calibrated) — SIGN SAFE
========================================================= */

function computeTotalsComponents(args: {
  sportKey: string;
  home: TeamRatingRow;
  away: TeamRatingRow;
  paceGame: number;
}) {
  const { sportKey, home, away, paceGame } = args;
  const paceFactor = paceGame / 100;

  // ✅ OE/DE ALWAYS from team_ratings
  const defFallback = sportKey === "basketball_nba" ? 112 : 100;
  const offFallback = sportKey === "basketball_nba" ? 112 : 100;

  const homeOff100 = num(home.engine_adj_off, offFallback);
  const homeDef100 = num(home.engine_adj_def, defFallback);
  const awayOff100 = num(away.engine_adj_off, offFallback);
  const awayDef100 = num(away.engine_adj_def, defFallback);

  const wOff = clamp01(PTS_BLEND_WEIGHT_OFF);
  const wDef = 1 - wOff;

  const homePts100 = wOff * homeOff100 + wDef * awayDef100;
  const awayPts100 = wOff * awayOff100 + wDef * homeDef100;

  const homePts_offdef = homePts100 * paceFactor;
  const awayPts_offdef = awayPts100 * paceFactor;
  const total_offdef_pace = Math.max(0, homePts_offdef + awayPts_offdef);

  const homePF = toNullNum(home.pf_points);
  const homePA = toNullNum(home.pa_points);
  const awayPF = toNullNum(away.pf_points);
  const awayPA = toNullNum(away.pa_points);

  const homePts_pfpa = avgNullable(homePF, awayPA);
  const awayPts_pfpa = avgNullable(awayPF, homePA);
  const total_pfpa = homePts_pfpa != null && awayPts_pfpa != null ? Math.max(0, homePts_pfpa + awayPts_pfpa) : null;

  const homeAvgTot = toNullNum(home.avg_total_points);
  const awayAvgTot = toNullNum(away.avg_total_points);
  const total_avg_total = avgNullable(homeAvgTot, awayAvgTot);

  return { total_offdef_pace, total_pfpa, total_avg_total };
}

function blendTotals(args: {
  offdef_pace: number;
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

function buildInputsPaceAware(args: {
  sportKey: string;
  home: TeamRatingRow;
  away: TeamRatingRow;

  paceGameRaw: number;

  consensusTotalLine: number | null;
  calib: EffectiveCalibration | null;

  marginBump: number;
  style: NcaabStyle;
}) {
  const { sportKey, home, away, paceGameRaw, consensusTotalLine, calib, marginBump, style } = args;

  const paceGame = sportKey === "basketball_ncaab" ? paceGameRaw * style.paceMult : paceGameRaw;

  const { lo, hi } = paceClampForSport(sportKey);
  const paceGameClamped = clamp(paceGame, lo, hi);

  const paceFactor = paceGameClamped / 100;
  const ready = calib ? calibrationIsReady(calib) && !calib.__not_ready : false;

  const comps = computeTotalsComponents({ sportKey, home, away, paceGame: paceGameClamped });

  const totalMean_model_base = blendTotals({
    offdef_pace: comps.total_offdef_pace,
    pfpa: comps.total_pfpa,
    avg_total: comps.total_avg_total,
    w_offdef_pace: TOTAL_W_OFFDEF_PACE,
    w_pfpa: TOTAL_W_PFPA,
    w_avg_total: TOTAL_W_AVG_TOTAL,
  });

  const totalMean_model =
    sportKey === "basketball_ncaab" ? Math.max(0, totalMean_model_base + style.totalAdd) : totalMean_model_base;

  const totalAnchorW = ready ? clamp(calib!.total_anchor_w, 0, 0.85) : TOTAL_ANCHOR_W_DEFAULT;
  const totalMean =
    consensusTotalLine != null && Number.isFinite(consensusTotalLine)
      ? Math.max(0, (1 - totalAnchorW) * totalMean_model + totalAnchorW * consensusTotalLine)
      : totalMean_model;

  const homePow = num(home.engine_power, 0);
  const awayPow = num(away.engine_power, 0);
  const hcaPts = num(home.true_hca, 0);
  const powerDiff = homePow - awayPow;

  const marginParams = {
    intercept: ready ? num(calib!.margin_intercept, MARGIN_INTERCEPT_DEFAULT) : MARGIN_INTERCEPT_DEFAULT,
    scale: ready ? num(calib!.margin_scale, MARGIN_SCALE_DEFAULT) : MARGIN_SCALE_DEFAULT,
    hca_scale: ready ? num(calib!.hca_scale, HCA_SCALE_DEFAULT) : HCA_SCALE_DEFAULT,
  };

  const safeScale = Math.abs(marginParams.scale);
  const marginMean_base = marginParams.intercept + safeScale * powerDiff + marginParams.hca_scale * hcaPts;

  const marginMean = sportKey === "basketball_ncaab" ? marginMean_base + marginBump + style.marginAdd : marginMean_base;

  const sigmaMargin100 = avg(num(home.sigma_margin_100, 8), num(away.sigma_margin_100, 8));
  const sigmaTotal100 = avg(num(home.sigma_total_100, 13.5), num(away.sigma_total_100, 13.5));

  const sigmaMarginGame_base = Math.max(SIGMA_MARGIN_FLOOR_GAME, sigmaMargin100 * paceFactor);
  const sigmaTotalGame_base = Math.max(SIGMA_TOTAL_FLOOR_GAME, sigmaTotal100 * paceFactor);

  const sigmaMult = {
    margin: ready ? clamp(num(calib!.sigma_margin_mult, 1), 0.25, 3.0) : SIGMA_MARGIN_MULT_DEFAULT,
    total: ready ? clamp(num(calib!.sigma_total_mult, 1), 0.25, 3.0) : SIGMA_TOTAL_MULT_DEFAULT,
  };

  const sigmaTotalStyleMult = sportKey === "basketball_ncaab" ? style.sigmaMultStyle : 1;

  const sigmaMarginGame = Math.max(SIGMA_MARGIN_FLOOR_GAME, sigmaMarginGame_base * sigmaMult.margin);
  const sigmaTotalGame = Math.max(SIGMA_TOTAL_FLOOR_GAME, sigmaTotalGame_base * sigmaMult.total * sigmaTotalStyleMult);

  const rhoMT = ready ? clamp(num(calib!.rho_margin_total, RHO_MT_DEFAULT), -0.75, 0.75) : RHO_MT_DEFAULT;

  return {
    paceGame_raw: paceGameRaw,
    paceGame_style_mult: sportKey === "basketball_ncaab" ? style.paceMult : 1,
    paceGame_final: paceGameClamped,

    marginMean,
    marginMean_base,
    marginBump,
    marginStyleAdd: sportKey === "basketball_ncaab" ? style.marginAdd : 0,

    totalMean,
    totalMean_model,
    totalMean_model_base,
    totalAnchorW,
    totalStyleAdd: sportKey === "basketball_ncaab" ? style.totalAdd : 0,

    sigmaMarginGame,
    sigmaTotalGame,

    sigmaMarginGame_base,
    sigmaTotalGame_base,
    sigmaMult,
    sigmaTotalStyleMult,

    rhoMT,

    marginParams: { ...marginParams, scale_used_abs: safeScale },

    totalsComponents: {
      ...comps,
      weights: { w_offdef_pace: TOTAL_W_OFFDEF_PACE, w_pfpa: TOTAL_W_PFPA, w_avg_total: TOTAL_W_AVG_TOTAL },
    },

    ncaabStyle: sportKey === "basketball_ncaab" ? style : null,
  };
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
    storeMarginHomeWinNegative: boolean;
    rhoMT: number;
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

  const rho = clamp(opts.rhoMT, -0.75, 0.75);
  const s = Math.sqrt(Math.max(1e-12, 1 - rho * rho));

  for (let i = 0; i < sims; i++) {
    const z1 = randn();
    const z2 = randn();

    const m = input.marginMean + z1 * input.sigmaMarginGame;
    const t = Math.max(0, input.totalMean + (rho * z1 + s * z2) * input.sigmaTotalGame);

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

  const projectedMarginHome_stored = opts.storeMarginHomeWinNegative ? -projectedMarginHome_model : projectedMarginHome_model;

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

async function fetchTeamPossessionsForSportSeason(sportKey: string, season: string, canonicals: string[]): Promise<PossRow[]> {
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

/**
 * ✅ STAT SAFETY: only stat_key + home_score + away_score + updated_at are read.
 */
async function fetchNcaabStatsForSportSeason(sportKey: string, season: string, canonicals: string[]): Promise<StatRow[]> {
  if (!canonicals.length) return [];
  const chunkSize = 300;
  const out: StatRow[] = [];

  for (let i = 0; i < canonicals.length; i += chunkSize) {
    const c = canonicals.slice(i, i + chunkSize);

    const { data, error } = await supabase
      .from("ncaab_stats")
      .select("sport_key,season,canonical,stat_key,home_score,away_score,updated_at")
      .eq("sport_key", sportKey)
      .eq("season", season)
      .in("canonical", c);

    if (error) throw new Error(`[MC] Failed to fetch ncaab_stats (${sportKey}): ${error.message}`);
    out.push(...((data ?? []) as StatRow[]));
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

  for (const [k2, arr] of buckets.entries()) out.set(k2, median(arr));

  for (const id of eventIds) {
    const homeKey = `${id}|spreads|home`;
    const awayKey = `${id}|spreads|away`;
    const overKey = `${id}|totals|over`;
    const underKey = `${id}|totals|under`;

    if (!out.has(homeKey) && out.has(awayKey)) out.set(homeKey, -Number(out.get(awayKey)));
    if (!out.has(awayKey) && out.has(homeKey)) out.set(awayKey, -Number(out.get(homeKey)));
    if (!out.has(overKey) && out.has(underKey)) out.set(overKey, Number(out.get(underKey)));
    if (!out.has(underKey) && out.has(overKey)) out.set(underKey, Number(out.get(overKey)));
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

/**
 * ✅ More resilient clear:
 *   1) try RPC with {p_sport_key}
 *   2) if fails, try RPC with {sport_key}
 *   3) if still fails or missing, fallback delete
 */
async function clearEvPlaysForSport(sportKey: string) {
  const tryRpc = async (args: any) => {
    const { error } = await supabase.rpc("clear_ev_plays_for_sport", args);
    return error ?? null;
  };

  let rpcErr = await tryRpc({ p_sport_key: sportKey });
  if (rpcErr) rpcErr = await tryRpc({ sport_key: sportKey });

  if (!rpcErr) return;

  const code = (rpcErr as any).code;
  const msg = (rpcErr as any).message || "";
  const notFoundish =
    code === "PGRST202" ||
    /schema cache/i.test(msg) ||
    /Could not find the function/i.test(msg) ||
    /function .* does not exist/i.test(msg);

  if (notFoundish) {
    const { error } = await supabase.from("ev_plays").delete().eq("sport_key", sportKey);
    if (error) throw new Error(`[EV] Failed to clear ev_plays fallback: ${error.message}`);
    return;
  }

  console.warn(`[EV] clear_ev_plays_for_sport RPC failed (${code}): ${msg} — falling back to delete`);
  const { error } = await supabase.from("ev_plays").delete().eq("sport_key", sportKey);
  if (error) throw new Error(`[EV] Failed to clear ev_plays fallback: ${error.message}`);
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

function americanOddsToProb(odds: number): number {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

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

function getSharpNoVigProb(
  latest: Map<string, OddsSnapshotRow>,
  eventId: string,
  market: MarketKey,
  side: SideKey,
  refLine: number | null
): { prob: number; sharpProb: number } | null {
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
  const sharpProb = mean(probs);
  return { prob: sharpProb, sharpProb };
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

function tailness(p: number) {
  return clamp(Math.abs(p - 0.5) / 0.5, 0, 1);
}

function marketFamilyFromMarket(market: MarketKey): MarketFamily {
  if (market === "h2h") return "h2h";
  if (market === "spreads") return "spreads";
  return "totals";
}

/* =========================================================
   CONFIDENCE NORMALIZATION (Option B)
========================================================= */

type ConfFeatures = {
  ev_pct: number;          // already % scale
  tail: number;            // 0..1
  disagree: number;        // 0..1-ish
};

type ConfNormParams = {
  mu_ev: number; sd_ev: number;
  mu_tail: number; sd_tail: number;
  mu_disagree: number; sd_disagree: number;
  n: number;
};

function z(x: number, mu: number, sd: number) {
  const s = Math.max(CONF_MIN_SD, sd);
  return (x - mu) / s;
}

/**
 * Combine z-scores into a 0–100 confidence score via sigmoid.
 * - Higher EV is better
 * - Higher tail is better (more “true” probability away from 50/50)
 * - Lower disagreement is better → we invert by negating z_disagree
 */
function computeConfidenceScoreNormalized(
  f: ConfFeatures,
  norm: ConfNormParams
) {
  const zEv = z(f.ev_pct, norm.mu_ev, norm.sd_ev);
  const zTail = z(f.tail, norm.mu_tail, norm.sd_tail);
  const zDis = z(f.disagree, norm.mu_disagree, norm.sd_disagree);

  const scoreRaw = 0.45 * zEv + 0.35 * zTail + 0.20 * (-zDis);

  const s = sigmoid(scoreRaw / Math.max(1e-6, CONF_SIGMOID_TEMP));
  const score = Math.round(100 * s);

  return { score, score_raw: scoreRaw, z_ev: zEv, z_tail: zTail, z_disagree: zDis };
}

function confidenceTier(score: number): string {
  if (score >= 85) return "A+";
  if (score >= 75) return "A";
  if (score >= 65) return "B";
  if (score >= 55) return "C";
  return "D";
}

/**
 * Pull rolling normalization stats from:
 *  1) confidence_norm table (recommended)
 *  2) fallback: compute from last N days of ev_plays
 *  3) fallback: compute from current-run features
 */
async function fetchConfidenceNormParams(
  sportKey: string,
  family: MarketFamily,
  fallbackFromEvPlays: boolean
): Promise<ConfNormParams | null> {
  // Try cached table first (if it exists)
  const { data: cached, error: cachedErr } = await supabase
    .from("confidence_norm")
    .select("sport_key,market_family,window_days,n,mu_ev,sd_ev,mu_tail,sd_tail,mu_disagree,sd_disagree,updated_at")
    .eq("sport_key", sportKey)
    .eq("market_family", family)
    .limit(1);

  if (!cachedErr && cached && cached[0]) {
    const r = cached[0] as any as ConfidenceNormRow;
    return {
      mu_ev: num((r as any).mu_ev, 0),
      sd_ev: Math.max(CONF_MIN_SD, num((r as any).sd_ev, 1)),
      mu_tail: num((r as any).mu_tail, 0.2),
      sd_tail: Math.max(CONF_MIN_SD, num((r as any).sd_tail, 0.1)),
      mu_disagree: num((r as any).mu_disagree, 0.05),
      sd_disagree: Math.max(CONF_MIN_SD, num((r as any).sd_disagree, 0.03)),
      n: num((r as any).n, 0),
    };
  }

  if (!fallbackFromEvPlays) return null;

  // Fallback: compute from last N days of ev_plays (if confidence_norm table isn't present)
  const since = new Date(Date.now() - CONF_NORM_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("ev_plays")
    .select("market,ev_pct,quantum_prob,run_id,event_id")
    .eq("sport_key", sportKey)
    .gte("commence_time", since) // best available without created_at; keeps it “recent slate”
    .limit(5000);

  if (error) {
    console.warn(`[CONF] (${sportKey}) failed to build norm from ev_plays: ${error.message}`);
    return null;
  }

  const xsEv: number[] = [];
  const xsTail: number[] = [];
  // without sharp/mc stored, we can’t rebuild disagreement; fallback to a proxy: tail itself (weak)
  const xsDis: number[] = [];

  for (const r of (data ?? []) as any[]) {
    const m = String(r.market || "").toLowerCase();
    if (m !== family) continue;
    const ev = num(r.ev_pct, NaN);
    const qp = num(r.quantum_prob, NaN);
    if (!Number.isFinite(ev) || !Number.isFinite(qp)) continue;

    xsEv.push(ev);
    xsTail.push(tailness(qp));
    xsDis.push(0.05); // neutral placeholder if we lack sharp/mc; cache table fixes this
  }

  if (xsEv.length < 25) return null;

  const muEv = mean(xsEv);
  const muTail = mean(xsTail);
  const muDis = mean(xsDis);

  return {
    mu_ev: muEv,
    sd_ev: Math.max(CONF_MIN_SD, safeStd(xsEv, muEv)),
    mu_tail: muTail,
    sd_tail: Math.max(CONF_MIN_SD, safeStd(xsTail, muTail)),
    mu_disagree: muDis,
    sd_disagree: Math.max(CONF_MIN_SD, safeStd(xsDis, muDis)),
    n: xsEv.length,
  };
}

async function upsertConfidenceNormRows(
  sportKey: string,
  rows: Array<{ market_family: MarketFamily; norm: ConfNormParams }>
) {
  // If the table doesn't exist, this will error; we swallow it (your pipeline keeps going).
  const payload = rows.map((r) => ({
    sport_key: sportKey,
    market_family: r.market_family,
    window_days: CONF_NORM_WINDOW_DAYS,
    n: r.norm.n,
    mu_ev: r.norm.mu_ev,
    sd_ev: r.norm.sd_ev,
    mu_tail: r.norm.mu_tail,
    sd_tail: r.norm.sd_tail,
    mu_disagree: r.norm.mu_disagree,
    sd_disagree: r.norm.sd_disagree,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from("confidence_norm").upsert(payload, { onConflict: "sport_key,market_family" });
  if (error) {
    const msg = error.message || "";
    const notFoundish = /relation .* does not exist/i.test(msg) || /schema cache/i.test(msg);
    if (!notFoundish) console.warn(`[CONF] upsert confidence_norm failed: ${msg}`);
  }
}

/* =========================================================
   EV PIPELINE
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

  // We build candidate features first, then normalize per-family.
  type Candidate = {
    family: MarketFamily;
    insert: Omit<EvPlayInsert, "confidence_score" | "confidence_tier">;
    features: ConfFeatures;
    // debug
    sharpProb: number;
    mcProb: number;
  };

  const candidates: Candidate[] = [];

  for (const mc of mcRows) {
    const eid = mc.event_id;

    const homeTeam = mc.home_team ?? null;
    const awayTeam = mc.away_team ?? null;

    const markets: MarketKey[] = ["h2h", "spreads", "totals"];

    for (const market of markets) {
      const sides: SideKey[] =
        market === "h2h" ? ["home", "away"] : market === "spreads" ? ["home", "away"] : ["over", "under"];

      const refLine = market === "spreads" ? mc.spread_line_home : market === "totals" ? mc.total_line : null;
      const family = marketFamilyFromMarket(market);

      for (const side of sides) {
        const mcProb = getMcProbForMarket(mc, market, side);
        if (mcProb == null) continue;

        const sharp = getSharpNoVigProb(latest, eid, market, side, refLine);
        if (!sharp) continue;

        const tail = tailness(sharp.prob);
        const wSharp = clamp(
          TAIL_SHARP_W_MIN + (TAIL_SHARP_W_MAX - TAIL_SHARP_W_MIN) * tail,
          TAIL_SHARP_W_MIN,
          TAIL_SHARP_W_MAX
        );
        const wMc = 1 - wSharp;

        // shrink MC towards sharp when tail is high
        const shrink = clamp(0.10 + 0.50 * tail, 0.10, 0.60);
        const mcAdj = clamp01(mcProb * (1 - shrink) + sharp.prob * shrink);

        const quantumProb = clamp01(wSharp * sharp.prob + wMc * mcAdj);
        const quantumOdds = probToAmericanOdds(quantumProb);

        const disagreement = Math.abs(sharp.prob - mcProb); // 0..1

        for (const book of SOFT_BOOKS) {
          const offer = getOffer(latest, eid, market, side, book);
          if (!offer) continue;

          const bookOdds = toNullNum(offer.odds);
          if (bookOdds == null) continue;

          // gate line match for spreads/totals
          if (market === "spreads" || market === "totals") {
            if (refLine == null) continue;

            const offerLine = toNullNum(offer.line);
            if (offerLine == null) continue;

            const expected = market === "spreads" ? (side === "home" ? refLine : -refLine) : refLine;
            if (!nearlyEqual(offerLine, expected, LINE_TOL)) continue;
          }

          // tail guard
          if (TAIL_GUARD_ENABLED) {
            const isLong = bookOdds >= TAIL_GUARD_LONG_ODDS || bookOdds <= -TAIL_GUARD_LONG_ODDS;
            const gap = Math.abs(mcProb - sharp.prob);
            if (isLong && mcProb > sharp.prob && gap > TAIL_GUARD_MAX_GAP) continue;
          }

          const ev = evPct(quantumProb, bookOdds);
          if (!(ev > MIN_EV_PCT)) continue;

          const rawKelly = kellyFraction(quantumProb, bookOdds);
          const betFraction = rawKelly * KELLY_MULTIPLIER;

          const team =
            market === "totals"
              ? homeTeam && awayTeam
                ? `${awayTeam} vs ${homeTeam}`
                : mc.matchup ?? null
              : side === "home"
              ? homeTeam
              : awayTeam;

          candidates.push({
            family,
            features: { ev_pct: ev, tail: tailness(quantumProb), disagree: disagreement },
            sharpProb: sharp.prob,
            mcProb,
            insert: {
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
              kelly_fraction: rawKelly,
              bet_fraction: betFraction,
              // filled after normalization
              confidence_score: 0 as any,
              confidence_tier: "" as any,
            },
          });
        }
      }
    }
  }

  if (!candidates.length) {
    console.log(`[EV] (${sportKey}) No +EV plays found.`);
    return;
  }

  // Build norm params per family:
  const families: MarketFamily[] = ["h2h", "spreads", "totals"]; // this script only builds game plays
  const normMap = new Map<MarketFamily, ConfNormParams>();

  for (const fam of families) {
    // 1) try cached table; 2) fallback to ev_plays; else null
    const fromCacheOrEv = await fetchConfidenceNormParams(sportKey, fam, true);

    if (fromCacheOrEv) {
      normMap.set(fam, fromCacheOrEv);
      continue;
    }

    // fallback: compute from this run’s candidates (per family)
    const xs = candidates.filter((c) => c.family === fam);
    if (xs.length < 10) continue;

    const evs = xs.map((x) => x.features.ev_pct);
    const tails = xs.map((x) => x.features.tail);
    const dis = xs.map((x) => x.features.disagree);

    const muEv = mean(evs);
    const muTail = mean(tails);
    const muDis = mean(dis);

    normMap.set(fam, {
      mu_ev: muEv,
      sd_ev: Math.max(CONF_MIN_SD, safeStd(evs, muEv)),
      mu_tail: muTail,
      sd_tail: Math.max(CONF_MIN_SD, safeStd(tails, muTail)),
      mu_disagree: muDis,
      sd_disagree: Math.max(CONF_MIN_SD, safeStd(dis, muDis)),
      n: xs.length,
    });
  }

  // Optional: upsert cache table (if you create it)
  await upsertConfidenceNormRows(
    sportKey,
    families
      .map((fam) => {
        const n = normMap.get(fam);
        return n ? { market_family: fam, norm: n } : null;
      })
      .filter(Boolean) as any
  );

  // Now score each candidate using the family’s norm:
  const inserts: EvPlayInsert[] = [];
  for (const c of candidates) {
    const norm = normMap.get(c.family);
    const use = norm
      ? norm
      : {
          mu_ev: 0,
          sd_ev: 1,
          mu_tail: 0.2,
          sd_tail: 0.1,
          mu_disagree: 0.05,
          sd_disagree: 0.03,
          n: 0,
        };

    const scored = computeConfidenceScoreNormalized(c.features, use);
    const tier = confidenceTier(scored.score);

    inserts.push({
      ...(c.insert as any),
      confidence_score: scored.score,
      confidence_tier: tier,
    });
  }

  // Insert
  const chunkSize = 1000;
  for (let i = 0; i < inserts.length; i += chunkSize) {
    const batch = inserts.slice(i, i + chunkSize);
    const { error } = await supabase.from("ev_plays").insert(batch);
    if (error) throw new Error(`[EV] (${sportKey}) Failed to insert ev_plays: ${error.message}`);
  }

  console.log(`[EV] (${sportKey}) Inserted ${inserts.length} plays into ev_plays (confidence normalized).`);
}

/* =========================================================
   MAIN
========================================================= */

async function main() {
  if (!SPORT_KEYS.length) throw new Error("[MC] SPORT_KEYS is empty.");

  const now = new Date();
  const graceMs = START_GRACE_MINUTES * 60 * 1000;
  const startCutoff = new Date(now.getTime() - graceMs);

  console.log(
    `[MC+EV] sports=${SPORT_KEYS.join(",")} season=${SEASON} possSeason=${POSS_SEASON} sims=${SIMS} startGraceMin=${START_GRACE_MINUTES} storeMarginHomeWinNegative=${MARGIN_HOME_WIN_NEGATIVE}`
  );

  for (const sportKey of SPORT_KEYS) {
    await runForSport(sportKey, startCutoff);
  }

  console.log(`[MC+EV] Done. sports=${SPORT_KEYS.join(",")}`);
}

async function runForSport(sportKey: string, startCutoff: Date) {
  console.log(`\n[MC+EV] >>> SPORT=${sportKey}`);

  const calib = await fetchModelCalibrationForSport(sportKey);

  const events = await fetchFutureEvents(startCutoff, sportKey);
  if (!events.length) {
    console.log(`[MC] (${sportKey}) No future events found. Done.`);
    return;
  }
  const eventIds = events.map((e) => e.event_id);

  const runId = await createMonteCarloRun({ sport_key: sportKey, config: buildRunConfig(sportKey, calib) });

  await clearMonteCarloResultsForSport(sportKey);

  const lineMap = await fetchConsensusLinesFromOddsSnapshot(eventIds);

  const teamSet = new Set<string>();
  for (const e of events) {
    if (e.canon_home_team) teamSet.add(e.canon_home_team);
    if (e.canon_away_team) teamSet.add(e.canon_away_team);
  }
  const teams = [...teamSet];

  const ratings = await fetchTeamRatingsForSport(sportKey, teams);
  const ratingMap = new Map<string, TeamRatingRow>();
  for (const r of ratings) ratingMap.set(r.canonical, r);

  const possRows = await fetchTeamPossessionsForSportSeason(sportKey, POSS_SEASON, teams);
  const possMap = new Map<string, PossRow>();
  for (const p of possRows) possMap.set(p.canonical, p);

  let statIdx: TeamStatIndex | null = null;
  if (sportKey === "basketball_ncaab") {
    try {
      const statRows = await fetchNcaabStatsForSportSeason(sportKey, SEASON, teams);
      statIdx = buildTeamStatIndex(statRows);
      console.log(`[MC] (${sportKey}) Loaded ncaab_stats rows=${statRows.length} teams_indexed=${statIdx.size}`);
    } catch (e: any) {
      console.warn(`[MC] (${sportKey}) ncaab_stats unavailable; continuing without it: ${e?.message || String(e)}`);
      statIdx = null;
    }
  }

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
        reason: `missing team_ratings(${sportKey}) for ${!homeR ? home : ""}${!homeR && !awayR ? " & " : ""}${!awayR ? away : ""}`,
      });
      continue;
    }

    const homeP = possMap.get(home) ?? null;
    const awayP = possMap.get(away) ?? null;

    const paceHomePoss = computeTeamPace(sportKey, homeP, "home");
    const paceAwayPoss = computeTeamPace(sportKey, awayP, "away");

    const pacePref = preferNcaabStatPace(sportKey, statIdx, home, away, paceHomePoss, paceAwayPoss);
    const paceHomeUsed = pacePref.paceHome;
    const paceAwayUsed = pacePref.paceAway;

    const paceGameRaw = averageNonNull([paceHomeUsed, paceAwayUsed]) ?? defaultPaceForSport(sportKey);

    const spreadLineHome = lineMap.get(`${e.event_id}|spreads|home`) ?? null;
    const totalLine = lineMap.get(`${e.event_id}|totals|over`) ?? null;

    const marginBump = sportKey === "basketball_ncaab" ? computeNcaabMarginBump(statIdx, home, away) : 0;
    const style =
      sportKey === "basketball_ncaab"
        ? computeNcaabStyleModifiers(statIdx, home, away)
        : ({ paceMult: 1, totalAdd: 0, sigmaMultStyle: 1, marginAdd: 0, used: {} } as NcaabStyle);

    const input = buildInputsPaceAware({
      sportKey,
      home: homeR,
      away: awayR,
      paceGameRaw,
      consensusTotalLine: totalLine,
      calib,
      marginBump,
      style,
    });

    const sim = simulateGameWithProbs(SIMS, input, {
      spreadLineHome,
      totalLine,
      eps: EPS,
      storeMarginHomeWinNegative: MARGIN_HOME_WIN_NEGATIVE,
      rhoMT: input.rhoMT,
    });

    const homePts = sim.projectedTotal / 2 + sim.projectedMarginHome_model / 2;
    const awayPts = sim.projectedTotal - homePts;

    const trace = WRITE_TRACE
      ? {
          sport_key: sportKey,
          season: SEASON,
          poss_season: POSS_SEASON,
          home,
          away,
          pace_inputs: {
            from_team_possessions: { home_split: paceHomePoss, away_split: paceAwayPoss },
            after_source_select: { home: paceHomeUsed, away: paceAwayUsed, game_raw: paceGameRaw },
            style_pace_mult: input.paceGame_style_mult,
            game_final: input.paceGame_final,
          },
          ncaab_style: input.ncaabStyle,
          margin_conventions: {
            model: "positive_means_home_better",
            stored: MARGIN_HOME_WIN_NEGATIVE ? "negative_means_home_better" : "positive_means_home_better",
          },
          margin_debug: {
            projected_margin_home_model: sim.projectedMarginHome_model,
            projected_margin_home_stored: sim.projectedMarginHome_stored,
          },
          calibration: calib
            ? {
                source: "model_calibration",
                window_days: calib.window_days,
                min_sample: calib.min_sample,
                n_games: calib.n_games,
                updated_at: calib.updated_at,
                ready: calibrationIsReady(calib) && !calib.__not_ready,
              }
            : null,
          margin: {
            intercept: input.marginParams.intercept,
            scale_raw: input.marginParams.scale,
            scale_used_abs: input.marginParams.scale_used_abs,
            hca_scale: input.marginParams.hca_scale,
            power_diff: num(homeR.engine_power, 0) - num(awayR.engine_power, 0),
            margin_mean_base_model_space: input.marginMean_base,
            margin_bump_scoring_margin: input.marginBump,
            margin_add_style: input.marginStyleAdd,
            margin_mean_final_model_space: input.marginMean,
          },
          totals: {
            model_total_mean_base: input.totalMean_model_base,
            style_total_add: input.totalStyleAdd,
            model_total_mean_after_style: input.totalMean_model,
            anchor_w: input.totalAnchorW,
            consensus_total_line: totalLine,
            blended_total_mean: input.totalMean,
            components: input.totalsComponents,
          },
          sigma: {
            base_margin_game: input.sigmaMarginGame_base,
            base_total_game: input.sigmaTotalGame_base,
            mult_margin_calib: input.sigmaMult.margin,
            mult_total_calib: input.sigmaMult.total,
            mult_total_style: input.sigmaTotalStyleMult,
            final_margin_game: input.sigmaMarginGame,
            final_total_game: input.sigmaTotalGame,
          },
          rho_mt: input.rhoMT,
          spread_line_home_consensus: spreadLineHome,
          total_line_consensus: totalLine,
          sims: SIMS,
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

  await upsertMonteCarloResultsSnapshot(results);
  console.log(`[MC] (${sportKey}) Snapshot upserted ${results.length} rows (run_id=${runId}).`);

  await rebuildEvPlaysForSport(sportKey, runId, results, eventIds);
}

/* =========================================================
   RUN
========================================================= */

main()
  .then(() => console.log("✅ run_monte_carlo.ts finished"))
  .catch((e: any) => {
    console.error("❌ run_monte_carlo.ts failed");
    try {
      console.error(e?.stack || e);
      console.error("DETAIL:", JSON.stringify(e, null, 2));
    } catch {
      console.error(e);
    }
    process.exit(1);
  });
