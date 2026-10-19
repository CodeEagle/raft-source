import { isAbsolute } from "node:path";

export type DeploymentConfig = Readonly<{ target: "standard" | "lazycat" }>;

/** Pure startup/preflight validation. Errors contain variable names, never values. */
export function parseDeploymentConfig(env: NodeJS.ProcessEnv = process.env): DeploymentConfig {
  const target = env.RAFT_DEPLOYMENT_TARGET ?? "standard";
  if (target !== "standard" && target !== "lazycat") {
    throw new Error("Invalid RAFT_DEPLOYMENT_TARGET: expected standard or lazycat");
  }
  if (target === "standard") return { target };

  const invalid: string[] = [];
  const required = [
    "LAZYCAT_AUTH_OIDC_CLIENT_ID", "LAZYCAT_AUTH_OIDC_CLIENT_SECRET",
    "LAZYCAT_AUTH_OIDC_ISSUER_URI", "LAZYCAT_AUTH_OIDC_AUTH_URI",
    "LAZYCAT_AUTH_OIDC_TOKEN_URI", "LAZYCAT_AUTH_OIDC_USERINFO_URI",
    "APP_URL", "UPLOADS_DIR",
  ];
  for (const name of required) {
    const value = env[name]?.trim();
    if (!value) { invalid.push(name); continue; }
    if (name.endsWith("_URI") || name === "APP_URL") {
      try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) invalid.push(name);
      } catch { invalid.push(name); }
    } else if (name.endsWith("_DIR") && !isAbsolute(value)) invalid.push(name);
  }
  if (invalid.length) throw new Error(`Invalid or missing lazycat configuration: ${invalid.join(", ")}`);
  return { target };
}
