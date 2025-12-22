import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { mockCalibrationData } from '../../data/mockData';

export function CalibrationScreen() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl text-white mb-1">Model Calibration</h2>
        <p className="text-xs text-[#808080]">Rolling accuracy & health metrics · 7 week window</p>
      </div>

      {/* Charts */}
      <div className="space-y-6">
        {/* Error Trends */}
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
          <h3 className="text-sm text-white mb-4">Prediction Error Trends</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={mockCalibrationData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                <XAxis
                  dataKey="window"
                  stroke="#606060"
                  tick={{ fill: '#808080', fontSize: 11 }}
                />
                <YAxis
                  stroke="#606060"
                  tick={{ fill: '#808080', fontSize: 11 }}
                  label={{ value: 'Error (points)', angle: -90, position: 'insideLeft', fill: '#808080', fontSize: 11 }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0a0a0a',
                    border: '1px solid #2a2a2a',
                    borderRadius: '6px',
                    fontSize: '11px',
                  }}
                  labelStyle={{ color: '#d4af37' }}
                  itemStyle={{ color: '#fff' }}
                />
                <Legend
                  wrapperStyle={{ fontSize: '11px', color: '#808080' }}
                />
                <Line
                  type="monotone"
                  dataKey="marginError"
                  stroke="#d4af37"
                  strokeWidth={2}
                  dot={{ fill: '#d4af37', r: 3 }}
                  name="Margin Error"
                />
                <Line
                  type="monotone"
                  dataKey="totalError"
                  stroke="#808080"
                  strokeWidth={2}
                  dot={{ fill: '#808080', r: 3 }}
                  name="Total Error"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 text-[10px] text-[#606060]">
            Lower error values indicate better predictive accuracy. Target: {'<'}10.0 pts
          </div>
        </div>

        {/* Calibration Slope */}
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
          <h3 className="text-sm text-white mb-4">Calibration Slope (Model Confidence)</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={mockCalibrationData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                <XAxis
                  dataKey="window"
                  stroke="#606060"
                  tick={{ fill: '#808080', fontSize: 11 }}
                />
                <YAxis
                  stroke="#606060"
                  tick={{ fill: '#808080', fontSize: 11 }}
                  domain={[0.85, 1.0]}
                  label={{ value: 'Calibration Slope', angle: -90, position: 'insideLeft', fill: '#808080', fontSize: 11 }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0a0a0a',
                    border: '1px solid #2a2a2a',
                    borderRadius: '6px',
                    fontSize: '11px',
                  }}
                  labelStyle={{ color: '#d4af37' }}
                  itemStyle={{ color: '#fff' }}
                />
                <Line
                  type="monotone"
                  dataKey="calibrationSlope"
                  stroke="#d4af37"
                  strokeWidth={2}
                  dot={{ fill: '#d4af37', r: 4 }}
                  name="Slope"
                />
                {/* Reference line at 1.0 */}
                <Line
                  type="monotone"
                  dataKey={() => 1.0}
                  stroke="#606060"
                  strokeWidth={1}
                  strokeDasharray="5 5"
                  dot={false}
                  name="Perfect (1.0)"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 text-[10px] text-[#606060]">
            1.0 = perfect calibration. Values {'<'}1.0 indicate model overconfidence.
          </div>
        </div>

        {/* Sample Count */}
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
          <h3 className="text-sm text-white mb-4">Weekly Sample Size</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={mockCalibrationData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                <XAxis
                  dataKey="window"
                  stroke="#606060"
                  tick={{ fill: '#808080', fontSize: 11 }}
                />
                <YAxis
                  stroke="#606060"
                  tick={{ fill: '#808080', fontSize: 11 }}
                  label={{ value: 'Games', angle: -90, position: 'insideLeft', fill: '#808080', fontSize: 11 }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0a0a0a',
                    border: '1px solid #2a2a2a',
                    borderRadius: '6px',
                    fontSize: '11px',
                  }}
                  labelStyle={{ color: '#d4af37' }}
                  itemStyle={{ color: '#fff' }}
                />
                <Line
                  type="monotone"
                  dataKey="sampleCount"
                  stroke="#808080"
                  strokeWidth={2}
                  dot={{ fill: '#808080', r: 4 }}
                  name="Sample Count"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 text-[10px] text-[#606060]">
            Larger sample sizes provide more reliable calibration metrics
          </div>
        </div>
      </div>

      {/* Calibration Table */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#0a0a0a] border-b border-[#2a2a2a]">
                <th className="text-left p-3 text-[#808080]">Window</th>
                <th className="text-center p-3 text-[#d4af37]">Sample Count</th>
                <th className="text-center p-3 text-[#d4af37]">Margin Error</th>
                <th className="text-center p-3 text-[#d4af37]">Total Error</th>
                <th className="text-center p-3 text-[#d4af37]">Calib Slope</th>
                <th className="text-center p-3 text-[#d4af37]">Health</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1a1a1a]">
              {mockCalibrationData.map((data) => {
                const isHealthy = data.marginError < 10.0 && data.calibrationSlope > 0.90;
                return (
                  <tr key={data.window} className="hover:bg-[#0f0f0f]/50 transition-colors">
                    <td className="p-3 text-white">{data.window}</td>
                    <td className="text-center p-3 text-[#b0b0b0]">{data.sampleCount}</td>
                    <td className="text-center p-3 text-white">
                      {data.marginError.toFixed(1)}
                    </td>
                    <td className="text-center p-3 text-white">
                      {data.totalError.toFixed(1)}
                    </td>
                    <td className="text-center p-3 text-white">
                      {data.calibrationSlope.toFixed(2)}
                    </td>
                    <td className="text-center p-3">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] ${
                        isHealthy
                          ? 'bg-emerald-500/20 text-emerald-500 border border-emerald-500/40'
                          : 'bg-yellow-500/20 text-yellow-500 border border-yellow-500/40'
                      }`}>
                        {isHealthy ? 'Healthy' : 'Monitor'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Calibration Guide */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4">
        <h3 className="text-sm text-white mb-3">Calibration Metrics Guide</h3>
        <div className="grid grid-cols-3 gap-4 text-xs">
          <div>
            <div className="text-[#d4af37] mb-1">Margin Error</div>
            <div className="text-[#808080]">
              Mean absolute error for point spreads. Target: {'<'}10.0 pts. Lower is better.
            </div>
          </div>
          <div>
            <div className="text-[#d4af37] mb-1">Total Error</div>
            <div className="text-[#808080]">
              Mean absolute error for totals. Target: {'<'}11.0 pts. Lower is better.
            </div>
          </div>
          <div>
            <div className="text-[#d4af37] mb-1">Calibration Slope</div>
            <div className="text-[#808080]">
              Measures model confidence vs reality. Target: 0.90-1.0. 1.0 = perfect calibration.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
