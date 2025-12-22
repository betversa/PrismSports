import { mockMonteCarloData } from '../../data/mockData';

export function MonteCarloScreen() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl text-white mb-1">Monte Carlo Debug View</h2>
        <p className="text-xs text-[#808080]">Internal simulation parameters · 10,000 iterations per game</p>
      </div>

      {/* Monte Carlo Table */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-10 min-w-[180px]">
                  Matchup
                </th>
                <th className="text-center p-3 text-[#d4af37]">Proj Margin</th>
                <th className="text-center p-3 text-[#d4af37]">σ Margin</th>
                <th className="text-center p-3 text-[#d4af37]">Proj Total</th>
                <th className="text-center p-3 text-[#d4af37]">σ Total</th>
                <th className="text-center p-3 text-[#d4af37]">Poss</th>
                <th className="text-center p-3 text-[#d4af37]">Calib Slope</th>
                <th className="text-center p-3 text-[#d4af37]">Calib Int</th>
                <th className="text-center p-3 text-[#d4af37]">Spread Anchor</th>
                <th className="text-center p-3 text-[#d4af37]">Total Anchor</th>
                <th className="text-center p-3 text-[#d4af37]">Market Width</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1a1a1a]">
              {mockMonteCarloData.map((data) => (
                <tr key={data.gameId} className="hover:bg-[#0f0f0f]/50 transition-colors">
                  <td className="p-3 text-white sticky left-0 bg-[#0f0f0f] z-10">
                    {data.matchup}
                  </td>
                  <td className="text-center p-3 text-white">
                    {data.projectedMargin > 0 ? '+' : ''}{data.projectedMargin.toFixed(1)}
                  </td>
                  <td className="text-center p-3 text-[#b0b0b0]">
                    {data.sigmaMargin.toFixed(1)}
                  </td>
                  <td className="text-center p-3 text-white">
                    {data.projectedTotal.toFixed(1)}
                  </td>
                  <td className="text-center p-3 text-[#b0b0b0]">
                    {data.sigmaTotal.toFixed(1)}
                  </td>
                  <td className="text-center p-3 text-[#b0b0b0]">
                    {data.possessions.toFixed(1)}
                  </td>
                  <td className="text-center p-3 text-white">
                    {data.calibSlope.toFixed(2)}
                  </td>
                  <td className="text-center p-3 text-[#b0b0b0]">
                    {data.calibIntercept.toFixed(2)}
                  </td>
                  <td className="text-center p-3 text-[#d4af37]">
                    {(data.spreadAnchorWeight * 100).toFixed(0)}%
                  </td>
                  <td className="text-center p-3 text-[#d4af37]">
                    {(data.totalAnchorWeight * 100).toFixed(0)}%
                  </td>
                  <td className="text-center p-3 text-white">
                    {data.marketWidth.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Parameter Explanations */}
      <div className="grid grid-cols-2 gap-4 mt-6">
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4">
          <h3 className="text-sm text-white mb-3">Simulation Parameters</h3>
          <div className="space-y-2 text-xs">
            <ParamExplanation
              label="Projected Margin"
              description="Expected home team margin from simulations (negative = away favored)"
            />
            <ParamExplanation
              label="σ Margin"
              description="Standard deviation of margin distribution (game volatility)"
            />
            <ParamExplanation
              label="Projected Total"
              description="Expected combined score from simulations"
            />
            <ParamExplanation
              label="σ Total"
              description="Standard deviation of total distribution"
            />
            <ParamExplanation
              label="Possessions"
              description="Estimated number of possessions per team"
            />
          </div>
        </div>

        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4">
          <h3 className="text-sm text-white mb-3">Anchoring & Calibration</h3>
          <div className="space-y-2 text-xs">
            <ParamExplanation
              label="Calib Slope"
              description="Historical accuracy adjustment (1.0 = perfect calibration)"
            />
            <ParamExplanation
              label="Calib Intercept"
              description="Systematic bias correction term"
            />
            <ParamExplanation
              label="Spread Anchor"
              description="Weight given to sharp market spread (vs simulation)"
            />
            <ParamExplanation
              label="Total Anchor"
              description="Weight given to sharp market total (vs simulation)"
            />
            <ParamExplanation
              label="Market Width"
              description="Bid-ask spread across sportsbooks (liquidity indicator)"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ParamExplanation({ label, description }: { label: string; description: string }) {
  return (
    <div>
      <div className="text-[#d4af37]">{label}</div>
      <div className="text-[#808080] mt-0.5">{description}</div>
    </div>
  );
}
