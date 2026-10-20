import React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import { appConfig } from "@/config/app";
import {
  CONTRACT_MIGRATION_SCHEMA_VERSION,
  CONTRACT_MIGRATION_STATUS_PATH,
  type ContractMigrationStatus,
} from "@/lib/api/contract-migration";
import {
  ContractMigrationActionGate,
  ContractMigrationBanner,
  ContractMigrationStatusBanner,
} from "../contract-migration-banner";

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

afterEach(() => {
  // The network status module keeps module-level state; make sure it is reset
  // so an offline assertion in one test cannot leak into the next.
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
});

describe("ContractMigrationBanner", () => {
  it("renders nothing for a stable contract", () => {
    const { container } = render(<ContractMigrationBanner status={status()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there is no status", () => {
    const { container } = render(<ContractMigrationBanner status={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("announces the preparing phase as a status with write access intact", () => {
    render(<ContractMigrationBanner status={status({ phase: "preparing" })} />);
    expect(
      screen.getByText(/preparing to migrate/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/read-only access is preserved/i)).toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows a read-only status while migrating", () => {
    render(<ContractMigrationBanner status={status({ phase: "migrating" })} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(/read-only access is preserved/i)).toBeInTheDocument();
  });

  it("escalates to a danger alert once replaced", () => {
    render(<ContractMigrationBanner status={status({ phase: "replaced" })} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/read-only access is preserved/i)).toBeInTheDocument();
  });

  it("never links to an unverified successor", () => {
    render(
      <ContractMigrationBanner
        status={status({
          phase: "replaced",
          successor: {
            contractId: OTHER_CONTRACT_ID,
            verified: false,
            migrationGuideUrl: "https://example.com/migrate",
          },
        })}
      />,
    );
    expect(screen.queryByRole("link", { name: /migration guide/i })).toBeNull();
    expect(screen.getByText(/has not been verified/i)).toBeInTheDocument();
  });

  it("links to a verified successor and the status page", () => {
    render(
      <ContractMigrationBanner
        status={status({
          phase: "replaced",
          statusPageUrl: "https://status.example.com",
          successor: {
            contractId: OTHER_CONTRACT_ID,
            verified: true,
            migrationGuideUrl: "https://example.com/migrate",
          },
        })}
      />,
    );
    expect(screen.getByRole("link", { name: /migration guide/i })).toHaveAttribute(
      "href",
      "https://example.com/migrate",
    );
    expect(screen.getByRole("link", { name: /migration status/i })).toHaveAttribute(
      "href",
      "https://status.example.com",
    );
  });

  it("warns that the status may be stale while offline", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    render(<ContractMigrationBanner status={status({ phase: "migrating" })} />);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(await screen.findByText(/you are offline/i)).toBeInTheDocument();
  });
});

describe("ContractMigrationActionGate", () => {
  it("renders children while writes are allowed", () => {
    render(
      <ContractMigrationActionGate capability="write" status={status({ phase: "preparing" })}>
        <button type="button">Issue credential</button>
      </ContractMigrationActionGate>,
    );
    expect(screen.getByRole("button", { name: /issue credential/i })).toBeInTheDocument();
  });

  it("gates a write action from migrating onward", () => {
    render(
      <ContractMigrationActionGate capability="write" status={status({ phase: "migrating" })}>
        <button type="button">Issue credential</button>
      </ContractMigrationActionGate>,
    );
    expect(screen.queryByRole("button", { name: /issue credential/i })).toBeNull();
    expect(screen.getByText(/changes are temporarily disabled/i)).toBeInTheDocument();
  });

  it("keeps read-only actions available during migration", () => {
    render(
      <ContractMigrationActionGate capability="read" status={status({ phase: "replaced" })}>
        <span>Proof history</span>
      </ContractMigrationActionGate>,
    );
    expect(screen.getByText("Proof history")).toBeInTheDocument();
  });
});

describe("ContractMigrationBanner — successorTrustAllowed", () => {
  const trustedSuccessorStatus = status({
    phase: "replaced",
    successor: {
      contractId: OTHER_CONTRACT_ID,
      verified: true,
      migrationGuideUrl: "https://example.com/migrate",
    },
  });

  it("links to a verified successor by default (prop omitted)", () => {
    render(<ContractMigrationBanner status={trustedSuccessorStatus} />);
    expect(screen.getByRole("link", { name: /migration guide/i })).toBeInTheDocument();
  });

  it("withholds an otherwise-trusted successor link once successorTrustAllowed is false, with a distinct stale note", () => {
    render(
      <ContractMigrationBanner status={trustedSuccessorStatus} successorTrustAllowed={false} />,
    );
    expect(screen.queryByRole("link", { name: /migration guide/i })).toBeNull();
    expect(screen.getByTestId("stale-successor-note")).toBeInTheDocument();
    // Must not be confused with "never verified" — it IS verified, just stale.
    expect(screen.queryByText(/has not been verified/i)).toBeNull();
  });
});

describe("ContractMigrationStatusBanner — real backend polling", () => {
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
  });

  it("self-loads the real migration status on mount (never the mock fixture)", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ ok: true, status: 200, json: async () => status({ phase: "migrating" }) }),
    );

    render(<ContractMigrationStatusBanner />);

    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(screen.getByText(/read-only access is preserved/i)).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(CONTRACT_MIGRATION_STATUS_PATH),
      expect.anything(),
    );
  });

  it("renders nothing while there is no status yet and the backend is unreachable", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const { container } = render(<ContractMigrationStatusBanner />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps gating writes from the last known status after a poll failure (fail-safe, not fail-closed-to-null)", async () => {
    jest.useFakeTimers({ advanceTimers: true });
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(
          mockResponse({ ok: true, status: 200, json: async () => status({ phase: "migrating" }) }),
        );
      }
      return Promise.reject(new TypeError("Failed to fetch"));
    });

    render(<ContractMigrationStatusBanner pollIntervalMs={1000} />);

    await waitFor(() => expect(screen.getByText(/read-only access is preserved/i)).toBeInTheDocument());

    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    // The poll failed, but the banner still shows (and still gates on) the
    // last known "migrating" status — it did not fall back to "no status".
    expect(screen.getByText(/read-only access is preserved/i)).toBeInTheDocument();

    jest.useRealTimers();
  });

  it("stops offering a successor redirect once the known status has gone stale, without discarding it", async () => {
    jest.useFakeTimers({ advanceTimers: true });
    const trustedSuccessorStatus = status({
      phase: "replaced",
      successor: {
        contractId: OTHER_CONTRACT_ID,
        verified: true,
        migrationGuideUrl: "https://example.com/migrate",
      },
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: async () => trustedSuccessorStatus }))
      .mockRejectedValue(new TypeError("Failed to fetch"));

    render(<ContractMigrationStatusBanner pollIntervalMs={1000} />);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /migration guide/i })).toBeInTheDocument(),
    );

    // Advance well past MIGRATION_STATUS_MAX_AGE_MS (10 minutes) while every
    // subsequent poll fails — the status itself must still be shown.
    await act(async () => {
      jest.advanceTimersByTime(11 * 60 * 1000);
    });

    expect(screen.queryByRole("link", { name: /migration guide/i })).toBeNull();
    expect(screen.getByTestId("stale-successor-note")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument(); // "replaced" is still being rendered

    jest.useRealTimers();
  });

  it("never second-guesses a caller-supplied initialStatus with its own fetch", () => {
    global.fetch = jest.fn();

    render(<ContractMigrationStatusBanner initialStatus={status({ phase: "stable" })} />);

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
