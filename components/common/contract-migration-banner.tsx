"use client";

/**
 * Contract successor migration readiness banner (#266).
 *
 * Three exports:
 *   - `ContractMigrationBanner`      — presentational, prop-driven.
 *   - `ContractMigrationStatusBanner`— self-loading wrapper mounted in the
 *                                      root layout.
 *   - `ContractMigrationActionGate`  — disables an affected action (with a
 *                                      reason) while preserving read-only
 *                                      access.
 *
 * The banner is network-aware: when the browser is offline it says so, and it
 * never claims the displayed migration state is current while disconnected.
 */

import { useEffect, useRef, useState } from "react";
import { useNetworkStatus } from "@/lib/network";
import {
  canPerform,
  fetchContractMigrationStatus,
  isMigrationStatusFresh,
  migrationBannerCopy,
  migrationGateReason,
  isMigrationStatusForCurrentNetwork,
  resolveStatusPageLink,
  resolveSuccessorGuideLink,
  type ContractMigrationStatus,
  type MigrationCapability,
} from "@/lib/api/contract-migration";

export interface ContractMigrationBannerProps {
  status: ContractMigrationStatus | null | undefined;
  className?: string;
  /**
   * Whether the status is fresh enough to authorize a successor redirect.
   * Defaults to `true` so every existing caller that passes a status it
   * already trusts (tests, and any future prop-driven usage) keeps working
   * unchanged. `ContractMigrationStatusBanner` is the one caller that ever
   * passes `false` — once its polled status has gone stale, the banner
   * keeps gating writes from it but stops offering a successor link until
   * the status is revalidated.
   */
  successorTrustAllowed?: boolean;
}

function toneClasses(tone: "warning" | "danger"): string {
  return tone === "danger"
    ? "border-rose-300/40 bg-rose-300/10 text-rose-100"
    : "border-amber-300/40 bg-amber-300/10 text-amber-100";
}

export function ContractMigrationBanner({
  status,
  className = "",
  successorTrustAllowed = true,
}: ContractMigrationBannerProps) {
  const { isOnline } = useNetworkStatus();
  const copy = migrationBannerCopy(status);

  if (!copy) {
    return null;
  }

  // Computed independent of `successorTrustAllowed` so a stale-but-verified
  // successor can be told apart from one that was never verified at all.
  const trustedSuccessorLink = resolveSuccessorGuideLink(status);
  const successorLink = successorTrustAllowed ? trustedSuccessorLink : null;
  const statusPageLink = resolveStatusPageLink(status);
  const successor = status?.successor;
  const showStaleSuccessorNote = Boolean(trustedSuccessorLink) && !successorTrustAllowed;
  const showUnverifiedSuccessorNote =
    Boolean(successor) && !trustedSuccessorLink;

  return (
    <div
      role={copy.tone === "danger" ? "alert" : "status"}
      aria-live={copy.tone === "danger" ? "assertive" : "polite"}
      aria-atomic="true"
      className={`rounded-lg border px-4 py-3 text-sm ${toneClasses(copy.tone)} ${className}`}
    >
      <p className="font-semibold">{copy.title}</p>
      <p className="mt-1">{copy.detail}</p>

      {copy.readOnly ? (
        <p className="mt-1 font-medium">
          Read-only access is preserved during the migration.
        </p>
      ) : null}

      {!isOnline ? (
        <p className="mt-1 text-xs opacity-90">
          You are offline. This migration status may be out of date until you
          reconnect.
        </p>
      ) : null}

      {successorLink || statusPageLink ? (
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {successorLink ? (
            <a
              className="font-medium underline underline-offset-2"
              href={successorLink.href}
              rel="noopener noreferrer"
              target="_blank"
            >
              {successorLink.label}
            </a>
          ) : null}
          {statusPageLink ? (
            <a
              className="font-medium underline underline-offset-2"
              href={statusPageLink.href}
              rel="noopener noreferrer"
              target="_blank"
            >
              {statusPageLink.label}
            </a>
          ) : null}
        </p>
      ) : null}

      {showStaleSuccessorNote ? (
        <p className="mt-2 text-xs opacity-90" data-testid="stale-successor-note">
          A verified successor contract is listed, but this status needs to
          be refreshed before this app will link to it automatically.
        </p>
      ) : null}

      {showUnverifiedSuccessorNote ? (
        <p className="mt-2 text-xs opacity-90">
          A successor contract is listed but has not been verified — this app
          will not link to it automatically.
        </p>
      ) : null}
    </div>
  );
}

export interface ContractMigrationStatusBannerProps {
  /** Optional pre-resolved status; when omitted the banner self-loads it. */
  initialStatus?: ContractMigrationStatus | null;
  /**
   * How often to re-check the migration status while mounted. Defaults to
   * 2 minutes. Exposed for tests; production code should not need to pass
   * this.
   */
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2 * 60 * 1000;

type MigrationStatusSnapshot = {
  status: ContractMigrationStatus | null;
  /** When `status` was last confirmed fresh by the backend, or `null` if never. */
  fetchedAt: number | null;
  etag: string | null;
};

/**
 * Self-loading banner intended for the root layout. It fetches the real
 * migration status (`fetchContractMigrationStatus`, #308 — never the mock
 * fixture) on mount and then polls on an interval while mounted.
 *
 * Critical fail-safe: a poll failure (network error, timeout, unauthorized,
 * malformed/untrusted response) NEVER clears a previously-known status. If
 * it did, a transient backend outage during an active "migrating" phase
 * would silently fall back to `canPerform(null, "write")`, which is
 * permissive — i.e. it would incorrectly *re-enable* writes that should
 * stay blocked. Instead the last known-good status keeps gating the UI, and
 * only its *freshness* (not its presence) degrades, which in turn only
 * affects whether a successor link may be offered (see
 * `isMigrationStatusFresh` / `successorTrustAllowed` above) — never whether
 * reads/writes are gated.
 */
export function ContractMigrationStatusBanner({
  initialStatus = null,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: ContractMigrationStatusBannerProps) {
  const [snapshot, setSnapshot] = useState<MigrationStatusSnapshot>(() => ({
    status: initialStatus,
    fetchedAt: initialStatus ? Date.now() : null,
    etag: null,
  }));
  const etagRef = useRef<string | null>(null);

  useEffect(() => {
    if (initialStatus) {
      // A pre-resolved status was supplied by the caller; this component
      // never second-guesses it with its own polling.
      return;
    }

    let cancelled = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      controller = new AbortController();
      try {
        const result = await fetchContractMigrationStatus({
          signal: controller.signal,
          etag: etagRef.current,
        });
        if (cancelled) return;

        if (result.kind === "fresh") {
          etagRef.current = result.etag;
          setSnapshot({ status: result.status, fetchedAt: Date.now(), etag: result.etag });
        } else {
          // 304: the last known status is still correct, just revalidated.
          setSnapshot((previous) =>
            previous.status ? { ...previous, fetchedAt: Date.now() } : previous,
          );
        }
      } catch {
        if (cancelled) return;
        // Fail-safe, not fail-closed-to-null: see the function doc above.
        // `status`/`fetchedAt` are deliberately left untouched — but a new
        // object reference still triggers a re-render, which is what lets
        // `successorTrustAllowed` (computed from `Date.now()` at render
        // time) actually recognize that the status has aged past
        // `MIGRATION_STATUS_MAX_AGE_MS` even though every poll since has
        // failed and produced no new data to set.
        setSnapshot((previous) => ({ ...previous }));
      } finally {
        if (!cancelled) {
          timer = setTimeout(poll, pollIntervalMs);
        }
      }
    }

    void poll();

    return () => {
      cancelled = true;
      controller?.abort();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [initialStatus, pollIntervalMs]);

  const successorTrustAllowed = isMigrationStatusFresh(snapshot.fetchedAt);

  return (
    <ContractMigrationBanner
      className="mx-4 my-2 sm:mx-12"
      status={snapshot.status}
      successorTrustAllowed={successorTrustAllowed}
    />
  );
}

export interface ContractMigrationActionGateProps {
  status: ContractMigrationStatus | null | undefined;
  capability: MigrationCapability;
  children: React.ReactNode;
  /** Rendered instead of `children` when the action is gated. */
  fallback?: React.ReactNode;
}

/**
 * Renders `children` when the capability is available, otherwise a disabled
 * notice. Reads are always allowed; writes are gated from "migrating" onward.
 */
export function ContractMigrationActionGate({
  status,
  capability,
  children,
  fallback,
}: ContractMigrationActionGateProps) {
  if (canPerform(status, capability)) {
    return <>{children}</>;
  }

  if (fallback !== undefined) {
    return <>{fallback}</>;
  }

  return (
    <p className="rounded-md border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">
      {migrationGateReason(status) ??
        "This action is unavailable while the contract migrates."}
    </p>
  );
}

/**
 * True when a status document cannot be trusted for this network/schema, so
 * callers can surface a "status unavailable" state instead of the standard
 * banner copy.
 */
export function isMigrationStatusStale(
  status: ContractMigrationStatus | null | undefined,
): boolean {
  if (!status) {
    return false;
  }
  return !isMigrationStatusForCurrentNetwork(status);
}
