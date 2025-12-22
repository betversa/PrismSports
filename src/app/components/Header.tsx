// components/Header.tsx
import { Calendar } from 'lucide-react';

type HeaderProps = {
  selectedDate: string;
  onChangeDate: (date: string) => void;
};

export function Header({ selectedDate, onChangeDate }: HeaderProps) {
  const dates = ['2024-12-18', '2024-12-19', '2024-12-20', '2024-12-21', '2024-12-22'];

  return (
    <div className="h-16 bg-[#0f0f0f] border-b border-[#2a2a2a] fixed top-0 right-0 left-0 md:left-64 z-10 flex items-center justify-between px-6">
      <div className="flex items-center gap-4">
        <Calendar className="w-5 h-5 text-[#d4af37]" />
        <div className="flex items-center gap-2">
          {dates.map((date) => (
            <button
              key={date}
              onClick={() => onChangeDate(date)}
              className={`px-3 py-1.5 text-xs rounded transition-colors ${
                selectedDate === date
                  ? 'bg-[#d4af37] text-black'
                  : 'bg-[#1a1a1a] text-[#b0b0b0] hover:bg-[#2a2a2a] hover:text-white'
              }`}
            >
              {new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs text-[#808080]">
        <div>Last Update: 2:47 PM ET</div>
        <div className="w-2 h-2 rounded-full bg-emerald-500" title="Live" />
      </div>
    </div>
  );
}
