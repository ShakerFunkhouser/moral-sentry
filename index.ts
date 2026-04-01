// Moral Sentry — OpenClaw plugin entry point
// Registers a before_tool_call hook that intercepts every agent tool call,
// runs a moral calculus, and allows / blocks / escalates accordingly.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { HostedAssessor } from "./src/hosted-assessor.js";
import { runCalculus } from "./src/calculus.js";
import { getPriorityWeights } from "./src/auth0.js";
import { LOW_DIVERGENCE_THRESHOLD, HIGH_DIVERGENCE_THRESHOLD } from "./src/defaults.js";
import type { ImpactAssessor } from "./src/types.js";

// Default assessor: calls the Moral Sentry hosted API.
// Swap this out with any ImpactAssessor implementation — your own LLM, a
// rules engine, or a self-hosted endpoint.
const defaultAssessor: ImpactAssessor = new HostedAssessor();

export default definePluginEntry({
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
      const toolArgs: Record<string, unknown> =
        (ctx.toolArgs ?? ctx.args ?? {}) as Record<string, unknown>;
      const agentIntent: string | undefined =
        (ctx.agentIntent ?? ctx.intent) as string | undefined;
      const userId: string | null =
        (ctx.userId ?? ctx.user?.id ?? null) as string | null;

      // Resolve assessor: plugin config can supply a custom ImpactAssessor instance.
      const assessor: ImpactAssessor =
        (cfg["assessor"] as ImpactAssessor | undefined) ?? defaultAssessor;

      // 1. Assess the moral impact of executing this tool call
      let assessment;
      try {
        assessment = await assessor.assessImpact({ toolName, toolArgs, agentIntent });
      } catch (err) {
        console.error("[moral-sentry] Assessor error — allowing by default:", err);
        return {}; // fail open; operators can flip this to { block: true } for stricter mode
      }

      // 2. Fetch the user's moral priority weights from Auth0 (or use defaults)
      const weights = await getPriorityWeights(userId);

      // 3. Run the Objectifiabilism calculus
      const audit = runCalculus(assessment, weights);

      console.log(
        `[moral-sentry] ${toolName} | prescribed=${audit.prescribed} | divergence=${audit.divergence.toFixed(3)}`
      );

      // 4. Decision tree

      // If the calculus prescribes "execute" and divergence is below the low threshold,
      // allow silently — the action is morally consistent with the user's priorities.
      if (audit.prescribed === "execute" && audit.divergence < LOW_THRESHOLD) {
        return {};
      }

      // If divergence is above the high threshold, the action strongly conflicts with
      // the user's moral priorities — block outright.
      if (audit.divergence >= HIGH_THRESHOLD) {
        const reason = formatBlockReason(audit);
        return { block: true, blockReason: reason };
      }

      // If prescribed is "defer" OR divergence is in the medium zone,
      // escalate to the user via the native platform approval UI (Telegram inline buttons).
      return {
        requireApproval: {
          title: `Moral Review: ${toolName}`,
          description: formatApprovalDescription(audit),
          severity: audit.divergence > 0.45 ? "high" : "medium",
          timeoutMs: 120_000, // 2 minutes
          timeoutBehavior: "deny",
          onResolution: async (decision: { approved: boolean }) => {
            if (!decision.approved) {
              console.log(
                `[moral-sentry] User denied ${toolName} after moral review`
              );
            }
          },
        },
      };
    });
  },
});

// ── Formatting helpers ──────────────────────────────────────────────────────

function topHarmFacets(facetRanges: ReturnType<typeof runCalculus>["facetRanges"]): string {
  return facetRanges
    .filter((r) => r.likely < -0.3)
    .sort((a, b) => a.likely - b.likely)
    .slice(0, 3)
    .map((r) => `${r.facet.name.replace(/_/g, " ")} (${(r.likely * 100).toFixed(0)}%)`)
    .join(", ");
}

function formatBlockReason(audit: ReturnType<typeof runCalculus>): string {
  const harms = topHarmFacets(audit.facetRanges);
  return (
    `Moral Authorization Denied — this action was assessed as strongly misaligned with your ethical priorities. ` +
    (harms ? `Primary concerns: ${harms}.` : "")
  );
}

function formatApprovalDescription(audit: ReturnType<typeof runCalculus>): string {
  const pctDivergence = (audit.divergence * 100).toFixed(0);
  const harms = topHarmFacets(audit.facetRanges);
  const lines = [
    `This action requires your explicit approval before proceeding.`,
    `Moral divergence score: ${pctDivergence}% (${audit.prescribed === "defer" ? "calculus recommends deferring" : "calculus is uncertain"}).`,
  ];
  if (harms) lines.push(`Potential concerns: ${harms}.`);
  lines.push(`Execute valence: ${audit.executeValence.toFixed(4)} | Defer valence: ${audit.deferValence.toFixed(4)}`);
  return lines.join("\n");
}
