// components/Sidebar.tsx
import { ChartBar, Calculator, TrendingUp, DollarSign, Target, Settings, House } from 'lucide-react';
import logoImage from 'figma:asset/4aa2478d18792f46aa71cf7479926ef979c47df9.png';
import type { Screen } from '../App';

interface SidebarProps {
  activeScreen: Screen;
  onNavigate: (screen: Screen) => void;
}

const menuItems: { id: Screen; label: string; icon: any }[] = [
  { id: 'overview', label: 'Overview', icon: House },
  { id: 'model', label: 'Model', icon: Target },
  { id: 'monte-carlo', label: 'Monte Carlo', icon: Calculator },
  { id: 'odds', label: 'Odds', icon: ChartBar },
  { id: 'results', label: 'Results', icon: TrendingUp },
  { id: 'calibration', label: 'Calibration', icon: DollarSign },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar({ activeScreen, onNavigate }: SidebarProps) {
  return (
    <div className="w-64 bg-[#0a0a0a] border-r border-[#2a2a2a] h-screen fixed left-0 top-0 z-20 flex flex-col overflow-hidden">
      {/* Logo */}
      <div className="p-6 border-b border-[#2a2a2a] flex items-center justify-center">
        <img src={logoImage} alt="PrismSports Analytics" className="w-40 h-auto" />
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4">
        <ul className="space-y-1">
          {menuItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeScreen === item.id;

            return (
              <li key={item.id}>
                <button
                  onClick={() => onNavigate(item.id)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 rounded transition-colors ${
                    isActive
                      ? 'bg-[#d4af37] text-black'
                      : 'text-[#b0b0b0] hover:bg-[#1a1a1a] hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span className="text-sm">{item.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-[#2a2a2a]">
        <div className="text-xs text-[#606060]">
          <div>Model v3.2.1</div>
          <div className="mt-1">Updated 12/20/24</div>
        </div>
      </div>
    </div>
  );
}
