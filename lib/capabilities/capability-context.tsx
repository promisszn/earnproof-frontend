"use client";

/**
 * React context/hook for capability-gated UI. See `lib/api/capabilities.ts`
 * for the full "UX layer only, not a security boundary" contract that
 * everything here inherits — nothing added in this file changes that.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  currentDeploymentIdentity,
  deploymentIdentityChanged,
  fetchCapabilityDocument,
  isCapabilityEnabled,
  type CapabilityDocument,
  type CapabilityKey,
} from "@/lib/api/capabilities";
import {
  isCapabilityCacheFresh,
  readCapabilityCache,
  writeCapabilityCache,
  clearCapabilityCache,
  type CachedCapabilityEntry,
} from "@/lib/api/capability-cache";

/**
 * `"stale"` means a fetch (initial load or refresh) failed, but a
 * previously-trusted document for this exact deployment identity is still
 * being served from cache — status distinguishes this from `"error"`
 * (no usable document at all) so callers can surface "may be out of date"
 * without hiding capabilities the user was already, correctly, granted.
 */
export type CapabilityStatus = "loading" | "ready" | "stale" | "error";

export type CapabilityContextValue = {
  status: CapabilityStatus;
  document: CapabilityDocument | null;
  /** Fail-closed: `false` whenever the key isn't explicitly enabled. */
  has: (key: CapabilityKey) => boolean;
  refresh: () => Promise<void>;
};

const CapabilityContext = createContext<CapabilityContextValue | null>(null);

/**
 * A fetcher may return either a bare document (the shape every existing
 * test/dev fixture already uses, including `fetchMockCapabilityDocument`)
 * or `{ document, etag }` so the provider can persist the ETag for
 * conditional revalidation. This is additive — a bare-document return is
 * still fully supported.
 */
export type CapabilityFetchOutcome =
  | CapabilityDocument
  | { document: CapabilityDocument; etag?: string | null };

export type CapabilityFetcher = () => Promise<CapabilityFetchOutcome>;

function unwrapFetchOutcome(outcome: CapabilityFetchOutcome): {
  document: CapabilityDocument;
  etag: string | null;
} {
  if (outcome && typeof outcome === "object" && "document" in outcome) {
    return { document: outcome.document, etag: outcome.etag ?? null };
  }
  return { document: outcome, etag: null };
}

/**
 * Production default: fetches the real capability document from the
 * backend, revalidating against the locally cached ETag (if the cache is
 * still for this exact deployment identity) so an unchanged document costs
 * a `304` instead of a full re-fetch.
 */
async function defaultCapabilityFetcher(): Promise<CapabilityFetchOutcome> {
  const identity = currentDeploymentIdentity();
  const cached = readCapabilityCache();
  const canRevalidate = !!cached && !deploymentIdentityChanged(cached.identity, identity);

  const result = await fetchCapabilityDocument({
    etag: canRevalidate && cached ? cached.etag ?? null : null,
  });

  if (result.kind === "not-modified") {
    if (!canRevalidate || !cached) {
      // The server validated an ETag we no longer have a trusted local
      // document for — never synthesize a document from thin air.
      throw new Error("Capability document revalidation had no trusted cached document to reuse.");
    }
    return { document: cached.document, etag: cached.etag ?? null };
  }

  return { document: result.document, etag: result.etag };
}

export function CapabilityProvider({
  children,
  fetcher = defaultCapabilityFetcher,
}: {
  children: ReactNode;
  /**
   * Overridable so tests can supply a deterministic document source
   * without touching this provider. Defaults to `defaultCapabilityFetcher`,
   * which calls the real backend (`fetchCapabilityDocument` in
   * `lib/api/capabilities.ts`) — production code should not need to pass
   * this prop at all. `fetchMockCapabilityDocument` remains available for
   * local development/tests that want the fixture instead.
   */
  fetcher?: CapabilityFetcher;
}) {
  const [status, setStatus] = useState<CapabilityStatus>("loading");
  const [document, setDocument] = useState<CapabilityDocument | null>(null);
  // Fetch is async; guard against setting state after unmount (route change
  // mid-request) the same way `app/verify/[proofId]/page.tsx` does.
  const mountedRef = useRef(true);
  // `refresh()` needs to force a real refetch (bypassing the cache) even
  // when the mount-time fetch already resolved. Rather than exposing an
  // imperative "call this function to refetch" API that an effect would
  // need to reach into (flagged by react-hooks/set-state-in-effect), the
  // effect re-runs whenever this generation counter changes, and
  // `refresh()` is nothing but "bump the counter" — the canonical React
  // pattern for an on-demand refetch driven by a dependency array.
  const [refreshToken, setRefreshToken] = useState(0);
  // Whether the pending fetch (keyed by refreshToken) should bypass the
  // cache. Only `refreshToken > 0` (i.e. an explicit refresh(), never the
  // initial mount) skips the cache.
  const skipCacheRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    const skipCache = skipCacheRef.current;

    // Effects synchronize with external systems; the actual setState
    // calls below happen inside this async closure, never synchronously
    // within the effect body itself.
    async function load() {
      setStatus("loading");
      const identity = currentDeploymentIdentity();
      const cached = readCapabilityCache();

      if (!skipCache && cached && isCapabilityCacheFresh(cached, identity)) {
        if (mountedRef.current) {
          setDocument(cached.document);
          setStatus("ready");
        }
        return;
      }

      // A cache entry for this *exact* deployment identity (even past its
      // TTL, or while force-refreshing) is kept as a fail-closed-safe
      // fallback if the fetch below fails: it was already validated for
      // this deployment, so re-showing it grants nothing new — it only
      // avoids hiding already-authorized capabilities behind a transient
      // network blip. A cache entry for a *different* deployment identity
      // (different API URL, network, or spec version) is never a safe
      // fallback and is dropped outright instead.
      const fallback: CachedCapabilityEntry | null =
        cached && !deploymentIdentityChanged(cached.identity, identity) ? cached : null;
      if (cached && !fallback) {
        clearCapabilityCache();
      }

      try {
        const outcome = await fetcher();
        if (!mountedRef.current) return;
        const { document: nextDocument, etag } = unwrapFetchOutcome(outcome);

        writeCapabilityCache({
          document: nextDocument,
          identity,
          cachedAt: Date.now(),
          etag,
        });
        setDocument(nextDocument);
        setStatus("ready");
      } catch {
        if (!mountedRef.current) return;
        if (fallback) {
          // Fail closed for anything *new*, but don't hide capabilities
          // already granted under a document that is still trusted for
          // this deployment — just mark the state explicitly stale.
          setDocument(fallback.document);
          setStatus("stale");
        } else {
          // No safe fallback: fail closed completely. No document means
          // every `has()` check below returns false, not "assume previous
          // state" or "assume enabled".
          setDocument(null);
          setStatus("error");
        }
      }
    }

    load();

    return () => {
      mountedRef.current = false;
    };
  }, [fetcher, refreshToken]);

  const has = useCallback(
    (key: CapabilityKey) => isCapabilityEnabled(document, key),
    [document],
  );

  const refresh = useCallback(async () => {
    skipCacheRef.current = true;
    setRefreshToken((token) => token + 1);
  }, []);

  const value = useMemo<CapabilityContextValue>(
    () => ({ status, document, has, refresh }),
    [status, document, has, refresh],
  );

  return <CapabilityContext.Provider value={value}>{children}</CapabilityContext.Provider>;
}

/**
 * Reads capability state. Must be used under `<CapabilityProvider>`.
 * Deliberately throws outside a provider (a programmer error, not a
 * runtime condition) rather than silently fail-opening — that would
 * hide a missing provider bug rather than surface it in development.
 */
export function useCapabilities(): CapabilityContextValue {
  const context = useContext(CapabilityContext);
  if (!context) {
    throw new Error("useCapabilities must be used within a CapabilityProvider");
  }
  return context;
}

/**
 * Convenience hook for a single capability check. Fails closed via
 * `has()` — while `status` is `"loading"` or `"error"`, this returns
 * `false` because `document` is `null` in both of those states. While
 * `status` is `"stale"`, `has()` evaluates the last known-trusted document
 * for this deployment rather than `false` — a capability already granted
 * stays visible during a transient refresh failure, it is never newly
 * granted by staleness.
 */
export function useCapability(key: CapabilityKey): {
  enabled: boolean;
  status: CapabilityStatus;
} {
  const { has, status } = useCapabilities();
  return { enabled: has(key), status };
}
