// Fixed log-bucketed latency histogram: bucket i covers [GROWTH^i, GROWTH^(i+1)) microseconds and reports its
// geometric midpoint, so any percentile is within 0.5 % of a recorded value (the story asks for <= 1 %). The exact
// minimum and maximum are kept and clamp the estimate. Memory is fixed (~2 100 counters), whatever the run length.
const GROWTH = 1.01;
const LN_GROWTH = Math.log(GROWTH);
const MAX_US = 3_600_000_000; // one hour
const BUCKETS = Math.ceil(Math.log(MAX_US) / LN_GROWTH) + 1;

export class Histogram {
  private counts = new Uint32Array(BUCKETS);
  count = 0;
  sum = 0;
  min = Infinity;
  max = 0;

  record(ms: number): void {
    const us = Math.min(Math.max(ms * 1000, 1), MAX_US);
    this.counts[Math.floor(Math.log(us) / LN_GROWTH)]++;
    this.count++;
    this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;
  }

  /** The q-quantile (0–1) in milliseconds, or null when nothing was recorded. */
  percentile(q: number): number | null {
    if (!this.count) return null;
    const rank = Math.max(1, Math.ceil(q * this.count));
    let seen = 0;
    for (let i = 0; i < BUCKETS; i++) {
      seen += this.counts[i];
      if (seen >= rank) {
        const mid = Math.pow(GROWTH, i + 0.5) / 1000;
        return Math.min(Math.max(mid, this.min), this.max);
      }
    }
    return this.max;
  }
}

/** Exact nearest-rank percentile of a small list (per-second and rolling-window figures). */
export function exactPercentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

export const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);
