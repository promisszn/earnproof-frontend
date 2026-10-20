# Organization role approval policy

Implements [#258](https://github.com/veridatum-labs/earnproof-frontend/issues/258)
(organizations need to configure which role changes require independent
approval and how long approval requests remain valid) and
[#309](https://github.com/veridatum-labs/earnproof-frontend/issues/309)
(connecting that editor to the live backend instead of a client-local mock).

## Where it lives

| Concern | Module |
| --- | --- |
| Types, validation, impact, versioning, fail-closed apply | `lib/api/organization-role-approval-policy.ts` |
| Editor / preview / history UI | `components/organizations/role-approval-policy-panel.tsx` |
| Route | `app/settings/organizations/role-approval/page.tsx` |

## Server-enforced minimums

`RoleApprovalMinimums` (defaulting to `DEFAULT_ROLE_APPROVAL_MINIMUMS`) is what
the client may never weaken. The UI can only make a policy *stricter*:

- at least `minApprovalsRequired` independent approvals (default 1);
- request validity within `[min..max]` hours (default 1–720);
- `allowSelfApproval` only when `selfApprovalPermitted` (default false);
- roles in `alwaysRequireApproval` (default `OWNER`) must always require
  approval.

`validateRoleApprovalPolicy()` returns the exact list of issues, so the editor,
the tests and the server all agree. A policy with any `error` issue cannot be
submitted. The server still re-validates every write — this layer only stops the
client offering a change it already knows will be rejected.

## Deterministic failure behavior

`applyPolicyUpdate()` fails closed with a specific reason:

| Reason | When |
| --- | --- |
| `unauthorized` | the viewer is not OWNER/ADMIN |
| `stale` | the server policy version has advanced past `expectedVersion` (also what replaying an already-applied update looks like), or the server uses a newer schema |
| `conflict` | the client believes the server version is *ahead* of it — versions are out of sync |
| `invalid` | the draft would weaken a server-enforced minimum |

On success the returned policy gets `policyVersion = current + 1` and a fresh
`updatedAt`, which is what makes replaying the same request fail closed the
second time.

Exact boundaries (approvals = 1 and 5; validity = 1 and 720 hours) are valid;
one step outside is rejected. Round-trip freshness and field-level comparisons
are exposed through `comparePolicyVersions()`.

## What the UI provides

- Per-role toggles for "requires independent approval".
- Independent-approvals and request-validity inputs.
- Self-approval toggle.
- Inline validation (errors block Save).
- Impact preview (`summarizePolicyImpact`) labelling a change as a
  strengthening or a relaxation.
- Version history with field-level comparison and
  **rollback-to-current** (`buildRollbackDraft` — a rollback is versioned and
  validated as a new change, so it can never resurrect a policy that violates
  current minimums).

Read-only roles (MEMBER/VIEWER) see a summary with all controls disabled.

## Authorization

`canManageRoleApprovalPolicy()` (OWNER/ADMIN) is UX gating only. The server is
the only authority for whether a policy write is allowed. The panel also
requires a `token` prop — without one, management controls are disabled even
for an OWNER/ADMIN `viewerRole`, since there is no session to authenticate a
write with.

## Real backend client (#309)

`lib/api/organization-role-approval-policy.ts` exports four real network
calls against `/organizations/{organizationId}/role-approval-policy` (not
yet in `lib/api/openapi/earnproof-api.v1.json` — this is this frontend's
forward contract for it), reusing the same `apiClient`/`bearer`/`retryRead`/
`retryMutation` conventions as `lib/api/organizations.ts`:

| Call | Method | Purpose |
| --- | --- | --- |
| `fetchRoleApprovalPolicy` | `GET .../role-approval-policy` | Current policy |
| `fetchRoleApprovalPolicyHistory` | `GET .../role-approval-policy/history` | Version history |
| `previewRoleApprovalPolicyUpdate` | `POST .../role-approval-policy/preview` | Server-side validation of a draft, merged with local `validateRoleApprovalPolicy` |
| `updateRoleApprovalPolicy` | `PUT .../role-approval-policy` (`If-Match: <expectedVersion>`) | Conditional write |

`fetchMockRoleApprovalPolicy` remains a fixture for local development/tests
only and is never wired as the default in `RoleApprovalPolicyPanel`.

**The UI never claims a save succeeded before the server confirms it.**
`handleSave` in the panel: (1) runs the cheap local `applyPolicyUpdate`
pre-check so an obviously invalid/weakening draft never reaches the network;
(2) calls the preview endpoint, which is authoritative for org-specific
minimums the client doesn't know about; (3) only then calls
`updateRoleApprovalPolicy`; (4) only *that* call's resolution — never any
earlier step — triggers the "Saved policy version N" notice and `onSaved`.

**Stale versions are rejected, not silently overwritten.** The write is
conditional (`If-Match` on the version the draft was loaded from). A stale
write is rejected by the server with `409 Conflict`, which `apiClient`
normalizes into `ApiConflictError` (`error.serverEntity` carries the
server's current policy). The panel catches this specifically
(`isRoleApprovalPolicyConflict`), adopts the server's real current policy
into local state, and shows a "changed on the server" error — the next save
attempt is based on real data, never a blind retry.

A malformed server response at any of the four calls is rejected by
`isWellFormedRoleApprovalPolicy` (or, for history, filtered entry-by-entry)
rather than trusted — the same fail-closed discipline as
`lib/api/capabilities.ts` and `lib/api/contract-migration.ts`.
