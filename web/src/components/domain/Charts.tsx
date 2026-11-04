"use client";

import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TrendPoint } from "@/lib/types";
import { STATUS_HEX } from "@/components/ui";

const AXIS = { fontSize: 11, fill: "#475569" };

export function TrendChart({ data, days }: { data: TrendPoint[]; days: number }) {
  const fmt = (d: string) => {
    const dt = new Date(d + "T00:00:00");
    return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  };
  return (
    <div className="h-64 w-full" role="img" aria-label={`Stacked bar chart of passed, failed and blocked results per day over the last ${days} days`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap={days > 30 ? 1 : "20%"}>
          <CartesianGrid vertical={false} stroke="#e2e8f0" />
          <XAxis dataKey="date" tickFormatter={fmt} tick={AXIS} tickLine={false} axisLine={{ stroke: "#cbd5e1" }} minTickGap={24} />
          <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
          <Tooltip
            cursor={{ fill: "#f1f5f9" }}
            labelFormatter={(l) => fmt(String(l))}
            contentStyle={{ borderRadius: 8, borderColor: "#e2e8f0", fontSize: 12 }}
          />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: "#334155" }} />
          <Bar dataKey="passed" name="Passed" stackId="s" fill={STATUS_HEX.passed} stroke="#fff" strokeWidth={1} />
          <Bar dataKey="failed" name="Failed" stackId="s" fill={STATUS_HEX.failed} stroke="#fff" strokeWidth={1} />
          <Bar dataKey="blocked" name="Blocked" stackId="s" fill={STATUS_HEX.blocked} stroke="#fff" strokeWidth={1} radius={[3, 3, 0, 0]} />
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
  if (total === 0) return <p className="py-8 text-center text-sm text-slate-600">No recorded results yet.</p>;
  const rate = passed + failed + blocked > 0 ? Math.round((passed / (passed + failed + blocked)) * 100) : 0;
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative h-40 w-40" role="img" aria-label={`Results: ${passed} passed, ${failed} failed, ${blocked} blocked, ${other} other`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={52} outerRadius={72} paddingAngle={data.length > 1 ? 2 : 0} stroke="#fff" strokeWidth={2}>
              {data.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
            </Pie>
            <Tooltip contentStyle={{ borderRadius: 8, borderColor: "#e2e8f0", fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-semibold text-slate-900">{rate}%</span>
          <span className="text-xs text-slate-600">pass rate</span>
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
            <span className="w-16 text-slate-700">{n}</span>
            <span className="font-medium tabular-nums text-slate-900">{v}</span>
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
    { k: "Error", v: s.error, c: "bg-red-800" },
    { k: "Blocked", v: s.blocked, c: "bg-amber-500" },
    { k: "Not executed", v: s.notExecuted, c: "bg-slate-300" },
  ];
  return (
    <div>
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={segs.map((x) => `${x.v} ${x.k.toLowerCase()}`).join(", ")}>
        {segs.map((x) => (x.v > 0 ? <div key={x.k} className={x.c} style={{ width: `${(x.v / total) * 100}%` }} title={`${x.k}: ${x.v}`} /> : null))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700">
        {segs.map((x) => (
          <li key={x.k} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${x.c}`} aria-hidden />
            {x.k} <span className="font-semibold tabular-nums text-slate-900">{x.v}</span>
          </li>
        ))}
        <li className="text-slate-600">
          Total <span className="font-semibold tabular-nums text-slate-900">{s.total}</span>
        </li>
      </ul>
    </div>
  );
}
