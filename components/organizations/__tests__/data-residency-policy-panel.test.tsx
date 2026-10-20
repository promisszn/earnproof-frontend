import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import {
  defaultDataResidencyPolicy,
  invalidateDataResidencyPolicyCache,
  type DataResidencyPolicy,
} from "@/lib/api/organization-data-residency";
import { DataResidencyPolicyPanel } from "../data-residency-policy-panel";

function policy(overrides: Partial<DataResidencyPolicy> = {}): DataResidencyPolicy {
  return { ...defaultDataResidencyPolicy(), ...overrides };
}

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof DataResidencyPolicyPanel>> = {},
) {
  return render(
    <DataResidencyPolicyPanel
      initialPolicy={policy()}
      organizationId="org-1"
      token="test-token"
      viewerRole="OWNER"
      {...overrides}
    />,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

function conflictResponse(currentEntity: unknown): Response {
  return {
    ok: false,
    status: 409,
    json: async () => ({ message: "Conflict", currentEntity, submittedData: {} }),
    headers: { get: () => null },
  } as unknown as Response;
}

function mockBackend(options: {
  previewIssues?: Array<{ field: string; message: string; severity: "error" | "warning" }>;
  previewBlockers?: Array<{ dataClass: string; region: string; message: string }>;
  updatedPolicy?: DataResidencyPolicy;
  conflictEntity?: DataResidencyPolicy;
  readPolicy?: DataResidencyPolicy;
  history?: DataResidencyPolicy[];
  rolloutStatus?: {
    migration: DataResidencyPolicy["migration"];
    rollout: DataResidencyPolicy["rollout"];
    serverValidation: DataResidencyPolicy["serverValidation"];
  };
}) {
  const {
    previewIssues = [],
    previewBlockers = [],
    updatedPolicy,
    conflictEntity,
    readPolicy,
    history = [],
    rolloutStatus,
  } = options;

  return jest.fn().mockImplementation((url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();

    if (url.endsWith("/preview") && method === "POST") {
      return Promise.resolve(jsonResponse({ issues: previewIssues, blockers: previewBlockers }));
    }
    if (url.endsWith("/rollout-status") && method === "GET") {
      return Promise.resolve(jsonResponse(rolloutStatus));
    }
    if (url.endsWith("/data-residency-policy/history") && method === "GET") {
      return Promise.resolve(jsonResponse(history));
    }
    if (url.endsWith("/data-residency-policy") && method === "PUT") {
      if (conflictEntity) {
        return Promise.resolve(conflictResponse(conflictEntity));
      }
      return Promise.resolve(jsonResponse(updatedPolicy));
    }
    if (url.endsWith("/data-residency-policy") && method === "GET") {
      return Promise.resolve(jsonResponse(readPolicy));
    }
    return Promise.reject(new Error(`Unexpected fetch call: ${method} ${url}`));
  });
}

describe("DataResidencyPolicyPanel", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    invalidateDataResidencyPolicyCache();
    jest.useRealTimers();
  });

  it("renders a read-only view for non-managers", () => {
    renderPanel({ viewerRole: "VIEWER" });
    expect(screen.getByText(/read-only access to this policy/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save policy/i })).toBeNull();
    expect(screen.getByLabelText("proofs in us-east")).toBeDisabled();
  });

  it("shows a sign-in state, never the mock-backed editor, when there is no token and no pre-loaded policy", () => {
    global.fetch = jest.fn();
    renderPanel({ initialPolicy: undefined, token: null });
    expect(screen.getByText(/sign in to view/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("treats a management viewerRole as read-only when no token is present", () => {
    renderPanel({ token: null });
    expect(screen.getByText(/read-only access to this policy/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save policy/i })).toBeNull();
  });

  it("reports the default policy as compliant", () => {
    renderPanel();
    expect(screen.getByTestId("compliance-status")).toHaveTextContent("Compliant");
  });

  it("does not imply compliance while a migration is in progress", () => {
    renderPanel({
      initialPolicy: policy({
        migration: { ...policy().migration, proofs: "in-progress" },
      }),
    });
    const status = screen.getByTestId("compliance-status");
    expect(status).toHaveTextContent("Not yet compliant");
    expect(status).toHaveTextContent(/proofs migration is in-progress/i);
  });

  it("disables regions that cannot store a data class", () => {
    renderPanel();
    expect(screen.getByLabelText("personal-data in us-west")).toBeDisabled();
    expect(screen.getByLabelText("proofs in ap-northeast")).toBeDisabled();
    expect(screen.getByLabelText("payment-records in eu-west")).toBeEnabled();
  });

  it("previews the impact of adding a region", () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText("backups in eu-west"));
    expect(screen.getByText(/eu-west will additionally store backups/i)).toBeInTheDocument();
  });

  it("blocks saving (and never calls the network) when a data class has no region", () => {
    global.fetch = jest.fn();
    renderPanel();
    fireEvent.click(screen.getByLabelText("backups in us-west"));
    expect(screen.getByText(/select at least one region for backups/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save policy/i })).toBeDisabled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("shows a migration blocker while a class is still migrating, and never calls the network to save", () => {
    global.fetch = jest.fn();
    renderPanel({
      initialPolicy: policy({
        migration: { ...policy().migration, proofs: "in-progress" },
      }),
    });
    fireEvent.click(screen.getByLabelText("proofs in eu-west"));
    expect(screen.getByTestId("migration-blockers")).toHaveTextContent(
      /cannot change proofs placement/i,
    );
    fireEvent.click(screen.getByRole("button", { name: /save policy/i }));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not claim the policy was saved until the server confirms it", async () => {
    const updated = policy({ policyVersion: 2 });
    global.fetch = mockBackend({ updatedPolicy: updated });
    renderPanel();

    fireEvent.click(screen.getByLabelText("proofs in us-west"));
    fireEvent.click(screen.getByRole("button", { name: /save policy/i }));

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/saved residency policy version 2/i),
    );
  });

  it("saves a valid change via the server, increments the version, and re-pends compliance", async () => {
    // A real server returns the newly-accepted write as pending its own
    // validation and rollout, not already compliant.
    const updated = policy({
      policyVersion: 2,
      serverValidation: "pending",
      rollout: { status: "not-started" },
    });
    global.fetch = mockBackend({ updatedPolicy: updated });
    const onSaved = jest.fn();
    renderPanel({ onSaved });

    fireEvent.click(screen.getByLabelText("proofs in us-west"));
    fireEvent.click(screen.getByRole("button", { name: /save policy/i }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/saved residency policy version 2/i),
    );
    expect(screen.getByTestId("residency-version")).toHaveTextContent("Version 2");
    expect(screen.getByTestId("compliance-status")).toHaveTextContent("Not yet compliant");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith(updated);

    const calls = (global.fetch as jest.Mock).mock.calls;
    const updateCall = calls.find(([url, init]) => url.endsWith("/data-residency-policy") && init.method === "PUT");
    expect(updateCall).toBeDefined();
    expect((updateCall![1].headers as Record<string, string>)["If-Match"]).toBe("1");
  });

  it("rejects a stale version on a 409 conflict and adopts the server's current policy", async () => {
    const serverCurrent = policy({ policyVersion: 6 });
    global.fetch = mockBackend({ conflictEntity: serverCurrent });
    const onSaved = jest.fn();
    renderPanel({ onSaved });

    fireEvent.click(screen.getByLabelText("proofs in us-west"));
    fireEvent.click(screen.getByRole("button", { name: /save policy/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/changed on the server since you loaded it/i),
    );
    expect(screen.getByTestId("residency-version")).toHaveTextContent("Version 6");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("keeps unsupported regions and incomplete migrations blocked even when the server-side preview reports them", async () => {
    global.fetch = mockBackend({
      previewBlockers: [
        { dataClass: "proofs", region: "us-east", message: "proofs migration to us-west is still running server-side." },
      ],
    });
    const onSaved = jest.fn();
    renderPanel({ onSaved });

    fireEvent.click(screen.getByLabelText("backups in eu-west"));
    fireEvent.click(screen.getByRole("button", { name: /save policy/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/still running server-side/i),
    );
    expect(onSaved).not.toHaveBeenCalled();
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls.some(([url, init]) => url.endsWith("/data-residency-policy") && init.method === "PUT")).toBe(
      false,
    );
  });

  it("does not warn or crash when unmounted while a save is in flight (cancellation)", async () => {
    let resolvePreview: (value: Response) => void = () => {};
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.endsWith("/preview")) {
        return new Promise<Response>((resolve) => {
          resolvePreview = resolve;
        });
      }
      return Promise.reject(new Error("should not reach update"));
    });

    const { unmount } = renderPanel();
    fireEvent.click(screen.getByLabelText("proofs in us-west"));
    fireEvent.click(screen.getByRole("button", { name: /save policy/i }));

    unmount();
    resolvePreview(jsonResponse({ issues: [], blockers: [] }));

    await Promise.resolve();
    await Promise.resolve();
  });

  it("compares an earlier version and rolls back to it", () => {
    const earlier = policy({ policyVersion: 1, backgroundJobRegion: "eu-west" });
    renderPanel({
      initialPolicy: policy({ policyVersion: 3, backgroundJobRegion: "us-east" }),
      initialHistory: [earlier],
    });

    fireEvent.change(screen.getByLabelText(/compare with current version/i), {
      target: { value: "1" },
    });
    expect(screen.getByText(/backgroundJobRegion/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /roll back to version 1/i }));
    expect(screen.getByLabelText(/background job region/i)).toHaveValue("eu-west");
  });

  it("loads the real policy and history from the backend on mount when no initialPolicy is given", async () => {
    const readPolicy = policy({ policyVersion: 9 });
    global.fetch = mockBackend({ readPolicy, history: [] });

    render(<DataResidencyPolicyPanel organizationId="org-1" token="test-token" viewerRole="OWNER" />);

    await waitFor(() => expect(screen.getByTestId("residency-version")).toHaveTextContent("Version 9"));
  });

  it("shows a load error instead of silently falling back to a fixture when the backend read fails", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    render(<DataResidencyPolicyPanel organizationId="org-1" token="test-token" viewerRole="OWNER" />);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not load/i));
  });

  it("invalidates tenant state and reloads from scratch when organizationId switches, never showing the previous org's policy", async () => {
    const orgOnePolicy = policy({ policyVersion: 1, backgroundJobRegion: "us-east" });
    const orgTwoPolicy = policy({ policyVersion: 1, backgroundJobRegion: "eu-west" });
    let currentOrg = "org-1";
    global.fetch = jest.fn().mockImplementation((url: string, init: RequestInit = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (url.endsWith("/data-residency-policy/history")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.endsWith("/data-residency-policy") && method === "GET") {
        return Promise.resolve(jsonResponse(currentOrg === "org-1" ? orgOnePolicy : orgTwoPolicy));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${method} ${url}`));
    });

    const { rerender } = render(
      <DataResidencyPolicyPanel organizationId="org-1" token="test-token" viewerRole="OWNER" />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/background job region/i)).toHaveValue("us-east"),
    );

    currentOrg = "org-2";
    rerender(<DataResidencyPolicyPanel organizationId="org-2" token="test-token" viewerRole="OWNER" />);

    // The previous organization's policy must not still be visible while
    // the new one loads.
    expect(screen.queryByLabelText(/background job region/i)).toBeNull();

    await waitFor(() =>
      expect(screen.getByLabelText(/background job region/i)).toHaveValue("eu-west"),
    );
  });

  it("polls rollout/migration status and updates it without disturbing the rest of the policy", async () => {
    jest.useFakeTimers({ advanceTimers: true });
    const readPolicy = policy({ policyVersion: 4 });
    global.fetch = mockBackend({
      readPolicy,
      history: [],
      rolloutStatus: {
        migration: { ...readPolicy.migration, proofs: "in-progress" },
        rollout: { status: "in-progress" },
        serverValidation: "accepted",
      },
    });

    render(<DataResidencyPolicyPanel organizationId="org-1" token="test-token" viewerRole="OWNER" />);

    await waitFor(() => expect(screen.getByTestId("residency-version")).toHaveTextContent("Version 4"));
    expect(screen.getByTestId("compliance-status")).toHaveTextContent("Compliant");

    await act(async () => {
      jest.advanceTimersByTime(31 * 1000);
    });

    await waitFor(() =>
      expect(screen.getByTestId("compliance-status")).toHaveTextContent(/proofs migration is in-progress/i),
    );
    // The version/placements the poll doesn't touch stay as they were.
    expect(screen.getByTestId("residency-version")).toHaveTextContent("Version 4");
  });
});
