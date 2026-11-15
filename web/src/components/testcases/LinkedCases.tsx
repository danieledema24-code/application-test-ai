"use client";

import Link from "next/link";
import { Plus, TriangleAlert } from "lucide-react";
import type { RequirementStatus } from "@/lib/contract";
import { useAuth } from "@/lib/auth";
import { EMPTY_CASE_FILTERS, casesForRequirement, linkedCasesState, sortCases } from "@/lib/testcases";
import { LinkButton, Skeleton } from "@/components/ui";
import { useProject } from "@/components/workspace/ProjectContext";
import { gateApproved, requirementsStages } from "@/components/requirements/hooks";
import { CaseStatusPill, OpenQuestionPill, TechniqueChip } from "./Bits";
import { useAllTestCases, useOpenQuestionKeys } from "./hooks";

/** Requirement detail, "Linked test cases" (design P3 §9). Shares the test-case list cache. */
export function LinkedTestCases({ requirementKey, status }: { requirementKey: string; status: RequirementStatus }) {
  const p = useProject();
  const { role } = useAuth();
  const canEdit = role !== null && role !== "viewer";
  const stages = requirementsStages(p.workflow);
  const designed = !!stages.design?.current_version;
  const all = useAllTestCases(p.id, null, designed);
  const oq = useOpenQuestionKeys(all.data);
  const found = casesForRequirement(all.data ?? [], requirementKey, oq.keys);
  const cases = sortCases(found.cases, EMPTY_CASE_FILTERS.sort);
  const waiting = sortCases(found.waiting, EMPTY_CASE_FILTERS.sort);
  const state = linkedCasesState({ g4Approved: gateApproved(stages.g4), designed, status, count: cases.length });
  const newHref = `/projects/${p.id}/test-cases/new?requirement=${encodeURIComponent(requirementKey)}`;
  const newButton = canEdit && designed && status === "approved" && (
    <LinkButton href={newHref} variant="secondary" size="sm" icon={<Plus className="h-4 w-4" aria-hidden />}>
      New test case for {requirementKey}
    </LinkButton>
  );

  return (
    <section className="space-y-2 px-4 py-3" aria-labelledby="linked-cases-h">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="linked-cases-h" className="text-small font-semibold text-fg-strong">
          Linked test cases{designed && all.data ? ` (${cases.length})` : ""}
        </h2>
        {designed && (
          <Link href={`/projects/${p.id}/traceability/${requirementKey}`} className="text-small font-medium text-navy-700 underline underline-offset-2">
            View traceability<span className="sr-only"> for {requirementKey}</span>
          </Link>
        )}
      </div>
      {designed && ((!all.data && !all.error) || oq.loading) ? (
        <Skeleton className="h-16" />
      ) : designed && all.error && !all.data ? (
        <p className="text-body text-fg-muted">Couldn’t load the linked test cases.</p>
      ) : state.text ? (
        <>
          <p className="text-body text-fg-muted">{state.text}</p>
          {state.uncovered && (
            <p className="flex items-start gap-1.5 text-body font-medium text-warning-fg">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              This approved requirement isn’t covered.
            </p>
          )}
          {state.offerNew && newButton}
        </>
      ) : (
        <>
          {waiting.length > 0 && (
            <p className="text-body text-fg">
              {waiting.length} test case{waiting.length === 1 ? " is" : "s are"} waiting for this answer: {waiting.map((c) => c.key).join(", ")}.
            </p>
          )}
          <ul className="space-y-1.5 text-body">
            {cases.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Link href={`/projects/${p.id}/test-cases/${c.key}`} className="min-w-0 break-words text-navy-700 underline underline-offset-2">
                  <span className="font-mono">{c.key}</span> {c.title}
                </Link>
                <TechniqueChip technique={c.technique} />
                <CaseStatusPill status={c.status} />
                {c.expected_result_status === "open_question" && <OpenQuestionPill />}
              </li>
            ))}
          </ul>
          {newButton}
        </>
      )}
    </section>
  );
}
