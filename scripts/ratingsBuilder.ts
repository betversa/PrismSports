/**
 * ratingsBuilder.ts — KenPom → Opponent-Adjusted Ratings (Per-100 Possessions)
 * ---------------------------------------------------------------------------
 * HARD RULES:
 *  1) Only count teams that exist in `team_map.canonical`
 *  2) Only include KenPom games where BOTH teams map via `team_map.KenPom -> canonical`
 *  3) Do NOT create big tables of game results — compute in-memory and upsert ratings
 *
 * Enhancements in this version:
 *  - ALL numeric outputs rounded to 2 decimals (e.g., 123.34)
 *  - Adds PF/PA (regulation-equivalent) computed from KenPom games used
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

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
  team1: string; // canonical
  team2: string; // canonical
  score1: number; // regulation-equivalent points
  score2: number; // regulation-equivalent points
  suffix: string;
  neutral: boolean;
  gamePoss: number; // regulation-equivalent poss
};

type TeamGame = {
  team: string; // canonical
  opponent: string; // canonical
  off100: number;
  oppOff100: number;
  rawScore: number;     // reg-equivalent PF in this game (for this team)
  oppRawScore: number;  // reg-equivalent PA in this game (for this team)
  neutral: boolean;
  homeAway: "home" | "away" | "neutral";
  baseWeight: number;
  gamePoss: number;
  suffix: string;
};

// === CONFIG ===
const KP_URL = "https://kenpom.com/cbbga26.txt";
const SEASON = "2025-26";

const HFA_POINTS = 2.0;
const MAX_ITER = 1000;
const TOL = 1e-6;
const RECENCY_HALF_LIFE_DAYS = 30;
const RECENCY_FLOOR = 0.3;
const MARGIN_CAP = 25;
const PRIOR_GAMES = 5;

const DEFAULT_LEAGUE_AVG_POSS = 70;

// === helpers ===
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

function round2(x: any): number | null {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function parseMMDDYYYY(s: string): Date | null {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
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

function getRecencyWeight(gameDate: Date, maxDate: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  const ageDays = (maxDate.getTime() - gameDate.getTime()) / msPerDay;
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
  return /\b[0-9]*\s*[Nn]\b/.test(suffix) || /\b[0-9]*[Nn]$/.test(suffix);
}

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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// === DB loads ===
async function loadTeamMapKenPomOnly(
  supabase: ReturnType<typeof createClient>
): Promise<{
  canonSet: Set<string>;
  kpToCanon: Map<string, string>;
}> {
  const { data, error } = await supabase
    .from("team_map")
    .select("canonical,KenPom")
    .not("canonical", "is", null)
    .not("KenPom", "is", null);

  if (error) throw error;

  const canonSet = new Set<string>();
  const kpToCanon = new Map<string, string>();

  for (const r of data || []) {
    const canonical = String((r as any).canonical || "").trim();
    const kpName = String((r as any).KenPom || "").trim();
    if (!canonical || !kpName) continue;

    canonSet.add(canonical);
    kpToCanon.set(normalizeKey(kpName), canonical);
  }

  return { canonSet, kpToCanon };
}

async function loadPossessions(
  supabase: ReturnType<typeof createClient>,
  season: string,
  canonSet: Set<string>
): Promise<{ teamPoss: Map<string, number>; leagueAvgPoss: number }> {
  const { data, error } = await supabase
    .from("team_possessions")
    .select("canonical, poss")
    .eq("season", season);

  if (error) throw error;

  const teamPoss = new Map<string, number>();
  let leagueSum = 0;
  let leagueCnt = 0;

  for (const r of data || []) {
    const canonical = String((r as any).canonical || "").trim();
    const p = Number((r as any).poss);

    if (!canonical || !canonSet.has(canonical)) continue;

    if (Number.isFinite(p) && p > 0) {
      teamPoss.set(canonical, p);
      leagueSum += p;
      leagueCnt += 1;
    }
  }

  const leagueAvgPoss = leagueCnt > 0 ? leagueSum / leagueCnt : DEFAULT_LEAGUE_AVG_POSS;
  return { teamPoss, leagueAvgPoss };
}

// === core compute ===
function buildGamesFromKenPom(
  rawLines: KpParsedLine[],
  kpToCanon: Map<string, string>,
  canonSet: Set<string>,
  teamPoss: Map<string, number>,
  leagueAvgPoss: number
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

    const p1 = teamPoss.get(c1);
    const p2 = teamPoss.get(c2);
    let gamePoss = leagueAvgPoss;
    if (Number.isFinite(p1) && Number.isFinite(p2)) gamePoss = (p1! + p2!) / 2;
    else if (Number.isFinite(p1)) gamePoss = p1!;
    else if (Number.isFinite(p2)) gamePoss = p2!;

    const numOT = computeNumOT(g.suffix);
    let possScale = 1.0;
    if (numOT > 0) {
      const totalMinutes = 40 + 5 * numOT;
      possScale = 40 / totalMinutes;
    }

    const regPoss = gamePoss * possScale;
    const regScore1 = g.score1 * possScale;
    const regScore2 = g.score2 * possScale;

    if (!maxDate || date > maxDate) maxDate = date;

    games.push({
      season: SEASON,
      date,
      team1: c1,
      team2: c2,
      score1: regScore1,
      score2: regScore2,
      suffix: g.suffix,
      neutral,
      gamePoss: regPoss,
    });
  }

  if (!games.length) {
    throw new Error("No valid games after strict KenPom->canonical mapping.");
  }
  if (!maxDate) throw new Error("No maxDate computed.");

  return { games, maxDate };
}

function buildTeamGames(games: KpGame[], maxDate: Date) {
  const teamGames: TeamGame[] = [];
  let totalPtsAll = 0;
  let totalPossAll = 0;

  for (const g of games) {
    const recW = getRecencyWeight(g.date, maxDate);
    const wBase = 1.0 * recW;

    const ha1: TeamGame["homeAway"] = g.neutral ? "neutral" : "away";
    const ha2: TeamGame["homeAway"] = g.neutral ? "neutral" : "home";

    const off100_1 = (g.score1 / g.gamePoss) * 100;
    const off100_2 = (g.score2 / g.gamePoss) * 100;

    teamGames.push({
      team: g.team1,
      opponent: g.team2,
      off100: off100_1,
      oppOff100: off100_2,
      rawScore: g.score1,
      oppRawScore: g.score2,
      neutral: g.neutral,
      homeAway: ha1,
      baseWeight: wBase,
      gamePoss: g.gamePoss,
      suffix: g.suffix,
    });

    teamGames.push({
      team: g.team2,
      opponent: g.team1,
      off100: off100_2,
      oppOff100: off100_1,
      rawScore: g.score2,
      oppRawScore: g.score1,
      neutral: g.neutral,
      homeAway: ha2,
      baseWeight: wBase,
      gamePoss: g.gamePoss,
      suffix: g.suffix,
    });

    totalPtsAll += g.score1 + g.score2;
    totalPossAll += g.gamePoss + g.gamePoss;
  }

  const leagueAvgOff100 = (totalPtsAll / totalPossAll) * 100;
  return { teamGames, leagueAvgOff100 };
}

function solveOffDef(teamGames: TeamGame[], teams: string[], leagueAvgOff100: number, leagueAvgPoss: number) {
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
    const dp = Math.max(Math.min(rawDp, MARGIN_CAP), -MARGIN_CAP);

    let possFactor = 1.0;
    if (leagueAvgPoss > 0 && Number.isFinite(g.gamePoss) && g.gamePoss > 0) {
      possFactor = Math.sqrt(g.gamePoss / leagueAvgPoss);
    }

    dPoints[i] = dp;
    weights[i] = g.baseWeight * possFactor;
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

    const offMean = average(OffNew);
    const defMean = average(DefNew);
    for (let t = 0; t < nTeams; t++) {
      OffNew[t] -= offMean;
      DefNew[t] -= defMean;
    }

    let delta = 0;
    for (let t = 0; t < nTeams; t++) {
      delta = Math.max(delta, Math.abs(OffNew[t] - Off[t]), Math.abs(DefNew[t] - Def[t]));
    }

    Off = OffNew;
    Def = DefNew;

    if (delta < TOL) break;
  }

  // shrink
  for (let t = 0; t < nTeams; t++) {
    const gCount = gamesPerTeam[t] || 0;
    const shrink = gCount / (gCount + PRIOR_GAMES);
    Off[t] = shrink * Off[t];
    Def[t] = shrink * Def[t];
  }

  // recenter after shrink
  const offMean2 = average(Off);
  const defMean2 = average(Def);
  for (let t = 0; t < nTeams; t++) {
    Off[t] -= offMean2;
    Def[t] -= defMean2;
  }

  return { idx, teamIdx, oppIdx, gamesPerTeam, Off, Def };
}

function computeTrueHca(
  teamGames: TeamGame[],
  nTeams: number,
  teamIdx: number[],
  oppIdx: number[],
  Off: number[],
  Def: number[],
  leagueAvgOff100: number
) {
  const nGames = teamGames.length;

  const homeResSum = new Array<number>(nTeams).fill(0);
  const homeResCnt = new Array<number>(nTeams).fill(0);
  const awayResSum = new Array<number>(nTeams).fill(0);
  const awayResCnt = new Array<number>(nTeams).fill(0);

  for (let i = 0; i < nGames; i++) {
    const g = teamGames[i];
    if (g.neutral) continue;

    const ti = teamIdx[i];
    const oi = oppIdx[i];

    const rawDp = g.off100 - leagueAvgOff100;
    const capDp = Math.max(Math.min(rawDp, MARGIN_CAP), -MARGIN_CAP);

    const predicted = Off[ti] - Def[oi];
    const residual = capDp - predicted;

    if (g.homeAway === "home") {
      homeResSum[ti] += residual;
      homeResCnt[ti] += 1;
    } else if (g.homeAway === "away") {
      awayResSum[ti] += residual;
      awayResCnt[ti] += 1;
    }
  }

  const trueHca = new Array<number>(nTeams).fill(HFA_POINTS);
  for (let t = 0; t < nTeams; t++) {
    const h = homeResCnt[t];
    const a = awayResCnt[t];
    if (h === 0 && a === 0) {
      trueHca[t] = HFA_POINTS;
      continue;
    }
    const homeAvg = h > 0 ? homeResSum[t] / h : 0;
    const awayAvg = a > 0 ? awayResSum[t] / a : 0;
    trueHca[t] = HFA_POINTS + (homeAvg - awayAvg);
  }

  return trueHca;
}

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

    const totalRaw = g.rawScore + g.oppRawScore;
    const signedMarginRaw = g.rawScore - g.oppRawScore;

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

function computePfPaFromGames(games: KpGame[], teams: string[]) {
  const pf = new Map<string, number>();
  const pa = new Map<string, number>();

  for (const t of teams) {
    pf.set(t, 0);
    pa.set(t, 0);
  }

  for (const g of games) {
    pf.set(g.team1, (pf.get(g.team1) || 0) + g.score1);
    pa.set(g.team1, (pa.get(g.team1) || 0) + g.score2);

    pf.set(g.team2, (pf.get(g.team2) || 0) + g.score2);
    pa.set(g.team2, (pa.get(g.team2) || 0) + g.score1);
  }

  return { pf, pa };
}

// === main ===
async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing env vars: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1) STRICT D1 universe = team_map rows with KenPom populated
  const { canonSet, kpToCanon } = await loadTeamMapKenPomOnly(supabase);

  if (canonSet.size === 0) {
    throw new Error("team_map contains 0 rows with KenPom populated. Cannot build ratings.");
  }

  // IMPORTANT: team list must come from canonSet (never from games)
  const teams = Array.from(canonSet).sort();
  const nTeams = teams.length;

  // 2) possessions (only for canonSet)
  const { teamPoss, leagueAvgPoss } = await loadPossessions(supabase, SEASON, canonSet);

  // 3) fetch + parse KenPom
  const text = await fetchKenPomText();
  const rawLines = parseKenPomLines(text);

  // 4) STRICT games
  const { games, maxDate } = buildGamesFromKenPom(rawLines, kpToCanon, canonSet, teamPoss, leagueAvgPoss);

  // 5) build team-games + league avg off100
  const { teamGames, leagueAvgOff100 } = buildTeamGames(games, maxDate);

  // 6) solver (uses teams from canonSet, not derived)
  const { idx, teamIdx, oppIdx, gamesPerTeam, Off, Def } =
    solveOffDef(teamGames, teams, leagueAvgOff100, leagueAvgPoss);

  // 7) engine metrics
  const engineAdjOff = Off.map((x) => 100 + x);
  const engineAdjDef = Def.map((x) => 100 - x);
  const enginePower  = engineAdjOff.map((o, i) => o - engineAdjDef[i]);

  // 8) true HCA
  const trueHca = computeTrueHca(teamGames, nTeams, teamIdx, oppIdx, Off, Def, leagueAvgOff100);

  // 9) fun + sigmas + averages
  const { funFactor, sigmaTotal100, sigmaMargin100, avgTotalPoints, avgMarginPoints } =
    computeFunAndSigmasFast(teamGames, nTeams, teamIdx, leagueAvgOff100);

  // 10) PF/PA from same games used
  const { pf, pa } = computePfPaFromGames(games, teams);

  // 11) build rows + rank by engine_power desc
  const nowIso = new Date().toISOString();

  const rows = teams.map((team, i) => {
    const pfVal = pf.get(team) ?? 0;
    const paVal = pa.get(team) ?? 0;

    return {
      canonical: team,
      season: SEASON,
      updated_at: nowIso,

      engine_adj_off: round2(engineAdjOff[i]),
      engine_adj_def: round2(engineAdjDef[i]),
      engine_power:   round2(enginePower[i]),

      true_hca:       round2(trueHca[i]),
      fun_factor:     round2(funFactor[i]),

      sigma_total_100:  round2(sigmaTotal100[i]),
      sigma_margin_100: round2(sigmaMargin100[i]),

      avg_total_points:  round2(avgTotalPoints[i]),
      avg_margin_points: round2(avgMarginPoints[i]),

      // NEW:
      pf_points: round2(pfVal),
      pa_points: round2(paVal),
    };
  });

  rows.sort((a, b) => Number(b.engine_power ?? 0) - Number(a.engine_power ?? 0));
  rows.forEach((r, i) => ((r as any).power_rank = i + 1));

  // Upsert
  for (const batch of chunk(rows, 500)) {
    const { error } = await supabase.from("team_ratings").upsert(batch, {
      onConflict: "canonical,season",
    });
    if (error) throw error;
  }

  console.log(
    JSON.stringify({
      ok: true,
      season: SEASON,
      teams_rated: rows.length,
      games_used: games.length,
      kenpom_lines_parsed: rawLines.length,
      d1_universe_size_team_map_kenpom: canonSet.size,
      leagueAvgPoss: round2(leagueAvgPoss),
      leagueAvgOff100: round2(leagueAvgOff100),
    })
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
