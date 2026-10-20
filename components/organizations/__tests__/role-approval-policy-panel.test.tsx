import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  defaultRoleApprovalPolicy,
  type RoleApprovalPolicy,
} from "@/lib/api/organization-role-approval-policy";
import { RoleApprovalPolicyPanel } from "../role-approval-policy-panel";

function policy(overrides: Partial<RoleApprovalPolicy> = {}): RoleApprovalPolicy {
  return { ...defaultRoleApprovalPolicy(), ...overrides };
}

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof RoleApprovalPolicyPanel>> = {},
) {
  return render(
    <RoleApprovalPolicyPanel
      initialPolicy={policy()}
      organizationId="org-1"
      token="test-token"
      viewerRole="OWNER"
      {...overrides}
    />,
  );
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return {
    ok: true,
    status: init.status ?? 200,
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

function conflictResponse(currentEntity: unknown): Response {
  return {
    ok: false,
    status: 409,
    json: async () => ({
      message: "Conflict",
      currentEntity,
      submittedData: {},
    }),
    headers: { get: () => null },
  } as unknown as Response;
}

/**
 * Builds a `global.fetch` mock that understands the three calls a save can
 * make: the preview POST, the conditional PUT update, and (if no
 * `initialPolicy` is supplied) the initial GET read + history calls.
 */
function mockBackend(options: {
  previewIssues?: Array<{ field: string; message: string; severity: "error" | "warning" }>;
  updatedPolicy?: RoleApprovalPolicy;
  conflictEntity?: RoleApprovalPolicy;
  readPolicy?: RoleApprovalPolicy;
  history?: RoleApprovalPolicy[];
}) {
  const { previewIssues = [], updatedPolicy, conflictEntity, readPolicy, history = [] } = options;

  return jest.fn().mockImplementation((url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();

    if (url.endsWith("/preview") && method === "POST") {
      return Promise.resolve(jsonResponse({ issues: previewIssues }));
    }
    if (url.endsWith("/role-approval-policy/history") && method === "GET") {
      return Promise.resolve(jsonResponse(history));
    }
    if (url.endsWith("/role-approval-policy") && method === "PUT") {
      if (conflictEntity) {
        return Promise.resolve(conflictResponse(conflictEntity));
      }
      return Promise.resolve(jsonResponse(updatedPolicy));
    }
    if (url.endsWith("/role-approval-policy") && method === "GET") {
      return Promise.resolve(jsonResponse(readPolicy));
    }
    return Promise.reject(new Error(`Unexpected fetch call: ${method} ${url}`));
  });
}

describe("RoleApprovalPolicyPanel", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("renders a read-only summary for viewers without a management role", () => {
    renderPanel({ viewerRole: "VIEWER" });
    expect(screen.getByText(/read-only access to this policy/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save policy/i })).toBeNull();
    expect(screen.getByLabelText("OWNER")).toBeDisabled();
  });

  it("shows a sign-in state, never the editor, when there is no token and no pre-loaded policy", () => {
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

  it("shows the management controls for an owner", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: /save policy/i })).toBeEnabled();
    expect(screen.getByTestId("policy-version")).toHaveTextContent("Version 1");
  });

  it("blocks removing approval from a role that must always require it", () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText("OWNER"));
    expect(screen.getByText(/OWNER role changes must always require approval/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save policy/i })).toBeDisabled();
  });

  it("blocks an approvals count below the server minimum", () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText(/independent approvals required/i), {
      target: { value: "0" },
    });
    expect(screen.getByText(/at least 1 independent approval/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save policy/i })).toBeDisabled();
  });

  it("blocks a request validity outside the allowed bounds", () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText(/request validity/i), {
      target: { value: "9999" },
    });
    expect(screen.getByText(/at most 720 hours/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save policy/i })).toBeDisabled();
  });

  it("blocks enabling self-approval when the server forbids it", () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText(/allow requesters to approve their own requests/i));
    expect(screen.getByText(/self-approval is not permitted/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save policy/i })).toBeDisabled();
  });

  it("never calls the network for a change that fails client-side validation", () => {
    global.fetch = jest.fn();
    renderPanel();
    fireEvent.click(screen.getByLabelText("OWNER"));
    fireEvent.click(screen.getByRole("button", { name: /save policy/i }));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("previews a relaxation in the impact panel", () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText("ADMIN"));
    expect(screen.getByText(/relaxes the current policy/i)).toBeInTheDocument();
    expect(screen.getByText(/no longer be required for: ADMIN/i)).toBeInTheDocument();
  });

  it("does not claim the policy was saved until the server confirms it", async () => {
    const updated = policy({ policyVersion: 2 });
    global.fetch = mockBackend({ updatedPolicy: updated });
    renderPanel();

    fireEvent.click(screen.getByLabelText("ADMIN"));
    fireEvent.click(screen.getByRole("button", { name: /save policy/i }));

    // Immediately after the click, before any network call resolves, the
    // panel must not say "saved" yet.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/saved policy version 2/i));
    expect(screen.getByTestId("policy-version")).toHaveTextContent("Version 2");
  });

  it("saves a valid change, increments the version, calls the server, and reports success", async () => {
    const updated = policy({ policyVersion: 2 });
    global.fetch = mockBackend({ updatedPolicy: updated });
    const onSaved = jest.fn();
    renderPanel({ onSaved });

    fireEvent.click(screen.getByLabelText("ADMIN"));
    fireEvent.click(screen.getByRole("button", { name: /save policy/i }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/saved policy version 2/i));
    expect(screen.getByTestId("policy-version")).toHaveTextContent("Version 2");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith(updated);

    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls.some(([url, init]) => url.endsWith("/preview") && init.method === "POST")).toBe(true);
    const updateCall = calls.find(([url, init]) => url.endsWith("/role-approval-policy") && init.method === "PUT");
    expect(updateCall).toBeDefined();
    expect((updateCall![1].headers as Record<string, string>)["If-Match"]).toBe("1");
  });

  it("rejects a stale version on a 409 conflict and adopts the server's current policy instead of overwriting it", async () => {
    const serverCurrent = policy({ policyVersion: 5, approvalsRequired: 3 });
    global.fetch = mockBackend({ conflictEntity: serverCurrent });
    const onSaved = jest.fn();
    renderPanel({ onSaved });

    fireEvent.click(screen.getByLabelText("ADMIN"));
    fireEvent.click(screen.getByRole("button", { name: /save policy/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/changed on the server since you loaded it/i),
    );
    // The server's real current version is adopted, never silently overwritten.
    expect(screen.getByTestId("policy-version")).toHaveTextContent("Version 5");
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("preserves server-enforced minimums surfaced only by the preview endpoint", async () => {
    global.fetch = mockBackend({
      previewIssues: [
        { field: "approvalsRequired", message: "This organization requires 3 approvals minimum.", severity: "error" },
      ],
    });
    const onSaved = jest.fn();
    renderPanel({ onSaved });

    fireEvent.click(screen.getByLabelText("ADMIN"));
    fireEvent.click(screen.getByRole("button", { name: /save policy/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/would weaken a server-enforced minimum/i),
    );
    expect(onSaved).not.toHaveBeenCalled();
    // The update endpoint must never be reached once preview blocks the save.
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls.some(([url, init]) => url.endsWith("/role-approval-policy") && init.method === "PUT")).toBe(
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
    fireEvent.click(screen.getByLabelText("ADMIN"));
    fireEvent.click(screen.getByRole("button", { name: /save policy/i }));

    unmount();
    resolvePreview(jsonResponse({ issues: [] }));

    // Flush pending microtasks; no assertion other than "this doesn't throw".
    await Promise.resolve();
    await Promise.resolve();
  });

  it("discards draft changes back to the saved policy", () => {
    global.fetch = jest.fn();
    renderPanel();
    fireEvent.click(screen.getByLabelText("ADMIN"));
    expect(screen.getByText(/relaxes the current policy/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /discard changes/i }));
    expect(screen.getByText(/at least as strict as the current policy/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("compares an earlier version and rolls back to it", () => {
    const earlier = policy({ policyVersion: 1, approvalsRequired: 4 });
    renderPanel({
      initialPolicy: policy({ policyVersion: 3, approvalsRequired: 2 }),
      initialHistory: [earlier],
    });

    fireEvent.change(screen.getByLabelText(/compare with current version/i), {
      target: { value: "1" },
    });
    expect(screen.getByText(/approvalsRequired/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /roll back to version 1/i }));
    expect(screen.getByLabelText(/independent approvals required/i)).toHaveValue(4);
  });

  it("loads the real policy and history from the backend on mount when no initialPolicy is given", async () => {
    const readPolicy = policy({ policyVersion: 7 });
    const history = [policy({ policyVersion: 6 })];
    global.fetch = mockBackend({ readPolicy, history });

    render(
      <RoleApprovalPolicyPanel organizationId="org-1" token="test-token" viewerRole="OWNER" />,
    );

    await waitFor(() => expect(screen.getByTestId("policy-version")).toHaveTextContent("Version 7"));
    fireEvent.change(screen.getByLabelText(/compare with current version/i), {
      target: { value: "6" },
    });
    expect(screen.getByText(/Version 6/)).toBeInTheDocument();
  });

  it("shows a load error instead of silently falling back to a fixture when the backend read fails", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    render(
      <RoleApprovalPolicyPanel organizationId="org-1" token="test-token" viewerRole="OWNER" />,
    );

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not load/i));
  });
});
