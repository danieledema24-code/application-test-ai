// JSON columns are stored as text so the schema is portable between SQLite and Postgres.
export function parse<T>(value: string | null | undefined, fallback: T): T {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export const str = (value: unknown) => JSON.stringify(value ?? null);

/**
 * For PATCH bodies: keep only keys the client actually sent. Zod 4 applies `.default()` values
 * even under `.partial()`, which would otherwise silently reset omitted fields.
 */
export function provided<T extends object>(parsed: T, raw: unknown): Partial<T> {
  const sent = raw && typeof raw === "object" ? new Set(Object.keys(raw)) : new Set<string>();
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => sent.has(k))) as Partial<T>;
}
