"use client";

import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TrendPoint } from "@/lib/types";
import { STATUS_HEX } from "@/components/ui";

// Mirrors the colour tokens in globals.css. Recharts writes these into SVG presentation
// attributes, where CSS variables are not reliably resolved, so hex values are used here.
const C = {
  grid: "#2a2a2a", // --color-line
  axisLine: "#3d3d3d", // --color-line-strong
  tick: "#a3a3a3", // --color-fg-muted
  surface: "#141414", // --color-surface (segment separators)
  cursor: "rgba(255,255,255,0.04)",
};
const AXIS = { fontSize: 11, fill: C.tick };
const TOOLTIP = {
  contentStyle: {
    borderRadius: 8,
    border: "1px solid var(--color-line-strong)",
    background: "var(--color-elevated)",
    color: "var(--color-fg)",
    fontSize: 12,
    boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
  },
  labelStyle: { color: "var(--color-fg-strong)", fontWeight: 600 },
  itemStyle: { color: "var(--color-fg)" },
};

export function TrendChart({ data, days }: { data: TrendPoint[]; days: number }) {
  const fmt = (d: string) => {
    const dt = new Date(d + "T00:00:00");
    return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  };
  return (
    <div className="h-64 w-full" role="img" aria-label={`Stacked bar chart of passed, failed and blocked results per day over the last ${days} days`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap={days > 30 ? 1 : "20%"}>
          <CartesianGrid vertical={false} stroke={C.grid} />
          <XAxis dataKey="date" tickFormatter={fmt} tick={AXIS} tickLine={false} axisLine={{ stroke: C.axisLine }} minTickGap={24} />
          <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
          <Tooltip
            cursor={{ fill: C.cursor }}
            labelFormatter={(l) => fmt(String(l))}
            {...TOOLTIP}
          />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: C.tick }} />
          <Bar dataKey="passed" name="Passed" stackId="s" fill={STATUS_HEX.passed} stroke={C.surface} strokeWidth={1} />
          <Bar dataKey="failed" name="Failed" stackId="s" fill={STATUS_HEX.failed} stroke={C.surface} strokeWidth={1} />
          <Bar dataKey="blocked" name="Blocked" stackId="s" fill={STATUS_HEX.blocked} stroke={C.surface} strokeWidth={1} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PassFailDonut({ passed, failed, blocked, other }: { passed: number; failed: number; blocked: number; other: number }) {
  const data = [
    { name: "Passed", value: passed, color: STATUS_HEX.passed },
    { name: "Failed", value: failed, color: STATUS_HEX.failed },
    { name: "Blocked", value: blocked, color: STATUS_HEX.blocked },
    { name: "Other", value: other, color: STATUS_HEX.other },
  ].filter((d) => d.value > 0);
  const total = passed + failed + blocked + other;
  if (total === 0) return <p className="py-8 text-center text-sm text-fg-muted">No recorded results yet.</p>;
  const rate = passed + failed + blocked > 0 ? Math.round((passed / (passed + failed + blocked)) * 100) : 0;
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative h-40 w-40" role="img" aria-label={`Results: ${passed} passed, ${failed} failed, ${blocked} blocked, ${other} other`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={52} outerRadius={72} paddingAngle={data.length > 1 ? 2 : 0} stroke={C.surface} strokeWidth={2}>
              {data.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
            </Pie>
            <Tooltip {...TOOLTIP} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-semibold text-fg-strong">{rate}%</span>
          <span className="text-xs text-fg-muted">pass rate</span>
        </div>
      </div>
      <ul className="space-y-1.5 text-sm">
        {[
          ["Passed", passed, STATUS_HEX.passed],
          ["Failed", failed, STATUS_HEX.failed],
          ["Blocked", blocked, STATUS_HEX.blocked],
          ["Other", other, STATUS_HEX.other],
        ].map(([n, v, c]) => (
          <li key={n as string} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: c as string }} aria-hidden />
            <span className="w-16 text-fg">{n}</span>
            <span className="font-medium tabular-nums text-fg-strong">{v}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Compact horizontal summary bar for a run. */
export function SummaryBar({ s }: { s: { total: number; passed: number; failed: number; blocked: number; notExecuted: number; error: number } }) {
  const total = s.total || 1;
  const segs = [
    { k: "Passed", v: s.passed, c: "bg-emerald-500" },
    { k: "Failed", v: s.failed, c: "bg-red-500" },
    { k: "Error", v: s.error, c: "bg-red-700" },
    { k: "Blocked", v: s.blocked, c: "bg-amber-500" },
    { k: "Not executed", v: s.notExecuted, c: "bg-neutral-500" },
  ];
  return (
    <div>
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-overlay" role="img" aria-label={segs.map((x) => `${x.v} ${x.k.toLowerCase()}`).join(", ")}>
        {segs.map((x) => (x.v > 0 ? <div key={x.k} className={x.c} style={{ width: `${(x.v / total) * 100}%` }} title={`${x.k}: ${x.v}`} /> : null))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg">
        {segs.map((x) => (
          <li key={x.k} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${x.c}`} aria-hidden />
            {x.k} <span className="font-semibold tabular-nums text-fg-strong">{x.v}</span>
          </li>
        ))}
        <li className="text-fg-muted">
          Total <span className="font-semibold tabular-nums text-fg-strong">{s.total}</span>
        </li>
      </ul>
    </div>
  );
}
