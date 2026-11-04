import { PageHeader } from "@/components/ui";
import { ReportsList } from "@/components/domain/ReportsList";

export const metadata = { title: "Reports" };

export default function ReportsPage() {
  return (
    <>
      <PageHeader title="Reports" description="Historical PDF and CSV reports built from recorded results." />
      <ReportsList />
    </>
  );
}
