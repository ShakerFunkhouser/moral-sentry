import { auth0 } from "@/lib/auth0";
import { NextRequest } from "next/server";

/**
 * Disconnects a Token Vault connected account for the logged-in user.
 * Uses the user's own session refresh token to get a My Account API token,
 * then calls DELETE /me/v1/connected-accounts/{connection}.
 *
 * Used for demo reset: removes the stored Google/GitHub token so the
 * "Connect Account" flow triggers fresh on the next run.
 */
export async function POST(req: NextRequest) {
  const session = await auth0.getSession();
  if (!session?.tokenSet?.refreshToken) {
    return Response.json(
      { ok: false, error: "No active session" },
      { status: 401 },
    );
  }

  const { connection = "google-oauth2" } = (await req
    .json()
    .catch(() => ({}))) as { connection?: string };

  const domain = process.env.AUTH0_DOMAIN!;
  const clientId = process.env.AUTH0_CLIENT_ID!;
  const clientSecret = process.env.AUTH0_CLIENT_SECRET!;

  // Exchange the user's refresh token for a My Account API access token
  const tokenRes = await fetch(`https://${domain}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: session.tokenSet.refreshToken,
      audience: `https://${domain}/me/`,
      scope: "delete:me:connected_accounts read:me:connected_accounts",
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return Response.json(
      { ok: false, error: `Could not get My Account API token: ${err}` },
      { status: 502 },
    );
  }

  const { access_token } = (await tokenRes.json()) as { access_token: string };

  // Delete the connected account
  const deleteRes = await fetch(
    `https://${domain}/me/v1/connected-accounts/${connection}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${access_token}` },
    },
  );

  if (deleteRes.status === 204 || deleteRes.status === 200) {
    return Response.json({ ok: true });
  }
  if (deleteRes.status === 404) {
    return Response.json({ ok: true, note: "Already disconnected" });
  }

  const body = await deleteRes.text();
  return Response.json(
    { ok: false, error: `Delete failed (${deleteRes.status}): ${body}` },
    { status: 502 },
  );
}
