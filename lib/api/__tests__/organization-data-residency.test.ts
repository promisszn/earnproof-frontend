import { ApiConflictError } from "@/lib/api/client";
import {
  DATA_RESIDENCY_CACHE_TTL_MS,
  DATA_RESIDENCY_POLICY_SCHEMA_VERSION,
  applyResidencyUpdate,
  compareResidencyVersions,
  computeComplianceStatus,
  computeMigrationBlockers,
  defaultDataResidencyPolicy,
  fetchDataResidencyPolicy,
  fetchDataResidencyRolloutStatus,
  fetchMockDataResidencyPolicy,
  getCachedDataResidencyPolicy,
  getRegionCapability,
  invalidateDataResidencyPolicyCache,
  isDataResidencyPolicyConflict,
  isRegionSupportedForClass,
  isResidencyPolicyValid,
  isWellFormedDataResidencyPolicy,
  previewResidencyPolicyUpdate,
  setCachedDataResidencyPolicy,
  summarizeResidencyImpact,
  updateDataResidencyPolicy,
  validateResidencyPolicy,
  type DataResidencyPolicy,
} from "../organization-data-residency";

function policy(overrides: Partial<DataResidencyPolicy> = {}): DataResidencyPolicy {
  return { ...defaultDataResidencyPolicy(), ...overrides };
}

describe("data-residency: region capability checks", () => {
  it("exposes a capability document per region", () => {
    expect(getRegionCapability("eu-west")?.supportedDataClasses).toContain("payment-records");
  });

  it("rejects a region that does not support the data class", () => {
    // us-west supports proofs/audit-logs/backups, but not personal-data.
    expect(isRegionSupportedForClass("us-west", "personal-data")).toBe(false);
    expect(isRegionSupportedForClass("us-west", "proofs")).toBe(true);
  });

  it("rejects deprecated regions even for a supported class", () => {
    // ap-northeast supports proofs but is deprecated.
    expect(isRegionSupportedForClass("ap-northeast", "proofs")).toBe(false);
  });
});

describe("data-residency: validation", () => {
  it("accepts the default policy", () => {
    expect(validateResidencyPolicy(policy())).toEqual([]);
    expect(isResidencyPolicyValid(policy())).toBe(true);
  });

  it("fails closed for an unsupported schema version", () => {
    const issues = validateResidencyPolicy(policy({ schemaVersion: 999 }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: "schemaVersion", severity: "error" });
  });

  it("requires at least one region per data class", () => {
    const invalid = policy({ placements: { ...policy().placements, backups: [] } });
    expect(isResidencyPolicyValid(invalid)).toBe(false);
    expect(
      validateResidencyPolicy(invalid).some((issue) => issue.field === "placements.backups"),
    ).toBe(true);
  });

  it("rejects selecting an unsupported region for a class", () => {
    const invalid = policy({
      placements: { ...policy().placements, "personal-data": ["us-west"] },
    });
    expect(
      validateResidencyPolicy(invalid).some((issue) =>
        /cannot store personal-data/.test(issue.message),
      ),
    ).toBe(true);
  });

  it("rejects a missing or deprecated background-job region", () => {
    expect(isResidencyPolicyValid(policy({ backgroundJobRegion: null }))).toBe(false);
    expect(isResidencyPolicyValid(policy({ backgroundJobRegion: "ap-northeast" }))).toBe(false);
  });
});

describe("data-residency: compliance status", () => {
  it("reports compliant only when validated, migrated and rolled out", () => {
    expect(computeComplianceStatus(policy()).status).toBe("compliant");
  });

  it("does not imply compliance before server validation", () => {
    const status = computeComplianceStatus(policy({ serverValidation: "pending" }));
    expect(status.status).toBe("awaiting-server-validation");
  });

  it("does not imply compliance while a migration is incomplete", () => {
    const status = computeComplianceStatus(
      policy({ migration: { ...policy().migration, proofs: "in-progress" } }),
    );
    expect(status.status).toBe("migration-incomplete");
    expect(status.reasons.join(" ")).toMatch(/proofs/);
  });

  it("does not imply compliance while the rollout is incomplete", () => {
    const status = computeComplianceStatus(
      policy({ rollout: { status: "in-progress" } }),
    );
    expect(status.status).toBe("migration-incomplete");
    expect(status.reasons.join(" ")).toMatch(/rollout/i);
  });

  it("reports invalid selections as invalid, not compliant", () => {
    const status = computeComplianceStatus(
      policy({ placements: { ...policy().placements, "personal-data": ["us-west"] } }),
    );
    expect(status.status).toBe("invalid");
  });
});

describe("data-residency: migration blockers", () => {
  it("blocks a placement change while the class is still migrating", () => {
    const current = policy({ migration: { ...policy().migration, proofs: "in-progress" } });
    const next = policy({
      ...current,
      placements: { ...current.placements, proofs: ["us-east"] },
    });
    const blockers = computeMigrationBlockers(current, next);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].dataClass).toBe("proofs");
  });

  it("allows a placement change once migration is complete", () => {
    const current = policy();
    const next = policy({
      ...current,
      placements: { ...current.placements, proofs: ["us-east"] },
    });
    expect(computeMigrationBlockers(current, next)).toEqual([]);
  });
});

describe("data-residency: fail-closed apply", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");

  it("applies a valid change, increments the version and re-pends validation", () => {
    const current = policy({ policyVersion: 2 });
    const draft = policy({
      policyVersion: 2,
      placements: { ...current.placements, proofs: ["us-east", "eu-west", "ap-southeast"] },
    });
    const outcome = applyResidencyUpdate({ current, draft, expectedVersion: 2, now });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.policy.policyVersion).toBe(3);
      expect(outcome.policy.serverValidation).toBe("pending");
      expect(outcome.policy.rollout.status).toBe("not-started");
    }
  });

  it("fails closed on a stale/replayed version", () => {
    const outcome = applyResidencyUpdate({
      current: policy({ policyVersion: 5 }),
      draft: policy({ policyVersion: 4 }),
      expectedVersion: 4,
      now,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("stale");
    }
  });

  it("fails closed on a forward version conflict", () => {
    const outcome = applyResidencyUpdate({
      current: policy({ policyVersion: 1 }),
      draft: policy({ policyVersion: 2 }),
      expectedVersion: 2,
      now,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("conflict");
    }
  });

  it("rejects an unsupported region selection as invalid", () => {
    const current = policy();
    const outcome = applyResidencyUpdate({
      current,
      draft: policy({ placements: { ...current.placements, "personal-data": ["us-west"] } }),
      expectedVersion: current.policyVersion,
      now,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("invalid");
    }
  });

  it("blocks a change while a migration is incomplete", () => {
    const current = policy({
      migration: { ...policy().migration, "audit-logs": "in-progress" },
    });
    const outcome = applyResidencyUpdate({
      current,
      draft: policy({
        ...current,
        placements: { ...current.placements, "audit-logs": ["us-east", "eu-central"] },
      }),
      expectedVersion: current.policyVersion,
      now,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("blocked");
    }
  });
});

describe("data-residency: impact + version comparison", () => {
  it("summarizes added and removed placements", () => {
    const current = policy();
    const next = policy({
      ...current,
      placements: { ...current.placements, backups: ["us-west", "eu-west"] },
    });
    const impact = summarizeResidencyImpact(current, next);
    expect(impact.addedPlacements).toContainEqual({ dataClass: "backups", region: "eu-west" });
    expect(impact.notes.join(" ")).toMatch(/eu-west will additionally store backups/);
  });

  it("reports no effective change as such", () => {
    const current = policy();
    expect(summarizeResidencyImpact(current, { ...current }).notes).toEqual([
      "No effective change.",
    ]);
  });

  it("compares placements field by field", () => {
    const before = policy({ policyVersion: 1 });
    const after = policy({
      policyVersion: 2,
      placements: { ...before.placements, proofs: ["us-east"] },
    });
    const changes = compareResidencyVersions(before, after);
    expect(changes).toEqual(
      expect.arrayContaining([
        { field: "policyVersion", before: "1", after: "2" },
        { field: "placements.proofs", before: "eu-west, us-east", after: "us-east" },
      ]),
    );
  });

  it("returns no changes for an identical policy", () => {
    expect(compareResidencyVersions(policy(), policy())).toEqual([]);
  });
});

describe("data-residency: fixture", () => {
  it("returns the default policy", async () => {
    const response = await fetchMockDataResidencyPolicy();
    expect(response.policy.schemaVersion).toBe(DATA_RESIDENCY_POLICY_SCHEMA_VERSION);
    expect(response.history).toEqual([]);
  });

  it("honors overrides", async () => {
    const response = await fetchMockDataResidencyPolicy({ policyVersion: 7 });
    expect(response.policy.policyVersion).toBe(7);
  });
});

describe("isWellFormedDataResidencyPolicy — runtime shape guard", () => {
  it("accepts a well-formed policy", () => {
    expect(isWellFormedDataResidencyPolicy(policy())).toBe(true);
  });

  it("rejects non-objects and an unsupported schema version", () => {
    expect(isWellFormedDataResidencyPolicy(null)).toBe(false);
    expect(isWellFormedDataResidencyPolicy(policy({ schemaVersion: 2 }))).toBe(false);
  });

  it("rejects an invalid serverValidation/rollout status", () => {
    expect(
      isWellFormedDataResidencyPolicy({ ...policy(), serverValidation: "maybe" }),
    ).toBe(false);
    expect(
      isWellFormedDataResidencyPolicy({ ...policy(), rollout: { status: "unknown" } }),
    ).toBe(false);
  });
});

describe("tenant-scoped in-memory cache", () => {
  afterEach(() => {
    invalidateDataResidencyPolicyCache();
  });

  it("round-trips a cached entry for one organization", () => {
    const response = { policy: policy(), history: [] };
    setCachedDataResidencyPolicy("org-a", response);
    expect(getCachedDataResidencyPolicy("org-a")).toEqual(response);
  });

  it("never serves one organization's cache entry for another (tenant scoping)", () => {
    setCachedDataResidencyPolicy("org-a", { policy: policy({ policyVersion: 1 }), history: [] });
    expect(getCachedDataResidencyPolicy("org-b")).toBeNull();
  });

  it("expires after the TTL", () => {
    const response = { policy: policy(), history: [] };
    const cachedAt = Date.now() - (DATA_RESIDENCY_CACHE_TTL_MS + 1);
    setCachedDataResidencyPolicy("org-a", response, cachedAt);
    expect(getCachedDataResidencyPolicy("org-a")).toBeNull();
  });

  it("is fresh right at the boundary just under the TTL", () => {
    const response = { policy: policy(), history: [] };
    const cachedAt = Date.now() - (DATA_RESIDENCY_CACHE_TTL_MS - 1000);
    setCachedDataResidencyPolicy("org-a", response, cachedAt);
    expect(getCachedDataResidencyPolicy("org-a")).toEqual(response);
  });

  it("invalidateDataResidencyPolicyCache(id) clears only that organization", () => {
    setCachedDataResidencyPolicy("org-a", { policy: policy(), history: [] });
    setCachedDataResidencyPolicy("org-b", { policy: policy(), history: [] });
    invalidateDataResidencyPolicyCache("org-a");
    expect(getCachedDataResidencyPolicy("org-a")).toBeNull();
    expect(getCachedDataResidencyPolicy("org-b")).not.toBeNull();
  });

  it("invalidateDataResidencyPolicyCache() with no argument clears every organization", () => {
    setCachedDataResidencyPolicy("org-a", { policy: policy(), history: [] });
    setCachedDataResidencyPolicy("org-b", { policy: policy(), history: [] });
    invalidateDataResidencyPolicyCache();
    expect(getCachedDataResidencyPolicy("org-a")).toBeNull();
    expect(getCachedDataResidencyPolicy("org-b")).toBeNull();
  });
});

describe("real backend client — read/preview/update/rollout-status", () => {
  const originalFetch = global.fetch;
  const ORG_ID = "org-77";
  const TOKEN = "test-token";

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      headers: { get: () => null },
    } as unknown as Response;
  }

  afterEach(() => {
    global.fetch = originalFetch;
    invalidateDataResidencyPolicyCache();
    jest.restoreAllMocks();
  });

  it("fetchDataResidencyPolicy reads policy + history and populates the tenant cache", async () => {
    const served = policy({ policyVersion: 2 });
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.endsWith("/history")) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse(served));
    });

    const result = await fetchDataResidencyPolicy(TOKEN, ORG_ID, new AbortController().signal);

    expect(result.policy).toEqual(served);
    expect(getCachedDataResidencyPolicy(ORG_ID)).toEqual(result);
  });

  it("fetchDataResidencyPolicy serves the tenant cache without calling the network again", async () => {
    const served = policy({ policyVersion: 2 });
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.endsWith("/history")) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse(served));
    });

    await fetchDataResidencyPolicy(TOKEN, ORG_ID, new AbortController().signal);
    (global.fetch as jest.Mock).mockClear();
    const second = await fetchDataResidencyPolicy(TOKEN, ORG_ID, new AbortController().signal);

    expect(second.policy).toEqual(served);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fetchDataResidencyPolicy rejects a malformed response rather than caching it", async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.endsWith("/history")) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({ not: "a policy" }));
    });

    await expect(
      fetchDataResidencyPolicy(TOKEN, ORG_ID, new AbortController().signal),
    ).rejects.toThrow(/malformed/i);
    expect(getCachedDataResidencyPolicy(ORG_ID)).toBeNull();
  });

  it("previewResidencyPolicyUpdate merges server-reported blockers with locally computed ones", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({ issues: [], blockers: [{ dataClass: "proofs", region: "us-east", message: "server blocker" }] }),
    );

    const current = policy();
    const draft = policy({ placements: { ...policy().placements, backups: ["eu-west"] } });

    const preview = await previewResidencyPolicyUpdate(TOKEN, ORG_ID, current, draft, new AbortController().signal);

    expect(preview.blockers.some((blocker) => blocker.message === "server blocker")).toBe(true);
  });

  it("updateDataResidencyPolicy sends If-Match, invalidates the tenant cache, and returns the server's result", async () => {
    setCachedDataResidencyPolicy(ORG_ID, { policy: policy(), history: [] });
    const updated = policy({ policyVersion: 2 });
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(updated));

    const result = await updateDataResidencyPolicy(
      TOKEN,
      ORG_ID,
      policy({ policyVersion: 2 }),
      1,
      new AbortController().signal,
    );

    expect(result).toEqual(updated);
    expect(getCachedDataResidencyPolicy(ORG_ID)).toBeNull();
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect((init.headers as Record<string, string>)["If-Match"]).toBe("1");
    expect(init.method).toBe("PUT");
  });

  it("updateDataResidencyPolicy surfaces a 409 as ApiConflictError carrying the server's current entity", async () => {
    const serverCurrent = policy({ policyVersion: 9 });
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: "stale", currentEntity: serverCurrent, submittedData: {} }),
      headers: { get: () => null },
    } as unknown as Response);

    const error = await updateDataResidencyPolicy(
      TOKEN,
      ORG_ID,
      policy({ policyVersion: 2 }),
      1,
      new AbortController().signal,
    ).catch((caught) => caught);

    expect(isDataResidencyPolicyConflict(error)).toBe(true);
    expect((error as ApiConflictError).serverEntity).toEqual(serverCurrent);
  });

  it("fetchDataResidencyRolloutStatus reads just migration/rollout/serverValidation", async () => {
    const status = {
      migration: policy().migration,
      rollout: { status: "in-progress" as const },
      serverValidation: "accepted" as const,
    };
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(status));

    const result = await fetchDataResidencyRolloutStatus(TOKEN, ORG_ID, new AbortController().signal);

    expect(result).toEqual(status);
    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain("/rollout-status");
  });

  it("fetchDataResidencyRolloutStatus rejects a malformed response", async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ not: "a status" }));

    await expect(
      fetchDataResidencyRolloutStatus(TOKEN, ORG_ID, new AbortController().signal),
    ).rejects.toThrow(/malformed/i);
  });

  it("isDataResidencyPolicyConflict is false for every other error shape", () => {
    expect(isDataResidencyPolicyConflict(new Error("network down"))).toBe(false);
    expect(isDataResidencyPolicyConflict(null)).toBe(false);
  });
});
