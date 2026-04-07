// Dashboard types - mirror the plugin's src/types.ts + dev/gateway.ts shapes

export interface PriorityWeights {
  resource_preservation: number;
  information_privacy: number;
  public_relations: number;
  system_stability: number;
  goal_achievement: number;
  transparency: number;
  [key: string]: number;
}

/** Flat map of facet name → likely impact score (−1 to +1) */
export type MockAssessment = Record<string, number>;

export interface ToolCallRequest {
  toolName: string;
  toolArgs: Record<string, unknown>;
  agentIntent: string;
  userId?: string;
  /** Omit to let the gateway call DeepSeek live; supply to use inline scores */
  mockAssessment?: MockAssessment;
  /** Human override: skip the moral-calculus escalation gate (not the Token Vault gate) */
  approved?: boolean;
}

export interface GatewayResult {
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    severity: string;
  };
}

export interface GatewayAudit {
  prescribed: string;
  divergence: number;
  executeValence: number;
  deferValence: number;
  facetScores: Record<string, number>;
}

export interface MockUserState {
  moral_priorities: Partial<PriorityWeights>;
  /** Auth0 refresh token - used to exchange for Token Vault credentials */
  user_refresh_token?: string;
}

export interface GatewayResponse {
  decision: "BLOCK" | "ESCALATE" | "ALLOW";
  result: GatewayResult;
  audit?: GatewayAudit;
  /** True when the gateway called DeepSeek live (no mockAssessment was supplied) */
  liveAssessment?: boolean;
  /** True when a user_refresh_token was present and Token Vault was invoked */
  vaultConnected?: boolean;
  /** True when the human approved an escalated action */
  humanApproved?: boolean;
}
