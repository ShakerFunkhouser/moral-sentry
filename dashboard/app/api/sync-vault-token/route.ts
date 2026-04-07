import { auth0 } from "@/lib/auth0";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3666";

/**
 * Server-side route: reads the Auth0 session refresh token and
 * POSTs it to the dev gateway so Token Vault calls can use it.
 * The refresh token never touches client-side JS.
 */
export async function POST() {
  const session = await auth0.getSession();
  if (!session?.tokenSet?.refreshToken) {
    return Response.json({ synced: false, reason: "no_refresh_token" });
  }

  try {
    const res = await fetch(`${GATEWAY_URL}/mock/user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_refresh_token: session.tokenSet.refreshToken }),
    });
    if (!res.ok) throw new Error(`Gateway ${res.status}`);
    return Response.json({ synced: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ synced: false, reason: message }, { status: 502 });
  }
}
