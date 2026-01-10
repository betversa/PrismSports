import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.");
}

const filePath = process.argv[2];
if (!filePath) {
  throw new Error("Usage: tsx scripts/gameModelResultsProjectionUpsert.ts <rows.json>");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function run() {
  const raw = await readFile(filePath, "utf-8");
  const rows = JSON.parse(raw);

  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("No rows to upsert.");
    return;
  }

  const { error } = await supabase.rpc("upsert_game_model_results_projection", { rows });
  if (error) {
    throw new Error(`Projection upsert failed: ${error.message}`);
  }

  console.log(`Upserted projections for ${rows.length} rows.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
