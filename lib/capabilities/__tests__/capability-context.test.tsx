/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CapabilityProvider,
  useCapabilities,
  useCapability,
} from "../capability-context";
import {
  CAPABILITY_DOCUMENT_SHAPE_VERSION,
  type CapabilityDocument,
} from "@/lib/api/capabilities";
import { readCapabilityCache, writeCapabilityCache } from "@/lib/api/capability-cache";
import { API_SPEC_VERSION } from "@/lib/api/generated/v1";
import { appConfig } from "@/config/app";
import { CAPABILITY_DOCUMENT_PATH } from "@/lib/api/capabilities";

function document(overrides: Partial<CapabilityDocument> = {}): CapabilityDocument {
  return {
    documentVersion: CAPABILITY_DOCUMENT_SHAPE_VERSION,
    apiVersion: API_SPEC_VERSION,
    network: "testnet",
    generatedAt: new Date().toISOString(),
    capabilities: {},
    ...overrides,
  };
}

function Probe({ capabilityKey }: { capabilityKey: Parameters<typeof useCapability>[0] }) {
  const { enabled, status } = useCapability(capabilityKey);
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="enabled">{String(enabled)}</span>
    </div>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("useCapabilities outside a provider", () => {
  it("throws rather than silently fail-opening", () => {
    // Swallow the expected React error boundary console noise for this
    // one assertion.
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    function Bare() {
      useCapabilities();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(
      "useCapabilities must be used within a CapabilityProvider",
    );
    spy.mockRestore();
  });
});

describe("partial rollout", () => {
  it("enables only the capabilities explicitly present in the document", async () => {
    const fetcher = jest.fn().mockResolvedValue(
      document({ capabilities: { "activity-log": { enabled: true } } }),
    );

    render(
      <CapabilityProvider fetcher={fetcher}>
        <Probe capabilityKey="activity-log" />
      </CapabilityProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("enabled")).toHaveTextContent("true");
  });

  it("fails closed for a capability withheld from this rollout", async () => {
    const fetcher = jest.fn().mockResolvedValue(
      document({ capabilities: { "activity-log": { enabled: true } } }),
    );

    render(
      <CapabilityProvider fetcher={fetcher}>
        <Probe capabilityKey="embeddable-verification-widget" />
      </CapabilityProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("enabled")).toHaveTextContent("false");
  });
});

describe("downgrade", () => {
  it("a capability available before refresh is disabled after a refetch removes it", async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(
        document({ capabilities: { "recurring-income-proofs": { enabled: true } } }),
      )
      .mockResolvedValueOnce(document({ capabilities: {} }));

    function Harness() {
      const { has, refresh, status } = useCapabilities();
      return (
        <div>
          <span data-testid="status">{status}</span>
          <span data-testid="enabled">{String(has("recurring-income-proofs"))}</span>
          <button onClick={() => refresh()} type="button">
            Refresh
          </button>
        </div>
      );
    }

    const user = userEvent.setup();

    render(
      <CapabilityProvider fetcher={fetcher}>
        <Harness />
      </CapabilityProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("enabled")).toHaveTextContent("true");

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("enabled")).toHaveTextContent("false");
  });
});

describe("stale cache", () => {
  it("ignores a cache entry from a different deployment identity and refetches", async () => {
    writeCapabilityCache({
      document: document({ capabilities: { "activity-log": { enabled: true } } }),
      identity: {
        apiUrl: "https://stale-api.example.com",
        stellarNetwork: "public",
        apiSpecVersion: "0.1.0",
      },
      cachedAt: Date.now(),
    });

    const fetcher = jest.fn().mockResolvedValue(
      document({ capabilities: { "activity-log": { enabled: false } } }),
    );

    render(
      <CapabilityProvider fetcher={fetcher}>
        <Probe capabilityKey="activity-log" />
      </CapabilityProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    // The fresh fetch (capability disabled) won, not the stale cached
    // document (capability enabled) for a different deployment identity.
    expect(screen.getByTestId("enabled")).toHaveTextContent("false");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses a cached document instead of refetching when it is still fresh for this identity", async () => {
    const identity = {
      apiUrl: "http://localhost:4000/api/v1",
      stellarNetwork: "testnet",
      apiSpecVersion: API_SPEC_VERSION,
    };
    writeCapabilityCache({
      document: document({ capabilities: { "activity-log": { enabled: true } } }),
      identity,
      cachedAt: Date.now(),
    });

    const fetcher = jest.fn().mockResolvedValue(document({ capabilities: {} }));

    render(
      <CapabilityProvider fetcher={fetcher}>
        <Probe capabilityKey="activity-log" />
      </CapabilityProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("enabled")).toHaveTextContent("true");
    expect(fetcher).not.toHaveBeenCalled();
    // Cache should still hold the entry we seeded (untouched).
    expect(readCapabilityCache()?.document.capabilities["activity-log"]?.enabled).toBe(true);
  });
});

describe("incompatible API versions", () => {
  it("fails closed when the fetched document's API version is incompatible", async () => {
    const fetcher = jest.fn().mockResolvedValue(
      document({
        apiVersion: "2.0.0",
        capabilities: { "activity-log": { enabled: true } },
      }),
    );

    render(
      <CapabilityProvider fetcher={fetcher}>
        <Probe capabilityKey="activity-log" />
      </CapabilityProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("enabled")).toHaveTextContent("false");
  });

  it("fails closed (status: error) when the fetch itself rejects", async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error("network down"));

    render(
      <CapabilityProvider fetcher={fetcher}>
        <Probe capabilityKey="activity-log" />
      </CapabilityProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("error"));
    expect(screen.getByTestId("enabled")).toHaveTextContent("false");
  });
});

describe("default (production) fetcher — real backend wiring", () => {
  const originalFetch = global.fetch;
  const identity = {
    apiUrl: appConfig.apiUrl,
    stellarNetwork: appConfig.stellarNetwork,
    apiSpecVersion: API_SPEC_VERSION,
  };

  function mockFetchResponse(init: {
    ok: boolean;
    status: number;
    json?: () => Promise<unknown>;
    etag?: string | null;
  }) {
    return {
      ok: init.ok,
      status: init.status,
      json: init.json ?? (async () => ({})),
      headers: { get: (name: string) => (name.toLowerCase() === "etag" ? init.etag ?? null : null) },
    } as unknown as Response;
  }

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("loads from the real backend when no fetcher override is supplied", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        ok: true,
        status: 200,
        json: async () => document({ capabilities: { "activity-log": { enabled: true } } }),
        etag: '"doc-v1"',
      }),
    );

    render(<Probe capabilityKey="activity-log" />, {
      // No <CapabilityProvider fetcher=...> override — exercises the real default.
      wrapper: ({ children }) => <CapabilityProvider>{children}</CapabilityProvider>,
    });

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("enabled")).toHaveTextContent("true");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(CAPABILITY_DOCUMENT_PATH),
      expect.anything(),
    );
    expect(readCapabilityCache()?.etag).toBe('"doc-v1"');
  });

  it("serves 'stale' from the last trusted cache when a refetch fails, without hiding an already-granted capability", async () => {
    writeCapabilityCache({
      document: document({ capabilities: { "activity-log": { enabled: true } } }),
      identity,
      cachedAt: Date.now() - 10 * 60 * 1000, // past the 5-minute TTL
      etag: '"stale-etag"',
    });
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    render(<Probe capabilityKey="activity-log" />, {
      wrapper: ({ children }) => <CapabilityProvider>{children}</CapabilityProvider>,
    });

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("stale"));
    expect(screen.getByTestId("enabled")).toHaveTextContent("true");
  });

  it("fails fully closed (status: error) when there is no same-identity cache to fall back to", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    render(<Probe capabilityKey="activity-log" />, {
      wrapper: ({ children }) => <CapabilityProvider>{children}</CapabilityProvider>,
    });

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("error"));
    expect(screen.getByTestId("enabled")).toHaveTextContent("false");
  });

  it("never falls back to a cache entry from a different deployment identity (cross-environment)", async () => {
    writeCapabilityCache({
      document: document({ capabilities: { "activity-log": { enabled: true } } }),
      identity: { apiUrl: "https://other-env.example.com", stellarNetwork: "public", apiSpecVersion: "9.0.0" },
      cachedAt: Date.now(),
      etag: '"cross-env-etag"',
    });
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    render(<Probe capabilityKey="activity-log" />, {
      wrapper: ({ children }) => <CapabilityProvider>{children}</CapabilityProvider>,
    });

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("error"));
    expect(screen.getByTestId("enabled")).toHaveTextContent("false");
  });

  it("treats a 304 revalidation as a replay-safe refresh of the existing trusted document", async () => {
    writeCapabilityCache({
      document: document({ capabilities: { "activity-log": { enabled: true } } }),
      identity,
      cachedAt: Date.now() - 10 * 60 * 1000, // past TTL, so a revalidation request is made
      etag: '"revalidate-me"',
    });
    global.fetch = jest.fn().mockResolvedValue(mockFetchResponse({ ok: false, status: 304 }));

    render(<Probe capabilityKey="activity-log" />, {
      wrapper: ({ children }) => <CapabilityProvider>{children}</CapabilityProvider>,
    });

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("enabled")).toHaveTextContent("true");
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect((options.headers as Record<string, string>)["If-None-Match"]).toBe('"revalidate-me"');
  });
});
