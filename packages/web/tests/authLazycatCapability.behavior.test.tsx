import "./helpers/domSetup";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import api from "../src/api/client";
import { __resetAuthProvidersForTest, useAuthProviders } from "../src/hooks/useAuthProviders";

beforeEach(() => __resetAuthProvidersForTest());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("hides lazycat until runtime capability arrives", async () => {
  let resolve!: (value: any) => void;
  vi.spyOn(api, "get").mockReturnValue(new Promise((done) => { resolve = done; }));
  const { result } = renderHook(() => useAuthProviders());
  expect(result.current.lazycatEnabled).toBe(false);
  await act(async () => resolve({ data: { providers: [], lazycat: { enabled: true } } }));
  await waitFor(() => expect(result.current.lazycatEnabled).toBe(true));
  expect(result.current.providers).toEqual([]);
});

for (const data of [{ providers: [] }, { providers: [], lazycat: { enabled: false } }, { providers: [], lazycat: { enabled: "true" } }]) {
  it(`defaults hidden for ${JSON.stringify(data)}`, async () => {
    vi.spyOn(api, "get").mockResolvedValue({ data });
    const { result } = renderHook(() => useAuthProviders());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.lazycatEnabled).toBe(false);
  });
}

it("hides lazycat on fetch failure", async () => {
  vi.spyOn(api, "get").mockRejectedValue(new Error("offline"));
  const { result } = renderHook(() => useAuthProviders());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.lazycatEnabled).toBe(false);
});
