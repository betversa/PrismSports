/**
 * ratingsBuilder_nba.ts — B-Ref Schedule → NBA OffRtg / DefRtg using TeamRankings pace (team_possessions)
 * ------------------------------------------------------------------------------------------------------
 * GOAL:
 *  - Build NBA team_ratings using raw (non-opponent-adjusted) OffRtg/DefRtg with REALISTIC pace:
 *      poss_total = poss_pg * games_played
 *      OffRtg = (PF / poss_total) * 100
 *      DefRtg = (PA / poss_total) * 100
 *      NetRtg = OffRtg - DefRtg
 *
 * DATA:
 *  - Games from Basketball-Reference schedule pages (PF/PA, GP)
 *  - Pace from public.team_possessions (TeamRankings):
 *      canonical, sport_key, season, "2025", "2024", "Last 3", "Last 1", "Home", "Away", updated_at
 *
 * TEAM MAP:
 *  - public.team_map:
 *      canonical (text)
 *      SR_School (text)  // exact team name as shown on B-Ref schedule pages
 *
 * OUTPUT:
 *  - public.team_ratings:
 *      engine_adj_off = OffRtg (raw)
 *      engine_adj_def = DefRtg (raw)
 *      engine_power   = NetRtg (raw)
 *      plus: true_hca, fun_factor, sigma_total_100, sigma_margin_100, avg_total_points, avg_margin_points, pf/pa per game
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
  awayPts: number; // raw points (no OT scaling)
  homePts: number; // raw points (no OT scaling)
  suffix: string; // OT marker
  neutral: boolean; // NBA regular season false
};

type TeamGame = {
  team: string; // canonical
  opponent: string; // canonical
  off100: number; // points per 100 (using estimated game possessions from pace table)
  oppOff100: number;
  pts: number;
  pa: number;
  neutral: boolean;
  homeAway: "home" | "away" | "neutral";
  w: number; // recency weight
  gamePoss: number; // estimated possessions for this game
  suffix: string;
};

type TeamPossRow = {
  canonical: string;
  sport_key: string;
  season: string;
  // columns are weird strings like "2025", "Last 3", etc.
  [k: string]: any;
};

/* =========================
   CONFIG
========================= */
const SPORT_KEY = process.env.SPORT_KEY || "basketball_nba";
const BR_LEAGUE_YEAR = Number(process.env.NBA_BR_LEAGUE_YEAR || "2025"); // NBA_2025
const SEASON = process.env.SEASON || "2024-25";

const RECENCY_HALF_LIFE_DAYS = 30;
const RECENCY_FLOOR = 0.3;

// HCA model
const HCA_BASE = 3.0;
const HCA_SHRINK = 0.35;
const HCA_MIN = 1.5;
const HCA_MAX = 4.8;
const HCA_MIN_HOME_GAMES = 5;

// fallback if team_possessions missing a team (should be rare)
const DEFAULT_POSS_PG_FALLBACK = Number(process.env.NBA_DEFAULT_POSS || "99");

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

function parseCskDate(csk: string): Date | null {
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

function seasonStartYear(season: string): number | null {
  // "2024-25" -> 2024
  const m = String(season || "").match(/^(\d{4})\s*-\s*(\d{2}|\d{4})$/);
  if (!m) return null;
  return Number(m[1]);
}

function toNullNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
   - completed games only
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

    const awayMatch = tr.match(/data-stat="visitor_team_name"[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
    const homeMatch = tr.match(/data-stat="home_team_name"[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
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
  if (brToCanon.size === 0) throw new Error('team_map has 0 SR_School mappings (SR_School empty).');

  return { canonSet, brToCanon };
}

/* =========================
   DB: LOAD TEAM POSSESSIONS
========================= */
async function loadTeamPossessions(
  supabase: ReturnType<typeof createClient>
): Promise<Map<string, TeamPossRow>> {
  const { data, error } = await supabase
    .from("team_possessions")
    .select("*")
    .eq("sport_key", SPORT_KEY)
    .eq("season", SEASON);

  if (error) throw error;

  const m = new Map<string, TeamPossRow>();
  for (const r of (data || []) as any[]) {
    const canon = String(r.canonical || "").trim();
    if (!canon) continue;
    m.set(canon, r as TeamPossRow);
  }
  return m;
}

function pickPossColumnForSeason(season: string): string | null {
  // Use season start year column: "2024-25" -> "2024"
  const y = seasonStartYear(season);
  if (!y) return null;
  return String(y);
}

function possPgForTeam(possMap: Map<string, TeamPossRow>, canonical: string): number {
  const row = possMap.get(canonical);
  const col = pickPossColumnForSeason(SEASON);
  if (row && col && row[col] != null) {
    const v = toNullNum(row[col]);
    if (v != null && v > 40 && v < 130) return v;
  }
  // fallback to Home/Away/Last 3 etc if you want later — for now keep it stable
  return DEFAULT_POSS_PG_FALLBACK;
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

      if (!maxDate || g.date > maxDate) maxDate = g.date;

      games.push({
        season: SEASON,
        date: g.date,
        away: cAway,
        home: cHome,
        awayPts: g.awayPts, // raw points
        homePts: g.homePts, // raw points
        suffix: g.ot || "",
        neutral: false,
      });
    }
  }

  if (!games.length) throw new Error("[NBA] No valid games after SR_School->canonical mapping.");
  if (!maxDate) throw new Error("[NBA] No maxDate computed.");

  return { games, maxDate };
}

/* =========================
   TEAM LIST
========================= */
function getTeamsFromGames(games: BrGame[]): string[] {
  const set = new Set<string>();
  for (const g of games) {
    set.add(g.away);
    set.add(g.home);
  }
  return Array.from(set).sort();
}

/* =========================
   AGG: PF/PA/GP
========================= */
function computePfPaGp(games: BrGame[], teams: string[]) {
  const pfTot = new Map<string, number>();
  const paTot = new Map<string, number>();
  const gp = new Map<string, number>();
  const homeGp = new Map<string, number>();

  for (const t of teams) {
    pfTot.set(t, 0);
    paTot.set(t, 0);
    gp.set(t, 0);
    homeGp.set(t, 0);
  }

  for (const g of games) {
    // away
    pfTot.set(g.away, (pfTot.get(g.away) || 0) + g.awayPts);
    paTot.set(g.away, (paTot.get(g.away) || 0) + g.homePts);
    gp.set(g.away, (gp.get(g.away) || 0) + 1);

    // home
    pfTot.set(g.home, (pfTot.get(g.home) || 0) + g.homePts);
    paTot.set(g.home, (paTot.get(g.home) || 0) + g.awayPts);
    gp.set(g.home, (gp.get(g.home) || 0) + 1);
    homeGp.set(g.home, (homeGp.get(g.home) || 0) + 1);
  }

  return { pfTot, paTot, gp, homeGp };
}

/* =========================
   BUILD TEAM-GAMES (for fun/sigmas)
   gamePoss = avg(team poss_pg, opp poss_pg)
========================= */
function buildTeamGames(
  games: BrGame[],
  maxDate: Date,
  possMap: Map<string, TeamPossRow>
) {
  const teamGames: TeamGame[] = [];

  let totalPtsAll = 0;
  let totalPossAll = 0;

  for (const g of games) {
    const w = recencyWeight(g.date, maxDate);

    const possAway = possPgForTeam(possMap, g.away);
    const possHome = possPgForTeam(possMap, g.home);
    const gamePoss = (possAway + possHome) / 2;

    const off100Away = (g.awayPts / gamePoss) * 100;
    const off100Home = (g.homePts / gamePoss) * 100;

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
      gamePoss,
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
      gamePoss,
      suffix: g.suffix,
    });

    totalPtsAll += g.awayPts + g.homePts;
    totalPossAll += gamePoss + gamePoss;
  }

  const leagueAvgOff100 = (totalPtsAll / totalPossAll) * 100;
  return { teamGames, leagueAvgOff100 };
}

/* =========================
   FUN FACTOR + SIGMAS
========================= */
function computeFunAndSigmasFast(
  teamGames: TeamGame[],
  teams: string[],
  leagueAvgOff100: number
) {
  const idx = new Map<string, number>();
  teams.forEach((t, i) => idx.set(t, i));
  const nTeams = teams.length;

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

  for (const g of teamGames) {
    const ti = idx.get(g.team);
    if (ti == null) continue;

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

    const rf = 0.4 * scoringScore + 0.3 * closenessScore + 0.2 * volatilityScore + 0.1 * (otRate * 2);
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

    const hi = idx.get(g.home);
    const ai = idx.get(g.away);
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

  // 1) team map
  const { canonSet, brToCanon } = await loadTeamMapNba(supabase);

  // 2) pace table for this sport+season
  const possMap = await loadTeamPossessions(supabase);

  // 3) games
  const { games, maxDate } = await fetchAllBrGamesStrict(brToCanon, canonSet);

  // 4) teams
  const teams = getTeamsFromGames(games);
  const nTeams = teams.length;

  const idx = new Map<string, number>();
  teams.forEach((t, i) => idx.set(t, i));

  // 5) PF/PA/GP
  const { pfTot, paTot, gp } = computePfPaGp(games, teams);

  // 6) OffRtg/DefRtg using poss_pg from team_possessions
  const offRtgArr: number[] = [];
  const defRtgArr: number[] = [];

  let leaguePf = 0;
  let leaguePa = 0;
  let leaguePossTotal = 0;

  for (const t of teams) {
    const gcount = gp.get(t) || 0;
    const possPg = possPgForTeam(possMap, t);
    const possTotal = possPg * gcount;

    const pf = pfTot.get(t) || 0;
    const pa = paTot.get(t) || 0;

    const off = possTotal > 0 ? (pf / possTotal) * 100 : 0;
    const def = possTotal > 0 ? (pa / possTotal) * 100 : 0;

    offRtgArr.push(off);
    defRtgArr.push(def);

    leaguePf += pf;
    leaguePa += pa;
    leaguePossTotal += possTotal;
  }

  const leagueAvgOff100 = leaguePossTotal > 0 ? (leaguePf / leaguePossTotal) * 100 : 0;

  const engineAdjOff = offRtgArr;
  const engineAdjDef = defRtgArr;
  const enginePower = engineAdjOff.map((o, i) => o - engineAdjDef[i]); // NetRtg

  // 7) teamGames for fun/sigmas using gamePoss from pace table
  const { teamGames } = buildTeamGames(games, maxDate, possMap);
  const { funFactor, sigmaTotal100, sigmaMargin100, avgTotalPoints, avgMarginPoints } =
    computeFunAndSigmasFast(teamGames, teams, leagueAvgOff100);

  // 8) HCA
  const { trueHca, homeGames, signal } = computeTrueHcaFromHomeMargins(games, idx, enginePower);

  // 9) PF/PA per game (simple)
  const pfPg = teams.map((t) => {
    const gcount = gp.get(t) || 0;
    return gcount ? (pfTot.get(t) || 0) / gcount : 0;
  });
  const paPg = teams.map((t) => {
    const gcount = gp.get(t) || 0;
    return gcount ? (paTot.get(t) || 0) / gcount : 0;
  });

  // 10) upsert
  const nowIso = new Date().toISOString();
  const rows: any[] = teams.map((team, i) => ({
    sport_key: SPORT_KEY,
    canonical: team,
    season: SEASON,
    updated_at: nowIso,

    engine_adj_off: round2(engineAdjOff[i]),
    engine_adj_def: round2(engineAdjDef[i]),
    engine_power: round2(enginePower[i]),

    true_hca: round2(trueHca[i]),

    fun_factor: round2(funFactor[i]),
    sigma_total_100: round2(sigmaTotal100[i]),
    sigma_margin_100: round2(sigmaMargin100[i]),
    avg_total_points: round2(avgTotalPoints[i]),
    avg_margin_points: round2(avgMarginPoints[i]),

    pf_points: round2(pfPg[i]),
    pa_points: round2(paPg[i]),
  }));

  rows.sort((a, b) => Number(b.engine_power ?? 0) - Number(a.engine_power ?? 0));
  rows.forEach((r, i) => (r.power_rank = i + 1));

  for (const batch of chunk(rows, 500)) {
    const { error } = await supabase.from("team_ratings").upsert(batch, {
      onConflict: "sport_key,season,canonical",
    });
    if (error) throw error;
  }

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
        poss_source: "team_possessions (TeamRankings)",
        poss_fallback: DEFAULT_POSS_PG_FALLBACK,
        hca: {
          base: HCA_BASE,
          shrink: HCA_SHRINK,
          min: HCA_MIN,
          max: HCA_MAX,
          min_home_games: HCA_MIN_HOME_GAMES,
          assigned_range: { min: round2(Math.min(...trueHca)), max: round2(Math.max(...trueHca)) },
          signal_range: { min: round2(Math.min(...signal)), max: round2(Math.max(...signal)) },
          home_games_range: { min: Math.min(...homeGames), max: Math.max(...homeGames) },
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

