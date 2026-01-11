import { clampNumber, safeNumber } from "./math";

export function calcBetAmount(bankroll: number, kellyFraction: number, kellyFactor: number) {
  const b = Math.max(0, safeNumber(bankroll, 0));
  const f = clampNumber(safeNumber(kellyFraction, 0), 0, 1);
  const k = clampNumber(safeNumber(kellyFactor, 0), 0, 1);
  return b * f * k;
}
