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
