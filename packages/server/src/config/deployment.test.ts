import { describe, expect, it } from "vitest";
import { parseDeploymentConfig } from "./deployment";

describe("deployment config", () => {
  it("defaults to standard despite leftover platform variables", () => {
    expect(parseDeploymentConfig({ LAZYCAT_AUTH_OIDC_CLIENT_SECRET: "leftover" })).toEqual({ target: "standard" });
  });
  it("accepts valid lazycat configuration", () => {
    expect(parseDeploymentConfig({
      RAFT_DEPLOYMENT_TARGET: "lazycat", APP_URL: "https://raft.example.test",
      UPLOADS_DIR: "/lzcapp/var/uploads", LAZYCAT_AUTH_OIDC_CLIENT_ID: "raft",
      LAZYCAT_AUTH_OIDC_CLIENT_SECRET: "secret",
      LAZYCAT_AUTH_OIDC_ISSUER_URI: "https://identity.example.test",
      LAZYCAT_AUTH_OIDC_AUTH_URI: "https://identity.example.test/authorize",
      LAZYCAT_AUTH_OIDC_TOKEN_URI: "https://identity.example.test/token",
      LAZYCAT_AUTH_OIDC_USERINFO_URI: "https://identity.example.test/userinfo",
    })).toEqual({ target: "lazycat" });
  });
  it("rejects unknown targets without echoing values", () => {
    expect(() => parseDeploymentConfig({ RAFT_DEPLOYMENT_TARGET: "private-value" })).toThrow("Invalid RAFT_DEPLOYMENT_TARGET: expected standard or lazycat");
  });
  it("aggregates missing and invalid variable names without exposing values", () => {
    let message = "";
    try {
      parseDeploymentConfig({ RAFT_DEPLOYMENT_TARGET: "lazycat", APP_URL: "private-value", LAZYCAT_AUTH_OIDC_CLIENT_SECRET: "secret-value", UPLOADS_DIR: "relative" });
    } catch (error) { message = (error as Error).message; }
    expect(message).toContain("LAZYCAT_AUTH_OIDC_CLIENT_ID");
    expect(message).toContain("LAZYCAT_AUTH_OIDC_AUTH_URI");
    expect(message).toContain("APP_URL");
    expect(message).toContain("UPLOADS_DIR");
    expect(message).not.toContain("private-value");
    expect(message).not.toContain("secret-value");
    expect(message).not.toContain("LAZYCAT_AUTH_OIDC_CLIENT_SECRET");
  });
});
