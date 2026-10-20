import { appConfig } from "@/config/app";
import {
  CONTRACT_MIGRATION_SCHEMA_VERSION,
  CONTRACT_MIGRATION_STATUS_PATH,
  MIGRATION_STATUS_MAX_AGE_MS,
  MigrationStatusError,
  canPerform,
  fetchContractMigrationStatus,
  fetchMockContractMigrationStatus,
  isMigrationStatusFresh,
  isReadOnlyPhase,
  isSafeSuccessorUrl,
  isSuccessorTrusted,
  isSupportedMigrationStatus,
  isValidContractId,
  isWellFormedMigrationStatus,
  migrationBannerCopy,
  migrationGateReason,
  resolveStatusPageLink,
  resolveSuccessorGuideLink,
  type ContractMigrationStatus,
} from "../contract-migration";

const VALID_CONTRACT_ID = `C${"A".repeat(55)}`;
const OTHER_CONTRACT_ID = `C${"B".repeat(55)}`;

function status(
  overrides: Partial<ContractMigrationStatus> = {},
): ContractMigrationStatus {
  return {
    schemaVersion: CONTRACT_MIGRATION_SCHEMA_VERSION,
    network: appConfig.stellarNetwork,
    currentContractId: VALID_CONTRACT_ID,
    phase: "stable",
    ...overrides,
  };
}

describe("contract-migration: contract ID + URL validation", () => {
  it("accepts a well-formed Stellar contract ID", () => {
    expect(isValidContractId(VALID_CONTRACT_ID)).toBe(true);
  });

  it("rejects malformed contract IDs", () => {
    expect(isValidContractId("")).toBe(false);
    expect(isValidContractId("C123")).toBe(false);
    expect(isValidContractId(`G${"A".repeat(55)}`)).toBe(false);
    // "0"/"1"/"8"/"9" are not in the base32 alphabet.
    expect(isValidContractId(`C${"0".repeat(55)}`)).toBe(false);
    expect(isValidContractId(null)).toBe(false);
  });

  it("only accepts absolute HTTPS successor URLs without credentials", () => {
    expect(isSafeSuccessorUrl("https://example.com/migrate")).toBe(true);
    expect(isSafeSuccessorUrl("http://example.com/migrate")).toBe(false);
    expect(isSafeSuccessorUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeSuccessorUrl("https://user:pass@example.com")).toBe(false);
    expect(isSafeSuccessorUrl("not a url")).toBe(false);
    expect(isSafeSuccessorUrl(undefined)).toBe(false);
  });
});

describe("contract-migration: successor identity checks", () => {
  it("trusts only a verified, valid, distinct successor", () => {
    expect(
      isSuccessorTrusted(
        status({
          phase: "replaced",
          successor: {
            contractId: OTHER_CONTRACT_ID,
            verified: true,
            migrationGuideUrl: "https://example.com/migrate",
          },
        }),
      ),
    ).toBe(true);
  });

  it("does not trust an unverified successor", () => {
    expect(
      isSuccessorTrusted(
        status({
          phase: "replaced",
          successor: { contractId: OTHER_CONTRACT_ID, verified: false },
        }),
      ),
    ).toBe(false);
  });

  it("does not trust a successor with an invalid contract ID", () => {
    expect(
      isSuccessorTrusted(
        status({
          phase: "replaced",
          successor: { contractId: "not-a-contract", verified: true },
        }),
      ),
    ).toBe(false);
  });

  it("does not trust the current contract listed as its own successor", () => {
    expect(
      isSuccessorTrusted(
        status({
          phase: "replaced",
          successor: { contractId: VALID_CONTRACT_ID, verified: true },
        }),
      ),
    ).toBe(false);
  });
});

describe("contract-migration: link resolution", () => {
  it("never resolves a successor guide link for an unverified successor", () => {
    const result = resolveSuccessorGuideLink(
      status({
        phase: "replaced",
        successor: {
          contractId: OTHER_CONTRACT_ID,
          verified: false,
          migrationGuideUrl: "https://example.com/migrate",
        },
      }),
    );
    expect(result).toBeNull();
  });

  it("resolves a verified successor guide link", () => {
    const result = resolveSuccessorGuideLink(
      status({
        phase: "replaced",
        successor: {
          contractId: OTHER_CONTRACT_ID,
          verified: true,
          migrationGuideUrl: "https://example.com/migrate",
        },
      }),
    );
    expect(result).toEqual({
      href: "https://example.com/migrate",
      label: "Migration guide",
    });
  });

  it("rejects an unsafe successor guide URL even when verified", () => {
    const result = resolveSuccessorGuideLink(
      status({
        phase: "replaced",
        successor: {
          contractId: OTHER_CONTRACT_ID,
          verified: true,
          migrationGuideUrl: "javascript:alert(1)",
        },
      }),
    );
    expect(result).toBeNull();
  });

  it("resolves a status-page link independently of successor trust", () => {
    const result = resolveStatusPageLink(
      status({ phase: "migrating", statusPageUrl: "https://status.example.com" }),
    );
    expect(result).toEqual({
      href: "https://status.example.com",
      label: "Migration status",
    });
  });
});

describe("contract-migration: capability gating", () => {
  it("does not gate anything when there is no status", () => {
    expect(canPerform(null, "read")).toBe(true);
    expect(canPerform(null, "write")).toBe(true);
  });

  it("allows reads and writes while stable", () => {
    expect(canPerform(status(), "read")).toBe(true);
    expect(canPerform(status(), "write")).toBe(true);
  });

  it("allows writes while preparing", () => {
    expect(canPerform(status({ phase: "preparing" }), "read")).toBe(true);
    expect(canPerform(status({ phase: "preparing" }), "write")).toBe(true);
  });

  it("preserves reads but blocks writes from migrating onward", () => {
    for (const phase of ["migrating", "decommissioned", "replaced"] as const) {
      expect(canPerform(status({ phase }), "read")).toBe(true);
      expect(canPerform(status({ phase }), "write")).toBe(false);
    }
  });

  it("fails closed for writes on an unsupported schema version", () => {
    const unsupported = { ...status(), schemaVersion: 999 };
    expect(canPerform(unsupported, "read")).toBe(true);
    expect(canPerform(unsupported, "write")).toBe(false);
  });

  it("fails closed for writes when the status is for a different network", () => {
    const otherNetwork = status({ network: "futurenet", phase: "stable" });
    expect(canPerform(otherNetwork, "read")).toBe(true);
    expect(canPerform(otherNetwork, "write")).toBe(false);
  });

  it("treats only migrating/decommissioned/replaced as read-only", () => {
    expect(isReadOnlyPhase("stable")).toBe(false);
    expect(isReadOnlyPhase("preparing")).toBe(false);
    expect(isReadOnlyPhase("migrating")).toBe(true);
    expect(isReadOnlyPhase("decommissioned")).toBe(true);
    expect(isReadOnlyPhase("replaced")).toBe(true);
  });

  it("explains why writes are gated, and stays silent when they are not", () => {
    expect(migrationGateReason(status({ phase: "stable" }))).toBeNull();
    expect(migrationGateReason(status({ phase: "migrating" }))).toMatch(/migrating/i);
  });
});

describe("contract-migration: banner copy", () => {
  it("renders nothing for a stable contract", () => {
    expect(migrationBannerCopy(status())).toBeNull();
  });

  it("renders nothing for an unsupported or wrong-network document", () => {
    expect(migrationBannerCopy({ ...status(), schemaVersion: 999 })).toBeNull();
    expect(migrationBannerCopy(status({ network: "futurenet" }))).toBeNull();
  });

  it("announces the preparing phase without claiming read-only", () => {
    const copy = migrationBannerCopy(status({ phase: "preparing" }));
    expect(copy?.tone).toBe("warning");
    expect(copy?.readOnly).toBe(false);
  });

  it("marks migrating as read-only and replaced as danger", () => {
    expect(migrationBannerCopy(status({ phase: "migrating" }))?.readOnly).toBe(true);
    const replaced = migrationBannerCopy(status({ phase: "replaced" }));
    expect(replaced?.tone).toBe("danger");
    expect(replaced?.readOnly).toBe(true);
  });
});

describe("contract-migration: status validation + fixture", () => {
  it("rejects a malformed status document", () => {
    expect(isSupportedMigrationStatus(null)).toBe(false);
    expect(isSupportedMigrationStatus({ ...status(), phase: "nope" as never })).toBe(false);
  });

  it("defaults the fixture to a stable, current-network status", async () => {
    const fixture = await fetchMockContractMigrationStatus();
    expect(fixture.phase).toBe("stable");
    expect(fixture.network).toBe(appConfig.stellarNetwork);
    expect(fixture.schemaVersion).toBe(CONTRACT_MIGRATION_SCHEMA_VERSION);
  });

  it("honors overrides in the fixture", async () => {
    const fixture = await fetchMockContractMigrationStatus({ phase: "migrating" });
    expect(fixture.phase).toBe("migrating");
  });
});

describe("isMigrationStatusFresh — successor-trust freshness boundary", () => {
  it("is fresh immediately after fetching", () => {
    expect(isMigrationStatusFresh(Date.now())).toBe(true);
  });

  it("is fresh right at the boundary just under the max age", () => {
    expect(isMigrationStatusFresh(Date.now() - (MIGRATION_STATUS_MAX_AGE_MS - 1000))).toBe(true);
  });

  it("is stale once the max age has elapsed", () => {
    expect(isMigrationStatusFresh(Date.now() - (MIGRATION_STATUS_MAX_AGE_MS + 1))).toBe(false);
  });

  it("is stale when fetchedAt is null (never fetched)", () => {
    expect(isMigrationStatusFresh(null)).toBe(false);
  });

  it("treats a fetchedAt in the future as stale (clock skew guard)", () => {
    expect(isMigrationStatusFresh(Date.now() + 60_000)).toBe(false);
  });
});

describe("isWellFormedMigrationStatus — runtime shape guard", () => {
  it("accepts a well-formed status", () => {
    expect(isWellFormedMigrationStatus(status())).toBe(true);
  });

  it("accepts a well-formed status with a well-formed successor", () => {
    expect(
      isWellFormedMigrationStatus(
        status({
          successor: { contractId: OTHER_CONTRACT_ID, verified: true, label: "v2" },
        }),
      ),
    ).toBe(true);
  });

  it("rejects non-objects and missing fields", () => {
    expect(isWellFormedMigrationStatus(null)).toBe(false);
    expect(isWellFormedMigrationStatus({ phase: "stable" })).toBe(false);
  });

  it("rejects an invalid phase", () => {
    expect(isWellFormedMigrationStatus({ ...status(), phase: "not-a-phase" })).toBe(false);
  });

  it("rejects a successor with the wrong field types", () => {
    expect(
      isWellFormedMigrationStatus({
        ...status(),
        successor: { contractId: OTHER_CONTRACT_ID, verified: "yes" },
      }),
    ).toBe(false);
  });
});

describe("fetchContractMigrationStatus — real backend client", () => {
  const originalFetch = global.fetch;

  function mockResponse(init: {
    ok: boolean;
    status: number;
    json?: () => Promise<unknown>;
    etag?: string | null;
  }): Response {
    return {
      ok: init.ok,
      status: init.status,
      json: init.json ?? (async () => ({})),
      headers: { get: (name: string) => (name.toLowerCase() === "etag" ? init.etag ?? null : null) },
    } as unknown as Response;
  }

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("requests the documented path, unauthenticated, against the configured API URL", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ ok: true, status: 200, json: async () => status() }),
    );

    await fetchContractMigrationStatus();

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${appConfig.apiUrl}${CONTRACT_MIGRATION_STATUS_PATH}`);
  });

  it("returns a fresh, trusted status with its ETag on 200", async () => {
    const served = status({ phase: "migrating" });
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ ok: true, status: 200, json: async () => served, etag: '"m1"' }),
    );

    const result = await fetchContractMigrationStatus();

    expect(result).toEqual({ kind: "fresh", status: served, etag: '"m1"' });
  });

  it("surfaces a 304 as 'not-modified' without synthesizing a status", async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ ok: false, status: 304 }));

    const result = await fetchContractMigrationStatus({ etag: '"m1"' });

    expect(result).toEqual({ kind: "not-modified" });
  });

  it("fails closed with reason 'unauthorized' on 401/403", async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ ok: false, status: 403 }));

    const error = await fetchContractMigrationStatus().catch((caught) => caught);
    expect(error).toBeInstanceOf(MigrationStatusError);
    expect((error as InstanceType<typeof MigrationStatusError>).reason).toBe("unauthorized");
  });

  it("fails closed with reason 'network' on a 5xx response", async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ ok: false, status: 502 }));

    const error = await fetchContractMigrationStatus().catch((caught) => caught);
    expect(error).toBeInstanceOf(MigrationStatusError);
    expect((error as InstanceType<typeof MigrationStatusError>).reason).toBe("network");
  });

  it("fails closed with reason 'malformed' for a structurally invalid body", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ ok: true, status: 200, json: async () => ({ not: "a migration status" }) }),
    );

    const error = await fetchContractMigrationStatus().catch((caught) => caught);
    expect(error).toBeInstanceOf(MigrationStatusError);
    expect((error as InstanceType<typeof MigrationStatusError>).reason).toBe("malformed");
  });

  it("fails closed with reason 'untrusted' for a well-formed status on a different network", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ ok: true, status: 200, json: async () => status({ network: "public" }) }),
    );

    const error = await fetchContractMigrationStatus().catch((caught) => caught);
    expect(error).toBeInstanceOf(MigrationStatusError);
    expect((error as InstanceType<typeof MigrationStatusError>).reason).toBe("untrusted");
  });

  it("fails closed with reason 'network' when the underlying fetch rejects", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await fetchContractMigrationStatus().catch((caught) => caught);
    expect(error).toBeInstanceOf(MigrationStatusError);
    expect((error as InstanceType<typeof MigrationStatusError>).reason).toBe("network");
  });

  it("propagates cancellation (AbortError) rather than wrapping it", async () => {
    const controller = new AbortController();
    global.fetch = jest.fn().mockImplementation(
      () =>
        new Promise((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    const pending = fetchContractMigrationStatus({ signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
