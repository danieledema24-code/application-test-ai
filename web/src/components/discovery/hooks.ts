"use client";

import useSWR from "swr";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Feature, Journey, Page, PageDetail, PageSummary, ScanDetail, ScanSummary, SitemapNode } from "@/lib/contract";
import { scanActive } from "@/lib/discovery";

export function useScans(projectId: string) {
  return useApi<Page<ScanSummary>>(`/projects/${projectId}/scans`, { limit: 100 });
}

/** The selected scan by sequence number (`?scan=n`), or the current discovery scan. Polls while active. */
export function useScan(projectId: string, scanNumber: number | null) {
  return useApi<ScanDetail>(scanNumber ? `/projects/${projectId}/scans/${scanNumber}` : `/projects/${projectId}/discovery`, undefined, {
    refreshInterval: (d) => (d && scanActive(d.status) ? 3000 : 0),
  });
}

/** Every page of a scan (Phase 1 scans are ≤ 100 pages, so this follows the cursor to the end). */
export function useAllPages(scanId: string | null | undefined, live = false) {
  return useSWR<PageSummary[]>(
    scanId ? `pages:${scanId}` : null,
    async () => {
      const out: PageSummary[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const res: Page<PageSummary> = await api<Page<PageSummary>>(`/scans/${scanId}/pages`, { query: { limit: 100, cursor } });
        out.push(...res.items);
        cursor = res.next_cursor;
        if (!cursor) break;
      }
      return out;
    },
    { revalidateOnFocus: false, refreshInterval: live ? 5000 : 0 },
  );
}

export function usePageDetail(pageId: string | null) {
  return useApi<PageDetail>(pageId ? `/pages/${pageId}` : null);
}

export function useSitemap(scanId: string | null | undefined, live = false) {
  return useApi<SitemapNode>(scanId ? `/scans/${scanId}/sitemap` : null, undefined, { refreshInterval: live ? 8000 : 0 });
}

export function useFeatures(scanId: string | null | undefined) {
  return useApi<Feature[]>(scanId ? `/scans/${scanId}/features` : null);
}

export function useJourneys(scanId: string | null | undefined) {
  return useApi<Journey[]>(scanId ? `/scans/${scanId}/journeys` : null);
}
