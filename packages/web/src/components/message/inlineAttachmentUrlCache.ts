import api from "../../api/client";

/**
 * Session cache + in-flight dedupe for inline attachment URLs.
 *
 * Every image tile used to fetch `/attachments/{id}/url?disposition=inline`
 * on its own, with no sharing across components or remounts. A message with
 * 6 images costs 6 requests; the same attachments rendered again inside a
 * forward preview cost 6 more; scrolling back remounts and pays again. The
 * download limiter is 120/min, so an attachment-dense channel trips it and the
 * images render as broken files (observed: dozens of 429s).
 *
 * Signed URLs carry an expiry, so they are cacheable by construction — this
 * just stops us re-asking for a URL we already hold.
 */
interface CachedInlineAttachmentUrl {
  url: string;
  expiresAt: string | null;
}

type InlineAttachmentUrlResponse = {
  urls?: Array<{ id: string; url: string; expiresAt?: string | null }>;
};

const cache = new Map<string, CachedInlineAttachmentUrl>();
const inFlight = new Map<string, Promise<string | null>>();
const batchInFlight = new Map<string, Promise<string | null>>();
const requestGenerations = new Map<string, number>();

function nextRequestGeneration(attachmentId: string): number {
  const generation = (requestGenerations.get(attachmentId) ?? 0) + 1;
  requestGenerations.set(attachmentId, generation);
  return generation;
}

function readFresh(attachmentId: string): string | null {
  const cached = cache.get(attachmentId);
  if (!cached) return null;
  if (cached.expiresAt) {
    const expiresAt = Date.parse(cached.expiresAt);
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
      cache.delete(attachmentId);
      return null;
    }
  }
  return cached.url;
}

/** Drop a cached URL that failed to load, so the next render refetches it. */
export function invalidateInlineAttachmentUrl(attachmentId: string): void {
  cache.delete(attachmentId);
  nextRequestGeneration(attachmentId);
  inFlight.delete(attachmentId);
  batchInFlight.delete(attachmentId);
}

export function getCachedInlineAttachmentUrl(attachmentId: string): string | null {
  return readFresh(attachmentId);
}

/**
 * NOTE ON ABORT: callers deliberately cannot cancel the shared request.
 *
 * An earlier version forwarded each caller's AbortSignal into the shared
 * promise. In a virtualised message list tiles unmount constantly, so the first
 * unmount aborted the in-flight fetch for EVERY other caller waiting on it, and
 * images fell back permanently to file chips. A shared request must outlive any
 * single subscriber; callers drop the result themselves if they are gone.
 */
/**
 * Resolve many attachment URLs in ONE request.
 *
 * Per-attachment resolution scales with images, not messages: a dense channel
 * blows past the 120/min download limiter and renders broken files. Callers
 * that know their whole set (a message's gallery) should use this; the single
 * form remains for one-off opens.
 */
export async function fetchInlineAttachmentUrls(attachmentIds: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const missing: string[] = [];
  const pending: Array<[string, Promise<string | null>]> = [];
  const generations = new Map<string, number>();
  const considered = new Set<string>();
  for (const id of attachmentIds) {
    if (considered.has(id)) continue;
    considered.add(id);
    const hit = readFresh(id);
    if (hit) resolved.set(id, hit);
    else {
      const currentPending = batchInFlight.get(id) ?? inFlight.get(id);
      if (currentPending) pending.push([id, currentPending]);
      else {
        missing.push(id);
        generations.set(id, nextRequestGeneration(id));
      }
    }
  }

  if (missing.length > 0) {
    const response = Promise.resolve().then(() => api.post<InlineAttachmentUrlResponse>(
      "/attachments/urls",
      { attachmentIds: missing },
    ));
    for (const attachmentId of missing) {
      const generation = generations.get(attachmentId)!;
      let attachmentRequest: Promise<string | null>;
      attachmentRequest = response
        .then(({ data }) => {
          const entry = data.urls?.find((candidate) => candidate.id === attachmentId);
          if (!entry || requestGenerations.get(attachmentId) !== generation) return null;
          cache.set(attachmentId, { url: entry.url, expiresAt: entry.expiresAt ?? null });
          return entry.url;
        })
        .catch(() => null)
        .finally(() => {
          if (batchInFlight.get(attachmentId) === attachmentRequest) {
            batchInFlight.delete(attachmentId);
          }
        });
      batchInFlight.set(attachmentId, attachmentRequest);
      pending.push([attachmentId, attachmentRequest]);
    }
  }

  for (const [attachmentId, attachmentRequest] of pending) {
    const url = await attachmentRequest;
    if (url) resolved.set(attachmentId, url);
  }
  return resolved;
}

export async function fetchInlineAttachmentUrl(attachmentId: string): Promise<string | null> {
  const cached = readFresh(attachmentId);
  if (cached) return cached;

  const pendingBatch = batchInFlight.get(attachmentId);
  if (pendingBatch) return pendingBatch;

  const pending = inFlight.get(attachmentId);
  if (pending) return pending;

  const requestGeneration = nextRequestGeneration(attachmentId);
  const request = api
    .get<{ url: string; expiresAt?: string | null }>(
      `/attachments/${attachmentId}/url?disposition=inline`,
    )
    .then(({ data }) => {
      if (requestGenerations.get(attachmentId) !== requestGeneration) return null;
      cache.set(attachmentId, { url: data.url, expiresAt: data.expiresAt ?? null });
      return data.url;
    })
    .finally(() => {
      if (requestGenerations.get(attachmentId) === requestGeneration) {
        inFlight.delete(attachmentId);
      }
    });

  inFlight.set(attachmentId, request.catch(() => null));
  return request;
}

/**
 * Clear the session cache. Exported for tests: the cache is module-level, so
 * one test's resolved URLs would otherwise satisfy the next test's expectations
 * and hide a missing request.
 */
export function resetInlineAttachmentUrlCache(): void {
  cache.clear();
  inFlight.clear();
  batchInFlight.clear();
  requestGenerations.clear();
}
