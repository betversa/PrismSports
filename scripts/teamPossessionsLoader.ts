/**
 * teamPossessionsLoader.ts — TeamRankings possessions-per-game → Supabase team_possessions
 * ---------------------------------------------------------------------------------------
 * NBA:
 *   https://www.teamrankings.com/nba/stat/possessions-per-game
 * NCAAB:
 *   https://www.teamrankings.com/ncaa-basketball/stat/possessions-per-game
 *
 * Writes to:
 *   public.team_possessions:
 *     sport_key, season, canonical, updated_at,
 *     "2025", "Last 3", "Last 1", "Home", "Away", "2024"
 *
 * Key behaviors:
 *  ✅ Uses team_map."TR" as the primary mapping (TeamRankings → canonical)
 *  ✅ Resets (deletes) rows for (sport_key, season) at start of every run
 *  ✅ Dedupes within the same run (prevents Postgres 21000 upsert error)
 *  ✅ Logs missing team mappings
 *
 * Required constraint:
 *  - PK/unique on (sport_key, season, canonical) in public.team_possessions
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

/* =========================
   CONFIG
========================= */
const SPORT_KEY = process.env.SPORT_KEY || "basketball_ncaab"; // basketball_ncaab | basketball_nba
const SEASON = process.env.SEASON || "2025-26";
const MAX_TRIES = Number(process.env.MAX_TRIES || "4");

const URL_BY_SPORT: Record<string, string> = {
  basketball_nba: "https://www.teamrankings.com/nba/stat/possessions-per-game",
  basketball_ncaab: "https://www.teamrankings.com/ncaa-basketball/stat/possessions-per-game",
};

function targetUrl(): string {
  const url = URL_BY_SPORT[SPORT_KEY];
  if (!url) {
    throw new Error(
      `Unsupported SPORT_KEY=${SPORT_KEY}. Expected one of: ${Object.keys(URL_BY_SPORT).join(", ")}`
    );
  }
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
   LOAD TEAM MAP (TR → canonical)
   - Uses team_map."TR" as TeamRankings mapping key
========================= */
async function loadTeamMapTR(
  supabase: ReturnType<typeof createClient>
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("team_map")
    .select('canonical,"TR"')
    .not("canonical", "is", null);

  if (error) throw error;

  const nameToCanon = new Map<string, string>();

  for (const r of (data || []) as any[]) {
    const canonical = String(r.canonical || "").trim();
    if (!canonical) continue;

    const tr = String(r["TR"] || "").trim();
    if (tr) {
      // If TR duplicates exist, later rows overwrite earlier ones; we'll dedupe at insert time anyway.
      nameToCanon.set(normalizeKey(tr), canonical);
    }
  }

  if (nameToCanon.size === 0) {
    throw new Error('team_map produced 0 mappings. Make sure team_map."TR" is populated.');
  }

  return nameToCanon;
}

/* =========================
   PARSE TEAMRANKINGS TABLE ROWS
   Expected columns after Team cell:
     2025, Last 3, Last 1, Home, Away, 2024
   We rely on td data-sort values, using the last 6.
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
  const out: TRRow[] = [];

  const trMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trMatches) {
    // Team name is in the <a> within the team column <td ...><a>TEAM</a></td>
    const teamMatch = tr.match(
      /<td[^>]*class="text-left nowrap"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i
    );
    if (!teamMatch?.[1]) continue;

    const teamName = teamMatch[1].trim();

    // Collect all data-sort values
    const tdSorts = Array.from(tr.matchAll(/<td[^>]*data-sort="([^"]+)"[^>]*>/gi)).map(
      (m) => m[1]
    );

    // We expect at least: rank + team + 6 numbers = 8 tds with data-sort
    if (tdSorts.length < 8) continue;

    const tail = tdSorts.slice(-6);
    const [s2025, sLast3, sLast1, sHome, sAway, s2024] = tail;

    out.push({
      teamName,
      v2025: toNum(s2025),
      last3: toNum(sLast3),
      last1: toNum(sLast1),
      home: toNum(sHome),
      away: toNum(sAway),
      v2024: toNum(s2024),
    });
  }

  // Dedup by TeamRankings teamName just in case
  const seen = new Set<string>();
  const dedup: TRRow[] = [];
  for (const r of out) {
    const k = normalizeKey(r.teamName);
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(r);
  }

  if (!dedup.length) {
    throw new Error("Parsed 0 rows from TeamRankings (layout changed or request blocked).");
  }

  return dedup;
}

/* =========================
   RESET TABLE SLICE
========================= */
async function resetSportSeason(
  supabase: ReturnType<typeof createClient>,
  sportKey: string,
  season: string
) {
  const { error } = await supabase
    .from("team_possessions")
    .delete()
    .eq("sport_key", sportKey)
    .eq("season", season);

  if (error) throw error;
}

/* =========================
   BUILD + DEDUPE UPSERT ROWS
========================= */
function dedupeByConflictKey(rows: any[]) {
  const byKey = new Map<string, any>();

  const fields = ["2025", "Last 3", "Last 1", "Home", "Away", "2024"];

  const score = (r: any) =>
    fields.reduce((s, f) => s + (r?.[f] === null || r?.[f] === undefined ? 0 : 1), 0);

  for (const row of rows) {
    const key = `${row.sport_key}||${row.season}||${row.canonical}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, row);
      continue;
    }
    // Keep the row with more populated values; tie -> keep latest
    if (score(row) >= score(prev)) byKey.set(key, row);
  }

  return Array.from(byKey.values());
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

  // 1) Load TeamRankings → canonical mapping
  const trToCanon = await loadTeamMapTR(supabase);

  // 2) Fetch HTML
  const html = await fetchHtmlWithRetries(url, MAX_TRIES);

  // 3) Parse rows
  const parsed = parseTeamRankingsPossessions(html);

  // 4) Reset existing rows for this sport+season
  await resetSportSeason(supabase, SPORT_KEY, SEASON);

  // 5) Build upserts
  const nowIso = new Date().toISOString();
  const upserts: any[] = [];
  const missing: string[] = [];

  for (const r of parsed) {
    const canon = trToCanon.get(normalizeKey(r.teamName));
    if (!canon) {
      missing.push(r.teamName);
      continue;
    }

    upserts.push({
      sport_key: SPORT_KEY,
      season: SEASON,
      canonical: canon,
      updated_at: nowIso,

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
      `0 mapped rows after canonicalization. Missing examples: ${missing.slice(0, 15).join(", ")}`
    );
  }

  // 6) Dedup within the same run (prevents Postgres 21000 in upsert)
  const deduped = dedupeByConflictKey(upserts);
  const dedupedN = deduped.length;
  const dropped = upserts.length - dedupedN;

  // 7) Upsert
  const { error } = await supabase.from("team_possessions").upsert(deduped, {
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
        rows_mapped: upserts.length,
        rows_deduped: dedupedN,
        deduped_dropped: dropped,
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
