import { afterEach, expect, it, vi } from "vitest";
import { openTestApp } from "../test/integration/app";

afterEach(() => vi.unstubAllEnvs());

for (const target of ["standard", "lazycat"] as const) {
  it(`advertises and mounts lazycat only for ${target}`, async () => {
    vi.stubEnv("RAFT_DEPLOYMENT_TARGET", target);
    vi.stubEnv("APP_URL", "https://raft.example.test");
    vi.stubEnv("UPLOADS_DIR", "/tmp/raft-deployment-test-uploads");
    for (const key of ["ISSUER_URI", "AUTH_URI", "TOKEN_URI", "USERINFO_URI"]) {
      vi.stubEnv(`LAZYCAT_AUTH_OIDC_${key}`, "https://identity.example.test/oidc");
    }
    vi.stubEnv("LAZYCAT_AUTH_OIDC_CLIENT_ID", "raft-test");
    vi.stubEnv("LAZYCAT_AUTH_OIDC_CLIENT_SECRET", "secret");
    const app = await openTestApp("pglite://", 0);
    try {
      const providers = await fetch(`${app.baseUrl}/api/auth/providers`);
      expect(providers.status).toBe(200);
      const body = await providers.json() as { providers: unknown[]; lazycat: { enabled: boolean } };
      expect(Array.isArray(body.providers)).toBe(true);
      expect(body.lazycat.enabled).toBe(target === "lazycat");
      const start = await fetch(`${app.baseUrl}/api/auth/lazycat/start`, { redirect: "manual" });
      expect(start.status).toBe(target === "lazycat" ? 302 : 404);
      if (target === "lazycat") {
        expect(new URL(start.headers.get("location")!).searchParams.get("redirect_uri")).toBe("https://raft.example.test/api/auth/lazycat/callback");
      }
      const callback = await fetch(`${app.baseUrl}/api/auth/lazycat/callback`);
      expect(callback.status).toBe(target === "lazycat" ? 400 : 404);
    } finally { await app.close(); }
  }, 60_000);
}
