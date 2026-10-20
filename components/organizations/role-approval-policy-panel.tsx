"use client";

/**
 * Organization role-approval policy configuration (#258, connected to the
 * backend in #309).
 *
 * Loads the current policy (and its version history) from the backend, lets
 * an OWNER/ADMIN edit it, previews the impact — first against the pure,
 * local `summarizePolicyImpact` for live feedback while editing, then
 * against the server's own preview endpoint right before saving — and
 * commits a save only once `updateRoleApprovalPolicy` resolves. The panel
 * never shows "Saved" before that: a conditional write (`If-Match` on the
 * loaded version) rejected by the server as `409 Conflict` is surfaced as a
 * stale-version error, and the server's own current policy (carried on the
 * conflict) is adopted locally so the next attempt is based on real data,
 * never silently retried or overwritten.
 *
 * Viewers without a management role see a read-only summary. All gating
 * here is UX only; the server re-validates every write.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_ROLE_APPROVAL_MINIMUMS,
  ORGANIZATION_ROLES,
  applyPolicyUpdate,
  buildRollbackDraft,
  canManageRoleApprovalPolicy,
  comparePolicyVersions,
  fetchRoleApprovalPolicy,
  fetchRoleApprovalPolicyHistory,
  isRoleApprovalPolicyConflict,
  isWellFormedRoleApprovalPolicy,
  previewRoleApprovalPolicyUpdate,
  summarizePolicyImpact,
  updateRoleApprovalPolicy,
  validateRoleApprovalPolicy,
  type OrganizationRole,
  type RoleApprovalMinimums,
  type RoleApprovalPolicy,
} from "@/lib/api/organization-role-approval-policy";

export interface RoleApprovalPolicyPanelProps {
  organizationId: string;
  viewerRole: OrganizationRole | null | undefined;
  /**
   * Bearer token for API requests. Without one, management actions are
   * disabled even for an OWNER/ADMIN `viewerRole` (there is no session to
   * authenticate the write with) — reads still work if `initialPolicy` was
   * supplied by the caller.
   */
  token?: string | null;
  /** Pre-loaded policy; when omitted the panel loads it from the backend. */
  initialPolicy?: RoleApprovalPolicy;
  initialHistory?: RoleApprovalPolicy[];
  minimums?: RoleApprovalMinimums;
  onSaved?: (policy: RoleApprovalPolicy) => void;
}

export function RoleApprovalPolicyPanel({
  organizationId,
  viewerRole,
  token = null,
  initialPolicy,
  initialHistory = [],
  minimums = DEFAULT_ROLE_APPROVAL_MINIMUMS,
  onSaved,
}: RoleApprovalPolicyPanelProps) {
  const canManage = canManageRoleApprovalPolicy(viewerRole) && Boolean(token);

  const [policy, setPolicy] = useState<RoleApprovalPolicy | null>(initialPolicy ?? null);
  const [history, setHistory] = useState<RoleApprovalPolicy[]>(initialHistory);
  const [draft, setDraft] = useState<RoleApprovalPolicy | null>(initialPolicy ?? null);
  const [compareTarget, setCompareTarget] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const mountedRef = useRef(true);
  const pendingControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (initialPolicy || !token) {
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const [loadedPolicy, loadedHistory] = await Promise.all([
          fetchRoleApprovalPolicy(token, organizationId, controller.signal),
          fetchRoleApprovalPolicyHistory(token, organizationId, controller.signal),
        ]);
        if (cancelled) return;
        setPolicy(loadedPolicy);
        setDraft(loadedPolicy);
        setHistory(loadedHistory);
        setLoadError(null);
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        setLoadError("Could not load the role approval policy. Try again.");
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [initialPolicy, organizationId, token]);

  const handleSave = useCallback(async () => {
    if (!policy || !draft || !token || isSaving) {
      return;
    }

    // Cheap client-side pre-check before ever touching the network — never
    // claims success from this alone.
    const localPrecheck = applyPolicyUpdate({
      current: policy,
      draft,
      expectedVersion: policy.policyVersion,
      viewerRole,
      minimums,
    });
    if (!localPrecheck.ok) {
      setSaveError(localPrecheck.message);
      setSavedNotice(null);
      return;
    }

    setIsSaving(true);
    setSaveError(null);
    setSavedNotice(null);

    const controller = new AbortController();
    pendingControllerRef.current = controller;

    try {
      const preview = await previewRoleApprovalPolicyUpdate(
        token,
        organizationId,
        policy,
        draft,
        controller.signal,
      );
      const blockingIssues = preview.issues.filter((issue) => issue.severity === "error");
      if (blockingIssues.length > 0) {
        if (mountedRef.current) {
          setSaveError("This policy would weaken a server-enforced minimum.");
        }
        return;
      }

      const updated = await updateRoleApprovalPolicy(
        token,
        organizationId,
        draft,
        policy.policyVersion,
        controller.signal,
      );

      if (!mountedRef.current) return;
      setHistory((previous) => [policy, ...previous]);
      setPolicy(updated);
      setDraft(updated);
      setSaveError(null);
      setSavedNotice(`Saved policy version ${updated.policyVersion}.`);
      onSaved?.(updated);
    } catch (error) {
      if (!mountedRef.current) return;
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      if (isRoleApprovalPolicyConflict(error)) {
        const serverPolicy = error.serverEntity;
        if (isWellFormedRoleApprovalPolicy(serverPolicy)) {
          // The server is authoritative: adopt its current version instead
          // of leaving the editor pointed at data we now know is stale.
          setPolicy(serverPolicy);
          setDraft(serverPolicy);
        }
        setSaveError(
          "This policy changed on the server since you loaded it. The latest version has been loaded above — review and save again.",
        );
      } else {
        setSaveError(
          error instanceof Error ? error.message : "Could not save the policy. Try again.",
        );
      }
    } finally {
      if (mountedRef.current) {
        setIsSaving(false);
      }
      pendingControllerRef.current = null;
    }
  }, [draft, isSaving, minimums, onSaved, organizationId, policy, token, viewerRole]);

  const issues = useMemo(
    () => (draft ? validateRoleApprovalPolicy(draft, minimums) : []),
    [draft, minimums],
  );
  const errors = issues.filter((issue) => issue.severity === "error");
  const impact = useMemo(
    () => (policy && draft ? summarizePolicyImpact(policy, draft) : null),
    [policy, draft],
  );

  if (!policy || !draft) {
    if (loadError) {
      return (
        <section
          className="rounded-lg border border-rose-300/40 bg-rose-300/10 p-5 text-sm text-rose-100"
          role="alert"
        >
          {loadError}
        </section>
      );
    }
    if (!token) {
      return (
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5 text-sm text-slate-300">
          Sign in to view this organization&apos;s role approval policy.
        </section>
      );
    }
    return (
      <section aria-busy="true" className="rounded-lg border border-white/10 bg-white/[0.04] p-5 text-sm text-slate-300">
        Loading role approval policy…
      </section>
    );
  }

  const updateRule = (role: OrganizationRole, requiresApproval: boolean) => {
    setSavedNotice(null);
    setDraft((current) =>
      current
        ? {
            ...current,
            rules: current.rules.map((rule) =>
              rule.role === role ? { ...rule, requiresApproval } : rule,
            ),
          }
        : current,
    );
  };

  const setNumber = (field: "approvalsRequired" | "requestValidityHours", value: string) => {
    setSavedNotice(null);
    const parsed = Number.parseInt(value, 10);
    setDraft((current) =>
      current ? { ...current, [field]: Number.isNaN(parsed) ? 0 : parsed } : current,
    );
  };

  const handleRollback = (target: RoleApprovalPolicy) => {
    setSaveError(null);
    setSavedNotice(null);
    setDraft(buildRollbackDraft(policy, target));
  };

  const compareVersion =
    compareTarget === null
      ? null
      : history.find((entry) => entry.policyVersion === compareTarget) ?? null;
  const comparison = compareVersion ? comparePolicyVersions(compareVersion, policy) : [];

  return (
    <section aria-labelledby="role-approval-heading" className="grid gap-6 rounded-lg border border-white/10 bg-white/[0.04] p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-white" id="role-approval-heading">
            Role approval policy
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Choose which role changes need independent approval and how long requests stay valid.
          </p>
        </div>
        <p className="text-xs text-slate-400" data-testid="policy-version">
          Version {policy.policyVersion} · updated {policy.updatedAt}
        </p>
      </header>

      <p className="text-xs text-slate-500">
        Organization {organizationId}
      </p>

      {!canManage ? (
        <div className="rounded-lg border border-blue-300/30 bg-blue-300/10 p-4 text-sm text-blue-200">
          You have read-only access to this policy. Owners and admins can change it.
        </div>
      ) : null}

      {saveError ? (
        <div className="rounded-lg border border-rose-300/40 bg-rose-300/10 p-3 text-sm text-rose-100" role="alert">
          {saveError}
        </div>
      ) : null}

      {savedNotice ? (
        <div className="rounded-lg border border-emerald-300/40 bg-emerald-300/10 p-3 text-sm text-emerald-100" role="status">
          {savedNotice}
        </div>
      ) : null}

      <fieldset className="grid gap-2" disabled={!canManage}>
        <legend className="text-sm font-semibold text-slate-200">
          Roles requiring independent approval
        </legend>
        {ORGANIZATION_ROLES.map((role) => {
          const rule = draft.rules.find((candidate) => candidate.role === role);
          const checked = rule?.requiresApproval ?? false;
          return (
            <label className="flex items-center gap-2 text-sm text-slate-300" key={role}>
              <input
                checked={checked}
                onChange={(event) => updateRule(role, event.target.checked)}
                type="checkbox"
              />
              <span>{role}</span>
            </label>
          );
        })}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm text-slate-300">
          <span>Independent approvals required</span>
          <input
            className="h-9 rounded-md border border-white/15 bg-slate-900/40 px-3 text-sm text-white"
            disabled={!canManage}
            min={minimums.minApprovalsRequired}
            max={minimums.maxApprovalsRequired}
            onChange={(event) => setNumber("approvalsRequired", event.target.value)}
            type="number"
            value={draft.approvalsRequired}
          />
        </label>

        <label className="grid gap-1 text-sm text-slate-300">
          <span>Request validity (hours)</span>
          <input
            className="h-9 rounded-md border border-white/15 bg-slate-900/40 px-3 text-sm text-white"
            disabled={!canManage}
            min={minimums.minRequestValidityHours}
            max={minimums.maxRequestValidityHours}
            onChange={(event) => setNumber("requestValidityHours", event.target.value)}
            type="number"
            value={draft.requestValidityHours}
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input
          checked={draft.allowSelfApproval}
          disabled={!canManage}
          onChange={(event) => {
            setSavedNotice(null);
            setDraft((current) =>
              current ? { ...current, allowSelfApproval: event.target.checked } : current,
            );
          }}
          type="checkbox"
        />
        <span>Allow requesters to approve their own requests</span>
      </label>

      {errors.length > 0 ? (
        <ul className="grid gap-1 rounded-lg border border-rose-300/40 bg-rose-300/10 p-3 text-sm text-rose-100" role="alert">
          {errors.map((issue) => (
            <li key={`${issue.field}:${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      ) : null}

      {impact ? (
        <div className="rounded-lg border border-white/10 bg-slate-900/30 p-4">
          <h3 className="text-sm font-semibold text-slate-200">Impact preview</h3>
          <p className="mt-1 text-xs text-slate-400">
            {impact.strengthening ? "This change is at least as strict as the current policy." : "This change relaxes the current policy."}
          </p>
          <ul className="mt-2 grid gap-1 text-sm text-slate-300">
            {impact.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-3 rounded-lg border border-white/10 bg-slate-900/30 p-4">
        <h3 className="text-sm font-semibold text-slate-200">Version history</h3>
        {history.length === 0 ? (
          <p className="text-sm text-slate-400">No earlier versions recorded yet.</p>
        ) : (
          <label className="grid gap-1 text-sm text-slate-300">
            <span>Compare with current version</span>
            <select
              className="h-9 rounded-md border border-white/15 bg-slate-900/40 px-3 text-sm text-white"
              onChange={(event) =>
                setCompareTarget(event.target.value === "" ? null : Number(event.target.value))
              }
              value={compareTarget ?? ""}
            >
              <option value="">Select a version…</option>
              {history.map((entry) => (
                <option key={entry.policyVersion} value={entry.policyVersion}>
                  Version {entry.policyVersion} ({entry.updatedAt})
                </option>
              ))}
            </select>
          </label>
        )}

        {compareVersion ? (
          <div className="grid gap-2">
            {comparison.length === 0 ? (
              <p className="text-sm text-slate-400">No differences from the current version.</p>
            ) : (
              <ul className="grid gap-1 text-sm text-slate-300">
                {comparison.map((change) => (
                  <li key={change.field}>
                    <span className="font-mono">{change.field}</span>: {change.before} → {change.after}
                  </li>
                ))}
              </ul>
            )}
            {canManage ? (
              <button
                className="h-9 w-fit rounded-md border border-white/15 px-3 text-xs font-semibold text-slate-100 hover:bg-white/5"
                onClick={() => handleRollback(compareVersion)}
                type="button"
              >
                Roll back to version {compareVersion.policyVersion}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {canManage ? (
        <div className="flex flex-wrap gap-3">
          <button
            className="h-9 rounded-md bg-cyan-300 px-4 text-xs font-semibold text-slate-950 hover:bg-cyan-200 disabled:opacity-50"
            disabled={errors.length > 0 || isSaving}
            onClick={() => void handleSave()}
            type="button"
          >
            {isSaving ? "Saving…" : "Save policy"}
          </button>
          <button
            className="h-9 rounded-md border border-white/15 px-4 text-xs font-semibold text-slate-100 hover:bg-white/5"
            disabled={isSaving}
            onClick={() => {
              setDraft(policy);
              setSaveError(null);
              setSavedNotice(null);
            }}
            type="button"
          >
            Discard changes
          </button>
        </div>
      ) : null}
    </section>
  );
}
