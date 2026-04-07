import { Auth0Client } from "@auth0/nextjs-auth0/server";

export const auth0 = new Auth0Client({
  authorizationParameters: {
    // offline_access is required to receive a refresh token for Token Vault
    scope: "openid profile email offline_access",
  },
  routes: {
    // Match the callback URL registered in the Auth0 application settings
    login: "/api/auth/login",
    callback: "/api/auth/callback",
    logout: "/api/auth/logout",
  },
});
