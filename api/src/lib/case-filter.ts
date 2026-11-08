import type { Prisma } from "@prisma/client";

export type CaseQuery = { search?: string; category?: string; priority?: string; status?: string; scan?: string };

/** Filters shared by the test-case list and its CSV export. `scan` keeps only the checks written by that site scan. */
export function caseListWhere(projectId: string, q: CaseQuery): Prisma.TestCaseWhereInput {
  return {
    projectId, ...(q.category ? { category: q.category } : {}), ...(q.priority ? { priority: q.priority } : {}), ...(q.status ? { status: q.status } : {}),
    ...(q.scan ? { discoveryId: q.scan } : {}),
    ...(q.search ? { OR: [{ title: { contains: q.search } }, { key: { contains: q.search } }, { description: { contains: q.search } }] } : {}),
  };
}
