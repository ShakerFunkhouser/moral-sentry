/**
 * Integration tests for the Auth0 + Token Vault layer.
 *
 * All HTTP calls (Management API token, user metadata, Token Vault exchange)
 * are intercepted via vi.stubGlobal("fetch", ...) - no network required.
 *
 * Covers:
 *  1. getPriorityWeights - custom weights from user_metadata merge over defaults
 *  2. getPriorityWeights - falls back to defaults when userId is null
 *  3. getPriorityWeights - falls back to defaults on M2M token failure
 *  4. requestVaultToken  - happy path returns third-party access token
 *  5. requestVaultToken  - 404 (user not connected) returns null
 *  6. requestVaultToken  - non-200 error returns null without throwing
 *  7. Full pipeline: getPriorityWeights + requestVaultToken in one flow
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getPriorityWeights,
  requestVaultToken,
  _resetTokenCache,
} from "./auth0.js";
import { DEFAULT_PRIORITY_WEIGHTS } from "./defaults.js";

// ── Fake Auth0 credentials ───────────────────────────────────────────────────
const FAKE_DOMAIN = "test.auth0.com";
const FAKE_CLIENT_ID = "test-client-id";
const FAKE_CLIENT_SECRET = "test-client-secret";

const M2M_TOKEN = "mock-management-api-token";
const VAULT_TOKEN = "mock-github-access-token";
const USER_REFRESH_TOKEN = "mock-user-refresh-token";
const USER_ID = "auth0|test-user-123";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/**
 * Build a stub fetch that routes on URL/body content.
 * - POST /oauth/token with client_credentials → M2M token
 * - POST /oauth/token with token-exchange grant → Token Vault
 * - GET  /api/v2/users/:id → user metadata
 */
function buildFetchStub({
  userMetadata = {},
  vaultStatus = 200,
  vaultAccessToken = VAULT_TOKEN,
  m2mStatus = 200,
}: {
  userMetadata?: Record<string, unknown>;
  vaultStatus?: number;
  vaultAccessToken?: string;
  m2mStatus?: number;
} = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();
    const bodyStr = (init?.body as string | undefined) ?? "";

    // M2M client_credentials token request
    if (
      urlStr === `https://${FAKE_DOMAIN}/oauth/token` &&
      bodyStr.includes('"client_credentials"')
    ) {
      return mockResponse(
        { access_token: M2M_TOKEN, expires_in: 86400 },
        m2mStatus,
      );
    }

    // Token Vault exchange (federated-connection grant)
    if (
      urlStr === `https://${FAKE_DOMAIN}/oauth/token` &&
      bodyStr.includes("token-exchange:federated-connection-access-token")
    ) {
      if (vaultStatus === 404) return mockResponse({}, 404);
      if (vaultStatus !== 200)
        return mockResponse({ error: "server_error" }, vaultStatus);
      return mockResponse({ access_token: vaultAccessToken });
    }

    // Management API - get user metadata
    if (urlStr.includes(`/api/v2/users/`)) {
      return mockResponse({ user_metadata: userMetadata });
    }

    throw new Error(`Unexpected fetch call: ${urlStr}`);
  });
}

// ── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetTokenCache();
  process.env.AUTH0_DOMAIN = FAKE_DOMAIN;
  process.env.AUTH0_CLIENT_ID = FAKE_CLIENT_ID;
  process.env.AUTH0_CLIENT_SECRET = FAKE_CLIENT_SECRET;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AUTH0_DOMAIN;
  delete process.env.AUTH0_CLIENT_ID;
  delete process.env.AUTH0_CLIENT_SECRET;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("getPriorityWeights", () => {
  it("returns default weights when userId is null (no Auth0 call)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const weights = await getPriorityWeights(null);

    expect(weights).toEqual(DEFAULT_PRIORITY_WEIGHTS);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("merges custom user_metadata weights over defaults", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchStub({
        userMetadata: {
          moral_priorities: {
            information_privacy: 0.95,
            system_stability: 0.5,
          },
        },
      }),
    );

    const weights = await getPriorityWeights(USER_ID);

    // Custom values win
    expect(weights["information_privacy"]).toBe(0.95);
    expect(weights["system_stability"]).toBe(0.5);
    // Unset facets keep their defaults
    expect(weights["resource_preservation"]).toBe(
      DEFAULT_PRIORITY_WEIGHTS["resource_preservation"],
    );
    expect(weights["goal_achievement"]).toBe(
      DEFAULT_PRIORITY_WEIGHTS["goal_achievement"],
    );
  });

  it("uses default weights when user_metadata has no moral_priorities", async () => {
    vi.stubGlobal("fetch", buildFetchStub({ userMetadata: {} }));

    const weights = await getPriorityWeights(USER_ID);

    expect(weights).toEqual(DEFAULT_PRIORITY_WEIGHTS);
  });

  it("falls back to defaults when the M2M token request fails", async () => {
    vi.stubGlobal("fetch", buildFetchStub({ m2mStatus: 500 }));

    const weights = await getPriorityWeights(USER_ID);

    expect(weights).toEqual(DEFAULT_PRIORITY_WEIGHTS);
  });

  it("silently falls back to defaults when Auth0 env vars are missing", async () => {
    delete process.env.AUTH0_DOMAIN;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const weights = await getPriorityWeights(USER_ID);

    expect(weights).toEqual(DEFAULT_PRIORITY_WEIGHTS);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reuses the cached M2M token on subsequent calls (only one token request)", async () => {
    const fetchStub = buildFetchStub({
      userMetadata: { moral_priorities: { information_privacy: 0.8 } },
    });
    vi.stubGlobal("fetch", fetchStub);

    await getPriorityWeights(USER_ID);
    await getPriorityWeights(USER_ID);

    const tokenCalls = fetchStub.mock.calls.filter(
      ([, init]) =>
        typeof init?.body === "string" &&
        (init.body as string).includes('"client_credentials"'),
    );
    // M2M token should only be fetched once across both calls
    expect(tokenCalls).toHaveLength(1);
  });
});

describe("requestVaultToken", () => {
  it("returns the third-party access token on success", async () => {
    vi.stubGlobal("fetch", buildFetchStub({ vaultAccessToken: VAULT_TOKEN }));

    const token = await requestVaultToken(USER_REFRESH_TOKEN, "github");

    expect(token).toBe(VAULT_TOKEN);
  });

  it("returns null when the user has not connected the provider (404)", async () => {
    vi.stubGlobal("fetch", buildFetchStub({ vaultStatus: 404 }));

    const token = await requestVaultToken(USER_REFRESH_TOKEN, "github");

    expect(token).toBeNull();
  });

  it("returns null and does not throw on a server error (500)", async () => {
    vi.stubGlobal("fetch", buildFetchStub({ vaultStatus: 500 }));

    const token = await requestVaultToken(USER_REFRESH_TOKEN, "google-oauth2");

    expect(token).toBeNull();
  });

  it("sends the correct grant_type and subject_token_type in the POST body", async () => {
    const fetchStub = buildFetchStub();
    vi.stubGlobal("fetch", fetchStub);

    await requestVaultToken(USER_REFRESH_TOKEN, "github");

    const vaultCall = fetchStub.mock.calls.find(
      ([, init]) =>
        typeof init?.body === "string" &&
        (init.body as string).includes(
          "token-exchange:federated-connection-access-token",
        ),
    );
    expect(vaultCall).toBeDefined();

    const body = JSON.parse(vaultCall![1]!.body as string);
    expect(body.grant_type).toBe(
      "urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token",
    );
    expect(body.subject_token).toBe(USER_REFRESH_TOKEN);
    expect(body.subject_token_type).toBe(
      "urn:ietf:params:oauth:token-type:refresh_token",
    );
    expect(body.connection).toBe("github");
  });

  it("returns null when Auth0 credentials are not configured", async () => {
    delete process.env.AUTH0_DOMAIN;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const token = await requestVaultToken(USER_REFRESH_TOKEN, "github");

    expect(token).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("getPriorityWeights + requestVaultToken - full pipeline", () => {
  it("fetches custom weights and vault token in the same test (simulates the plugin flow)", async () => {
    const fetchStub = buildFetchStub({
      userMetadata: {
        moral_priorities: {
          public_relations: 0.9,
          transparency: 0.7,
        },
      },
      vaultAccessToken: "ghp_mock_token_xyz",
    });
    vi.stubGlobal("fetch", fetchStub);

    const [weights, vaultToken] = await Promise.all([
      getPriorityWeights(USER_ID),
      requestVaultToken(USER_REFRESH_TOKEN, "github"),
    ]);

    expect(weights["public_relations"]).toBe(0.9);
    expect(weights["transparency"]).toBe(0.7);
    expect(vaultToken).toBe("ghp_mock_token_xyz");
  });
});
