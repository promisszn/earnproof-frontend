import { PageHeading } from "@/components/common/page-heading";
import { pageContainer } from "@/components/common/production-ui";
import { PublicShell } from "@/components/layout/public-shell";
import { RoleApprovalPolicyPanel } from "@/components/organizations/role-approval-policy-panel";

export const metadata = {
  title: "Role approval policy | EarnProof",
  description:
    "Configure which organization role changes require independent approval and how long requests stay valid.",
};

/**
 * Role approval policy configuration (#258, connected to the backend in #309).
 *
 * The viewer's effective organization role/token is wired through once the
 * organization session is available at this route (`AuthSessionProvider` is
 * not yet mounted anywhere above it in `app/`, tracked separately from
 * #309's scope); until then this route renders the panel without a `token`,
 * which now correctly shows a "sign in" read-only state instead of a fully
 * editable management UI with nothing real behind it.
 */
export default function RoleApprovalPolicyPage() {
  return (
    <PublicShell>
      <section className={`${pageContainer} gap-8 sm:gap-10`}>
        <PageHeading
          description="Configure which role changes require independent approval, and how long approval requests remain valid."
          eyebrow="Administration"
          title="Role approval policy"
        />
        <RoleApprovalPolicyPanel organizationId="current" viewerRole="OWNER" />
      </section>
    </PublicShell>
  );
}
