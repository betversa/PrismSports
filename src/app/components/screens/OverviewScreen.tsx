import { ArrowRight, Database, Calculator, Anchor, DollarSign, Target, TrendingUp } from 'lucide-react';

export function OverviewScreen() {
  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h2 className="text-xl text-white mb-2">What is PrismSports?</h2>
        <p className="text-sm text-[#b0b0b0] leading-relaxed max-w-3xl">
          PrismSports is a quantitative sports betting analytics platform for NCAAB that combines Monte Carlo simulation,
          sharp market anchoring, and no-vig pricing to identify positive expected value (EV) betting opportunities across
          moneyline, spread, and total markets.
        </p>
      </div>

      {/* Pipeline Diagram */}
      <div>
        <h3 className="text-base text-white mb-4">Processing Pipeline</h3>
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
          <div className="flex items-center justify-between">
            <PipelineStep icon={Database} label="Odds Ingestion" sublabel="5 Sportsbooks" />
            <ArrowRight className="w-5 h-5 text-[#606060] flex-shrink-0 mx-2" />
            <PipelineStep icon={Calculator} label="Monte Carlo" sublabel="10K Simulations" />
            <ArrowRight className="w-5 h-5 text-[#606060] flex-shrink-0 mx-2" />
            <PipelineStep icon={Anchor} label="Market Anchoring" sublabel="Sharp Lines" />
            <ArrowRight className="w-5 h-5 text-[#606060] flex-shrink-0 mx-2" />
            <PipelineStep icon={DollarSign} label="No-Vig Pricing" sublabel="True Probability" />
            <ArrowRight className="w-5 h-5 text-[#606060] flex-shrink-0 mx-2" />
            <PipelineStep icon={Target} label="EV Calculation" sublabel="Edge Detection" />
            <ArrowRight className="w-5 h-5 text-[#606060] flex-shrink-0 mx-2" />
            <PipelineStep icon={TrendingUp} label="Results Tracking" sublabel="Performance" />
          </div>
        </div>
      </div>

      {/* Model Version */}
      <div>
        <h3 className="text-base text-white mb-4">Latest Model Version</h3>
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
          <div className="grid grid-cols-3 gap-6">
            <div>
              <div className="text-xs text-[#808080] mb-1">Version</div>
              <div className="text-sm text-white">v3.2.1</div>
            </div>
            <div>
              <div className="text-xs text-[#808080] mb-1">Release Date</div>
              <div className="text-sm text-white">December 15, 2024</div>
            </div>
            <div>
              <div className="text-xs text-[#808080] mb-1">Status</div>
              <div className="text-sm text-emerald-500">Production</div>
            </div>
          </div>

          <div className="mt-6 pt-6 border-t border-[#2a2a2a]">
            <div className="text-xs text-[#808080] mb-2">Core Parameters</div>
            <div className="grid grid-cols-4 gap-4 text-xs">
              <div>
                <span className="text-[#606060]">Simulations:</span>{' '}
                <span className="text-white">10,000</span>
              </div>
              <div>
                <span className="text-[#606060]">Calibration Window:</span>{' '}
                <span className="text-white">Rolling 14d</span>
              </div>
              <div>
                <span className="text-[#606060]">Anchor Weight:</span>{' '}
                <span className="text-white">0.65-0.75</span>
              </div>
              <div>
                <span className="text-[#606060]">Min EV Threshold:</span>{' '}
                <span className="text-white">2.5%</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* What Changed */}
      <div>
        <h3 className="text-base text-white mb-4">What Changed</h3>
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg divide-y divide-[#2a2a2a]">
          <ChangeLogEntry
            version="v3.2.1"
            date="Dec 15, 2024"
            changes={[
              'Improved calibration slope calculation for high-variance games',
              'Added dynamic anchor weighting based on market liquidity',
              'Reduced minimum EV threshold from 3.0% to 2.5%',
            ]}
          />
          <ChangeLogEntry
            version="v3.2.0"
            date="Dec 8, 2024"
            changes={[
              'Integrated BetOnline odds feed',
              'Expanded Monte Carlo from 5K to 10K simulations',
              'Updated possession estimation model',
            ]}
          />
          <ChangeLogEntry
            version="v3.1.5"
            date="Dec 1, 2024"
            changes={[
              'Fixed edge case in no-vig calculation for large spreads',
              'Enhanced PrismScore weighting algorithm',
              'Added conference-based variance adjustments',
            ]}
          />
        </div>
      </div>

      {/* Data Sources */}
      <div>
        <h3 className="text-base text-white mb-4">Sportsbook Coverage</h3>
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
          <div className="grid grid-cols-5 gap-4 text-center">
            <div className="p-3 bg-[#1a1a1a] rounded">
              <div className="text-xs text-[#d4af37]">DraftKings</div>
              <div className="text-[10px] text-[#606060] mt-1">Primary</div>
            </div>
            <div className="p-3 bg-[#1a1a1a] rounded">
              <div className="text-xs text-[#d4af37]">FanDuel</div>
              <div className="text-[10px] text-[#606060] mt-1">Primary</div>
            </div>
            <div className="p-3 bg-[#1a1a1a] rounded">
              <div className="text-xs text-[#d4af37]">BetMGM</div>
              <div className="text-[10px] text-[#606060] mt-1">Primary</div>
            </div>
            <div className="p-3 bg-[#1a1a1a] rounded">
              <div className="text-xs text-[#d4af37]">Pinnacle</div>
              <div className="text-[10px] text-[#606060] mt-1">Sharp</div>
            </div>
            <div className="p-3 bg-[#1a1a1a] rounded">
              <div className="text-xs text-[#d4af37]">BetOnline</div>
              <div className="text-[10px] text-[#606060] mt-1">Secondary</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PipelineStep({ icon: Icon, label, sublabel }: { icon: any; label: string; sublabel: string }) {
  return (
    <div className="flex flex-col items-center flex-1 min-w-0">
      <div className="w-12 h-12 bg-[#1a1a1a] border border-[#d4af37]/30 rounded-lg flex items-center justify-center mb-2">
        <Icon className="w-5 h-5 text-[#d4af37]" />
      </div>
      <div className="text-xs text-white text-center mb-0.5">{label}</div>
      <div className="text-[10px] text-[#606060] text-center">{sublabel}</div>
    </div>
  );
}

function ChangeLogEntry({ version, date, changes }: { version: string; date: string; changes: string[] }) {
  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm text-white">{version}</div>
        <div className="text-xs text-[#606060]">{date}</div>
      </div>
      <ul className="space-y-1.5">
        {changes.map((change, idx) => (
          <li key={idx} className="text-xs text-[#b0b0b0] pl-4 relative before:content-['•'] before:absolute before:left-0 before:text-[#d4af37]">
            {change}
          </li>
        ))}
      </ul>
    </div>
  );
}
