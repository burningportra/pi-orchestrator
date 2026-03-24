import React from "react";

interface DataPoint {
  round: number;
  changes: number;
}

interface ConvergenceChartProps {
  data: DataPoint[];
  width?: number;
  height?: number;
}

export default function ConvergenceChart({
  data,
  width = 280,
  height = 80,
}: ConvergenceChartProps) {
  if (data.length === 0) return null;

  const padding = { top: 8, right: 12, bottom: 20, left: 32 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxChanges = Math.max(...data.map((d) => d.changes), 1);
  const maxRound = Math.max(...data.map((d) => d.round), 1);

  const toX = (round: number) =>
    padding.left + (round / maxRound) * chartW;
  const toY = (changes: number) =>
    padding.top + chartH - (changes / maxChanges) * chartH;

  const points = data.map((d) => ({ x: toX(d.round), y: toY(d.changes) }));
  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
    .join(" ");

  // Converging = last value < first value
  const isConverging =
    data.length >= 2 && data[data.length - 1].changes < data[0].changes;
  const lineColor = isConverging ? "#22c55e" : "#eab308";
  const dotColor = isConverging ? "#22c55e" : "#eab308";

  return (
    <svg
      width={width}
      height={height}
      className="bg-surface-1 rounded-lg border border-surface-3"
    >
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map((frac) => (
        <line
          key={frac}
          x1={padding.left}
          y1={padding.top + chartH * (1 - frac)}
          x2={width - padding.right}
          y2={padding.top + chartH * (1 - frac)}
          stroke="#242432"
          strokeWidth={0.5}
        />
      ))}

      {/* Axis labels */}
      <text
        x={padding.left - 4}
        y={padding.top + 4}
        textAnchor="end"
        className="fill-gray-600 text-[9px]"
      >
        {maxChanges}
      </text>
      <text
        x={padding.left - 4}
        y={padding.top + chartH + 4}
        textAnchor="end"
        className="fill-gray-600 text-[9px]"
      >
        0
      </text>
      <text
        x={width / 2}
        y={height - 2}
        textAnchor="middle"
        className="fill-gray-600 text-[9px]"
      >
        Rounds
      </text>

      {/* Line */}
      <path d={pathD} fill="none" stroke={lineColor} strokeWidth={1.5} />

      {/* Dots */}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={3} fill={dotColor} />
      ))}
    </svg>
  );
}
