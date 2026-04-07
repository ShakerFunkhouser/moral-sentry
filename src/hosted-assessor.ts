// Moral Sentry - Hosted ImpactAssessor
//
// Default implementation of ImpactAssessor that calls the Moral Sentry hosted
// assessment API. The actual LLM + prompt engineering stay private on the server;
// this file is safe to publish. Rate-limiting is handled by the API.
//
// Anyone can supply their own ImpactAssessor implementation conforming to the
// interface in types.ts - swap in any LLM or rules engine you like.

import type {
  ImpactAssessor,
  ImpactAssessment,
  FacetRange,
  ToolCallContext,
  Facet,
} from "./types.js";
import { DEFAULT_FACETS } from "./defaults.js";

const DEFAULT_API_URL = "https://api.moral-sentry.com/assess";

export interface HostedAssessorOptions {
  /** Override the endpoint, e.g. for local dev or self-hosted deployments. */
  apiUrl?: string;
  /**
   * Optional API key (Bearer token).  Without a key the hosted endpoint uses a
   * shared rate-limit tier suitable for demos and evaluation.
   */
  apiKey?: string;
  /** Facet set to score against. Defaults to DEFAULT_FACETS. */
  facets?: Facet[];
}

/**
 * Calls the Moral Sentry hosted assessment API.
 *
 * The API accepts a tool call context plus a list of facets and returns a
 * per-facet { min, likely, max } range object. The prompt engineering and LLM
 * calibration that produce reliable scores are server-side and not published.
 *
 * On network error or rate-limit the assessor returns an empty assessment
 * (neutral), which causes the calculus to allow the action - fail-open by
 * default. Operators who prefer fail-closed can catch the empty case in index.ts.
 */
export class HostedAssessor implements ImpactAssessor {
  private readonly apiUrl: string;
  private readonly apiKey: string | undefined;
  private readonly facets: Facet[];

  constructor(options: HostedAssessorOptions = {}) {
    this.apiUrl =
      options.apiUrl ?? process.env.MORAL_SENTRY_API_URL ?? DEFAULT_API_URL;
    this.apiKey = options.apiKey ?? process.env.MORAL_SENTRY_API_KEY;
    this.facets = options.facets ?? DEFAULT_FACETS;
  }

  async assessImpact(ctx: ToolCallContext): Promise<ImpactAssessment> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const body = JSON.stringify({
      toolName: ctx.toolName,
      toolArgs: ctx.toolArgs,
      ...(ctx.agentIntent ? { agentIntent: ctx.agentIntent } : {}),
      facets: this.facets.map((f) => ({
        name: f.name,
        description: f.description,
      })),
    });

    let res: Response;
    try {
      res = await fetch(this.apiUrl, { method: "POST", headers, body });
    } catch (err) {
      console.warn(
        "[moral-sentry] Hosted assessor unreachable - returning neutral assessment",
      );
      return { facetRanges: [] };
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      console.warn(
        `[moral-sentry] Rate limited by hosted assessor${retryAfter ? ` - retry after ${retryAfter}s` : ""}. ` +
          "Set MORAL_SENTRY_API_KEY for a higher limit.",
      );
      return { facetRanges: [] };
    }

    if (!res.ok) {
      console.error(
        `[moral-sentry] Hosted assessor returned ${res.status} - returning neutral assessment`,
      );
      return { facetRanges: [] };
    }

    const data = (await res.json()) as unknown;
    return parseResponse(data, this.facets);
  }
}

function clamp(v: number): number {
  return Math.max(-1.0, Math.min(1.0, v));
}

/**
 * Parse the flat `{ facet_name: { min, likely, max } }` response from the API
 * into the structured ImpactAssessment type, attaching Facet metadata.
 */
function parseResponse(data: unknown, facets: Facet[]): ImpactAssessment {
  if (typeof data !== "object" || data === null) return { facetRanges: [] };

  const facetMap = new Map(facets.map((f) => [f.name, f]));
  const facetRanges: FacetRange[] = [];

  for (const [name, entry] of Object.entries(data as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { min, likely, max } = entry as Record<string, unknown>;
    if (
      typeof min !== "number" ||
      typeof likely !== "number" ||
      typeof max !== "number"
    )
      continue;

    facetRanges.push({
      facet: facetMap.get(name) ?? { name, description: name },
      min: clamp(min),
      likely: clamp(likely),
      max: clamp(max),
    });
  }

  return { facetRanges };
}
