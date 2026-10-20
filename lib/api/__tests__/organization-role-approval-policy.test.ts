import { ApiConflictError } from "@/lib/api/client";
import {
  DEFAULT_ROLE_APPROVAL_MINIMUMS,
  ROLE_APPROVAL_POLICY_SCHEMA_VERSION,
  applyPolicyUpdate,
  buildRollbackDraft,
  canManageRoleApprovalPolicy,
  comparePolicyVersions,
  defaultRoleApprovalPolicy,
  fetchMockRoleApprovalPolicy,
  fetchRoleApprovalPolicy,
  fetchRoleApprovalPolicyHistory,
  isPolicyAtLeastAsStrict,
  isRoleApprovalPolicyConflict,
  isRoleApprovalPolicyValid,
  isWellFormedRoleApprovalPolicy,
  previewRoleApprovalPolicyUpdate,
  summarizePolicyImpact,
  updateRoleApprovalPolicy,
  validateRoleApprovalPolicy,
  type RoleApprovalPolicy,
} from "../organization-role-approval-policy";

function policy(overrides: Partial<RoleApprovalPolicy> = {}): RoleApprovalPolicy {
  return { ...defaultRoleApprovalPolicy(), ...overrides };
}

describe("role-approval-policy: validation", () => {
  it("accepts the default policy", () => {
    expect(validateRoleApprovalPolicy(policy())).toEqual([]);
    expect(isRoleApprovalPolicyValid(policy())).toBe(true);
  });

  it("fails closed for an unsupported schema version", () => {
    const issues = validateRoleApprovalPolicy(policy({ schemaVersion: 999 }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: "schemaVersion", severity: "error" });
  });

  it("rejects reducing approvals below the server minimum", () => {
    const issues = validateRoleApprovalPolicy(policy({ approvalsRequired: 0 }));
    expect(issues.some((issue) => issue.field === "approvalsRequired")).toBe(true);
  });

  it("accepts the exact minimum and maximum boundaries", () => {
    expect(
      isRoleApprovalPolicyValid(
        policy({ approvalsRequired: DEFAULT_ROLE_APPROVAL_MINIMUMS.minApprovalsRequired }),
      ),
    ).toBe(true);
    expect(
      isRoleApprovalPolicyValid(
        policy({ approvalsRequired: DEFAULT_ROLE_APPROVAL_MINIMUMS.maxApprovalsRequired }),
      ),
    ).toBe(true);
  });

  it("rejects exceeding the maximum approvals", () => {
    expect(isRoleApprovalPolicyValid(policy({ approvalsRequired: 999 }))).toBe(false);
  });

  it("enforces the request-validity bounds", () => {
    expect(isRoleApprovalPolicyValid(policy({ requestValidityHours: 0 }))).toBe(false);
    expect(isRoleApprovalPolicyValid(policy({ requestValidityHours: 1 }))).toBe(true);
    expect(isRoleApprovalPolicyValid(policy({ requestValidityHours: 720 }))).toBe(true);
    expect(isRoleApprovalPolicyValid(policy({ requestValidityHours: 721 }))).toBe(false);
  });

  it("refuses to enable self-approval when the server forbids it", () => {
    expect(isRoleApprovalPolicyValid(policy({ allowSelfApproval: true }))).toBe(false);
  });

  it("refuses to drop approval for a role that must always require it", () => {
    const weakened = policy({
      rules: [
        { role: "OWNER", requiresApproval: false },
        { role: "ADMIN", requiresApproval: true },
        { role: "MEMBER", requiresApproval: false },
        { role: "VIEWER", requiresApproval: false },
      ],
    });
    const issues = validateRoleApprovalPolicy(weakened);
    expect(issues.some((issue) => issue.field === "rules.OWNER")).toBe(true);
  });

  it("rejects duplicate rules for the same role", () => {
    const duplicated = policy({
      rules: [
        { role: "OWNER", requiresApproval: true },
        { role: "OWNER", requiresApproval: true },
        { role: "ADMIN", requiresApproval: true },
      ],
    });
    expect(
      validateRoleApprovalPolicy(duplicated).some((issue) => /Duplicate rule/.test(issue.message)),
    ).toBe(true);
  });
});

describe("role-approval-policy: authorization", () => {
  it("allows only OWNER and ADMIN to manage the policy", () => {
    expect(canManageRoleApprovalPolicy("OWNER")).toBe(true);
    expect(canManageRoleApprovalPolicy("ADMIN")).toBe(true);
    expect(canManageRoleApprovalPolicy("MEMBER")).toBe(false);
    expect(canManageRoleApprovalPolicy("VIEWER")).toBe(false);
    expect(canManageRoleApprovalPolicy(null)).toBe(false);
  });

  it("fails an update closed for an unauthorized viewer", () => {
    const current = policy();
    const outcome = applyPolicyUpdate({
      current,
      draft: current,
      expectedVersion: current.policyVersion,
      viewerRole: "VIEWER",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("unauthorized");
    }
  });
});

describe("role-approval-policy: fail-closed apply", () => {
  const now = new Date("2026-06-01T12:00:00.000Z");

  it("applies a valid change and increments the version", () => {
    const current = policy({ policyVersion: 3 });
    const draft = policy({
      policyVersion: 3,
      approvalsRequired: 3,
    });
    const outcome = applyPolicyUpdate({
      current,
      draft,
      expectedVersion: 3,
      viewerRole: "OWNER",
      now,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.policy.policyVersion).toBe(4);
      expect(outcome.policy.approvalsRequired).toBe(3);
      expect(outcome.policy.updatedAt).toBe(now.toISOString());
    }
  });

  it("fails closed when the server version moved on (stale/replay)", () => {
    const current = policy({ policyVersion: 5 });
    const draft = policy({ policyVersion: 4 });
    const outcome = applyPolicyUpdate({
      current,
      draft,
      expectedVersion: 4,
      viewerRole: "OWNER",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("stale");
    }
  });

  it("replaying the same update fails closed the second time", () => {
    const current = policy({ policyVersion: 1 });
    const draft = policy({ policyVersion: 1, approvalsRequired: 3 });

    const first = applyPolicyUpdate({
      current,
      draft,
      expectedVersion: 1,
      viewerRole: "ADMIN",
      now,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The client replays the exact same request against the now-current policy.
    const second = applyPolicyUpdate({
      current: first.policy,
      draft,
      expectedVersion: 1,
      viewerRole: "ADMIN",
      now,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("stale");
    }
  });

  it("fails closed on a forward version conflict", () => {
    const outcome = applyPolicyUpdate({
      current: policy({ policyVersion: 2 }),
      draft: policy({ policyVersion: 3 }),
      expectedVersion: 3,
      viewerRole: "OWNER",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("conflict");
    }
  });

  it("rejects a weakening change as invalid", () => {
    const current = policy({ policyVersion: 1 });
    const outcome = applyPolicyUpdate({
      current,
      draft: policy({ policyVersion: 1, approvalsRequired: 0 }),
      expectedVersion: 1,
      viewerRole: "OWNER",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("invalid");
      expect(outcome.issues?.length).toBeGreaterThan(0);
    }
  });
});

describe("role-approval-policy: impact preview + comparison", () => {
  it("summarizes a strengthening change", () => {
    const current = policy();
    const next = policy({
      approvalsRequired: 3,
      rules: [
        { role: "OWNER", requiresApproval: true },
        { role: "ADMIN", requiresApproval: true },
        { role: "MEMBER", requiresApproval: true },
        { role: "VIEWER", requiresApproval: false },
      ],
    });
    const impact = summarizePolicyImpact(current, next);
    expect(impact.strengthening).toBe(true);
    expect(impact.addedApprovalRoles).toContain("MEMBER");
    expect(impact.approvalsChange).toEqual({ from: 2, to: 3 });
  });

  it("flags a relaxation as not at least as strict", () => {
    const current = policy();
    const next = policy({ approvalsRequired: 1 });
    expect(isPolicyAtLeastAsStrict(current, next)).toBe(false);
    expect(summarizePolicyImpact(current, next).strengthening).toBe(false);
  });

  it("reports no effective change as such", () => {
    const current = policy();
    expect(summarizePolicyImpact(current, { ...current })).toMatchObject({
      addedApprovalRoles: [],
      removedApprovalRoles: [],
      strengthening: true,
    });
  });

  it("compares two versions field by field", () => {
    const before = policy({ policyVersion: 1, approvalsRequired: 2 });
    const after = policy({
      policyVersion: 2,
      approvalsRequired: 4,
      rules: [
        { role: "OWNER", requiresApproval: true },
        { role: "ADMIN", requiresApproval: false },
        { role: "MEMBER", requiresApproval: false },
        { role: "VIEWER", requiresApproval: false },
      ],
    });
    const changes = comparePolicyVersions(before, after);
    expect(changes).toEqual(
      expect.arrayContaining([
        { field: "policyVersion", before: "1", after: "2" },
        { field: "approvalsRequired", before: "2", after: "4" },
        { field: "rules.ADMIN", before: "true", after: "false" },
      ]),
    );
  });

  it("returns no changes for equivalent versions", () => {
    expect(comparePolicyVersions(policy(), policy())).toEqual([]);
  });
});

describe("role-approval-policy: rollback + fixture", () => {
  it("builds a rollback draft that keeps the server's current version slot", () => {
    const current = policy({ policyVersion: 7 });
    const target = policy({ policyVersion: 2, approvalsRequired: 1 });
    const draft = buildRollbackDraft(current, target);
    expect(draft.policyVersion).toBe(7);
    expect(draft.approvalsRequired).toBe(1);
    expect(draft.schemaVersion).toBe(ROLE_APPROVAL_POLICY_SCHEMA_VERSION);
  });

  it("still validates a rollback against the current minimums", () => {
    const target = policy({ approvalsRequired: 0 });
    expect(isRoleApprovalPolicyValid(target)).toBe(false);
  });

  it("returns the default policy from the fixture", async () => {
    const response = await fetchMockRoleApprovalPolicy();
    expect(response.policy.schemaVersion).toBe(ROLE_APPROVAL_POLICY_SCHEMA_VERSION);
    expect(response.history).toEqual([]);
  });

  it("honors fixture overrides and history", async () => {
    const response = await fetchMockRoleApprovalPolicy(
      { approvalsRequired: 3 },
      [policy({ policyVersion: 1 })],
    );
    expect(response.policy.approvalsRequired).toBe(3);
    expect(response.history).toHaveLength(1);
  });
});

describe("isWellFormedRoleApprovalPolicy — runtime shape guard", () => {
  it("accepts a well-formed policy", () => {
    expect(isWellFormedRoleApprovalPolicy(policy())).toBe(true);
  });

  it("rejects non-objects and an unsupported schema version", () => {
    expect(isWellFormedRoleApprovalPolicy(null)).toBe(false);
    expect(isWellFormedRoleApprovalPolicy(policy({ schemaVersion: 2 }))).toBe(false);
  });

  it("rejects a non-integer policyVersion", () => {
    expect(isWellFormedRoleApprovalPolicy({ ...policy(), policyVersion: 1.5 })).toBe(false);
  });

  it("rejects a rule with an unknown role or wrong field types", () => {
    expect(
      isWellFormedRoleApprovalPolicy({
        ...policy(),
        rules: [{ role: "NOT-A-ROLE", requiresApproval: true }],
      }),
    ).toBe(false);
    expect(
      isWellFormedRoleApprovalPolicy({
        ...policy(),
        rules: [{ role: "OWNER", requiresApproval: "yes" }],
      }),
    ).toBe(false);
  });
});

describe("real backend client — read/preview/update/history", () => {
  const originalFetch = global.fetch;
  const ORG_ID = "org-42";
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
    jest.restoreAllMocks();
  });

  it("fetchRoleApprovalPolicy reads from /organizations/{id}/role-approval-policy with a bearer token", async () => {
    const served = policy({ policyVersion: 4 });
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(served));

    const result = await fetchRoleApprovalPolicy(TOKEN, ORG_ID, new AbortController().signal);

    expect(result).toEqual(served);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain(`/organizations/${ORG_ID}/role-approval-policy`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("fetchRoleApprovalPolicy rejects a malformed response rather than returning it", async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ not: "a policy" }));

    await expect(
      fetchRoleApprovalPolicy(TOKEN, ORG_ID, new AbortController().signal),
    ).rejects.toThrow(/malformed/i);
  });

  it("fetchRoleApprovalPolicyHistory reads the history list and drops malformed entries", async () => {
    const good = policy({ policyVersion: 1 });
    global.fetch = jest.fn().mockResolvedValue(jsonResponse([good, { not: "a policy" }]));

    const result = await fetchRoleApprovalPolicyHistory(TOKEN, ORG_ID, new AbortController().signal);

    expect(result).toEqual([good]);
  });

  it("previewRoleApprovalPolicyUpdate merges server-reported issues with local validation", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        issues: [{ field: "approvalsRequired", message: "org-specific floor", severity: "error" }],
      }),
    );

    const current = policy();
    const draft = policy({ approvalsRequired: 0 }); // also fails local validation

    const preview = await previewRoleApprovalPolicyUpdate(
      TOKEN,
      ORG_ID,
      current,
      draft,
      new AbortController().signal,
    );

    expect(preview.issues.some((issue) => issue.message === "org-specific floor")).toBe(true);
    expect(preview.issues.some((issue) => issue.field === "approvalsRequired" && issue.severity === "error")).toBe(
      true,
    );
  });

  it("updateRoleApprovalPolicy sends If-Match with the expected version and returns the server's result", async () => {
    const updated = policy({ policyVersion: 3 });
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(updated));

    const result = await updateRoleApprovalPolicy(
      TOKEN,
      ORG_ID,
      policy({ policyVersion: 2 }),
      2,
      new AbortController().signal,
    );

    expect(result).toEqual(updated);
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect((init.headers as Record<string, string>)["If-Match"]).toBe("2");
    expect(init.method).toBe("PUT");
  });

  it("updateRoleApprovalPolicy surfaces a 409 as ApiConflictError carrying the server's current entity", async () => {
    const serverCurrent = policy({ policyVersion: 9 });
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: "stale", currentEntity: serverCurrent, submittedData: {} }),
      headers: { get: () => null },
    } as unknown as Response);

    const error = await updateRoleApprovalPolicy(
      TOKEN,
      ORG_ID,
      policy({ policyVersion: 2 }),
      1, // stale expected version
      new AbortController().signal,
    ).catch((caught) => caught);

    expect(isRoleApprovalPolicyConflict(error)).toBe(true);
    expect((error as ApiConflictError).serverEntity).toEqual(serverCurrent);
  });

  it("isRoleApprovalPolicyConflict is false for every other error shape", () => {
    expect(isRoleApprovalPolicyConflict(new Error("network down"))).toBe(false);
    expect(isRoleApprovalPolicyConflict(null)).toBe(false);
  });
});
