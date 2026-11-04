import { PageHeader } from "@/components/ui";
import { DefectsList } from "@/components/domain/DefectsList";

export const metadata = { title: "Defects" };

export default function DefectsPage() {
  return (
    <>
      <PageHeader title="Defects" description="Issues raised from test results and exploratory testing." />
      <DefectsList />
    </>
  );
}
