/**
 * ratingsBuilder.ts — NCAAB KenPom → Opponent-Adjusted Ratings (Per-100 Possessions)
 * ---------------------------------------------------------------------------------
 * Writes to: public.team_ratings
 * Keyed by: (sport_key, canonical, season)
 *
 * Key upgrade in this rewrite:
 * ✅ Uses team_possessions pace to estimate game possessions:
 *    gamePoss = avg(poss(team), poss(opponent))
 *    then OT-scaled to 40-min equivalent
 *
 * Still:
 * ✅ Strict mapping: BOTH teams must map via team_map."KenPom" -> canonical
 * ✅ Opponent-adjusted Off/Def solve in per-100 space
 * ✅ Chunked upserts to team_ratings
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

/* =========================
   TYPES
========================= */
type KpParsedLine = {
  dateStr: string;
  team1Raw: string;
  team2Raw: string;
  score1: number;
  score2: number;
  suffix: string;
};

type KpGame = {
  season: string;
  date: Date;

  team1: string; // canonical (AWAY in kenpom file)
  team2: string; // canonical (HOME in kenpom file) unless neutral

  score1: number; // regulation-equivalent points
  score2: number;

  suffix: string;
  neutral: boolean;

  gamePoss: number; // regulation-equivalent possessions estimate
};

type TeamGame = {
  team: string; // canonical
  opponent: string; // canonical

  off100: number; // points per 100 possessions scored by team
  oppOff100: number; // points per 100 possessions scored by opponent

  pts: number; // regulation-equivalent PF
  pa: number;  // regulation-equivalent PA

  neutral: boolean;
  homeAway: "home" | "away" | "neutral";

  w: number; // recency weight
  poss: number; // regulation-equivalent possessions
  suffix: string;
};

type TeamPossRow = {
  canonical: string;
  sport_key: string;
  season: string;
  [k: string]: any; // dynamic columns like "2025", "2024", "Last 3", etc.
};

/* =========================
   CONFIG
========================= */
const KP_URL = process.env.KP_URL ?? "https://kenpom.com/cbbga26.txt";

const SPORT_KEY = process.env.SPORT_KEY ?? "basketball_ncaab";
const SEASON = process.env.SEASON ?? "2025-26";

// Fallback if a team is missing in team_possessions
const DEFAULT_LEAGUE_AVG_POSS = Number(process.env.DEFAULT_LEAGUE_AVG_POSS ?? "70");

// solver + weighting
const MAX_ITER = 1000;
const TOL = 1e-6;
const MARGIN_CAP_100 = 25;
const PRIOR_GAMES = 5;

const RECENCY_HALF_LIFE_DAYS = 30;
const RECENCY_FLOOR = 0.3;

// HCA model (margin-based)
const HCA_BASE = 3.0;
const HCA_SHRINK = 0.35;
const HCA_MIN = 1.5;
const HCA_MAX = 4.8;
const HCA_MIN_HOME_GAMES = 5;

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

function toNullNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseMMDDYYYY(s: string): Date | null {
  const m = String(s || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  return Number.isFinite(d.getTime()) ? d : null;
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

function computeNumOT(suffix: string): number {
  const s = String(suffix || "").toUpperCase();
  if (!s.includes("OT")) return 0;
  const m = s.match(/(\d+)\s*OT/i);
  if (m?.[1]) return parseInt(m[1], 10);
  return 1;
}

function isNeutralFromSuffix(suffix: string): boolean {
  // KenPom uses "N", "1N", etc
  return /\b[0-9]*\s*[Nn]\b/.test(suffix) || /\b[0-9]*[Nn]$/.test(suffix);
}

function seasonStartYear(season: string): number | null {
  const m = String(season || "").match(/^(\d{4})\s*-\s*(\d{2}|\d{4})$/);
  if (!m) return null;
  return Number(m[1]);
}

function pickPossColumnForSeason(season: string): string | null {
  const y = seasonStartYear(season);
  if (!y) return null;
  return String(y); // "2025" for "2025-26"
}

function possPgForTeam(possMap: Map<string, TeamPossRow>, canonical: string): number {
  const row = possMap.get(canonical);
  const col = pickPossColumnForSeason(SEASON);
  if (row && col) {
    const v = toNullNum(row[col]);
    if (v != null && v > 40 && v < 120) return v; // sanity
  }
  return DEFAULT_LEAGUE_AVG_POSS;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* =========================
   FETCH + PARSE KENPOM
========================= */
async function fetchKenPomText(): Promise<string> {
  const res = await fetch(KP_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!res.ok) throw new Error(`KenPom fetch failed: ${res.status} ${await res.text()}`);

  const raw = await res.text();
  const pre = raw.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  return pre ? pre[1] : raw;
}

function parseKenPomLines(text: string): KpParsedLine[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const parsed: KpParsedLine[] = [];

  for (const line of lines) {
    // 11/03/2025 Florida 87 Arizona 93 N   Las Vegas, NV
    const m = line.match(/^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(\d+)\s+(.+?)\s+(\d+)\s*(.*)$/);
    if (!m) continue;

    parsed.push({
      dateStr: m[1],
      team1Raw: m[2].trim(),
      score1: Number(m[3]),
      team2Raw: m[4].trim(),
      score2: Number(m[5]),
      suffix: (m[6] || "").trim(),
    });
  }

  return parsed;
}

/* =========================
   DB: LOAD TEAM MAP (KenPom)
========================= */
async function loadTeamMap(
  supabase: ReturnType<typeof createClient>
): Promise<{ canonSet: Set<string>; kpToCanon: Map<string, string> }> {
  // Try selecting sport_key too; if it errors, retry without it.
  let data: any[] | null = null;

  {
    const res = await supabase
      .from("team_map")
      .select('canonical, "KenPom", sport_key')
      .not("canonical", "is", null);

    if (!res.error) {
      data = (res.data ?? []) as any[];
    } else {
      const res2 = await supabase
        .from("team_map")
        .select('canonical, "KenPom"')
        .not("canonical", "is", null);
      if (res2.error) throw res2.error;
      data = (res2.data ?? []) as any[];
    }
  }

  const canonSet = new Set<string>();
  const kpToCanon = new Map<string, string>();

  for (const r of data || []) {
    const canonical = String(r.canonical ?? "").trim();
    if (!canonical) continue;

    // If team_map.sport_key exists, filter to current SPORT_KEY
    if (Object.prototype.hasOwnProperty.call(r, "sport_key")) {
      const sk = String(r.sport_key ?? "").trim();
      if (sk && sk !== SPORT_KEY) continue;
    }

    canonSet.add(canonical);

    const kpName = String(r["KenPom"] ?? "").trim();
    if (kpName) kpToCanon.set(normalizeKey(kpName), canonical);
  }

  if (canonSet.size === 0) {
    throw new Error(
      `team_map produced 0 canonical rows. If team_map has sport_key, verify rows where sport_key='${SPORT_KEY}'.`
    );
  }
  if (kpToCanon.size === 0) {
    throw new Error(`team_map has 0 KenPom mappings for sport_key='${SPORT_KEY}' (KenPom column empty).`);
  }

  return { canonSet, kpToCanon };
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

/* =========================
   BUILD GAMES (STRICT + PACE)
========================= */
function buildGamesFromKenPom(
  rawLines: KpParsedLine[],
  kpToCanon: Map<string, string>,
  canonSet: Set<string>,
  possMap: Map<string, TeamPossRow>
): { games: KpGame[]; maxDate: Date } {
  const games: KpGame[] = [];
  let maxDate: Date | null = null;

  for (const g of rawLines) {
    const date = parseMMDDYYYY(g.dateStr);
    if (!date) continue;

    const c1 = kpToCanon.get(normalizeKey(g.team1Raw));
    const c2 = kpToCanon.get(normalizeKey(g.team2Raw));
    if (!c1 || !c2) continue;

    if (!canonSet.has(c1) || !canonSet.has(c2)) continue;

    const neutral = isNeutralFromSuffix(g.suffix);

    // pace-based possessions estimate (per game), then OT scale to 40-min equivalent
    const p1 = possPgForTeam(possMap, c1);
    const p2 = possPgForTeam(possMap, c2);
    const basePoss = (p1 + p2) / 2;

    const numOT = computeNumOT(g.suffix);
    const possScale = numOT > 0 ? 40 / (40 + 5 * numOT) : 1.0;

    const regPoss = basePoss * possScale;
    const regScore1 = g.score1 * possScale;
    const regScore2 = g.score2 * possScale;

    if (!maxDate || date > maxDate) maxDate = date;

    // sanity: if regPoss gets weird, fallback
    const safePoss =
      Number.isFinite(regPoss) && regPoss > 40 && regPoss < 120 ? regPoss : DEFAULT_LEAGUE_AVG_POSS * possScale;

    games.push({
      season: SEASON,
      date,
      team1: c1,
      team2: c2,
      score1: regScore1,
      score2: regScore2,
      suffix: g.suffix,
      neutral,
      gamePoss: safePoss,
    });
  }

  if (!games.length) {
    throw new Error(
      `No valid games after strict KenPom->canonical mapping for sport_key='${SPORT_KEY}'. Check team_map."KenPom" coverage.`
    );
  }
  if (!maxDate) throw new Error("No maxDate computed.");

  return { games, maxDate };
}

/* =========================
   TEAM-GAMES + LEAGUE AVG
========================= */
function buildTeamGames(games: KpGame[], maxDate: Date) {
  const teamGames: TeamGame[] = [];
  let totalPtsAll = 0;
  let totalPossAll = 0;

  for (const g of games) {
    const w = recencyWeight(g.date, maxDate);

    const ha1: TeamGame["homeAway"] = g.neutral ? "neutral" : "away";
    const ha2: TeamGame["homeAway"] = g.neutral ? "neutral" : "home";

    const off100_1 = (g.score1 / g.gamePoss) * 100;
    const off100_2 = (g.score2 / g.gamePoss) * 100;

    teamGames.push({
      team: g.team1,
      opponent: g.team2,
      off100: off100_1,
      oppOff100: off100_2,
      pts: g.score1,
      pa: g.score2,
      neutral: g.neutral,
      homeAway: ha1,
      w,
      poss: g.gamePoss,
      suffix: g.suffix,
    });

    teamGames.push({
      team: g.team2,
      opponent: g.team1,
      off100: off100_2,
      oppOff100: off100_1,
      pts: g.score2,
      pa: g.score1,
      neutral: g.neutral,
      homeAway: ha2,
      w,
      poss: g.gamePoss,
      suffix: g.suffix,
    });

    totalPtsAll += g.score1 + g.score2;
    totalPossAll += g.gamePoss + g.gamePoss;
  }

  const leagueAvgOff100 = (totalPtsAll / totalPossAll) * 100;
  return { teamGames, leagueAvgOff100 };
}

/* =========================
   SOLVE OFF/DEF (per-100 deviations)
========================= */
function solveOffDef(teamGames: TeamGame[], leagueAvgOff100: number) {
  const teamSet = new Set<string>();
  for (const tg of teamGames) teamSet.add(tg.team);

  const teams = Array.from(teamSet).sort();
  const nTeams = teams.length;

  const idx = new Map<string, number>();
  teams.forEach((t, i) => idx.set(t, i));

  const nGames = teamGames.length;
  const teamIdx = new Array<number>(nGames);
  const oppIdx = new Array<number>(nGames);
  const dPoints = new Array<number>(nGames);
  const weights = new Array<number>(nGames);
  const gamesPerTeam = new Array<number>(nTeams).fill(0);

  for (let i = 0; i < nGames; i++) {
    const g = teamGames[i];
    const ti = idx.get(g.team)!;
    const oi = idx.get(g.opponent)!;

    teamIdx[i] = ti;
    oppIdx[i] = oi;

    const rawDp = g.off100 - leagueAvgOff100;
    const dp = Math.max(Math.min(rawDp, MARGIN_CAP_100), -MARGIN_CAP_100);

    dPoints[i] = dp;
    weights[i] = g.w;
    gamesPerTeam[ti] += 1;
  }

  let Off = new Array<number>(nTeams).fill(0);
  let Def = new Array<number>(nTeams).fill(0);

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const offSum = new Array<number>(nTeams).fill(0);
    const offW = new Array<number>(nTeams).fill(0);
    const defSum = new Array<number>(nTeams).fill(0);
    const defW = new Array<number>(nTeams).fill(0);

    for (let k = 0; k < nGames; k++) {
      const ti = teamIdx[k];
      const oi = oppIdx[k];
      const dp = dPoints[k];
      const w = weights[k];

      offSum[ti] += w * (dp + Def[oi]);
      offW[ti] += w;

      defSum[oi] += w * (Off[ti] - dp);
      defW[oi] += w;
    }

    const OffNew = new Array<number>(nTeams);
    const DefNew = new Array<number>(nTeams);

    for (let t = 0; t < nTeams; t++) {
      OffNew[t] = offW[t] > 0 ? offSum[t] / offW[t] : Off[t];
      DefNew[t] = defW[t] > 0 ? defSum[t] / defW[t] : Def[t];
    }

    // recenter
    const offMean = average(OffNew);
    const defMean = average(DefNew);
    for (let t = 0; t < nTeams; t++) {
      OffNew[t] -= offMean;
      DefNew[t] -= defMean;
    }

    // convergence
    let delta = 0;
    for (let t = 0; t < nTeams; t++) {
      delta = Math.max(delta, Math.abs(OffNew[t] - Off[t]), Math.abs(DefNew[t] - Def[t]));
    }

    Off = OffNew;
    Def = DefNew;

    if (delta < TOL) break;
  }

  // shrink early-season
  for (let t = 0; t < nTeams; t++) {
    const gc = gamesPerTeam[t] || 0;
    const shrink = gc / (gc + PRIOR_GAMES);
    Off[t] *= shrink;
    Def[t] *= shrink;
  }

  // recenter after shrink
  const offMean2 = average(Off);
  const defMean2 = average(Def);
  for (let t = 0; t < nTeams; t++) {
    Off[t] -= offMean2;
    Def[t] -= defMean2;
  }

  return { teams, idx, teamIdx, gamesPerTeam, Off, Def };
}

/* =========================
   TRUE HCA (MARGIN-BASED)
========================= */
function computeTrueHcaFromHomeMargins(
  games: KpGame[],
  idx: Map<string, number>,
  enginePower: number[]
): { trueHca: number[]; homeGames: number[]; signal: number[] } {
  const nTeams = enginePower.length;

  const sumDelta = new Array<number>(nTeams).fill(0);
  const cntHome = new Array<number>(nTeams).fill(0);

  for (const g of games) {
    if (g.neutral) continue;

    // KenPom ordering: team1 = away, team2 = home
    const away = g.team1;
    const home = g.team2;

    const hi = idx.get(home);
    const ai = idx.get(away);
    if (hi === undefined || ai === undefined) continue;

    const actualMargin = g.score2 - g.score1;
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
   FUN FACTOR + SIGMAS + AVERAGES
========================= */
function computeFunAndSigmasFast(
  teamGames: TeamGame[],
  nTeams: number,
  teamIdxArr: number[],
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
    const ti = teamIdxArr[i];

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
   PF / PA PER GAME
========================= */
function computePfPaPerGame(games: KpGame[], teams: string[]) {
  const pfTot = new Map<string, number>();
  const paTot = new Map<string, number>();
  const gp = new Map<string, number>();

  for (const t of teams) {
    pfTot.set(t, 0);
    paTot.set(t, 0);
    gp.set(t, 0);
  }

  for (const g of games) {
    pfTot.set(g.team1, (pfTot.get(g.team1) || 0) + g.score1);
    paTot.set(g.team1, (paTot.get(g.team1) || 0) + g.score2);
    gp.set(g.team1, (gp.get(g.team1) || 0) + 1);

    pfTot.set(g.team2, (pfTot.get(g.team2) || 0) + g.score2);
    paTot.set(g.team2, (paTot.get(g.team2) || 0) + g.score1);
    gp.set(g.team2, (gp.get(g.team2) || 0) + 1);
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

  // 1) Universe from team_map
  const { canonSet, kpToCanon } = await loadTeamMap(supabase);

  // 2) Load possessions for this sport+season
  const possMap = await loadTeamPossessions(supabase);

  // 3) fetch + parse KenPom
  const text = await fetchKenPomText();
  const rawLines = parseKenPomLines(text);

  // 4) strict games + pace-based possessions
  const { games, maxDate } = buildGamesFromKenPom(rawLines, kpToCanon, canonSet, possMap);

  // 5) build team-games + league avg
  const { teamGames, leagueAvgOff100 } = buildTeamGames(games, maxDate);

  // 6) solve Off/Def
  const { teams, idx, teamIdx, gamesPerTeam, Off, Def } = solveOffDef(teamGames, leagueAvgOff100);
  const nTeams = teams.length;

  // 7) engine ratings (per-100)
  const engineAdjOff = Off.map((x) => 100 + x);
  const engineAdjDef = Def.map((x) => 100 - x);
  const enginePower = engineAdjOff.map((o, i) => o - engineAdjDef[i]); // Off - Def

  // 8) HCA (margin-based)
  const { trueHca, homeGames, signal } = computeTrueHcaFromHomeMargins(games, idx, enginePower);

  // 9) fun + sigmas + averages
  const { funFactor, sigmaTotal100, sigmaMargin100, avgTotalPoints, avgMarginPoints } =
    computeFunAndSigmasFast(teamGames, nTeams, teamIdx, leagueAvgOff100);

  // 10) PF/PA per game
  const { pfPg, paPg } = computePfPaPerGame(games, teams);

  // 11) build rows
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

    pf_points: round2(pfPg.get(team) || 0),
    pa_points: round2(paPg.get(team) || 0),
  }));

  // rank by power desc
  rows.sort((a, b) => Number(b.engine_power ?? 0) - Number(a.engine_power ?? 0));
  rows.forEach((r, i) => (r.power_rank = i + 1));

  // 12) upsert into team_ratings (chunked)
  for (const batch of chunk(rows, 500)) {
    const { error } = await supabase.from("team_ratings").upsert(batch, {
      onConflict: "sport_key,canonical,season",
    });
    if (error) throw error;
  }

  // Debug summary
  const possCol = pickPossColumnForSeason(SEASON);
  const usedPossTeams = possCol
    ? Array.from(possMap.values()).filter((r) => toNullNum(r[possCol]) != null).length
    : 0;

  console.log(
    JSON.stringify(
      {
        ok: true,
        sport_key: SPORT_KEY,
        season: SEASON,
        team_map_canonical_count: canonSet.size,
        teams_rated: rows.length,
        games_used: games.length,
        kenpom_lines_parsed: rawLines.length,
        leagueAvgOff100: round2(leagueAvgOff100),
        poss: {
          source: "team_possessions",
          season_column: possCol,
          teams_with_poss_value: usedPossTeams,
          fallback_default: DEFAULT_LEAGUE_AVG_POSS,
        },
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

