"use client";

/**
 * Organization data-residency policy controls (#277, connected to the
 * backend in #310).
 *
 * Lets an OWNER/ADMIN review and change the allowed storage/processing regions
 * per data class plus the background-job region, preview the migration impact
 * against the server, compare/roll back versions, and see the *exact*
 * compliance state. Saving is conditional (`If-Match`) and only ever commits
 * once the server confirms it — see `handleSave` below and
 * `lib/api/organization-data-residency.ts`'s module doc for the full
 * read/preview/update/history/rollout-status client.
 *
 * The panel never implies compliance before the server has validated the
 * policy and every data class has migrated: it renders the reasons from
 * `computeComplianceStatus()` verbatim.
 *
 * Switching `organizationId` (or the deployment identity) invalidates any
 * tenant-scoped cache entry and reloads from scratch — never the previous
 * organization's/environment's policy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DATA_CLASSES,
  PROCESSING_REGIONS,
  applyResidencyUpdate,
  buildResidencyRollbackDraft,
  canManageDataResidencyPolicy,
  compareResidencyVersions,
  computeComplianceStatus,
  fetchDataResidencyPolicy,
  fetchDataResidencyRolloutStatus,
  invalidateDataResidencyPolicyCache,
  isDataResidencyPolicyConflict,
  isRegionSupportedForClass,
  isWellFormedDataResidencyPolicy,
  previewResidencyPolicyUpdate,
  summarizeResidencyImpact,
  updateDataResidencyPolicy,
  validateResidencyPolicy,
  type DataClass,
  type DataResidencyPolicy,
  type ProcessingRegion,
  type ResidencyViewerRole,
} from "@/lib/api/organization-data-residency";

const ROLLOUT_POLL_INTERVAL_MS = 30 * 1000;

export interface DataResidencyPolicyPanelProps {
  organizationId: string;
  viewerRole: ResidencyViewerRole | null | undefined;
  /**
   * Bearer token for API requests. Without one, management actions are
   * disabled even for an OWNER/ADMIN `viewerRole` — reads still work if
   * `initialPolicy` was supplied by the caller.
   */
  token?: string | null;
  initialPolicy?: DataResidencyPolicy;
  initialHistory?: DataResidencyPolicy[];
  onSaved?: (policy: DataResidencyPolicy) => void;
}

export function DataResidencyPolicyPanel({
  organizationId,
  viewerRole,
  token = null,
  initialPolicy,
  initialHistory = [],
  onSaved,
}: DataResidencyPolicyPanelProps) {
  const canManage = canManageDataResidencyPolicy(viewerRole) && Boolean(token);

  const [policy, setPolicy] = useState<DataResidencyPolicy | null>(initialPolicy ?? null);
  const [history, setHistory] = useState<DataResidencyPolicy[]>(initialHistory);
  const [draft, setDraft] = useState<DataResidencyPolicy | null>(initialPolicy ?? null);
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

  // A switch to a different organization must never keep showing the
  // previous tenant's policy while the new one loads. This is the "adjust
  // state during render" pattern (see react.dev "You Might Not Need an
  // Effect"), not an effect, so the stale policy for the old organization
  // is never committed to the DOM even for one paint.
  const [activeOrganizationId, setActiveOrganizationId] = useState(organizationId);
  if (organizationId !== activeOrganizationId) {
    setActiveOrganizationId(organizationId);
    if (!initialPolicy) {
      setPolicy(null);
      setDraft(null);
      setHistory([]);
    }
    setLoadError(null);
    setSaveError(null);
    setSavedNotice(null);
  }

  useEffect(() => {
    if (initialPolicy || !token) {
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetchDataResidencyPolicy(token, organizationId, controller.signal);
        if (cancelled) return;
        setPolicy(response.policy);
        setDraft(response.policy);
        setHistory(response.history);
        setLoadError(null);
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        setLoadError("Could not load the data residency policy. Try again.");
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [initialPolicy, organizationId, token]);

  // Polls just rollout/migration progress while the panel is mounted, so a
  // long-running region migration's status doesn't need a full policy
  // reload to stay current. A no-op (via the functional updater below)
  // whenever no policy is loaded yet.
  useEffect(() => {
    if (!token) {
      return;
    }
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const status = await fetchDataResidencyRolloutStatus(
            token,
            organizationId,
            new AbortController().signal,
          );
          if (cancelled) return;
          setPolicy((current) =>
            current
              ? {
                  ...current,
                  migration: status.migration,
                  rollout: status.rollout,
                  serverValidation: status.serverValidation,
                }
              : current,
          );
        } catch {
          // Fail-safe: leave the last known rollout/migration state as is.
        }
      })();
    }, ROLLOUT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token, organizationId]);

  const handleSave = useCallback(async () => {
    if (!policy || !draft || !token || isSaving) {
      return;
    }

    // Cheap client-side pre-check (unsupported regions, incomplete
    // migrations, stale version) before ever touching the network.
    const localPrecheck = applyResidencyUpdate({
      current: policy,
      draft,
      expectedVersion: policy.policyVersion,
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
      const preview = await previewResidencyPolicyUpdate(
        token,
        organizationId,
        policy,
        draft,
        controller.signal,
      );
      const blocking =
        preview.issues.some((issue) => issue.severity === "error") || preview.blockers.length > 0;
      if (blocking) {
        if (mountedRef.current) {
          setSaveError(
            preview.blockers.length > 0
              ? preview.blockers.map((blocker) => blocker.message).join(" ")
              : "This policy selects a region that cannot store the chosen data.",
          );
        }
        return;
      }

      const updated = await updateDataResidencyPolicy(
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
      setSavedNotice(`Saved residency policy version ${updated.policyVersion}.`);
      onSaved?.(updated);
    } catch (error) {
      if (!mountedRef.current) return;
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      if (isDataResidencyPolicyConflict(error)) {
        const serverPolicy = error.serverEntity;
        if (isWellFormedDataResidencyPolicy(serverPolicy)) {
          setPolicy(serverPolicy);
          setDraft(serverPolicy);
        }
        invalidateDataResidencyPolicyCache(organizationId);
        setSaveError(
          "This residency policy changed on the server since you loaded it. The latest version has been loaded above — review and save again.",
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
  }, [draft, isSaving, onSaved, organizationId, policy, token]);

  const issues = useMemo(() => (draft ? validateResidencyPolicy(draft) : []), [draft]);
  const errors = issues.filter((issue) => issue.severity === "error");
  const impact = useMemo(
    () => (policy && draft ? summarizeResidencyImpact(policy, draft) : null),
    [policy, draft],
  );
  const compliance = useMemo(() => (policy ? computeComplianceStatus(policy) : null), [policy]);

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
          Sign in to view this organization&apos;s data residency policy.
        </section>
      );
    }
    return (
      <section
        aria-busy="true"
        className="rounded-lg border border-white/10 bg-white/[0.04] p-5 text-sm text-slate-300"
      >
        Loading data residency policy…
      </section>
    );
  }

  const toggleRegion = (dataClass: DataClass, region: ProcessingRegion, selected: boolean) => {
    setSavedNotice(null);
    setDraft((current) => {
      if (!current) return current;
      const existing = current.placements[dataClass] ?? [];
      const nextRegions = selected
        ? [...existing, region]
        : existing.filter((candidate) => candidate !== region);
      return {
        ...current,
        placements: { ...current.placements, [dataClass]: nextRegions },
      };
    });
  };

  const compareVersion =
    compareTarget === null
      ? null
      : history.find((entry) => entry.policyVersion === compareTarget) ?? null;
  const comparison = compareVersion ? compareResidencyVersions(compareVersion, policy) : [];

  return (
    <section
      aria-labelledby="data-residency-heading"
      className="grid gap-6 rounded-lg border border-white/10 bg-white/[0.04] p-5"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-white" id="data-residency-heading">
            Data residency policy
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Choose the allowed storage and processing regions for each data class and for background jobs.
          </p>
        </div>
        <p className="text-xs text-slate-400" data-testid="residency-version">
          Version {policy.policyVersion} · updated {policy.updatedAt}
        </p>
      </header>

      <p className="text-xs text-slate-500">Organization {organizationId}</p>

      {compliance ? (
        <div
          className={`rounded-lg border p-3 text-sm ${
            compliance.status === "compliant"
              ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-100"
              : "border-amber-300/40 bg-amber-300/10 text-amber-100"
          }`}
          data-testid="compliance-status"
        >
          <p className="font-semibold">
            {compliance.status === "compliant"
              ? "Compliant"
              : "Not yet compliant"}
          </p>
          {compliance.reasons.length > 0 ? (
            <ul className="mt-1 grid gap-1">
              {compliance.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 text-xs">
            Rollout: {policy.rollout.status}. Server validation: {policy.serverValidation}.
          </p>
        </div>
      ) : null}

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

      <div className="grid gap-5">
        {DATA_CLASSES.map((dataClass) => (
          <fieldset className="grid gap-2" disabled={!canManage} key={dataClass}>
            <legend className="text-sm font-semibold text-slate-200">{dataClass}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {PROCESSING_REGIONS.map((region) => {
                const supported = isRegionSupportedForClass(region, dataClass);
                const selected = (draft.placements[dataClass] ?? []).includes(region);
                const disabled = !canManage || (!supported && !selected);
                return (
                  <label
                    className={`flex items-center gap-2 text-sm ${
                      disabled ? "text-slate-500" : "text-slate-300"
                    }`}
                    key={`${dataClass}:${region}`}
                    title={
                      supported
                        ? undefined
                        : `${region} cannot store ${dataClass} in this environment.`
                    }
                  >
                    <input
                      checked={selected}
                      disabled={disabled}
                      onChange={(event) => toggleRegion(dataClass, region, event.target.checked)}
                      type="checkbox"
                    />
                    <span>{`${dataClass} in ${region}`}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      <label className="grid gap-1 text-sm text-slate-300">
        <span>Background job region</span>
        <select
          className="h-9 w-fit rounded-md border border-white/15 bg-slate-900/40 px-3 text-sm text-white"
          disabled={!canManage}
          onChange={(event) => {
            setSavedNotice(null);
            setDraft((current) =>
              current
                ? { ...current, backgroundJobRegion: event.target.value as ProcessingRegion }
                : current,
            );
          }}
          value={draft.backgroundJobRegion ?? ""}
        >
          <option value="">Select a region…</option>
          {PROCESSING_REGIONS.map((region) => (
            <option key={region} value={region}>
              {region}
            </option>
          ))}
        </select>
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
          <ul className="mt-2 grid gap-1 text-sm text-slate-300">
            {impact.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          {impact.blockers.length > 0 ? (
            <ul className="mt-2 grid gap-1 text-sm text-amber-100" data-testid="migration-blockers">
              {impact.blockers.map((blocker) => (
                <li key={`${blocker.dataClass}:${blocker.message}`}>{blocker.message}</li>
              ))}
            </ul>
          ) : null}
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
              className="h-9 w-fit rounded-md border border-white/15 bg-slate-900/40 px-3 text-sm text-white"
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
                onClick={() => {
                  setSaveError(null);
                  setSavedNotice(null);
                  setDraft(buildResidencyRollbackDraft(policy, compareVersion));
                }}
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
