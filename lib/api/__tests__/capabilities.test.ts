/**
 * @jest-environment jsdom
 */

import {
  CAPABILITY_DOCUMENT_PATH,
  CAPABILITY_DOCUMENT_SHAPE_VERSION,
  CapabilityDocumentError,
  currentDeploymentIdentity,
  deploymentIdentityChanged,
  fetchCapabilityDocument,
  fetchMockCapabilityDocument,
  isApiVersionCompatible,
  isCapabilityDocumentTrusted,
  isCapabilityEnabled,
  isWellFormedCapabilityDocument,
  type CapabilityDocument,
} from "../capabilities";
import { API_SPEC_VERSION } from "../generated/v1";
import { appConfig } from "@/config/app";

function baseDocument(overrides: Partial<CapabilityDocument> = {}): CapabilityDocument {
  return {
    documentVersion: CAPABILITY_DOCUMENT_SHAPE_VERSION,
    apiVersion: API_SPEC_VERSION,
    network: "testnet",
    generatedAt: new Date().toISOString(),
    capabilities: {
      "activity-log": { enabled: true },
      "embeddable-verification-widget": { enabled: true },
    },
    ...overrides,
  };
}

describe("isCapabilityEnabled — fail closed", () => {
  it("returns false when the document is null/undefined", () => {
    expect(isCapabilityEnabled(null, "activity-log")).toBe(false);
    expect(isCapabilityEnabled(undefined, "activity-log")).toBe(false);
  });

  it("returns false for a capability key absent from the document (partial rollout)", () => {
    const document = baseDocument({
      capabilities: {
        "activity-log": { enabled: true },
        // "embeddable-verification-widget" intentionally absent — this
        // organization hasn't been rolled into that capability yet.
      },
    });

    expect(isCapabilityEnabled(document, "activity-log")).toBe(true);
    expect(isCapabilityEnabled(document, "embeddable-verification-widget")).toBe(false);
  });

  it("returns false for a capability explicitly present but disabled", () => {
    const document = baseDocument({
      capabilities: {
        "activity-log": { enabled: false, note: "Disabled for this org" },
      },
    });

    expect(isCapabilityEnabled(document, "activity-log")).toBe(false);
  });

  it("returns false for a capability that disappears from a refetched document (downgrade)", () => {
    const before = baseDocument({
      capabilities: {
        "recurring-income-proofs": { enabled: true },
      },
    });
    const after = baseDocument({
      capabilities: {},
    });

    expect(isCapabilityEnabled(before, "recurring-income-proofs")).toBe(true);
    expect(isCapabilityEnabled(after, "recurring-income-proofs")).toBe(false);
  });

  it("returns false when the document shape version is unrecognized", () => {
    const document = baseDocument({ documentVersion: 999 });
    expect(isCapabilityEnabled(document, "activity-log")).toBe(false);
  });

  it("returns false when the document's API version is incompatible", () => {
    const document = baseDocument({ apiVersion: "2.0.0" });
    expect(isCapabilityEnabled(document, "activity-log")).toBe(false);
  });

  it("does not throw for an unknown/garbage capability key at the type boundary", () => {
    const document = baseDocument();
    // Cast to simulate a document containing keys this frontend build
    // doesn't know about (e.g. served by a newer backend).
    expect(
      isCapabilityEnabled(document, "some-future-capability" as never),
    ).toBe(false);
  });
});

describe("isApiVersionCompatible", () => {
  it("accepts matching major versions", () => {
    expect(isApiVersionCompatible("1.0.0", "1.0.0")).toBe(true);
    expect(isApiVersionCompatible("1.4.2", "1.0.0")).toBe(true);
  });

  it("rejects differing major versions (incompatible API version)", () => {
    expect(isApiVersionCompatible("2.0.0", "1.0.0")).toBe(false);
    expect(isApiVersionCompatible("0.9.0", "1.0.0")).toBe(false);
  });

  it("rejects malformed version strings", () => {
    expect(isApiVersionCompatible("", "1.0.0")).toBe(false);
    expect(isApiVersionCompatible("1.0.0", "")).toBe(false);
  });
});

describe("deploymentIdentityChanged", () => {
  it("is false when apiUrl, network, and apiSpecVersion are unchanged", () => {
    const identity = currentDeploymentIdentity();
    expect(deploymentIdentityChanged(identity, { ...identity })).toBe(false);
  });

  it("is true when the API URL changes", () => {
    const identity = currentDeploymentIdentity();
    expect(
      deploymentIdentityChanged(identity, {
        ...identity,
        apiUrl: "https://different-api.example.com",
      }),
    ).toBe(true);
  });

  it("is true when the Stellar network changes", () => {
    const identity = currentDeploymentIdentity();
    expect(
      deploymentIdentityChanged(identity, { ...identity, stellarNetwork: "public" }),
    ).toBe(true);
  });

  it("is true when the API spec version changes", () => {
    const identity = currentDeploymentIdentity();
    expect(
      deploymentIdentityChanged(identity, { ...identity, apiSpecVersion: "2.0.0" }),
    ).toBe(true);
  });
});

describe("fetchMockCapabilityDocument", () => {
  it("is explicitly a local stub, not a real network call", async () => {
    // No fetch mock is installed in this test — if this function reached
    // out over the network it would throw. It resolving successfully
    // demonstrates it's a pure in-memory fixture.
    const document = await fetchMockCapabilityDocument();
    expect(document.documentVersion).toBe(CAPABILITY_DOCUMENT_SHAPE_VERSION);
    expect(document.apiVersion).toBe(API_SPEC_VERSION);
  });

  it("supports overrides for simulating partial rollout in callers/tests", async () => {
    const document = await fetchMockCapabilityDocument({
      capabilities: { "activity-log": { enabled: true } },
    });
    expect(isCapabilityEnabled(document, "activity-log")).toBe(true);
    expect(isCapabilityEnabled(document, "embeddable-verification-widget")).toBe(false);
  });
});

describe("isCapabilityDocumentTrusted — cross-network/version fail-closed", () => {
  it("trusts a document matching shape version, API version, and network", () => {
    const document = baseDocument();
    expect(isCapabilityDocumentTrusted(document)).toBe(true);
  });

  it("does not trust a document computed for a different network", () => {
    const document = baseDocument({ network: "public" });
    expect(isCapabilityDocumentTrusted(document)).toBe(false);
    expect(isCapabilityEnabled(document, "activity-log")).toBe(false);
  });

  it("does not trust a document with an incompatible API version", () => {
    const document = baseDocument({ apiVersion: "999.0.0" });
    expect(isCapabilityDocumentTrusted(document)).toBe(false);
  });

  it("does not trust an unrecognized document shape version", () => {
    const document = baseDocument({ documentVersion: 2 });
    expect(isCapabilityDocumentTrusted(document)).toBe(false);
  });

  it("does not trust null/undefined", () => {
    expect(isCapabilityDocumentTrusted(null)).toBe(false);
    expect(isCapabilityDocumentTrusted(undefined)).toBe(false);
  });
});

describe("isWellFormedCapabilityDocument — runtime shape guard", () => {
  it("accepts a well-formed document", () => {
    expect(isWellFormedCapabilityDocument(baseDocument())).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isWellFormedCapabilityDocument(null)).toBe(false);
    expect(isWellFormedCapabilityDocument("a document")).toBe(false);
    expect(isWellFormedCapabilityDocument(42)).toBe(false);
  });

  it("rejects a body missing required fields", () => {
    expect(isWellFormedCapabilityDocument({ documentVersion: 1 })).toBe(false);
  });

  it("rejects a capabilities map whose values aren't { enabled: boolean }", () => {
    const malformed = {
      ...baseDocument(),
      capabilities: { "activity-log": { enabled: "yes" } },
    };
    expect(isWellFormedCapabilityDocument(malformed)).toBe(false);
  });

  it("tolerates an explicitly undefined capability entry", () => {
    const document = {
      ...baseDocument(),
      capabilities: { "activity-log": undefined },
    };
    expect(isWellFormedCapabilityDocument(document)).toBe(true);
  });
});

describe("fetchCapabilityDocument — real backend client", () => {
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

  it("requests the documented path against the configured API URL", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ ok: true, status: 200, json: async () => baseDocument(), etag: '"v1"' }),
    );

    await fetchCapabilityDocument();

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${appConfig.apiUrl}${CAPABILITY_DOCUMENT_PATH}`);
  });

  it("returns a fresh, trusted document with its ETag on 200", async () => {
    const served = baseDocument();
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ ok: true, status: 200, json: async () => served, etag: '"abc123"' }),
    );

    const result = await fetchCapabilityDocument();

    expect(result).toEqual({ kind: "fresh", document: served, etag: '"abc123"' });
  });

  it("sends If-None-Match when an etag is supplied, and omits it otherwise", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ ok: true, status: 200, json: async () => baseDocument() }),
    );

    await fetchCapabilityDocument({ etag: '"cached-etag"' });
    let [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect((options.headers as Record<string, string>)["If-None-Match"]).toBe('"cached-etag"');

    (global.fetch as jest.Mock).mockClear();
    await fetchCapabilityDocument();
    [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(options.headers as Record<string, string>).not.toHaveProperty("If-None-Match");
  });

  it("surfaces a 304 Not Modified as a replay-safe 'not-modified' result, never a synthesized document", async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ ok: false, status: 304 }));

    const result = await fetchCapabilityDocument({ etag: '"abc123"' });

    expect(result).toEqual({ kind: "not-modified" });
  });

  it("fails closed with reason 'unauthorized' on 401", async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ ok: false, status: 401 }));

    const error = await fetchCapabilityDocument().catch((caught) => caught);
    expect(error).toBeInstanceOf(CapabilityDocumentError);
    expect((error as InstanceType<typeof CapabilityDocumentError>).reason).toBe("unauthorized");
  });

  it("fails closed with reason 'unauthorized' on 403", async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ ok: false, status: 403 }));

    const error = await fetchCapabilityDocument().catch((caught) => caught);
    expect(error).toBeInstanceOf(CapabilityDocumentError);
    expect((error as InstanceType<typeof CapabilityDocumentError>).reason).toBe("unauthorized");
  });

  it("fails closed with reason 'network' on a 5xx response", async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ ok: false, status: 503 }));

    const error = await fetchCapabilityDocument().catch((caught) => caught);
    expect(error).toBeInstanceOf(CapabilityDocumentError);
    expect((error as InstanceType<typeof CapabilityDocumentError>).reason).toBe("network");
  });

  it("fails closed with reason 'malformed' when the body is structurally invalid", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ ok: true, status: 200, json: async () => ({ not: "a capability document" }) }),
    );

    const error = await fetchCapabilityDocument().catch((caught) => caught);
    expect(error).toBeInstanceOf(CapabilityDocumentError);
    expect((error as InstanceType<typeof CapabilityDocumentError>).reason).toBe("malformed");
  });

  it("fails closed with reason 'malformed' when the response body is not valid JSON", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }),
    );

    const error = await fetchCapabilityDocument().catch((caught) => caught);
    expect(error).toBeInstanceOf(CapabilityDocumentError);
    expect((error as InstanceType<typeof CapabilityDocumentError>).reason).toBe("malformed");
  });

  it("fails closed with reason 'untrusted' for a well-formed document computed for a different network", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ ok: true, status: 200, json: async () => baseDocument({ network: "public" }) }),
    );

    const error = await fetchCapabilityDocument().catch((caught) => caught);
    expect(error).toBeInstanceOf(CapabilityDocumentError);
    expect((error as InstanceType<typeof CapabilityDocumentError>).reason).toBe("untrusted");
  });

  it("fails closed with reason 'network' when the underlying fetch rejects", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await fetchCapabilityDocument().catch((caught) => caught);
    expect(error).toBeInstanceOf(CapabilityDocumentError);
    expect((error as InstanceType<typeof CapabilityDocumentError>).reason).toBe("network");
  });

  it("propagates cancellation (AbortError) rather than wrapping it as a CapabilityDocumentError", async () => {
    const controller = new AbortController();
    global.fetch = jest.fn().mockImplementation(
      () =>
        new Promise((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    const pending = fetchCapabilityDocument({ signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
