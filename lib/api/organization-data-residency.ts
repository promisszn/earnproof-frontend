/**
 * Organization data-residency policy controls (#277, connected to the
 * backend in #310).
 * =========================================================================
 *
 * Organizations need to review (and change) the allowed storage and processing
 * regions for regulated data classes and background jobs.
 *
 * Three guarantees drive every function here:
 *
 *   1. **No unsupported selection.** A region may only hold a data class the
 *      region's capability document permits, and never a deprecated region.
 *      Enforced by `validateResidencyPolicy`/`applyResidencyUpdate`, which run
 *      as a client-side pre-check before the server (the sole authority) is
 *      ever asked to accept a write.
 *   2. **No compliance until it is real.** The UI must not imply a policy is
 *      in force until the server has validated it *and* every data class has
 *      finished migrating. `computeComplianceStatus()` therefore reports
 *      `compliant` only when both are true, and otherwise says exactly what is
 *      still outstanding. An incomplete migration also blocks changing that
 *      data class's placement at all (`computeMigrationBlockers`).
 *   3. **Policy state is tenant- and deployment-scoped.** The in-memory cache
 *      below (`getCachedDataResidencyPolicy`/`setCachedDataResidencyPolicy`/
 *      `invalidateDataResidencyPolicyCache`) is keyed by *both*
 *      `organizationId` and the current deployment identity
 *      (`currentDeploymentIdentity()` from `lib/api/capabilities.ts`), so
 *      switching the active organization or the deployment (API URL,
 *      network, or spec version) can never serve another tenant's or
 *      another environment's cached policy.
 *
 * As with the other policy modules, this is a client-side UX/readiness layer.
 * The server remains the only authority for what a region may store.
 */

import {
  currentDeploymentIdentity,
  deploymentIdentityChanged,
  type DeploymentIdentity,
} from "@/lib/api/capabilities";
import { ApiConflictError, apiClient, bearer, retryMutation, retryRead } from "@/lib/api/client";

export const DATA_RESIDENCY_POLICY_SCHEMA_VERSION = 1;

export const PROCESSING_REGIONS = [
  "us-east",
  "us-west",
  "eu-west",
  "eu-central",
  "ap-southeast",
  "ap-northeast",
] as const;

export type ProcessingRegion = (typeof PROCESSING_REGIONS)[number];

export const DATA_CLASSES = [
  "proofs",
  "personal-data",
  "audit-logs",
  "payment-records",
  "backups",
] as const;

export type DataClass = (typeof DATA_CLASSES)[number];

export function isProcessingRegion(value: unknown): value is ProcessingRegion {
  return typeof value === "string" && (PROCESSING_REGIONS as readonly string[]).includes(value);
}

export function isDataClass(value: unknown): value is DataClass {
  return typeof value === "string" && (DATA_CLASSES as readonly string[]).includes(value);
}

/** Which data classes a region is permitted to store and process. */
export type RegionCapability = {
  region: ProcessingRegion;
  supportedDataClasses: DataClass[];
  /** Deprecated regions may hold existing data but accept no new placements. */
  deprecated?: boolean;
};

export const REGION_CAPABILITIES: readonly RegionCapability[] = [
  { region: "us-east", supportedDataClasses: ["proofs", "personal-data", "audit-logs", "payment-records", "backups"] },
  { region: "us-west", supportedDataClasses: ["proofs", "audit-logs", "backups"] },
  { region: "eu-west", supportedDataClasses: ["proofs", "personal-data", "audit-logs", "payment-records", "backups"] },
  { region: "eu-central", supportedDataClasses: ["proofs", "personal-data", "audit-logs"] },
  { region: "ap-southeast", supportedDataClasses: ["proofs", "audit-logs"] },
  { region: "ap-northeast", supportedDataClasses: ["proofs", "audit-logs"], deprecated: true },
];

export function getRegionCapability(region: ProcessingRegion): RegionCapability | undefined {
  return REGION_CAPABILITIES.find((capability) => capability.region === region);
}

/**
 * Whether `region` may store/process `dataClass`. Deprecated regions and
 * regions whose capability document omits the class are both unsupported.
 */
export function isRegionSupportedForClass(
  region: ProcessingRegion,
  dataClass: DataClass,
): boolean {
  const capability = getRegionCapability(region);
  if (!capability || capability.deprecated) {
    return false;
  }
  return capability.supportedDataClasses.includes(dataClass);
}

export type MigrationState = "not-started" | "in-progress" | "complete";

export type DataResidencyPolicy = {
  schemaVersion: number;
  policyVersion: number;
  updatedAt: string;
  /** Allowed regions per data class. */
  placements: Record<DataClass, ProcessingRegion[]>;
  /** Region where background jobs run. */
  backgroundJobRegion: ProcessingRegion | null;
  /** Server-reported migration progress per data class. */
  migration: Record<DataClass, MigrationState>;
  /** Whether the server has validated (and begun applying) this version. */
  serverValidation: "pending" | "accepted" | "rejected";
  rollout: {
    status: "not-started" | "in-progress" | "complete";
    startedAt?: string;
  };
};

export type ResidencyValidationSeverity = "error" | "warning";

export type ResidencyValidationIssue = {
  field: string;
  message: string;
  severity: ResidencyValidationSeverity;
};

export function validateResidencyPolicy(
  policy: DataResidencyPolicy,
): ResidencyValidationIssue[] {
  const issues: ResidencyValidationIssue[] = [];

  if (policy.schemaVersion !== DATA_RESIDENCY_POLICY_SCHEMA_VERSION) {
    return [
      {
        field: "schemaVersion",
        message: "This residency policy version is not supported by the client.",
        severity: "error",
      },
    ];
  }

  for (const dataClass of DATA_CLASSES) {
    const regions = policy.placements?.[dataClass];
    if (!Array.isArray(regions) || regions.length === 0) {
      issues.push({
        field: `placements.${dataClass}`,
        message: `Select at least one region for ${dataClass}.`,
        severity: "error",
      });
      continue;
    }
    for (const region of regions) {
      if (!isProcessingRegion(region)) {
        issues.push({
          field: `placements.${dataClass}`,
          message: `Unknown region "${String(region)}" for ${dataClass}.`,
          severity: "error",
        });
        continue;
      }
      if (!isRegionSupportedForClass(region, dataClass)) {
        issues.push({
          field: `placements.${dataClass}`,
          message: `${region} cannot store ${dataClass} in this environment.`,
          severity: "error",
        });
      }
    }
  }

  if (policy.backgroundJobRegion === null) {
    issues.push({
      field: "backgroundJobRegion",
      message: "Choose a region for background jobs.",
      severity: "error",
    });
  } else if (!isProcessingRegion(policy.backgroundJobRegion)) {
    issues.push({
      field: "backgroundJobRegion",
      message: `Unknown region "${String(policy.backgroundJobRegion)}".`,
      severity: "error",
    });
  } else if (getRegionCapability(policy.backgroundJobRegion)?.deprecated) {
    issues.push({
      field: "backgroundJobRegion",
      message: "Background jobs cannot run in a deprecated region.",
      severity: "error",
    });
  }

  return issues;
}

export function isResidencyPolicyValid(policy: DataResidencyPolicy): boolean {
  return !validateResidencyPolicy(policy).some((issue) => issue.severity === "error");
}

export type ComplianceStatus = {
  status:
    | "compliant"
    | "awaiting-server-validation"
    | "migration-incomplete"
    | "invalid";
  /** Plain-language reasons the policy is not yet compliant. */
  reasons: string[];
};

/**
 * Compliance is only reported once the server has accepted the policy *and*
 * every data class has finished migrating and the rollout is complete.
 * Anything short of that is surfaced explicitly rather than assumed.
 */
export function computeComplianceStatus(policy: DataResidencyPolicy): ComplianceStatus {
  const issues = validateResidencyPolicy(policy).filter(
    (issue) => issue.severity === "error",
  );
  if (issues.length > 0) {
    return {
      status: "invalid",
      reasons: issues.map((issue) => issue.message),
    };
  }

  if (policy.serverValidation !== "accepted") {
    return {
      status: "awaiting-server-validation",
      reasons: [
        policy.serverValidation === "rejected"
          ? "The server rejected this residency policy."
          : "This residency policy is pending server validation.",
      ],
    };
  }

  const reasons: string[] = [];
  for (const dataClass of DATA_CLASSES) {
    if (policy.migration[dataClass] !== "complete") {
      reasons.push(`${dataClass} migration is ${policy.migration[dataClass]}.`);
    }
  }
  if (policy.rollout.status !== "complete") {
    reasons.push(`Rollout is ${policy.rollout.status}.`);
  }

  if (reasons.length > 0) {
    return { status: "migration-incomplete", reasons };
  }

  return { status: "compliant", reasons: [] };
}

export type MigrationBlocker = {
  dataClass: DataClass;
  region: ProcessingRegion;
  message: string;
};

/**
 * Changes that cannot be applied yet because the data has not finished
 * migrating out of the affected regions. Moving a class's placement (or
 * dropping a region) while its migration is incomplete is blocked.
 */
export function computeMigrationBlockers(
  current: DataResidencyPolicy,
  next: DataResidencyPolicy,
): MigrationBlocker[] {
  const blockers: MigrationBlocker[] = [];

  for (const dataClass of DATA_CLASSES) {
    const before = current.placements[dataClass] ?? [];
    const after = next.placements[dataClass] ?? [];
    const changed =
      before.length !== after.length || before.some((region) => !after.includes(region));

    if (!changed) {
      continue;
    }

    if (current.migration[dataClass] !== "complete") {
      blockers.push({
        dataClass,
        region: (before[0] ?? after[0]) as ProcessingRegion,
        message: `Cannot change ${dataClass} placement until its migration completes.`,
      });
    }
  }

  return blockers;
}

export type ResidencyImpactSummary = {
  addedPlacements: Array<{ dataClass: DataClass; region: ProcessingRegion }>;
  removedPlacements: Array<{ dataClass: DataClass; region: ProcessingRegion }>;
  backgroundJobRegionChange: {
    from: ProcessingRegion | null;
    to: ProcessingRegion | null;
  };
  blockers: MigrationBlocker[];
  notes: string[];
};

export function summarizeResidencyImpact(
  current: DataResidencyPolicy,
  next: DataResidencyPolicy,
): ResidencyImpactSummary {
  const addedPlacements: Array<{ dataClass: DataClass; region: ProcessingRegion }> = [];
  const removedPlacements: Array<{ dataClass: DataClass; region: ProcessingRegion }> = [];

  for (const dataClass of DATA_CLASSES) {
    const before = current.placements[dataClass] ?? [];
    const after = next.placements[dataClass] ?? [];
    for (const region of after) {
      if (!before.includes(region)) {
        addedPlacements.push({ dataClass, region });
      }
    }
    for (const region of before) {
      if (!after.includes(region)) {
        removedPlacements.push({ dataClass, region });
      }
    }
  }

  const blockers = computeMigrationBlockers(current, next);
  const notes: string[] = [];
  for (const { dataClass, region } of addedPlacements) {
    notes.push(`${region} will additionally store ${dataClass}.`);
  }
  for (const { dataClass, region } of removedPlacements) {
    notes.push(`${region} will no longer store ${dataClass}.`);
  }
  if (current.backgroundJobRegion !== next.backgroundJobRegion) {
    notes.push(
      `Background jobs move from ${current.backgroundJobRegion ?? "none"} to ${next.backgroundJobRegion ?? "none"}.`,
    );
  }
  if (notes.length === 0) {
    notes.push("No effective change.");
  }

  return {
    addedPlacements,
    removedPlacements,
    backgroundJobRegionChange: {
      from: current.backgroundJobRegion,
      to: next.backgroundJobRegion,
    },
    blockers,
    notes,
  };
}

export type ResidencyFieldChange = { field: string; before: string; after: string };

export function compareResidencyVersions(
  previous: DataResidencyPolicy,
  next: DataResidencyPolicy,
): ResidencyFieldChange[] {
  const changes: ResidencyFieldChange[] = [];

  if (previous.policyVersion !== next.policyVersion) {
    changes.push({
      field: "policyVersion",
      before: String(previous.policyVersion),
      after: String(next.policyVersion),
    });
  }
  for (const dataClass of DATA_CLASSES) {
    const before = [...(previous.placements[dataClass] ?? [])].sort().join(", ");
    const after = [...(next.placements[dataClass] ?? [])].sort().join(", ");
    if (before !== after) {
      changes.push({ field: `placements.${dataClass}`, before, after });
    }
  }
  if (previous.backgroundJobRegion !== next.backgroundJobRegion) {
    changes.push({
      field: "backgroundJobRegion",
      before: String(previous.backgroundJobRegion),
      after: String(next.backgroundJobRegion),
    });
  }

  return changes;
}

export type ResidencyUpdateOutcome =
  | { ok: true; policy: DataResidencyPolicy }
  | {
      ok: false;
      reason: "stale" | "conflict" | "invalid" | "blocked";
      message: string;
      issues?: ResidencyValidationIssue[];
    };

/**
 * Applies a draft residency policy on top of the latest known server version.
 * Fails closed on stale/conflicting versions, unsupported region selections,
 * or when an incomplete migration blocks the change.
 */
export function applyResidencyUpdate(args: {
  current: DataResidencyPolicy;
  draft: DataResidencyPolicy;
  expectedVersion: number;
  now?: Date;
}): ResidencyUpdateOutcome {
  const { current, draft, expectedVersion, now = new Date() } = args;

  if (current.schemaVersion !== DATA_RESIDENCY_POLICY_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "stale",
      message: "The server policy uses a newer format. Reload before editing.",
    };
  }

  if (expectedVersion < current.policyVersion) {
    return {
      ok: false,
      reason: "stale",
      message:
        "This residency policy changed since you loaded it. Reload before saving again.",
    };
  }

  if (expectedVersion > current.policyVersion) {
    return {
      ok: false,
      reason: "conflict",
      message: "The policy version does not match the server. Reload before saving.",
    };
  }

  const issues = validateResidencyPolicy(draft);
  if (issues.some((issue) => issue.severity === "error")) {
    return {
      ok: false,
      reason: "invalid",
      message: "This policy selects a region that cannot store the chosen data.",
      issues,
    };
  }

  const blockers = computeMigrationBlockers(current, draft);
  if (blockers.length > 0) {
    return {
      ok: false,
      reason: "blocked",
      message: blockers.map((blocker) => blocker.message).join(" "),
    };
  }

  return {
    ok: true,
    policy: {
      ...draft,
      schemaVersion: DATA_RESIDENCY_POLICY_SCHEMA_VERSION,
      policyVersion: current.policyVersion + 1,
      updatedAt: now.toISOString(),
      // A saved change must be re-validated by the server before it is in force.
      serverValidation: "pending",
      rollout: { ...draft.rollout, status: "not-started" },
    },
  };
}

export function defaultDataResidencyPolicy(): DataResidencyPolicy {
  return {
    schemaVersion: DATA_RESIDENCY_POLICY_SCHEMA_VERSION,
    policyVersion: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    placements: {
      proofs: ["us-east", "eu-west"],
      "personal-data": ["us-east", "eu-west"],
      "audit-logs": ["us-east"],
      "payment-records": ["us-east"],
      backups: ["us-west"],
    },
    backgroundJobRegion: "us-east",
    migration: {
      proofs: "complete",
      "personal-data": "complete",
      "audit-logs": "complete",
      "payment-records": "complete",
      backups: "complete",
    },
    serverValidation: "accepted",
    rollout: { status: "complete" },
  };
}

export type DataResidencyPolicyResponse = {
  policy: DataResidencyPolicy;
  history: DataResidencyPolicy[];
};

/**
 * Real data-residency-policy client (#310).
 * ============================================
 * Authenticated read/validate/preview/update/history/rollout-status calls
 * against `/organizations/{organizationId}/data-residency-policy`. Not yet
 * in `lib/api/openapi/earnproof-api.v1.json`; this is this frontend's
 * forward contract for it, reusing the same `apiClient`/`bearer`/
 * `retryRead`/`retryMutation` conventions as `lib/api/organizations.ts` and
 * `lib/api/organization-role-approval-policy.ts`.
 */
function dataResidencyPolicyPath(organizationId: string): string {
  return `/organizations/${encodeURIComponent(organizationId)}/data-residency-policy`;
}

/** Runtime shape guard for a parsed server response. */
export function isWellFormedDataResidencyPolicy(value: unknown): value is DataResidencyPolicy {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DataResidencyPolicy>;
  if (candidate.schemaVersion !== DATA_RESIDENCY_POLICY_SCHEMA_VERSION) return false;
  if (!Number.isInteger(candidate.policyVersion)) return false;
  if (typeof candidate.updatedAt !== "string") return false;
  if (!candidate.placements || typeof candidate.placements !== "object") return false;
  for (const dataClass of DATA_CLASSES) {
    const regions = candidate.placements[dataClass];
    if (regions !== undefined && !Array.isArray(regions)) return false;
  }
  if (candidate.backgroundJobRegion !== null && !isProcessingRegion(candidate.backgroundJobRegion)) {
    return false;
  }
  if (!candidate.migration || typeof candidate.migration !== "object") return false;
  if (!["pending", "accepted", "rejected"].includes(candidate.serverValidation as string)) return false;
  if (!candidate.rollout || typeof candidate.rollout !== "object") return false;
  if (!["not-started", "in-progress", "complete"].includes(candidate.rollout.status)) return false;
  return true;
}

/**
 * Tenant- and deployment-scoped in-memory cache. Bounded (one entry per
 * organization at a time — writing a new entry for an organization replaces
 * its previous one) and never persisted, so there is nothing to clean up on
 * sign-out; a page reload starts cold.
 */
type DataResidencyCacheEntry = {
  response: DataResidencyPolicyResponse;
  identity: DeploymentIdentity;
  cachedAt: number;
};

export const DATA_RESIDENCY_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

const dataResidencyCache = new Map<string, DataResidencyCacheEntry>();

export function getCachedDataResidencyPolicy(
  organizationId: string,
  now: number = Date.now(),
): DataResidencyPolicyResponse | null {
  const entry = dataResidencyCache.get(organizationId);
  if (!entry) return null;

  // Cross-environment fail-closed: a cached entry from a different
  // deployment (API URL, network, or spec version) is never served, even
  // if it's still within its TTL — an environment switch invalidates it.
  if (deploymentIdentityChanged(entry.identity, currentDeploymentIdentity())) {
    dataResidencyCache.delete(organizationId);
    return null;
  }

  const age = now - entry.cachedAt;
  if (age < 0 || age >= DATA_RESIDENCY_CACHE_TTL_MS) {
    return null;
  }
  return entry.response;
}

export function setCachedDataResidencyPolicy(
  organizationId: string,
  response: DataResidencyPolicyResponse,
  now: number = Date.now(),
): void {
  dataResidencyCache.set(organizationId, {
    response,
    identity: currentDeploymentIdentity(),
    cachedAt: now,
  });
}

/** Invalidates one organization's cache entry, or every entry when called with no argument (e.g. on sign-out). */
export function invalidateDataResidencyPolicyCache(organizationId?: string): void {
  if (organizationId === undefined) {
    dataResidencyCache.clear();
    return;
  }
  dataResidencyCache.delete(organizationId);
}

/**
 * Reads the current policy and history, preferring the tenant-scoped cache
 * when it is fresh for this exact organization and deployment. A cache hit
 * never makes a network call.
 */
export async function fetchDataResidencyPolicy(
  token: string,
  organizationId: string,
  signal: AbortSignal,
  options: { skipCache?: boolean } = {},
): Promise<DataResidencyPolicyResponse> {
  if (!options.skipCache) {
    const cached = getCachedDataResidencyPolicy(organizationId);
    if (cached) {
      return cached;
    }
  }

  return retryRead(async (innerSignal) => {
    const [policy, history] = await Promise.all([
      apiClient<unknown>({
        path: dataResidencyPolicyPath(organizationId),
        method: "GET",
        headers: bearer(token),
        signal: innerSignal,
      }),
      apiClient<unknown>({
        path: `${dataResidencyPolicyPath(organizationId)}/history`,
        method: "GET",
        headers: bearer(token),
        signal: innerSignal,
      }),
    ]);

    if (!isWellFormedDataResidencyPolicy(policy)) {
      throw new Error("The data residency policy response was malformed.");
    }
    if (!Array.isArray(history)) {
      throw new Error("The data residency policy history response was malformed.");
    }

    const response: DataResidencyPolicyResponse = {
      policy,
      history: history.filter(isWellFormedDataResidencyPolicy),
    };
    setCachedDataResidencyPolicy(organizationId, response);
    return response;
  }, signal);
}

export type DataResidencyPreview = {
  issues: ResidencyValidationIssue[];
  blockers: MigrationBlocker[];
  impact: ResidencyImpactSummary;
};

/** Server-side preview of applying `draft` on top of `current`. Never mutates anything. */
export async function previewResidencyPolicyUpdate(
  token: string,
  organizationId: string,
  current: DataResidencyPolicy,
  draft: DataResidencyPolicy,
  signal: AbortSignal,
): Promise<DataResidencyPreview> {
  return retryRead(async (innerSignal) => {
    const response = await apiClient<{
      issues?: ResidencyValidationIssue[];
      blockers?: MigrationBlocker[];
    }>({
      path: `${dataResidencyPolicyPath(organizationId)}/preview`,
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ draft, expectedVersion: current.policyVersion }),
      signal: innerSignal,
    });

    const serverIssues = Array.isArray(response?.issues) ? response.issues : [];
    const serverBlockers = Array.isArray(response?.blockers) ? response.blockers : [];
    return {
      issues: [...validateResidencyPolicy(draft), ...serverIssues],
      blockers: [...computeMigrationBlockers(current, draft), ...serverBlockers],
      impact: summarizeResidencyImpact(current, draft),
    };
  }, signal);
}

/**
 * Submits `draft`, conditional on the server's version still matching
 * `expectedVersion` (`If-Match`). A stale write is rejected as
 * `409 Conflict`, surfaced by `apiClient` as `ApiConflictError`. On success,
 * invalidates this organization's cache (the response itself is the new
 * truth; the next read will repopulate it) and returns the server's result.
 */
export async function updateDataResidencyPolicy(
  token: string,
  organizationId: string,
  draft: DataResidencyPolicy,
  expectedVersion: number,
  signal: AbortSignal,
): Promise<DataResidencyPolicy> {
  return retryMutation(async (innerSignal) => {
    const updated = await apiClient<unknown>({
      path: dataResidencyPolicyPath(organizationId),
      method: "PUT",
      headers: { ...bearer(token), "If-Match": String(expectedVersion) },
      body: JSON.stringify(draft),
      signal: innerSignal,
    });
    if (!isWellFormedDataResidencyPolicy(updated)) {
      throw new Error("The data residency policy response was malformed after update.");
    }
    invalidateDataResidencyPolicyCache(organizationId);
    return updated;
  }, signal);
}

export type DataResidencyRolloutStatus = {
  migration: Record<DataClass, MigrationState>;
  rollout: DataResidencyPolicy["rollout"];
  serverValidation: DataResidencyPolicy["serverValidation"];
};

/**
 * Polls just the rollout/migration progress for `organizationId`, without
 * re-fetching (or trusting a cached copy of) the full policy — a long-running
 * region migration's progress should always be current when checked.
 */
export async function fetchDataResidencyRolloutStatus(
  token: string,
  organizationId: string,
  signal: AbortSignal,
): Promise<DataResidencyRolloutStatus> {
  return retryRead(async (innerSignal) => {
    const response = await apiClient<unknown>({
      path: `${dataResidencyPolicyPath(organizationId)}/rollout-status`,
      method: "GET",
      headers: bearer(token),
      signal: innerSignal,
    });

    if (!response || typeof response !== "object") {
      throw new Error("The rollout status response was malformed.");
    }
    const candidate = response as Partial<DataResidencyRolloutStatus>;
    if (!candidate.migration || typeof candidate.migration !== "object") {
      throw new Error("The rollout status response was malformed.");
    }
    if (!candidate.rollout || !["not-started", "in-progress", "complete"].includes(candidate.rollout.status)) {
      throw new Error("The rollout status response was malformed.");
    }
    if (!["pending", "accepted", "rejected"].includes(candidate.serverValidation as string)) {
      throw new Error("The rollout status response was malformed.");
    }
    return candidate as DataResidencyRolloutStatus;
  }, signal);
}

/** True for the one error shape `updateDataResidencyPolicy` can throw that means "stale write". */
export function isDataResidencyPolicyConflict(error: unknown): error is ApiConflictError {
  return error instanceof ApiConflictError;
}

/**
 * Fixture/forward-contract provider for local development and tests only —
 * never wired as the default in `DataResidencyPolicyPanel`.
 */
export async function fetchMockDataResidencyPolicy(
  overrides: Partial<DataResidencyPolicy> = {},
  history: DataResidencyPolicy[] = [],
): Promise<DataResidencyPolicyResponse> {
  return {
    policy: { ...defaultDataResidencyPolicy(), ...overrides },
    history,
  };
}

export const RESIDENCY_MANAGEMENT_ROLES = ["OWNER", "ADMIN"] as const;

export type ResidencyViewerRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

/** UX gating only; the server remains the authority. */
export function canManageDataResidencyPolicy(
  role: ResidencyViewerRole | null | undefined,
): boolean {
  return (
    role !== null &&
    role !== undefined &&
    (RESIDENCY_MANAGEMENT_ROLES as readonly string[]).includes(role)
  );
}

/**
 * Builds a rollback draft from an older version: the older version's settings
 * are restored but versioned and re-validated as a brand-new change, so a
 * rollback can never resurrect an unsupported selection.
 */
export function buildResidencyRollbackDraft(
  current: DataResidencyPolicy,
  target: DataResidencyPolicy,
): DataResidencyPolicy {
  return {
    ...target,
    schemaVersion: DATA_RESIDENCY_POLICY_SCHEMA_VERSION,
    policyVersion: current.policyVersion,
    updatedAt: current.updatedAt,
  };
}
