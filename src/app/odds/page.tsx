"use client";

import { OddsScreen } from "../screens/OddsScreen";

export default function OddsPage() {
  // If OddsScreen requires sportKey, pass a default or read from search params
  return <OddsScreen sportKey="basketball_nba" />;
}
