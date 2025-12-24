import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type TeamMapRow = {
  canonical: string;
  KenPom: string | null;
};

type KenPomRow = {
  "Date": string; // YYYY-MM-DD
  "Team1 (Away)": string;
  "Score1": number | null;
  "Team2 (Home)": string;
  "Score2": number | null;
  "Suffix": string | null;
  "Neutral": boolean;
  "Location": string | null;
  "Season"?: string | null; // optional
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

function decodeEntities(s: string) {
  const named: Record<string, string> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&quot;": '"',
    "&lt;": "<",
    "&gt;": ">",
    "&apos;": "'",
    "&apos": "'",
  };

  return String(s ?? "")
    .replace(/&(nbsp|amp|quot|lt|gt|apos);/g, (m) => named[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => {
      const c = parseInt(d, 10);
      return Number.isFinite(c) ? String.fromCharCode(c) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const c = parseInt(h, 16);
      return Number.isFinite(c) ? String.fromCharCode(c) : _;
    });
}

function normKey(s: string) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[\.\'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePreBody(htmlOrText: string) {
  const m = htmlOrText.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  return m ? m[1] : htmlOrText;
}

function mmddyyyyToISO(mmddyyyy: string) {
  const [mm, dd, yyyy] = mmddyyyy.split("/");
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function isNeutralFromSuffix(suffix: string) {
  return /\b[0-9]*\s*[Nn]\b/.test(suffix) || /\b[0-9]*[Nn]$/.test(suffix);
}

function locationFromSuffix(suffix: string) {
  const loc = suffix.replace(/^\s*[0-9]*\s*[Nn]?\s*/, "").trim();
  return loc || null;
}

async function fetchKenPomText(url: string) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} fetching KenPom: ${url}`);

  const text = await res.text();
  return parsePreBody(text);
}

async function loadKenPomResolver(): Promise<(name: string) => string> {
  const { data, error } = await supabase.from("team_map").select('canonical, "KenPom"');

  if (error) {
    console.warn("[KenPom] team_map load failed:", error.message);
    return (n) => n;
  }

  const map = new Map<string, string>();
  for (const r of (data ?? []) as any[]) {
    const canonical = String(r.canonical ?? "").trim();
    const kp = String(r["KenPom"] ?? "").trim();
    if (!canonical || !kp) continue;
    map.set(normKey(kp), canonical);
  }

  return (name: string) => {
    const raw = decodeEntities(String(name ?? "").trim());
    const key = normKey(raw);
    return map.get(key) ?? raw;
  };
}

function parseKenPom(text: string, resolveTeam: (n: string) => string, season?: string) {
  const out: KenPomRow[] = [];
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // 11/03/2025 Florida 87 Arizona 93 N   Las Vegas, NV
    const m = line.match(/^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(\d+)\s+(.+?)\s+(\d+)\s*(.*)$/);
    if (!m) continue;

    const dateISO = mmddyyyyToISO(m[1]);
    const rawT1 = decodeEntities(m[2].trim());
    const s1 = Number(m[3]);
    const rawT2 = decodeEntities(m[4].trim());
    const s2 = Number(m[5]);
    const suffix = (m[6] || "").trim();

    const away = resolveTeam(rawT1);
    const home = resolveTeam(rawT2);

    const neutral = suffix ? isNeutralFromSuffix(suffix) : false;
    const location = suffix ? locationFromSuffix(suffix) : null;

    out.push({
      "Date": dateISO,
      "Team1 (Away)": away,
      "Score1": Number.isFinite(s1) ? s1 : null,
      "Team2 (Home)": home,
      "Score2": Number.isFinite(s2) ? s2 : null,
      "Suffix": suffix || null,
      "Neutral": neutral,
      "Location": location,
      ...(season ? { Season: season } : {}),
    });
  }

  return out;
}

async function upsertRows(rows: KenPomRow[]) {
  if (!rows.length) return 0;

  const CHUNK = 1000;
  let total = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => ({
      ...r,
      updated_at: new Date().toISOString(),
    }));

    const { error } = await supabase
      .from("kenpom_games")
      .upsert(chunk, { onConflict: '"Date","Team1 (Away)","Team2 (Home)"' });

    if (error) throw new Error(`Upsert failed: ${error.message}`);

    total += chunk.length;
  }

  return total;
}

async function main() {
  const url = process.env.KP_URL ?? "https://kenpom.com/cbbga26.txt";
  const season = process.env.KP_SEASON ?? "2025-26";

  console.log(`[KenPom] fetching: ${url}`);
  const resolveTeam = await loadKenPomResolver();
  const text = await fetchKenPomText(url);

  const rows = parseKenPom(text, resolveTeam, season);
  console.log(`[KenPom] parsed rows: ${rows.length}`);

  const upserted = await upsertRows(rows);
  console.log(`[KenPom] upserted: ${upserted}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
