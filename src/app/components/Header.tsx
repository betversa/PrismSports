// components/Header.tsx
import { useMemo } from "react";
import { Menu } from "lucide-react";

type HeaderProps = {
  selectedDate: string;
  onChangeDate: (date: string) => void;
  onOpenMenu?: () => void;
  showDates?: boolean;
};

const CT_TZ = "America/Chicago";

function ctYmd(d: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${day}`;
}

// Safe display label
function dateFromYmdMidday(ymd: string) {
  return new Date(`${ymd}T12:00:00`);
}

export function Header({
  selectedDate,
  onChangeDate,
  onOpenMenu,
  showDates = true,
}: HeaderProps) {
  const dates = useMemo(() => {
    const now = new Date();
    const list: string[] = [];
    for (let i = 0; i <= 2; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() + i);
      list.push(ctYmd(d));
    }
    return list;
  }, []);

  const safeSelected = dates.includes(selectedDate) ? selectedDate : dates[0];

  return (
    <div className="h-16 bg-[#0f0f0f] border-b border-[#2a2a2a] fixed top-0 right-0 left-0 md:left-64 z-10 flex items-center justify-between px-3 md:px-6">
      <div className="flex items-center gap-3 md:gap-4 min-w-0">
        <button
          onClick={onOpenMenu}
          className="md:hidden p-2 rounded border border-[#2a2a2a] text-[#cfcfcf] hover:border-[#3a3a3a]"
          aria-label="Open menu"
          type="button"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* ✅ Main logo (public/logos/mainlogo.png) */}
        <img
          src="/logos/mainlogo.png"
          alt="PrismSports"
          className="h-8 w-auto object-contain select-none"
          draggable={false}
        />

        {/* ✅ Dates ONLY when showDates is true */}
        {showDates ? (
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar min-w-0">
            {dates.map((date) => (
              <button
                key={date}
                onClick={() => onChangeDate(date)}
                className={`px-3 py-1.5 text-xs rounded transition-colors whitespace-nowrap ${
                  safeSelected === date
                    ? "bg-[#d4af37] text-black"
                    : "bg-[#1a1a1a] text-[#b0b0b0] hover:bg-[#2a2a2a] hover:text-white"
                }`}
                type="button"
              >
                {dateFromYmdMidday(date).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </button>
            ))}
          </div>
        ) : (
          <div className="h-[34px]" /> // keeps header height consistent without showing dates
        )}
      </div>

      <div className="hidden sm:flex items-center gap-4 text-xs text-[#808080]">
        <div>Live</div>
        <div className="w-2 h-2 rounded-full bg-emerald-500" title="Live" />
      </div>
    </div>
  );
}



