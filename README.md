# Moral Sentry

> **Value-Based Authorization for Agentic AI** - middleware that gates every agent tool call against the user's personal ethical priorities stored in [Auth0](https://auth0.com).

---

## The Problem

Current agent authorization answers one question: _can_ the agent do this? It doesn't ask _should_ it. An agent with a GitHub token is equally authorized to push a hotfix and to delete every repository. Standard security models have no concept of moral alignment.

The result is what we call **alignment fiascos** - actions that are technically permitted but ethically catastrophic.

---

## The Solution

Moral Sentry exposes a `before_tool_call` hook that any agent runtime can call before executing a tool. The hook runs the proposed action through the [Objectifiabilist](https://github.com) moral calculus engine and returns an allow / block / escalate decision before any credentials are used.

```
Agent runtime  (LangChain / Vercel AI / custom gateway / …)
  └─ moral-sentry  (before_tool_call hook)
        │
        ├─ 1. Impact Assessor   → scores each facet of prosperity
        │                          (resource_preservation, information_privacy,
        │                           system_stability, public_relations, …)
        │
        ├─ 2. Auth0 Token Vault → fetches user's moral priority weights
        │                          stored as user_metadata
        │
        ├─ 3. Objectifiabilist  → runs weighted moral calculus
        │                          divergence = Σ(harm_i × weight_i) / Σ(weight_i)
        │
        ├─ divergence < 20%  →  ALLOW    (silent, credentials released)
        ├─ divergence ≥ 38%  →  BLOCK    (credentials withheld, reason returned)
        └─ in between        →  ESCALATE (requireApproval → user approval gate)
```

**Identity as a value system.** Auth0 doesn't just tell the agent who the user is - it tells the agent _what the user cares about_. An agent acting on your behalf should reflect your character, not just your permissions.

---

## Architecture

| Layer                  | Component                                                             | Role                                              |
| ---------------------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| Agent runtime          | Any framework with tool-call interception                             | Executes tool calls; calls the hook before each   |
| Ethics gate            | `moral-sentry` (this repo)                                            | `before_tool_call` hook; allow / block / escalate |
| Moral engine           | [`objectifiabilist`](./objectifiabilist)                              | Weighted Objectifiabilism calculus                |
| Identity & credentials | [Auth0 Token Vault](https://auth0.com/docs/secure/tokens/token-vault) | Stores moral priorities + third-party tokens      |
| Impact assessment      | `DeepSeekAssessor` / `HostedAssessor`                                 | Scores tool calls across 6 facets of prosperity   |

---

## Facets of Prosperity

The calculus evaluates every action across six dimensions:

| Facet                   | What it measures                                            |
| ----------------------- | ----------------------------------------------------------- |
| `resource_preservation` | Prevents wasteful destruction of physical or digital assets |
| `information_privacy`   | Prevents unauthorised disclosure of private data            |
| `system_stability`      | Prevents actions that degrade reliability or availability   |
| `public_relations`      | Prevents reputational or relational damage                  |
| `goal_achievement`      | Credits actions that advance the user's stated objectives   |
| `transparency`          | Credits openness and accountability                         |

Each facet is weighted by the user's `moral_priorities` in Auth0 `user_metadata`. A user who sets `information_privacy: Critical` will see even mild data-leakage scenarios escalated or blocked.

---

## Quickstart

### 1. Clone and install

```bash
git clone https://github.com/your-org/moral-sentry
cd moral-sentry
npm install
```

### 2. Configure Auth0

Set environment variables:

```bash
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_CLIENT_ID=your-m2m-client-id
AUTH0_CLIENT_SECRET=your-m2m-client-secret
```

Store user moral priorities in Auth0 `user_metadata`:

```json
{
  "moral_priorities": {
    "information_privacy": 0.95,
    "system_stability": 0.9,
    "resource_preservation": 0.6
  }
}
```

### 3. Integrate the hook

Call `plugin.register(api)` from your agent runtime, passing a `pluginConfig` with an `assessor` and optional `userRefreshToken`:

```typescript
import pluginEntry from "moral-sentry";

pluginEntry.register({
  pluginConfig: { assessor, userRefreshToken },
  on(event, handler) {
    if (event === "before_tool_call") agentRuntime.addHook(handler);
  },
});
```

The handler returns `{}` (allow), `{ block: true, blockReason }`, or `{ requireApproval: { title, description, severity } }`.

### 4. Set up Token Vault

Moral Sentry uses Auth0 Token Vault to hold GitHub and Google credentials. When a tool call targets a connected service (`send_email`, `github_comment`, `github_push`, etc.), the plugin verifies that the user has linked their account via Token Vault before proceeding. If no account is linked the action is escalated with a "Sign In Required" prompt so the user can connect their account first. See [Auth0 Token Vault docs](https://auth0.com/docs/secure/tokens/token-vault).

---

## Local Development & Demo

### Run the dev gateway (mocks all Auth0 calls)

```bash
npm run dev-gateway   # starts on http://localhost:3666
```

### Run the demo dashboard

```bash
npm run dev-dashboard  # starts on http://localhost:3000
```

The dashboard lets you:

- Adjust moral priority sliders to simulate different user profiles
- Fire pre-built catastrophic scenarios (nuclear email delete, leaky summary, force push, vengeful scheming)
- Watch the divergence bar and calculus trace update in real time
- See decisions flip from ESCALATE → BLOCK as you raise priority weights

---

## Example Decisions

### BLOCK - Nuclear email delete (~50% divergence)

```
Agent intent: "Delete the mail directory to reclaim disk space"
Tool:         exec { cmd: "rm -rf /var/mail" }

system_stability:     -1.00  (weight: High)
resource_preservation: -0.90  (weight: Moderate)

Divergence: 49.6% → BLOCK
Reason: "Moral Authorization Denied - system stability (-100%), resource preservation (-90%)"
```

### ESCALATE - Leaky document summary (~26% divergence)

```
Agent intent: "Summarise confidential documents and store the result"
Tool:         post_summary { to: "all-staff@corp.com" }

information_privacy: -0.60  (weight: High)

Divergence: 25.6% → ESCALATE (user approval required)
```

### ALLOW - Force-push hotfix (~9% divergence)

```
Agent intent: "Force-push a hotfix to resolve a production bug"
Tool:         github.push { branch: "main", force: true }

goal_achievement: +0.90
system_stability: -0.20  (low weight impact)

Divergence: 8.8% → ALLOW
```

---

## Running Tests

```bash
npm test
```

20 tests across two suites:

- `src/auth0.integration.test.ts` - 12 unit tests for Auth0 M2M, Token Vault exchange, priority weight merging
- `src/gateway.integration.test.ts` - 8 end-to-end tests through the full plugin pipeline (BLOCK / ESCALATE / ALLOW, Auth0 integration, config overrides)

---

## Project Structure

```
moral-sentry/
├── index.ts                    Hook entry point (register / before_tool_call)
├── src/
│   ├── types.ts                Core types (FacetRange, ImpactAssessment, AuditResult)
│   ├── defaults.ts             Default facets and priority weights
│   ├── calculus.ts             Objectifiabilist calculus bridge
│   ├── auth0.ts                Auth0 M2M + Token Vault
│   ├── connections.ts          GitHub / Google typed token wrappers
│   ├── deepseek-assessor.ts    DeepSeek-backed impact assessor
│   ├── hosted-assessor.ts      HTTP assessor (api.moral-sentry.com)
│   ├── auth0.integration.test.ts
│   └── gateway.integration.test.ts
├── objectifiabilist/           Pure moral calculus engine (public npm package)
├── dev/
│   └── gateway.ts              Local dev server with mocked Auth0
├── dashboard/                  Next.js demo dashboard
└── demo/
    └── run-scenarios.ts        CLI scenario runner
```

---

## The Bigger Picture

Most authorization systems answer: _is this user allowed to do this?_

Moral Sentry answers: _is this action consistent with who this user is?_

Auth0 Token Vault ensures the agent never holds live credentials - they are only released at the moment of an ethics-cleared tool call, and only for the connection the action requires. The architecture treats identity not as a static username, but as a dynamic ethical profile that governs what an agent may do on your behalf.

---

## Scope & Complementary Layers

Moral Sentry operates at the **tool-call layer** - the moment an agent attempts to take an action. This covers:

| Threat class                   | Example                                             | Covered?                                 |
| ------------------------------ | --------------------------------------------------- | ---------------------------------------- |
| Goal-driven harmful action     | Agent posts shaming thread after PR rejection       | ✅                                       |
| Self-preservation coercion     | Agent blackmails exec to avoid shutdown             | ✅                                       |
| Disproportionate action        | Agent deletes mail server to protect one secret     | ✅                                       |
| Privilege escalation           | Agent grants sudo to 3rd-party skill                | ✅                                       |
| Prompt-injection outcomes      | Hijacked agent exfiltrates credentials via `exec`   | ✅ (action blocked regardless of origin) |
| Data exfiltration              | Agent uploads private docs to public repo           | ✅                                       |
| Hallucination / misinformation | Chatbot states incorrect refund policy (Air Canada) | ❌ out of scope                          |

**On prompt injection:** Moral Sentry cannot detect _why_ an agent is making a suspicious call (legitimate mistake vs. adversarial injection), but it blocks any tool call whose action diverges from user priorities - providing defence-in-depth regardless of origin.

**On hallucination:** Text-generation errors (wrong facts, fabricated policies) occur before any tool call and require a separate output-validation layer such as NeMo Guardrails or a response filter. Moral Sentry is complementary to, not a replacement for, such layers.
