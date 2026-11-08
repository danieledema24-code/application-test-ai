import { PageHeader } from "@/components/ui";
import { DefectsList } from "@/components/domain/DefectsList";

export const metadata = { title: "Bugs" };

export default function DefectsPage() {
  return (
    <>
      <PageHeader title="Bugs" description="Problems found by your test runs, and any you log yourself." />
      <DefectsList />
    </>
  );
}
