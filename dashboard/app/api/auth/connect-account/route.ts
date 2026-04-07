import { auth0 } from "@/lib/auth0";
import { NextRequest } from "next/server";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const connection = searchParams.get("connection") ?? "google-oauth2";
  const returnTo = searchParams.get("returnTo") ?? "/";

  // Check for an active session with a refresh token first.
  // If the session's refresh token was issued before MRRT was enabled,
  // we need to force a fresh login so an MRRT-capable token is issued.
  const session = await auth0.getSession();
  if (!session) {
    const loginUrl = new URL("/api/auth/login", req.nextUrl.origin);
    loginUrl.searchParams.set(
      "returnTo",
      `/api/auth/connect-account?connection=${connection}&returnTo=${encodeURIComponent(returnTo)}`,
    );
    return Response.redirect(loginUrl.toString(), 302);
  }

  if (!session.tokenSet?.refreshToken) {
    // No refresh token - re-login forcing offline_access
    const loginUrl = new URL("/api/auth/login", req.nextUrl.origin);
    loginUrl.searchParams.set(
      "returnTo",
      `/api/auth/connect-account?connection=${connection}&returnTo=${encodeURIComponent(returnTo)}`,
    );
    return Response.redirect(loginUrl.toString(), 302);
  }

  // Attempt to exchange for a My Account API token directly to get a clear error
  const domain = process.env.AUTH0_DOMAIN!;
  const clientId = process.env.AUTH0_CLIENT_ID!;
  const clientSecret = process.env.AUTH0_CLIENT_SECRET!;

  const preCheck = await fetch(`https://${domain}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: session.tokenSet.refreshToken,
      audience: `https://${domain}/me/`,
      scope: "create:me:connected_accounts",
    }),
  });

  if (!preCheck.ok) {
    const errBody = await preCheck.text();
    console.error(
      `[connect-account] My Account API pre-check failed (${preCheck.status}): ${errBody}`,
    );
    let errJson: Record<string, string> = {};
    try {
      errJson = JSON.parse(errBody);
    } catch {
      /* */
    }

    // invalid_grant = refresh token revoked or expired (e.g. after demo reset) → re-login
    if (errJson.error === "invalid_grant" || preCheck.status === 401) {
      console.log(
        "[connect-account] Forcing re-login (invalid_grant); will return to connect flow",
      );
      // Return to this same connect-account URL after login so the OAuth flow
      // continues automatically without requiring the user to click again.
      const connectReturn = `/api/auth/connect-account?connection=${encodeURIComponent(connection)}&returnTo=${encodeURIComponent(returnTo)}`;
      const loginUrl = new URL("/api/auth/login", req.nextUrl.origin);
      loginUrl.searchParams.set("returnTo", connectReturn);
      return Response.redirect(loginUrl.toString(), 302);
    }

    const url = new URL(returnTo, req.nextUrl.origin);
    url.searchParams.set(
      "connect_error",
      `My Account API error (${preCheck.status}): ${errJson.error_description ?? errJson.error ?? errBody}`,
    );
    return Response.redirect(url.toString(), 302);
  }

  try {
    // Sync the (possibly new post-login) refresh token to the gateway so
    // Token Vault exchanges work as soon as the user returns from Google OAuth.
    const gatewayUrl =
      process.env.GATEWAY_URL ??
      process.env.NEXT_PUBLIC_GATEWAY_URL ??
      "http://localhost:3666";
    if (session.tokenSet.refreshToken) {
      fetch(`${gatewayUrl}/mock/user`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_refresh_token: session.tokenSet.refreshToken,
        }),
      }).catch(() => {});
    }

    // auth0.connectAccount is the public Auth0Client method - returns a plain NextResponse.
    // prompt:consent forces the Google consent screen to re-appear after demo reset;
    // do NOT pass it for GitHub - GitHub OAuth does not support the prompt parameter.
    const authorizationParams =
      connection === "google-oauth2" ? { prompt: "consent" } : {};
    return await auth0.connectAccount({
      connection,
      returnTo,
      authorizationParams,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[connect-account] auth0.connectAccount error:", message);
    const url = new URL(returnTo, req.nextUrl.origin);
    url.searchParams.set("connect_error", message);
    return Response.redirect(url.toString(), 302);
  }
}
