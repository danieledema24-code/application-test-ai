"use client";

import useSWR, { type SWRConfiguration } from "swr";
import { api, buildQuery } from "./api";

type Query = Record<string, string | number | boolean | null | undefined>;

/** SWR-backed GET. Pass `null` as path to skip fetching. */
export function useApi<T>(path: string | null, query?: Query, config?: SWRConfiguration<T>) {
  const key = path ? `${path}${buildQuery(query)}` : null;
  return useSWR<T>(key, (k: string) => api<T>(k), { revalidateOnFocus: false, ...config });
}
