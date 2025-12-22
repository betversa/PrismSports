/**
 * ratingsBuilder.ts — KenPom → Opponent-Adjusted Ratings (Per-100)
 * ----------------------------------------------------------------
 * FIXES IN THIS VERSION:
 *  1) TRUE D1 LIMIT: D1_SET = team_map.canonical ∩ team_possessions(season)
 *  2) PF/PA are PER GAME (pf_pg / pa_pg)
 *  3) HCA computed in POINTS (not per-100) + clamped to sane range
 *  4) All numeric fields rounded to 2 decimals before upsert
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
  gamePoss: number; // regulation-equivalent possessions
};

type TeamGame = {
  team: string;
  opponent: string;
  off100: number;
  oppOff100: number;
  rawScore: number;    // actual points (reg-equivalent) for team
  oppRawScore: number; // actual points (reg-equivalent) for opponent
  neutral: boolean;
  homeAway: "home" | "away" | "neutral";
  baseWeight: number;
  gamePoss: number;
  suffix: string;
};

// ===================== CONFIG =====================
const KP_URL = "https://kenpom.com/cbbga26.txt";
const SEASON = "2025-26";

const BASE_HFA_POINTS = 2.0;      // baseline HFA in POINTS
const HFA_CLAMP_MIN = 0.0;        // realistic clamps
const HFA_CLAMP_MAX = 6.0;

const MAX_ITER = 1000;
const TOL = 1e-6;

const RECENCY_HALF_LIFE_DAYS = 30;
const RECENCY_FLOOR = 0.3;

const MARGIN_CAP_100 = 25;        // cap in per-100 space for solver stability
const PRIOR_GAMES = 5;

const DEFAULT_LEAGUE_AVG_POSS = 70;

// ===================== HELPERS =====================
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

// ===================== DB LOADS =====================
async function loadTeamMapKenPom(
  supabase: ReturnType<typeof createClient>
): Promise<{
  canonicalAll: Set<string>;
  kpToCanon: Map<string, string>;
}> {
  const { data, error } = await supabase
    .from("team_map")
    .select("canonical,KenPom")
    .not("canonical", "is", null);

  if (error) throw error;

  const canonicalAll = new Set<string>();
  const kpToCanon = new Map<string, string>();

  for (const r of data || []) {
    const canonical = String((r as any).canonical || "").trim();
    if (!canonical) continue;
    canonicalAll.add(canonical);

    const kpName = String((r as any).KenPom || "").trim();
    if (kpName) kpToCanon.set(normalizeKey(kpName), canonical);
  }

  return { canonicalAll, kpToCanon };
}

async function loadPossessionsAndD1Set(
  supabase: ReturnType<typeof createClient>,
  season: string,
  canonicalAll: Set<string>
): Promise<{
  d1Set: Set<string>;
  teamPoss: Map<string, number>;
  leagueAvgPoss: number;
}> {
  const { data, error } = await supabase
    .from("team_possessions")
    .select("canonical, poss")
    .eq("season", season);

  if (error) throw error;

  const d1Set = new Set<string>();
  const teamPoss = new Map<string, number>();

  let sum = 0;
  let cnt = 0;

  for (const r of data || []) {
    const canonical = String((r as any).canonical || "").trim();
    const p = Number((r as any).poss);

    // IMPORTANT: possessions is our D1 filter for this season
    if (!canonical) continue;
    if (!canonicalAll.has(canonical)) continue;

    d1Set.add(canonical);

    if (Number.isFinite(p) && p > 0) {
      teamPoss.set(canonical, p);
      sum += p;
      cnt += 1;
    }
  }

  const leagueAvgPoss = cnt ? sum / cnt : DEFAULT_LEAGUE_AVG_POSS;
  return { d1Set, teamPoss, leagueAvgPoss };
}

// ===================== BUILD GAMES (STRICT D1) =====================
function buildGamesFromKenPom(
  rawLines: KpParsedLine[],
  kpToCanon: Map<string, string>,
  d1Set: Set<string>,
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

    // 🚨 TRUE D1 GATE
    if (!d1Set.has(c1) || !d1Set.has(c2)) continue;

    const neutral = isNeutralFromSuffix(g.suffix);

    const p1 = teamPoss.get(c1);
    const p2 = teamPoss.get(c2);
    let gamePoss = leagueAvgPoss;
    if (Number.isFinite(p1) && Number.isFinite(p2)) gamePoss = (p1! + p2!) / 2;
    else if (Number.isFinite(p1)) gamePoss = p1!;
    else if (Number.isFinite(p2)) gamePoss = p2!;

    // OT scale back to 40-minute equivalent
    const numOT = computeNumOT(g.suffix);
    const possScale = numOT > 0 ? 40 / (40 + 5 * numOT) : 1.0;

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

  if (!games.length) throw new Error("No valid D1 games after strict mapping.");
  if (!maxDate) throw new Error("No maxDate computed.");

  return { games, maxDate };
}

function buildTeamGames(games: KpGame[], maxDate: Date) {
  const teamGames: TeamGame[] = [];
  let totalPtsAll = 0;
  let totalPossAll = 0;

  for (const g of games) {
    const wBase = getRecencyWeight(g.date, maxDate);

    // KenPom lines are away/home unless neutral
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

// ===================== SOLVER =====================
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
    const dp = Math.max(Math.min(rawDp, MARGIN_CAP_100), -MARGIN_CAP_100);

    let possFactor = 1.0;
    if (leagueAvgPoss > 0 && g.gamePoss > 0) {
      possFactor = Math.sqrt(g.gamePoss / leagueAvgPoss);
    }

    dPoints[i] = dp;
    weights[i] = g.baseWeight * possFactor;
    gamesPerTeam[ti] += 1;
  }

  let Off = new Array<number>(nTeams).fill(0); // dev from league avg in per-100
  let Def = new Array<number>(nTeams).fill(0); // dev from league avg in per-100

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

    let delta = 0;
    for (let t = 0; t < nTeams; t++) {
      delta = Math.max(delta, Math.abs(OffNew[t] - Off[t]), Math.abs(DefNew[t] - Def[t]));
    }

    Off = OffNew;
    Def = DefNew;

    if (delta < TOL) break;
  }

  // shrink early season
  for (let t = 0; t < nTeams; t++) {
    const gCount = gamesPerTeam[t] || 0;
    const shrink = gCount / (gCount + PRIOR_GAMES);
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

  return { idx, teamIdx, oppIdx, gamesPerTeam, Off, Def };
}

// ===================== TRUE HCA (POINTS-BASED) =====================
function computeTrueHcaPoints(
  teamGames: TeamGame[],
  nTeams: number,
  teamIdx: number[],
  oppIdx: number[],
  Off: number[],
  Def: number[],
  leagueAvgOff100: number
) {
  const homeSum = new Array<number>(nTeams).fill(0);
  const homeCnt = new Array<number>(nTeams).fill(0);
  const awaySum = new Array<number>(nTeams).fill(0);
  const awayCnt = new Array<number>(nTeams).fill(0);

  for (let i = 0; i < teamGames.length; i++) {
    const g = teamGames[i];
    if (g.neutral) continue;

    const ti = teamIdx[i];
    const oi = oppIdx[i];

    // predicted points for team in THIS GAME (points space)
    const predPts =
      (leagueAvgOff100 + Off[ti] - Def[oi]) * (g.gamePoss / 100);

    const resPts = g.rawScore - predPts;

    if (g.homeAway === "home") {
      homeSum[ti] += resPts;
      homeCnt[ti] += 1;
    } else if (g.homeAway === "away") {
      awaySum[ti] += resPts;
      awayCnt[ti] += 1;
    }
  }

  const trueHca = new Array<number>(nTeams).fill(BASE_HFA_POINTS);
  for (let t = 0; t < nTeams; t++) {
    const h = homeCnt[t], a = awayCnt[t];
    const homeAvg = h ? homeSum[t] / h : 0;
    const awayAvg = a ? awaySum[t] / a : 0;

    // if they only have 1 side of games, don’t let it go crazy
    const raw = BASE_HFA_POINTS + (homeAvg - awayAvg);
    trueHca[t] = clamp(raw, HFA_CLAMP_MIN, HFA_CLAMP_MAX);
  }

  return trueHca;
}

// ===================== PF/PA PER GAME =====================
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

  return { pfPg, paPg, gamesPlayed: gp };
}

// ===================== MAIN =====================
async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing env vars: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1) load team_map canonical + KenPom mapping
  const { canonicalAll, kpToCanon } = await loadTeamMapKenPom(supabase);

  // 2) TRUE D1 set from possessions for this season (intersection)
  const { d1Set, teamPoss, leagueAvgPoss } =
    await loadPossessionsAndD1Set(supabase, SEASON, canonicalAll);

  if (d1Set.size === 0) {
    throw new Error(`No D1 teams found in team_possessions for season ${SEASON}.`);
  }

  // teams list MUST come from d1Set (and we will later restrict to teams that actually appear in games)
  const d1TeamsAll = Array.from(d1Set).sort();

  // 3) fetch + parse KenPom
  const text = await fetchKenPomText();
  const rawLines = parseKenPomLines(text);

  // 4) build strict D1 games only
  const { games, maxDate } =
    buildGamesFromKenPom(rawLines, kpToCanon, d1Set, teamPoss, leagueAvgPoss);

  // 5) teams actually used in valid games (this is what we rate/upsert)
  const usedSet = new Set<string>();
  for (const g of games) {
    usedSet.add(g.team1);
    usedSet.add(g.team2);
  }
  const teams = Array.from(usedSet).sort();

  // sanity: cannot exceed D1 set
  if (teams.length > d1Set.size) {
    throw new Error(`D1 leak: teams_used(${teams.length}) > d1_set(${d1Set.size})`);
  }

  // 6) build team-game rows + league avg off100
  const { teamGames, leagueAvgOff100 } = buildTeamGames(games, maxDate);

  // 7) solve Off/Def using ONLY teams used
  const { teamIdx, oppIdx, gamesPerTeam, Off, Def } =
    solveOffDef(teamGames, teams, leagueAvgOff100, leagueAvgPoss);

  const nTeams = teams.length;

  // 8) engine metrics
  const engineAdjOff = Off.map((x) => 100 + x);
  const engineAdjDef = Def.map((x) => 100 - x);
  const enginePower = engineAdjOff.map((o, i) => o - engineAdjDef[i]);

  // 9) true HCA (points-based + clamped)
  const trueHca = computeTrueHcaPoints(
    teamGames,
    nTeams,
    teamIdx,
    oppIdx,
    Off,
    Def,
    leagueAvgOff100
  );

  // 10) PF/PA per game
  const { pfPg, paPg } = computePfPaPerGame(games, teams);

  // NOTE: keep your existing fun/sigma if you want; omitted here for brevity
  // If you want it back, we’ll plug it in after verifying D1 counts + HCA sanity.

  const nowIso = new Date().toISOString();

  const rows: any[] = teams.map((team, i) => ({
    canonical: team,
    season: SEASON,
    updated_at: nowIso,

    engine_adj_off: round2(engineAdjOff[i]),
    engine_adj_def: round2(engineAdjDef[i]),
    engine_power: round2(enginePower[i]),

    true_hca: round2(trueHca[i]),

    // NEW: per-game PF/PA
    pf_pg: round2(pfPg.get(team) || 0),
    pa_pg: round2(paPg.get(team) || 0),
  }));

  // rank by power
  rows.sort((a, b) => Number(b.engine_power ?? 0) - Number(a.engine_power ?? 0));
  rows.forEach((r, i) => (r.power_rank = i + 1));

  // upsert — assumes these columns exist:
  // pf_pg, pa_pg (create them like you planned for PF/PA)
  for (const batch of chunk(rows, 500)) {
    const { error } = await supabase.from("team_ratings").upsert(batch, {
      onConflict: "canonical,season",
    });
    if (error) throw error;
  }

  console.log(JSON.stringify({
    ok: true,
    season: SEASON,
    kenpom_lines_parsed: rawLines.length,
    d1_set_from_possessions: d1Set.size,
    teams_used_in_games: teams.length,
    games_used: games.length,
    leagueAvgPoss: round2(leagueAvgPoss),
    leagueAvgOff100: round2(leagueAvgOff100),
    hca_range: {
      min: round2(Math.min(...trueHca)),
      max: round2(Math.max(...trueHca)),
    }
  }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

