// src/app/data/mockData.ts

export type Game = {
  id: string;

  awayTeam: string;
  homeTeam: string;
  startTime: string;
  commenced: boolean;

  // Moneyline
  prismML: number;
  bookML: number;
  mlEV: number;
  mlPrismScore: number;
  mlUnits: number;

  // Spread
  prismSpread: number;
  bookSpread: number;
  spreadEV: number;
  spreadPrismScore: number;
  spreadUnits: number;

  // Total
  prismTotal: number;
  bookTotal: number;
  totalEV: number;
  totalPrismScore: number;
  totalUnits: number;
};

export const mockGames: Game[] = [
  {
    id: "game-1",
    awayTeam: "Duke",
    homeTeam: "Kansas",
    startTime: "7:00 PM ET",
    commenced: false,

    prismML: -135,
    bookML: -125,
    mlEV: 2.8,
    mlPrismScore: 82,
    mlUnits: 0.75,

    prismSpread: -2.5,
    bookSpread: -2.0,
    spreadEV: 1.6,
    spreadPrismScore: 74,
    spreadUnits: 0.25,

    prismTotal: 145.5,
    bookTotal: 146.0,
    totalEV: 0,
    totalPrismScore: 0,
    totalUnits: 0,
  },
  {
    id: "game-2",
    awayTeam: "Gonzaga",
    homeTeam: "UCLA",
    startTime: "9:30 PM ET",
    commenced: false,

    prismML: 110,
    bookML: 120,
    mlEV: 3.4,
    mlPrismScore: 79,
    mlUnits: 0.5,

    prismSpread: 2.0,
    bookSpread: 2.5,
    spreadEV: 0.9,
    spreadPrismScore: 68,
    spreadUnits: 0.25,

    prismTotal: 151.0,
    bookTotal: 150.5,
    totalEV: 2.1,
    totalPrismScore: 77,
    totalUnits: 0.5,
  },
  {
    id: "game-3",
    awayTeam: "Baylor",
    homeTeam: "Houston",
    startTime: "8:00 PM ET",
    commenced: true,

    prismML: -105,
    bookML: -110,
    mlEV: 0,
    mlPrismScore: 0,
    mlUnits: 0,

    prismSpread: 1.0,
    bookSpread: 1.5,
    spreadEV: 0,
    spreadPrismScore: 0,
    spreadUnits: 0,

    prismTotal: 137.5,
    bookTotal: 138.0,
    totalEV: 0,
    totalPrismScore: 0,
    totalUnits: 0,
  },
];

/**
 * MonteCarlo screen expects a named export: mockMonteCarloData
 * We derive it from mockGames so there's a single source of truth.
 *
 * If your MonteCarloScreen expects a different shape, tell me what fields it reads
 * and I'll match it exactly.
 */
export const mockMonteCarloData = mockGames.map((g) => ({
  id: g.id,
  matchup: `${g.awayTeam} @ ${g.homeTeam}`,
  startTime: g.startTime,
  commenced: g.commenced,

  // lines
  prismSpread: g.prismSpread,
  bookSpread: g.bookSpread,
  prismTotal: g.prismTotal,
  bookTotal: g.bookTotal,
  prismML: g.prismML,
  bookML: g.bookML,

  // EV / Score / Units
  mlEV: g.mlEV,
  mlPrismScore: g.mlPrismScore,
  mlUnits: g.mlUnits,

  spreadEV: g.spreadEV,
  spreadPrismScore: g.spreadPrismScore,
  spreadUnits: g.spreadUnits,

  totalEV: g.totalEV,
  totalPrismScore: g.totalPrismScore,
  totalUnits: g.totalUnits,
}));

// src/app/data/mockData.ts

export type ResultsDay = {
  date: string;        // ISO date string
  games: number;
  mlWinPct: number;
  spreadWinPct: number;
  totalWinPct: number;
  mlMAE: number;
  spreadMAE: number;
  totalRMSE: number;
  unitsWon: number;
  coverage: number;    // %
};

export const mockResultsData: ResultsDay[] = [
  { date: "2025-12-16", games: 182, mlWinPct: 56.0, spreadWinPct: 53.1, totalWinPct: 51.9, mlMAE: 7.8, spreadMAE: 10.6, totalRMSE: 18.9, unitsWon: 2.15, coverage: 98.4 },
  { date: "2025-12-17", games: 195, mlWinPct: 54.9, spreadWinPct: 52.8, totalWinPct: 53.6, mlMAE: 7.6, spreadMAE: 10.4, totalRMSE: 18.2, unitsWon: 1.42, coverage: 99.1 },
  { date: "2025-12-18", games: 210, mlWinPct: 57.2, spreadWinPct: 54.0, totalWinPct: 52.4, mlMAE: 7.4, spreadMAE: 10.2, totalRMSE: 17.8, unitsWon: 2.88, coverage: 99.0 },
  { date: "2025-12-19", games: 198, mlWinPct: 55.3, spreadWinPct: 53.4, totalWinPct: 51.2, mlMAE: 7.9, spreadMAE: 10.7, totalRMSE: 19.4, unitsWon: 0.64, coverage: 98.7 },
  { date: "2025-12-20", games: 173, mlWinPct: 53.8, spreadWinPct: 51.9, totalWinPct: 52.9, mlMAE: 8.1, spreadMAE: 10.9, totalRMSE: 19.1, unitsWon: -0.22, coverage: 97.9 },
  { date: "2025-12-21", games: 160, mlWinPct: 54.4, spreadWinPct: 52.2, totalWinPct: 50.6, mlMAE: 8.3, spreadMAE: 11.1, totalRMSE: 19.8, unitsWon: 0.31, coverage: 96.8 },
  { date: "2025-12-22", games: 148, mlWinPct: 55.7, spreadWinPct: 53.0, totalWinPct: 52.1, mlMAE: 8.0, spreadMAE: 10.8, totalRMSE: 19.0, unitsWon: 0.95, coverage: 97.5 },
];

// src/app/data/mockData.ts

export type CalibrationPoint = {
  window: string;          // e.g. "W-7" or "Nov 10–Nov 16"
  sampleCount: number;     // games
  marginError: number;     // points
  totalError: number;      // points
  calibrationSlope: number; // 0.85–1.0
};

export const mockCalibrationData: CalibrationPoint[] = [
  { window: "W-7", sampleCount: 1680, marginError: 9.8, totalError: 10.9, calibrationSlope: 0.94 },
  { window: "W-6", sampleCount: 1715, marginError: 9.5, totalError: 10.7, calibrationSlope: 0.95 },
  { window: "W-5", sampleCount: 1762, marginError: 9.2, totalError: 10.5, calibrationSlope: 0.96 },
  { window: "W-4", sampleCount: 1801, marginError: 9.0, totalError: 10.3, calibrationSlope: 0.97 },
  { window: "W-3", sampleCount: 1849, marginError: 9.1, totalError: 10.4, calibrationSlope: 0.96 },
  { window: "W-2", sampleCount: 1893, marginError: 8.9, totalError: 10.2, calibrationSlope: 0.97 },
  { window: "W-1", sampleCount: 1925, marginError: 8.7, totalError: 10.1, calibrationSlope: 0.98 },
];

