/**
 * teamRankingsStatsLoader.ts — TeamRankings multi-stat loader → Supabase ncaab_stats
 * ---------------------------------------------------------------------------------
 * Pulls ALL relevant NCAAB team stats and builds Home/Away composites
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

/* =========================
   CONFIG
========================= */
const SPORT_KEY = "basketball_ncaab";
const SEASON = process.env.SEASON || "2025-26";
const MAX_TRIES = 4;

const BASE_URL = "https://www.teamrankings.com/ncaa-basketball/stat";

/** 👉 Add/remove stats HERE */
const STAT_SLUGS = [
  "points-per-game",
  "points-allowed-per-game",
  "offensive-efficiency",
  "defensive-efficiency",
  "effective-field-goal-pct",
  "opponent-effective-field-goal-pct",
  "turnovers-per-game",
  "opponent-turnovers-per-game",
  "assists-per-game",
  "offensive-rebounds-per-game",
  "defensive-rebounds-per-game",
  "free-throw-rate",
  "opponent-free-throw-rate",
  "three-point-pct",
  "two-point-pct",
  "average-scoring-margin",
  "possessions-per-game",
];

/* =========================
   HELPERS
========================= */
const normalizeKey = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const toNum = (v: string | null) => {
  if (!v || v === "--") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url: string) {
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

    const tds = Array.from(tr.matchAll(/data-sort="([^"]+)"/g)).map((m) => m[1]);
    if (tds.length < 8) continue;

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
  const parts = [
    [primary, 0.4],
    [v2025, 0.25],
    [l3, 0.15],
    [l1, 0.1],
    [v2024, 0.1],
  ];

  let num = 0;
  let den = 0;

  for (const [v, w] of parts) {
    if (v !== null) {
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

  // reset season
  await supabase
    .from("ncaab_stats")
    .delete()
    .eq("sport_key", SPORT_KEY)
    .eq("season", SEASON);

  const upserts: any[] = [];

  for (const stat of STAT_SLUGS) {
    const url = `${BASE_URL}/${stat}`;
    const html = await fetchHtml(url);
    const parsed = parseStatTable(html);

    for (const r of parsed) {
      const canon = trToCanon.get(normalizeKey(r.team));
      if (!canon) continue;

      upserts.push({
        sport_key: SPORT_KEY,
        season: SEASON,
        canonical: canon,
        stat_key: stat,
        v_2025: r.v2025,
        last_3: r.last3,
        last_1: r.last1,
        home_raw: r.home,
        away_raw: r.away,
        v_2024: r.v2024,
        home_score: composite(r.home, r.v2025, r.last3, r.last1, r.v2024),
        away_score: composite(r.away, r.v2025, r.last3, r.last1, r.v2024),
        updated_at: new Date().toISOString(),
      });
    }
  }

  await supabase.from("ncaab_stats").upsert(upserts, {
    onConflict: "sport_key,season,canonical,stat_key",
  });

  console.log(`✅ Loaded ${upserts.length} stat rows`);
}

main().catch(console.error);
