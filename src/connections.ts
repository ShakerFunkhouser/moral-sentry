// Moral Sentry - Token Vault connection definitions
//
// Mirrors the Auth0 AI SDK "withTokenVault" configuration from the docs:
//   https://auth0.com/ai/docs/integrations/github
//   https://auth0.com/ai/docs/integrations/google
//
// Since Moral Sentry is an OpenClaw plugin (not a Vercel AI / LangChain app),
// we use our own requestVaultToken() instead of the framework-specific
// Auth0AI.withTokenVault() wrapper.  The connection names and scopes below
// exactly match what was configured in the Auth0 Dashboard.

import { requestVaultToken } from "./auth0.js";

// ── GitHub ──────────────────────────────────────────────────────────────────
// GitHub Apps use fine-grained permissions, so scopes are NOT requested here;
// they are set when creating the GitHub App in GitHub Developer Settings.
// See: https://auth0.com/ai/docs/integrations/github

export const GITHUB_CONNECTION = "github";
export const GITHUB_SCOPES: string[] = [];

export function getGitHubToken(
  userRefreshToken: string,
): Promise<string | null> {
  return requestVaultToken(userRefreshToken, GITHUB_CONNECTION);
}

// ── Google ───────────────────────────────────────────────────────────────────
// Full Gmail access is required to demonstrate blocking inflammatory email
// sends and mass email deletion in the Moral Sentry demo scenarios.
// See: https://auth0.com/ai/docs/integrations/google

export const GOOGLE_CONNECTION = "google-oauth2";
export const GOOGLE_SCOPES = ["openid", "https://mail.google.com/"] as const;

export function getGoogleToken(
  userRefreshToken: string,
): Promise<string | null> {
  return requestVaultToken(userRefreshToken, GOOGLE_CONNECTION);
}

// ── Connection detection ──────────────────────────────────────────────────────
// Infers which (if any) connected account a tool call requires, based on the
// tool name and arguments.  Returns null when no connected account is needed.

const GITHUB_PATTERNS = [
  /\bgit(hub)?/i,
  /\bgh\b/,
  /\b(push|pull|clone|commit|pr|branch|repo)\b/i,
];

const GOOGLE_PATTERNS = [
  /\bgoogle\b/i,
  /\bgmail\b/i,
  /\b(send_email|email|draft|inbox)\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Infer which Token Vault connection (if any) a tool call requires.
 * Checks the tool name and any string-valued arguments.
 *
 * Returns "github" | "google-oauth2" | null.
 */
export function detectConnection(
  toolName: string,
  toolArgs: Record<string, unknown>,
): "github" | "google-oauth2" | null {
  const tokens = [
    toolName,
    ...Object.values(toolArgs).flatMap((v) =>
      typeof v === "string" ? [v] : [],
    ),
  ].join(" ");

  if (matchesAny(tokens, GITHUB_PATTERNS)) return GITHUB_CONNECTION;
  if (matchesAny(tokens, GOOGLE_PATTERNS)) return GOOGLE_CONNECTION;
  return null;
}

const CONNECTION_LABELS: Record<string, string> = {
  [GITHUB_CONNECTION]: "GitHub",
  [GOOGLE_CONNECTION]: "Google",
};

export function connectionLabel(connection: string): string {
  return CONNECTION_LABELS[connection] ?? connection;
}
