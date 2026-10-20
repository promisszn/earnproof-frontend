import { PageHeading } from "@/components/common/page-heading";
import { pageContainer } from "@/components/common/production-ui";
import { PublicShell } from "@/components/layout/public-shell";
import { DataResidencyPolicyPanel } from "@/components/organizations/data-residency-policy-panel";

export const metadata = {
  title: "Data residency | EarnProof",
  description:
    "Review the allowed storage and processing regions for each data class and for background jobs.",
};

/**
 * Organization data residency policy controls (#277, connected to the
 * backend in #310).
 *
 * The viewer's effective organization role/token is wired through once the
 * organization session is available at this route (`AuthSessionProvider` is
 * not yet mounted anywhere above it in `app/`, tracked separately from
 * #310's scope); until then this route renders the panel without a `token`,
 * which now correctly shows a "sign in" read-only state instead of a fully
 * editable management UI with nothing real behind it.
 */
export default function DataResidencyPolicyPage() {
  return (
    <PublicShell>
      <section className={`${pageContainer} gap-8 sm:gap-10`}>
        <PageHeading
          description="Review the allowed storage and processing regions for each data class and background jobs."
          eyebrow="Administration"
          title="Data residency"
        />
        <DataResidencyPolicyPanel organizationId="current" viewerRole="OWNER" />
      </section>
    </PublicShell>
  );
}
