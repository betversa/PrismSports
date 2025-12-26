/**
 * ratingsBuilder_nba.ts — Basketball-Reference Schedule → NBA OffRtg / DefRtg (Per-100 Possessions, non-adjusted)
 * ------------------------------------------------------------------------------------------------------------
 * GOAL:
 *  - Build NBA team_ratings using simple (non-opponent-adjusted) season OffRtg and DefRtg:
 *      OffRtg = (PF / Poss) * 100
 *      DefRtg = (PA / Poss) * 100
 *      NetRtg = OffRtg - DefRtg
 *
 * DATA SOURCE:
 *  - Basketball-Reference monthly schedule pages, e.g.
 *    https://www.basketball-reference.com/leagues/NBA_2025_games-october.html
 *    ...-november.html, ...-december.html, etc.
 *
 * REQUIRED DB TABLE:
 *  - public.team_map:
 *      canonical (text, unique)
 *      SR_School (text)  // exact team name from B-Ref schedule pages (as you're using now)
 *
 * OUTPUT TABLE:
 *  - public.team_ratings (sport-aware):
 *      sport_key, season, canonical,
 *      engine_adj_off  -> OffRtg (raw)
 *      engine_adj_def  -> DefRtg (raw)
 *      engine_power    -> NetRtg (raw)
 *      true_hca, pf_points, pa_points, avg_total_points,
 *      sigma_margin_100, sigma_total_100, fun_factor, power_rank, updated_at
 *
 * NOTES:
 *  - B-Ref may 403 in GitHub Actions. We set headers + retries.
 *  - We only use completed games (visitor_pts/home_pts must be present).
 *  - Possessions are estimated with a constant (DEFAULT_LEAGUE_AVG_POSS) and OT scaling,
 *    consistent with your previous NCAA-style approach.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

/* =========================
   TYPES
========================= */
type BrGame = {
  season: string;
  date: Date;
  away: string; // canonical
  home: string; // canonical
  awayPts: number; // OT-scaled to regulation-equivalent points
  homePts: number; // OT-scaled to regulation-equivalent points
  suffix: string; // OT marker (e.g., "OT", "2OT")
  neutral: boolean; // NBA regular season false
  gamePoss: number; // estimated possessions (regulation-equivalent)
};

type TeamGame = {
  team: string; // canonical
  opponent: string; // canonical
  off100: number; // per-game offensive points per 100 poss (using estimated poss)
  oppOff100: number; // opponent per-game offensive points per 100 poss
  pts: number;
  pa: number;
  neutral: boolean;
  homeAway: "home" | "away" | "neutral";
  w: number; // recency weight
  poss: number;
  suffix: string;
};

/* =========================
   CONFIG
========================= */
const SPORT_KEY = process.env.SPORT_KEY || "basketball_nba";

// NBA_2025 == 2024-25 season on Basketball-Reference
const BR_LEAGUE_YEAR = Number(process.env.NBA_BR_LEAGUE_YEAR || "2025"); // NBA_2025
const SEASON = process.env.SEASON || "2024-25";

// possessions fallback (NBA pace is ~99–101; use a constant)
const DEFAULT_LEAGUE_AVG_POSS = Number(process.env.NBA_DEFAULT_POSS || "99");

// recency weighting (used only for fun/sigmas; OffRtg/DefRtg is season aggregate)
const RECENCY_HALF_LIFE_DAYS = 30;
const RECENCY_FLOOR = 0.3;

// HCA model (margin-based)
const HCA_BASE = 3.0;
const HCA_SHRINK = 0.35;
const HCA_MIN = 1.5;
const HCA_MAX = 4.8;
const HCA_MIN_HOME_GAMES = 5;

// months to try (B-Ref pages exist by month name)
const MONTHS = [
  "october",
  "november",
  "december",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
] as const;

/* =========================
   HELPERS
========================= */
function normalizeKey(s: string) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\u00a0/g, " ")
    .replace(/[’‘]/g, "'")
    .replace(/&/g, "and")
    .replace(/[\.\'’]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ");
}

function round2(x: any): number {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}

function average(arr: number[]) {
  if (!arr.length) return 0;
  let s = 0;
  for (const x of arr) s += x;
  return s / arr.length;
}

function recencyWeight(gameDate: Date, maxDate: Date): number {
  const ageDays = (maxDate.getTime() - gameDate.getTime()) / 86400000;
  if (ageDays <= 0) return 1.0;
  const w = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  return Math.max(RECENCY_FLOOR, w);
}

function computeNumOT(otCell: string): number {
  const s = String(otCell || "").trim().toUpperCase();
  if (!s) return 0;
  // Common patterns: "OT", "2OT", "3OT"
  const m = s.match(/^(\d+)\s*OT$/i);
  if (m?.[1]) return parseInt(m[1], 10);
  if (s === "OT") return 1;
  return 0;
}

function parseCskDate(csk: string): Date | null {
  // e.g. csk="202410220BOS" -> YYYYMMDD...
  const m = String(csk || "").match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  return Number.isFinite(d.getTime()) ? d : null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* =========================
   FETCH (with retries)
========================= */
async function fetchHtmlWithRetries(url: string, maxTries = 4): Promise<string> {
  let lastErr: any = null;

  for (let t = 1; t <= maxTries; t++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} for ${url} :: ${body.slice(0, 180)}`);
      }
      return await res.text();
    } catch (e) {
      lastErr = e;
      const ms = 750 * t * t;
      await new Promise((r) => setTimeout(r, ms));
    }
  }

  throw lastErr;
}

/* =========================
   PARSE B-REF MONTH PAGE
========================= */
function parseBrMonth(html: string) {
  const rows: Array<{
    date: Date;
    awayName: string;
    awayPts: number;
    homeName: string;
    homePts: number;
    ot: string;
  }> = [];

  const trMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (const tr of trMatches) {
    const cskMatch = tr.match(/data-stat="date_game"[^>]*csk="([^"]+)"/i);
    if (!cskMatch?.[1]) continue;

    const date = parseCskDate(cskMatch[1]);
    if (!date) continue;

    const awayMatch = tr.match(
      /data-stat="visitor_team_name"[\s\S]*?<a[^>]*>([^<]+)<\/a>/i
    );
    const homeMatch = tr.match(
      /data-stat="home_team_name"[\s\S]*?<a[^>]*>([^<]+)<\/a>/i
    );
    if (!awayMatch?.[1] || !homeMatch?.[1]) continue;

    const awayName = awayMatch[1].trim();
    const homeName = homeMatch[1].trim();

    const awayPtsMatch = tr.match(/data-stat="visitor_pts"[^>]*>(\d+)</i);
    const homePtsMatch = tr.match(/data-stat="home_pts"[^>]*>(\d+)</i);
    if (!awayPtsMatch?.[1] || !homePtsMatch?.[1]) continue;

    const awayPts = Number(awayPtsMatch[1]);
    const homePts = Number(homePtsMatch[1]);
    if (!Number.isFinite(awayPts) || !Number.isFinite(homePts)) continue;

    const otMatch = tr.match(/data-stat="overtimes"[^>]*>([^<]*)</i);
    const ot = (otMatch?.[1] || "").trim();

    rows.push({ date, awayName, awayPts, homeName, homePts, ot });
  }

  return rows;
}

/* =========================
   DB: LOAD TEAM MAP (NBA)
   Using team_map.SR_School as requested
========================= */
async function loadTeamMapNba(
  supabase: ReturnType<typeof createClient>
): Promise<{ canonSet: Set<string>; brToCanon: Map<string, string> }> {
  const { data, error } = await supabase
    .from("team_map")
    .select('canonical,"SR_School"')
    .not("canonical", "is", null);

  if (error) throw error;

  const canonSet = new Set<string>();
  const brToCanon = new Map<string, string>();

  for (const r of (data || []) as any[]) {
    const canonical = String(r.canonical || "").trim();
    if (!canonical) continue;
    canonSet.add(canonical);

    const brName = String(r.SR_School || "").trim();
    if (brName) brToCanon.set(normalizeKey(brName), canonical);
  }

  if (canonSet.size === 0) throw new Error("team_map has 0 canonical rows.");
  if (brToCanon.size === 0)
    throw new Error('team_map has 0 SR_School mappings (SR_School column empty).');

  return { canonSet, brToCanon };
}

/* =========================
   FETCH ALL GAMES (STRICT MAPPING)
========================= */
async function fetchAllBrGamesStrict(
  brToCanon: Map<string, string>,
  canonSet: Set<string>
): Promise<{ games: BrGame[]; maxDate: Date }> {
  const games: BrGame[] = [];
  let maxDate: Date | null = null;

  for (const month of MONTHS) {
    const url = `https://www.basketball-reference.com/leagues/NBA_${BR_LEAGUE_YEAR}_games-${month}.html`;

    let html = "";
    try {
      html = await fetchHtmlWithRetries(url, 4);
    } catch (e) {
      console.warn(`[NBA] Skip month=${month} (fetch failed):`, (e as any)?.message || e);
      continue;
    }

    const parsed = parseBrMonth(html);
    if (!parsed.length) continue;

    for (const g of parsed) {
      const cAway = brToCanon.get(normalizeKey(g.awayName));
      const cHome = brToCanon.get(normalizeKey(g.homeName));
      if (!cAway || !cHome) continue;

      if (!canonSet.has(cAway) || !canonSet.has(cHome)) continue;

      const numOT = computeNumOT(g.ot);
      // NBA regulation 48 minutes; each OT is 5 minutes
      const possScale = numOT > 0 ? 48 / (48 + 5 * numOT) : 1.0;

      // "regulation-equivalent" scaling consistent with prior script
      const regPoss = DEFAULT_LEAGUE_AVG_POSS * possScale;
      const regAwayPts = g.awayPts * possScale;
      const regHomePts = g.homePts * possScale;

      if (!maxDate || g.date > maxDate) maxDate = g.date;

      games.push({
        season: SEASON,
        date: g.date,
        away: cAway,
        home: cHome,
        awayPts: regAwayPts,
        homePts: regHomePts,
        suffix: g.ot || "",
        neutral: false,
        gamePoss: regPoss,
      });
    }
  }

  if (!games.length) {
    throw new Error(
      "[NBA] No valid games after strict SR_School->canonical mapping. Check team_map coverage or B-Ref blocking."
    );
  }
  if (!maxDate) throw new Error("[NBA] No maxDate computed.");

  return { games, maxDate };
}

/* =========================
   TEAM-GAMES + LEAGUE AVG (for sigmas/fun)
========================= */
function buildTeamGames(games: BrGame[], maxDate: Date) {
  const teamGames: TeamGame[] = [];
  let totalPtsAll = 0;
  let totalPossAll = 0;

  for (const g of games) {
    const w = recencyWeight(g.date, maxDate);

    const off100Away = (g.awayPts / g.gamePoss) * 100;
    const off100Home = (g.homePts / g.gamePoss) * 100;

    teamGames.push({
      team: g.away,
      opponent: g.home,
      off100: off100Away,
      oppOff100: off100Home,
      pts: g.awayPts,
      pa: g.homePts,
      neutral: g.neutral,
      homeAway: g.neutral ? "neutral" : "away",
      w,
      poss: g.gamePoss,
      suffix: g.suffix,
    });

    teamGames.push({
      team: g.home,
      opponent: g.away,
      off100: off100Home,
      oppOff100: off100Away,
      pts: g.homePts,
      pa: g.awayPts,
      neutral: g.neutral,
      homeAway: g.neutral ? "neutral" : "home",
      w,
      poss: g.gamePoss,
      suffix: g.suffix,
    });

    totalPtsAll += g.awayPts + g.homePts;
    totalPossAll += g.gamePoss + g.gamePoss;
  }

  const leagueAvgOff100 = (totalPtsAll / totalPossAll) * 100;
  return { teamGames, leagueAvgOff100 };
}

/* =========================
   OFFRTG / DEFRTG AGGREGATION
========================= */
function computeTeamOffDefRtg(games: BrGame[], teams: string[]) {
  const pf = new Map<string, number>();
  const pa = new Map<string, number>();
  const poss = new Map<string, number>();

  for (const t of teams) {
    pf.set(t, 0);
    pa.set(t, 0);
    poss.set(t, 0);
  }

  for (const g of games) {
    poss.set(g.away, (poss.get(g.away) || 0) + g.gamePoss);
    poss.set(g.home, (poss.get(g.home) || 0) + g.gamePoss);

    pf.set(g.away, (pf.get(g.away) || 0) + g.awayPts);
    pa.set(g.away, (pa.get(g.away) || 0) + g.homePts);

    pf.set(g.home, (pf.get(g.home) || 0) + g.homePts);
    pa.set(g.home, (pa.get(g.home) || 0) + g.awayPts);
  }

  const offRtg = new Map<string, number>();
  const defRtg = new Map<string, number>();

  for (const t of teams) {
    const p = poss.get(t) || 0;
    offRtg.set(t, p > 0 ? ((pf.get(t) || 0) / p) * 100 : 0);
    defRtg.set(t, p > 0 ? ((pa.get(t) || 0) / p) * 100 : 0);
  }

  return { offRtg, defRtg, pf, pa, poss };
}

/* =========================
   TRUE HCA (MARGIN-BASED)
========================= */
function computeTrueHcaFromHomeMargins(
  games: BrGame[],
  idx: Map<string, number>,
  enginePower: number[]
) {
  const nTeams = enginePower.length;

  const sumDelta = new Array<number>(nTeams).fill(0);
  const cntHome = new Array<number>(nTeams).fill(0);

  for (const g of games) {
    if (g.neutral) continue;

    const home = g.home;
    const away = g.away;

    const hi = idx.get(home);
    const ai = idx.get(away);
    if (hi === undefined || ai === undefined) continue;

    const actualMargin = g.homePts - g.awayPts;
    const expectedMargin = enginePower[hi] - enginePower[ai];

    const delta = actualMargin - expectedMargin;

    sumDelta[hi] += delta;
    cntHome[hi] += 1;
  }

  const signal = new Array<number>(nTeams).fill(0);
  const trueHca = new Array<number>(nTeams).fill(HCA_BASE);

  for (let t = 0; t < nTeams; t++) {
    if (cntHome[t] >= 1) signal[t] = sumDelta[t] / cntHome[t];

    if (cntHome[t] < HCA_MIN_HOME_GAMES) {
      trueHca[t] = HCA_BASE;
    } else {
      const raw = HCA_BASE + HCA_SHRINK * signal[t];
      trueHca[t] = clamp(raw, HCA_MIN, HCA_MAX);
    }
  }

  return { trueHca, homeGames: cntHome, signal };
}

/* =========================
   FUN FACTOR + SIGMAS + AVERAGES (per team)
========================= */
function computeFunAndSigmasFast(
  teamGames: TeamGame[],
  nTeams: number,
  teamIdx: number[],
  leagueAvgOff100: number
) {
  const nGames = teamGames.length;

  const totalPer100Sum = new Array<number>(nTeams).fill(0);
  const totalPer100Sq = new Array<number>(nTeams).fill(0);
  const totalRawSum = new Array<number>(nTeams).fill(0);

  const closeSum = new Array<number>(nTeams).fill(0);

  const marginSignedPer100Sum = new Array<number>(nTeams).fill(0);
  const marginSignedPer100Sq = new Array<number>(nTeams).fill(0);

  const marginAbsPer100Sum = new Array<number>(nTeams).fill(0);
  const marginAbsPer100Sq = new Array<number>(nTeams).fill(0);

  const marginSignedRawSum = new Array<number>(nTeams).fill(0);
  const gameCount = new Array<number>(nTeams).fill(0);
  const otCount = new Array<number>(nTeams).fill(0);

  for (let i = 0; i < nGames; i++) {
    const g = teamGames[i];
    const ti = teamIdx[i];

    const totalPer100 = g.off100 + g.oppOff100;
    const signedMargin100 = g.off100 - g.oppOff100;
    const absMargin100 = Math.abs(signedMargin100);

    const totalRaw = g.pts + g.pa;
    const signedMarginRaw = g.pts - g.pa;

    const closeGame = Math.max(0, 1 - absMargin100 / 25);
    const otFlag = /OT/i.test(g.suffix || "") ? 1 : 0;

    totalPer100Sum[ti] += totalPer100;
    totalPer100Sq[ti] += totalPer100 * totalPer100;
    totalRawSum[ti] += totalRaw;

    marginSignedPer100Sum[ti] += signedMargin100;
    marginSignedPer100Sq[ti] += signedMargin100 * signedMargin100;

    marginAbsPer100Sum[ti] += absMargin100;
    marginAbsPer100Sq[ti] += absMargin100 * absMargin100;

    marginSignedRawSum[ti] += signedMarginRaw;

    closeSum[ti] += closeGame;
    gameCount[ti] += 1;
    otCount[ti] += otFlag;
  }

  const leagueAvgTotal100 = 2 * leagueAvgOff100;

  const sigmaTotal100 = new Array<number>(nTeams).fill(0);
  const sigmaMargin100 = new Array<number>(nTeams).fill(0);
  const avgTotalPoints = new Array<number>(nTeams).fill(0);
  const avgMarginPoints = new Array<number>(nTeams).fill(0);

  const rawFun = new Array<number>(nTeams).fill(0);
  let minFun: number | null = null;
  let maxFun: number | null = null;

  for (let t = 0; t < nTeams; t++) {
    const gc = gameCount[t];
    if (!gc) continue;

    const meanTotalPer100 = totalPer100Sum[t] / gc;
    const meanTotalPer100Sq = totalPer100Sq[t] / gc;
    const varTotal = Math.max(0, meanTotalPer100Sq - meanTotalPer100 * meanTotalPer100);
    sigmaTotal100[t] = Math.sqrt(varTotal);

    const meanMarginSigned = marginSignedPer100Sum[t] / gc;
    const meanMarginSignedSq = marginSignedPer100Sq[t] / gc;
    const varMarginSigned = Math.max(0, meanMarginSignedSq - meanMarginSigned * meanMarginSigned);
    sigmaMargin100[t] = Math.sqrt(varMarginSigned);

    avgTotalPoints[t] = totalRawSum[t] / gc;
    avgMarginPoints[t] = marginSignedRawSum[t] / gc;

    const scoringScore = meanTotalPer100 / leagueAvgTotal100;
    const closenessScore = closeSum[t] / gc;

    const meanAbs = marginAbsPer100Sum[t] / gc;
    const meanAbsSq = marginAbsPer100Sq[t] / gc;
    const varAbs = Math.max(0, meanAbsSq - meanAbs * meanAbs);
    const stdAbs = Math.sqrt(varAbs);
    const volatilityScore = stdAbs / 10.0;

    const otRate = otCount[t] / gc;

    const rf =
      0.4 * scoringScore +
      0.3 * closenessScore +
      0.2 * volatilityScore +
      0.1 * (otRate * 2);

    rawFun[t] = rf;
    minFun = minFun === null ? rf : Math.min(minFun, rf);
    maxFun = maxFun === null ? rf : Math.max(maxFun, rf);
  }

  const funFactor = new Array<number>(nTeams).fill(10);
  if (minFun !== null && maxFun !== null && maxFun > minFun) {
    const span = maxFun - minFun;
    for (let t = 0; t < nTeams; t++) {
      const norm = (rawFun[t] - minFun) / span;
      funFactor[t] = 20 * norm;
    }
  }

  return { funFactor, sigmaTotal100, sigmaMargin100, avgTotalPoints, avgMarginPoints };
}

/* =========================
   PF / PA PER GAME (TEAM-LEVEL)
========================= */
function computePfPaPerGame(games: BrGame[], teams: string[]) {
  const pfTot = new Map<string, number>();
  const paTot = new Map<string, number>();
  const gp = new Map<string, number>();

  for (const t of teams) {
    pfTot.set(t, 0);
    paTot.set(t, 0);
    gp.set(t, 0);
  }

  for (const g of games) {
    pfTot.set(g.away, (pfTot.get(g.away) || 0) + g.awayPts);
    paTot.set(g.away, (paTot.get(g.away) || 0) + g.homePts);
    gp.set(g.away, (gp.get(g.away) || 0) + 1);

    pfTot.set(g.home, (pfTot.get(g.home) || 0) + g.homePts);
    paTot.set(g.home, (paTot.get(g.home) || 0) + g.awayPts);
    gp.set(g.home, (gp.get(g.home) || 0) + 1);
  }

  const pfPg = new Map<string, number>();
  const paPg = new Map<string, number>();

  for (const t of teams) {
    const gcount = gp.get(t) || 0;
    pfPg.set(t, gcount ? (pfTot.get(t) || 0) / gcount : 0);
    paPg.set(t, gcount ? (paTot.get(t) || 0) / gcount : 0);
  }

  return { pfPg, paPg };
}

/* =========================
   MAIN
========================= */
async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing env vars: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // 1) NBA universe
  const { canonSet, brToCanon } = await loadTeamMapNba(supabase);

  // 2) Fetch + parse B-Ref schedule pages (strict mapped games only)
  const { games, maxDate } = await fetchAllBrGamesStrict(brToCanon, canonSet);

  // 3) Build team-games + league avg (for fun/sigma metrics)
  const { teamGames, leagueAvgOff100 } = buildTeamGames(games, maxDate);

  // 4) Teams list + indices
  const teamSet = new Set<string>();
  for (const tg of teamGames) teamSet.add(tg.team);
  const teams = Array.from(teamSet).sort();
  const nTeams = teams.length;

  const idx = new Map<string, number>();
  teams.forEach((t, i) => idx.set(t, i));

  const teamIdx = teamGames.map((tg) => idx.get(tg.team) ?? -1);

  // 5) OffRtg / DefRtg (raw, non-adjusted)
  const { offRtg, defRtg } = computeTeamOffDefRtg(games, teams);

  const engineAdjOff = teams.map((t) => offRtg.get(t) || 0); // OffRtg stored in engine_adj_off
  const engineAdjDef = teams.map((t) => defRtg.get(t) || 0); // DefRtg stored in engine_adj_def
  const enginePower = engineAdjOff.map((o, i) => o - engineAdjDef[i]); // NetRtg

  // 6) HCA (uses NetRtg-based expectation)
  const { trueHca, homeGames, signal } = computeTrueHcaFromHomeMargins(games, idx, enginePower);

  // 7) Fun + sigmas + averages
  const { funFactor, sigmaTotal100, sigmaMargin100, avgTotalPoints, avgMarginPoints } =
    computeFunAndSigmasFast(teamGames, nTeams, teamIdx, leagueAvgOff100);

  // 8) PF/PA per game
  const { pfPg, paPg } = computePfPaPerGame(games, teams);

  // 9) Build upsert rows
  const nowIso = new Date().toISOString();

  const rows: any[] = teams.map((team, i) => ({
    sport_key: SPORT_KEY,
    canonical: team,
    season: SEASON,
    updated_at: nowIso,

    // Raw NBA Ratings
    engine_adj_off: round2(engineAdjOff[i]), // OffRtg
    engine_adj_def: round2(engineAdjDef[i]), // DefRtg
    engine_power: round2(enginePower[i]), // NetRtg

    true_hca: round2(trueHca[i]),

    fun_factor: round2(funFactor[i]),
    sigma_total_100: round2(sigmaTotal100[i]),
    sigma_margin_100: round2(sigmaMargin100[i]),
    avg_total_points: round2(avgTotalPoints[i]),
    avg_margin_points: round2(avgMarginPoints[i]),

    pf_points: round2(pfPg.get(team) || 0),
    pa_points: round2(paPg.get(team) || 0),
  }));

  rows.sort((a, b) => Number(b.engine_power ?? 0) - Number(a.engine_power ?? 0));
  rows.forEach((r, i) => (r.power_rank = i + 1));

  // 10) Upsert into team_ratings
  for (const batch of chunk(rows, 500)) {
    const { error } = await supabase.from("team_ratings").upsert(batch, {
      onConflict: "sport_key,season,canonical",
    });
    if (error) throw error;
  }

  const hcaMin = Math.min(...trueHca);
  const hcaMax = Math.max(...trueHca);
  const sigMin = Math.min(...signal);
  const sigMax = Math.max(...signal);
  const homeMin = Math.min(...homeGames);
  const homeMax = Math.max(...homeGames);

  console.log(
    JSON.stringify(
      {
        ok: true,
        sport_key: SPORT_KEY,
        season: SEASON,
        br_league_year: BR_LEAGUE_YEAR,
        teams_rated: rows.length,
        games_used: games.length,
        leagueAvgOff100: round2(leagueAvgOff100),
        poss_assumption: DEFAULT_LEAGUE_AVG_POSS,
        hca: {
          base: HCA_BASE,
          shrink: HCA_SHRINK,
          min: HCA_MIN,
          max: HCA_MAX,
          min_home_games: HCA_MIN_HOME_GAMES,
          assigned_range: { min: round2(hcaMin), max: round2(hcaMax) },
          signal_range: { min: round2(sigMin), max: round2(sigMax) },
          home_games_range: { min: homeMin, max: homeMax },
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
