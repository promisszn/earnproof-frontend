/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react";
import { VerificationWidgetGate } from "@/components/verification/embed/verification-widget-gate";
import { fetchWidgetVerification } from "@/lib/api/verification-widget";
import { fetchCapabilityDocument } from "@/lib/api/capabilities";
import { CAPABILITY_DOCUMENT_SHAPE_VERSION } from "@/lib/api/capabilities";
import { API_SPEC_VERSION } from "@/lib/api/generated/v1";
import type { VerifyProofResponse } from "@/lib/api/generated/v1";

// `CapabilityProvider`'s default fetcher is now `fetchCapabilityDocument`
// (the real backend client, #307) rather than the local mock fixture — see
// `lib/capabilities/capability-context.tsx`. Mocking it here is what makes
// these tests deterministic without a real `/capabilities` endpoint.
jest.mock("@/lib/api/capabilities", () => ({
  ...jest.requireActual("@/lib/api/capabilities"),
  fetchCapabilityDocument: jest.fn(),
}));

jest.mock("@/lib/api/verification-widget", () => ({
  ...jest.requireActual("@/lib/api/verification-widget"),
  fetchWidgetVerification: jest.fn(),
}));

const mockedFetchCapabilityDocument = fetchCapabilityDocument as jest.MockedFunction<
  typeof fetchCapabilityDocument
>;
const mockedFetchWidget = fetchWidgetVerification as jest.MockedFunction<
  typeof fetchWidgetVerification
>;

const VALID_RESULT: VerifyProofResponse = { result: "VALID", status: "valid" };

beforeEach(() => {
  window.localStorage.clear();
  mockedFetchCapabilityDocument.mockReset();
  mockedFetchWidget.mockReset();
  mockedFetchWidget.mockResolvedValue({ kind: "result", response: VALID_RESULT });
});

describe("VerificationWidgetGate", () => {
  it("renders the widget once the embeddable-verification-widget capability is enabled", async () => {
    mockedFetchCapabilityDocument.mockResolvedValue({
      kind: "fresh",
      etag: null,
      document: {
        documentVersion: CAPABILITY_DOCUMENT_SHAPE_VERSION,
        apiVersion: API_SPEC_VERSION,
        network: "testnet",
        generatedAt: new Date().toISOString(),
        capabilities: { "embeddable-verification-widget": { enabled: true } },
      },
    });

    render(<VerificationWidgetGate proofId="EP-8A42-91DC" />);

    await waitFor(() => expect(screen.getByText("valid")).toBeInTheDocument());
  });

  it("renders an explicit unavailable state (not a blank iframe, not a link back to EarnProof) when the capability is disabled", async () => {
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

    render(<VerificationWidgetGate proofId="EP-8A42-91DC" />);

    await waitFor(() =>
      expect(screen.getByText("Verification widget unavailable")).toBeInTheDocument(),
    );
    // The main-app CapabilityUnavailable component links "Back to
    // EarnProof" — meaningless (and a broken navigation target) inside a
    // relying-party-embedded iframe, so the gate must not render that link.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(mockedFetchWidget).not.toHaveBeenCalled();
  });

  it("fails closed (renders unavailable, not the widget) when the capability document fails to load", async () => {
    mockedFetchCapabilityDocument.mockRejectedValue(new Error("network error"));

    render(<VerificationWidgetGate proofId="EP-8A42-91DC" />);

    await waitFor(() =>
      expect(screen.getByText("Verification widget unavailable")).toBeInTheDocument(),
    );
    expect(mockedFetchWidget).not.toHaveBeenCalled();
  });

  it("shows a loading state before the capability check resolves", () => {
    mockedFetchCapabilityDocument.mockReturnValue(new Promise(() => {})); // never resolves

    render(<VerificationWidgetGate proofId="EP-8A42-91DC" />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
  });
});
