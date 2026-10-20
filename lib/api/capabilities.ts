/**
 * Capability gating — UX layer only, never a security boundary.
 * =================================================================
 *
 * This module lets routes/actions show or hide themselves based on a
 * "capability document" the client holds. It exists purely to avoid
 * showing controls for backend functionality that isn't available yet
 * (a route behind a partial rollout, a network the API doesn't support,
 * an API version the deployed frontend has outdated assumptions about).
 *
 * IMPORTANT — read before using `useCapability`/`isCapabilityEnabled`
 * anywhere:
 *
 * 1. This is NOT an authorization system. The backend is the only thing
 *    that may decide whether a request is actually allowed to succeed.
 *    Every mutation and every read of sensitive data MUST still be
 *    enforced server-side, exactly as if this module did not exist.
 * 2. Treat every value here as attacker-controlled UX hint, not fact. A
 *    user can trivially edit the cached document in devtools, disable
 *    JS execution of the fail-closed check, or hand-craft a request that
 *    never goes through gated UI at all. None of that should grant them
 *    anything the server wouldn't otherwise allow.
 * 3. Do not use this module to decide whether to render sensitive data
 *    that was already fetched — only whether to *offer* the action that
 *    would fetch/submit it. The server response (or its absence) is the
 *    actual gate.
 * 4. `fetchCapabilityDocument` is the production client: it calls the real
 *    backend (`GET {apiUrl}/capabilities`, not yet present in
 *    `lib/api/openapi/earnproof-api.v1.json` — see that function's own
 *    comment for the forward contract this frontend assumes).
 *    `fetchMockCapabilityDocument` is a fixture for local development and
 *    tests only; it is never wired as the default in
 *    `lib/capabilities/capability-context.tsx`. Either way, the gating
 *    contract below (fail closed, cache invalidation, "never a security
 *    boundary") is unaffected by which fetcher is in use.
 *
 * Fail-closed contract: any capability key not present (or not `true`)
 * in the resolved document is treated as disabled. A stale, missing, or
 * malformed document also resolves to "no capabilities enabled" rather
 * than throwing — callers should never crash because this module 404s.
 */

import { appConfig } from "@/config/app";
import { API_SPEC_VERSION } from "@/lib/api/generated/v1";
import { fetchWithTimeout } from "@/lib/api/client";
import { recordNetworkFailure, recordNetworkSuccess } from "@/lib/network";

/**
 * Capability keys the frontend currently knows how to gate on. Adding a
 * new gated route/action means adding its key here first — the type
 * system then forces every call site to handle the "capability missing"
 * case explicitly instead of assuming a feature is on.
 */
export const CAPABILITY_KEYS = [
  "activity-log",
  "embeddable-verification-widget",
  "recurring-income-proofs",
  "payment-receipt-proofs",
  "organization-management",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export type CapabilityState = {
  /** Fully rolled out and safe to offer to every user. */
  enabled: boolean;
  /**
   * Optional rollout note surfaced in the unavailable state (e.g. "Rolling
   * out to a subset of organizations"). Never used to bypass `enabled`.
   */
  note?: string;
};

/**
 * A versioned capability document, as (eventually) served by the backend.
 * `apiVersion` is the API contract version the document was computed
 * against — the frontend fails closed if it can't parse that version or
 * if it is incompatible with `API_SPEC_VERSION`.
 */
export type CapabilityDocument = {
  documentVersion: number;
  apiVersion: string;
  network: string;
  generatedAt: string;
  capabilities: Partial<Record<CapabilityKey, CapabilityState>>;
};

export const CAPABILITY_DOCUMENT_SHAPE_VERSION = 1;

/**
 * "Deployment identity" for cache-invalidation purposes: the combination
 * of values that, if any of them changes, means a cached capability
 * document can no longer be trusted. Built entirely from state this
 * codebase already tracks (`config/app.ts`, the generated API spec
 * version) — no new source of truth is introduced.
 */
export type DeploymentIdentity = {
  apiUrl: string;
  stellarNetwork: string;
  apiSpecVersion: string;
};

export function currentDeploymentIdentity(): DeploymentIdentity {
  return {
    apiUrl: appConfig.apiUrl,
    stellarNetwork: appConfig.stellarNetwork,
    apiSpecVersion: API_SPEC_VERSION,
  };
}

function identityKey(identity: DeploymentIdentity): string {
  return [identity.apiUrl, identity.stellarNetwork, identity.apiSpecVersion].join("|");
}

export function deploymentIdentityChanged(
  a: DeploymentIdentity,
  b: DeploymentIdentity,
): boolean {
  return identityKey(a) !== identityKey(b);
}

/**
 * A minimal semver-ish major.minor.patch compatibility check: the
 * document is considered incompatible if its major version differs from
 * the frontend's known API spec major version. This mirrors how
 * `API_SPEC_VERSION` (from the generated client) is already versioned —
 * see `lib/api/generated/v1.ts`.
 */
export function isApiVersionCompatible(documentApiVersion: string, knownApiVersion: string): boolean {
  const documentMajor = documentApiVersion.split(".")[0];
  const knownMajor = knownApiVersion.split(".")[0];

  if (!documentMajor || !knownMajor) {
    return false;
  }

  return documentMajor === knownMajor;
}

/**
 * True only for a document this frontend can trust at all: a recognized
 * shape version, a compatible API version, AND a `network` matching this
 * deployment's own Stellar network. The last check is what makes a
 * cross-network document (e.g. one computed for `public` served while this
 * build targets `testnet`) fail closed instead of silently being treated as
 * authoritative — distinct from `deploymentIdentityChanged`, which governs
 * whether a *cached* entry may still be trusted, not whether the document
 * itself is well-formed for this deployment.
 */
export function isCapabilityDocumentTrusted(
  document: CapabilityDocument | null | undefined,
  identity: DeploymentIdentity = currentDeploymentIdentity(),
): document is CapabilityDocument {
  if (!document || typeof document !== "object") {
    return false;
  }
  if (document.documentVersion !== CAPABILITY_DOCUMENT_SHAPE_VERSION) {
    return false;
  }
  if (!isApiVersionCompatible(document.apiVersion, identity.apiSpecVersion)) {
    return false;
  }
  if (document.network !== identity.stellarNetwork) {
    return false;
  }
  return true;
}

/**
 * Fail-closed lookup: returns `false` for any key absent from the
 * document, any document that is `null`/`undefined`, or any document
 * whose shape/API version/network this frontend doesn't recognize or trust
 * (see `isCapabilityDocumentTrusted`).
 */
export function isCapabilityEnabled(
  document: CapabilityDocument | null | undefined,
  key: CapabilityKey,
): boolean {
  if (!isCapabilityDocumentTrusted(document)) {
    return false;
  }

  return document.capabilities[key]?.enabled === true;
}

/**
 * Real capability-document client (#307).
 * ========================================
 * `GET {apiUrl}/capabilities` — a deployment-scoped, versioned capability
 * document. This endpoint is not yet in `earnproof-api.v1.json`; the request
 * shape below is this frontend's forward contract for it, matching the
 * `CapabilityDocument` type and the ETag/conditional-GET convention already
 * used for revalidation in this module's cache layer
 * (`lib/api/capability-cache.ts`). When the OpenAPI spec is regenerated with
 * this route, only the URL/response parsing here should need to change.
 */
export const CAPABILITY_DOCUMENT_PATH = "/capabilities" as const;

export type CapabilityFetchReason = "network" | "malformed" | "unauthorized" | "untrusted";

/** Thrown by `fetchCapabilityDocument` for any outcome other than a trusted 200/304. */
export class CapabilityDocumentError extends Error {
  readonly reason: CapabilityFetchReason;

  constructor(reason: CapabilityFetchReason, message: string) {
    super(message);
    this.name = "CapabilityDocumentError";
    this.reason = reason;
  }
}

/**
 * Runtime shape guard for a parsed response body. Deliberately stricter than
 * the TypeScript type: a malformed or partially-shaped body (missing fields,
 * wrong types, a `capabilities` map whose values aren't `{ enabled: boolean }`)
 * is rejected here rather than reaching `isCapabilityEnabled`, so a bad
 * response can never be cached as if it were valid.
 */
export function isWellFormedCapabilityDocument(value: unknown): value is CapabilityDocument {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CapabilityDocument>;
  if (typeof candidate.documentVersion !== "number") return false;
  if (typeof candidate.apiVersion !== "string") return false;
  if (typeof candidate.network !== "string") return false;
  if (typeof candidate.generatedAt !== "string") return false;
  if (!candidate.capabilities || typeof candidate.capabilities !== "object") return false;

  for (const capabilityState of Object.values(candidate.capabilities)) {
    if (capabilityState === undefined) continue;
    if (
      !capabilityState ||
      typeof capabilityState !== "object" ||
      typeof (capabilityState as CapabilityState).enabled !== "boolean"
    ) {
      return false;
    }
  }
  return true;
}

export type CapabilityFetchResult =
  | { kind: "fresh"; document: CapabilityDocument; etag: string | null }
  | { kind: "not-modified" };

/**
 * Fetches the capability document directly from the backend. Bounded by the
 * same request timeout as every other client in this codebase
 * (`fetchWithTimeout`), and supports conditional revalidation via `etag`:
 * pass the ETag of a previously-fetched document to receive `304 Not
 * Modified` (surfaced as `{ kind: "not-modified" }`) instead of re-sending
 * the body when nothing changed.
 *
 * This function does not read or write the capability cache itself — that
 * composition (deciding when to revalidate, and what to do with a
 * `not-modified` result) lives in `lib/capabilities/capability-context.tsx`,
 * keeping this module a cache-agnostic network client.
 *
 * Fails closed (throws `CapabilityDocumentError`) for:
 * - any network/timeout/abort failure (`"network"`),
 * - a non-2xx/304 response, with 401/403 reported as `"unauthorized"` and
 *   everything else as `"network"`,
 * - a 200 response whose body is not a well-formed capability document
 *   (`"malformed"`),
 * - a well-formed body that is not trusted for this deployment — wrong
 *   shape version, incompatible API version, or wrong network (`"untrusted"`).
 */
export async function fetchCapabilityDocument(
  options: { signal?: AbortSignal; etag?: string | null } = {},
): Promise<CapabilityFetchResult> {
  const { signal, etag } = options;

  let response: Response;
  try {
    response = await fetchWithTimeout(`${appConfig.apiUrl}${CAPABILITY_DOCUMENT_PATH}`, {
      method: "GET",
      signal,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(etag ? { "If-None-Match": etag } : {}),
      },
    });
  } catch (error) {
    recordNetworkFailure();
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new CapabilityDocumentError("network", "Could not reach the capability document endpoint.");
  }

  if (response.status === 304) {
    recordNetworkSuccess();
    return { kind: "not-modified" };
  }

  if (!response.ok) {
    recordNetworkFailure();
    if (response.status === 401 || response.status === 403) {
      throw new CapabilityDocumentError(
        "unauthorized",
        "The capability document endpoint rejected this request.",
      );
    }
    throw new CapabilityDocumentError(
      "network",
      `The capability document endpoint returned ${response.status}.`,
    );
  }

  recordNetworkSuccess();

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CapabilityDocumentError("malformed", "The capability document response was not valid JSON.");
  }

  if (!isWellFormedCapabilityDocument(body)) {
    throw new CapabilityDocumentError("malformed", "The capability document response was malformed.");
  }

  if (!isCapabilityDocumentTrusted(body)) {
    throw new CapabilityDocumentError(
      "untrusted",
      "The capability document was not computed for this deployment (version/network mismatch).",
    );
  }

  return { kind: "fresh", document: body, etag: response.headers.get("etag") };
}

/**
 * Local mock/stub capability provider.
 * =====================================
 * This is a fixture for local development and tests — never reachable in
 * production, where `fetchCapabilityDocument` (above) is the default. It
 * simulates network latency and returns a document shaped exactly like a
 * real one would be, so the gating/caching/UI code around it does not
 * need to change when the real endpoint's response shape evolves.
 *
 * `overrides` exists so tests and local development can simulate partial
 * rollout, downgrades, or incompatible versions without needing a real
 * server.
 */
export async function fetchMockCapabilityDocument(
  overrides: Partial<CapabilityDocument> = {},
): Promise<CapabilityDocument> {
  const identity = currentDeploymentIdentity();

  const document: CapabilityDocument = {
    documentVersion: CAPABILITY_DOCUMENT_SHAPE_VERSION,
    apiVersion: identity.apiSpecVersion,
    network: identity.stellarNetwork,
    generatedAt: new Date().toISOString(),
    capabilities: {
      "activity-log": { enabled: true },
      "embeddable-verification-widget": { enabled: true },
      "recurring-income-proofs": { enabled: true },
      "payment-receipt-proofs": { enabled: true },
      "organization-management": { enabled: true },
    },
    ...overrides,
  };

  return document;
}
