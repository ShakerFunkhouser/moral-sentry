// Stub ambient type declarations for openclaw's plugin SDK.
// The actual runtime is provided by OpenClaw when it loads the plugin.

declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface BeforeToolCallContext {
    /** Name of the tool being called */
    toolName?: string;
    /** Legacy alias */
    tool?: string;
    /** Arguments passed to the tool */
    toolArgs?: Record<string, unknown>;
    /** Legacy alias */
    args?: Record<string, unknown>;
    /** The agent's stated intent for this call */
    agentIntent?: string;
    /** Legacy alias */
    intent?: string;
    /** Auth0 user ID of the authenticated user */
    userId?: string;
    /** User object (may contain .id) */
    user?: { id?: string; [key: string]: unknown };
  }

  export interface ApprovalOptions {
    title: string;
    description: string;
    severity?: "low" | "medium" | "high" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "deny" | "allow";
    onResolution?: (decision: { approved: boolean }) => void | Promise<void>;
  }

  export type BeforeToolCallResult =
    | { block?: false; blockReason?: undefined; requireApproval?: undefined } // allow
    | { block: true; blockReason?: string; requireApproval?: undefined } // hard block
    | { block?: undefined; requireApproval: ApprovalOptions }; // escalate

  export interface PluginRegistrationAPI {
    pluginConfig?: Record<string, unknown>;
    on(
      event: "before_tool_call",
      handler: (
        ctx: BeforeToolCallContext,
      ) => Promise<BeforeToolCallResult> | BeforeToolCallResult,
    ): void;
    on(event: string, handler: (...args: unknown[]) => unknown): void;
  }

  export interface PluginEntry {
    id?: string;
    name?: string;
    description?: string;
    kind?: string;
    register: (api: PluginRegistrationAPI) => void;
  }

  export function definePluginEntry(entry: PluginEntry): PluginEntry;
  export const emptyPluginConfigSchema: unknown;
}
