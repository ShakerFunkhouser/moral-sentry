import { NextRequest, NextResponse } from "next/server";

const DOMAIN = process.env.AUTH0_DOMAIN;
const CLIENT_ID = process.env.AUTH0_CLIENT_ID;
const CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET;
const TEST_EMAIL = process.env.AUTH0_TEST_USERNAME;

let cachedMgmtToken: { value: string; expiresAt: number } | null = null;

async function getMgmtToken(): Promise<string> {
  const now = Date.now();
  if (cachedMgmtToken && cachedMgmtToken.expiresAt - now > 60_000) {
    return cachedMgmtToken.value;
  }
  const res = await fetch(`https://${DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      audience: `https://${DOMAIN}/api/v2/`,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    const msg =
      (JSON.parse(text) as { error_description?: string }).error_description ??
      text;
    throw new Error(
      res.status === 401
        ? `Auth0 rejected client credentials (401): ${msg}`
        : res.status === 403
          ? `App missing client_credentials grant or Management API authorization (403): ${msg}. ` +
            `Fix: Auth0 Dashboard → Applications → [app] → Advanced Settings → Grant Types → enable Client Credentials, ` +
            `then APIs → Auth0 Management API → Machine to Machine Applications → authorize the app with read:users + update:users scopes.`
          : `M2M token failed (${res.status}): ${msg}`,
    );
  }
  const { access_token, expires_in } = JSON.parse(text) as {
    access_token: string;
    expires_in: number;
  };
  cachedMgmtToken = { value: access_token, expiresAt: now + expires_in * 1000 };
  return access_token;
}

async function getUserId(token: string): Promise<string> {
  const url = `https://${DOMAIN}/api/v2/users-by-email?email=${encodeURIComponent(TEST_EMAIL!)}&fields=user_id&include_fields=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`User lookup failed (${res.status}): ${text}`);
  const users = JSON.parse(text) as Array<{ user_id: string }>;
  if (!users.length) throw new Error(`No Auth0 user found for ${TEST_EMAIL}`);
  return users[0].user_id;
}

export async function POST(req: NextRequest) {
  try {
    if (!DOMAIN || !CLIENT_ID || !CLIENT_SECRET || !TEST_EMAIL) {
      return NextResponse.json(
        {
          error:
            "Missing Auth0 env vars (AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_TEST_USERNAME)",
        },
        { status: 500 },
      );
    }

    const body = (await req.json()) as {
      moral_priorities?: Record<string, number>;
    };
    if (!body.moral_priorities || typeof body.moral_priorities !== "object") {
      return NextResponse.json(
        { error: "Missing moral_priorities in request body" },
        { status: 400 },
      );
    }

    const token = await getMgmtToken();
    const userId = await getUserId(token);

    const patchRes = await fetch(
      `https://${DOMAIN}/api/v2/users/${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          user_metadata: { moral_priorities: body.moral_priorities },
        }),
      },
    );
    const patchText = await patchRes.text();
    if (!patchRes.ok)
      throw new Error(
        `Metadata patch failed (${patchRes.status}): ${patchText}`,
      );

    return NextResponse.json({ ok: true, userId }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
