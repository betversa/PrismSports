// App.tsx
import { useMemo, useState, useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";

import { OverviewScreen } from "./components/screens/OverviewScreen";
import { ModelScreen } from "./components/screens/ModelScreen";
import { MonteCarloScreen } from "./components/screens/MonteCarloScreen";
import { OddsScreen } from "./components/screens/OddsScreen";
import { ResultsScreen } from "./components/screens/ResultsScreen";
import { CalibrationScreen } from "./components/screens/CalibrationScreen";
import { SettingsScreen } from "./components/screens/SettingsScreen";

export type Screen =
  | "overview"
  | "model"
  | "monte-carlo"
  | "odds"
  | "results"
  | "calibration"
  | "settings";

// ✅ match your DB / Odds API sport keys
export type SportKey =
  | "basketball_ncaab"
  | "basketball_nba"
  | "football_ncaaf"
  | "football_nfl"
  | "icehockey_nhl"
  | "baseball_mlb";

const CT_TZ = "America/Chicago";

// YYYY-MM-DD in Central Time
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

export default function App() {
  const [activeScreen, setActiveScreen] = useState<Screen>("overview");
  const [selectedDate, setSelectedDate] = useState<string>(() => ctYmd(new Date()));

  // ✅ Separate sport selectors (Odds vs Predictions)
  const [oddsSportKey, setOddsSportKey] = useState<SportKey>("basketball_ncaab");
  const [predSportKey, setPredSportKey] = useState<SportKey>("basketball_ncaab");

  // Mobile drawer state
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Dynamic top padding based on actual header height
  const [headerH, setHeaderH] = useState(120);

  // Prevent body scroll when drawer is open (mobile)
  useEffect(() => {
    document.body.style.overflow = sidebarOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [sidebarOpen]);

  const screens = useMemo<Record<Screen, JSX.Element>>(
    () => ({
      overview: <OverviewScreen />,
      model: <ModelScreen selectedDate={selectedDate} />,

      // ✅ pass sport into Predictions if desired
      "monte-carlo": <MonteCarloScreen sportKey={predSportKey} />,

      // ✅ THIS is the line you asked about
      odds: <OddsScreen sportKey={oddsSportKey} />,

      results: <ResultsScreen />,
      calibration: <CalibrationScreen />,
      settings: <SettingsScreen />,
    }),
    [selectedDate, oddsSportKey, predSportKey]
  );

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* Mobile drawer sidebar ONLY */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-[60]">
          <button
            className="absolute inset-0 bg-black/60"
            aria-label="Close sidebar backdrop"
            onClick={() => setSidebarOpen(false)}
            type="button"
          />
          <div className="absolute left-0 top-0 bottom-0 w-72 max-w-[85vw]">
            <Sidebar
              activeScreen={activeScreen}
              onNavigate={(s) => {
                setActiveScreen(s);
                setSidebarOpen(false);
              }}
              variant="mobile"
              onClose={() => setSidebarOpen(false)}

              // ✅ add these props to Sidebar (so it can change the selected sport)
              oddsSportKey={oddsSportKey}
              onPickOddsSport={(k: SportKey) => setOddsSportKey(k)}
              predSportKey={predSportKey}
              onPickPredSport={(k: SportKey) => setPredSportKey(k)}
            />
          </div>
        </div>
      )}

      {/* Header */}
      <Header
        onOpenMenu={() => setSidebarOpen(true)}
        onNavigate={(screen) => {
          setActiveScreen(screen);
          setSidebarOpen(false);
        }}
        activeScreen={activeScreen}
        onHeightChange={(px) => setHeaderH(Math.ceil(px))}

        // ✅ add these props to Header (so dropdown selection sets the sport)
        oddsSportKey={oddsSportKey}
        onPickOddsSport={(k: SportKey) => {
          setOddsSportKey(k);
          setActiveScreen("odds");
        }}
        predSportKey={predSportKey}
        onPickPredSport={(k: SportKey) => {
          setPredSportKey(k);
          setActiveScreen("monte-carlo");
        }}
      />

      {/* Main Content scroll container */}
      <div className="h-screen overflow-y-auto overflow-x-hidden" style={{ paddingTop: headerH }}>
        <div className="p-3 md:p-6 pb-12">{screens[activeScreen]}</div>
      </div>
    </div>
  );
}

