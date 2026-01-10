export function americanToDecimalParlay(american: number) {
  if (!Number.isFinite(american) || american === 0) return 1;
  if (american > 0) return 1 + american / 100;
  return 1 + 100 / Math.abs(american);
}

export function decimalToAmericanParlay(decimal: number): number | null {
  if (!Number.isFinite(decimal) || decimal <= 1) return null;
  const profit = decimal - 1;
  if (profit >= 1) return Math.round(profit * 100);
  return -Math.round(100 / profit);
}

export function parlayEvPct(pWin: number, decimal: number) {
  const ev = pWin * (decimal - 1) - (1 - pWin);
  return ev * 100;
}
