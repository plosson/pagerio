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
  /** Token endpoint timeout; defaults to 10 seconds. */
  timeoutMs?: number;
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
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
        if (!res.ok) throw new AuthError("code_exchange_failed");
        const parsed = await res.json();
        if (typeof parsed !== "object" || parsed === null) throw new AuthError("missing_id_token");
        body = parsed as { id_token?: unknown };
        if (typeof body.id_token !== "string" || body.id_token === "") throw new AuthError("missing_id_token");
      } catch (err) {
        if (err instanceof AuthError) throw err;
        throw new AuthError("code_exchange_failed");
      }
      return body.id_token;
    },
  };
}
