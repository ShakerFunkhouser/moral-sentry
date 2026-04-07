// Moral Sentry - OpenClaw plugin entry point
// Registers a before_tool_call hook that intercepts every agent tool call,
// runs a moral calculus, and allows / blocks / escalates accordingly.

import {
  definePluginEntry,
  emptyPluginConfigSchema,
} from "openclaw/plugin-sdk/plugin-entry";
import type { BeforeToolCallResult } from "openclaw/plugin-sdk/plugin-entry";
import { HostedAssessor } from "./src/hosted-assessor.js";
import { DeepSeekAssessor } from "./src/deepseek-assessor.js";
import { runCalculus } from "./src/calculus.js";
import { getPriorityWeights } from "./src/auth0.js";
import {
  detectConnection,
  connectionLabel,
  getGitHubToken,
  getGoogleToken,
} from "./src/connections.js";
import {
  LOW_DIVERGENCE_THRESHOLD,
  HIGH_DIVERGENCE_THRESHOLD,
} from "./src/defaults.js";
import type { ImpactAssessor, PriorityWeights } from "./src/types.js";

// Default assessor: use DeepSeekAssessor when DEEPSEEK_API_KEY is available,
// otherwise fall back to the hosted API (fails open if the endpoint is down).
const defaultAssessor: ImpactAssessor = process.env.DEEPSEEK_API_KEY
  ? new DeepSeekAssessor()
  : new HostedAssessor();

export default definePluginEntry({
  id: "moral-sentry",
  name: "Moral Sentry",
  description:
    "Intercepts agent tool calls and runs an Objectifiabilist moral calculus.",
  configSchema: emptyPluginConfigSchema,
  register(api) {
    // Read configurable thresholds from plugin config (with defaults)
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const LOW_THRESHOLD =
      typeof cfg["lowDivergenceThreshold"] === "number"
        ? cfg["lowDivergenceThreshold"]
        : LOW_DIVERGENCE_THRESHOLD;
    const HIGH_THRESHOLD =
      typeof cfg["highDivergenceThreshold"] === "number"
        ? cfg["highDivergenceThreshold"]
        : HIGH_DIVERGENCE_THRESHOLD;

    api.on("before_tool_call", async (ctx) => {
      const toolName: string = ctx.toolName ?? ctx.tool ?? "unknown_tool";
      const toolArgs: Record<string, unknown> = (ctx.toolArgs ??
        ctx.args ??
        {}) as Record<string, unknown>;
      const agentIntent: string | undefined = (ctx.agentIntent ??
        ctx.intent) as string | undefined;
      const userId: string | null = (ctx.userId ?? ctx.user?.id ?? null) as
        | string
        | null;

      // Resolve assessor: plugin config can supply a custom ImpactAssessor instance.
      const assessor: ImpactAssessor =
        (cfg["assessor"] as ImpactAssessor | undefined) ?? defaultAssessor;

      // 0. Token Vault consent check - runs BEFORE the moral calculus.
      //    If the tool targets a connected service (GitHub or Google), verify that
      //    the user has linked their account via Auth0 Token Vault.  No vault token
      //    means no consent has been granted - escalate immediately so the user can
      //    connect their account before the agent proceeds.
      const userRefreshToken = cfg["userRefreshToken"] as string | undefined;
      const connection = detectConnection(toolName, toolArgs);

      // 1. Assess the moral impact of executing this tool call
      let assessment;
      try {
        assessment = await assessor.assessImpact({
          toolName,
          toolArgs,
          agentIntent,
        });
      } catch (err) {
        console.error(
          "[moral-sentry] Assessor error - allowing by default:",
          err,
        );
        return {}; // fail open; operators can flip this to { block: true } for stricter mode
      }

      // 2. Fetch the user's moral priority weights from Auth0 (or use defaults).
      //    If the plugin host injected weights directly (e.g. from the dev gateway),
      //    use those instead of making a Management API round-trip.
      const injectedWeights = cfg["priorityWeights"] as
        | PriorityWeights
        | undefined;
      const weights = injectedWeights ?? (await getPriorityWeights(userId));

      // 3. Run the Objectifiabilism calculus
      const audit = runCalculus(assessment, weights);

      console.log(
        `[moral-sentry] ${toolName} | prescribed=${audit.prescribed} | divergence=${audit.divergence.toFixed(3)}`,
      );

      // 4. Decision tree
      let hookDecision: "allow" | "block" | "escalate";
      let result: BeforeToolCallResult;

      if (audit.prescribed === "execute" && audit.divergence < LOW_THRESHOLD) {
        hookDecision = "allow";
        result = {};
      } else if (audit.divergence >= HIGH_THRESHOLD) {
        // Strongly conflicts with user's moral priorities - block outright.
        // Do NOT run the vault gate: harmful actions are rejected before OAuth is relevant.
        hookDecision = "block";
        result = { block: true, blockReason: formatBlockReason(audit) };
      } else {
        // Prescribed "defer" or medium-zone divergence - escalate for human review.
        // If the action also requires a connected account, check Token Vault first.
        if (connection) {
          if (!userRefreshToken) {
            const label = connectionLabel(connection);
            console.log(
              `[moral-sentry] ${toolName} | ESCALATE - Token Vault: no session (user not signed in)`,
            );
            const noSessionResult: BeforeToolCallResult = {
              requireApproval: {
                title: `Sign In Required`,
                description:
                  `The agent wants to perform a ${label} action via Token Vault, ` +
                  `but no Auth0 session is active. Sign in to link your ${label} account and grant consent.`,
                severity: "high",
                timeoutMs: 120_000,
                timeoutBehavior: "deny",
              },
            };
            return noSessionResult;
          }

          let vaultToken: string | null = null;
          let vaultError: string | undefined;
          try {
            vaultToken =
              connection === "github"
                ? await getGitHubToken(userRefreshToken)
                : await getGoogleToken(userRefreshToken);
          } catch (err) {
            vaultError = err instanceof Error ? err.message : String(err);
            console.error(
              `[moral-sentry] Token Vault error for ${connection}:`,
              vaultError,
            );
          }

          if (!vaultToken) {
            const label = connectionLabel(connection);
            console.log(
              `[moral-sentry] ${toolName} | ESCALATE - Token Vault: no ${label} token${vaultError ? ` (error: ${vaultError})` : " (user not connected)"}`,
            );
            const descSuffix = vaultError
              ? `\n\n⚠️ Auth0 error: ${vaultError}`
              : `Connect your account at Settings → Connected Accounts, then retry.`;
            const noConsentResult: BeforeToolCallResult = {
              requireApproval: {
                title: `${label} Account Not Connected`,
                description:
                  `The agent wants to perform a ${label} action, but your ${label} account ` +
                  `is not linked to your Auth0 profile via Token Vault. ` +
                  descSuffix,
                severity: "high",
                timeoutMs: 120_000,
                timeoutBehavior: "deny",
              },
            };
            // Fire webhook so the dashboard LiveFeed shows the vault-gate escalation
            const dashboardUrl = process.env.MORAL_SENTRY_DASHBOARD_URL;
            if (dashboardUrl) {
              fetch(`${dashboardUrl}/api/events/ingest`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  toolName,
                  toolArgs,
                  agentIntent,
                  userId,
                  decision: "escalate",
                  divergence: 1,
                  prescribed: "defer",
                  vaultGate: true,
                  connection,
                  timestamp: Date.now(),
                }),
              }).catch(() => {});
            }
            return noConsentResult;
          }

          console.log(
            `[moral-sentry] ${toolName} | Token Vault ✓ ${connectionLabel(connection)} consent verified`,
          );
        }

        hookDecision = "escalate";
        result = {
          requireApproval: {
            title: `Moral Review: ${toolName}`,
            description: formatApprovalDescription(audit),
            severity: audit.divergence > 0.45 ? "high" : "medium",
            timeoutMs: 120_000, // 2 minutes
            timeoutBehavior: "deny",
            onResolution: async (d: { approved: boolean }) => {
              if (!d.approved) {
                console.log(
                  `[moral-sentry] User denied ${toolName} after moral review`,
                );
              }
            },
          },
        };
      }

      // 5. Fire-and-forget webhook to dashboard LiveFeed
      const dashboardUrl = process.env.MORAL_SENTRY_DASHBOARD_URL;
      if (dashboardUrl) {
        fetch(`${dashboardUrl}/api/events/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            toolName,
            toolArgs,
            agentIntent,
            userId,
            decision: hookDecision,
            divergence: audit.divergence,
            prescribed: audit.prescribed,
            timestamp: Date.now(),
          }),
        }).catch(() => {});
      }

      return result;
    });
  },
});

// ── Formatting helpers ──────────────────────────────────────────────────────

function topHarmFacets(
  facetRanges: ReturnType<typeof runCalculus>["facetRanges"],
): string {
  return facetRanges
    .filter((r) => r.likely < -0.3)
    .sort((a, b) => a.likely - b.likely)
    .slice(0, 3)
    .map(
      (r) =>
        `${r.facet.name.replace(/_/g, " ")} (${(r.likely * 100).toFixed(0)}%)`,
    )
    .join(", ");
}

function formatBlockReason(audit: ReturnType<typeof runCalculus>): string {
  const harms = topHarmFacets(audit.facetRanges);
  return (
    `Moral Authorization Denied - this action was assessed as strongly misaligned with your ethical priorities. ` +
    (harms ? `Primary concerns: ${harms}.` : "")
  );
}

function formatApprovalDescription(
  audit: ReturnType<typeof runCalculus>,
): string {
  const pctDivergence = (audit.divergence * 100).toFixed(0);
  const harms = topHarmFacets(audit.facetRanges);
  const lines = [
    `This action requires your explicit approval before proceeding.`,
    `Moral divergence score: ${pctDivergence}% (${audit.prescribed === "defer" ? "calculus recommends deferring" : "calculus is uncertain"}).`,
  ];
  if (harms) lines.push(`Potential concerns: ${harms}.`);
  lines.push(
    `Execute valence: ${audit.executeValence.toFixed(4)} | Defer valence: ${audit.deferValence.toFixed(4)}`,
  );
  const dashboardUrl = process.env.DASHBOARD_URL;
  if (dashboardUrl)
    lines.push(`\n[View in Moral Sentry Dashboard](${dashboardUrl})`);
  return lines.join("\n");
}
