# Organization data residency policy

Implements [#277](https://github.com/veridatum-labs/earnproof-frontend/issues/277)
(organizations need to review the allowed storage and processing regions for
regulated data classes and background jobs) and
[#310](https://github.com/veridatum-labs/earnproof-frontend/issues/310)
(connecting that editor to the live backend instead of a client-local mock,
with tenant-scoped caching and rollout-status polling).

## Where it lives

| Concern | Module |
| --- | --- |
| Region capabilities, validation, compliance, blockers, versioning | `lib/api/organization-data-residency.ts` |
| Editor / impact preview / history UI | `components/organizations/data-residency-policy-panel.tsx` |
| Route | `app/settings/organizations/data-residency/page.tsx` |

## Region capabilities

`REGION_CAPABILITIES` maps each processing region to the data classes it may
store/process, and marks deprecated regions. `isRegionSupportedForClass()`
returns `false` for:

- a region that does not list the data class, and
- a deprecated region (existing data may remain, but no new placement).

The editor disables every unsupported checkbox, so an unsupported region cannot
be selected in the first place.

## Compliance is never implied

`computeComplianceStatus()` reports `compliant` **only** when all of the
following hold:

1. the policy validates (no unsupported selections);
2. `serverValidation === "accepted"`;
3. every data class's `migration` is `"complete"`;
4. `rollout.status === "complete"`.

Otherwise it returns `awaiting-server-validation`, `migration-incomplete` or
`invalid`, with the exact outstanding reasons. Saving a change resets
`serverValidation` to `"pending"` and the rollout to `"not-started"`, so the UI
immediately stops claiming compliance until the server catches up.

## Migration blockers

`computeMigrationBlockers(current, next)` blocks any change to a data class's
placement (or a region removal) while that class's migration is incomplete.
`applyResidencyUpdate()` refuses such a change with reason `"blocked"`.

## Deterministic failure behavior

| Reason | When |
| --- | --- |
| `stale` | server version advanced past `expectedVersion` (also replay), or a newer schema |
| `conflict` | client believes the server version is ahead — out of sync |
| `invalid` | draft selects a region that cannot store the chosen data class, or leaves a class with no region |
| `blocked` | an incomplete migration blocks the placement change |

## What the UI provides

- Per-data-class region selection (unsupported/deprecated regions disabled).
- Background-job region selection.
- Inline validation (errors block Save).
- Impact preview (`summarizeResidencyImpact`), including migration blockers.
- Explicit compliance banner with reasons and rollout/validation state.
- Version history with field-level comparison and rollback
  (`buildResidencyRollbackDraft` — versioned and re-validated as a new change).

Read-only roles (MEMBER/VIEWER) see the same information with controls disabled.
A `token` prop is also required for management actions — without one,
`canManageDataResidencyPolicy()` is overridden to read-only regardless of
`viewerRole`, since there is no session to authenticate a write with.

## Real backend client, tenant-scoped caching, and rollout polling (#310)

`lib/api/organization-data-residency.ts` exports real network calls against
`/organizations/{organizationId}/data-residency-policy` (not yet in
`lib/api/openapi/earnproof-api.v1.json` — this frontend's forward contract
for it), reusing the same `apiClient`/`bearer`/`retryRead`/`retryMutation`
conventions as `lib/api/organizations.ts` and
`lib/api/organization-role-approval-policy.ts`:

| Call | Method | Purpose |
| --- | --- | --- |
| `fetchDataResidencyPolicy` | `GET .../data-residency-policy` (+ `GET .../history`) | Current policy + version history, tenant-cache-aware |
| `previewResidencyPolicyUpdate` | `POST .../preview` | Server-side validation/blockers, merged with local `validateResidencyPolicy`/`computeMigrationBlockers` |
| `updateDataResidencyPolicy` | `PUT ...` (`If-Match: <expectedVersion>`) | Conditional write; invalidates this organization's cache on success |
| `fetchDataResidencyRolloutStatus` | `GET .../rollout-status` | Just `migration`/`rollout`/`serverValidation`, polled independently of a full policy reload |

`fetchMockDataResidencyPolicy` remains a fixture for local
development/tests only and is never wired as the default in
`DataResidencyPolicyPanel` — mock data never ships in production.

**Tenant-scoped caching.** `getCachedDataResidencyPolicy`/
`setCachedDataResidencyPolicy`/`invalidateDataResidencyPolicyCache` keep an
in-memory (never persisted) `Map` keyed by `organizationId`, each entry also
stamped with the deployment identity (`apiUrl`/`network`/`apiSpecVersion`,
from `lib/api/capabilities.ts`) it was fetched under. A read is only served
from cache when both the organization and the deployment identity match the
current one *and* the entry is within `DATA_RESIDENCY_CACHE_TTL_MS` (2
minutes) — an environment switch or a TTL expiry falls back to the network,
never a stale or cross-tenant entry.

**Organization switches invalidate state in the UI, not just the cache.**
`DataResidencyPolicyPanel` resets its local `policy`/`draft`/`history` the
moment its `organizationId` prop changes (using the "adjust state during
render" pattern, so the previous organization's policy is never even
painted for one frame) and reloads from scratch.

**Rollout-status polling.** While mounted and holding a `token`, the panel
polls `fetchDataResidencyRolloutStatus` every 30 seconds and merges just
`migration`/`rollout`/`serverValidation` into the current policy — a
long-running region migration's progress (and therefore
`computeComplianceStatus()`'s verdict) stays current without a full policy
reload, and without disturbing `placements`/`backgroundJobRegion`/
`policyVersion`.

**The UI never claims a save succeeded before the server confirms it,** and
a stale write is rejected, not silently overwritten: the same
pre-check → server preview → conditional update → adopt-the-server's-
current-entity-on-409 flow documented in `docs/role-approval-policy.md`
applies here via `isDataResidencyPolicyConflict`/`ApiConflictError`.
