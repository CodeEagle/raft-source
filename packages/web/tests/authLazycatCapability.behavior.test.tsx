import "./helpers/domSetup";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import api from "../src/api/client";
import { __resetAuthProvidersForTest, useAuthProviders } from "../src/hooks/useAuthProviders";
import LoginPage from "../src/components/auth/LoginPage";
import { renderWithIntl } from "./helpers/intl";

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

it("renders the real login page without lazycat while loading, then shows the enabled link", async () => {
  let resolve!: (value: any) => void;
  vi.spyOn(api, "get").mockReturnValue(new Promise((done) => { resolve = done; }));
  const page = renderWithIntl(<LoginPage onForgotPassword={() => {}} />);
  expect(page.queryByRole("link", { name: /lazycat/i })).toBeNull();
  expect(page.queryByRole("button", { name: /lazycat/i })).toBeNull();
  expect(page.container.querySelector('[href="/api/auth/lazycat/start"]')).toBeNull();

  await act(async () => resolve({ data: { providers: [], lazycat: { enabled: true } } }));
  const link = await page.findByRole("link", { name: /lazycat/i });
  expect(link.getAttribute("href")).toBe("/api/auth/lazycat/start");
});

for (const scenario of ["fetch failed", "capability absent", "enabled absent", "disabled"] as const) {
  it(`renders no lazycat login control when ${scenario}`, async () => {
    const request = vi.spyOn(api, "get");
    if (scenario === "fetch failed") request.mockRejectedValue(new Error("offline"));
    else request.mockResolvedValue({ data: {
      providers: [],
      ...(scenario === "capability absent" ? {} : { lazycat: scenario === "enabled absent" ? {} : { enabled: false } }),
    } });
    const page = renderWithIntl(<LoginPage onForgotPassword={() => {}} />);
    // Observe the shared request settling so absence is checked after loading too.
    const { result } = renderHook(() => useAuthProviders());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(page.queryByRole("link", { name: /lazycat/i })).toBeNull();
    expect(page.queryByRole("button", { name: /lazycat/i })).toBeNull();
    expect(page.container.querySelector('[href="/api/auth/lazycat/start"]')).toBeNull();
  });
}
