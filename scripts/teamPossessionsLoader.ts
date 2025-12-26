/**
 * teamPossessionsLoader.ts — TeamRankings possessions-per-game → Supabase team_possessions
 *
 * NBA:
 *   https://www.teamrankings.com/nba/stat/possessions-per-game
 * NCAAB:
 *   https://www.teamrankings.com/ncaa-basketball/stat/possessions-per-game
 *
 * Writes:
 *   public.team_possessions:
 *     sport_key, season, canonical,
 *     "2025", "Last 3", "Last 1", "Home", "Away", "2024", updated_at
 *
 * Notes:
 * - TeamRankings may block aggressive scraping; we use headers + retries.
 * - Mapping uses public.team_map; add/adjust columns in the SELECT as needed.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

/* =========================
   CONFIG
========================= */
const SPORT_KEY = process.env.SPORT_KEY || "basketball_ncaab"; // "basketball_nba" or "basketball_ncaab"
const SEASON = process.env.SEASON || "2025-26"; // store in season column (your choice)
const MAX_TRIES = Number(process.env.MAX_TRIES || "4");

const URL_BY_SPORT: Record<string, string> = {
  basketball_nba: "https://www.teamrankings.com/nba/stat/possessions-per-game",
  basketball_ncaab: "https://www.teamrankings.com/ncaa-basketball/stat/possessions-per-game",
};

function targetUrl() {
  const url = URL_BY_SPORT[SPORT_KEY];
  if (!url) throw new Error(`Unsupported SPORT_KEY=${SPORT_KEY}. Expected basketball_nba or basketball_ncaab.`);
  return url;
}

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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function toNum(v: string | null | undefined): number | null {
  const s = String(v ?? "").trim();
  if (!s || s === "--") return null;
  const n = Number(s);
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
        throw new Error(`HTTP ${res.status} for ${url} :: ${body.slice(0, 200)}`);
      }

      const html = await res.text();
      if (!html || html.length < 2000) {
        throw new Error(`Suspiciously short HTML from ${url} (len=${html?.length ?? 0})`);
      }

      return html;
    } catch (e) {
      lastErr = e;
      await sleep(700 * t * t);
    }
  }

  throw lastErr;
}

/* =========================
   TEAM MAP LOADER
   Build a lookup from many possible team_map columns -> canonical
========================= */
async function loadTeamMap(
  supabase: ReturnType<typeof createClient>
): Promise<Map<string, string>> {
  // Add/remove columns as your team_map evolves.
  const { data, error } = await supabase
    .from("team_map")
    .select(
      [
        "canonical",
        `"SR_School"`,
        `"BasketballReference"`,
        `"ESPN_Long"`,
        `"The Odds API"`,
        `"KenPom"`,
        `"Elo"`,
        `"TeamRankings"`, // if you add this column later, it will be used automatically
      ].join(",")
    )
    .not("canonical", "is", null);

  if (error) throw error;

  const map = new Map<string, string>();

  for (const r of (data || []) as any[]) {
    const canonical = String(r.canonical || "").trim();
    if (!canonical) continue;

    const candidates: string[] = [
      canonical,
      r["TeamRankings"],
      r["SR_School"],
      r["BasketballReference"],
      r["ESPN_Long"],
      r["The Odds API"],
      r["KenPom"],
      r["Elo"],
    ]
      .map((x) => String(x || "").trim())
      .filter(Boolean);

    for (const name of candidates) {
      map.set(normalizeKey(name), canonical);
    }
  }

  if (map.size === 0) throw new Error("team_map produced 0 mappings (check columns + data).");
  return map;
}

/* =========================
   PARSE TEAMRANKINGS TABLE
   We extract:
     Team name (anchor text)
     Then 6 numeric columns:
       2025, Last 3, Last 1, Home, Away, 2024
   Your sample row matches this.
========================= */
type TRRow = {
  teamName: string;
  v2025: number | null;
  last3: number | null;
  last1: number | null;
  home: number | null;
  away: number | null;
  v2024: number | null;
};

function parseTeamRankingsPossessions(html: string): TRRow[] {
  const rows: TRRow[] = [];

  // Grab all <tr ...>...</tr>
  const trMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trMatches) {
    // Must contain the team link cell
    const teamMatch = tr.match(/<td[^>]*data-sort="[^"]*"[^>]*>\s*<a[^>]*>([^<]+)<\/a>\s*<\/td>/i);
    if (!teamMatch?.[1]) continue;

    const teamName = teamMatch[1].trim();

    // Grab all td data-sort numeric values for the row
    // Expect pattern: rank td then team td then 6 numeric tds.
    const tdSorts = Array.from(tr.matchAll(/<td[^>]*data-sort="([^"]+)"[^>]*>/gi)).map((m) => m[1]);

    // tdSorts includes rank and team and numbers; we want the LAST 6 numeric fields
    // TeamRankings pages are consistent: Rank, Team, 2025, Last 3, Last 1, Home, Away, 2024
    // We'll parse from the end to be robust.
    if (tdSorts.length < 8) continue;

    const tail = tdSorts.slice(-6);
    const [s2025, sLast3, sLast1, sHome, sAway, s2024] = tail;

    rows.push({
      teamName,
      v2025: toNum(s2025),
      last3: toNum(sLast3),
      last1: toNum(sLast1),
      home: toNum(sHome),
      away: toNum(sAway),
      v2024: toNum(s2024),
    });
  }

  // De-dupe by teamName just in case
  const seen = new Set<string>();
  const out: TRRow[] = [];
  for (const r of rows) {
    const k = normalizeKey(r.teamName);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }

  if (!out.length) {
    throw new Error("Parsed 0 rows from TeamRankings HTML (page layout may have changed or blocked).");
  }
  return out;
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

  const url = targetUrl();

  // 1) Load mappings
  const nameToCanon = await loadTeamMap(supabase);

  // 2) Fetch page
  const html = await fetchHtmlWithRetries(url, MAX_TRIES);

  // 3) Parse rows
  const parsed = parseTeamRankingsPossessions(html);

  // 4) Map to canonical + build upsert rows
  const nowIso = new Date().toISOString();

  const upserts: any[] = [];
  const missing: string[] = [];

  for (const r of parsed) {
    const canon = nameToCanon.get(normalizeKey(r.teamName));
    if (!canon) {
      missing.push(r.teamName);
      continue;
    }

    upserts.push({
      sport_key: SPORT_KEY,
      season: SEASON,
      canonical: canon,
      updated_at: nowIso,

      // quoted columns in Postgres must be referenced by exact string keys
      "2025": r.v2025,
      "Last 3": r.last3,
      "Last 1": r.last1,
      "Home": r.home,
      "Away": r.away,
      "2024": r.v2024,
    });
  }

  if (!upserts.length) {
    throw new Error(
      `0 mapped rows after canonicalization. Missing examples: ${missing.slice(0, 10).join(", ")}`
    );
  }

  // 5) Upsert
  const { error } = await supabase.from("team_possessions").upsert(upserts, {
    onConflict: "sport_key,season,canonical",
  });
  if (error) throw error;

  console.log(
    JSON.stringify(
      {
        ok: true,
        sport_key: SPORT_KEY,
        season: SEASON,
        source_url: url,
        rows_parsed: parsed.length,
        rows_upserted: upserts.length,
        missing_count: missing.length,
        missing_sample: missing.slice(0, 25),
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
