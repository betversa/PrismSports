/**
 * teamRankingsStatsLoader.ts — NCAAB COMPLETE STAT INGEST (v3.0)
 * -----------------------------------------------------------------------------------
 * Scrapes TeamRankings NCAAB stats (ALL core + opponent stats),
 * normalizes units, builds home/away composites,
 * and upserts into public.ncaab_stats.
 *
 * This loader is intentionally conservative and unit-safe.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

/* =========================
   CONFIG
========================= */

const SPORT_KEY = "basketball_ncaab";
const SEASON = process.env.SEASON || "2025-26";
const BASE_URL = "https://www.teamrankings.com/ncaa-basketball/stat";
const MAX_TRIES = 4;

/**
 * COMPLETE STAT CONTRACT
 * (Every stat we agreed on)
 */
const STAT_SLUGS: string[] = [
  // --- CORE ---
  "possessions-per-game",
  "offensive-efficiency",
  "defensive-efficiency",
  "points-per-game",
  "opponent-points-per-game",
  "average-scoring-margin",

  // --- SHOT QUALITY ---
  "effective-field-goal-pct",
  "opponent-effective-field-goal-pct",

  // --- SHOT MIX ---
  "three-point-rate",
  "two-point-rate",
  "opponent-three-point-rate",
  "opponent-two-point-rate",

  // --- SHOT ACCURACY ---
  "three-point-pct",
  "two-point-pct",
  "opponent-three-point-pct",
  "opponent-two-point-pct",

  // --- FREE THROWS ---
  "fta-per-fga",
  "opponent-fta-per-fga",
  "free-throw-pct",
  "opponent-free-throw-pct",

  // --- TURNOVERS ---
  "turnover-pct",
  "opponent-turnover-pct",

  // --- REBOUNDING ---
  "offensive-rebounding-pct",
  "defensive-rebounding-pct",
  "opponent-offensive-rebounding-pct",
  "opponent-defensive-rebounding-pct",

  // --- VOLATILITY ---
  "steals-perpossession",
  "opponent-steals-perpossession",
  "block-pct",
  "opponent-block-pct",

  // --- FOUL ENVIRONMENT ---
  "personal-fouls-per-possession",
  "opponent-personal-fouls-per-possession",

  // --- ADVANCED POSSESSION QUALITY ---
  "effective-possession-ratio",
  "opponent-effective-possession-ratio",
];

/* =========================
   HELPERS
========================= */

const normalizeKey = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const toNum = (v: string | null): number | null => {
  if (!v || v === "--") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const normalizePct = (v: number | null): number | null => {
  if (v == null) return null;
  // Convert 52.3 → 0.523, leave 0.523 alone
  if (v > 1.5) return v / 100;
  return v;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url: string): Promise<string> {
  for (let i = 1; i <= MAX_TRIES; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "text/html",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      if (html.length < 2000) throw new Error("Short HTML");
      return html;
    } catch (e) {
      if (i === MAX_TRIES) throw e;
      await sleep(500 * i * i);
    }
  }
  throw new Error("fetch failed");
}

/* =========================
   PARSER
========================= */

type ParsedRow = {
  team: string;
  v2025: number | null;
  last3: number | null;
  last1: number | null;
  home: number | null;
  away: number | null;
  v2024: number | null;
};

function parseStatTable(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];

  const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trs) {
    const teamMatch = tr.match(/<a[^>]*>([^<]+)<\/a>/);
    if (!teamMatch) continue;

    const tds = Array.from(tr.matchAll(/data-sort="([^"]+)"/g)).map(
      (m) => m[1]
    );
    if (tds.length < 6) continue;

    const [v2025, l3, l1, h, a, v2024] = tds.slice(-6);

    rows.push({
      team: teamMatch[1].trim(),
      v2025: toNum(v2025),
      last3: toNum(l3),
      last1: toNum(l1),
      home: toNum(h),
      away: toNum(a),
      v2024: toNum(v2024),
    });
  }

  return rows;
}

/* =========================
   COMPOSITES
========================= */

function composite(
  primary: number | null,
  v2025: number | null,
  l3: number | null,
  l1: number | null,
  v2024: number | null
) {
  const parts: Array<[number | null, number]> = [
    [primary, 0.4],
    [v2025, 0.25],
    [l3, 0.15],
    [l1, 0.1],
    [v2024, 0.1],
  ];

  let num = 0;
  let den = 0;

  for (const [v, w] of parts) {
    if (v != null && v !== 0) {
      num += v * w;
      den += w;
    }
  }

  return den ? num / den : null;
}

/* =========================
   MAIN
========================= */

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: teamMap } = await supabase
    .from("team_map")
    .select('canonical,"TR"');

  const trToCanon = new Map(
    teamMap!.map((r) => [normalizeKey(r.TR), r.canonical])
  );

  // Reset season
  await supabase
    .from("ncaab_stats")
    .delete()
    .eq("sport_key", SPORT_KEY)
    .eq("season", SEASON);

  const upserts: any[] = [];

  for (const stat of STAT_SLUGS) {
    const url = `${BASE_URL}/${stat}`;
    console.log(`Fetching ${stat}`);
    const html = await fetchHtml(url);
    const parsed = parseStatTable(html);

    const isPctLike =
      stat.includes("pct") ||
      stat.includes("rate") ||
      stat.includes("ratio");

    for (const r of parsed) {
      const canon = trToCanon.get(normalizeKey(r.team));
      if (!canon) continue;

      const v2025 = isPctLike ? normalizePct(r.v2025) : r.v2025;
      const last3 = isPctLike ? normalizePct(r.last3) : r.last3;
      const last1 = isPctLike ? normalizePct(r.last1) : r.last1;
      const home = isPctLike ? normalizePct(r.home) : r.home;
      const away = isPctLike ? normalizePct(r.away) : r.away;
      const v2024 = isPctLike ? normalizePct(r.v2024) : r.v2024;

      upserts.push({
        sport_key: SPORT_KEY,
        season: SEASON,
        canonical: canon,
        stat_key: stat,
        v_2025: v2025,
        last_3: last3,
        last_1: last1,
        home_raw: home,
        away_raw: away,
        v_2024: v2024,
        home_score: composite(home, v2025, last3, last1, v2024),
        away_score: composite(away, v2025, last3, last1, v2024),
        updated_at: new Date().toISOString(),
      });
    }
  }

  await supabase.from("ncaab_stats").upsert(upserts, {
    onConflict: "sport_key,season,canonical,stat_key",
  });

  console.log(`✅ Loaded ${upserts.length} NCAAB stat rows`);
}

main().catch((e) => {
  console.error("❌ teamRankingsStatsLoader failed");
  console.error(e);
  process.exit(1);
});
