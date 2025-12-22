import { mockResultsData } from '../../data/mockData';

export function ResultsScreen() {
  const totalGames = mockResultsData.reduce((sum, r) => sum + r.games, 0);
  const avgMLWin = mockResultsData.reduce((sum, r) => sum + r.mlWinPct, 0) / mockResultsData.length;
  const avgSpreadWin = mockResultsData.reduce((sum, r) => sum + r.spreadWinPct, 0) / mockResultsData.length;
  const avgTotalWin = mockResultsData.reduce((sum, r) => sum + r.totalWinPct, 0) / mockResultsData.length;
  const totalUnitsWon = mockResultsData.reduce((sum, r) => sum + r.unitsWon, 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl text-white mb-1">Historical Results</h2>
        <p className="text-xs text-[#808080]">Last 7 days · Performance tracking</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-5 gap-4">
        <SummaryCard
          label="Total Games"
          value={totalGames.toString()}
          sublabel="7 day period"
        />
        <SummaryCard
          label="ML Win Rate"
          value={`${avgMLWin.toFixed(1)}%`}
          sublabel="Average"
          positive={avgMLWin > 52.4}
        />
        <SummaryCard
          label="Spread Win Rate"
          value={`${avgSpreadWin.toFixed(1)}%`}
          sublabel="Average"
          positive={avgSpreadWin > 52.4}
        />
        <SummaryCard
          label="Total Win Rate"
          value={`${avgTotalWin.toFixed(1)}%`}
          sublabel="Average"
          positive={avgTotalWin > 52.4}
        />
        <SummaryCard
          label="Units Won"
          value={totalUnitsWon > 0 ? `+${totalUnitsWon.toFixed(2)}` : totalUnitsWon.toFixed(2)}
          sublabel="Net Profit"
          positive={totalUnitsWon > 0}
        />
      </div>

      {/* Results Table */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                <th className="text-left p-3 text-[#808080]">Date</th>
                <th className="text-center p-3 text-[#808080]">Games</th>
                <th className="text-center p-3 text-[#d4af37] border-l border-[#2a2a2a]">ML Win %</th>
                <th className="text-center p-3 text-[#d4af37]">Spread Win %</th>
                <th className="text-center p-3 text-[#d4af37]">Total Win %</th>
                <th className="text-center p-3 text-[#d4af37] border-l border-[#2a2a2a]">ML MAE</th>
                <th className="text-center p-3 text-[#d4af37]">Spread MAE</th>
                <th className="text-center p-3 text-[#d4af37]">Total RMSE</th>
                <th className="text-center p-3 text-[#d4af37] border-l border-[#2a2a2a]">Units</th>
                <th className="text-center p-3 text-[#d4af37]">Coverage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1a1a1a]">
              {mockResultsData.map((result) => (
                <tr key={result.date} className="hover:bg-[#0f0f0f]/50 transition-colors">
                  <td className="p-3 text-white">
                    {new Date(result.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </td>
                  <td className="text-center p-3 text-[#b0b0b0]">{result.games}</td>
                  <td className="text-center p-3 border-l border-[#2a2a2a]">
                    <WinPct value={result.mlWinPct} />
                  </td>
                  <td className="text-center p-3">
                    <WinPct value={result.spreadWinPct} />
                  </td>
                  <td className="text-center p-3">
                    <WinPct value={result.totalWinPct} />
                  </td>
                  <td className="text-center p-3 text-white border-l border-[#2a2a2a]">
                    {result.mlMAE.toFixed(1)}
                  </td>
                  <td className="text-center p-3 text-white">
                    {result.spreadMAE.toFixed(1)}
                  </td>
                  <td className="text-center p-3 text-white">
                    {result.totalRMSE.toFixed(1)}
                  </td>
                  <td className="text-center p-3 border-l border-[#2a2a2a]">
                    <UnitsValue value={result.unitsWon} />
                  </td>
                  <td className="text-center p-3">
                    <Coverage value={result.coverage} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Metrics Explanation */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4">
          <h3 className="text-sm text-white mb-3">Win Rate Metrics</h3>
          <div className="space-y-2 text-xs">
            <MetricExplanation
              label="ML Win %"
              description="Percentage of moneyline picks that won"
            />
            <MetricExplanation
              label="Spread Win %"
              description="Percentage of spread picks that covered"
            />
            <MetricExplanation
              label="Total Win %"
              description="Percentage of total (over/under) picks that won"
            />
            <div className="mt-4 pt-3 border-t border-[#2a2a2a] text-[10px] text-[#606060]">
              Break-even at -110 odds = 52.38%
            </div>
          </div>
        </div>

        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4">
          <h3 className="text-sm text-white mb-3">Accuracy Metrics</h3>
          <div className="space-y-2 text-xs">
            <MetricExplanation
              label="MAE (Mean Absolute Error)"
              description="Average point difference between prediction and actual result"
            />
            <MetricExplanation
              label="RMSE (Root Mean Squared Error)"
              description="Standard error metric penalizing large misses"
            />
            <MetricExplanation
              label="Coverage"
              description="Percentage of games successfully modeled (vs skipped)"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, sublabel, positive }: { label: string; value: string; sublabel: string; positive?: boolean }) {
  return (
    <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4">
      <div className="text-[10px] text-[#606060] mb-1">{label}</div>
      <div className={`text-xl mb-1 ${positive !== undefined ? (positive ? 'text-[#d4af37]' : 'text-white') : 'text-white'}`}>
        {value}
      </div>
      <div className="text-[10px] text-[#808080]">{sublabel}</div>
    </div>
  );
}

function WinPct({ value }: { value: number }) {
  const isGood = value >= 52.4;
  return (
    <div className={isGood ? 'text-[#d4af37]' : 'text-white'}>
      {value.toFixed(1)}%
    </div>
  );
}

function UnitsValue({ value }: { value: number }) {
  const isPositive = value > 0;
  return (
    <div className={isPositive ? 'text-[#d4af37]' : 'text-white'}>
      {value > 0 ? '+' : ''}{value.toFixed(2)}
    </div>
  );
}

function Coverage({ value }: { value: number }) {
  const isGood = value >= 90;
  return (
    <div className={isGood ? 'text-white' : 'text-[#808080]'}>
      {value.toFixed(1)}%
    </div>
  );
}

function MetricExplanation({ label, description }: { label: string; description: string }) {
  return (
    <div>
      <div className="text-[#d4af37]">{label}</div>
      <div className="text-[#808080] mt-0.5">{description}</div>
    </div>
  );
}
