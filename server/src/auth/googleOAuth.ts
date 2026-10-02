import { AuthError } from "./google";

export interface GoogleOAuthClient {
  authorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<string>;
}

export function createGoogleOAuthClient(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchFn?: typeof fetch;
}): GoogleOAuthClient {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    authorizationUrl(state) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: opts.clientId,
        redirect_uri: opts.redirectUri,
        response_type: "code",
        scope: "openid email",
        state,
        prompt: "select_account",
      }).toString();
      return url.toString();
    },
    async exchangeCode(code) {
      let body: { id_token?: unknown };
      try {
        const res = await fetchFn("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: opts.clientId,
            client_secret: opts.clientSecret,
            redirect_uri: opts.redirectUri,
            grant_type: "authorization_code",
          }).toString(),
        });
        if (!res.ok) throw new AuthError("code_exchange_failed");
        body = (await res.json()) as { id_token?: unknown };
      } catch {
        throw new AuthError("code_exchange_failed");
      }
      if (typeof body.id_token !== "string" || body.id_token === "") throw new AuthError("missing_id_token");
      return body.id_token;
    },
  };
}
