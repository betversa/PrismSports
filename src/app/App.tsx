// App.tsx
import { useMemo, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { OverviewScreen } from './components/screens/OverviewScreen';
import { ModelScreen } from './components/screens/ModelScreen';
import { MonteCarloScreen } from './components/screens/MonteCarloScreen';
import { OddsScreen } from './components/screens/OddsScreen';
import { ResultsScreen } from './components/screens/ResultsScreen';
import { CalibrationScreen } from './components/screens/CalibrationScreen';
import { SettingsScreen } from './components/screens/SettingsScreen';

export type Screen =
  | 'overview'
  | 'model'
  | 'monte-carlo'
  | 'odds'
  | 'results'
  | 'calibration'
  | 'settings';

export default function App() {
  const [activeScreen, setActiveScreen] = useState<Screen>('overview');
  const [selectedDate, setSelectedDate] = useState<string>('2024-12-20');

  const screens = useMemo<Record<Screen, JSX.Element>>(
    () => ({
      overview: <OverviewScreen />,
      model: <ModelScreen />,
      'monte-carlo': <MonteCarloScreen />,
      odds: <OddsScreen />,
      results: <ResultsScreen />,
      calibration: <CalibrationScreen />,
      settings: <SettingsScreen />,
    }),
    []
  );

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <Sidebar activeScreen={activeScreen} onNavigate={setActiveScreen} />
      <Header selectedDate={selectedDate} onChangeDate={setSelectedDate} />

      {/* Main Content */}
      <div className="pt-16 min-h-screen md:ml-64">
        <div className="p-6 pb-12">
          {/* If/when screens need the date, pass selectedDate into them */}
          {screens[activeScreen]}
        </div>
      </div>
    </div>
  );
}
