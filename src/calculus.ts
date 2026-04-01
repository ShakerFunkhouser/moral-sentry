// Moral Sentry — calculus bridge
// Maps an ImpactAssessment + PriorityWeights into objectifiabilist types,
// runs the moral calculus, and returns a structured AuditResult.

import {
  getPrescribedChoice,
  calculateAllMoralValences,
  calculatePreferabilities,
} from "objectifiabilist";
import type {
  Dilemma,
  Ethic,
  Choice,
  Effect,
  Group,
  MoralPriority,
} from "objectifiabilist";
import type {
  ImpactAssessment,
  PriorityWeights,
  AuditResult,
} from "./types.js";

// A single synthetic group representing "the user and their stakeholders".
// characteristicBandMemberships with count:1 ensures calculateImportance
// returns a non-zero weight when the concern's characteristicBands is empty
// (vacuously satisfied by any group member).
const AFFECTED_GROUP: Group = {
  name: "affected_parties",
  description: "The user and all parties affected by this agent action",
  characteristicBandMemberships: [{ characteristicBands: [], count: 1 }],
};

// Build a Choice (execute or defer) from a per-facet impact map
function buildChoice(
  name: string,
  facetImpacts: Record<string, number>,
): Choice {
  const effects: Effect[] = Object.entries(facetImpacts).map(
    ([facet, magnitude]) => ({
      affectedGroup: AFFECTED_GROUP,
      facetOfProsperity: facet,
      outlook: "near-term",
      possibleBenefits: [
        {
          likelihood: 1.0,
          quantitativeMagnitude: magnitude,
          signage:
            magnitude > 0 ? "positive" : magnitude < 0 ? "negative" : "zero",
        },
      ],
    }),
  );
  return { name, effects };
}

// Build the objectifiabilist Ethic from the user's priority weights
function buildEthic(weights: PriorityWeights): Ethic {
  const moralPriorities: MoralPriority[] = Object.entries(weights).map(
    ([facet, weight]) => ({
      moralConcern: {
        kind: "characteristicBand",
        characteristicBands: [],
        facetOfProsperity: facet,
        outlook: "near-term",
      },
      importance: weight, // already in [0, 1]
    }),
  );

  return {
    name: "user_ethic",
    moralPriorities,
    optimismBias: 0.0,
  };
}

/**
 * Run the Objectifiabilism calculus and return an AuditResult.
 *
 * Strategy:
 *   - "execute" choice: uses the `likely` value for each facet
 *   - "defer"   choice: all facets are neutral (0) — deferring has no direct impact
 *
 * Divergence is computed as the normalised absolute difference in preferability
 * ordinals between the two choices, scaled to [0, 1].
 */
export function runCalculus(
  assessment: ImpactAssessment,
  weights: PriorityWeights,
): AuditResult {
  // Build per-facet impact maps
  const executeFacets: Record<string, number> = {};
  const deferFacets: Record<string, number> = {};

  for (const { facet, likely } of assessment.facetRanges) {
    executeFacets[facet.name] = likely;
    deferFacets[facet.name] = 0.0; // deferring is neutral
  }

  const executeChoice = buildChoice("execute", executeFacets);
  const deferChoice = buildChoice("defer", deferFacets);

  const dilemma: Dilemma = {
    name: "tool_call_dilemma",
    choices: [executeChoice, deferChoice],
  };

  const ethic = buildEthic(weights);

  const valences = calculateAllMoralValences(dilemma, ethic);
  const prescribed = getPrescribedChoice(dilemma, ethic);

  // Divergence: weighted harm signal = sum(harm_i * weight_i) / sum(weight_i)
  //   where harm_i = max(0, -likely_i) for each facet present in the assessment.
  //
  // This measures "how much damage to high-priority facets does executing this
  // action cause?" and is bounded in [0, 1].  It is independent of offsetting
  // benefits so that privacy violations or stability risks are not silently
  // cancelled out by goal-achievement gains.
  let weightedHarm = 0;
  let totalWeight = 0;
  for (const { facet, likely } of assessment.facetRanges) {
    const w = weights[facet.name] ?? 0.5;
    weightedHarm += Math.max(0, -likely) * w;
    totalWeight += w;
  }
  const divergence = totalWeight > 0 ? weightedHarm / totalWeight : 0;

  return {
    prescribed,
    divergence,
    executeValence: valences["execute"] ?? 0,
    deferValence: valences["defer"] ?? 0,
    facetRanges: assessment.facetRanges,
  };
}

// Re-export calculatePreferabilities so index.ts and tests can use it without
// importing from objectifiabilist directly.
export { calculatePreferabilities };
