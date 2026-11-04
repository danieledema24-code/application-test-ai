import { config } from "../config.js";

// Queue abstraction (spec NFR-004). This in-process implementation runs jobs on a bounded
// worker pool; job state lives in the database, so swapping in Redis/BullMQ only means
// re-implementing enqueue() and the pump. Browser work itself runs in child processes.
export type Job = { type: "automated-run" | "api-run" | "discovery"; id: string };
type Handler = (job: Job) => Promise<void>;

const handlers = new Map<Job["type"], Handler>();
const pending: Job[] = [];
const cancelled = new Set<string>();
let active = 0;

export function registerHandler(type: Job["type"], handler: Handler) {
  handlers.set(type, handler);
}

export function enqueue(job: Job) {
  if (!pending.some((j) => j.id === job.id)) pending.push(job);
  setImmediate(pump);
}

export function cancel(id: string) {
  cancelled.add(id);
  const i = pending.findIndex((j) => j.id === id);
  if (i >= 0) pending.splice(i, 1);
}

export const isCancelled = (id: string) => cancelled.has(id);
export const queueStats = () => ({ pending: pending.length, active, concurrency: config.workerConcurrency });

function pump() {
  while (active < config.workerConcurrency && pending.length) {
    const job = pending.shift()!;
    const handler = handlers.get(job.type);
    if (!handler) continue;
    active++;
    handler(job)
      .catch((err) => console.error(`[queue] ${job.type} ${job.id} crashed:`, err))
      .finally(() => {
        active--;
        cancelled.delete(job.id);
        setImmediate(pump);
      });
  }
}
