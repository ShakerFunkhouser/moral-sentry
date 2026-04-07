// Moral Sentry - internal types
// These types describe the impact assessment output and the audit result
// produced by the calculus bridge.

export interface Facet {
  name: string;
  description: string;
  defaultPriorityWeight?: number;
}

/**
 * Per-facet range produced by the impact assessor.
 * All values are floats in [-1, 1]:
 *   -1 = maximally harmful, 0 = neutral, +1 = maximally beneficial.
 */
export interface FacetRange {
  facet: Facet;
  min: number;
  likely: number;
  max: number;
}

/**
 * Full impact assessment across all recognised facets of prosperity.
 * Facets absent from the assessment are treated as neutral (0).
 */
export interface ImpactAssessment {
  // resource_preservation?: FacetRange;
  // information_privacy?: FacetRange;
  // public_relations?: FacetRange;
  // system_stability?: FacetRange;
  // goal_achievement?: FacetRange;
  // transparency?: FacetRange;
  // internal_cohesion?: FacetRange;
  // [facet: string]: FacetRange | undefined;
  // date: Date;
  facetRanges: FacetRange[];
}

/**
 * Raw tool-call context forwarded to the assessor.
 */
export interface ToolCallContext {
  toolName: string;
  toolArgs: Record<string, unknown>;
  agentIntent?: string;
}

export interface ImpactAssessor {
  assessImpact(ctx: ToolCallContext): Promise<ImpactAssessment>;
}

/**
 * Result produced by the calculus bridge before the plugin decides allow/block/approve.
 */
export interface AuditResult {
  /** The choice recommended by the calculus ("execute" or "defer"). */
  prescribed: string;
  /** Mean absolute divergence in [0, 1] between execute and defer preferability. */
  divergence: number;
  /** Raw moral valence of the "execute" choice (can be negative). */
  executeValence: number;
  /** Raw moral valence of the "defer" choice. */
  deferValence: number;
  /** Snapshot of the impact assessment used as input. */
  facetRanges: FacetRange[];
}

/**
 * Per-facet importance weights used to build the Ethic passed to objectifiabilist.
 * Values are floats in [0, 1] where 1 = highest importance.
 */
export type PriorityWeights = Record<string, number>;
