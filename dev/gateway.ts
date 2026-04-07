#!/usr/bin/env tsx
/**
 * Moral Sentry - Local Dev Gateway
 *
 * A minimal HTTP server that simulates the OpenClaw gateway running with the
 * Moral Sentry plugin loaded.  Auth0 and Token Vault are fully mocked in-process
 * so you can fire real tool-call requests and see allow / block / requireApproval
 * decisions without any live credentials.
 *
 * Usage:
 *   npm run dev-gateway
 *   # or directly:
 *   npx tsx dev/gateway.ts
 *
 * Then fire requests with curl (examples printed on startup).
 *
 * Endpoints:
 *   POST /tool-call         - run a tool call through the moral calculus
 *   POST /mock/user         - set the mock user's moral priority weights
 *   GET  /mock/user         - inspect the current mock user state
 *   GET  /health            - liveness check
 *
 * /tool-call request body:
 * {
 *   "toolName":    "send_email",
 *   "toolArgs":    { "to": "all@corp.com", "body": "..." },
 *   "agentIntent": "Send a summary of confidential documents",
 *   "userId":      "mock-user"          // optional; omit to skip Auth0 lookup
 * }
 *
 * /mock/user request body (Auth0 user_metadata shape):
 * {
 *   "moral_priorities": {
 *     "information_privacy": 0.95,
 *     "system_stability":    0.9
 *   }
 * }
 * Omit or POST {} to reset to default priority weights.
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import type {
  PluginRegistrationAPI,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  ImpactAssessor,
  ImpactAssessment,
  ToolCallContext,
} from "../src/types.js";
import { DEFAULT_FACETS, DEFAULT_PRIORITY_WEIGHTS } from "../src/defaults.js";
import { runCalculus } from "../src/calculus.js";
import { _resetTokenCache } from "../src/auth0.js";
import { DeepSeekAssessor } from "../src/deepseek-assessor.js";

// Load .env if present so DEEPSEEK_API_KEY etc. are available without exporting them manually
try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.startsWith("#"))
      process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
} catch {
  /* .env is optional */
}

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3666);
const MOCK_DOMAIN = "mock.auth0.local";

// Determine whether real Auth0 credentials are available.
// If so, the fetch mock will NOT intercept Auth0 calls - real M2M + Token Vault
// exchanges will be made.  If credentials are absent we fall back to stubs.
const auth0Live = !!(
  process.env.AUTH0_DOMAIN &&
  process.env.AUTH0_CLIENT_ID &&
  process.env.AUTH0_CLIENT_SECRET
);

// When credentials are absent, point auth0.ts at the mock domain.
if (!auth0Live) {
  process.env.AUTH0_DOMAIN = MOCK_DOMAIN;
  process.env.AUTH0_CLIENT_ID = "mock-client-id";
  process.env.AUTH0_CLIENT_SECRET = "mock-client-secret";
}

// ── Mock state (mutated at runtime via POST /mock/user) ──────────────────────
// In live mode this is still used for the audit trace displayed by the dashboard,
// but the plugin hook itself reads real priorities from Auth0 user_metadata.

// Persist user_refresh_token across gateway restarts so demo reset works without
// requiring the user to visit the dashboard again.
const TOKEN_PERSIST_FILE = ".gateway-state.json";

function loadPersistedState(): Record<string, unknown> {
  try {
    if (existsSync(TOKEN_PERSIST_FILE)) {
      const saved = JSON.parse(
        readFileSync(TOKEN_PERSIST_FILE, "utf8"),
      ) as Record<string, unknown>;
      if (saved.user_refresh_token) {
        console.log(
          "[gateway] Restored user_refresh_token from",
          TOKEN_PERSIST_FILE,
        );
        return { user_refresh_token: saved.user_refresh_token };
      }
    }
  } catch {
    /* ignore corrupt file */
  }
  return {};
}

function persistTokenIfPresent(metadata: Record<string, unknown>): void {
  const token = (metadata as { user_refresh_token?: string })
    .user_refresh_token;
  if (token) {
    try {
      writeFileSync(
        TOKEN_PERSIST_FILE,
        JSON.stringify({ user_refresh_token: token }),
        "utf8",
      );
    } catch {
      /* best-effort */
    }
  }
}

let mockUserMetadata: Record<string, unknown> = loadPersistedState();

// ── Install the global fetch interceptor ─────────────────────────────────────
// Always installed so we can stub the hosted assessor URL and pass everything
// else through.  Auth0 endpoints are only stubbed when auth0Live is false.

const realFetch = globalThis.fetch;

globalThis.fetch = async function mockedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = input.toString();
  const body = (init?.body as string | undefined) ?? "";

  function jsonResponse(data: unknown, status = 200): Response {
    const text = JSON.stringify(data);
    return new Response(text, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!auth0Live) {
    // Auth0 token endpoint (mock domain only)
    if (url === `https://${MOCK_DOMAIN}/oauth/token`) {
      if (body.includes('"client_credentials"')) {
        return jsonResponse({
          access_token: "mock-m2m-token",
          expires_in: 86400,
        });
      }
      if (body.includes("token-exchange:federated-connection-access-token")) {
        const parsed = JSON.parse(body) as { connection?: string };
        const conn = parsed.connection ?? "unknown";
        const mockTokens: Record<string, string> = {
          github: "ghp_MockGitHubToken1234567890abcdefgh",
          "google-oauth2": "ya29.MockGoogleOAuthToken_1234567890",
        };
        return jsonResponse({
          access_token: mockTokens[conn] ?? `mock-token-for-${conn}`,
        });
      }
    }

    // Management API - user metadata
    if (url.includes(MOCK_DOMAIN) && url.includes("/api/v2/users/")) {
      return jsonResponse({ user_metadata: mockUserMetadata });
    }
  }

  // In live mode, intercept Management API user metadata lookups for the mock
  // user ID so that slider changes are reflected in the calculus even when
  // real Auth0 credentials are configured.  Token endpoint calls (client_credentials
  // and token-exchange) are NOT intercepted - they go to the real Auth0 tenant.
  if (
    auth0Live &&
    url.includes("/api/v2/users/") &&
    init?.method !== "DELETE"
  ) {
    return jsonResponse({ user_metadata: mockUserMetadata });
  }

  // Moral Sentry hosted assessor - should never be called in dev but handle gracefully
  if (url.includes("moral-sentry.com") || url.includes("api.moral-sentry")) {
    console.warn(
      "[mock-fetch] ⚠️  Unexpected call to hosted assessor - returning neutral",
    );
    return jsonResponse({ facetRanges: [] });
  }

  return realFetch(input, init);
};

// ── Stub ImpactAssessor (reads scores from request body) ─────────────────────

/**
 * Builds an ImpactAssessor from a flat { facetName: likelyValue } map.
 * If no scores are provided, falls back to a neutral assessment.
 */
function makeAssessor(scores: Record<string, number>): ImpactAssessor {
  const facetMap = new Map(DEFAULT_FACETS.map((f) => [f.name, f]));
  const assessment: ImpactAssessment = {
    facetRanges: Object.entries(scores).map(([name, likely]) => ({
      facet: facetMap.get(name) ?? { name, description: name },
      min: Math.max(-1, likely - 0.1),
      likely,
      max: Math.min(1, likely + 0.1),
    })),
  };
  return {
    assessImpact: (_ctx: ToolCallContext) => Promise.resolve(assessment),
  };
}

// ── Gateway harness ───────────────────────────────────────────────────────────

type BeforeToolCallHandler = (
  ctx: BeforeToolCallContext,
) => Promise<BeforeToolCallResult>;

let registeredHandler: BeforeToolCallHandler | null = null;

function buildPluginAPI(
  assessor: ImpactAssessor | null,
): PluginRegistrationAPI {
  const userRefreshToken = (mockUserMetadata as { user_refresh_token?: string })
    .user_refresh_token;
  const priorityWeights = (
    mockUserMetadata as { moral_priorities?: Record<string, number> }
  ).moral_priorities;
  return {
    pluginConfig: {
      ...(assessor ? { assessor } : {}),
      ...(userRefreshToken ? { userRefreshToken } : {}),
      ...(priorityWeights ? { priorityWeights } : {}),
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (event === "before_tool_call") {
        registeredHandler = handler as BeforeToolCallHandler;
      }
    },
  } as PluginRegistrationAPI;
}

// ── Load plugin (deferred so fetch mock is in place first) ───────────────────

// We use a dynamic import so the env vars and fetch mock are set before module-level
// code in index.ts runs.
async function loadPlugin() {
  const mod = await import("../index.js");
  return mod.default;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

// ── Request body type for /tool-call ─────────────────────────────────────────

interface ToolCallRequest {
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  agentIntent?: string;
  userId?: string;
  /** Inline facet scores for this request - bypasses the hosted assessor */
  mockAssessment?: Record<string, number>;
  /** Human override: skip the moral-calculus escalation gate (not the Token Vault gate) */
  approved?: boolean;
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  try {
    // ── GET /health ──────────────────────────────────────────────────────────
    if (method === "GET" && url === "/health") {
      return send(res, 200, {
        status: "ok",
        auth0Live,
        auth0Domain: auth0Live ? process.env.AUTH0_DOMAIN : MOCK_DOMAIN,
        deepSeekLive: !!process.env.DEEPSEEK_API_KEY,
      });
    }

    // ── GET /mock/user ───────────────────────────────────────────────────────
    if (method === "GET" && url === "/mock/user") {
      return send(res, 200, { user_metadata: mockUserMetadata });
    }

    // ── POST /mock/user ──────────────────────────────────────────────────────
    if (method === "POST" && url === "/mock/user") {
      const raw = await readBody(req);
      const patch = JSON.parse(raw || "{}") as Record<string, unknown>;
      // Merge patch into existing mockUserMetadata so callers can update
      // moral_priorities and user_refresh_token independently.
      mockUserMetadata = { ...mockUserMetadata, ...patch };
      _resetTokenCache(); // clear M2M cache so next tool-call re-fetches metadata
      persistTokenIfPresent(mockUserMetadata);
      console.log(
        "[gateway] Mock user updated:",
        JSON.stringify(mockUserMetadata),
      );
      return send(res, 200, { ok: true, user_metadata: mockUserMetadata });
    }

    // ── POST /tool-call ──────────────────────────────────────────────────────
    if (method === "POST" && url === "/tool-call") {
      const raw = await readBody(req);
      const request: ToolCallRequest = JSON.parse(raw || "{}");

      const {
        toolName = "unknown_tool",
        toolArgs = {},
        agentIntent,
        userId,
        mockAssessment,
        approved = false,
      } = request;

      const hasMockScores =
        mockAssessment && Object.keys(mockAssessment).length > 0;

      // Resolve assessor and collect the live assessment for the audit response
      let resolvedAssessor: ImpactAssessor | null;
      let liveAssessment: ImpactAssessment | null = null;

      if (hasMockScores) {
        // Caller supplied explicit facet scores - use the stub (controlled test)
        resolvedAssessor = makeAssessor(mockAssessment!);
      } else if (process.env.DEEPSEEK_API_KEY) {
        // Live mode: call DeepSeek, capture the assessment, then pass it as a stub
        // so the plugin makes a single DeepSeek call (not two)
        const ds = new DeepSeekAssessor();
        liveAssessment = await ds.assessImpact({
          toolName,
          toolArgs,
          agentIntent,
        });
        const captured = liveAssessment;
        resolvedAssessor = {
          assessImpact: (_ctx: ToolCallContext) => Promise.resolve(captured),
        };
      } else {
        // No key and no mock scores - pass null so plugin defaults (neutral via HostedAssessor fail-open)
        resolvedAssessor = null;
      }

      // Re-register plugin with the assessor for this specific request
      const plugin = await loadPlugin();
      plugin.register(buildPluginAPI(resolvedAssessor));

      if (!registeredHandler) {
        return send(res, 500, {
          error: "Plugin did not register a before_tool_call handler",
        });
      }

      const ctx: BeforeToolCallContext = {
        toolName,
        toolArgs,
        agentIntent,
        userId,
      };
      let result = await registeredHandler(ctx);

      // Determine decision label for easy reading
      let decision: string;
      if ((result as { block?: boolean }).block) {
        decision = "BLOCK";
      } else if ((result as { requireApproval?: unknown }).requireApproval) {
        decision = "ESCALATE";
      } else {
        decision = "ALLOW";
      }

      // Human override: if the caller set approved=true and the hook escalated
      // for a *moral calculus* reason, honour the approval and ALLOW.
      // Token Vault "Account Not Connected" escalations are NOT overridable -
      // the user must connect their account first.
      let humanApproved = false;
      if (approved && decision === "ESCALATE") {
        const approvalTitle =
          (result as { requireApproval?: { title?: string } }).requireApproval
            ?.title ?? "";
        const isVaultGate = approvalTitle.includes("Not Connected");
        if (!isVaultGate) {
          decision = "ALLOW";
          result = {};
          humanApproved = true;
          console.log(`[gateway] ${toolName} → ALLOW (human approved)`);
        }
      }

      // Compute audit trace so the dashboard can display divergence / facet scores.
      // Use liveAssessment (DeepSeek) if available, otherwise rebuild from mockAssessment.
      const userPriorities =
        (mockUserMetadata as { moral_priorities?: Record<string, number> })
          .moral_priorities ?? {};
      const weights = { ...DEFAULT_PRIORITY_WEIGHTS, ...userPriorities };
      const facetMap = new Map(DEFAULT_FACETS.map((f) => [f.name, f]));
      const auditAssessment: ImpactAssessment = liveAssessment ?? {
        facetRanges: Object.entries(mockAssessment ?? {}).map(
          ([name, likely]) => ({
            facet: facetMap.get(name) ?? { name, description: name },
            min: Math.max(-1, likely - 0.1),
            likely,
            max: Math.min(1, likely + 0.1),
          }),
        ),
      };
      const audit = runCalculus(auditAssessment, weights);

      const userRefreshToken = (
        mockUserMetadata as { user_refresh_token?: string }
      ).user_refresh_token;

      console.log(`[gateway] ${toolName} → ${decision}`);
      return send(res, 200, {
        decision,
        result,
        liveAssessment: liveAssessment !== null,
        vaultConnected: !!userRefreshToken,
        humanApproved,
        audit: {
          prescribed: audit.prescribed,
          divergence: audit.divergence,
          executeValence: audit.executeValence,
          deferValence: audit.deferValence,
          facetScores: Object.fromEntries(
            audit.facetRanges.map((r) => [r.facet.name, r.likely]),
          ),
        },
      });
    }

    // ── POST /interpret ────────────────────────────────────────────────────
    if (method === "POST" && url === "/interpret") {
      const raw = await readBody(req);
      const { prompt } = JSON.parse(raw || "{}") as { prompt?: string };
      if (!prompt?.trim())
        return send(res, 400, { error: "prompt is required" });

      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey)
        return send(res, 503, {
          error: "DEEPSEEK_API_KEY not set - start gateway with that env var",
        });

      const apiUrl =
        process.env.DEEPSEEK_API_URL ?? "https://api.deepseek.com/v1";
      const model = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

      const upstream = await realFetch(`${apiUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content:
                'You translate natural-language agent scenarios into structured tool calls. Reply ONLY with a JSON object with exactly these keys: toolName (string), toolArgs (object), agentIntent (string), connection (string | null). The connection field identifies which third-party OAuth service the tool requires: use "google-oauth2" for Gmail/Google actions, "github" for GitHub actions, null for everything else. No other text or markdown.',
            },
            {
              role: "user",
              content: `Scenario: "${prompt.trim()}"\n\nCommon tools: exec (shell/CLI, args: {cmd}), send_email (via Gmail, args: {to, subject, body}), github_comment (post PR/issue comment, args: {repo, pr, body}), github_push (args: {branch, force}), read_file (args: {path}), write_file (args: {path, content}), delete_file (args: {path}), browser_navigate (args: {url}).\n\nInfer the single most likely tool call an AI agent would make for this scenario. Set connection to the OAuth service the tool requires (\"google-oauth2\", \"github\", or null).`,
            },
          ],
          response_format: { type: "json_object" },
        }),
      });

      const json = (await upstream.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content) as {
        toolName?: string;
        toolArgs?: Record<string, unknown>;
        agentIntent?: string;
        connection?: string | null;
      };
      console.log(
        `[gateway] /interpret → ${parsed.toolName ?? "?"}  "${parsed.agentIntent ?? ""}"${parsed.connection ? `  (${parsed.connection})` : ""}`,
      );
      return send(res, 200, parsed);
    }

    // ── POST /demo/reset ─────────────────────────────────────────────────
    // Disconnects a Token Vault connected account for the stored user, so the
    // Connect Account OAuth flow triggers fresh on the next demo run.
    // Body: { "connection": "google-oauth2" }  (default: "google-oauth2")
    if (method === "POST" && url === "/demo/reset") {
      if (!auth0Live) {
        return send(res, 400, {
          error: "Not applicable - Auth0 is mocked (no real Token Vault)",
        });
      }

      const raw = await readBody(req);
      const { connection = "google-oauth2" } = JSON.parse(raw || "{}") as {
        connection?: string;
      };

      const userRefreshToken = (
        mockUserMetadata as { user_refresh_token?: string }
      ).user_refresh_token;
      if (!userRefreshToken) {
        return send(res, 400, {
          error:
            "No user_refresh_token stored - log into the dashboard first so the token syncs",
        });
      }

      const domain = process.env.AUTH0_DOMAIN!;
      const clientId = process.env.AUTH0_CLIENT_ID!;
      const clientSecret = process.env.AUTH0_CLIENT_SECRET!;

      // Exchange the user's refresh token for a My Account API access token
      const tokenRes = await realFetch(`https://${domain}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: userRefreshToken,
          audience: `https://${domain}/me/`,
          scope: "delete:me:connected_accounts",
        }),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        return send(res, 502, {
          error: `Could not get My Account API token: ${err}`,
        });
      }

      const { access_token } = (await tokenRes.json()) as {
        access_token: string;
      };

      // Delete the connected account from Token Vault
      const deleteRes = await realFetch(
        `https://${domain}/me/v1/connected-accounts/${connection}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${access_token}` },
        },
      );

      if (
        deleteRes.status !== 204 &&
        deleteRes.status !== 200 &&
        deleteRes.status !== 404
      ) {
        const body = await deleteRes.text();
        return send(res, 502, {
          error: `Delete failed (${deleteRes.status}): ${body}`,
        });
      }
      const alreadyGone = deleteRes.status === 404;

      // Revoke the MRRT so the Token Vault exchange fails on the next tool call,
      // forcing the "Connect Account" gate to fire on the next demo run.
      // (Deleting the connected account record alone does not invalidate the
      // federated refresh token stored inside the MRRT.)
      // Auth0 RFC 7009 revocation endpoint: POST /oauth/revoke (no v2)
      const revokeRes = await realFetch(`https://${domain}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          token: userRefreshToken,
        }),
      });

      // Keep the (now-revoked) MRRT in gateway state - the vault exchange will fail
      // on the next tool call without requiring the user to re-sync.
      // The persist file keeps the revoked token so gateway restarts still trigger
      // the vault gate correctly.
      _resetTokenCache();

      const revokeOk = revokeRes.ok || revokeRes.status === 200;
      console.log(
        `[gateway] Demo reset - ${alreadyGone ? "already disconnected" : `disconnected ${connection}`}; MRRT revoke: ${revokeOk ? "ok" : revokeRes.status}`,
      );
      return send(res, 200, {
        ok: true,
        connection,
        note: alreadyGone ? "connected account was already gone" : undefined,
      });
    }

    // ── GET /debug/vault-test ────────────────────────────────────────────
    // Directly calls requestVaultToken with the stored refresh token to
    // surface the real Auth0 error (status + body) without going through the
    // full tool-call flow.  Query params: ?connection=google-oauth2|github
    if (method === "GET" && url.startsWith("/debug/vault-test")) {
      const qs = new URL(url, `http://localhost`).searchParams;
      const connection = qs.get("connection") ?? "google-oauth2";
      const userRefreshToken = (
        mockUserMetadata as { user_refresh_token?: string }
      ).user_refresh_token;

      if (!userRefreshToken) {
        return send(res, 400, {
          error:
            "No user_refresh_token in gateway state - log in and sync first",
          hint: "POST /mock/user  { user_refresh_token: '<token>' }",
        });
      }

      // Skip the fetch mock - call the real Auth0 endpoint directly
      const { requestVaultToken } = await import("../src/auth0.js");
      try {
        const token = await requestVaultToken(userRefreshToken, connection);
        return send(res, 200, {
          ok: true,
          connection,
          tokenPreview: token?.slice(0, 20) + "…",
        });
      } catch (err) {
        return send(res, 200, { ok: false, connection, error: String(err) });
      }
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("[gateway] Error:", err);
    send(res, 500, { error: String(err) });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  const base = `http://localhost:${PORT}`;

  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║           Moral Sentry - Local Dev Gateway                          ║
╚══════════════════════════════════════════════════════════════════════╝

Listening on ${base}
Auth0:        ${auth0Live ? "LIVE - " + process.env.AUTH0_DOMAIN : "MOCKED (set AUTH0_DOMAIN / AUTH0_CLIENT_ID / AUTH0_CLIENT_SECRET for live calls)"}
Token Vault:  ${auth0Live ? "LIVE - Token Vault exchanges will use real credentials" : "MOCKED (no real calls)"}
Assessor:     ${process.env.DEEPSEEK_API_KEY ? "LIVE - DeepSeek (" + (process.env.DEEPSEEK_MODEL ?? "deepseek-chat") + ")" : "INLINE (supply mockAssessment in request) or NEUTRAL (no key)"}

──────────────────────────────────────────────────────────────────────
 ENDPOINTS
──────────────────────────────────────────────────────────────────────

POST ${base}/tool-call
  Body: {
    "toolName":       string,
    "toolArgs":       object,
    "agentIntent":    string,
    "userId":         string | undefined,
    "mockAssessment": { facetName: likelyScore, ... }
  }

POST ${base}/mock/user
  Set mock Auth0 user_metadata (moral priority weights).
  Body: { "moral_priorities": { "information_privacy": 0.95, ... } }

GET  ${base}/mock/user    - inspect current mock user
GET  ${base}/health       - liveness check

──────────────────────────────────────────────────────────────────────
 EXAMPLE SCENARIOS (paste into a terminal)
──────────────────────────────────────────────────────────────────────

# BLOCK - nuclear/catastrophic email deletion (~50% divergence)
curl -s -X POST ${base}/tool-call \\
  -H "Content-Type: application/json" \\
  -d '{
    "toolName": "exec",
    "toolArgs": { "cmd": "rm -rf /var/mail" },
    "agentIntent": "Delete the entire mail server directory",
    "mockAssessment": {
      "resource_preservation": -0.9,
      "system_stability": -1.0,
      "information_privacy": 0.9,
      "goal_achievement": 0.8
    }
  }' | jq .

# ESCALATE - leaky document summary (~26% divergence)
curl -s -X POST ${base}/tool-call \\
  -H "Content-Type: application/json" \\
  -d '{
    "toolName": "send_email",
    "toolArgs": { "to": "all-staff@corp.com", "body": "Confidential summary..." },
    "agentIntent": "Send a summary of confidential documents to the team",
    "mockAssessment": {
      "information_privacy": -0.6,
      "public_relations": -0.3,
      "goal_achievement": 0.7,
      "transparency": 0.5
    }
  }' | jq .

# ALLOW - force-push hotfix (~9% divergence)
curl -s -X POST ${base}/tool-call \\
  -H "Content-Type: application/json" \\
  -d '{
    "toolName": "github.push",
    "toolArgs": { "branch": "main", "force": true },
    "agentIntent": "Force-push a hotfix to resolve a production bug",
    "mockAssessment": {
      "system_stability": -0.2,
      "resource_preservation": 0.1,
      "goal_achievement": 0.9,
      "public_relations": -0.1
    }
  }' | jq .

# Set custom moral priorities (raises information_privacy weight)
curl -s -X POST ${base}/mock/user \\
  -H "Content-Type: application/json" \\
  -d '{ "moral_priorities": { "information_privacy": 1.0, "system_stability": 1.0 } }' | jq .

# Then re-run the leaky summary - it should now BLOCK instead of ESCALATE
curl -s -X POST ${base}/tool-call \\
  -H "Content-Type: application/json" \\
  -d '{
    "toolName": "send_email",
    "toolArgs": { "to": "all-staff@corp.com", "body": "Confidential summary..." },
    "agentIntent": "Send a summary of confidential documents to the team",
    "userId": "mock-user",
    "mockAssessment": {
      "information_privacy": -0.6,
      "public_relations": -0.3,
      "goal_achievement": 0.7
    }
  }' | jq .

──────────────────────────────────────────────────────────────────────
`);
});
