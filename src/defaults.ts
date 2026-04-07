// Moral Sentry - default facets and derived priority weights

import type { Facet, PriorityWeights } from "./types.js";

export const DEFAULT_FACETS: Facet[] = [
  {
    name: "resource_preservation",
    description:
      "Preservation of physical and digital resources (e.g., energy, materials, data)",
    defaultPriorityWeight: 0.6,
  },
  {
    name: "information_privacy",
    description:
      "Protection of private information and prevention of data leaks",
    defaultPriorityWeight: 0.8,
  },
  {
    name: "public_relations",
    description: "Maintenance of positive relationships and community trust",
    defaultPriorityWeight: 0.6,
  },
  {
    name: "system_stability",
    description: "Ensuring the reliability and robustness of systems",
    defaultPriorityWeight: 0.8,
  },
  {
    name: "goal_achievement",
    description: "Advancement towards the user's stated objectives",
    defaultPriorityWeight: 0.5,
  },
  {
    name: "transparency",
    description: "Promotion of openness and accountability",
    defaultPriorityWeight: 0.6,
  },
];

/**
 * Priority weights derived from DEFAULT_FACETS.defaultPriorityWeight.
 * Override individual entries via Auth0 user_metadata.moral_priorities.
 */
export const DEFAULT_PRIORITY_WEIGHTS: PriorityWeights = Object.fromEntries(
  DEFAULT_FACETS.map((f) => [f.name, f.defaultPriorityWeight ?? 0.5]),
);

// Thresholds are calibrated against the weighted harm signal (see calculus.ts).

/**
 * Divergence below this threshold AND calculus prescribes "execute":
 * allow the action silently.
 */
export const LOW_DIVERGENCE_THRESHOLD = 0.2;

/**
 * Divergence at or above this threshold: block the action outright.
 * (For the demo scenarios: clawhavoc-sudo scores ~0.57, shutdown-blackmail ~0.66 → BLOCK)
 */
export const HIGH_DIVERGENCE_THRESHOLD = 0.38;
