# Contract successor migration readiness

Implements [#266](https://github.com/veridatum-labs/earnproof-frontend/issues/266)
(route-level guidance when a contract is preparing to move, has been
decommissioned, or has been replaced by a successor) and
[#308](https://github.com/veridatum-labs/earnproof-frontend/issues/308)
(connecting that guidance to the live backend instead of the local fixture).

## Where it lives

| Concern | Module |
| --- | --- |
| Status shape, validation, gating, link resolution, real backend client | `lib/api/contract-migration.ts` |
| Banner, self-loading + polling mount, action gate | `components/common/contract-migration-banner.tsx` |
| Global mount point | `app/layout.tsx` |

## Status document

```ts
type ContractMigrationStatus = {
  schemaVersion: number;              // must equal CONTRACT_MIGRATION_SCHEMA_VERSION (1)
  network: string;                    // must match appConfig.stellarNetwork
  currentContractId: string;
  phase: "stable" | "preparing" | "migrating" | "decommissioned" | "replaced";
  effectiveAt?: string;
  readOnlySince?: string;
  statusPageUrl?: string;
  successor?: {
    contractId: string;               // StrKey "C…" form
    verified: boolean;                // server-attested
    label?: string;
    migrationGuideUrl?: string;
  };
};
```

There is no `/contracts/migration-status` endpoint in the API spec yet.
`fetchContractMigrationStatus()` is the production client for this
frontend's forward contract for that route; `fetchMockContractMigrationStatus()`
remains a fixture for local development/tests only and is never wired as the
default in `ContractMigrationStatusBanner`. When the real route ships, only
the URL/response parsing in `fetchContractMigrationStatus()` should need to
change — never the gating contract below.

## Real backend client and polling

`ContractMigrationStatusBanner` (mounted once, unauthenticated, in
`app/layout.tsx`) fetches on mount via `fetchContractMigrationStatus()` and
re-checks every `pollIntervalMs` (default 2 minutes) while mounted, with
conditional (`If-None-Match`) revalidation and `AbortController`-based
cancellation on unmount/next poll.

**Fail-safe, not fail-closed-to-null:** a poll failure (network error,
timeout, `401`/`403`, malformed or wrong-network body) never clears a
previously-known status. If it did, a transient backend outage during an
active `"migrating"` phase would silently fall back to
`canPerform(null, "write")` — which is *permissive* — incorrectly
re-enabling writes that should stay blocked. The last known-good status
keeps gating reads/writes exactly as before; only its *freshness* degrades.

**Stale data cannot authorize a successor redirect.** `isMigrationStatusFresh()`
bounds how long a fetched status may be used to offer a successor link
(`MIGRATION_STATUS_MAX_AGE_MS`, 10 minutes) — tracked independently of
whether the status itself is still being shown. `ContractMigrationBanner`'s
`successorTrustAllowed` prop (default `true`, so every existing
prop-driven caller is unaffected) is what `ContractMigrationStatusBanner`
sets to `false` once its polled status has aged out: the banner keeps
rendering the (now stale) phase and keeps gating writes from it, but stops
offering a redirect to the successor until a poll revalidates it. A
stale-but-still-verified successor is distinguished in the UI
(`data-testid="stale-successor-note"`) from one that was never verified at
all, so the two failure modes are never conflated.

| Situation | Status shown | Writes gated by | Successor link |
| --- | --- | --- | --- |
| Backend reachable, status fresh | current | current | offered if verified |
| Backend unreachable, no status fetched yet | none (banner renders nothing) | not gated (no information) | — |
| Backend unreachable after a prior successful fetch | last known | last known | withheld once stale, even if verified |
| Backend returns `304 Not Modified` | last known, revalidated | last known | re-offered (freshness restored) |

## Deterministic behavior

| Situation | Reads | Writes | Banner |
| --- | --- | --- | --- |
| No status, or `phase: "stable"` | allowed | allowed | none |
| `phase: "preparing"` | allowed | allowed | warning |
| `phase: "migrating"` | allowed | blocked | warning + read-only note |
| `phase: "decommissioned"` | allowed | blocked | danger + read-only note |
| `phase: "replaced"` | allowed | blocked | danger + read-only note |
| Unsupported `schemaVersion` | allowed | blocked (fail closed) | none (surfaced as stale) |
| `network` ≠ `appConfig.stellarNetwork` | allowed | blocked (fail closed) | none (surfaced as stale) |

Read-only access — including on a decommissioned or replaced contract — is
always preserved.

## Successor identity checks

`resolveSuccessorGuideLink()` is the only function that can produce a link to a
successor, and it returns `null` unless **all** of the following hold:

1. the document is a supported schema and for the current network;
2. `successor.verified === true` (server-attested);
3. `successor.contractId` is a well-formed Stellar contract ID;
4. `successor.contractId` differs from `currentContractId`;
5. `successor.migrationGuideUrl` is an absolute HTTPS URL with no embedded
   credentials.

Consequently the client can never redirect a user to an unverified successor.
The public status page (`statusPageUrl`) is an announcement rather than a
redirect target, so it is shown independently of successor trust — but it is
still restricted to safe HTTPS URLs.

## Network awareness

The banner uses `useNetworkStatus()` from `lib/network`. While the browser is
offline it states that the displayed migration status may be out of date,
rather than implying the state is current.
