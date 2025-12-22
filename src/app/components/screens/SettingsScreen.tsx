import { Settings as SettingsIcon, Bell, Database, Zap } from 'lucide-react';

export function SettingsScreen() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl text-white mb-1">Settings</h2>
        <p className="text-xs text-[#808080]">Model configuration & preferences</p>
      </div>

      {/* Model Parameters */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <SettingsIcon className="w-5 h-5 text-[#d4af37]" />
          <h3 className="text-sm text-white">Model Parameters</h3>
        </div>
        <div className="space-y-4">
          <SettingRow
            label="Minimum EV Threshold"
            value="2.5%"
            description="Minimum expected value to trigger a play recommendation"
          />
          <SettingRow
            label="Simulation Count"
            value="10,000"
            description="Number of Monte Carlo iterations per game"
          />
          <SettingRow
            label="Calibration Window"
            value="Rolling 14 days"
            description="Historical period used for model calibration"
          />
          <SettingRow
            label="Anchor Weight Range"
            value="0.65 - 0.75"
            description="Dynamic weight given to sharp market lines"
          />
          <SettingRow
            label="Max Units per Play"
            value="1.0"
            description="Maximum Kelly Criterion bet sizing"
          />
        </div>
      </div>

      {/* Data Sources */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <Database className="w-5 h-5 text-[#d4af37]" />
          <h3 className="text-sm text-white">Data Sources</h3>
        </div>
        <div className="space-y-3">
          <DataSourceRow name="DraftKings" status="Active" updateFreq="60s" />
          <DataSourceRow name="FanDuel" status="Active" updateFreq="60s" />
          <DataSourceRow name="BetMGM" status="Active" updateFreq="60s" />
          <DataSourceRow name="Pinnacle" status="Active" updateFreq="60s" priority="Sharp" />
          <DataSourceRow name="BetOnline" status="Active" updateFreq="60s" />
        </div>
      </div>

      {/* Notifications */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <Bell className="w-5 h-5 text-[#d4af37]" />
          <h3 className="text-sm text-white">Notifications</h3>
        </div>
        <div className="space-y-3 text-xs">
          <NotificationRow
            label="New High-Value Plays"
            description="Alert when EV > 5% and PrismScore > 80"
            enabled={true}
          />
          <NotificationRow
            label="Line Movement"
            description="Notify on significant odds changes"
            enabled={false}
          />
          <NotificationRow
            label="Model Updates"
            description="Alert when new model version is deployed"
            enabled={true}
          />
          <NotificationRow
            label="Results Summary"
            description="Daily performance recap"
            enabled={true}
          />
        </div>
      </div>

      {/* Performance */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <Zap className="w-5 h-5 text-[#d4af37]" />
          <h3 className="text-sm text-white">System Status</h3>
        </div>
        <div className="grid grid-cols-4 gap-4 text-xs">
          <div>
            <div className="text-[#606060] mb-1">Avg Processing Time</div>
            <div className="text-white">1.2s per game</div>
          </div>
          <div>
            <div className="text-[#606060] mb-1">Cache Hit Rate</div>
            <div className="text-white">94.3%</div>
          </div>
          <div>
            <div className="text-[#606060] mb-1">API Uptime</div>
            <div className="text-emerald-500">99.8%</div>
          </div>
          <div>
            <div className="text-[#606060] mb-1">Last Full Sync</div>
            <div className="text-white">2 min ago</div>
          </div>
        </div>
      </div>

      {/* Version Info */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4">
        <div className="flex items-center justify-between text-xs">
          <div className="text-[#606060]">
            PrismSports Model v3.2.1 · Released December 15, 2024
          </div>
          <div className="text-[#808080]">
            © 2024 PrismSports Analytics
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingRow({ label, value, description }: { label: string; value: string; description: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#1a1a1a] last:border-0">
      <div className="flex-1">
        <div className="text-xs text-white mb-0.5">{label}</div>
        <div className="text-[10px] text-[#606060]">{description}</div>
      </div>
      <div className="text-xs text-[#d4af37]">{value}</div>
    </div>
  );
}

function DataSourceRow({ name, status, updateFreq, priority }: { name: string; status: string; updateFreq: string; priority?: string }) {
  return (
    <div className="flex items-center justify-between py-2 text-xs border-b border-[#1a1a1a] last:border-0">
      <div className="flex items-center gap-3">
        <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
        <div className="text-white">{name}</div>
        {priority && (
          <span className="px-2 py-0.5 bg-[#d4af37]/20 text-[#d4af37] rounded text-[10px] border border-[#d4af37]/40">
            {priority}
          </span>
        )}
      </div>
      <div className="flex items-center gap-4">
        <div className="text-[#606060]">Update: {updateFreq}</div>
        <div className="text-emerald-500">{status}</div>
      </div>
    </div>
  );
}

function NotificationRow({ label, description, enabled }: { label: string; description: string; enabled: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#1a1a1a] last:border-0">
      <div className="flex-1">
        <div className="text-white mb-0.5">{label}</div>
        <div className="text-[10px] text-[#606060]">{description}</div>
      </div>
      <div className={`w-10 h-5 rounded-full transition-colors ${enabled ? 'bg-[#d4af37]' : 'bg-[#2a2a2a]'} relative`}>
        <div className={`absolute top-0.5 ${enabled ? 'right-0.5' : 'left-0.5'} w-4 h-4 rounded-full bg-white transition-all`}></div>
      </div>
    </div>
  );
}
