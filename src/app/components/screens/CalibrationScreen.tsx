import React, { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { mockCalibrationData } from "../../data/mockData";
import { ScreenShell, SectionCard, SectionHeader } from "../ScreenShell";

export function CalibrationScreen() {
  const buckets = useMemo(() => mockCalibrationData, []);
  const latest = buckets[buckets.length - 1];

  const hitRateLabel = latest ? `${Math.max(0, 100 - latest.marginError).toFixed(1)}%` : "—";
  const biasLabel = latest ? `${(latest.calibrationSlope * 100).toFixed(1)}%` : "—";
  const updatedLabel = latest?.window ?? "—";

  return (
    <ScreenShell
      title="Calibration Lab"
      subtitle="Monitor model confidence vs. outcomes, bias drift, and calibration curves across markets."
      status={[
        {
          label: "Buckets",
          value: String(buckets.length),
          helper: "Confidence bins",
        },
        {
          label: "Hit Rate",
          value: hitRateLabel,
          helper: "Margin accuracy",
        },
        {
          label: "Bias",
          value: biasLabel,
          helper: "Calibration slope",
        },
        {
          label: "Updated",
          value: updatedLabel,
          helper: "Rolling window",
        },
      ]}
    >
      <SectionCard>
        <SectionHeader
          title="Calibration Dashboard"
          description="Track calibration drift, error bands, and model confidence alignment."
        />
        <div className="mt-6 space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-white/40">Latest Window</p>
              <p className="mt-2 text-lg font-semibold text-white">{updatedLabel}</p>
              <p className="mt-1 text-xs text-white/50">{latest?.sampleCount ?? "—"} samples</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-white/40">Margin Error</p>
              <p className="mt-2 text-lg font-semibold text-white">{latest ? `${latest.marginError.toFixed(1)} pts` : "—"}</p>
              <p className="mt-1 text-xs text-white/50">Target: &lt; 10.0 pts</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-white/40">Total Error</p>
              <p className="mt-2 text-lg font-semibold text-white">{latest ? `${latest.totalError.toFixed(1)} pts` : "—"}</p>
              <p className="mt-1 text-xs text-white/50">Target: &lt; 11.0 pts</p>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-2xl p-6">
              <h3 className="text-sm text-white mb-4">Prediction Error Trends</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={buckets}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis dataKey="window" stroke="#606060" tick={{ fill: "#808080", fontSize: 11 }} />
                    <YAxis
                      stroke="#606060"
                      tick={{ fill: "#808080", fontSize: 11 }}
                      label={{ value: "Error (points)", angle: -90, position: "insideLeft", fill: "#808080", fontSize: 11 }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#0a0a0a",
                        border: "1px solid #2a2a2a",
                        borderRadius: "6px",
                        fontSize: "11px",
                      }}
                      labelStyle={{ color: "#d4af37" }}
                      itemStyle={{ color: "#fff" }}
                    />
                    <Legend wrapperStyle={{ fontSize: "11px", color: "#808080" }} />
                    <Line type="monotone" dataKey="marginError" stroke="#d4af37" strokeWidth={2} dot={{ fill: "#d4af37", r: 3 }} name="Margin Error" />
                    <Line type="monotone" dataKey="totalError" stroke="#808080" strokeWidth={2} dot={{ fill: "#808080", r: 3 }} name="Total Error" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-4 text-[10px] text-[#606060]">
                Lower error values indicate better predictive accuracy.
              </div>
            </div>

            <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-2xl p-6">
              <h3 className="text-sm text-white mb-4">Calibration Slope (Model Confidence)</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={buckets}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis dataKey="window" stroke="#606060" tick={{ fill: "#808080", fontSize: 11 }} />
                    <YAxis
                      stroke="#606060"
                      tick={{ fill: "#808080", fontSize: 11 }}
                      domain={[0.85, 1.0]}
                      label={{ value: "Calibration Slope", angle: -90, position: "insideLeft", fill: "#808080", fontSize: 11 }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#0a0a0a",
                        border: "1px solid #2a2a2a",
                        borderRadius: "6px",
                        fontSize: "11px",
                      }}
                      labelStyle={{ color: "#d4af37" }}
                      itemStyle={{ color: "#fff" }}
                    />
                    <Line
                      type="monotone"
                      dataKey="calibrationSlope"
                      stroke="#22c55e"
                      strokeWidth={2}
                      dot={{ fill: "#22c55e", r: 3 }}
                      name="Calibration Slope"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-4 text-[10px] text-[#606060]">
                Target slope is 1.0. Values below 1.0 indicate underconfidence.
              </div>
            </div>
          </div>
        </div>
      </SectionCard>
    </ScreenShell>
  );
}
