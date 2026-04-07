// Moral Sentry - Auth0 integration
// Fetches a user's moral priority weights from Auth0 user_metadata via the Management API.
// Falls back to DEFAULT_PRIORITY_WEIGHTS when credentials are absent or the user has no custom priorities.

import type { PriorityWeights } from "./types.js";
import { DEFAULT_PRIORITY_WEIGHTS } from "./defaults.js";

interface Auth0Config {
  domain: string;
  clientId: string;
  clientSecret: string;
}

function getAuth0Config(): Auth0Config | null {
  const domain = process.env.AUTH0_DOMAIN;
  const clientId = process.env.AUTH0_CLIENT_ID;
  const clientSecret = process.env.AUTH0_CLIENT_SECRET;
  if (!domain || !clientId || !clientSecret) return null;
  return { domain, clientId, clientSecret };
}

let cachedToken: { value: string; expiresAt: number } | null = null;

/** @internal - used only in tests to clear the module-level M2M token cache. */
export function _resetTokenCache(): void {
  cachedToken = null;
}

/**
 * Obtain a Management API access token via the client_credentials grant.
 * The token is cached until it is within 60s of expiry.
 */
async function getManagementToken(cfg: Auth0Config): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - now > 60_000) {
    return cachedToken.value;
  }

  const res = await fetch(`https://${cfg.domain}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      audience: `https://${cfg.domain}/api/v2/`,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Auth0 token request failed: ${res.status} ${await res.text()}`,
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedToken = {
    value: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };
  return cachedToken.value;
}

/**
 * Fetch user_metadata for a given Auth0 user ID.
 */
async function getUserMetadata(
  cfg: Auth0Config,
  userId: string,
): Promise<Record<string, unknown>> {
  const token = await getManagementToken(cfg);
  const encoded = encodeURIComponent(userId);
  const res = await fetch(
    `https://${cfg.domain}/api/v2/users/${encoded}?fields=user_metadata&include_fields=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) {
    throw new Error(
      `Auth0 user fetch failed: ${res.status} ${await res.text()}`,
    );
  }

  const data = (await res.json()) as {
    user_metadata?: Record<string, unknown>;
  };
  return data.user_metadata ?? {};
}

/**
 * Return priority weights for the given user, merging Auth0 user_metadata on top of
 * the defaults. Silently falls back to defaults if Auth0 is not configured or the
 * request fails.
 *
 * Expected user_metadata shape:
 *   { "moral_priorities": { "information_privacy": 0.9, "system_stability": 0.7, ... } }
 */
export async function getPriorityWeights(
  userId: string | null,
): Promise<PriorityWeights> {
  if (!userId) return { ...DEFAULT_PRIORITY_WEIGHTS };

  const cfg = getAuth0Config();
  if (!cfg) {
    console.warn(
      "[moral-sentry] Auth0 not configured - using default priority weights",
    );
    return { ...DEFAULT_PRIORITY_WEIGHTS };
  }

  try {
    const metadata = await getUserMetadata(cfg, userId);
    const custom = metadata["moral_priorities"];
    if (custom && typeof custom === "object" && !Array.isArray(custom)) {
      const merged: PriorityWeights = { ...DEFAULT_PRIORITY_WEIGHTS };
      for (const [facet, weight] of Object.entries(
        custom as Record<string, unknown>,
      )) {
        if (typeof weight === "number" && weight >= 0 && weight <= 1) {
          merged[facet] = weight;
        }
      }
      return merged;
    }
  } catch (err) {
    console.error("[moral-sentry] Auth0 fetch failed - using defaults:", err);
  }

  return { ...DEFAULT_PRIORITY_WEIGHTS };
}

/**
 * Exchange an Auth0 refresh token for the user's stored third-party access token
 * from Token Vault (e.g. their GitHub or Google OAuth token).
 *
 * Uses Auth0's proprietary federated-connection token exchange grant:
 *   POST https://{domain}/oauth/token
 *   grant_type    = urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token
 *   subject_token = the user's Auth0 refresh token (not a Management API token)
 *   connection    = the social connection name ("github" or "google-oauth2")
 *
 * Prerequisites - see readme for full setup guide:
 *   1. Social connection: Authentication > Social Connections > [connection] > Purpose >
 *      toggle "Connected Accounts for Token Vault" ON.
 *   2. Application grant types: Advanced Settings > Grant Types >
 *      enable "Token Vault" + "Refresh Token" + "Authorization Code".
 *   3. Application: Advanced Settings > enable Multi-Resource Refresh Token (MRRT).
 *   4. Activate the My Account API: Applications > APIs > MyAccount API > Activate.
 *   5. Create a client grant for your app on the My Account API with scopes:
 *      create:me:connected_accounts, read:me:connected_accounts, delete:me:connected_accounts
 *   6. The user must have connected their GitHub/Google account via the My Account API
 *      (POST https://{domain}/me/connected_accounts) before vault tokens are available.
 *   7. AUTH0_DOMAIN / AUTH0_CLIENT_ID / AUTH0_CLIENT_SECRET env vars set.
 *
 * @param userRefreshToken  The user's Auth0 refresh token (obtained at login with offline_access scope)
 * @param connection        Token Vault connection name ("github" or "google-oauth2")
 * @returns The stored third-party access token, or null if unavailable.
 */
export async function requestVaultToken(
  userRefreshToken: string,
  connection: string,
): Promise<string | null> {
  const cfg = getAuth0Config();
  if (!cfg) {
    console.warn(
      "[moral-sentry] Auth0 not configured - Token Vault unavailable",
    );
    return null;
  }

  const body = {
    grant_type:
      "urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    // The subject_token is the user's own Auth0 refresh token, not an M2M token.
    // The app must have been granted the Token Vault grant type and MRRT must be enabled.
    subject_token: userRefreshToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:refresh_token",
    // Auth0-specific token type for federated connection access tokens
    requested_token_type:
      "http://auth0.com/oauth/token-type/federated-connection-access-token",
    // connection selects which Token Vault entry to retrieve
    connection,
  };

  try {
    const res = await fetch(`https://${cfg.domain}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.status === 404) {
      // User has not yet connected this provider via the My Account API
      return null;
    }

    if (!res.ok) {
      const text = await res.text();

      // 401 federated_connection_refresh_token_not_found = account not connected yet
      // (same semantic as 404 - show the Connect Account button)
      try {
        const json = JSON.parse(text) as { error?: string };
        if (json.error === "federated_connection_refresh_token_not_found") {
          return null;
        }
      } catch {
        /* ignore parse errors */
      }

      const msg = `Auth0 Token Vault ${res.status}: ${text}`;
      console.error(
        `[moral-sentry] Token Vault exchange failed (${res.status}) for connection=${connection}: ${text}`,
      );
      throw new Error(msg);
    }

    const data = (await res.json()) as { access_token?: string };
    return data.access_token ?? null;
  } catch (err) {
    console.error("[moral-sentry] Token Vault request failed:", err);
    return null;
  }
}
