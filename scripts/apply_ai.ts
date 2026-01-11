import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type ModelVersionRow = {
  id: string;
  sport_key: string | null;
  params: any;
};

type GameRow = {
  sport_key: string | null;
  event_id: string;
  run_id: string;
  home_win_prob: number | null;
  away_win_prob: number | null;
  home_cover_prob: number | null;
  away_cover_prob: number | null;
  over_prob: number | null;
  under_prob: number | null;
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.");
}

const sportKeyFilter = process.env.SPORT_KEY ?? null;
const runIdFilter = process.env.RUN_ID ?? null;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => Math.log(p / (1 - p));

function adjustProb(p: number | null, params?: { a: number; b: number }) {
  if (p == null || !Number.isFinite(p)) return null;
  if (!params) return p;
  const lp = logit(clamp(p, 1e-6, 1 - 1e-6));
  return sigmoid(params.a * lp + params.b);
}

async function fetchActiveModel(): Promise<ModelVersionRow | null> {
  let q = supabase.from("ai_model_versions").select("id,sport_key,params").eq("active", true).limit(1);
  if (sportKeyFilter) q = q.eq("sport_key", sportKeyFilter);
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data?.[0] ?? null) as ModelVersionRow | null;
}

async function fetchLatestRunIds(): Promise<string[]> {
  const { data, error } = await supabase
    .from("game_model_results")
    .select("run_id,sport_key,game_date")
    .order("game_date", { ascending: false })
    .limit(5000);

  if (error) throw new Error(error.message);

  const seen = new Map<string, string>();
  for (const row of data ?? []) {
    const sk = (row as any).sport_key ?? "";
    const runId = (row as any).run_id ?? "";
    if (!sk || !runId) continue;
    if (!seen.has(sk)) seen.set(sk, runId);
  }

  return Array.from(seen.values());
}

async function fetchGameRows(runIds: string[]): Promise<GameRow[]> {
  const cols = [
    "sport_key",
    "event_id",
    "run_id",
    "home_win_prob",
    "away_win_prob",
    "home_cover_prob",
    "away_cover_prob",
    "over_prob",
    "under_prob",
  ].join(",");

  let q = supabase.from("game_model_results").select(cols);
  if (sportKeyFilter) q = q.eq("sport_key", sportKeyFilter);
  if (runIds.length) q = q.in("run_id", runIds);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as GameRow[];
}

async function run() {
  const model = await fetchActiveModel();
  if (!model) {
    console.log("No active AI model version found.");
    return;
  }

  const runIds = runIdFilter ? [runIdFilter] : await fetchLatestRunIds();
  if (!runIds.length) {
    console.log("No run_id values found to apply AI adjustments.");
    return;
  }

  const rows = await fetchGameRows(runIds);
  if (!rows.length) {
    console.log("No game rows found to adjust.");
    return;
  }

  const fields = model.params?.fields ?? {};

  const payload = rows
    .map((row) => {
      if (!row.sport_key) return null;
      return {
        sport_key: row.sport_key,
        event_id: row.event_id,
        run_id: row.run_id,
        model_version_id: model.id,
        ai_home_win_prob: adjustProb(row.home_win_prob, fields.home_win),
        ai_away_win_prob: adjustProb(row.away_win_prob, fields.away_win),
        ai_home_cover_prob: adjustProb(row.home_cover_prob, fields.home_cover),
        ai_away_cover_prob: adjustProb(row.away_cover_prob, fields.away_cover),
        ai_over_prob: adjustProb(row.over_prob, fields.over),
        ai_under_prob: adjustProb(row.under_prob, fields.under),
        updated_at: new Date().toISOString(),
      };
    })
    .filter(Boolean);

  if (!payload.length) {
    console.log("No rows with sport_key to upsert AI adjustments.");
    return;
  }

  const { error } = await supabase
    .from("ai_adjusted_results")
    .upsert(payload, { onConflict: "sport_key,event_id,run_id" });

  if (error) throw new Error(error.message);

  console.log(`Applied AI adjustments to ${payload.length} rows.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
