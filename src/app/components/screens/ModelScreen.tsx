import { mockGames } from '../../data/mockData';
import type { Game } from '../../data/mockData';

export function ModelScreen() {
  const activeGames = mockGames.filter(g => !g.commenced);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl text-white mb-1">Model Picks</h2>
          <p className="text-xs text-[#808080]">{activeGames.length} games · Updated 2:47 PM ET</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <div className="px-2 py-1 bg-[#1a1a1a] rounded text-[#808080]">
            Total Units: <span className="text-[#d4af37]">8.25</span>
          </div>
        </div>
      </div>

      {/* Main Picks Table */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-10 min-w-[200px]">
                  Game
                </th>
                {/* Moneyline */}
                <th colSpan={5} className="text-center p-3 text-[#d4af37] border-l border-[#2a2a2a]">
                  MONEYLINE
                </th>
                {/* Spread */}
                <th colSpan={5} className="text-center p-3 text-[#d4af37] border-l border-[#2a2a2a]">
                  SPREAD
                </th>
                {/* Total */}
                <th colSpan={5} className="text-center p-3 text-[#d4af37] border-l border-[#2a2a2a]">
                  TOTAL
                </th>
              </tr>
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a] text-[10px]">
                <th className="sticky left-0 bg-[#0a0a0a] z-10"></th>
                {/* ML Headers */}
                <th className="text-center p-2 text-[#606060] border-l border-[#2a2a2a]">Prism</th>
                <th className="text-center p-2 text-[#606060]">Book</th>
                <th className="text-center p-2 text-[#606060]">EV%</th>
                <th className="text-center p-2 text-[#606060]">Score</th>
                <th className="text-center p-2 text-[#606060]">Units</th>
                {/* Spread Headers */}
                <th className="text-center p-2 text-[#606060] border-l border-[#2a2a2a]">Prism</th>
                <th className="text-center p-2 text-[#606060]">Book</th>
                <th className="text-center p-2 text-[#606060]">EV%</th>
                <th className="text-center p-2 text-[#606060]">Score</th>
                <th className="text-center p-2 text-[#606060]">Units</th>
                {/* Total Headers */}
                <th className="text-center p-2 text-[#606060] border-l border-[#2a2a2a]">Prism</th>
                <th className="text-center p-2 text-[#606060]">Book</th>
                <th className="text-center p-2 text-[#606060]">EV%</th>
                <th className="text-center p-2 text-[#606060]">Score</th>
                <th className="text-center p-2 text-[#606060]">Units</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1a1a1a]">
              {activeGames.map((game) => (
                <GameRow key={game.id} game={game} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 text-[10px] text-[#606060] pt-2">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-[#d4af37]/20 border border-[#d4af37]/40 rounded"></div>
          <span>Positive EV</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-[#1a1a1a] rounded"></div>
          <span>No Play (0 units)</span>
        </div>
        <div>
          <span className="text-[#808080]">PrismScore:</span> Confidence metric (0-100)
        </div>
      </div>
    </div>
  );
}

function GameRow({ game }: { game: Game }) {
  const hasMLPlay = game.mlUnits > 0;
  const hasSpreadPlay = game.spreadUnits > 0;
  const hasTotalPlay = game.totalUnits > 0;

  return (
    <tr className="hover:bg-[#0f0f0f]/50 transition-colors">
      {/* Game Info */}
      <td className="p-3 sticky left-0 bg-[#0f0f0f] z-10">
        <div className="text-white">{game.awayTeam} @ {game.homeTeam}</div>
        <div className="text-[10px] text-[#606060] mt-0.5">{game.startTime}</div>
      </td>

      {/* Moneyline */}
      <td className={`text-center p-3 border-l border-[#2a2a2a] ${!hasMLPlay ? 'opacity-40' : ''}`}>
        <OddsValue value={game.prismML} />
      </td>
      <td className={`text-center p-3 ${!hasMLPlay ? 'opacity-40' : ''}`}>
        <OddsValue value={game.bookML} />
      </td>
      <td className={`text-center p-3 ${!hasMLPlay ? 'opacity-40' : ''}`}>
        <EVValue value={game.mlEV} />
      </td>
      <td className={`text-center p-3 ${!hasMLPlay ? 'opacity-40' : ''}`}>
        <ScoreValue value={game.mlPrismScore} />
      </td>
      <td className={`text-center p-3 ${!hasMLPlay ? 'opacity-40' : ''}`}>
        <UnitsValue value={game.mlUnits} />
      </td>

      {/* Spread */}
      <td className={`text-center p-3 border-l border-[#2a2a2a] ${!hasSpreadPlay ? 'opacity-40' : ''}`}>
        <SpreadValue value={game.prismSpread} />
      </td>
      <td className={`text-center p-3 ${!hasSpreadPlay ? 'opacity-40' : ''}`}>
        <SpreadValue value={game.bookSpread} />
      </td>
      <td className={`text-center p-3 ${!hasSpreadPlay ? 'opacity-40' : ''}`}>
        <EVValue value={game.spreadEV} />
      </td>
      <td className={`text-center p-3 ${!hasSpreadPlay ? 'opacity-40' : ''}`}>
        <ScoreValue value={game.spreadPrismScore} />
      </td>
      <td className={`text-center p-3 ${!hasSpreadPlay ? 'opacity-40' : ''}`}>
        <UnitsValue value={game.spreadUnits} />
      </td>

      {/* Total */}
      <td className={`text-center p-3 border-l border-[#2a2a2a] ${!hasTotalPlay ? 'opacity-40' : ''}`}>
        <div className="text-white">{game.prismTotal}</div>
      </td>
      <td className={`text-center p-3 ${!hasTotalPlay ? 'opacity-40' : ''}`}>
        <div className="text-white">{game.bookTotal}</div>
      </td>
      <td className={`text-center p-3 ${!hasTotalPlay ? 'opacity-40' : ''}`}>
        <EVValue value={game.totalEV} />
      </td>
      <td className={`text-center p-3 ${!hasTotalPlay ? 'opacity-40' : ''}`}>
        <ScoreValue value={game.totalPrismScore} />
      </td>
      <td className={`text-center p-3 ${!hasTotalPlay ? 'opacity-40' : ''}`}>
        <UnitsValue value={game.totalUnits} />
      </td>
    </tr>
  );
}

function OddsValue({ value }: { value: number }) {
  return (
    <div className="text-white">
      {value > 0 ? '+' : ''}{value}
    </div>
  );
}

function SpreadValue({ value }: { value: number }) {
  return (
    <div className="text-white">
      {value > 0 ? '+' : ''}{value}
    </div>
  );
}

function EVValue({ value }: { value: number }) {
  const isPositive = value > 0;
  return (
    <div className={`${isPositive ? 'text-[#d4af37]' : 'text-[#808080]'}`}>
      {value > 0 ? '+' : ''}{value.toFixed(1)}%
    </div>
  );
}

function ScoreValue({ value }: { value: number }) {
  let color = 'text-[#606060]';
  if (value >= 80) color = 'text-[#d4af37]';
  else if (value >= 70) color = 'text-white';

  return <div className={color}>{value}</div>;
}

function UnitsValue({ value }: { value: number }) {
  if (value === 0) {
    return <div className="text-[#404040]">—</div>;
  }

  return (
    <div className="inline-flex items-center justify-center px-2 py-0.5 bg-[#d4af37]/20 border border-[#d4af37]/40 rounded text-[#d4af37]">
      {value}u
    </div>
  );
}
