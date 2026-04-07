import type { GatewayResponse, MockUserState, ToolCallRequest } from "./types";

/** POST a tool call to the Next.js API proxy → dev gateway */
export async function fireToolCall(
  req: ToolCallRequest,
): Promise<GatewayResponse> {
  const res = await fetch("/api/tool-call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gateway error ${res.status}: ${text}`);
  }
  return res.json() as Promise<GatewayResponse>;
}

/** GET the current mock Auth0 user state */
export async function getMockUser(): Promise<MockUserState> {
  const res = await fetch("/api/mock-user");
  if (!res.ok) throw new Error(`Failed to fetch mock user: ${res.status}`);
  return res.json() as Promise<MockUserState>;
}

/** POST new mock Auth0 user priorities */
export async function setMockUser(
  priorities: MockUserState["moral_priorities"],
): Promise<void> {
  const res = await fetch("/api/mock-user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ moral_priorities: priorities }),
  });
  if (!res.ok) throw new Error(`Failed to set mock user: ${res.status}`);
}

/** POST a refresh token into the mock user state so Token Vault calls use it */
export async function setMockRefreshToken(refreshToken: string): Promise<void> {
  const res = await fetch("/api/mock-user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`Failed to set refresh token: ${res.status}`);
}

/** DELETE the connected account and revoke the MRRT - resets the Token Vault demo */
export async function resetDemo(): Promise<void> {
  const res = await fetch("/api/reset", { method: "POST" });
  if (!res.ok) {
    const body = (await res
      .json()
      .catch(() => ({ error: `HTTP ${res.status}` }))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

/** PATCH real Auth0 user_metadata.moral_priorities via Management API */
export async function savePriorities(
  priorities: Record<string, number>,
): Promise<void> {
  const res = await fetch("/api/priorities", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ moral_priorities: priorities }),
  });
  if (!res.ok) {
    const body = (await res
      .json()
      .catch(() => ({ error: `HTTP ${res.status}` }))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}
