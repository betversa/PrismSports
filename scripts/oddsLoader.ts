import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type OddsApiEvent = {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    last_update?: string;
    markets: Array<{
      key: "h2h" | "spreads" | "totals";
      outcomes: Array<{
        name: string;      // team name OR "Over"/"Under"
        price: number;     // american odds (int)
        point?: number;    // spread/total line
      }>;
    }>;
  }>;
};

const SPORT_KEY = "basketball_ncaab";
const MARKETS = "h2h,spreads,totals";
const BOOKMAKERS =
  "draftkings,fanduel,betmgm,betrivers,hardrockbet,betonlineag,pinnacle";

function normalizeTeamKey(s: string) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\u00A0/g, " ")
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9\s&'.-]/g, "")
    .replace(/\s+/g, " ");
}

function matchup(away: string, home: string) {
  return `${away} @ ${home}`;
}

async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL!;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const ODDS_API_KEY = process.env.ODDS_API_KEY!;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ODDS_API_KEY) {
    throw new Error("Missing env vars: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ODDS_API_KEY");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ---- 1) Build alias map from team_map (canonical + aliases[])
  const { data: teamRows, error: teamErr } = await supabase
    .from("team_map")
    .select("canonical, aliases");

  if (teamErr) throw teamErr;

  const aliasMap = new Map<string, string>();
  for (const r of teamRows || []) {
    const canon = r.canonical as string;
    aliasMap.set(normalizeTeamKey(canon), canon);
    const aliases = (r.aliases || []) as string[];
    for (const a of aliases) aliasMap.set(normalizeTeamKey(a), canon);
  }

  const missingTeams = new Set<string>();

  const canonicalize = (name: string) => {
    const raw = String(name || "").trim();
    const key = normalizeTeamKey(raw);
    const canon = aliasMap.get(key);
    if (canon) return canon;
    if (raw) missingTeams.add(raw);
    return raw;
  };

  // ---- 2) Fetch Odds API
  const url =
    `https://api.the-odds-api.com/v4/sports/${SPORT_KEY}/odds` +
    `?apiKey=${ODDS_API_KEY}` +
    `&bookmakers=${BOOKMAKERS}` +
    `&markets=${MARKETS}` +
    `&oddsFormat=american&dateFormat=iso`;

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Odds API error ${res.status}: ${txt}`);
  }

  const events = (await res.json()) as OddsApiEvent[];

  // ---- 3) Upsert events
  const eventUpserts = events.map((e) => {
    const canonHome = canonicalize(e.home_team);
    const canonAway = canonicalize(e.away_team);

    return {
      event_id: e.id,
      sport_key: SPORT_KEY,
      commence_time: e.commence_time,
      api_home_team: e.home_team,
      api_away_team: e.away_team,
      canon_home_team: canonHome,
      canon_away_team: canonAway,
      matchup: matchup(canonAway, canonHome),
      updated_at: new Date().toISOString(),
    };
  });

  // chunk to avoid payload limits
  const chunk = <T,>(arr: T[], size: number) =>
    Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
      arr.slice(i * size, (i + 1) * size)
    );

  for (const batch of chunk(eventUpserts, 500)) {
    const { error } = await supabase.from("events").upsert(batch, {
      onConflict: "event_id",
    });
    if (error) throw error;
  }

  // ---- 4) Log missing teams (team_missing_log)
  for (const team of missingTeams) {
    // Upsert-ish: insert if new, else update last_seen + increment seen_count
    const { data: existing } = await supabase
      .from("team_missing_log")
      .select("team_name, seen_count")
      .eq("team_name", team)
      .maybeSingle();

    if (!existing) {
      const { error } = await supabase.from("team_missing_log").insert({
        team_name: team,
      });
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("team_missing_log")
        .update({
          last_seen: new Date().toISOString(),
          seen_count: (existing.seen_count || 1) + 1,
        })
        .eq("team_name", team);
      if (error) throw error;
    }
  }

  // ---- 5) Build odds_snapshot rows
  const nowTs = new Date().toISOString();
  const snapshotRows: Array<{
    ts: string;
    sport_key: string;
    event_id: string;
    bookmaker: string;
    market: string;
    side: string;
    line: number | null;
    odds: number | null;
    last_update: string | null;
  }> = [];

  function findOutcome(outcomes: any[], name: string) {
    return (outcomes || []).find((o) => o?.name === name) || null;
  }

  for (const e of events) {
    for (const bk of e.bookmakers || []) {
      const bookmaker = bk.key;
      const lastUpdate = bk.last_update ? new Date(bk.last_update).toISOString() : null;

      for (const mk of bk.markets || []) {
        const market = mk.key;
        const outs = mk.outcomes || [];

        if (market === "totals") {
          const over = findOutcome(outs, "Over");
          const under = findOutcome(outs, "Under");
          const totalLine =
            (typeof over?.point === "number" ? over.point :
             typeof under?.point === "number" ? under.point : null);

          snapshotRows.push({
            ts: nowTs,
            sport_key: SPORT_KEY,
            event_id: e.id,
            bookmaker,
            market,
            side: "over",
            line: totalLine,
            odds: typeof over?.price === "number" ? over.price : null,
            last_update: lastUpdate,
          });
          snapshotRows.push({
            ts: nowTs,
            sport_key: SPORT_KEY,
            event_id: e.id,
            bookmaker,
            market,
            side: "under",
            line: totalLine,
            odds: typeof under?.price === "number" ? under.price : null,
            last_update: lastUpdate,
          });
        } else if (market === "h2h") {
          const home = findOutcome(outs, e.home_team);
          const away = findOutcome(outs, e.away_team);

          // fallback to first two if names don’t match
          const o1 = home || outs[0] || null;
          const o2 = away || outs[1] || null;

          // try to map outcome names to home/away
          const o1Key = normalizeTeamKey(o1?.name || "");
          const homeKey = normalizeTeamKey(e.home_team);
          const awayKey = normalizeTeamKey(e.away_team);

          const homeOdds =
            o1Key === homeKey ? o1?.price :
            o1Key === awayKey ? o2?.price :
            o1?.price;

          const awayOdds =
            o1Key === homeKey ? o2?.price :
            o1Key === awayKey ? o1?.price :
            o2?.price;

          snapshotRows.push({
            ts: nowTs,
            sport_key: SPORT_KEY,
            event_id: e.id,
            bookmaker,
            market,
            side: "home",
            line: null,
            odds: typeof homeOdds === "number" ? homeOdds : null,
            last_update: lastUpdate,
          });
          snapshotRows.push({
            ts: nowTs,
            sport_key: SPORT_KEY,
            event_id: e.id,
            bookmaker,
            market,
            side: "away",
            line: null,
            odds: typeof awayOdds === "number" ? awayOdds : null,
            last_update: lastUpdate,
          });
        } else if (market === "spreads") {
          const home = findOutcome(outs, e.home_team);
          const away = findOutcome(outs, e.away_team);

          const o1 = home || outs[0] || null;
          const o2 = away || outs[1] || null;

          const o1Key = normalizeTeamKey(o1?.name || "");
          const homeKey = normalizeTeamKey(e.home_team);
          const awayKey = normalizeTeamKey(e.away_team);

          const homeObj =
            o1Key === homeKey ? o1 :
            o1Key === awayKey ? o2 :
            o1;

          const awayObj =
            o1Key === homeKey ? o2 :
            o1Key === awayKey ? o1 :
            o2;

          snapshotRows.push({
            ts: nowTs,
            sport_key: SPORT_KEY,
            event_id: e.id,
            bookmaker,
            market,
            side: "home",
            line: typeof homeObj?.point === "number" ? homeObj.point : null,
            odds: typeof homeObj?.price === "number" ? homeObj.price : null,
            last_update: lastUpdate,
          });
          snapshotRows.push({
            ts: nowTs,
            sport_key: SPORT_KEY,
            event_id: e.id,
            bookmaker,
            market,
            side: "away",
            line: typeof awayObj?.point === "number" ? awayObj.point : null,
            odds: typeof awayObj?.price === "number" ? awayObj.price : null,
            last_update: lastUpdate,
          });
        }
      }
    }
  }

  // ---- 6) Insert odds snapshots (ts is part of unique constraint)
  // If the job reruns within the same second, conflict can happen; use upsert.
  for (const batch of chunk(snapshotRows, 1000)) {
    const { error } = await supabase
      .from("odds_snapshot")
      .upsert(batch, { onConflict: "ts,event_id,bookmaker,market,side" });
    if (error) throw error;
  }

  console.log(
    JSON.stringify({
      ok: true,
      events: events.length,
      snapshots: snapshotRows.length,
      missingTeams: missingTeams.size,
    })
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
