import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type KpGame = {
  season: string;
  date: Date;
  team1: string;
  team2: string;
  score1: number;
  score2: number;
  suffix: string;
  neutral: boolean;
  gamePoss: number;
};

const SPORT_KEY = "basketball_ncaab";
const KP_URL = "https://kenpom.com/cbbga26.txt";
const SEASON = "2025-26";

// Match Apps Script defaults
const HFA_POINTS = 2.0;
const MAX_ITER = 1000;
const TOL = 1e-6;
const RECENCY_HALF_LIFE_DAYS = 30;
const RECENCY_FLOOR = 0.30;
const MARGIN_CAP = 25;
const PRIOR_GAMES = 5;

const DEFAULT_LEAGUE_AVG_POSS = 70;

// ---------------- utils ----------------

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

function parseMMDDYYYY(s: string): Date | null {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  return Number.isFinite(d.getTime()) ? d : null;
}

function getRecencyWeight(gameDate: Date, maxDate: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  const ageDays = (maxDate.getTime() - gameDate.getTime()) / msPerDay;
  if (ageDays <= 0) return 1.0;
  const w = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  return Math.max(RECENCY_FLOOR, w);
}

function average(arr: number[]) {
  if (!arr.length) return 0;
  let s = 0;
  for (const x of arr) s += x;
  return s / arr.length;
}

function computeNumOT(suffix: string): number {
  const s = String(suffix || "").toUpperCase();
  if (!s.includes("OT")) return 0;
  const m = s.match(/(\d+)\s*OT/i);
  if (m?.[1]) return parseInt(m[1], 10);
  return 1;
}

function isNeutral(suffix: string): boolean {
  return /\b[0-9]*\s*[Nn]\b/.test(suffix) || /\b[0-9]*[Nn]$/.test(suffix);
}

function chunk<T>(arr: T[], size: number) {
  return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, (i + 1) * size)
  );
}

// ---------------- KenPom fetch/parse ----------------

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

function parseKpLines(text: string) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Example:
  // 11/03/2025 Florida 87 Arizona 93 N   Las Vegas, NV
  const parsed: Array<{
    dateStr: string;
    team1: string;
    score1: number;
    team2: string;
    score2: number;
    suffix: string;
  }> = [];

  for (const line of lines) {
    const m = line.match(
      /^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(\d+)\s+(.+?)\s+(\d+)\s*(.*)$/
    );
    if (!m) continue;

    parsed.push({
      dateStr: m[1],
      team1: m[2].trim(),
      score1: Number(m[3]),
      team2: m[4].trim(),
      score2: Number(m[5]),
      suffix: (m[6] || "").trim(),
    });
  }

  return parsed;
}

// ---------------- Supabase helpers ----------------

async function loadKenPomCanonicalizer(supabase: ReturnType<typeof createClient>) {
  /**
   * Uses team_map.KenPom (variation) -> team_map.canonical
   * Note: select("canonical,KenPom") works if the column name is exactly KenPom.
   */
  const { data, error } = await supabase
    .from("team_map")
    .select("canonical,KenPom")
    .not("KenPom", "is", null);

  if (error) throw error;

  const kpToCanon = new Map<string, string>();
  for (const r of data || []) {
    const kp = (r as any).KenPom;
    const canon = (r as any).canonical;
    if (!kp || !canon) continue;
    kpToCanon.set(normalizeKey(String(kp)), String(canon));
  }

  return (kpName: string) => {
    const key = normalizeKey(kpName);
    return kpToCanon.get(key) || kpName.trim();
  };
}

async function loadPossessions(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from("team_possessions")
    .select("canonical, poss")
    .eq("season", SEASON);

  if (error) throw error;

  const teamPoss = new Map<string, number>();
  let leagueSum = 0;
  let leagueCnt = 0;

  for (const r of data || []) {
    const canonical = String((r as any).canonical || "").trim();
    const p = Number((r as any).poss);
    if (!canonical) continue;
    if (Number.isFinite(p) && p > 0) {
      teamPoss.set(canonical, p);
      leagueSum += p;
      leagueCnt += 1;
    }
  }

  const leagueAvgPoss = leagueCnt ? leagueSum / leagueCnt : DEFAULT_LEAGUE_AVG_POSS;
  return { teamPoss, leagueAvgPoss };
}

/**
 * FK-safe: ensure all canonicals exist in team_map before inserting into team_ratings.
 *
 * We insert missing rows into team_map with:
 *  - canonical = canonical
 *  - KenPom = canonical (safe default if you don’t have a better KP string)
 *  - "The Odds API" = canonical (optional helper)
 * All other columns left null.
 */
async function ensureTeamsExistInTeamMap(
  supabase: ReturnType<typeof createClient>,
  canonicals: string[]
) {
  const unique = Array.from(new Set(canonicals.map((c) => String(c || "").trim()).filter(Boolean)));
  if (!unique.length) return;

  // Find existing canonicals in team_map
  const existing = new Set<string>();
  for (const batch of chunk(unique, 500)) {
    const { data, error } = await supabase
      .from("team_map")
      .select("canonical")
      .in("canonical", batch);

    if (error) throw error;
    for (const r of data || []) existing.add(String((r as any).canonical));
  }

  const missing = unique.filter((c) => !existing.has(c));
  if (!missing.length) return;

  const payload = missing.map((canonical) => ({
    canonical,
    KenPom: canonical,
    // IMPORTANT: if your actual column is literally named "The Odds API" in Postgres,
    // this object-key approach works (Supabase will quote it).
    // If the real DB column is snake_case (e.g., the_odds_api), rename this key accordingly.
    "The Odds API": canonical,
    ESPN_Long: null,
    SR_School: null,
    SR_School_Short: null,
    Elo: null,
    HFA: null,
    TR: null,
  }));

  const { error: upsertErr } = await supabase.from("team_map").upsert(payload, {
    onConflict: "canonical",
  });

  if (upsertErr) {
    console.error(
      JSON.stringify(
        {
          message:
            "Failed to upsert missing canonicals into team_map. This is almost always a column-name mismatch " +
            '(ex: "The Odds API" is actually the_odds_api) or an RLS/permission issue.',
          upsert_error: upsertErr,
          missing_count: missing.length,
          missing_sample: missing.slice(0, 25),
        },
        null,
        2
      )
    );
    throw upsertErr;
  }

  console.log(JSON.stringify({ ensured_team_map: true, inserted: missing.length }, null, 2));
}

// ------------------------- main -------------------------

async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL!;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing env vars: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const canonicalize = await loadKenPomCanonicalizer(supabase);
  const { teamPoss, leagueAvgPoss } = await loadPossessions(supabase);

  // Fetch + parse KenPom games
  const text = await fetchKenPomText();
  const rawGames = parseKpLines(text);

  const gameRows: KpGame[] = [];
  let maxDate: Date | null = null;

  for (const g of rawGames) {
    const date = parseMMDDYYYY(g.dateStr);
    if (!date) continue;

    // First map KP name -> canonical (via team_map.KenPom)
    const team1 = canonicalize(g.team1);
    const team2 = canonicalize(g.team2);

    const neutral = isNeutral(g.suffix);

    // possessions
    const p1 = teamPoss.get(team1);
    const p2 = teamPoss.get(team2);
    let gamePoss = leagueAvgPoss;

    if (Number.isFinite(p1) && Number.isFinite(p2)) gamePoss = ((p1 as number) + (p2 as number)) / 2;
    else if (Number.isFinite(p1)) gamePoss = p1 as number;
    else if (Number.isFinite(p2)) gamePoss = p2 as number;

    // OT scale back to 40-minute equivalent
    const numOT = computeNumOT(g.suffix);
    const possScale = numOT > 0 ? 40 / (40 + 5 * numOT) : 1.0;

    const regPoss = gamePoss * possScale;
    const regScore1 = g.score1 * possScale;
    const regScore2 = g.score2 * possScale;

    if (!maxDate || date > maxDate) maxDate = date;

    gameRows.push({
      season: SEASON,
      date,
      team1,
      team2,
      score1: regScore1,
      score2: regScore2,
      suffix: g.suffix,
      neutral,
      gamePoss: regPoss,
    });
  }

  if (!gameRows.length) throw new Error("No games parsed from KenPom file.");
  if (!maxDate) throw new Error("No maxDate computed.");

  // FK safety: ensure all canonicals exist in team_map BEFORE upserting team_ratings
  await ensureTeamsExistInTeamMap(
    supabase,
    gameRows.flatMap((g) => [g.team1, g.team2])
  );

  // 4) Build team-game rows (two per game)
  type TeamGame = {
    team: string;
    opponent: string;
    off100: number;
    oppOff100: number;
    rawScore: number;
    oppRawScore: number;
    neutral: boolean;
    homeAway: "home" | "away" | "neutral";
    baseWeight: number;
    gamePoss: number;
    suffix: string;
  };

  const teamGames: TeamGame[] = [];
  let totalPtsAll = 0;
  let totalPossAll = 0;

  for (const g of gameRows) {
    const recW = getRecencyWeight(g.date, maxDate);
    const wBase = recW;

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

  // 5) Index mapping
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
    const dp = Math.max(Math.min(rawDp, MARGIN_CAP), -MARGIN_CAP);

    let possFactor = 1.0;
    if (leagueAvgPoss > 0 && Number.isFinite(g.gamePoss) && g.gamePoss > 0) {
      possFactor = Math.sqrt(g.gamePoss / leagueAvgPoss);
    }

    dPoints[i] = dp;
    weights[i] = g.baseWeight * possFactor;
    gamesPerTeam[ti] += 1;
  }

  // 6) Iterative solver
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

  // 7) Shrink toward league avg
  for (let t = 0; t < nTeams; t++) {
    const gCount = gamesPerTeam[t] || 0;
    const shrink = gCount / (gCount + PRIOR_GAMES);
    Off[t] = shrink * Off[t];
    Def[t] = shrink * Def[t];
  }

  // recenter
  const offMean2 = average(Off);
  const defMean2 = average(Def);
  for (let t = 0; t < nTeams; t++) {
    Off[t] -= offMean2;
    Def[t] -= defMean2;
  }

  // 8) Engine Off/Def/Power
  const engineAdjOff = Off.map((x) => 100 + x);
  const engineAdjDef = Def.map((x) => 100 - x);
  const enginePower = engineAdjOff.map((o, i) => o - engineAdjDef[i]);

  // 9) True HCA
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
    if (h === 0 && a === 0) continue;
    const homeAvg = h > 0 ? homeResSum[t] / h : 0;
    const awayAvg = a > 0 ? awayResSum[t] / a : 0;
    trueHca[t] = HFA_POINTS + (homeAvg - awayAvg);
  }

  // 10) Fun factor + sigmas + pure averages
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
      const norm = (rawFun[t] - (minFun as number)) / span;
      funFactor[t] = 20 * norm;
    }
  }

  // 11) Build rows + rank by enginePower (desc)
  const rows = teams.map((team, i) => ({
    canonical: team,
    season: SEASON,
    updated_at: new Date().toISOString(),
    engine_adj_off: engineAdjOff[i],
    engine_adj_def: engineAdjDef[i],
    engine_power: enginePower[i],
    true_hca: trueHca[i],
    fun_factor: funFactor[i],
    sigma_total_100: sigmaTotal100[i],
    sigma_margin_100: sigmaMargin100[i],
    avg_total_points: avgTotalPoints[i],
    avg_margin_points: avgMarginPoints[i],
    power_rank: 0,
  }));

  rows.sort((a, b) => Number(b.engine_power ?? 0) - Number(a.engine_power ?? 0));
  rows.forEach((r, i) => (r.power_rank = i + 1));

  // 12) Upsert into team_ratings
  for (const batch of chunk(rows, 500)) {
    const { error } = await supabase.from("team_ratings").upsert(batch, {
      onConflict: "canonical,season",
    });
    if (error) throw error;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        season: SEASON,
        teams: rows.length,
        games: gameRows.length,
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

