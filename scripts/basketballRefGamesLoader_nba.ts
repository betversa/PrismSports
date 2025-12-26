import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";

type TeamMapRow = {
  canonical: string;
  BasketballReference?: string | null; // optional (column may not exist)
};

type BrefGameRow = {
  season: string;
  date: string; // YYYY-MM-DD
  away_team: string;
  home_team: string;
  away_pts: number | null;
  home_pts: number | null;
  overtime: string | null;
  notes: string | null;
  source_url: string;
  updated_at?: string;
};

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

function normKey(s: string) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[\.\'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchHtml(url: string) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

/**
 * Loads a resolver based on team_map."BasketballReference" -> canonical
 * If the column doesn't exist or query fails, falls back to identity.
 */
async function loadBrefResolver(): Promise<(name: string) => string> {
  // Try selecting the column; if it doesn't exist, Supabase returns an error.
  const { data, error } = await supabase
    .from("team_map")
    .select('canonical, "BasketballReference"');

  if (error) {
    console.warn('[BR] team_map load failed (no BasketballReference col?):', error.message);
    return (n) => String(n ?? "").trim();
  }

  const map = new Map<string, string>();
  for (const r of (data ?? []) as any[]) {
    const canonical = String(r.canonical ?? "").trim();
    const br = String(r["BasketballReference"] ?? "").trim();
    if (!canonical || !br) continue;
    map.set(normKey(br), canonical);
  }

  return (name: string) => {
    const raw = String(name ?? "").trim();
    const key = normKey(raw);
    return map.get(key) ?? raw;
  };
}

/**
 * Basketball-Reference NBA schedule index:
 * https://www.basketball-reference.com/leagues/NBA_2026_games.html
 *
 * It links to month pages like:
 * .../NBA_2026_games-october.html, ...-november.html, etc.
 */
function seasonToIndexUrl(seasonEndYear: number) {
  return `https://www.basketball-reference.com/leagues/NBA_${seasonEndYear}_games.html`;
}

function seasonToMonthUrl(seasonEndYear: number, href: string) {
  // href is like "/leagues/NBA_2026_games-october.html"
  if (href.startsWith("http")) return href;
  return `https://www.basketball-reference.com${href}`;
}

function mmddyyyyToISO(dateText: string) {
  // BR uses "Tue, Oct 22, 2025" style on month pages
  // We’ll parse via Date for robustness.
  const d = new Date(dateText);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseMonthPage(html: string, url: string, season: string, resolveTeam: (n: string) => string): BrefGameRow[] {
  const $ = cheerio.load(html);
  const rows: BrefGameRow[] = [];

  // Month pages contain a table with id="schedule"
  const table = $("#schedule");
  if (!table.length) return rows;

  table.find("tbody tr").each((_, tr) => {
    const $tr = $(tr);

    // Skip header separator rows
    if ($tr.hasClass("thead")) return;

    // Date is in th[data-stat="date_game"]
    const dateText = $tr.find('th[data-stat="date_game"]').text().trim();
    const dateISO = mmddyyyyToISO(dateText);
    if (!dateISO) return;

    const awayRaw = $tr.find('td[data-stat="visitor_team_name"]').text().trim();
    const homeRaw = $tr.find('td[data-stat="home_team_name"]').text().trim();
    if (!awayRaw || !homeRaw) return;

    const away_team = resolveTeam(awayRaw);
    const home_team = resolveTeam(homeRaw);

    const awayPtsText = $tr.find('td[data-stat="visitor_pts"]').text().trim();
    const homePtsText = $tr.find('td[data-stat="home_pts"]').text().trim();

    const away_pts = awayPtsText ? Number(awayPtsText) : null;
    const home_pts = homePtsText ? Number(homePtsText) : null;

    const overtime = $tr.find('td[data-stat="overtimes"]').text().trim() || null;
    const notes = $tr.find('td[data-stat="game_remarks"]').text().trim() || null;

    rows.push({
      season,
      date: dateISO,
      away_team,
      home_team,
      away_pts: Number.isFinite(away_pts as any) ? away_pts : null,
      home_pts: Number.isFinite(home_pts as any) ? home_pts : null,
      overtime,
      notes,
      source_url: url,
    });
  });

  return rows;
}

async function upsertGames(rows: BrefGameRow[]) {
  if (!rows.length) return 0;

  const CHUNK = 1000;
  let total = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => ({
      ...r,
      updated_at: new Date().toISOString(),
    }));

    const { error } = await supabase
      .from("basketballref_games_nba")
      .upsert(chunk, { onConflict: "season,date,away_team,home_team" });

    if (error) throw new Error(`Upsert failed: ${error.message}`);
    total += chunk.length;
  }

  return total;
}

async function main() {
  // Example: for 2025-26 NBA season, BR uses NBA_2026_...
  const seasonEndYear = Number(process.env.BR_NBA_SEASON_END_YEAR ?? "2026");
  const season = process.env.BR_NBA_SEASON ?? "2025-26";

  const indexUrl = seasonToIndexUrl(seasonEndYear);

  console.log(`[BR] fetching index: ${indexUrl}`);
  const resolveTeam = await loadBrefResolver();
  const indexHtml = await fetchHtml(indexUrl);

  const $ = cheerio.load(indexHtml);

  // Find month links (they live under div#content and are usually in a filter/list)
  const monthHrefs = new Set<string>();
  $('a[href*="NBA_' + seasonEndYear + '_games-"]').each((_, a) => {
    const href = $(a).attr("href");
    if (href) monthHrefs.add(href);
  });

  // Some seasons also have "playoffs" link. Keep only month pages.
  const monthUrls = [...monthHrefs]
    .filter((h) => /NBA_\d+_games-(october|november|december|january|february|march|april|may|june)\.html/i.test(h))
    .map((h) => seasonToMonthUrl(seasonEndYear, h));

  if (!monthUrls.length) {
    throw new Error(`[BR] Could not find month schedule links on index page: ${indexUrl}`);
  }

  console.log(`[BR] month pages found: ${monthUrls.length}`);

  const allRows: BrefGameRow[] = [];
  for (const url of monthUrls) {
    console.log(`[BR] fetching month: ${url}`);
    const html = await fetchHtml(url);
    const rows = parseMonthPage(html, url, season, resolveTeam);
    console.log(`[BR] parsed ${rows.length} rows from month page`);
    allRows.push(...rows);
  }

  // De-dupe just in case
  const key = (r: BrefGameRow) => `${r.season}|${r.date}|${r.away_team}|${r.home_team}`;
  const dedup = new Map<string, BrefGameRow>();
  for (const r of allRows) dedup.set(key(r), r);

  const finalRows = [...dedup.values()];
  console.log(`[BR] total unique games: ${finalRows.length}`);

  const upserted = await upsertGames(finalRows);
  console.log(`[BR] upserted: ${upserted}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
