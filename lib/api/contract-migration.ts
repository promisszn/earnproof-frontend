/**
 * Contract successor migration readiness (#266).
 * ==============================================
 *
 * Users need clear route-level guidance when a contract is preparing to
 * move, has been decommissioned, or has been replaced by a successor. This
 * module is the single source of truth for the *client-side* interpretation
 * of that state:
 *
 *   - it validates and normalizes a migration-status document,
 *   - it decides which capabilities (read vs write) remain available, and
 *   - it resolves the only links the UI is ever allowed to follow.
 *
 * IMPORTANT — this is a UX/readiness layer, not a security boundary. The
 * server remains the only thing that may allow or reject a request. Every
 * value here is attacker-controlled (it can be edited in devtools or the
 * module's fail-closed checks can be bypassed entirely), so the checks below
 * exist to keep the *UI honest*, never to grant or withhold real authority.
 *
 * Fail-closed contract:
 *   - An unsupported schema version, an unparseable shape, or a status that
 *     was computed for a different network never enables a write.
 *   - Read-only access is preserved through every migration phase, including
 *     "decommissioned" and "replaced".
 *   - A successor link is only ever offered when the successor is
 *     server-attested as verified, carries a well-formed contract ID, is not
 *     the same as the current contract, and points at a safe HTTPS URL. The
 *     client must never redirect to an unverified successor.
 *
 * There is no `/contracts/migration-status` route in
 * `lib/api/openapi/earnproof-api.v1.json` yet. `fetchContractMigrationStatus`
 * is the production client for this frontend's forward contract for that
 * route (see its own comment below); `fetchMockContractMigrationStatus`
 * remains a fixture for local development/tests only and is never wired as
 * the default in `ContractMigrationStatusBanner`.
 */

import { appConfig } from "@/config/app";
import { fetchWithTimeout } from "@/lib/api/client";
import { recordNetworkFailure, recordNetworkSuccess } from "@/lib/network";

export const CONTRACT_MIGRATION_SCHEMA_VERSION = 1;

export const MIGRATION_PHASES = [
  "stable",
  "preparing",
  "migrating",
  "decommissioned",
  "replaced",
] as const;

export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

/** A Stellar contract ID in StrKey form ("C" + 55 base32 characters). */
export type ContractId = string;

export type SuccessorContract = {
  contractId: ContractId;
  /**
   * Server-attested flag: the backend has independently confirmed this is the
   * intended successor for `currentContractId`. A missing/false value must be
   * treated as unverified.
   */
  verified: boolean;
  label?: string;
  /** Optional deep link into the successor's own migration guide. */
  migrationGuideUrl?: string;
};

export type ContractMigrationStatus = {
  schemaVersion: number;
  network: string;
  currentContractId: ContractId;
  phase: MigrationPhase;
  /** When the phase took effect (ISO-8601), if known. */
  effectiveAt?: string;
  /** When writes were first disabled (ISO-8601), if known. */
  readOnlySince?: string;
  /** Public status/announcement page. Safe to show regardless of successor trust. */
  statusPageUrl?: string;
  successor?: SuccessorContract;
};

export type MigrationCapability = "read" | "write";

export function isMigrationPhase(value: unknown): value is MigrationPhase {
  return (
    typeof value === "string" &&
    (MIGRATION_PHASES as readonly string[]).includes(value)
  );
}

/**
 * Validates that a status document is one this client understands. Anything
 * else (wrong schema version, missing phase, non-string IDs) is "unsupported"
 * and callers must fall back to the fail-closed behavior.
 */
export function isSupportedMigrationStatus(
  status: ContractMigrationStatus | null | undefined,
): status is ContractMigrationStatus {
  if (!status || typeof status !== "object") {
    return false;
  }
  if (status.schemaVersion !== CONTRACT_MIGRATION_SCHEMA_VERSION) {
    return false;
  }
  if (!isMigrationPhase(status.phase)) {
    return false;
  }
  if (typeof status.currentContractId !== "string") {
    return false;
  }
  if (typeof status.network !== "string") {
    return false;
  }
  return true;
}

/**
 * A status computed for a different network can never be trusted to gate this
 * deployment's actions, so it is treated exactly like an unsupported document.
 */
export function isMigrationStatusForCurrentNetwork(
  status: ContractMigrationStatus | null | undefined,
): status is ContractMigrationStatus {
  return isSupportedMigrationStatus(status) && status.network === appConfig.stellarNetwork;
}

const STELLAR_CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

/** True for a well-formed Stellar contract ID (StrKey "C..." form). */
export function isValidContractId(value: unknown): value is ContractId {
  return typeof value === "string" && STELLAR_CONTRACT_ID_PATTERN.test(value);
}

/**
 * Only absolute HTTPS links with no embedded credentials are safe to surface.
 * Rejecting everything else prevents `javascript:`, `data:`, and userinfo
 * smuggling through a status document.
 */
export function isSafeSuccessorUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.username || parsed.password) {
    return false;
  }
  return true;
}

/**
 * A successor is trusted only when it is explicitly server-attested, carries a
 * valid contract ID, and differs from the contract currently in use. Every
 * other combination is treated as unverified.
 */
export function isSuccessorTrusted(
  status: ContractMigrationStatus | null | undefined,
): boolean {
  if (!isSupportedMigrationStatus(status)) {
    return false;
  }
  const successor = status.successor;
  if (!successor) {
    return false;
  }
  if (successor.verified !== true) {
    return false;
  }
  if (!isValidContractId(successor.contractId)) {
    return false;
  }
  if (successor.contractId === status.currentContractId) {
    return false;
  }
  return true;
}

/**
 * The successor migration-guide link, or `null`. This is the ONLY function
 * that may ever produce a link to a successor, and it returns `null` for any
 * unverified successor — so the UI has no way to redirect to one by accident.
 */
export function resolveSuccessorGuideLink(
  status: ContractMigrationStatus | null | undefined,
): { href: string; label: string } | null {
  if (!isSuccessorTrusted(status)) {
    return null;
  }
  const url = status!.successor!.migrationGuideUrl;
  if (!isSafeSuccessorUrl(url)) {
    return null;
  }
  return { href: url, label: "Migration guide" };
}

/**
 * The public status-page link, or `null`. Unlike the successor link this does
 * not depend on successor trust (it is an announcement, not a redirect target).
 */
export function resolveStatusPageLink(
  status: ContractMigrationStatus | null | undefined,
): { href: string; label: string } | null {
  if (!isSupportedMigrationStatus(status)) {
    return null;
  }
  if (!isSafeSuccessorUrl(status.statusPageUrl)) {
    return null;
  }
  return { href: status.statusPageUrl, label: "Migration status" };
}

/** Phases in which the deployment is read-only. */
export function isReadOnlyPhase(phase: MigrationPhase): boolean {
  return phase === "migrating" || phase === "decommissioned" || phase === "replaced";
}

/**
 * Whether a capability is still available under `status`.
 *
 * - `null`/absent status means "no migration information" → nothing is gated.
 * - Reads are preserved through every phase (including decommissioned).
 * - Writes are allowed only while merely "preparing" (users can still finish
 *   work and export it) and are disabled from "migrating" onward.
 * - Unsupported or wrong-network documents fail closed for writes.
 */
export function canPerform(
  status: ContractMigrationStatus | null | undefined,
  capability: MigrationCapability,
): boolean {
  if (!status) {
    return true;
  }
  if (!isMigrationStatusForCurrentNetwork(status)) {
    // Unknown shape/version/network: never unlock a write, keep reads.
    return capability === "read";
  }
  if (status.phase === "stable") {
    return true;
  }
  if (capability === "read") {
    return true;
  }
  return status.phase === "preparing";
}

/**
 * A short, user-facing reason explaining why writes are unavailable, or `null`
 * when writes are allowed (or only reads are being gated).
 */
export function migrationGateReason(
  status: ContractMigrationStatus | null | undefined,
): string | null {
  if (!status || canPerform(status, "write")) {
    return null;
  }
  return "This contract is migrating. Changes are temporarily disabled; read-only access remains available.";
}

export type MigrationBannerTone = "warning" | "danger";

export type MigrationBannerCopy = {
  tone: MigrationBannerTone;
  title: string;
  detail: string;
  readOnly: boolean;
};

/**
 * The banner copy for a status, or `null` when there is nothing to announce
 * (stable phase, absent status, or an unsupported/wrong-network document,
 * which is surfaced elsewhere rather than as a migration announcement).
 */
export function migrationBannerCopy(
  status: ContractMigrationStatus | null | undefined,
): MigrationBannerCopy | null {
  if (!isSupportedMigrationStatus(status)) {
    return null;
  }
  if (!isMigrationStatusForCurrentNetwork(status)) {
    return null;
  }
  const readOnly = isReadOnlyPhase(status.phase);

  switch (status.phase) {
    case "stable":
      return null;
    case "preparing":
      return {
        tone: "warning",
        title: "This contract is preparing to migrate.",
        detail:
          "Writes are still available for now, but finish and export any in-progress work before the migration window.",
        readOnly,
      };
    case "migrating":
      return {
        tone: "warning",
        title: "This contract is migrating.",
        detail:
          "Writes are paused while state is transferred. Read-only access remains available and your data is unchanged.",
        readOnly,
      };
    case "decommissioned":
      return {
        tone: "danger",
        title: "This contract has been decommissioned.",
        detail:
          "Writes are disabled and no longer accepted. Read-only access remains available for existing data.",
        readOnly,
      };
    case "replaced":
      return {
        tone: "danger",
        title: "This contract has been replaced.",
        detail:
          "This deployment is read-only. Continue on the verified successor contract if one is listed below.",
        readOnly,
      };
  }
}

/**
 * How long a successfully-fetched status may be trusted to authorize a
 * successor redirect before it must be re-validated by another fetch. This
 * is deliberately shorter than how long the banner keeps *showing* a status
 * (an unreachable backend must never silently re-enable writes — see
 * `ContractMigrationStatusBanner` — but it also must never let an
 * increasingly-stale cached "replaced" status keep pointing users at a
 * successor without checking back in).
 */
export const MIGRATION_STATUS_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Whether a status fetched at `fetchedAt` is still fresh enough to authorize
 * a successor redirect. A status that has merely gone stale is NOT treated
 * as "no migration information" (which would wrongly re-enable writes) — it
 * is still rendered and still gates writes; it simply stops being eligible
 * to produce a new successor link until revalidated.
 */
export function isMigrationStatusFresh(fetchedAt: number | null, now: number = Date.now()): boolean {
  if (fetchedAt === null) {
    return false;
  }
  const age = now - fetchedAt;
  if (age < 0) {
    // Clock skew/tamper guard, same convention as the capability cache.
    return false;
  }
  return age < MIGRATION_STATUS_MAX_AGE_MS;
}

/**
 * Real migration-status client (#308).
 * =====================================
 * `GET {apiUrl}/contracts/migration-status` — not yet in
 * `earnproof-api.v1.json`; this is this frontend's forward contract for it.
 * Unauthenticated: the banner this feeds is mounted in the root layout,
 * before any session exists, so the endpoint must be reachable without a
 * bearer token.
 */
export const CONTRACT_MIGRATION_STATUS_PATH = "/contracts/migration-status" as const;

export type MigrationStatusFetchReason = "network" | "malformed" | "unauthorized" | "untrusted";

/** Thrown by `fetchContractMigrationStatus` for any outcome other than a trusted 200/304. */
export class MigrationStatusError extends Error {
  readonly reason: MigrationStatusFetchReason;

  constructor(reason: MigrationStatusFetchReason, message: string) {
    super(message);
    this.name = "MigrationStatusError";
    this.reason = reason;
  }
}

/**
 * Runtime shape guard, stricter than `isSupportedMigrationStatus`: it checks
 * every field's type, not just the ones gating decisions, so a response the
 * server shaped incorrectly can never be partially trusted.
 */
export function isWellFormedMigrationStatus(value: unknown): value is ContractMigrationStatus {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ContractMigrationStatus>;
  if (typeof candidate.schemaVersion !== "number") return false;
  if (typeof candidate.network !== "string") return false;
  if (typeof candidate.currentContractId !== "string") return false;
  if (!isMigrationPhase(candidate.phase)) return false;
  if (candidate.effectiveAt !== undefined && typeof candidate.effectiveAt !== "string") return false;
  if (candidate.readOnlySince !== undefined && typeof candidate.readOnlySince !== "string") return false;
  if (candidate.statusPageUrl !== undefined && typeof candidate.statusPageUrl !== "string") return false;
  if (candidate.successor !== undefined) {
    if (!candidate.successor || typeof candidate.successor !== "object") return false;
    const successor = candidate.successor as Partial<SuccessorContract>;
    if (typeof successor.contractId !== "string") return false;
    if (typeof successor.verified !== "boolean") return false;
    if (successor.label !== undefined && typeof successor.label !== "string") return false;
    if (successor.migrationGuideUrl !== undefined && typeof successor.migrationGuideUrl !== "string") {
      return false;
    }
  }
  return true;
}

export type MigrationStatusFetchResult =
  | { kind: "fresh"; status: ContractMigrationStatus; etag: string | null }
  | { kind: "not-modified" };

/**
 * Fetches the migration status directly from the backend. Bounded by the
 * same request timeout as every other client in this codebase, cancellable
 * via `AbortSignal`, and supports conditional revalidation via `etag`
 * (mirrors `fetchCapabilityDocument` in `lib/api/capabilities.ts`).
 *
 * Fails closed (throws `MigrationStatusError`) for any network failure, a
 * non-2xx/304 response, a malformed body, or a well-formed body computed for
 * a different network than this deployment's (`"untrusted"`) — the same
 * fail-closed reasons `fetchCapabilityDocument` uses, for consistency.
 */
export async function fetchContractMigrationStatus(
  options: { signal?: AbortSignal; etag?: string | null } = {},
): Promise<MigrationStatusFetchResult> {
  const { signal, etag } = options;

  let response: Response;
  try {
    response = await fetchWithTimeout(`${appConfig.apiUrl}${CONTRACT_MIGRATION_STATUS_PATH}`, {
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
    throw new MigrationStatusError("network", "Could not reach the migration status endpoint.");
  }

  if (response.status === 304) {
    recordNetworkSuccess();
    return { kind: "not-modified" };
  }

  if (!response.ok) {
    recordNetworkFailure();
    if (response.status === 401 || response.status === 403) {
      throw new MigrationStatusError("unauthorized", "The migration status endpoint rejected this request.");
    }
    throw new MigrationStatusError("network", `The migration status endpoint returned ${response.status}.`);
  }

  recordNetworkSuccess();

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new MigrationStatusError("malformed", "The migration status response was not valid JSON.");
  }

  if (!isWellFormedMigrationStatus(body)) {
    throw new MigrationStatusError("malformed", "The migration status response was malformed.");
  }

  if (!isMigrationStatusForCurrentNetwork(body)) {
    throw new MigrationStatusError(
      "untrusted",
      "The migration status was not computed for this deployment's network.",
    );
  }

  return { kind: "fresh", status: body, etag: response.headers.get("etag") };
}

/**
 * Fixture/forward-contract provider for the (not-yet-existing) migration
 * endpoint. Returns a "stable" status by default so the banner stays silent in
 * configurations where no migration is in progress. Tests and local
 * development pass `overrides` to simulate preparing/migrating/replaced states.
 *
 * Never wired as the production default — see `fetchContractMigrationStatus`
 * above and `ContractMigrationStatusBanner`'s default fetcher.
 */
export async function fetchMockContractMigrationStatus(
  overrides: Partial<ContractMigrationStatus> = {},
): Promise<ContractMigrationStatus> {
  return {
    schemaVersion: CONTRACT_MIGRATION_SCHEMA_VERSION,
    network: appConfig.stellarNetwork,
    currentContractId: "",
    phase: "stable",
    ...overrides,
  };
}
