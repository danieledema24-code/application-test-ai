import { prisma } from "../db.js";

/** Allocates the next human-readable key (TC-0001 …) atomically per organisation. */
export async function nextKey(organisationId: string, kind: "case" | "run" | "defect", count = 1): Promise<string[]> {
  const field = ({ case: "caseSeq", run: "runSeq", defect: "defectSeq" } as const)[kind];
  const prefix = { case: "TC", run: "RUN", defect: "DEF" }[kind];
  const org = await prisma.organisation.update({ where: { id: organisationId }, data: { [field]: { increment: count } } });
  const end = org[field];
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(end - count + 1 + i).padStart(4, "0")}`);
}
