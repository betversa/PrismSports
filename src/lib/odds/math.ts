export function safeNumber(value: any, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function safeNumberOrNull(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function americanToDecimal(odds: number) {
  if (!Number.isFinite(odds) || odds === 0) return NaN;
  if (odds > 0) return 1 + odds / 100;
  return 1 + 100 / Math.abs(odds);
}

export function decimalToAmerican(dec: number) {
  if (!Number.isFinite(dec) || dec <= 1) return NaN;
  const profit = dec - 1;
  if (profit >= 1) return Math.round(profit * 100);
  return -Math.round(100 / profit);
}

export function impliedProbFromAmerican(odds: number) {
  if (!Number.isFinite(odds) || odds === 0) return NaN;
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

export function impliedProbFromDecimal(dec: number) {
  if (!Number.isFinite(dec) || dec <= 1) return NaN;
  return 1 / dec;
}

export function evPercentFromDecimal(trueProb: number, dec: number) {
  if (!Number.isFinite(trueProb) || !Number.isFinite(dec) || dec <= 1) return NaN;
  const p = clampNumber(trueProb, 0, 1);
  const ev = p * (dec - 1) - (1 - p);
  return ev * 100;
}

export function kellyFraction(trueProb: number, dec: number) {
  if (!Number.isFinite(trueProb) || !Number.isFinite(dec) || dec <= 1) return NaN;
  const p = clampNumber(trueProb, 0, 1);
  const q = 1 - p;
  const b = dec - 1;
  const f = (b * p - q) / b;
  return f;
}

export function payoutFromStakeDecimal(stake: number, dec: number) {
  if (!Number.isFinite(stake) || !Number.isFinite(dec) || dec <= 1) return NaN;
  return stake * dec;
}

export function profitFromStakeDecimal(stake: number, dec: number) {
  const pay = payoutFromStakeDecimal(stake, dec);
  if (!Number.isFinite(pay)) return NaN;
  return pay - stake;
}

export function toProb01(value: number | null | undefined): number | null {
  if (value == null) return null;
  const x = value > 1.5 ? value / 100 : value;
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(1, x));
}

export function probToAmerican(prob: number | null): string {
  if (prob == null || prob <= 0 || prob >= 1) return "—";
  if (prob >= 0.5) {
    const a = -Math.round((prob / (1 - prob)) * 100);
    return String(a);
  }
  const a = Math.round(((1 - prob) / prob) * 100);
  return `+${a}`;
}

export function median(values: number[]) {
  const a = values.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function medianOrNull(values: number[]) {
  return median(values);
}
