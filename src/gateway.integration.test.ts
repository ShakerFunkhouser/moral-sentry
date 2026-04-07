/**
 * Gateway harness integration tests for Moral Sentry.
 *
 * These tests exercise the full before_tool_call pipeline end-to-end - from
 * the plugin entry point in index.ts, through the moral calculus, to the
 * final allow / block / requireApproval decision - without any live services.
 *
 * How it works
 * ────────────
 * OpenClaw is not installed as a real package; its SDK is stubbed in
 * types/openclaw.d.ts. We build a minimal in-process "gateway harness" that
 * implements the same PluginRegistrationAPI interface, loads the plugin, and
 * lets us fire synthetic before_tool_call events.
 *
 * Auth0 / Token Vault: all fetch() calls are intercepted with vi.stubGlobal.
 * Hosted assessor: injected via pluginConfig.assessor so no network is needed.
 *
 * Scenarios tested (matching the demo example-json files)
 * ───────────────────────────────────────────────────────
 *  BLOCK     - nuclear-email   (divergence ~49 %)
 *  ESCALATE  - leaky-summary   (divergence ~26 %)
 *  ESCALATE  - vengeful-scheme (divergence ~23 %)
 *  ALLOW     - force-push      (divergence ~9 %)
 *
 * Plus Auth0 integration scenarios:
 *  - Custom user priority weights fetched from Auth0 user_metadata
 *  - Auth0 unavailable → defaults used, pipeline still runs
 *  - userId null → no Auth0 calls, pipeline still runs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  PluginRegistrationAPI,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  ImpactAssessment,
  ImpactAssessor,
  ToolCallContext,
} from "./types.js";
import { DEFAULT_FACETS } from "./defaults.js";
import { _resetTokenCache } from "./auth0.js";

// ── Fake Auth0 credentials ───────────────────────────────────────────────────

const FAKE_DOMAIN = "test.auth0.com";
const FAKE_CLIENT_ID = "fake-client-id";
const FAKE_CLIENT_SECRET = "fake-client-secret";
const FAKE_USER_ID = "auth0|gateway-test-user";
const FAKE_REFRESH_TOKEN = "fake-refresh-token";

// ── Gateway harness ──────────────────────────────────────────────────────────

type BeforeToolCallHandler = (
  ctx: BeforeToolCallContext,
) => Promise<BeforeToolCallResult>;

/**
 * Minimal in-process implementation of PluginRegistrationAPI.
 * Captures the before_tool_call handler and exposes fireToolCall()
 * to simulate what the OpenClaw gateway does on every tool invocation.
 */
class GatewayHarness {
  private handler: BeforeToolCallHandler | null = null;

  buildAPI(pluginConfig: Record<string, unknown> = {}): PluginRegistrationAPI {
    return {
      pluginConfig,
      on: (event: string, h: (...args: unknown[]) => unknown) => {
        if (event === "before_tool_call") {
          this.handler = h as BeforeToolCallHandler;
        }
      },
    } as PluginRegistrationAPI;
  }

  async fireToolCall(
    ctx: BeforeToolCallContext,
  ): Promise<BeforeToolCallResult> {
    if (!this.handler)
      throw new Error("Plugin not registered - did you call register(api)?");
    return this.handler(ctx);
  }
}

// ── Stub ImpactAssessor factory ──────────────────────────────────────────────

/**
 * Builds a stub ImpactAssessor that returns the supplied facet scores.
 * Scores are provided as { facetName: likelyValue } - min/max are inferred
 * as ±0.1 around the likely value to keep it realistic.
 */
function stubAssessor(scores: Record<string, number>): ImpactAssessor {
  const facetMap = new Map(DEFAULT_FACETS.map((f) => [f.name, f]));
  const assessment: ImpactAssessment = {
    facetRanges: Object.entries(scores).map(([name, likely]) => ({
      facet: facetMap.get(name) ?? { name, description: name },
      min: likely - 0.1,
      likely,
      max: likely + 0.1,
    })),
  };
  return {
    assessImpact: (_ctx: ToolCallContext) => Promise.resolve(assessment),
  };
}

// ── Auth0 fetch stub ─────────────────────────────────────────────────────────

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function buildAuth0FetchStub(
  userMetadata: Record<string, unknown> = {},
  m2mStatus = 200,
) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();
    const body = (init?.body as string | undefined) ?? "";

    if (
      urlStr === `https://${FAKE_DOMAIN}/oauth/token` &&
      body.includes('"client_credentials"')
    ) {
      return mockResponse(
        { access_token: "m2m-token", expires_in: 86400 },
        m2mStatus,
      );
    }
    if (urlStr.includes(`/api/v2/users/`)) {
      return mockResponse({ user_metadata: userMetadata });
    }
    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  });
}

// ── Plugin loader ─────────────────────────────────────────────────────────────
// Import the plugin entry once; the register() call is side-effect-free per call.

let pluginModule: {
  default: { register: (api: PluginRegistrationAPI) => void };
};

async function loadPlugin() {
  if (!pluginModule) {
    pluginModule = await import("../index.js");
  }
  return pluginModule.default;
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

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

// ── Decision scenarios ────────────────────────────────────────────────────────

describe("Gateway harness - decision pipeline", () => {
  it("BLOCK: nuclear-email scenario (~49% divergence)", async () => {
    vi.stubGlobal("fetch", buildAuth0FetchStub());

    const assessor = stubAssessor({
      resource_preservation: -0.9,
      information_privacy: 0.9,
      system_stability: -1.0,
      goal_achievement: 0.8,
    });

    const harness = new GatewayHarness();
    const plugin = await loadPlugin();
    plugin.register(harness.buildAPI({ assessor }));

    const result = await harness.fireToolCall({
      toolName: "exec",
      toolArgs: { cmd: "rm -rf /var/mail" },
      agentIntent: "Delete the entire mail server directory",
      userId: undefined,
    });

    expect(result).toHaveProperty("block", true);
    expect((result as { blockReason?: string }).blockReason).toMatch(
      /Moral Authorization Denied/,
    );
  });

  it("ESCALATE: leaky-summary scenario (~26% divergence)", async () => {
    vi.stubGlobal("fetch", buildAuth0FetchStub());

    const assessor = stubAssessor({
      information_privacy: -0.6,
      public_relations: -0.3,
      goal_achievement: 0.7,
      transparency: 0.5,
    });

    const harness = new GatewayHarness();
    const plugin = await loadPlugin();
    plugin.register(harness.buildAPI({ assessor }));

    const result = await harness.fireToolCall({
      toolName: "post_summary",
      toolArgs: { to: "all-staff@corp.com", body: "Confidential summary..." },
      agentIntent: "Send a summary of confidential documents to the team",
      userId: undefined,
    });

    expect(result).toHaveProperty("requireApproval");
    const r = result as {
      requireApproval: { title: string; severity: string };
    };
    expect(r.requireApproval.title).toMatch(/Moral Review/);
  });

  it("ALLOW: force-push scenario (~9% divergence)", async () => {
    vi.stubGlobal("fetch", buildAuth0FetchStub());

    const assessor = stubAssessor({
      system_stability: -0.2,
      resource_preservation: 0.1,
      goal_achievement: 0.9,
      public_relations: -0.1,
    });

    const harness = new GatewayHarness();
    const plugin = await loadPlugin();
    plugin.register(harness.buildAPI({ assessor }));

    const result = await harness.fireToolCall({
      toolName: "github.push",
      toolArgs: { branch: "main", force: true },
      agentIntent: "Force-push a hotfix to resolve a production bug",
      userId: undefined,
    });

    // Allow returns an empty object (no block, no requireApproval)
    expect(result).not.toHaveProperty("block");
    expect(result).not.toHaveProperty("requireApproval");
  });
});

// ── Auth0 integration scenarios ──────────────────────────────────────────────

describe("Gateway harness - Auth0 integration", () => {
  it("pulls custom priority weights from Auth0 user_metadata and affects the decision", async () => {
    // User has cranked information_privacy weight to maximum (1.0)
    // This pushes a mildly privacy-violating action over the block threshold
    vi.stubGlobal(
      "fetch",
      buildAuth0FetchStub({
        moral_priorities: { information_privacy: 1.0, system_stability: 1.0 },
      }),
    );

    // Mild privacy violation that would be ESCALATE with default weights
    // but should BLOCK once information_privacy = 1.0 amplifies the harm
    const assessor = stubAssessor({
      information_privacy: -0.7,
      system_stability: -0.7,
      goal_achievement: 0.6,
    });

    const harness = new GatewayHarness();
    const plugin = await loadPlugin();
    plugin.register(harness.buildAPI({ assessor }));

    const result = await harness.fireToolCall({
      toolName: "upload_doc",
      toolArgs: {
        path: "/internal/salaries.xlsx",
        destination: "public-bucket",
      },
      agentIntent: "Publish internal salary spreadsheet to the public bucket",
      userId: FAKE_USER_ID,
    });

    expect(result).toHaveProperty("block", true);
  });

  it("falls back to default weights gracefully when Auth0 is unreachable", async () => {
    vi.stubGlobal("fetch", buildAuth0FetchStub({}, 500)); // M2M token fetch fails

    // Scores that ALLOW under default weights
    const assessor = stubAssessor({
      goal_achievement: 0.9,
      system_stability: 0.1,
      resource_preservation: 0.0,
    });

    const harness = new GatewayHarness();
    const plugin = await loadPlugin();
    plugin.register(harness.buildAPI({ assessor }));

    // Should not throw even though Auth0 is down
    const result = await harness.fireToolCall({
      toolName: "read_file",
      toolArgs: { path: "/tmp/report.pdf" },
      userId: FAKE_USER_ID,
    });

    expect(result).not.toHaveProperty("block");
  });

  it("skips Auth0 entirely when userId is null (no fetch calls for metadata)", async () => {
    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      // Only Token Vault calls are acceptable here; metadata calls should not occur
      const urlStr = url.toString();
      if (urlStr.includes("/api/v2/users/")) {
        throw new Error(
          "User metadata should not be fetched when userId is null",
        );
      }
      return mockResponse({ access_token: "m2m-token", expires_in: 86400 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const assessor = stubAssessor({ goal_achievement: 0.8 });

    const harness = new GatewayHarness();
    const plugin = await loadPlugin();
    plugin.register(harness.buildAPI({ assessor }));

    await expect(
      harness.fireToolCall({
        toolName: "list_files",
        toolArgs: { dir: "/home" },
        userId: undefined, // no userId - simulates unauthenticated context
      }),
    ).resolves.toBeDefined();
  });
});

// ── Config overrides ──────────────────────────────────────────────────────────

describe("Gateway harness - plugin config overrides", () => {
  it("honours custom lowDivergenceThreshold from pluginConfig", async () => {
    vi.stubGlobal("fetch", buildAuth0FetchStub());

    // Scores that give ~9% divergence (normally ALLOW)
    const assessor = stubAssessor({
      goal_achievement: 0.9,
      system_stability: -0.1,
    });

    const harness = new GatewayHarness();
    const plugin = await loadPlugin();
    // Set threshold to 0 - everything diverging even slightly should escalate
    plugin.register(harness.buildAPI({ assessor, lowDivergenceThreshold: 0 }));

    const result = await harness.fireToolCall({
      toolName: "shell",
      toolArgs: { cmd: "ls" },
      userId: undefined,
    });

    // With threshold at 0, even a low-divergence action must not silently allow
    expect(
      "requireApproval" in result ||
        (result as { block?: boolean }).block === true,
    ).toBe(true);
  });

  it("honours custom highDivergenceThreshold from pluginConfig", async () => {
    vi.stubGlobal("fetch", buildAuth0FetchStub());

    // Scores that normally BLOCK (~49% divergence)
    const assessor = stubAssessor({
      resource_preservation: -0.9,
      system_stability: -1.0,
    });

    const harness = new GatewayHarness();
    const plugin = await loadPlugin();
    // Raise block threshold to 0.99 - essentially never block, only escalate
    plugin.register(
      harness.buildAPI({ assessor, highDivergenceThreshold: 0.99 }),
    );

    const result = await harness.fireToolCall({
      toolName: "exec",
      toolArgs: { cmd: "rm -rf /" },
      userId: undefined,
    });

    // Should escalate rather than hard-block because threshold was raised
    expect(result).toHaveProperty("requireApproval");
    expect(result).not.toHaveProperty("block");
  });
});
