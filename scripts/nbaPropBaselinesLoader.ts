// scripts/nbaPlayerPropEvBuilder.ts
//
// NBA PLAYER PROPS EV BUILDER — SINGLE FINAL TABLE (FULL REWRITE v2: SHARP FIX)
// ---------------------------------------------------------------------------
// ✅ Scrapes FantasyPros season / last7 / last15 for: PTS, REB, AST, 3PM, MIN
// ✅ Uses only those windows to build mean projections + sigma estimate
// ✅ Uses odds_wide_latest (team, pin_spread_line, pin_total_line) to context-adjust minutes + mu
// ✅ Uses player_props_snapshot (your exact schema) for lines/odds/books and event_id/commence_time/opponent
// ✅ ONLY returns players from FUTURE GAMES:
//    - event_id must exist in events table
//    - commence_time must be > now
// ✅ FIX: p_sharp now uses BOTH Pinnacle + BetOnlineAG (avg when both exist)
//    - fallback: Pinnacle-only if BetOnline missing (or BetOnline-only if Pinnacle missing)
//    - still uses nearest-line fallback within tolerance (fills far more cells)
// ✅ Outputs to ONE table: public.player_prop_ev_latest (cleared per run by sport_key)
// ✅ Includes player picture_url
//
// Run: npm run nba:props:ev:build
//
// NOTE: Ensure the SQL table exists (player_prop_ev_latest) with the columns you expect.
//       Optional debug fields are included but commented — enable if your table supports them.

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

// Nearest-line matching tolerance (points, assists, rebounds typical .5 increments)
// (You can bump to 1.5 if you want even more p_sharp fills)
const PIN_LINE_TOLERANCE = 1.0;

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
  team: string;
  pin_spread_line: number | null;
  pin_total_line: number | null;
};

type PropsRow = {
  sport_key: string;
  event_id: string;
  commence_time: string;
  player_name: string;
  player_id: string | null;
  team: string | null;
  opponent: string | null;
  market: string;
  side: string;
  line: number;
  odds: number;
  bookmaker: string;
};

type SharpBook = (typeof SHARP_BOOKS)[number];

type SharpNoVigLine = {
  book: SharpBook;
  line: number;
  p_over: number;
  p_under: number;
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
  // NOTE: signature is (szn, d7, d15) in your original, but you use W.d15 on third arg.
  // We'll keep your intended weighting: szn (a), d7 (b), d15 (c)
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

function normBook(b: any): SharpBook | null {
  const s = String(b || "").toLowerCase().trim();
  if (!s) return null;

  if (s === "pinnacle" || s.includes("pinnacle")) return "pinnacle";
  if (s === "betonlineag" || s.includes("betonline")) return "betonlineag";

  return null;
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
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
      Math.exp(-z * z);
  const sign = z >= 0 ? 1 : -1;
  return 0.5 * (1 + sign * erf);
}

// P(X > line) using continuous approx (push mass ignored)
function pOverNormal(line: number, mu: number, sigma: number): number {
  return clamp(1 - normalCdf(line, mu, sigma), 0, 1);
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
  // baseline sigma scales with mean
  let base =
    kind === "pts"
      ? Math.max(3.0, 0.22 * mu)
      : kind === "reb"
      ? Math.max(1.5, 0.28 * mu)
      : kind === "ast"
      ? Math.max(1.5, 0.30 * mu)
      : Math.max(0.8, 0.45 * Math.max(mu, 0.5));

  // disagreement term
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
  if (spread <= -12) f -= 0.02; // huge favorite rest risk
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
   MAIN
========================================================= */

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!supabaseUrl || !serviceKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const run_id = crypto.randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();

  /* -------------------------------------------------------
     1) Get FUTURE events (defines slate) — games not started
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
  for (const e of (events || []) as any[]) {
    if (!e?.event_id) continue;
    allowedEventIds.add(String(e.event_id));
  }

  // If no future slate, clear output and exit
  if (allowedEventIds.size === 0) {
    const { error: delErr } = await supabase.from("player_prop_ev_latest").delete().eq("sport_key", SPORT_KEY);
    if (delErr) throw delErr;

    console.log(JSON.stringify({ ok: true, run_id, inserted_rows: 0, reason: "no_future_events" }, null, 2));
    return;
  }

  /* -------------------------------------------------------
     2) Pull props snapshot ONLY for future events
        NOTE: We pull ALL books (soft + sharp) because we need
              Pinnacle/BetOnline for p_sharp, then we filter
              to SOFT_BOOKS when outputting playable rows.
  -------------------------------------------------------- */
  const props: PropsRow[] = [];
  const eventIdList = Array.from(allowedEventIds);
  const EVENT_CHUNK = 200;

  for (let i = 0; i < eventIdList.length; i += EVENT_CHUNK) {
    const chunk = eventIdList.slice(i, i + EVENT_CHUNK);

    const { data, error } = await supabase
      .from("player_props_snapshot")
      .select("sport_key,event_id,commence_time,player_name,player_id,team,opponent,market,side,line,odds,bookmaker")
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
     3) Scrape FantasyPros for baselines (szn/7/15)
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
     4) Canonicalize team via team_map."Abbreviation" -> canonical
  -------------------------------------------------------- */
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
    b.canonical = raw ? abbrToCanon.get(raw) ?? raw : null;
  }

  const baselineByName = new Map<string, PlayerBaseline>();
  for (const b of baselines.values()) baselineByName.set(normName(b.player_name), b);

  /* -------------------------------------------------------
     5) Pull odds_wide_latest context (spread/total per team)
  -------------------------------------------------------- */
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

  /* -------------------------------------------------------
     6) Build SHARP no-vig index (Pinnacle + BetOnlineAG)
        key = event|player|market => list of {book,line,p_over,p_under}
  -------------------------------------------------------- */
  const sharpIndex = new Map<string, SharpNoVigLine[]>();

  function idxKey(r: PropsRow) {
    // Keep RAW market string so it matches snapshot structure 1:1
    return `${r.event_id}|${normName(r.player_name)}|${r.market}`;
  }

  // (event|player|market|book|line) -> {over,under}
  const sharpPairs = new Map<string, { book: SharpBook; line: number; over?: number; under?: number }>();

  for (const r of props) {
    const book = normBook(r.bookmaker);
    if (!book) continue;

    const side = String(r.side || "").toLowerCase().trim();
    const line = toNum(r.line);
    const odds = toNum(r.odds);
    if (line == null || odds == null) continue;

    const k = `${idxKey(r)}|${book}|${line}`;
    const cur = sharpPairs.get(k) ?? { book, line };

    if (side === "over") cur.over = odds;
    if (side === "under") cur.under = odds;

    sharpPairs.set(k, cur);
  }

  for (const [k, v] of sharpPairs.entries()) {
    if (v.over == null || v.under == null) continue;

    const pO = americanToImpliedProb(v.over);
    const pU = americanToImpliedProb(v.under);
    const denom = pO + pU;
    if (denom <= 0) continue;

    const baseKey = k.split("|").slice(0, 3).join("|"); // event|player|market
    const arr = sharpIndex.get(baseKey) ?? [];
    arr.push({
      book: v.book,
      line: v.line,
      p_over: pO / denom,
      p_under: pU / denom,
      over_odds: v.over,
      under_odds: v.under,
    });
    sharpIndex.set(baseKey, arr);
  }

  for (const [k, arr] of sharpIndex.entries()) {
    arr.sort((a, b) => {
      if (a.book !== b.book) return a.book.localeCompare(b.book);
      return a.line - b.line;
    });
    sharpIndex.set(k, arr);
  }

  function nearestSharpForBook(arr: SharpNoVigLine[], book: SharpBook, targetLine: number): SharpNoVigLine | null {
    let best: SharpNoVigLine | null = null;
    let bestDist = Infinity;

    for (const cand of arr) {
      if (cand.book !== book) continue;
      const dist = Math.abs(cand.line - targetLine);
      if (dist < bestDist) {
        bestDist = dist;
        best = cand;
      }
    }

    if (!best || bestDist > PIN_LINE_TOLERANCE) return null;
    return best;
  }

  function getSharpNoVigP(r: PropsRow): {
    p_sharp: number | null;
    sharp_line_used: number | null;
    sharp_books_used: string | null; // "pinnacle", "betonlineag", "pinnacle+betonlineag"
  } {
    const arr = sharpIndex.get(idxKey(r));
    if (!arr || arr.length === 0) return { p_sharp: null, sharp_line_used: null, sharp_books_used: null };

    const target = toNum(r.line);
    if (target == null) return { p_sharp: null, sharp_line_used: null, sharp_books_used: null };

    const pin = nearestSharpForBook(arr, "pinnacle", target);
    const bol = nearestSharpForBook(arr, "betonlineag", target);

    const side = String(r.side || "").toLowerCase().trim();
    const pickP = (x: SharpNoVigLine | null) => {
      if (!x) return null;
      if (side === "over") return x.p_over;
      if (side === "under") return x.p_under;
      return null;
    };

    const pPin = pickP(pin);
    const pBol = pickP(bol);

    if (pPin != null && pBol != null) {
      return {
        p_sharp: clamp((pPin + pBol) / 2, 0, 1),
        sharp_line_used: pin?.line ?? bol?.line ?? null,
        sharp_books_used: "pinnacle+betonlineag",
      };
    }

    if (pPin != null) {
      return { p_sharp: clamp(pPin, 0, 1), sharp_line_used: pin?.line ?? null, sharp_books_used: "pinnacle" };
    }

    if (pBol != null) {
      return { p_sharp: clamp(pBol, 0, 1), sharp_line_used: bol?.line ?? null, sharp_books_used: "betonlineag" };
    }

    return { p_sharp: null, sharp_line_used: null, sharp_books_used: null };
  }

  /* -------------------------------------------------------
     7) Build final EV rows (SOFT books only)
  -------------------------------------------------------- */

  const out: any[] = [];

  for (const r of props) {
    // Safety: only future slate
    const eid = String(r.event_id || "");
    if (!allowedEventIds.has(eid)) continue;

    const ct = r.commence_time ? new Date(r.commence_time) : null;
    if (!ct || !(ct.getTime() > now.getTime())) continue;

    const book = String(r.bookmaker).toLowerCase().trim();
    if (!SOFT_BOOKS.has(book)) continue;

    const playerNameRaw = String(r.player_name || "").trim();
    if (!playerNameRaw) continue;

    const base = baselineByName.get(normName(playerNameRaw));
    if (!base || !base.canonical) continue;

    // Market mapping (your output market names)
    const market =
      r.market === "player_points"
        ? "points"
        : r.market === "player_rebounds"
        ? "rebounds"
        : r.market === "player_assists"
        ? "assists"
        : r.market === "player_threes"
        ? "threes"
        : null;
    if (!market) continue;

    const side = String(r.side || "").toLowerCase().trim();
    if (side !== "over" && side !== "under") continue;

    const line = toNum(r.line);
    const odds = toNum(r.odds);
    if (line == null || odds == null) continue;

    // Context from odds_wide_latest by canonical team
    const ow = teamToOdds.get(base.canonical);
    const pin_spread_line = ow?.pin_spread_line ?? null;
    const pin_total_line = ow?.pin_total_line ?? null;

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

    // Build mu/sigma/p_model
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

    // SHARP no-vig (Pinnacle + BetOnlineAG) with nearest-line fallback
    const { p_sharp, sharp_line_used, sharp_books_used } = getSharpNoVigP(r);

    // Quantum probability
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

      // OPTIONAL DEBUG (enable only if your SQL has these columns)
      // sharp_line_used,
      // sharp_books_used,
    });
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

  // Quick diagnostics so you can confirm p_sharp fill improved
  let sharpFilled = 0;
  let sharpNull = 0;
  for (const r of out) {
    if (r.p_sharp == null) sharpNull++;
    else sharpFilled++;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        run_id,
        inserted_rows: out.length,
        p_sharp_filled: sharpFilled,
        p_sharp_null: sharpNull,
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

