import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui";

export const metadata = { title: "Help" };

const SECTIONS = [
  {
    title: "1. Start a QA analysis",
    body: "Enter a website URL on the dashboard. We check that it is public and reachable before anything starts. Only analyse sites you’re authorised to test.",
  },
  {
    title: "2. Confirm authorisation (Gate 1)",
    body: "Confirm you own the site or have the owner’s permission. Your confirmation is recorded with your name and the time.",
  },
  {
    title: "3. Watch Application Discovery",
    body: "An isolated browser opens pages, reads their structure and takes screenshots. It never submits forms, makes purchases, or creates, changes or deletes data. You can pause, resume or cancel at any time.",
  },
  {
    title: "4. Review the findings",
    body: "Every finding is labelled Observed (seen directly in the browser) or Inferred (concluded from what was seen, not verified) and links to its evidence.",
  },
  {
    title: "5. Approve discovery (Gate 2)",
    body: "Read the agent’s completeness assessment and approve, request changes, or re-scan with different settings. Earlier scans and their reports are kept.",
  },
  {
    title: "6. Download the report",
    body: "The Application Discovery Report is available in the app and as a PDF. Requirements, test design, automation and execution arrive in later phases.",
  },
];

export default function HelpPage() {
  return (
    <>
      <PageHeader title="Help" description="How the QA Analyst works in Phase 1." />
      <div className="grid gap-4 md:grid-cols-2">
        {SECTIONS.map((s) => (
          <Card key={s.title}>
            <CardHeader title={s.title} />
            <CardBody>
              <p className="text-body text-fg">{s.body}</p>
            </CardBody>
          </Card>
        ))}
      </div>
    </>
  );
}
