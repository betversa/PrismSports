import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";

/* =========================
   CONFIG
========================= */

const URL_AVG_SZN = "https://www.fantasypros.com/nba/stats/avg-overall.php";
const URL_AVG_7   = "https://www.fantasypros.com/nba/stats/avg-overall.php?days=7";
const URL_AVG_15  = "https://www.fantasypros.com/nba/stats/avg-overall.php?days=15";

// weights for baseline blending
const W = { szn: 0.40, d15: 0.30, d7: 0.30 };

// league baselines (good enough to start; you can later compute dynamically)
const NBA_AVG_TOTAL = 228; // typical NBA total
const NBA_AVG_TEAM_TOTAL = NBA_AVG_TOTAL / 2;

/* =========================
   TYPES
========================= */

type StatPack = {
  pts: number | null;
  reb: number | null;
  ast: number | null;
  pm3: number | null;
  min: number | null;
};

type PlayerRow = {
  season: string;
  fp_id: number;
  player_name: string;
  player_url: string | null;

  team_abbr_raw: string | null;
  canonical: string | null;
  position: string | null;

  opponent: string | null; // we keep this, but spread/total comes from odds_wide_latest
  picture_url: string;

  // raw windows
  pts_szn: number | null; reb_szn: number | null; ast_szn: number | null; pm3_szn: number | null; min_szn: number | null;
  pts_7: number | null;   reb_7: number | null;   ast_7: number | null;   pm3_7: number | null;   min_7: number | null;
  pts_15: number | null;  reb_15: number | null;  ast_15: number | null;  pm3_15: number | null;  min_15: number | null;

  // composites (0..100)
  pts_comp: number | null; reb_comp: number | null; ast_comp: number | null; pm3_comp: number | null; min_comp: number | null;

  // environment
  pin_spread_line: number | null;
  pin_total_line: number | null;
  implied_team_total: number | null;
  minutes_factor: number | null;
  pace_factor: number | null;
  team_total_factor: number | null;

  // projections
  min_base: number | null;
  min_adj: number | null;
  pts_adj: number | null;
  reb_adj: number | null;
  ast_adj: number | null;
  pm3_adj: number | null;

  updated_at: string;
};

/* =========================
   HELPERS
========================= */

function toNum(x: string | undefined | null): number | null {
  if (!x) return null;
  const t = x.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function parseSeason($: cheerio.CheerioAPI): string {
  const text = $("h2, h3").text();
  return text.match(/\((\d{4}-\d{2})\)/)?.[1] ?? "unknown";
}

function parseTeamPosLabel(label: string): { team: string | null; firstPos: string | null } {
  // "(LAL - PG,SG)" -> team=LAL, firstPos=PG
  const m = label.match(/\(\s*([A-Z]{2,4})\s*-\s*([^)]+)\)/);
  if (!m) return { team: null, firstPos: null };
  const team = m[1];
  const posRaw = m[2].trim();
  const firstPos = posRaw.split(",")[0]?.trim() || null;
  return { team, firstPos };
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; PrismSportsBot/1.0)" },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.text();
}

/**
 * avg-overall.php numeric td.center order (0-based):
 * 0 PTS, 1 REB, 2 AST, ... 7 3PM, ... 10 MIN
 */
function scrapeAvgPage(html: string): { season: string; map: Map<number, { base: any; stats: StatPack }> } {
  const $ = cheerio.load(html);
  const season = parseSeason($);
  const out = new Map<number, { base: any; stats: StatPack }>();

  $("tr[class^='mpb-player-']").each((_, tr) => {
    const $tr = $(tr);

    const a = $tr.find("td.player-label a.fp-player-link").first();
    const cls = a.attr("class") || "";
    const idMatch = cls.match(/fp-id-(\d+)/);
    const fp_id = idMatch ? Number(idMatch[1]) : null;

    const player_name = (a.attr("fp-player-name") || a.text() || "").trim();
    const player_url = a.attr("href") || null;

    const small = $tr.find("td.player-label small").first().text().trim();
    const { team: team_abbr_raw, firstPos } = parseTeamPosLabel(small);

    const centers = $tr.find("td.center").toArray().map(td => $(td).text().trim());
    if (!fp_id || !player_name || centers.length < 11) return;

    const stats: StatPack = {
      pts: toNum(centers[0]),
      reb: toNum(centers[1]),
      ast: toNum(centers[2]),
      pm3: toNum(centers[7]),
      min: toNum(centers[10]),
    };

    out.set(fp_id, {
      base: { fp_id, player_name, player_url, team_abbr_raw, position: firstPos },
      stats,
    });
  });

  return { season, map: out };
}

function percentileMap(valuesById: Map<number, number>): Map<number, number> {
  const arr = [...valuesById.entries()].filter(([, v]) => Number.isFinite(v));
  arr.sort((a, b) => a[1] - b[1]);
  const out = new Map<number, number>();
  const n = arr.length;
  if (!n) return out;
  for (let i = 0; i < n; i++) {
    const [id] = arr[i];
    out.set(id, n === 1 ? 100 : (i / (n - 1)) * 100);
  }
  return out;
}

function buildComposite(rows: Map<number, PlayerRow>, stat: "pts"|"reb"|"ast"|"pm3"|"min"): Map<number, number> {
  const pull = (suffix: "szn"|"7"|"15") => {
    const m = new Map<number, number>();
    for (const [id, r] of rows.entries()) {
      const v = (r as any)[`${stat}_${suffix}`] as number | null;
      if (v != null && Number.isFinite(v)) m.set(id, v);
    }
    return m;
  };

  const pS = percentileMap(pull("szn"));
  const p7 = percentileMap(pull("7"));
  const p15 = percentileMap(pull("15"));

  const out = new Map<number, number>();
  for (const [id] of rows.entries()) {
    const parts: Array<[number, number]> = [];
    const s = pS.get(id); if (s != null) parts.push([s, W.szn]);
    const d15 = p15.get(id); if (d15 != null) parts.push([d15, W.d15]);
    const d7 = p7.get(id); if (d7 != null) parts.push([d7, W.d7]);
    if (!parts.length) continue;

    const wsum = parts.reduce((a, [, w]) => a + w, 0);
    const score = parts.reduce((a, [p, w]) => a + p * w, 0) / wsum;
    out.set(id, score);
  }
  return out;
}

function weightedAvg(a: number | null, b: number | null, c: number | null): number | null {
  let sum = 0;
  let wsum = 0;

  if (a != null) { sum += a * W.szn; wsum += W.szn; }
  if (b != null) { sum += b * W.d7;  wsum += W.d7; }
  if (c != null) { sum += c * W.d15; wsum += W.d15; }

  if (wsum === 0) return null;
  return sum / wsum;
}

/**
 * Convert spread to minutes factor (blowout risk).
 * We use abs spread buckets and clamp.
 */
function minutesFactorFromSpread(spread: number | null): number | null {
  if (spread == null) return null;
  const a = Math.abs(spread);

  let f =
    a <= 4.5 ? 1.03 :
    a <= 9.5 ? 1.00 :
    a <= 14.5 ? 0.95 :
               0.90;

  // Slight extra penalty for huge favorites (more likely to rest starters)
  if (spread <= -12) f -= 0.02;

  return clamp(f, 0.85, 1.06);
}

/* =========================
   MAIN
========================= */

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!supabaseUrl || !serviceKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // 1) scrape 3 windows
  const [htmlSzn, html7, html15] = await Promise.all([
    fetchHtml(URL_AVG_SZN),
    fetchHtml(URL_AVG_7),
    fetchHtml(URL_AVG_15),
  ]);

  const szn = scrapeAvgPage(htmlSzn);
  const d7 = scrapeAvgPage(html7);
  const d15 = scrapeAvgPage(html15);
  const season = szn.season;

  console.log(JSON.stringify({ step: "scrape_counts", season, season_rows: szn.map.size, last7_rows: d7.map.size, last15_rows: d15.map.size }, null, 2));

  // 2) build merged player rows
  const merged = new Map<number, PlayerRow>();

  function upsert(id: number, base: any) {
    if (merged.has(id)) return;
    merged.set(id, {
      season,
      fp_id: id,
      player_name: base.player_name,
      player_url: base.player_url ?? null,
      team_abbr_raw: base.team_abbr_raw ?? null,
      canonical: null,
      opponent: null,
      position: base.position ?? null,
      picture_url: `https://images.fantasypros.com/images/players/nba/${id}/headshot/70x70.png`,

      pts_szn: null, reb_szn: null, ast_szn: null, pm3_szn: null, min_szn: null,
      pts_7: null,   reb_7: null,   ast_7: null,   pm3_7: null,   min_7: null,
      pts_15: null,  reb_15: null,  ast_15: null,  pm3_15: null,  min_15: null,

      pts_comp: null, reb_comp: null, ast_comp: null, pm3_comp: null, min_comp: null,

      pin_spread_line: null,
      pin_total_line: null,
      implied_team_total: null,
      minutes_factor: null,
      pace_factor: null,
      team_total_factor: null,

      min_base: null,
      min_adj: null,
      pts_adj: null,
      reb_adj: null,
      ast_adj: null,
      pm3_adj: null,

      updated_at: new Date().toISOString(),
    });
  }

  function applyWindow(map: Map<number, { base: any; stats: StatPack }>, suffix: "szn"|"7"|"15") {
    for (const [id, v] of map.entries()) {
      upsert(id, v.base);
      const r = merged.get(id)!;

      // keep earliest seen base fields if missing
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

  applyWindow(szn.map, "szn");
  applyWindow(d7.map, "7");
  applyWindow(d15.map, "15");

  // 3) canonical mapping via team_map."Abbreviation" -> canonical
  const { data: teamMapRows, error: tmErr } = await supabase
    .from("team_map")
    .select('"Abbreviation", canonical')
    .limit(1000);

  if (tmErr) throw tmErr;

  const abbrToCanon = new Map<string, string>();
  for (const r of teamMapRows || []) {
    const abbr = (r as any)["Abbreviation"]?.toString().trim();
    const canon = (r as any).canonical?.toString().trim();
    if (abbr && canon) abbrToCanon.set(abbr, canon);
  }

  for (const r of merged.values()) {
    const raw = (r.team_abbr_raw || "").trim();
    r.canonical = raw ? (abbrToCanon.get(raw) ?? raw) : null;
  }

  // 4) pull Pinnacle spread/total from odds_wide_latest for each team
  const { data: oddsRows, error: oErr } = await supabase
    .from("odds_wide_latest")
    .select("team, pin_spread_line, pin_total_line")
    .limit(5000);

  if (oErr) throw oErr;

  const teamToOdds = new Map<string, { spread: number | null; total: number | null }>();
  for (const o of oddsRows || []) {
    const team = (o as any).team?.toString().trim();
    if (!team) continue;
    teamToOdds.set(team, {
      spread: (o as any).pin_spread_line ?? null,
      total: (o as any).pin_total_line ?? null,
    });
  }

  // 5) compute environment multipliers + adjusted projections
  for (const r of merged.values()) {
    const team = r.canonical;
    const odds = team ? teamToOdds.get(team) : undefined;

    r.pin_spread_line = odds?.spread ?? null;
    r.pin_total_line = odds?.total ?? null;

    // implied team total from team spread + game total
    // team_total = total/2 - spread/2 (spread is team line; negative fav => higher implied)
    if (r.pin_total_line != null && r.pin_spread_line != null) {
      r.implied_team_total = (r.pin_total_line / 2) - (r.pin_spread_line / 2);
      r.pace_factor = clamp(r.pin_total_line / NBA_AVG_TOTAL, 0.90, 1.10);
      r.team_total_factor = clamp(r.implied_team_total / NBA_AVG_TEAM_TOTAL, 0.85, 1.15);
    } else {
      r.implied_team_total = null;
      r.pace_factor = null;
      r.team_total_factor = null;
    }

    r.minutes_factor = minutesFactorFromSpread(r.pin_spread_line);

    // baseline minutes (weighted avg of raw MIN)
    r.min_base = weightedAvg(r.min_szn, r.min_7, r.min_15);

    // adjusted minutes = base minutes * minutes_factor
    r.min_adj =
      r.min_base != null && r.minutes_factor != null
        ? r.min_base * r.minutes_factor
        : r.min_base;

    // build per-minute rates (weighted averages of (stat/min))
    const rate = (stat_szn: number | null, stat_7: number | null, stat_15: number | null) => {
      const rS = (stat_szn != null && r.min_szn != null && r.min_szn > 0) ? stat_szn / r.min_szn : null;
      const r7 = (stat_7 != null && r.min_7 != null && r.min_7 > 0) ? stat_7 / r.min_7 : null;
      const r15 = (stat_15 != null && r.min_15 != null && r.min_15 > 0) ? stat_15 / r.min_15 : null;
      return weightedAvg(rS, r7, r15);
    };

    const ptsRate = rate(r.pts_szn, r.pts_7, r.pts_15);
    const astRate = rate(r.ast_szn, r.ast_7, r.ast_15);
    const pm3Rate = rate(r.pm3_szn, r.pm3_7, r.pm3_15);
    const rebRate = rate(r.reb_szn, r.reb_7, r.reb_15);

    // apply environment:
    // - PTS/AST/3PM: use team_total_factor (captures pace + scoring)
    // - REB: use pace_factor more than team scoring
    const ttf = r.team_total_factor ?? 1.0;
    const pf = r.pace_factor ?? 1.0;

    if (r.min_adj != null) {
      r.pts_adj = ptsRate != null ? ptsRate * r.min_adj * ttf : null;
      r.ast_adj = astRate != null ? astRate * r.min_adj * ttf : null;
      r.pm3_adj = pm3Rate != null ? pm3Rate * r.min_adj * ttf : null;

      // rebounds: pace-heavy
      r.reb_adj = rebRate != null ? rebRate * r.min_adj * pf : null;
    } else {
      r.pts_adj = r.ast_adj = r.pm3_adj = r.reb_adj = null;
    }
  }

  // 6) composite percentiles (still useful for “player quality”)
  const ptsComp = buildComposite(merged, "pts");
  const rebComp = buildComposite(merged, "reb");
  const astComp = buildComposite(merged, "ast");
  const pm3Comp = buildComposite(merged, "pm3");
  const minComp = buildComposite(merged, "min");

  for (const [id, s] of ptsComp.entries()) merged.get(id)!.pts_comp = s;
  for (const [id, s] of rebComp.entries()) merged.get(id)!.reb_comp = s;
  for (const [id, s] of astComp.entries()) merged.get(id)!.ast_comp = s;
  for (const [id, s] of pm3Comp.entries()) merged.get(id)!.pm3_comp = s;
  for (const [id, s] of minComp.entries()) merged.get(id)!.min_comp = s;

  // 7) build payload + RESET per season
  const payload = [...merged.values()].map(r => ({
    season: r.season,
    fp_id: r.fp_id,
    player_name: r.player_name,
    player_url: r.player_url,

    team_abbr_raw: r.team_abbr_raw,
    canonical: r.canonical,
    position: r.position,
    opponent: r.opponent,

    picture_url: r.picture_url,

    pts_szn: r.pts_szn, reb_szn: r.reb_szn, ast_szn: r.ast_szn, pm3_szn: r.pm3_szn, min_szn: r.min_szn,
    pts_7: r.pts_7,     reb_7: r.reb_7,     ast_7: r.ast_7,     pm3_7: r.pm3_7,     min_7: r.min_7,
    pts_15: r.pts_15,   reb_15: r.reb_15,   ast_15: r.ast_15,   pm3_15: r.pm3_15,   min_15: r.min_15,

    pts_comp: r.pts_comp, reb_comp: r.reb_comp, ast_comp: r.ast_comp, pm3_comp: r.pm3_comp, min_comp: r.min_comp,

    pin_spread_line: r.pin_spread_line,
    pin_total_line: r.pin_total_line,
    implied_team_total: r.implied_team_total,
    minutes_factor: r.minutes_factor,
    pace_factor: r.pace_factor,
    team_total_factor: r.team_total_factor,

    min_base: r.min_base,
    min_adj: r.min_adj,
    pts_adj: r.pts_adj,
    reb_adj: r.reb_adj,
    ast_adj: r.ast_adj,
    pm3_adj: r.pm3_adj,

    updated_at: new Date().toISOString(),
  }));

  const { error: delErr, count: delCount } = await supabase
    .from("nba_player_prop_baselines")
    .delete({ count: "exact" })
    .eq("season", season);

  if (delErr) throw delErr;

  const { error: insErr } = await supabase.from("nba_player_prop_baselines").insert(payload);
  if (insErr) throw insErr;

  console.log(JSON.stringify({ ok: true, season, deleted_rows: delCount ?? null, inserted_rows: payload.length }, null, 2));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

