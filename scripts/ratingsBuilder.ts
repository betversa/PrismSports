/**
 * ratingsBuilder.ts — KenPom → Opponent-Adjusted Ratings (Per-100 Possessions)
 * ---------------------------------------------------------------------------
 * ASSUMPTIONS (per your update):
 *  - team_map.canonical now contains ONLY D1 teams (you cleaned it)
 *  - team_possessions is NOT available (or empty), so we use a constant poss estimate
 *
 * HARD RULES:
 *  1) D1 universe = all rows in team_map.canonical
 *  2) Only include KenPom games where BOTH teams map via team_map.KenPom -> canonical
 *  3) No big game tables in DB — compute in-memory and upsert into team_ratings
 *
 * Fixes included:
 *  - True HCA computed in POINTS (not per-100) + clamped to realistic range
 *  - PF/PA stored as PER GAME (pf_pg / pa_pg)
 *  - All numeric fields rounded to 2 decimals
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
  team1: string; // canonical
  team2: string; // canonical
  score1: number; // regulation-equivalent points
  score2: number; // regulation-equivalent points
  suffix: string;
  neutral: boolean;
  gamePoss: number; // regulation-equivalent possessions (estimated)
};

type TeamGame = {
  team: string; // canonical
  opponent: string; // canonical
  off100: number;
  oppOff100: number;
  pts: number;   // reg-equivalent PF for this game (this team)
  pa: number;    // reg-equivalent PA for this game (this team)
  neutral: boolean;
  homeAway: "home" | "away" | "neutral";
  w: number;     // weight
  poss: number;
  suffix: string;
};

/* =========================
   CONFIG
========================= */
const KP_URL = "https://kenpom.com/cbbga26.txt";
const SEASON = "2025-26";

// possessions fallback (because team_possessions not available)
const DEFAULT_LEAGUE_AVG_POSS = 70;

// solver + weighting
const MAX_ITER = 1000;
const TOL = 1e-6;
const MARGIN_CAP_100 = 25;
const PRIOR_GAMES = 5;

const RECENCY_HALF_LIFE_DAYS = 30;
const RECENCY_FLOOR = 0.3;

// HCA in points (realistic bounds)
const BASE_HFA_POINTS = 2.0;
const HFA_CLAMP_MIN = 0.0;
const HFA_CLAMP_MAX = 6.0;

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
  // KenPom uses N, 1N, etc
  return /\b[0-9]*\s*[Nn]\b/.test(suffix) || /\b[0-9]*[Nn]$/.test(suffix);
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

  // If wrapped in <pre>, extract it
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
   LOAD TEAM MAP (D1 = canonical rows)
========================= */
async function loadTeamMap(
  supabase: ReturnType<typeof createClient>
): Promise<{ canonSet: Set<string>; kpToCanon: Map<string, string> }> {
  const { data, error } = await supabase
    .from("team_map")
    .select("canonical,KenPom")
    .not("canonical", "is", null);

  if (error) throw error;

  const canonSet = new Set<string>();
  const kpToCanon = new Map<string, string>();

  for (const r of data || []) {
    const canonical = String((r as any).canonical || "").trim();
    if (!canonical) continue;
    canonSet.add(canonical);

    const kpName = String((r as any).KenPom || "").trim();
    if (kpName) kpToCanon.set(normalizeKey(kpName), canonical);
  }

  if (canonSet.size === 0) throw new Error("team_map has 0 canonical rows.");
  if (kpToCanon.size === 0) throw new Error("team_map has 0 KenPom mappings (KenPom column empty).");

  return { canonSet, kpToCanon };
}

/* =========================
   BUILD GAMES (STRICT)
========================= */
function buildGamesFromKenPom(
  rawLines: KpParsedLine[],
  kpToCanon: Map<string, string>,
  canonSet: Set<string>
): { games: KpGame[]; maxDate: Date } {
  const games: KpGame[] = [];
  let maxDate: Date | null = null;

  for (const g of rawLines) {
    const date = parseMMDDYYYY(g.dateStr);
    if (!date) continue;

    const c1 = kpToCanon.get(normalizeKey(g.team1Raw));
    const c2 = kpToCanon.get(normalizeKey(g.team2Raw));
    if (!c1 || !c2) continue;

    // STRICT: only allow canonicals
    if (!canonSet.has(c1) || !canonSet.has(c2)) continue;

    const neutral = isNeutralFromSuffix(g.suffix);

    // possessions: constant estimate (no team_possessions available)
    let gamePoss = DEFAULT_LEAGUE_AVG_POSS;

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

  if (!games.length) {
    throw new Error("No valid games after strict KenPom->canonical mapping. Check team_map.KenPom coverage.");
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

    // KenPom cbbga lines are away/home unless neutral
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
function solveOffDef(teamGames: TeamGame[], teams: string[], leagueAvgOff100: number) {
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

    // dp in per-100 space
    const rawDp = g.off100 - leagueAvgOff100;
    const dp = Math.max(Math.min(rawDp, MARGIN_CAP_100), -MARGIN_CAP_100);

    dPoints[i] = dp;
    weights[i] = g.w; // already includes recency
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

    // recenter so means are 0
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

  // early season shrink
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

  return { teamIdx, oppIdx, gamesPerTeam, Off, Def };
}

/* =========================
   TRUE HCA (POINTS SPACE) + CLAMP
========================= */
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

    // predicted points in this game (points-space)
    const predPts = (leagueAvgOff100 + Off[ti] - Def[oi]) * (g.poss / 100);
    const resPts = g.pts - predPts;

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
    const raw = BASE_HFA_POINTS + (homeAvg - awayAvg);
    trueHca[t] = clamp(raw, HFA_CLAMP_MIN, HFA_CLAMP_MAX);
  }
  return trueHca;
}

/* =========================
   PF/PA PER GAME
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
  return { pfPg, paPg, gp };
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

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1) D1 universe = team_map.canonical (you cleaned it)
  const { canonSet, kpToCanon } = await loadTeamMap(supabase);

  // 2) fetch + parse KenPom
  const text = await fetchKenPomText();
  const rawLines = parseKenPomLines(text);

  // 3) strict games
  const { games, maxDate } = buildGamesFromKenPom(rawLines, kpToCanon, canonSet);

  // 4) teams used in actual valid games (rate only those)
  const used = new Set<string>();
  for (const g of games) {
    used.add(g.team1);
    used.add(g.team2);
  }
  const teams = Array.from(used).sort();
  const nTeams = teams.length;

  // 5) build team-games + league avg
  const { teamGames, leagueAvgOff100 } = buildTeamGames(games, maxDate);

  // 6) solve Off/Def (per-100 devs)
  const { teamIdx, oppIdx, gamesPerTeam, Off, Def } =
    solveOffDef(teamGames, teams, leagueAvgOff100);

  // 7) engine metrics (per-100 ratings)
  const engineAdjOff = Off.map((x) => 100 + x);
  const engineAdjDef = Def.map((x) => 100 - x);
  const enginePower = engineAdjOff.map((o, i) => o - engineAdjDef[i]);

  // 8) true HCA (points-based)
  const trueHca = computeTrueHcaPoints(
    teamGames,
    nTeams,
    teamIdx,
    oppIdx,
    Off,
    Def,
    leagueAvgOff100
  );

  // 9) PF/PA per game
  const { pfPg, paPg, gp } = computePfPaPerGame(games, teams);

  // 10) build rows (rounded to 2 decimals)
  const nowIso = new Date().toISOString();

  const rows: any[] = teams.map((team, i) => ({
    canonical: team,
    season: SEASON,
    updated_at: nowIso,

    engine_adj_off: round2(engineAdjOff[i]),
    engine_adj_def: round2(engineAdjDef[i]),
    engine_power: round2(enginePower[i]),

    true_hca: round2(trueHca[i]),

    pf_points: round2(pfPg.get(team) || 0),
    pa_points: round2(paPg.get(team) || 0),
    games_played: Number(gp.get(team) || 0),
  }));

  // sort + rank
  rows.sort((a, b) => Number(b.engine_power ?? 0) - Number(a.engine_power ?? 0));
  rows.forEach((r, i) => (r.power_rank = i + 1));

  // upsert
  for (const batch of chunk(rows, 500)) {
    const { error } = await supabase.from("team_ratings").upsert(batch, {
      onConflict: "canonical,season",
    });
    if (error) throw error;
  }

  const hcaMin = Math.min(...trueHca);
  const hcaMax = Math.max(...trueHca);

  console.log(
    JSON.stringify({
      ok: true,
      season: SEASON,
      team_map_canonical_count: canonSet.size,
      teams_used_in_games: teams.length,
      games_used: games.length,
      kenpom_lines_parsed: rawLines.length,
      leagueAvgOff100: round2(leagueAvgOff100),
      poss_assumption: DEFAULT_LEAGUE_AVG_POSS,
      true_hca_range: { min: round2(hcaMin), max: round2(hcaMax) },
    })
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


