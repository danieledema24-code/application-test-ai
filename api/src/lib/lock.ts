// In-process mutex keyed by string (e.g. a project id). Jobs and requests run in this one API process
// (see services/queue.ts), so this is enough to serialise work per project. A multi-process deployment
// would need a database or Redis lock instead.
const tails = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}
