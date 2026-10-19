import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseDeploymentConfig } from "../config/deployment";
import { openTestApp } from "../test/integration/app";

afterEach(() => vi.unstubAllEnvs());

it("serves standard auth without any lazycat configuration", async () => {
  vi.stubEnv("RAFT_DEPLOYMENT_TARGET", "standard");
  for (const name of Object.keys(process.env).filter((name) => name.startsWith("LAZYCAT_"))) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("APP_URL", undefined);
  vi.stubEnv("UPLOADS_DIR", undefined);
  const app = await openTestApp("pglite://", 0);
  try {
    const response = await fetch(`${app.baseUrl}/api/auth/providers`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.lazycat.enabled).toBe(false);
    for (const path of ["start", "callback", "unknown"]) {
      const response = await fetch(`${app.baseUrl}/api/auth/lazycat/${path}`, { redirect: "manual" });
      expect(response.status).toBe(404);
    }
  } finally { await app.close(); }
}, 60_000);

it("rejects incomplete lazycat configuration with names only before startup side effects", () => {
  const env = {
    RAFT_DEPLOYMENT_TARGET: "lazycat",
    LAZYCAT_AUTH_OIDC_CLIENT_ID: "private-client-id",
    LAZYCAT_AUTH_OIDC_CLIENT_SECRET: "private-client-secret",
    LAZYCAT_AUTH_OIDC_ISSUER_URI: "https://private-user:private-password@identity.example.test",
    APP_URL: "invalid-private-app-url",
    UPLOADS_DIR: "relative-private-upload-path",
  };
  const message = "Invalid or missing lazycat configuration: LAZYCAT_AUTH_OIDC_ISSUER_URI, LAZYCAT_AUTH_OIDC_AUTH_URI, LAZYCAT_AUTH_OIDC_TOKEN_URI, LAZYCAT_AUTH_OIDC_USERINFO_URI, APP_URL, UPLOADS_DIR";
  expect(() => parseDeploymentConfig(env)).toThrowError(new Error(message));
  try {
    parseDeploymentConfig(env);
  } catch (error) {
    // The target is a public enum; all supplied configuration values stay private.
    for (const [name, value] of Object.entries(env)) {
      if (name !== "RAFT_DEPLOYMENT_TARGET") expect((error as Error).message).not.toContain(value);
    }
  }

  // Inspect bootstrap without importing server.ts, which would start the server.
  const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const bootstrap = source.slice(source.indexOf("async function bootstrap()"));
  expect(bootstrap).toMatch(/^async function bootstrap\(\)\s*\{\s*\/\/[^\n]*\n\s*parseDeploymentConfig\(\);/);
  for (const call of ["await initDatabase(", "startMobilePushOutboxWorker(", "startChannelConversionWorker("]) {
    expect(bootstrap.indexOf(call)).toBeGreaterThan(bootstrap.indexOf("parseDeploymentConfig();"));
  }
  expect(source).toMatch(/bootstrap\(\)\.catch\(\(err\) => \{[\s\S]*?process\.exit\(1\);/);
});

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
