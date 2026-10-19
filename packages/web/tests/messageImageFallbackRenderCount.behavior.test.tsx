import assert from "node:assert/strict";
import { resetInlineAttachmentUrlCache } from "../src/components/message/inlineAttachmentUrlCache";
import { act } from "react";
import { cleanup, fireEvent, render as rtlRender, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Message, MessageAttachment } from "../src/store/messageStore";
import { createRenderCounter } from "./helpers/renderCount";

const originalGet = api.get;
const originalPost = api.post;

function makeUser(): User {
  return {
    id: "user-1",
    email: "owner@example.com",
    gravatarHash: "",
    name: "owner",
    displayName: "Owner",
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: null,
    preferredTimezone: "UTC",
    autoTranslationEnabled: false,
    preferredTranslationDisplay: "original",
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
  };
}

function makeMessage(attachments?: MessageAttachment[]): Message {
  return {
    id: "message-1",
    channelId: "channel-1",
    senderType: "user",
    // Keep the sender distinct from the viewer so Gravatar's independent
    // async email-hash commit cannot hide the fallback-effect regression.
    senderId: "user-2",
    senderName: "Guest",
    messageType: "chat",
    content: "",
    createdAt: "2026-07-10T00:00:00.000Z",
    attachments,
  };
}

async function renderCountedMessage(message: Message) {
  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useSavedStore } = await import("../src/store/savedStore");
  const { useServerStore } = await import("../src/store/serverStore");

  useAuthStore.setState({
    user: makeUser(),
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  });
  useServerStore.setState({ current: null, members: [] });
  useAgentStore.setState({ agents: [] as Agent[], agentActivities: {} });
  useChannelStore.setState({ dmChannels: [] as Channel[] });
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false });

  const counter = createRenderCounter();
  const view = render(
    <MemoryRouter>
      <counter.Count id="message-row">
        <MessageItem message={message} mentionMap={new Map()} channels={[]} hideThreadActions />
      </counter.Count>
    </MemoryRouter>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return { ...view, commits: counter.get("message-row") };
}

afterEach(() => {
  resetInlineAttachmentUrlCache();
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
});

test("attachment-free MessageItem settles after one commit", async () => {
  assert.equal((await renderCountedMessage(makeMessage())).commits, 1);
});

test("MessageItem with an existing image thumbnail settles after one commit", async () => {
  assert.equal((await renderCountedMessage(makeMessage([{
    id: "image-1",
    filename: "image.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    localPreviewUrl: null,
    thumbnailUrl: "/thumbnail.png",
    rasterPreviewUrl: null,
  }]))).commits, 1);
});

test("MessageItem still loads an inline fallback when an image has no thumbnail", async () => {
  const requestedUrls: string[] = [];
  api.post = (async (url: string, body: { attachmentIds: string[] }) => {
    assert.equal(url, "/attachments/urls");
    requestedUrls.push(...body.attachmentIds);
    return { data: { urls: body.attachmentIds.map((id) => ({ id, url: "/inline.png", expiresAt: null })) } };
  }) as unknown as typeof api.post;
  api.get = (async (url: string) => {
    requestedUrls.push(url);
    return { data: { url: "/inline.png", expiresAt: null } };
  }) as typeof api.get;

  const { container } = await renderCountedMessage(makeMessage([{
    id: "image-1",
    filename: "image.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    localPreviewUrl: null,
    thumbnailUrl: null,
    rasterPreviewUrl: null,
  }]));

  await waitFor(() => {
    assert.equal(container.querySelector("img[alt='image.png']")?.getAttribute("src"), "/inline.png");
  });
  // One batch call carrying the single image id, not a per-image GET.
  assert.deepEqual(requestedUrls, ["image-1"]);
});

test("a failed inline image retries once, then falls back to the attachment chip", async () => {
  let batchCalls = 0;
  let singleCalls = 0;
  api.post = (async (url: string, body: { attachmentIds: string[] }) => {
    assert.equal(url, "/attachments/urls");
    batchCalls += 1;
    return {
      data: {
        urls: body.attachmentIds.map((id) => ({
          id,
          url: "/expired-inline.png",
          expiresAt: "2026-10-15T01:00:00.000Z",
        })),
      },
    };
  }) as unknown as typeof api.post;
  api.get = (async (url: string) => {
    assert.equal(url, "/attachments/image-1/url?disposition=inline");
    singleCalls += 1;
    return {
      data: {
        url: "/refreshed-inline.png",
        expiresAt: "2026-10-15T02:00:00.000Z",
      },
    };
  }) as typeof api.get;

  const { container } = await renderCountedMessage(makeMessage([{
    id: "image-1",
    filename: "image.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    localPreviewUrl: null,
    thumbnailUrl: null,
    rasterPreviewUrl: null,
  }]));

  const image = await waitFor(() => {
    const node = container.querySelector("img[alt='image.png']");
    assert.ok(node);
    assert.equal(node.getAttribute("src"), "/expired-inline.png");
    return node as HTMLImageElement;
  });
  assert.equal(batchCalls, 1);

  fireEvent.error(image);
  const refreshedImage = await waitFor(() => {
    const node = container.querySelector("img[alt='image.png']");
    assert.ok(node);
    assert.notEqual(node, image);
    assert.equal(node.getAttribute("src"), "/refreshed-inline.png");
    return node as HTMLImageElement;
  });
  assert.equal(singleCalls, 1);

  fireEvent.error(refreshedImage);
  await waitFor(() => {
    assert.ok(container.querySelector("img[alt='image.png']") === null);
    assert.ok(container.querySelector("[data-message-affordance='attachment-text-slot']"));
  });
  assert.equal(singleCalls, 1);
});

test("a retry that returns the same inline URL remounts before a second failure", async () => {
  let singleCalls = 0;
  api.post = (async (_url: string, body: { attachmentIds: string[] }) => ({
    data: {
      urls: body.attachmentIds.map((id) => ({
        id,
        url: "/same-inline.png",
        expiresAt: "2026-10-15T01:00:00.000Z",
      })),
    },
  })) as unknown as typeof api.post;
  api.get = (async (url: string) => {
    assert.equal(url, "/attachments/image-1/url?disposition=inline");
    singleCalls += 1;
    return {
      data: {
        url: "/same-inline.png",
        expiresAt: "2026-10-15T02:00:00.000Z",
      },
    };
  }) as typeof api.get;

  const { container } = await renderCountedMessage(makeMessage([{
    id: "image-1",
    filename: "same.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    localPreviewUrl: null,
    thumbnailUrl: null,
    rasterPreviewUrl: null,
  }]));
  const firstImage = await waitFor(() => {
    const node = container.querySelector("img[alt='same.png']");
    assert.ok(node);
    assert.equal(node.getAttribute("src"), "/same-inline.png");
    return node as HTMLImageElement;
  });

  fireEvent.error(firstImage);
  const retriedImage = await waitFor(() => {
    const node = container.querySelector("img[alt='same.png']");
    assert.ok(node);
    assert.notEqual(node, firstImage);
    assert.equal(node.getAttribute("src"), "/same-inline.png");
    return node as HTMLImageElement;
  });
  assert.equal(singleCalls, 1);

  fireEvent.error(retriedImage);
  await waitFor(() => {
    assert.equal(container.querySelector("img[alt='same.png']"), null);
    assert.ok(container.querySelector("[data-message-affordance='attachment-text-slot']"));
  });
  assert.equal(singleCalls, 1);
});

test("preferred thumbnail and local previews do not receive an inline fallback error handler", async () => {
  const { container } = await renderCountedMessage(makeMessage([
    {
      id: "thumbnail-image",
      filename: "thumbnail.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      localPreviewUrl: null,
      thumbnailUrl: "/thumbnail.png",
      rasterPreviewUrl: null,
    },
    {
      id: "local-image",
      filename: "local.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      localPreviewUrl: "/local.png",
      thumbnailUrl: null,
      rasterPreviewUrl: null,
    },
  ]));

  await waitFor(() => {
    const images = Array.from(container.querySelectorAll("img"));
    assert.equal(images.length, 2);
    assert.deepEqual(images.map((image) => image.getAttribute("src")), ["/thumbnail.png", "/local.png"]);
    for (const image of images) assert.equal(image.onerror, null);
  });
});

test("a deferred retry does not write into a message after its attachments change", async () => {
  let resolveRetry!: (response: { data: { url: string; expiresAt: string } }) => void;
  const retryResponse = new Promise<{ data: { url: string; expiresAt: string } }>((resolve) => {
    resolveRetry = resolve;
  });
  api.post = (async (_url: string, body: { attachmentIds: string[] }) => ({
    data: {
      urls: body.attachmentIds.map((id) => ({
        id,
        url: `/inline-${id}.png`,
        expiresAt: "2026-10-15T02:00:00.000Z",
      })),
    },
  })) as unknown as typeof api.post;
  api.get = (async (url: string) => {
    assert.equal(url, "/attachments/image-1/url?disposition=inline");
    return retryResponse;
  }) as typeof api.get;

  const view = await renderCountedMessage(makeMessage([{
    id: "image-1",
    filename: "old.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    localPreviewUrl: null,
    thumbnailUrl: null,
    rasterPreviewUrl: null,
  }]));
  const oldImage = await waitFor(() => {
    const node = view.container.querySelector("img[alt='old.png']");
    assert.ok(node);
    return node as HTMLImageElement;
  });
  fireEvent.error(oldImage);

  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const nextMessage = makeMessage([{
    id: "image-2",
    filename: "new.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    localPreviewUrl: null,
    thumbnailUrl: null,
    rasterPreviewUrl: null,
  }]);
  view.rerender(
    <MemoryRouter>
      <MessageItem message={nextMessage} mentionMap={new Map()} channels={[]} hideThreadActions />
    </MemoryRouter>,
  );
  await waitFor(() => {
    assert.equal(view.container.querySelector("img[alt='new.png']")?.getAttribute("src"), "/inline-image-2.png");
  });

  resolveRetry({ data: { url: "/stale-inline.png", expiresAt: "2026-10-15T03:00:00.000Z" } });
  await act(async () => {
    await retryResponse;
  });
  assert.equal(view.container.querySelector("img[alt='old.png']"), null);
  assert.equal(view.container.querySelector("img[alt='new.png']")?.getAttribute("src"), "/inline-image-2.png");
});

test("multiple inline images retry independently", async () => {
  const retryCalls: string[] = [];
  api.post = (async (_url: string, body: { attachmentIds: string[] }) => ({
    data: {
      urls: body.attachmentIds.map((id) => ({
        id,
        url: `/inline-${id}.png`,
        expiresAt: "2026-10-15T01:00:00.000Z",
      })),
    },
  })) as unknown as typeof api.post;
  api.get = (async (url: string) => {
    const id = url.includes("image-1") ? "image-1" : "image-2";
    retryCalls.push(id);
    return {
      data: {
        url: `/refreshed-${id}.png`,
        expiresAt: "2026-10-15T02:00:00.000Z",
      },
    };
  }) as typeof api.get;

  const { container } = await renderCountedMessage(makeMessage([
    {
      id: "image-1",
      filename: "one.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      localPreviewUrl: null,
      thumbnailUrl: null,
      rasterPreviewUrl: null,
    },
    {
      id: "image-2",
      filename: "two.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      localPreviewUrl: null,
      thumbnailUrl: null,
      rasterPreviewUrl: null,
    },
  ]));
  const firstImage = await waitFor(() => {
    const node = container.querySelector("img[alt='one.png']");
    assert.ok(node);
    return node as HTMLImageElement;
  });
  const secondImage = container.querySelector("img[alt='two.png']");
  assert.ok(secondImage);

  fireEvent.error(firstImage);
  await waitFor(() => {
    assert.equal(container.querySelector("img[alt='one.png']")?.getAttribute("src"), "/refreshed-image-1.png");
    assert.equal(container.querySelector("img[alt='two.png']")?.getAttribute("src"), "/inline-image-2.png");
  });
  const secondImageAfterFirstRetry = container.querySelector("img[alt='two.png']");
  assert.ok(secondImageAfterFirstRetry);
  fireEvent.error(secondImageAfterFirstRetry);
  await waitFor(() => {
    assert.equal(container.querySelector("img[alt='two.png']")?.getAttribute("src"), "/refreshed-image-2.png");
  });
  assert.deepEqual(retryCalls.sort(), ["image-1", "image-2"]);
});
