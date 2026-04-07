import { auth0 } from "@/lib/auth0";
import type { NextRequest } from "next/server";

// Mount Auth0 SDK routes: /auth/login, /auth/callback, /auth/logout
export async function middleware(request: NextRequest) {
  return auth0.middleware(request);
}

export const config = {
  // Exclude connect-account - handled by our custom route in app/api/auth/connect-account/route.ts
  // which does a pre-flight check and auto re-login if MRRT is needed.
  matcher: ["/api/auth/login", "/api/auth/callback", "/api/auth/logout"],
};
