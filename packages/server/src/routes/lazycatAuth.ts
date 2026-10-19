import { randomBytes } from "node:crypto";
import { Router, type Request, type Response, type Router as RouterType } from "express";
import { eq } from "drizzle-orm";
import { fetch } from "undici";
import { isReservedAgentName, validateName } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import { signAccessToken } from "../middleware/auth";
import { createUser, markEmailVerifiedForTest } from "../services/userService";
import { createSession } from "../services/sessionService";
import { getRequestLegalMetadata } from "../services/legalAcceptanceService";
import { normalizeEmail } from "../services/emailNormalization";
import { parseCookieHeader } from "../services/socialAuthService";

export const lazycatAuthRouter: RouterType = Router();
const STATE_COOKIE = "lzc_oidc_state";

function callbackUrl(req: Request): string {
  const origin = process.env.LAZYCAT_APP_DOMAIN
    ? `https://${process.env.LAZYCAT_APP_DOMAIN}`
    : `${req.protocol}://${req.get("host")}`;
  return `${origin}/api/auth/lazycat/callback`;
}

function errorPage(res: Response, status: number, message: string) {
  const escaped = message.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
  res.status(status).type("html").send(`<!DOCTYPE html><html><body><p>${escaped}</p></body></html>`);
}

lazycatAuthRouter.get("/start", (req, res) => {
  const authUri = process.env.LAZYCAT_AUTH_OIDC_AUTH_URI;
  const clientId = process.env.LAZYCAT_AUTH_OIDC_CLIENT_ID;
  if (!authUri || !clientId) {
    res.status(503).json({ error: "lazycat SSO not configured" });
    return;
  }
  try {
    const state = randomBytes(16).toString("hex");
    const url = new URL(authUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", callbackUrl(req));
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", state);
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true, sameSite: "lax", maxAge: 10 * 60 * 1000, path: "/",
      secure: callbackUrl(req).startsWith("https://"),
    });
    res.redirect(url.toString());
  } catch {
    errorPage(res, 500, "Invalid lazycat SSO configuration");
  }
});

lazycatAuthRouter.get("/callback", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  let state: string | undefined;
  try {
    state = parseCookieHeader(req.headers.cookie)[STATE_COOKIE];
  } catch {
    errorPage(res, 400, "Invalid lazycat SSO cookie");
    return;
  }
  res.clearCookie(STATE_COOKIE, { path: "/" });
  if (typeof req.query.state !== "string" || !state || req.query.state !== state) {
    errorPage(res, 400, "Invalid lazycat SSO state");
    return;
  }
  if (typeof req.query.code !== "string" || !req.query.code) {
    errorPage(res, 400, "Missing lazycat authorization code");
    return;
  }
  const tokenUri = process.env.LAZYCAT_AUTH_OIDC_TOKEN_URI;
  const userInfoUri = process.env.LAZYCAT_AUTH_OIDC_USERINFO_URI;
  const clientId = process.env.LAZYCAT_AUTH_OIDC_CLIENT_ID;
  const clientSecret = process.env.LAZYCAT_AUTH_OIDC_CLIENT_SECRET;
  if (!tokenUri || !userInfoUri || !clientId || !clientSecret) {
    errorPage(res, 500, "lazycat SSO not configured");
    return;
  }
  let profile: Record<string, unknown>;
  try {
    const tokenResponse = await fetch(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: req.query.code,
        redirect_uri: callbackUrl(req), client_id: clientId, client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenResponse.ok) {
      await tokenResponse.body?.cancel();
      errorPage(res, tokenResponse.status >= 500 ? 502 : 401, "Lazycat token exchange failed");
      return;
    }
    const token = await tokenResponse.json() as { access_token?: unknown };
    if (typeof token.access_token !== "string" || !token.access_token) {
      errorPage(res, 502, "Lazycat token response is missing access_token");
      return;
    }
    const userInfoResponse = await fetch(userInfoUri, {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!userInfoResponse.ok) {
      await userInfoResponse.body?.cancel();
      errorPage(res, userInfoResponse.status >= 500 ? 502 : 401, "Lazycat userinfo request failed");
      return;
    }
    profile = await userInfoResponse.json() as Record<string, unknown>;
    if (!profile || typeof profile.sub !== "string" || !profile.sub) {
      errorPage(res, 502, "Lazycat userinfo is missing sub");
      return;
    }
  } catch {
    errorPage(res, 502, "Unable to read lazycat SSO response");
    return;
  }
  try {
    const email = normalizeEmail(typeof profile.email === "string" && profile.email.trim()
      ? profile.email : `${profile.sub}@lazycat.local`);
    const candidate = typeof profile.preferred_username === "string"
      ? profile.preferred_username : typeof profile.name === "string" ? profile.name : null;
    const name = candidate && !validateName(candidate, "Name", 5) && !isReservedAgentName(candidate)
      ? candidate.trim() : null;
    const [user] = await getDb().select({ id: users.id, retiredAt: users.retiredAt })
      .from(users).where(eq(users.email, email));
    if (user?.retiredAt) {
      errorPage(res, 401, "This account is retired");
      return;
    }
    let userId = user?.id;
    if (!userId) {
      userId = (await createUser(
        email, randomBytes(32).toString("base64"), name,
        { acceptTerms: true, termsVersion: "2026-05-12", privacyVersion: "2026-05-12" },
        getRequestLegalMetadata(req), "signup", { deferProfileSetup: true },
      )).id;
      // 懒猫系统已完成账号所有者验证，应用层无需再发验证码。
      await markEmailVerifiedForTest(userId);
    }
    const { familyId, refreshToken } = await createSession(userId);
    const accessToken = signAccessToken(userId, familyId);
    // Escape script delimiters without changing the values stored by the browser.
    const scriptJson = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    const nonce = randomBytes(16).toString("base64");
    // Helmet's default CSP blocks inline scripts; authorize only this response's script.
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`);
    res.type("html").send(`<!DOCTYPE html><html><body><script nonce="${nonce}">localStorage.setItem('slock_access_token', ${scriptJson(accessToken)});localStorage.setItem('slock_refresh_token', ${scriptJson(refreshToken)});location.href='/';</script></body></html>`);
  } catch {
    errorPage(res, 500, "Lazycat sign-in failed");
  }
});
