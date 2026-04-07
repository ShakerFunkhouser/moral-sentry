// Moral Sentry - DeepSeek ImpactAssessor
//
// Uses the DeepSeek Chat API (OpenAI-compatible) to produce an impartial,
// structured impact assessment for a given tool call.
//
// The LLM's role is purely descriptive: "if this action executes, what are
// its likely effects on each concern?"  It does NOT make a moral judgment -
// that is the job of the Objectifiabilist calculus in calculus.ts.
//
// Configuration (env vars):
//   DEEPSEEK_API_KEY   - required
//   DEEPSEEK_MODEL     - optional, defaults to "deepseek-chat"
//   DEEPSEEK_API_URL   - optional, defaults to https://api.deepseek.com/v1

import type {
  ImpactAssessor,
  ImpactAssessment,
  FacetRange,
  ToolCallContext,
  Facet,
} from "./types.js";
import { DEFAULT_FACETS } from "./defaults.js";

const DEFAULT_API_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

export interface DeepSeekAssessorOptions {
  apiKey?: string;
  apiUrl?: string;
  model?: string;
  facets?: Facet[];
}

/**
 * Calls the DeepSeek Chat API to produce a per-facet impact assessment.
 *
 * The response is a JSON object mapping each facet name to a
 * { min, likely, max } range where all values are in [-1.0, 1.0]:
 *   -1.0 = maximally harmful to this concern
 *    0.0 = neutral / no effect
 *   +1.0 = maximally beneficial to this concern
 *
 * The LLM is instructed to reason factually about likely real-world effects,
 * not to make a moral judgment. Uncertainty is expressed as a wide range
 * (e.g. min:-0.9, likely:-0.3, max:0.2) rather than hedged prose.
 */
export class DeepSeekAssessor implements ImpactAssessor {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly model: string;
  private readonly facets: Facet[];

  constructor(options: DeepSeekAssessorOptions = {}) {
    const key = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!key) {
      throw new Error(
        "[moral-sentry] DeepSeekAssessor requires DEEPSEEK_API_KEY. " +
          "Set it in your environment or pass apiKey to the constructor.",
      );
    }
    this.apiKey = key;
    this.apiUrl =
      options.apiUrl ?? process.env.DEEPSEEK_API_URL ?? DEFAULT_API_URL;
    this.model = options.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL;
    this.facets = options.facets ?? DEFAULT_FACETS;
  }

  async assessImpact(ctx: ToolCallContext): Promise<ImpactAssessment> {
    const facetList = this.facets
      .map((f) => `- ${f.name}: ${f.description}`)
      .join("\n");

    const toolDescription = [
      `Tool: ${ctx.toolName}`,
      ctx.toolArgs && Object.keys(ctx.toolArgs).length > 0
        ? `Arguments: ${JSON.stringify(ctx.toolArgs)}`
        : null,
      ctx.agentIntent ? `Agent's stated intent: ${ctx.agentIntent}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const systemPrompt = `You are an impartial impact analyst for an AI safety system. \
Your role is purely descriptive: given a tool call that an AI agent is about to execute, \
you estimate the likely real-world effects on each of the following concerns. \
You do NOT make a moral judgment or decide whether the action is good or bad overall - \
that is handled separately. You only describe what will likely happen.

Concerns to assess:
${facetList}

Respond with ONLY a valid JSON object. Each key is a concern name from the list above. \
Each value is an object with three numbers, all in the range [-1.0, 1.0]:
  "min":    worst plausible effect on this concern (most harmful end of the uncertainty range)
  "likely": most probable effect
  "max":    best plausible effect (most beneficial end)

-1.0 means maximally harmful to this concern. \
0.0 means no effect. \
1.0 means maximally beneficial. \
Express genuine uncertainty as a wide range, not a narrow one centered on 0. \
Do not include any explanation, markdown, or keys outside the concern names.`;

    const userPrompt = `Assess the impact of this tool call:\n\n${toolDescription}`;

    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.1, // low temperature for consistent structured output
          max_tokens: 512,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
    } catch (err) {
      console.error(
        "[moral-sentry] DeepSeek API unreachable - returning neutral assessment:",
        err,
      );
      return { facetRanges: [] };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[moral-sentry] DeepSeek API error ${res.status}: ${body}`);
      return { facetRanges: [] };
    }

    const completion = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = completion.choices?.[0]?.message?.content ?? "";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      console.error("[moral-sentry] DeepSeek returned non-JSON:", content);
      return { facetRanges: [] };
    }

    return parseAssessment(parsed, this.facets);
  }
}

function clamp(v: number): number {
  return Math.max(-1.0, Math.min(1.0, v));
}

function parseAssessment(
  data: Record<string, unknown>,
  facets: Facet[],
): ImpactAssessment {
  const facetMap = new Map(facets.map((f) => [f.name, f]));
  const facetRanges: FacetRange[] = [];

  for (const [name, entry] of Object.entries(data)) {
    const facet = facetMap.get(name);
    if (!facet || !entry || typeof entry !== "object") continue;

    const { min, likely, max } = entry as Record<string, unknown>;
    if (
      typeof min !== "number" ||
      typeof likely !== "number" ||
      typeof max !== "number"
    )
      continue;

    facetRanges.push({
      facet,
      min: clamp(min),
      likely: clamp(likely),
      max: clamp(max),
    });
  }

  return { facetRanges };
}
