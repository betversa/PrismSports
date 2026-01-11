import { safeNumberOrNull } from "./math";

export function normalizeEvPct(row: { ev_pct?: number | null; ev?: number | null }) {
  const v = row.ev_pct ?? row.ev ?? null;
  if (v == null) return null;
  const n = safeNumberOrNull(v);
  if (n == null) return null;
  if (Math.abs(n) <= 1) return n * 100;
  return n;
}

export function withinOddsGate(odds: number | null, minOdds: number, maxOdds: number) {
  if (odds == null) return false;
  return odds >= minOdds && odds <= maxOdds;
}

export function clampPercent(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
