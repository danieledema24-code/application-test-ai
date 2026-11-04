import { PageHeader } from "@/components/ui";
import { RunsList } from "@/components/domain/RunsList";

export const metadata = { title: "Test runs" };

export default function TestRunsPage() {
  return (
    <>
      <PageHeader title="Test runs" description="Manual, automated and API executions across all projects." />
      <RunsList />
    </>
  );
}
