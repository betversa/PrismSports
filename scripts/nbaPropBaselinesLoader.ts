// scripts/nbaPlayerPropEvBuilder.ts
//
// NBA PLAYER PROPS EV BUILDER — SINGLE FINAL TABLE (v3.4: FIX CONTEXT LINES BY EVENT_ID+TEAM)
// ------------------------------------------------------------------------------------------
// ✅ FIX: pin_spread_line / pin_total_line are now pulled by (event_id + team) instead of team-only
//      This prevents “everything is -15 / 225” caused by team-only overwrites in odds_wide_latest.
// ✅ Keeps your v3.3 logic: synthetic Pinnacle + hybrid devig + translate to soft line
// ✅ Uses odds_wide_latest rows keyed by event_id|canonical_team (canonicalized through team_map aliases)
//
// Run: npm run nba:props:ev:build

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";

/* =========================================================
   CONFIG
========================================================= */

const SPORT_KEY = "basketball_nba";

// FantasyPros sources (NO projections page)
const FP_SZN = "https://www.fantasypros.com/nba/stats/avg-overall.php";
const FP_7 = "https://www.fantasypros.com/nba/stats/avg-overall.php?days=7";
const FP_15 = "https://www.fantasypros.com/nba/stats/avg-overall.php?days=15";

// mean/sigma weights
const W = { szn: 0.4, d15: 0.3, d7: 0.3 };

// league anchors
const NBA_AVG_TOTAL = 228;
const NBA_AVG_TEAM_TOTAL = NBA_AVG_TOTAL / 2;

// quantum blend (if sharp exists)
const QUANTUM_BLEND_MODEL = 0.25;
const QUANTUM_BLEND_SHARP = 0.75;

// books
const SOFT_BOOKS = new Set(["draftkings", "fanduel", "betmgm"]);
const SHARP_BOOKS = ["pinnacle", "betonlineag"] as const;
type SharpBook = (typeof SHARP_BOOKS)[number];

/**
 * HYBRID DEVIG switch:
 * - near 50/50 => equal margin (stable)
 * - skewed => MPTO-style (power devig)
 * - blend in between
 */
const DEVIG_SKEW_EQ_MAX = 0.06; // <= 6% skew => equal margin
const DEVIG_SKEW_MPTO_MIN = 0.18; // >= 18% skew => MPTO
const DEVIG_MPTO_POWER_LO = 0.5;
const DEVIG_MPTO_POWER_HI = 3.0;

/* =========================================================
   TYPES
========================================================= */

type StatPack = {
  pts: number | null;
  reb: number | null;
  ast: number | null;
  pm3: number | null;
  min: number | null;
};

type PlayerBaseline = {
  fp_id: number;
  player_name: string;
  player_url: string | null;
  team_abbr_raw: string | null;
  canonical: string | null;
  position: string | null;
  picture_url: string;

  pts_szn: number | null;
  reb_szn: number | null;
  ast_szn: number | null;
  pm3_szn: number | null;
  min_szn: number | null;

  pts_7: number | null;
  reb_7: number | null;
  ast_7: number | null;
  pm3_7: number | null;
  min_7: number | null;

  pts_15: number | null;
  reb_15: number | null;
  ast_15: number | null;
  pm3_15: number | null;
  min_15: number | null;
};

type OddsWide = {
  event_id: string;
  team: string; // canonicalized
  pin_spread_line: number | null;
  pin_total_line: number | null;
};

type PropsRow = {
  sport_key: string;
  event_id: string;
  commence_time: string;

  home_team: string | null;
  away_team: string | null;

  player_name: string;

  market: string; // player_points, etc
  side: string; // over/under
  line: number;
  odds: number;

  bookmaker: string;
};

type SharpPair = {
  line: number;
  over_odds: number;
  under_odds: number;
};

/* =========================================================
   UTIL
========================================================= */

function toNum(x: any): number | null {
  if (x === null || x === undefined) return null;
  const n = Number(String(x).trim());
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function normName(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/'/g, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normSide(s: any): "over" | "under" | null {
  const t = String(s || "").toLowerCase().trim();
  if (t === "over") return "over";
  if (t === "under") return "under";
  return null;
}

function normBook(b: any): SharpBook | null {
  const s = String(b || "").toLowerCase().trim();
  if (!s) return null;
  if (s === "pinnacle" || s.includes("pinnacle")) return "pinnacle";
  if (s === "betonlineag" || s.includes("betonline")) return "betonlineag";
  return null;
}

function normalizeTeamKey(s: string) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\u00a0/g, " ")
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9\s&'.-]/g, "")
    .replace(/\s+/g, " ");
}

function americanToImpliedProb(odds: number): number {
  if (odds === 0) return 0.5;
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

function impliedProbToAmerican(p: number): number {
  const pp = clamp(p, 1e-6, 1 - 1e-6);
  if (pp >= 0.5) return -Math.round((pp / (1 - pp)) * 100);
  return Math.round(((1 - pp) / pp) * 100);
}

function evPct(p: number, odds: number): number {
  const b = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
  return (p * b - (1 - p)) * 100;
}

function kellyFraction(p: number, odds: number): number {
  const b = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
  const f = (p * (b + 1) - 1) / b;
  return clamp(f, 0, 1);
}

function weightedAvg(a: number | null, b: number | null, c: number | null): number | null {
  let sum = 0;
  let wsum = 0;
  if (a != null) {
    sum += a * W.szn;
    wsum += W.szn;
  }
  if (c != null) {
    sum += c * W.d15;
    wsum += W.d15;
  }
  if (b != null) {
    sum += b * W.d7;
    wsum += W.d7;
  }
  return wsum ? sum / wsum : null;
}

/* =========================================================
   HYBRID DEVIG (Equal Margin ↔ MPTO)
========================================================= */

function devigEqualMargin(pOverImp: number, pUnderImp: number) {
  const h = pOverImp + pUnderImp - 1;
  const pO = clamp(pOverImp - h / 2, 1e-6, 1 - 1e-6);
  const pU = clamp(pUnderImp - h / 2, 1e-6, 1 - 1e-6);
  const s = pO + pU;
  return { p_over: pO / s, p_under: pU / s };
}

function devigPairMPTO_power(pOverImp: number, pUnderImp: number) {
  const skew = Math.abs(pOverImp - pUnderImp);
  const t = clamp(
    (skew - DEVIG_SKEW_EQ_MAX) /
      Math.max(DEVIG_SKEW_MPTO_MIN - DEVIG_SKEW_EQ_MAX, 1e-6),
    0,
    1
  );
  const k = DEVIG_MPTO_POWER_LO + t * (DEVIG_MPTO_POWER_HI - DEVIG_MPTO_POWER_LO);

  const a = Math.pow(clamp(pOverImp, 1e-12, 1), k);
  const b = Math.pow(clamp(pUnderImp, 1e-12, 1), k);
  const denom = a + b || 1;

  const pO = clamp(a / denom, 1e-6, 1 - 1e-6);
  const pU = clamp(1 - pO, 1e-6, 1 - 1e-6);
  return { p_over: pO, p_under: pU };
}

function devigHybrid(pOverImp: number, pUnderImp: number) {
  const skew = Math.abs(pOverImp - pUnderImp);
  const eq = devigEqualMargin(pOverImp, pUnderImp);
  const mp = devigPairMPTO_power(pOverImp, pUnderImp);

  if (skew <= DEVIG_SKEW_EQ_MAX) return { ...eq, method: "equal_margin" as const, alpha: 0 };
  if (skew >= DEVIG_SKEW_MPTO_MIN) return { ...mp, method: "mpto" as const, alpha: 1 };

  const alpha = clamp((skew - DEVIG_SKEW_EQ_MAX) / (DEVIG_SKEW_MPTO_MIN - DEVIG_SKEW_EQ_MAX), 0, 1);
  const pO = clamp(eq.p_over * (1 - alpha) + mp.p_over * alpha, 1e-6, 1 - 1e-6);
  return { p_over: pO, p_under: 1 - pO, method: "blend" as const, alpha };
}

/* =========================================================
   DISTRIBUTIONS
========================================================= */

// Normal CDF (erf approximation)
function normalCdf(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / (sigma * Math.SQRT2);
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429;
  const erf =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-z * z);
  const sign = z >= 0 ? 1 : -1;
  return 0.5 * (1 + sign * erf);
}

function pOverNormal(line: number, mu: number, sigma: number): number {
  return clamp(1 - normalCdf(line, mu, sigma), 0, 1);
}

// Acklam inverse normal CDF approximation
function invNorm(p: number): number {
  const pp = clamp(p, 1e-12, 1 - 1e-12);
  const a = [
    -3.969683028665376e+01,
    2.209460984245205e+02,
    -2.759285104469687e+02,
    1.383577518672690e+02,
    -3.066479806614716e+01,
    2.506628277459239e+00,
  ];
  const b = [
    -5.447609879822406e+01,
    1.615858368580409e+02,
    -1.556989798598866e+02,
    6.680131188771972e+01,
    -1.328068155288572e+01,
  ];
  const c = [
    -7.784894002430293e-03,
    -3.223964580411365e-01,
    -2.400758277161838e+00,
    -2.549732539343734e+00,
    4.374664141464968e+00,
    2.938163982698783e+00,
  ];
  const d = [
    7.784695709041462e-03,
    3.224671290700398e-01,
    2.445134137142996e+00,
    3.754408661907416e+00,
  ];

  const plow = 0.02425;
  const phigh = 1 - plow;

  let q: number, r: number;
  if (pp < plow) {
    q = Math.sqrt(-2 * Math.log(pp));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  if (pp > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - pp));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  q = pp - 0.5;
  r = q * q;
  return (
    (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

// Poisson CDF for k <= floor(line)
function poissonCdf(k: number, lambda: number): number {
  const kk = Math.floor(k);
  if (lambda <= 0) return kk >= 0 ? 1 : 0;
  let sum = 0;
  let term = Math.exp(-lambda);
  sum += term;
  for (let i = 1; i <= kk; i++) {
    term *= lambda / i;
    sum += term;
  }
  return clamp(sum, 0, 1);
}

function pOverPoisson(line: number, lambda: number): number {
  const k = Math.floor(line);
  return clamp(1 - poissonCdf(k, Math.max(lambda, 0.01)), 0, 1);
}

function inferLambdaFromPoissonOver(line: number, pOver0: number): number | null {
  const p0 = clamp(pOver0, 1e-6, 1 - 1e-6);

  let lo = 0.01;
  let hi = Math.max(1, line + 6);

  for (let i = 0; i < 30; i++) {
    const pHi = pOverPoisson(line, hi);
    if (pHi >= p0) break;
    hi *= 1.6;
    if (hi > 200) break;
  }

  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const pm = pOverPoisson(line, mid);
    if (pm < p0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/* =========================================================
   SIGMA + CONTEXT
========================================================= */

function sigmaFromWindows(
  mu: number,
  szn: number | null,
  d7: number | null,
  d15: number | null,
  kind: "pts" | "reb" | "ast" | "pm3"
): number {
  let base =
    kind === "pts"
      ? Math.max(3.0, 0.22 * mu)
      : kind === "reb"
      ? Math.max(1.5, 0.28 * mu)
      : kind === "ast"
      ? Math.max(1.5, 0.30 * mu)
      : Math.max(0.8, 0.45 * Math.max(mu, 0.5));

  const parts: Array<[number, number]> = [];
  if (szn != null) parts.push([szn, W.szn]);
  if (d15 != null) parts.push([d15, W.d15]);
  if (d7 != null) parts.push([d7, W.d7]);

  let d = 0;
  for (const [v, w] of parts) d += w * Math.pow(v - mu, 2);
  d = Math.sqrt(d);

  const k = kind === "pts" ? 1.0 : kind === "pm3" ? 0.6 : 0.8;
  const infl = 1 + k * (d / Math.max(Math.abs(mu), 1e-6));
  const sigma = base * clamp(infl, 0.9, 1.6);

  return clamp(sigma, base * 0.75, base * 1.75);
}

function minutesFactorFromSpread(spread: number | null): number | null {
  if (spread == null) return null;
  const a = Math.abs(spread);
  let f = a <= 4.5 ? 1.03 : a <= 9.5 ? 1.0 : a <= 14.5 ? 0.95 : 0.9;
  if (spread <= -12) f -= 0.02;
  return clamp(f, 0.85, 1.06);
}

/* =========================================================
   FANTASYPROS SCRAPE
========================================================= */

function parseTeamPosLabel(label: string): { team: string | null; firstPos: string | null } {
  const m = label.match(/\(\s*([A-Z]{2,4})\s*-\s*([^)]+)\)/);
  if (!m) return { team: null, firstPos: null };
  const team = m[1];
  const firstPos = m[2].trim().split(",")[0]?.trim() || null;
  return { team, firstPos };
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; PrismSportsBot/1.0)" },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.text();
}

// avg-overall.php td.center indices: PTS=0 REB=1 AST=2 3PM=7 MIN=10
function scrapeAvgPage(html: string): Map<number, { base: any; stats: StatPack }> {
  const $ = cheerio.load(html);
  const out = new Map<number, { base: any; stats: StatPack }>();

  $("tr[class^='mpb-player-']").each((_, tr) => {
    const $tr = $(tr);

    const a = $tr.find("td.player-label a.fp-player-link").first();
    const cls = a.attr("class") || "";
    const idMatch = cls.match(/fp-id-(\d+)/);
    const fp_id = idMatch ? Number(idMatch[1]) : null;
    if (!fp_id) return;

    const player_name = (a.attr("fp-player-name") || a.text() || "").trim();
    const player_url = a.attr("href") || null;

    const small = $tr.find("td.player-label small").first().text().trim();
    const { team: team_abbr_raw, firstPos } = parseTeamPosLabel(small);

    const centers = $tr
      .find("td.center")
      .toArray()
      .map((td) => $(td).text().trim());

    if (centers.length < 11) return;

    out.set(fp_id, {
      base: { fp_id, player_name, player_url, team_abbr_raw, position: firstPos },
      stats: {
        pts: toNum(centers[0]),
        reb: toNum(centers[1]),
        ast: toNum(centers[2]),
        pm3: toNum(centers[7]),
        min: toNum(centers[10]),
      },
    });
  });

  return out;
}

/* =========================================================
   SHARP KEY + TRANSLATION
========================================================= */

function idxKey(event_id: string, player_name: string, market_raw: string) {
  return `${event_id}|${normName(player_name)}|${String(market_raw || "").trim()}`;
}

function translateSharpOverToTarget(opts: {
  marketOut: "points" | "rebounds" | "assists" | "threes";
  targetLine: number;
  sharpLine: number;
  pOverAtSharpLine: number; // no-vig OVER at sharpLine
  sigmaAnchor: number | null; // required for normal markets
}): number | null {
  const p0_over = clamp(opts.pOverAtSharpLine, 1e-6, 1 - 1e-6);

  if (opts.marketOut !== "threes") {
    const sigma =
      opts.sigmaAnchor != null && Number.isFinite(opts.sigmaAnchor) && opts.sigmaAnchor > 0
        ? opts.sigmaAnchor
        : null;
    if (!sigma) return null;

    // p0_over = 1 - Phi((L - mu)/sigma) => mu = L - sigma*z where z = Phi^-1(1 - p0_over)
    const z = invNorm(1 - p0_over);
    const muSharp = opts.sharpLine - sigma * z;
    return pOverNormal(opts.targetLine, muSharp, sigma);
  }

  const lambda = inferLambdaFromPoissonOver(opts.sharpLine, p0_over);
  if (lambda == null) return null;
  return pOverPoisson(opts.targetLine, lambda);
}

/* =========================================================
   MAIN
========================================================= */

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!supabaseUrl || !serviceKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // @ts-ignore
  const run_id = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `run_${Date.now()}`;
  const now = new Date();
  const nowIso = now.toISOString();

  /* -------------------------------------------------------
     1) FUTURE events (defines slate)
  -------------------------------------------------------- */
  const { data: events, error: evErr } = await supabase
    .from("events")
    .select("event_id, commence_time")
    .eq("sport_key", SPORT_KEY)
    .gt("commence_time", nowIso)
    .order("commence_time", { ascending: true })
    .limit(5000);

  if (evErr) throw evErr;

  const allowedEventIds = new Set<string>();
  for (const e of (events || []) as any[]) if (e?.event_id) allowedEventIds.add(String(e.event_id));

  if (allowedEventIds.size === 0) {
    const { error: delErr } = await supabase.from("player_prop_ev_latest").delete().eq("sport_key", SPORT_KEY);
    if (delErr) throw delErr;
    console.log(JSON.stringify({ ok: true, run_id, inserted_rows: 0, reason: "no_future_events" }, null, 2));
    return;
  }

  /* -------------------------------------------------------
     2) Pull props snapshot for FUTURE events (ALL books!)
  -------------------------------------------------------- */
  const props: PropsRow[] = [];
  const eventIdList = Array.from(allowedEventIds);
  const EVENT_CHUNK = 200;

  for (let i = 0; i < eventIdList.length; i += EVENT_CHUNK) {
    const chunk = eventIdList.slice(i, i + EVENT_CHUNK);

    const { data, error } = await supabase
      .from("player_props_snapshot")
      .select("sport_key,event_id,commence_time,home_team,away_team,player_name,market,side,line,odds,bookmaker")
      .eq("sport_key", SPORT_KEY)
      .in("event_id", chunk)
      .gt("commence_time", nowIso);

    if (error) throw error;
    if (data?.length) props.push(...(data as any[]));
  }

  if (props.length === 0) {
    const { error: delErr } = await supabase.from("player_prop_ev_latest").delete().eq("sport_key", SPORT_KEY);
    if (delErr) throw delErr;
    console.log(JSON.stringify({ ok: true, run_id, inserted_rows: 0, reason: "no_future_props_rows" }, null, 2));
    return;
  }

  /* -------------------------------------------------------
     3) Scrape FantasyPros baselines (szn/7/15)
  -------------------------------------------------------- */
  const [htmlS, html7, html15] = await Promise.all([fetchHtml(FP_SZN), fetchHtml(FP_7), fetchHtml(FP_15)]);
  const mapS = scrapeAvgPage(htmlS);
  const map7 = scrapeAvgPage(html7);
  const map15 = scrapeAvgPage(html15);

  const baselines = new Map<number, PlayerBaseline>();

  function ensure(fp_id: number, base: any) {
    if (baselines.has(fp_id)) return;
    baselines.set(fp_id, {
      fp_id,
      player_name: base.player_name,
      player_url: base.player_url ?? null,
      team_abbr_raw: base.team_abbr_raw ?? null,
      canonical: null,
      position: base.position ?? null,
      picture_url: `https://images.fantasypros.com/images/players/nba/${fp_id}/headshot/70x70.png`,

      pts_szn: null,
      reb_szn: null,
      ast_szn: null,
      pm3_szn: null,
      min_szn: null,

      pts_7: null,
      reb_7: null,
      ast_7: null,
      pm3_7: null,
      min_7: null,

      pts_15: null,
      reb_15: null,
      ast_15: null,
      pm3_15: null,
      min_15: null,
    });
  }

  function apply(map: Map<number, { base: any; stats: StatPack }>, suffix: "szn" | "7" | "15") {
    for (const [fp_id, v] of map.entries()) {
      ensure(fp_id, v.base);
      const r = baselines.get(fp_id)!;

      r.player_name = r.player_name || v.base.player_name;
      r.player_url = r.player_url ?? v.base.player_url ?? null;
      r.team_abbr_raw = r.team_abbr_raw ?? v.base.team_abbr_raw ?? null;
      r.position = r.position ?? v.base.position ?? null;

      (r as any)[`pts_${suffix}`] = v.stats.pts;
      (r as any)[`reb_${suffix}`] = v.stats.reb;
      (r as any)[`ast_${suffix}`] = v.stats.ast;
      (r as any)[`pm3_${suffix}`] = v.stats.pm3;
      (r as any)[`min_${suffix}`] = v.stats.min;
    }
  }

  apply(mapS, "szn");
  apply(map7, "7");
  apply(map15, "15");

  /* -------------------------------------------------------
     4) Team canonicalization
  -------------------------------------------------------- */
  const { data: teamMapRows, error: tmErr } = await supabase
    .from("team_map")
    .select('canonical,"Abbreviation","The Odds API","ESPN_Long","SR_School","SR_School_Short","KenPom","Elo"')
    .limit(4000);

  if (tmErr) throw tmErr;

  const abbrToCanon = new Map<string, string>();
  const aliasToCanon = new Map<string, string>();

  for (const r of teamMapRows || []) {
    const canon = (r as any).canonical?.toString().trim();
    if (!canon) continue;

    aliasToCanon.set(normalizeTeamKey(canon), canon);

    const abbr = (r as any)["Abbreviation"]?.toString().trim();
    if (abbr) abbrToCanon.set(abbr, canon);

    for (const v of Object.values(r as any)) {
      if (typeof v === "string" && v.trim()) aliasToCanon.set(normalizeTeamKey(v), canon);
    }
  }

  for (const b of baselines.values()) {
    const raw = (b.team_abbr_raw || "").trim();
    b.canonical = raw ? abbrToCanon.get(raw) ?? raw : null;
  }

  const baselineByName = new Map<string, PlayerBaseline>();
  for (const b of baselines.values()) baselineByName.set(normName(b.player_name), b);

  const canonTeam = (s: string | null) => {
    if (!s) return null;
    return aliasToCanon.get(normalizeTeamKey(s)) ?? s;
  };

  /* -------------------------------------------------------
     5) Pull odds_wide_latest context
        ✅ FIX: key by event_id + canonical team
  -------------------------------------------------------- */

  // IMPORTANT: if odds_wide_latest does NOT have event_id, you must add it,
  // or change the select below to the correct id column.
  const { data: oddsRows, error: oErr } = await supabase
    .from("odds_wide_latest")
    .select("event_id, team, pin_spread_line, pin_total_line")
    .eq("sport_key", SPORT_KEY);

  if (oErr) throw oErr;

  const oddsKey = (event_id: string, teamCanon: string) => `${event_id}|${teamCanon}`;
  const oddsByEventTeam = new Map<string, OddsWide>();

  for (const o of (oddsRows || []) as any[]) {
    const event_id = String(o.event_id || "").trim();
    if (!event_id) continue;

    const teamCanon = canonTeam((o.team || "").toString().trim());
    if (!teamCanon) continue;

    oddsByEventTeam.set(oddsKey(event_id, teamCanon), {
      event_id,
      team: teamCanon,
      pin_spread_line: toNum(o.pin_spread_line),
      pin_total_line: toNum(o.pin_total_line),
    });
  }

  /* -------------------------------------------------------
     6) Build PINNACLE paired lines index (event|player|market -> [{line, over, under}])
  -------------------------------------------------------- */

  const pinPairsByKey = new Map<string, SharpPair[]>();
  const tmp = new Map<string, { line: number; over?: number; under?: number }>();

  for (const r of props) {
    const book = normBook(r.bookmaker);
    if (book !== "pinnacle") continue;

    const side = normSide(r.side);
    const line = toNum(r.line);
    const odds = toNum(r.odds);
    if (!side || line == null || odds == null) continue;

    const base = idxKey(r.event_id, r.player_name, r.market);
    const k = `${base}|${line}`;
    const cur = tmp.get(k) ?? { line };
    if (side === "over") cur.over = odds;
    if (side === "under") cur.under = odds;
    tmp.set(k, cur);
  }

  for (const [k, v] of tmp.entries()) {
    if (v.over == null || v.under == null) continue;
    const base = k.split("|").slice(0, 3).join("|");
    const arr = pinPairsByKey.get(base) ?? [];
    arr.push({ line: v.line, over_odds: v.over, under_odds: v.under });
    pinPairsByKey.set(base, arr);
  }

  for (const [k, arr] of pinPairsByKey.entries()) {
    arr.sort((a, b) => a.line - b.line);
    pinPairsByKey.set(k, arr);
  }

  function nearestPinPair(baseKey: string, targetLine: number): SharpPair | null {
    const arr = pinPairsByKey.get(baseKey);
    if (!arr || !arr.length) return null;

    let best: SharpPair | null = null;
    let bestDist = Infinity;
    for (const p of arr) {
      const d = Math.abs(p.line - targetLine);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  }

  /* -------------------------------------------------------
     7) Build final EV rows (SOFT books only)
  -------------------------------------------------------- */
  const out: any[] = [];
  const created_at = new Date().toISOString();

  const diag = {
    dropped_bad_side_or_odds: 0,
    dropped_no_baseline: 0,
    dropped_no_team: 0,
    dropped_no_model: 0,
    dropped_no_pinnacle_pair_anywhere: 0,
    dropped_translate_failed: 0,
    dropped_no_context_line: 0,
    inserted: 0,
  };

  for (const r of props) {
    const eid = String(r.event_id || "");
    if (!allowedEventIds.has(eid)) continue;

    const ct = r.commence_time ? new Date(r.commence_time) : null;
    if (!ct || !(ct.getTime() > now.getTime())) continue;

    const book = String(r.bookmaker).toLowerCase().trim();
    if (!SOFT_BOOKS.has(book)) continue;

    const playerNameRaw = String(r.player_name || "").trim();
    if (!playerNameRaw) {
      diag.dropped_no_baseline++;
      continue;
    }

    const base = baselineByName.get(normName(playerNameRaw));
    if (!base) {
      diag.dropped_no_baseline++;
      continue;
    }
    if (!base.canonical) {
      diag.dropped_no_team++;
      continue;
    }

    const marketOut =
      r.market === "player_points"
        ? ("points" as const)
        : r.market === "player_rebounds"
        ? ("rebounds" as const)
        : r.market === "player_assists"
        ? ("assists" as const)
        : r.market === "player_threes"
        ? ("threes" as const)
        : null;
    if (!marketOut) continue;

    const side = normSide(r.side);
    const line = toNum(r.line);
    const odds = toNum(r.odds);
    if (!side || line == null || odds == null) {
      diag.dropped_bad_side_or_odds++;
      continue;
    }

    // Opponent from snapshot home/away
    const homeCanon = canonTeam(r.home_team);
    const awayCanon = canonTeam(r.away_team);
    const opponent =
      homeCanon && awayCanon
        ? base.canonical === homeCanon
          ? awayCanon
          : base.canonical === awayCanon
          ? homeCanon
          : null
        : null;

    // ✅ FIXED context lookup
    const ow = oddsByEventTeam.get(`${eid}|${base.canonical}`) ?? null;
    const pin_spread_line = ow?.pin_spread_line ?? null;
    const pin_total_line = ow?.pin_total_line ?? null;

    // (optional) if you want to drop rows missing context entirely:
    // if (pin_spread_line == null && pin_total_line == null) { diag.dropped_no_context_line++; continue; }

    const minutes_factor = minutesFactorFromSpread(pin_spread_line);
    const pace_factor = pin_total_line != null ? clamp(pin_total_line / NBA_AVG_TOTAL, 0.9, 1.1) : null;

    const implied_team_total =
      pin_total_line != null && pin_spread_line != null ? pin_total_line / 2 - pin_spread_line / 2 : null;
    const team_total_factor =
      implied_team_total != null ? clamp(implied_team_total / NBA_AVG_TEAM_TOTAL, 0.85, 1.15) : null;

    // Minutes mean + adjusted
    const min_base = weightedAvg(base.min_szn, base.min_7, base.min_15);
    const min_adj = min_base != null && minutes_factor != null ? min_base * minutes_factor : min_base;

    // Per-minute rates
    const rate = (stat_szn: number | null, stat_7: number | null, stat_15: number | null) => {
      const rS = stat_szn != null && base.min_szn != null && base.min_szn > 0 ? stat_szn / base.min_szn : null;
      const r7 = stat_7 != null && base.min_7 != null && base.min_7 > 0 ? stat_7 / base.min_7 : null;
      const r15 = stat_15 != null && base.min_15 != null && base.min_15 > 0 ? stat_15 / base.min_15 : null;
      return weightedAvg(rS, r7, r15);
    };

    const ptsRate = rate(base.pts_szn, base.pts_7, base.pts_15);
    const rebRate = rate(base.reb_szn, base.reb_7, base.reb_15);
    const astRate = rate(base.ast_szn, base.ast_7, base.ast_15);
    const pm3Rate = rate(base.pm3_szn, base.pm3_7, base.pm3_15);

    const pf = pace_factor ?? 1.0;
    const ttf = team_total_factor ?? 1.0;

    // Model p
    let mu: number | null = null;
    let sigma: number | null = null;
    let p_model: number | null = null;

    if (min_adj != null) {
      if (marketOut === "points" && ptsRate != null) {
        mu = ptsRate * min_adj * ttf;
        sigma = sigmaFromWindows(mu, base.pts_szn, base.pts_7, base.pts_15, "pts");
        const pO = pOverNormal(line, mu, sigma);
        p_model = side === "over" ? pO : 1 - pO;
      } else if (marketOut === "rebounds" && rebRate != null) {
        mu = rebRate * min_adj * pf;
        sigma = sigmaFromWindows(mu, base.reb_szn, base.reb_7, base.reb_15, "reb");
        const pO = pOverNormal(line, mu, sigma);
        p_model = side === "over" ? pO : 1 - pO;
      } else if (marketOut === "assists" && astRate != null) {
        mu = astRate * min_adj * ttf;
        sigma = sigmaFromWindows(mu, base.ast_szn, base.ast_7, base.ast_15, "ast");
        const pO = pOverNormal(line, mu, sigma);
        p_model = side === "over" ? pO : 1 - pO;
      } else if (marketOut === "threes" && pm3Rate != null) {
        mu = pm3Rate * min_adj * ttf;
        sigma = Math.sqrt(Math.max(mu, 0.01));
        const pO = pOverPoisson(line, mu);
        p_model = side === "over" ? pO : 1 - pO;
      }
    }

    if (mu == null || p_model == null) {
      diag.dropped_no_model++;
      continue;
    }

    // Synthetic Pinnacle at soft line:
    const baseKey = idxKey(r.event_id, r.player_name, r.market);
    const pinPair = nearestPinPair(baseKey, line);
    if (!pinPair) {
      diag.dropped_no_pinnacle_pair_anywhere++;
      continue;
    }

    const pO_imp = americanToImpliedProb(pinPair.over_odds);
    const pU_imp = americanToImpliedProb(pinPair.under_odds);
    const dev = devigHybrid(pO_imp, pU_imp);
    const pOver_nv_at_pinLine = dev.p_over;

    // Translate to target soft line
    const pOverTarget = translateSharpOverToTarget({
      marketOut,
      targetLine: line,
      sharpLine: pinPair.line,
      pOverAtSharpLine: pOver_nv_at_pinLine,
      sigmaAnchor: marketOut === "threes" ? null : sigma,
    });

    if (pOverTarget == null) {
      diag.dropped_translate_failed++;
      continue;
    }

    const p_sharp = side === "over" ? pOverTarget : 1 - pOverTarget;

    // Quantum blend
    const p_quantum = clamp(p_model * QUANTUM_BLEND_MODEL + p_sharp * QUANTUM_BLEND_SHARP, 0, 1);

    // EV + sizing
    const quantum_fair_odds = impliedProbToAmerican(p_quantum);
    const book_implied_prob = americanToImpliedProb(odds);
    const ev_pct_val = evPct(p_quantum, odds);

    const edge = (p_quantum - book_implied_prob) * 100;
    const score = ev_pct_val * 10 + edge;

    out.push({
      run_id,
      created_at,
      sport_key: SPORT_KEY,

      event_id: r.event_id,
      commence_time: r.commence_time,
      team: base.canonical,
      opponent,

      fp_id: base.fp_id,
      player_name: base.player_name,
      position: base.position,
      picture_url: base.picture_url,

      market: marketOut,
      side,
      line,
      book,
      odds,

      // ✅ context (now correctly keyed)
      pin_spread_line,
      pin_total_line,
      implied_team_total,
      minutes_factor,
      pace_factor,
      team_total_factor,

      // model
      min_base,
      min_adj,
      mu,
      sigma,
      p_model,

      // sharp / quantum
      p_sharp,
      p_quantum,
      quantum_fair_odds,

      // ev outputs
      book_implied_prob,
      ev_pct: ev_pct_val,
      kelly_fraction: kellyFraction(p_quantum, odds),
      score,
    });

    diag.inserted++;
  }

  /* -------------------------------------------------------
     8) Reset + insert output table
  -------------------------------------------------------- */
  const { error: delErr } = await supabase.from("player_prop_ev_latest").delete().eq("sport_key", SPORT_KEY);
  if (delErr) throw delErr;

  const INSERT_CHUNK = 2000;
  for (let i = 0; i < out.length; i += INSERT_CHUNK) {
    const batch = out.slice(i, i + INSERT_CHUNK);
    const { error: insErr } = await supabase.from("player_prop_ev_latest").insert(batch);
    if (insErr) throw insErr;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        run_id,
        inserted_rows: out.length,
        dropped: {
          dropped_bad_side_or_odds: diag.dropped_bad_side_or_odds,
          dropped_no_baseline: diag.dropped_no_baseline,
          dropped_no_team: diag.dropped_no_team,
          dropped_no_model: diag.dropped_no_model,
          dropped_no_pinnacle_pair_anywhere: diag.dropped_no_pinnacle_pair_anywhere,
          dropped_translate_failed: diag.dropped_translate_failed,
          dropped_no_context_line: diag.dropped_no_context_line,
        },
        notes: {
          context_fix: "odds_wide_latest now indexed by (event_id + canonical team)",
          devig: {
            eq_if_skew_le: DEVIG_SKEW_EQ_MAX,
            mpto_if_skew_ge: DEVIG_SKEW_MPTO_MIN,
            blend_between: [DEVIG_SKEW_EQ_MAX, DEVIG_SKEW_MPTO_MIN],
          },
        },
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
