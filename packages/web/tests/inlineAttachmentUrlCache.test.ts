import assert from "node:assert/strict";
import api from "../src/api/client";
import {
  fetchInlineAttachmentUrls,
  getCachedInlineAttachmentUrl,
  invalidateInlineAttachmentUrl,
  resetInlineAttachmentUrlCache,
} from "../src/components/message/inlineAttachmentUrlCache";

const originalPost = api.post;

afterEach(() => {
  resetInlineAttachmentUrlCache();
  api.post = originalPost;
});

test("inline URL cache keeps expiresAt semantics and refreshes before and at expiry", async () => {
  const realDateNow = Date.now;
  const now = Date.parse("2026-10-15T00:00:00.000Z");
  let currentNow = now;
  let postCalls = 0;
  Date.now = () => currentNow;
  api.post = (async (_url: string, body: { attachmentIds: string[] }) => {
    postCalls += 1;
    const id = body.attachmentIds[0]!;
    return {
      data: {
        urls: [{
          id,
          url: postCalls === 1 ? "/inline-a.png" : "/inline-b.png",
          expiresAt: postCalls === 1
            ? new Date(now + 1_000).toISOString()
            : new Date(now + 10_000).toISOString(),
        }],
      },
    };
  }) as unknown as typeof api.post;

  try {
    const initial = await fetchInlineAttachmentUrls(["att-1"]);
    assert.equal(initial.get("att-1"), "/inline-a.png");
    assert.equal(getCachedInlineAttachmentUrl("att-1"), "/inline-a.png");

    currentNow = now + 999;
    const beforeExpiry = await fetchInlineAttachmentUrls(["att-1"]);
    assert.equal(beforeExpiry.get("att-1"), "/inline-a.png");
    assert.equal(postCalls, 1);

    currentNow = now + 1_000;
    const atExpiry = await fetchInlineAttachmentUrls(["att-1"]);
    assert.equal(atExpiry.get("att-1"), "/inline-b.png");
    assert.equal(getCachedInlineAttachmentUrl("att-1"), "/inline-b.png");
    assert.equal(postCalls, 2);
  } finally {
    Date.now = realDateNow;
  }
});

test("malformed non-empty expiresAt invalidates the cached URL and refetches", async () => {
  let postCalls = 0;
  api.post = (async (_url: string, body: { attachmentIds: string[] }) => {
    postCalls += 1;
    const id = body.attachmentIds[0]!;
    return {
      data: {
        urls: [{
          id,
          url: postCalls === 1 ? "/malformed-inline.png" : "/fresh-inline.png",
          expiresAt: postCalls === 1 ? "not-a-timestamp" : "2026-10-15T02:00:00.000Z",
        }],
      },
    };
  }) as unknown as typeof api.post;

  const initial = await fetchInlineAttachmentUrls(["att-malformed"]);
  assert.equal(initial.get("att-malformed"), "/malformed-inline.png");
  assert.equal(getCachedInlineAttachmentUrl("att-malformed"), null);

  const refreshed = await fetchInlineAttachmentUrls(["att-malformed"]);
  assert.equal(refreshed.get("att-malformed"), "/fresh-inline.png");
  assert.equal(postCalls, 2);
});

test("concurrent batch callers share one per-attachment response", async () => {
  type UrlResponse = { data: { urls: Array<{ id: string; url: string; expiresAt: string }> } };
  let resolveBatch!: (response: UrlResponse) => void;
  const batchResponse = new Promise<UrlResponse>((resolve) => {
    resolveBatch = resolve;
  });
  let postCalls = 0;
  api.post = (async () => {
    postCalls += 1;
    return batchResponse;
  }) as unknown as typeof api.post;

  const firstRequest = fetchInlineAttachmentUrls(["att-race"]);
  const secondRequest = fetchInlineAttachmentUrls(["att-race"]);

  resolveBatch({
    data: { urls: [{ id: "att-race", url: "/latest-inline.png", expiresAt: "2099-10-15T02:00:00.000Z" }] },
  });
  const [firstResolved, secondResolved] = await Promise.all([firstRequest, secondRequest]);
  assert.equal(firstResolved.get("att-race"), "/latest-inline.png");
  assert.equal(secondResolved.get("att-race"), "/latest-inline.png");
  assert.equal(postCalls, 1);
  assert.equal(getCachedInlineAttachmentUrl("att-race"), "/latest-inline.png");
});

test("an invalidated batch request cannot repopulate the cache after it resolves", async () => {
  type UrlResponse = { data: { urls: Array<{ id: string; url: string; expiresAt: string }> } };
  let resolvePending!: (response: UrlResponse) => void;
  const pendingResponse = new Promise<UrlResponse>((resolve) => {
    resolvePending = resolve;
  });
  api.post = (async () => pendingResponse) as unknown as typeof api.post;

  const pendingRequest = fetchInlineAttachmentUrls(["att-invalidated"]);
  invalidateInlineAttachmentUrl("att-invalidated");
  resolvePending({
    data: { urls: [{ id: "att-invalidated", url: "/stale-inline.png", expiresAt: "2099-10-15T02:00:00.000Z" }] },
  });

  assert.equal((await pendingRequest).get("att-invalidated"), undefined);
  assert.equal(getCachedInlineAttachmentUrl("att-invalidated"), null);
});
