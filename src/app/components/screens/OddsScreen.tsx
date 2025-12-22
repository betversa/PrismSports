import { mockOddsData } from '../../data/mockData';

export function OddsScreen() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl text-white mb-1">Raw Odds Feed</h2>
        <p className="text-xs text-[#808080]">Live sportsbook lines · 5 books · Updated every 60 seconds</p>
      </div>

      {/* Odds Table */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                <th className="text-left p-3 text-[#808080] sticky left-0 bg-[#0a0a0a] z-10 min-w-[100px]">
                  Event ID
                </th>
                <th className="text-left p-3 text-[#808080] min-w-[180px]">Matchup</th>
                <th className="text-left p-3 text-[#808080] min-w-[140px]">Commence</th>
                <th className="text-left p-3 text-[#d4af37] border-l border-[#2a2a2a]">DraftKings</th>
                <th className="text-left p-3 text-[#d4af37]">FanDuel</th>
                <th className="text-left p-3 text-[#d4af37]">BetMGM</th>
                <th className="text-left p-3 text-[#d4af37]">Pinnacle</th>
                <th className="text-left p-3 text-[#d4af37]">BetOnline</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1a1a1a]">
              {mockOddsData.map((odds) => (
                <OddsRow key={odds.eventId} odds={odds} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer Info */}
      <div className="flex items-center justify-between text-[10px] text-[#606060] pt-2">
        <div>
          Data provided by OddsAPI · Lines may vary by location
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
          <span>Live Feed Active</span>
        </div>
      </div>
    </div>
  );
}

function OddsRow({ odds }: { odds: any }) {
  return (
    <>
      {/* Moneyline Row */}
      <tr className="hover:bg-[#0f0f0f]/50 transition-colors">
        <td className="p-3 text-[#808080] sticky left-0 bg-[#0f0f0f] z-10 align-top" rowSpan={3}>
          {odds.eventId}
        </td>
        <td className="p-3 text-white align-top" rowSpan={3}>
          {odds.matchup}
        </td>
        <td className="p-3 text-[#b0b0b0] align-top" rowSpan={3}>
          {odds.commenceTime}
        </td>
        <td className="p-3 text-white border-l border-[#2a2a2a]">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#606060] w-8">ML:</span>
            <span>{odds.draftKingsML}</span>
          </div>
        </td>
        <td className="p-3 text-white">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#606060] w-8">ML:</span>
            <span>{odds.fanDuelML}</span>
          </div>
        </td>
        <td className="p-3 text-white">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#606060] w-8">ML:</span>
            <span>{odds.betMGMML}</span>
          </div>
        </td>
        <td className="p-3 text-white">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#606060] w-8">ML:</span>
            <span>{odds.pinnacleML}</span>
          </div>
        </td>
        <td className="p-3 text-white">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#606060] w-8">ML:</span>
            <span>{odds.betOnlineML}</span>
          </div>
        </td>
      </tr>

      {/* Spread Row */}
      <tr className="hover:bg-[#0f0f0f]/50 transition-colors border-t border-[#1a1a1a]/50">
        <td className="p-3 text-white border-l border-[#2a2a2a]">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#606060] w-8">SPR:</span>
            <span>{odds.draftKingsSpread}</span>
          </div>
        </td>
        <td className="p-3 text-white">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#606060] w-8">SPR:</span>
            <span>{odds.fanDuelSpread}</span>
          </div>
        </td>
        <td className="p-3 text-white">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#606060] w-8">SPR:</span>
            <span>{odds.betMGMSpread}</span>
          </div>
        </td>
        <td className="p-3 text-white">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#606060] w-8">SPR:</span>
            <span>{odds.pinnacleSpread}</span>
          </div>
        </td>
        <td className="p-3 text-white">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#606060] w-8">SPR:</span>
            <span>{odds.betOnlineSpread}</span>
          </div>
        </td>
      </tr>

      {/* Total Row */}
      <tr className="hover:bg-[#0f0f0f]/50 transition-colors border-t border-[#1a1a1a]/50">
        <td className="p-3 text-white border-l border-[#2a2a2a]">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#606060] w-8">TOT:</span>
            <span>{odds.draftKingsTotal}</span>
          </div>
        </td>
        <td className="p-3 text-white">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#606060] w-8">TOT:</span>
            <span>{odds.fanDuelTotal}</span>
          </div>
        </td>
        <td className="p-3 text-white">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#606060] w-8">TOT:</span>
            <span>{odds.betMGMTotal}</span>
          </div>
        </td>
        <td className="p-3 text-white">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#606060] w-8">TOT:</span>
            <span>{odds.pinnacleTotal}</span>
          </div>
        </td>
        <td className="p-3 text-white">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[#606060] w-8">TOT:</span>
            <span>{odds.betOnlineTotal}</span>
          </div>
        </td>
      </tr>
    </>
  );
}
