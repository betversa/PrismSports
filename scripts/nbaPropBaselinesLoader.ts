import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";

/* =========================
   CONFIG
========================= */
const SPORT_KEY = "basketball_nba";

const FP_SZN = "https://www.fantasypros.com/nba/stats/avg-overall.php";
const FP_7   = "https://www.fantasypros.com/nba/stats/avg-overall.php?days=7";
const FP_15  = "https://www.fantasypros.com/nba/stats/avg-overall.php?days=15";

const W = { szn: 0.4, d15: 0.3, d7: 0.3 };

const NBA_AVG_TOTAL = 228;
const NBA_AVG_TEAM_TOTAL = NBA_AVG_TOTAL / 2;

const QUANTUM_BLEND_MODEL = 0.70;
const QUANTUM_BLEND_SHARP = 0.30;

const SHARP_BOOK = "pinnacle";
const SOFT_BOOKS = new Set(["draftkings", "fanduel", "betmgm"]);

/* =========================
   TYPES
========================= */
type StatPack = { pts: number|null; reb: number|null; ast: number|null; pm3: number|null; min: number|null };

type PlayerBaseline = {
  fp_id: number;
  player_name: string;
  player_url: string | null;
  team_abbr_raw: string | null;
  canonical: string | null;
  position: string | null;
  picture_url: string;

  pts_szn: number|null; reb_szn: number|null; ast_szn: number|null; pm3_szn: number|null; min_szn: number|null;
  pts_7: number|null;   reb_7: number|null;   ast_7: number|null;   pm3_7: number|null;   min_7: number|null;
  pts_15: number|null;  reb_15: number|null;  ast_15: number|null;  pm3_15: number|null;  min_15: number|null;
};

type OddsWide = { team: string; pin_spread_line: number|null; pin_total_line: number|null };

/* =========================
   HELPERS
========================= */
function toNum(x: any): number | null {
  if (x === null || x === undefined) return null;
  const n = Number(String(x).trim());
  return Number.isFinite(n) ? n : null;
}
function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }

function normName(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/'/g, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

/* ---- Normal CDF (approx) ---- */
function normalCdf(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / (sigma * Math.SQRT2);
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const erf = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-z * z);
  const sign = z >= 0 ? 1 : -1;
  return 0.5 * (1 + sign * erf);
}
function pOverNormal(line: number, mu: number, sigma: number): number {
  return clamp(1 - normalCdf(line, mu, sigma), 0, 1);
}

/* ---- Poisson CDF ---- */
function poissonCdf(k: number, lambda: number): number {
  const kk = Math.floor(k);
  if (lambda <= 0) return kk >= 0 ? 1 : 0;
  let sum = 0;
  let term = Math.exp(-lambda);
  sum += term;
  for (let i = 1; i <= kk; i++) { term *= lambda / i; sum += term; }
  return clamp(sum, 0, 1);
}
function pOverPoisson(line: number, lambda: number): number {
  const k = Math.floor(line);
  return clamp(1 - poissonCdf(k, Math.max(lambda, 0.01)), 0, 1);
}

/* ---- FantasyPros scrape ---- */
function parseTeamPosLabel(label: string): { team: string|null; firstPos: string|null } {
  const m = label.match(/\(\s*([A-Z]{2,4})\s*-\s*([^)]+)\)/);
  if (!m) return { team: null, firstPos: null };
  return { team: m[1], firstPos: m[2].trim().split(",")[0]?.trim() || null };
}
async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; PrismSportsBot/1.0)" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.text();
}
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

    const centers = $tr.find("td.center").toArray().map(td => $(td).text().trim());
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

function weightedAvg(a: number|null, b: number|null, c: number|null): number|null {
  let sum = 0, wsum = 0;
  if (a != null) { sum += a * W.szn; wsum += W.szn; }
  if (c != null) { sum += c * W.d15; wsum += W.d15; }
  if (b != null) { sum += b * W.d7;  wsum += W.d7; }
  return wsum ? (sum / wsum) : null;
}

function sigmaFromWindows(mu: number, szn: number|null, d7: number|null, d15: number|null, kind: "pts"|"reb"|"ast"|"pm3"): number {
  let base =
    kind === "pts" ? Math.max(3.0, 0.22 * mu) :
    kind === "reb" ? Math.max(1.5, 0.28 * mu) :
    kind === "ast" ? Math.max(1.5, 0.30 * mu) :
                     Math.max(0.8, 0.45 * Math.max(mu, 0.5));

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

function minutesFactorFromSpread(spread: number|null): number|null {
  if (spread == null) return null;
  const a = Math.abs(spread);
  let f =
    a <= 4.5 ? 1.03 :
    a <= 9.5 ? 1.00 :
    a <= 14.5 ? 0.95 :
               0.90;
  if (spread <= -12) f -= 0.02;
  return clamp(f, 0.85, 1.06);
}

/* =========================
   MAIN
========================= */
async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const run_id = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  // 1) FantasyPros baselines
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

      pts_szn: null, reb_szn: null, ast_szn: null, pm3_szn: null, min_szn: null,
      pts_7: null,   reb_7: null,   ast_7: null,   pm3_7: null,   min_7: null,
      pts_15: null,  reb_15: null,  ast_15: null,  pm3_15: null,  min_15: null,
    });
  }
  function apply(map: Map<number, { base: any; stats: StatPack }>, suffix: "szn"|"7"|"15") {
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

  // 2) Canonicalize team via team_map."Abbreviation" -> canonical
  const { data: teamMapRows, error: tmErr } = await supabase
    .from("team_map")
    .select('"Abbreviation", canonical')
    .limit(2000);
  if (tmErr) throw tmErr;

  const abbrToCanon = new Map<string, string>();
  for (const r of teamMapRows || []) {
    const abbr = (r as any)["Abbreviation"]?.toString().trim();
    const canon = (r as any).canonical?.toString().trim();
    if (abbr && canon) abbrToCanon.set(abbr, canon);
  }
  for (const b of baselines.values()) {
    const raw = (b.team_abbr_raw || "").trim();
    b.canonical = raw ? (abbrToCanon.get(raw) ?? raw) : null;
  }

  const baselineByName = new Map<string, PlayerBaseline>();
  for (const b of baselines.values()) baselineByName.set(normName(b.player_name), b);

  // 3) odds_wide_latest context
  const { data: oddsRows, error: oErr } = await supabase
    .from("odds_wide_latest")
    .select("team, pin_spread_line, pin_total_line")
    .eq("sport_key", SPORT_KEY);
  if (oErr) throw oErr;

  const teamToOdds = new Map<string, OddsWide>();
  for (const o of (oddsRows || []) as any[]) {
    const team = (o.team || "").toString().trim();
    if (!team) continue;
    teamToOdds.set(team, {
      team,
      pin_spread_line: toNum(o.pin_spread_line),
      pin_total_line: toNum(o.pin_total_line),
    });
  }

  // 4) props snapshot (exact schema from your CSV)
  const { data: propsRows, error: pErr } = await supabase
    .from("player_props_snapshot")
    .select("sport_key,event_id,commence_time,player_name,player_id,team,opponent,market,side,line,odds,bookmaker")
    .eq("sport_key", SPORT_KEY);
  if (pErr) throw pErr;

  const props = (propsRows || []) as any[];

  // 5) Build Pinnacle no-vig probs per (event/player/market/line)
  // key: event|player|market|line
  const pinPairs = new Map<string, { over?: number; under?: number }>();
  for (const r of props) {
    if (String(r.bookmaker).toLowerCase() !== SHARP_BOOK) continue;
    const k = `${r.event_id}|${normName(r.player_name)}|${r.market}|${r.line}`;
    const cur = pinPairs.get(k) ?? {};
    if (r.side === "over") cur.over = toNum(r.odds) ?? undefined;
    if (r.side === "under") cur.under = toNum(r.odds) ?? undefined;
    pinPairs.set(k, cur);
  }
  const pinNoVig = new Map<string, { p_over: number; p_under: number }>();
  for (const [k, v] of pinPairs.entries()) {
    if (v.over == null || v.under == null) continue;
    const pO = americanToImpliedProb(v.over);
    const pU = americanToImpliedProb(v.under);
    const denom = pO + pU;
    if (denom <= 0) continue;
    pinNoVig.set(k, { p_over: pO / denom, p_under: pU / denom });
  }

  // 6) Build final rows for soft books
  const out: any[] = [];

  for (const r of props) {
    const book = String(r.bookmaker).toLowerCase();
    if (!SOFT_BOOKS.has(book)) continue;

    const base = baselineByName.get(normName(String(r.player_name)));
    if (!base || !base.canonical) continue;

    // map market
    const market =
      r.market === "player_points" ? "points" :
      r.market === "player_rebounds" ? "rebounds" :
      r.market === "player_assists" ? "assists" :
      r.market === "player_threes" ? "threes" :
      null;
    if (!market) continue;

    const side = r.side === "over" ? "over" : r.side === "under" ? "under" : null;
    const line = toNum(r.line);
    const odds = toNum(r.odds);
    if (!side || line == null || odds == null) continue;

    // context
    const ow = teamToOdds.get(base.canonical);
    const pin_spread_line = ow?.pin_spread_line ?? null;
    const pin_total_line = ow?.pin_total_line ?? null;

    const minutes_factor = minutesFactorFromSpread(pin_spread_line);
    const pace_factor = pin_total_line != null ? clamp(pin_total_line / NBA_AVG_TOTAL, 0.90, 1.10) : null;

    const implied_team_total =
      (pin_total_line != null && pin_spread_line != null)
        ? (pin_total_line / 2) - (pin_spread_line / 2)
        : null;

    const team_total_factor =
      implied_team_total != null ? clamp(implied_team_total / NBA_AVG_TEAM_TOTAL, 0.85, 1.15) : null;

    // minutes mean + adj
    const min_base = weightedAvg(base.min_szn, base.min_7, base.min_15);
    const min_adj = (min_base != null && minutes_factor != null) ? (min_base * minutes_factor) : min_base;

    // per-minute rates
    const rate = (stat_szn: number|null, stat_7: number|null, stat_15: number|null) => {
      const rS  = (stat_szn != null && base.min_szn != null && base.min_szn > 0) ? stat_szn / base.min_szn : null;
      const r7  = (stat_7 != null && base.min_7 != null && base.min_7 > 0) ? stat_7 / base.min_7 : null;
      const r15 = (stat_15 != null && base.min_15 != null && base.min_15 > 0) ? stat_15 / base.min_15 : null;
      return weightedAvg(rS, r7, r15);
    };

    const ptsRate = rate(base.pts_szn, base.pts_7, base.pts_15);
    const rebRate = rate(base.reb_szn, base.reb_7, base.reb_15);
    const astRate = rate(base.ast_szn, base.ast_7, base.ast_15);
    const pm3Rate = rate(base.pm3_szn, base.pm3_7, base.pm3_15);

    const pf = pace_factor ?? 1.0;
    const ttf = team_total_factor ?? 1.0;

    let mu: number | null = null;
    let sigma: number | null = null;
    let p_model: number | null = null;

    if (min_adj != null) {
      if (market === "points" && ptsRate != null) {
        mu = ptsRate * min_adj * ttf;
        sigma = sigmaFromWindows(mu, base.pts_szn, base.pts_7, base.pts_15, "pts");
        const pO = pOverNormal(line, mu, sigma);
        p_model = side === "over" ? pO : 1 - pO;
      } else if (market === "rebounds" && rebRate != null) {
        mu = rebRate * min_adj * pf;
        sigma = sigmaFromWindows(mu, base.reb_szn, base.reb_7, base.reb_15, "reb");
        const pO = pOverNormal(line, mu, sigma);
        p_model = side === "over" ? pO : 1 - pO;
      } else if (market === "assists" && astRate != null) {
        mu = astRate * min_adj * ttf;
        sigma = sigmaFromWindows(mu, base.ast_szn, base.ast_7, base.ast_15, "ast");
        const pO = pOverNormal(line, mu, sigma);
        p_model = side === "over" ? pO : 1 - pO;
      } else if (market === "threes" && pm3Rate != null) {
        mu = pm3Rate * min_adj * ttf;
        sigma = Math.sqrt(Math.max(mu, 0.01));
        const pO = pOverPoisson(line, mu);
        p_model = side === "over" ? pO : 1 - pO;
      }
    }

    if (mu == null || p_model == null) continue;

    const k = `${r.event_id}|${normName(r.player_name)}|${r.market}|${r.line}`;
    const pin = pinNoVig.get(k);
    const p_sharp = pin ? (side === "over" ? pin.p_over : pin.p_under) : null;

    const p_quantum =
      p_sharp != null
        ? clamp(p_model * QUANTUM_BLEND_MODEL + p_sharp * QUANTUM_BLEND_SHARP, 0, 1)
        : p_model;

    const quantum_fair_odds = impliedProbToAmerican(p_quantum);
    const book_implied_prob = americanToImpliedProb(odds);
    const ev_pct_val = evPct(p_quantum, odds);
    const edge = (p_quantum - book_implied_prob) * 100;
    const score = ev_pct_val * 10 + edge;

    out.push({
      run_id,
      created_at: nowIso,
      sport_key: SPORT_KEY,

      event_id: r.event_id,
      commence_time: r.commence_time,
      team: base.canonical,
      opponent: r.opponent ?? null,

      fp_id: base.fp_id,
      player_name: base.player_name,
      position: base.position,
      picture_url: base.picture_url,

      market,
      side,
      line,
      book,
      odds,

      pin_spread_line,
      pin_total_line,
      implied_team_total,
      minutes_factor,
      pace_factor,
      team_total_factor,

      min_base,
      min_adj,
      mu,
      sigma,
      p_model,

      p_sharp,
      p_quantum,
      quantum_fair_odds,

      book_implied_prob,
      ev_pct: ev_pct_val,
      kelly_fraction: kellyFraction(p_quantum, odds),
      score,
    });
  }

  // 7) Reset + insert
  const { error: delErr } = await supabase
    .from("player_prop_ev_latest")
    .delete()
    .eq("sport_key", SPORT_KEY);
  if (delErr) throw delErr;

  const CHUNK = 2000;
  for (let i = 0; i < out.length; i += CHUNK) {
    const batch = out.slice(i, i + CHUNK);
    const { error: insErr } = await supabase.from("player_prop_ev_latest").insert(batch);
    if (insErr) throw insErr;
  }

  console.log(JSON.stringify({ ok: true, run_id, inserted_rows: out.length }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


