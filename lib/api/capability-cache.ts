/**
 * localStorage cache for the capability document (see `capabilities.ts`
 * for the full "UX layer only" warning — it applies to everything here
 * too). Follows the persisted-value pattern documented in
 * `docs/state-management.md`: named key, explicit serialize/parse, safe
 * handling of malformed data, and — specific to this cache — explicit
 * invalidation when deployment identity changes.
 */

import {
  type CapabilityDocument,
  type DeploymentIdentity,
  deploymentIdentityChanged,
} from "@/lib/api/capabilities";

const CAPABILITY_CACHE_KEY = "earnproof_capabilities";

/**
 * How long a cached document is trusted before it's treated as stale and
 * refetched, independent of deployment identity. Capability rollouts are
 * expected to complete within minutes, not hours — a short TTL keeps a
 * "downgrade" (a capability disappearing) from being invisible for long
 * even if deployment identity never changes.
 */
export const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type CachedCapabilityEntry = {
  document: CapabilityDocument;
  identity: DeploymentIdentity;
  cachedAt: number;
  /**
   * ETag of `document`, as returned by the backend, when known. Used to
   * make a conditional (`If-None-Match`) revalidation request instead of
   * re-fetching the full body once the TTL below has elapsed. Optional so
   * entries written by the mock provider (which has no real ETag) remain
   * well-formed.
   */
  etag?: string | null;
};

function isCachedCapabilityEntry(value: unknown): value is CachedCapabilityEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CachedCapabilityEntry>;
  return (
    typeof candidate.cachedAt === "number" &&
    !!candidate.document &&
    typeof candidate.document === "object" &&
    !!candidate.identity &&
    typeof candidate.identity === "object"
  );
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Storage can throw (private browsing, disabled storage, etc.) — the
    // cache is a pure optimization, so treat that the same as "no cache".
    return null;
  }
}

export function readCapabilityCache(): CachedCapabilityEntry | null {
  const storage = getStorage();
  if (!storage) return null;

  const raw = storage.getItem(CAPABILITY_CACHE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!isCachedCapabilityEntry(parsed)) {
      storage.removeItem(CAPABILITY_CACHE_KEY);
      return null;
    }
    return parsed;
  } catch {
    storage.removeItem(CAPABILITY_CACHE_KEY);
    return null;
  }
}

export function writeCapabilityCache(entry: CachedCapabilityEntry): void {
  const storage = getStorage();
  if (!storage) return;

  try {
    storage.setItem(CAPABILITY_CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Quota exceeded or storage unavailable mid-write — non-fatal, the
    // document just won't be cached for next load.
  }
}

export function clearCapabilityCache(): void {
  const storage = getStorage();
  if (!storage) return;
  storage.removeItem(CAPABILITY_CACHE_KEY);
}

export function isCapabilityCacheFresh(
  entry: CachedCapabilityEntry,
  currentIdentity: DeploymentIdentity,
  now: number = Date.now(),
): boolean {
  if (deploymentIdentityChanged(entry.identity, currentIdentity)) {
    return false;
  }

  const age = now - entry.cachedAt;
  if (age < 0) {
    // Clock skew / tampered timestamp — don't trust a cache entry that
    // claims to be from the future.
    return false;
  }

  return age < CAPABILITY_CACHE_TTL_MS;
}
