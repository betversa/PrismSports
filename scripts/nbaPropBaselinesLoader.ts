/**
 * scripts/nbaPropBaselinesLoader.ts
 *
 * Updates:
 * ✅ Only PTS/REB/AST/3PM from 4 FantasyPros sources
 * ✅ Store ONLY first position if multiple (e.g. "PG,SG" => "PG")
 * ✅ team_abbr becomes canonical team name via public.team_map.Abbreviation
 * ✅ Adds opponent via public.events (canon_home_team/canon_away_team)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";

const URL_AVG_SZN = "https://www.fantasypros.com/nba/stats/avg-overall.php";
const URL_AVG_7   = "https://www.fantasypros.com/nba/stats/avg-overall.php?days=7";
const URL_AVG_15  = "https://www.fantasypros.com/nba/stats/avg-overall.php?days=15";
const URL_PROJ    = "https://www.fantasypros.com/nba/projections/avg-daily-overall.php";

type Stat4 = { pts?: number; reb?: number; ast?: number; pm3?: number };

type PlayerBase = {
  fp_id: number;
  player_name: string;
  player_url?: string | null;
  team_abbr_raw?: string | null; // e.g. "LAL" from FantasyPros
  position?: string | null;      // FIRST position only (e.g. "PG")
};

type PlayerRow = PlayerBase & {
  // raw inputs
  pts_szn?: number | null;  reb_szn?: number | null;  ast_szn?: number | null;  pm3_szn?: number | null;
  pts_7?: number | null;    reb_7?: number | null;    ast_7?: number | null;    pm3_7?: number | null;
  pts_15?: number | null;   reb_15?: number | null;   ast_15?: number | null;   pm3_15?: number | null;
  pts_proj?: number | null; reb_proj?: number | null; ast_proj?: number | null; pm3_proj?: number | null;

  // composites
  pts_comp?: number | null;
  reb_comp?: number | null;
  ast_comp?: number | null;
  pm3_comp?: number | null;

  // canon
  team_abbr?: string | null; // YOU requested this becomes canonical team name
  opponent?: string | null;  // canonical opponent
};

function toNum(x: string | undefined | null): number | null {
  if (!x) return null;
  const t = x.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseSeasonFromAnyPage($: cheerio.CheerioAPI): string {
  const text = $("h2, h3").text();
  const m = text.match(/\((\d{4}-\d{2})\)/);
  return m?.[1] ?? "unknown";
}

function parseTeamPosLabel(label: string): { team: string | null; firstPos: string | null } {
  // label like "(LAL - PG,SG)"
  const m = label.match(/\(\s*([A-Z]{2,4})\s*-\s*([^)]+)\)/);
  if (!m) return { team: null, firstPos: null };
  const team = m[1];
  const posRaw = m[2].trim();       // "PG,SG"
  const firstPos = posRaw.split(",")[0]?.trim() || null; // "PG"
  return { team, firstPos };
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; PrismSportsBot/1.0)",
      accept: "text/html",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.text();
}

/**
 * Scrape avg-overall.php tables:
 * td.center order includes PTS(0), REB(1), AST(2), 3PM(7) on this page structure.
 */
function scrapeAvgPage(html: string): { season: string; map: Map<number, PlayerBase & Stat4> } {
  const $ = cheerio.load(html);
  const season = parseSeasonFromAnyPage($);
  const out = new Map<number, PlayerBase & Stat4>();

  $("tr[class^='mpb-player-']").each((_, tr) => {
    const $tr = $(tr);

    const a = $tr.find("td.player-label a.fp-player-link").first();
    const player_name = (a.attr("fp-player-name") || a.text() || "").trim();
    const href = a.attr("href") || null;

    const cls = a.attr("class") || "";
    const idMatch = cls.match(/fp-id-(\d+)/);
    const fp_id = idMatch ? Number(idMatch[1]) : null;

    const small = $tr.find("td.player-label small").first().text().trim();
    const { team: team_abbr_raw, firstPos } = parseTeamPosLabel(small);

    const centers = $tr.find("td.center").toArray().map(td => $(td).text().trim());
    if (!fp_id || !player_name || centers.length < 8) return;

    const pts = toNum(centers[0]);
    const reb = toNum(centers[1]);
    const ast = toNum(centers[2]);
    const pm3 = toNum(centers[7]); // 3PM

    out.set(fp_id, {
      fp_id,
      player_name,
      player_url: href,
      team_abbr_raw,
      position: firstPos,
      pts: pts ?? undefined,
      reb: reb ?? undefined,
      ast: ast ?? undefined,
      pm3: pm3 ?? undefined,
    });
  });

  return { season, map: out };
}

/**
 * Scrape projections avg-daily-overall:
 * We take td.center[0]=PTS, [1]=REB, [2]=AST, [7]=3PM based on visible header order.
 */
function scrapeProjPage(html: string): { map: Map<number, PlayerBase & Stat4>; rowCount: number } {
  const $ = cheerio.load(html);
  const out = new Map<number, PlayerBase & Stat4>();

  $("tr").each((_, tr) => {
    const $tr = $(tr);
    const a = $tr.find("a.fp-player-link").first();
    if (!a.length) return;

    const player_name = (a.attr("fp-player-name") || a.text() || "").trim();
    const href = a.attr("href") || null;

    const cls = a.attr("class") || "";
    const idMatch = cls.match(/fp-id-(\d+)/);
    const fp_id = idMatch ? Number(idMatch[1]) : null;

    const small = $tr.find("small").first().text().trim();
    const { team: team_abbr_raw, firstPos } = parseTeamPosLabel(small);

    const centers = $tr.find("td.center").toArray().map(td => $(td).text().trim());
    if (!fp_id || !player_name || centers.length < 8) return;

    const pts = toNum(centers[0]);
    const reb = toNum(centers[1]);
    const ast = toNum(centers[2]);
    const pm3 = toNum(centers[7]);

    out.set(fp_id, {
      fp_id,
      player_name,
      player_url: href,
      team_abbr_raw,
      position: firstPos,
      pts: pts ?? undefined,
      reb: reb ?? undefined,
      ast: ast ?? undefined,
      pm3: pm3 ?? undefined,
    });
  });

  return { map: out, rowCount: out.size };
}

function percentileMap(valuesById: Map<number, number>): Map<number, number> {
  const arr = [...valuesById.entries()].filter(([, v]) => Number.isFinite(v));
  arr.sort((a, b) => a[1] - b[1]);
  const out = new Map<number, number>();
  const n = arr.length;
  if (n === 0) return out;

  for (let i = 0; i < n; i++) {
    const [id] = arr[i];
    const p = n === 1 ? 100 : (i / (n - 1)) * 100;
    out.set(id, p);
  }
  return out;
}

function buildComposite(
  rows: Map<number, PlayerRow>,
  statKey: "pts" | "reb" | "ast" | "pm3",
  weights: { szn: number; d7: number; d15: number; proj: number }
): Map<number, number> {
  const pull = (suffix: string) => {
    const m = new Map<number, number>();
    for (const [id, r] of rows.entries()) {
      const v = (r as any)[`${statKey}_${suffix}`] as number | null | undefined;
      if (v != null && Number.isFinite(v)) m.set(id, v);
    }
    return m;
  };

  const pSzn = percentileMap(pull("szn"));
  const p7 = percentileMap(pull("7"));
  const p15 = percentileMap(pull("15"));
  const pProj = percentileMap(pull("proj"));

  const out = new Map<number, number>();
  for (const [id] of rows.entries()) {
    const parts: Array<[number, number]> = [];
    const s = pSzn.get(id); if (s != null) parts.push([s, weights.szn]);
    const d7 = p7.get(id); if (d7 != null) parts.push([d7, weights.d7]);
    const d15 = p15.get(id); if (d15 != null) parts.push([d15, weights.d15]);
    const pr = pProj.get(id); if (pr != null) parts.push([pr, weights.proj]);

    if (!parts.length) continue;
    const wsum = parts.reduce((a, [, w]) => a + w, 0);
    const score = parts.reduce((a, [p, w]) => a + p * w, 0) / wsum;
    out.set(id, score);
  }
  return out;
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!supabaseUrl || !serviceKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // 1) Pull FantasyPros pages
  const [htmlSzn, html7, html15, htmlProj] = await Promise.all([
    fetchHtml(URL_AVG_SZN),
    fetchHtml(URL_AVG_7),
    fetchHtml(URL_AVG_15),
    fetchHtml(URL_PROJ),
  ]);

  const szn = scrapeAvgPage(htmlSzn);
  const d7 = scrapeAvgPage(html7);
  const d15 = scrapeAvgPage(html15);
  const season = szn.season;

  const proj = scrapeProjPage(htmlProj);
  if (proj.rowCount < 50) {
    console.warn(
      `WARNING: projections scraped only ${proj.rowCount} players; this page may be limited unless authenticated.`
    );
  }

  // 2) Load team_map so we can convert Abbreviation -> Canonical Team Name
  // You said: use team_map Abbreviation and return canonical name.
  // Assumption: team_map has columns: Abbreviation, Canonical (or team / canonical_name).
  // We'll select a few common candidates and pick whichever exists in your schema.
  const { data: teamMapRows, error: tmErr } = await supabase
    .from("team_map")
    .select("Abbreviation, abbreviation, Canonical, canonical, team, canonical_name, Team, name")
    .limit(500);

  if (tmErr) throw tmErr;

  const abbrToCanon = new Map<string, string>();
  for (const r of teamMapRows || []) {
    const abbr = (r.Abbreviation || r.abbreviation || "").toString().trim();
    const canon =
      (r.Canonical ||
        r.canonical ||
        r.canonical_name ||
        r.team ||
        r.Team ||
        r.name ||
        "")?.toString().trim();

    if (abbr && canon) abbrToCanon.set(abbr, canon);
  }

  // 3) Merge players across sources
  const merged = new Map<number, PlayerRow>();

  function upsertBase(p: PlayerBase) {
    const cur = merged.get(p.fp_id) ?? { fp_id: p.fp_id, player_name: p.player_name };
    merged.set(p.fp_id, {
      ...cur,
      fp_id: p.fp_id,
      player_name: p.player_name || cur.player_name,
      player_url: p.player_url ?? cur.player_url ?? null,
      team_abbr_raw: p.team_abbr_raw ?? (cur as any).team_abbr_raw ?? null,
      position: p.position ?? (cur as any).position ?? null,
    });
  }

  function apply(map: Map<number, PlayerBase & Stat4>, suffix: "szn" | "7" | "15" | "proj") {
    for (const [id, p] of map.entries()) {
      upsertBase(p);
      const cur = merged.get(id)!;
      merged.set(id, {
        ...cur,
        [`pts_${suffix}`]: p.pts ?? null,
        [`reb_${suffix}`]: p.reb ?? null,
        [`ast_${suffix}`]: p.ast ?? null,
        [`pm3_${suffix}`]: p.pm3 ?? null,
      } as any);
    }
  }

  apply(szn.map, "szn");
  apply(d7.map, "7");
  apply(d15.map, "15");
  apply(proj.map, "proj");

  // 4) Canonicalize team name into team_abbr field (per your request)
  for (const r of merged.values()) {
    const raw = (r.team_abbr_raw || "").toString().trim();
    r.team_abbr = raw ? (abbrToCanon.get(raw) ?? raw) : null; // canonical name if available, else keep raw
  }

  // 5) Build opponent via events table (canon_home_team / canon_away_team)
  // Strategy: for each team canonical name, find the nearest upcoming event for NBA,
  // then return the opposing canonical team.
  const uniqueTeams = [...new Set([...merged.values()].map(r => r.team_abbr).filter(Boolean) as string[])];

  // Pull upcoming events (you can tighten time window if you want)
  const nowIso = new Date().toISOString();
  const { data: events, error: evErr } = await supabase
    .from("events")
    .select("event_id, commence_time, canon_home_team, canon_away_team, sport_key")
    .eq("sport_key", "basketball_nba")
    .gte("commence_time", nowIso)
    .order("commence_time", { ascending: true })
    .limit(5000);

  if (evErr) throw evErr;

  // Map team canonical -> opponent canonical (nearest game)
  const teamToOpponent = new Map<string, string>();
  for (const team of uniqueTeams) {
    const game = (events || []).find(e => e.canon_home_team === team || e.canon_away_team === team);
    if (!game) continue;
    const opp = game.canon_home_team === team ? game.canon_away_team : game.canon_home_team;
    if (opp) teamToOpponent.set(team, opp);
  }

  for (const r of merged.values()) {
    const team = r.team_abbr;
    r.opponent = team ? (teamToOpponent.get(team) ?? null) : null;
  }

  // 6) composites
  const weights = { szn: 0.35, d15: 0.25, d7: 0.25, proj: 0.15 };

  const ptsComp = buildComposite(merged, "pts", weights);
  const rebComp = buildComposite(merged, "reb", weights);
  const astComp = buildComposite(merged, "ast", weights);
  const pm3Comp = buildComposite(merged, "pm3", weights);

  for (const [id, s] of ptsComp.entries()) merged.get(id)!.pts_comp = s;
  for (const [id, s] of rebComp.entries()) merged.get(id)!.reb_comp = s;
  for (const [id, s] of astComp.entries()) merged.get(id)!.ast_comp = s;
  for (const [id, s] of pm3Comp.entries()) merged.get(id)!.pm3_comp = s;

  // 7) upsert payload
  const payload = [...merged.values()].map(r => ({
    season,
    fp_id: r.fp_id,
    player_name: r.player_name,
    player_url: r.player_url ?? null,

    // you requested canonical team name goes into team_abbr
    team_abbr: r.team_abbr ?? null,
    team_abbr_raw: r.team_abbr_raw ?? null,
    positions: r.position ?? null,

    opponent: r.opponent ?? null,

    pts_szn: r.pts_szn ?? null, reb_szn: r.reb_szn ?? null, ast_szn: r.ast_szn ?? null, pm3_szn: r.pm3_szn ?? null,
    pts_7: r.pts_7 ?? null,     reb_7: r.reb_7 ?? null,     ast_7: r.ast_7 ?? null,     pm3_7: r.pm3_7 ?? null,
    pts_15: r.pts_15 ?? null,   reb_15: r.reb_15 ?? null,   ast_15: r.ast_15 ?? null,   pm3_15: r.pm3_15 ?? null,
    pts_proj: r.pts_proj ?? null, reb_proj: r.reb_proj ?? null, ast_proj: r.ast_proj ?? null, pm3_proj: r.pm3_proj ?? null,

    pts_comp: r.pts_comp ?? null,
    reb_comp: r.reb_comp ?? null,
    ast_comp: r.ast_comp ?? null,
    pm3_comp: r.pm3_comp ?? null,

    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("nba_player_prop_baselines")
    .upsert(payload, { onConflict: "season,fp_id" });

  if (error) throw error;

  console.log(JSON.stringify({ ok: true, season, players: payload.length }, null, 2));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
