# Runtime capability document

Implements [#307](https://github.com/veridatum-labs/earnproof-frontend/issues/307):
load the capability-gated UI's runtime capability document from the backend
instead of the local fixture, with bounded caching, ETag revalidation,
deterministic stale/fail-closed behavior, and deployment identity checks.

See `lib/api/capabilities.ts` for the full "UX layer only, not a security
boundary" warning that everything here inherits.

## Where it lives

| Concern | Module |
| --- | --- |
| Document shape, validation, trust checks, real backend client | `lib/api/capabilities.ts` |
| Bounded `localStorage` cache (TTL + ETag) | `lib/api/capability-cache.ts` |
| React context, default fetcher wiring, stale/refresh orchestration | `lib/capabilities/capability-context.tsx` |

## Capability document

```ts
type CapabilityDocument = {
  documentVersion: number;   // must equal CAPABILITY_DOCUMENT_SHAPE_VERSION (1)
  apiVersion: string;        // major version must match API_SPEC_VERSION
  network: string;           // must match appConfig.stellarNetwork
  generatedAt: string;
  capabilities: Partial<Record<CapabilityKey, { enabled: boolean; note?: string }>>;
};
```

## Real backend client

`fetchCapabilityDocument()` (`lib/api/capabilities.ts`) calls
`GET {apiUrl}/capabilities`. This route is not yet in
`lib/api/openapi/earnproof-api.v1.json` — the shape above is this frontend's
forward contract for it; when the spec is regenerated with the real route,
only the URL/response parsing in that function should need to change.

- Bounded by the same per-request timeout as every other client
  (`fetchWithTimeout`), and cancellable via `AbortSignal`.
- Supports conditional revalidation: pass the previously-seen `ETag` as
  `etag`, and an unchanged document comes back as `304 Not Modified`
  (`{ kind: "not-modified" }`) instead of a full body.
- Never caches anything itself — `lib/capabilities/capability-context.tsx`
  owns composing the cache with this client.

## Fail-closed contract

| Situation | Result |
| --- | --- |
| Network/timeout/abort failure | `CapabilityDocumentError("network")` |
| `401`/`403` response | `CapabilityDocumentError("unauthorized")` |
| Any other non-2xx/304 response | `CapabilityDocumentError("network")` |
| Non-JSON or structurally malformed body | `CapabilityDocumentError("malformed")` |
| Well-formed body, wrong `documentVersion`, incompatible `apiVersion`, or wrong `network` | `CapabilityDocumentError("untrusted")` |
| `304 Not Modified` with no trusted cached document to reuse | rejected (never synthesizes a document) |

`isCapabilityDocumentTrusted()` is the single source of truth for whether a
document may be trusted at all (shape version + API version + network).
`isCapabilityEnabled()` calls it before ever reading a capability key, so an
untrusted document — including one computed for the **wrong network** —
resolves every key to `false`, the same as a missing document.

## Caching, staleness, and replay

`lib/api/capability-cache.ts` stores `{ document, identity, cachedAt, etag }`
in `localStorage`, keyed by the deployment identity (`apiUrl` + `network` +
`apiSpecVersion`) at write time.

| Situation | Behavior |
| --- | --- |
| Cache entry present, same deployment identity, within `CAPABILITY_CACHE_TTL_MS` (5 min) | Served directly — no network call. |
| Cache entry present, same deployment identity, past TTL | Backend is called (with conditional `If-None-Match` using the cached ETag); a `304` extends freshness without a new body. |
| Cache entry present, **different** deployment identity (cross-environment) | Never served, never used for revalidation, and dropped outright. The backend is called from scratch. |
| Fetch fails, and the stale cache entry is for the **same** deployment identity | `status: "stale"` — the last trusted document for this exact deployment is still served (`has()` behaves as it did before the failure). This is what keeps a transient network blip from hiding capabilities a user was already, correctly, granted. |
| Fetch fails, and there is no same-identity cache entry to fall back to | `status: "error"`, `document: null` — every `has()` check returns `false`. |
| `refresh()` called | Bypasses the TTL short-circuit and always calls the backend; the same stale/error fallback rules apply if it fails. |

A cached document is never "replayed" to grant something new: the identity
check and the trust check both re-run every time a cached (or stale-fallback)
document is used, exactly as they would for a freshly fetched one.

## `CapabilityStatus`

`"loading" | "ready" | "stale" | "error"`. `"stale"` is the only status that
is new to this issue — see the table above. UI built on `useCapability`/
`useCapabilities` can treat `"stale"` the same as `"ready"` for `has()`
purposes and optionally surface "capabilities may be out of date" using the
status value.
