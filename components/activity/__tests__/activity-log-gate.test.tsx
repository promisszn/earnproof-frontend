/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react";
import { ActivityLogGate } from "@/components/activity/activity-log-gate";
import { fetchActivityEvents } from "@/lib/api/activity";
import { fetchCapabilityDocument, CAPABILITY_DOCUMENT_SHAPE_VERSION } from "@/lib/api/capabilities";
import { API_SPEC_VERSION } from "@/lib/api/generated/v1";

// `CapabilityProvider`'s default fetcher is now `fetchCapabilityDocument`
// (the real backend client, #307) rather than the local mock fixture — see
// `lib/capabilities/capability-context.tsx`. Mocking it here is what makes
// these tests deterministic without a real `/capabilities` endpoint.
jest.mock("@/lib/api/capabilities", () => ({
  ...jest.requireActual("@/lib/api/capabilities"),
  fetchCapabilityDocument: jest.fn(),
}));

jest.mock("@/lib/api/activity", () => ({
  ...jest.requireActual("@/lib/api/activity"),
  fetchActivityEvents: jest.fn(),
}));

const mockedFetchCapabilityDocument = fetchCapabilityDocument as jest.MockedFunction<
  typeof fetchCapabilityDocument
>;
const mockedFetchActivityEvents = fetchActivityEvents as jest.MockedFunction<
  typeof fetchActivityEvents
>;

beforeEach(() => {
  window.localStorage.clear();
  mockedFetchCapabilityDocument.mockReset();
  mockedFetchActivityEvents.mockReset();
  mockedFetchActivityEvents.mockResolvedValue({ events: [], nextCursor: null });
});

describe("ActivityLogGate", () => {
  it("renders the activity log once the activity-log capability is enabled", async () => {
    mockedFetchCapabilityDocument.mockResolvedValue({
      kind: "fresh",
      etag: null,
      document: {
        documentVersion: CAPABILITY_DOCUMENT_SHAPE_VERSION,
        apiVersion: API_SPEC_VERSION,
        network: "testnet",
        generatedAt: new Date().toISOString(),
        capabilities: { "activity-log": { enabled: true } },
      },
    });

    render(<ActivityLogGate />);

    await waitFor(() =>
      expect(screen.getByText("No recent account activity to show.")).toBeInTheDocument(),
    );
  });

  it("renders an explicit unavailable state (not a blank/hidden section) when the capability is disabled", async () => {
    mockedFetchCapabilityDocument.mockResolvedValue({
      kind: "fresh",
      etag: null,
      document: {
        documentVersion: CAPABILITY_DOCUMENT_SHAPE_VERSION,
        apiVersion: API_SPEC_VERSION,
        network: "testnet",
        generatedAt: new Date().toISOString(),
        capabilities: {},
      },
    });

    render(<ActivityLogGate />);

    await waitFor(() =>
      expect(screen.getByText("Activity log unavailable")).toBeInTheDocument(),
    );
    expect(mockedFetchActivityEvents).not.toHaveBeenCalled();
  });

  it("fails closed (renders unavailable, not the activity log) when the capability document fails to load", async () => {
    mockedFetchCapabilityDocument.mockRejectedValue(new Error("network error"));

    render(<ActivityLogGate />);

    await waitFor(() =>
      expect(screen.getByText("Activity log unavailable")).toBeInTheDocument(),
    );
    expect(mockedFetchActivityEvents).not.toHaveBeenCalled();
  });

  it("shows a loading state before the capability check resolves", () => {
    mockedFetchCapabilityDocument.mockReturnValue(new Promise(() => {})); // never resolves

    render(<ActivityLogGate />);

    expect(screen.getByText("Checking availability...")).toBeInTheDocument();
  });
});
