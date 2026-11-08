import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui";

export const metadata = { title: "Help" };

const SECTIONS = [
  {
    title: "1. Create a project and environment",
    body: "Add the application URL, then confirm in Environments that you are authorised to test it. Production environments are read-only unless you explicitly allow destructive actions.",
  },
  {
    title: "2. Scan your site",
    body: "The site scan opens your pages, forms and menus like a visitor would, without submitting anything, and then writes draft checks for what it found. Check the “Limitations / not covered” panel: a scan can miss pages, so it never covers everything.",
  },
  {
    title: "3. Generate and review test cases",
    body: "AI-generated cases are saved as drafts marked “AI draft — review before use”. Approve or mark them ready before they can be run.",
  },
  {
    title: "4. Run tests",
    body: "Start manual, automated (Playwright) or API runs. Automated runs capture screenshots, video and logs as evidence.",
  },
  {
    title: "5. Triage failures",
    body: "“Analyse failure” produces a hypothesis — useful for triage, but the recorded result and evidence are the source of truth. Create defects from failed results with a prefilled draft.",
  },
  {
    title: "6. Report",
    body: "Generate PDF or CSV reports from recorded results for a run or a whole project.",
  },
];

export default function HelpPage() {
  return (
    <>
      <PageHeader title="Help" description="How Application Test AI fits into your QA workflow." />
      <div className="grid gap-4 md:grid-cols-2">
        {SECTIONS.map((s) => (
          <Card key={s.title}>
            <CardHeader title={s.title} />
            <CardBody>
              <p className="text-sm text-fg">{s.body}</p>
            </CardBody>
          </Card>
        ))}
      </div>
    </>
  );
}
