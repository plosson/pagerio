import { beforeAll, describe, expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { AuthError, createGoogleVerifier } from "../../src/auth/google";
import { createGoogleOAuthClient } from "../../src/auth/googleOAuth";

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let verifier: ReturnType<typeof createGoogleVerifier>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  verifier = createGoogleVerifier(["web-client", "ios-client"], createLocalJWKSet({ keys: [jwk] }));
});

async function idToken(claims: JWTPayload = {}, opts: { key?: CryptoKey; exp?: string | number } = {}): Promise<string> {
  return new SignJWT({ email: "a@example.com", email_verified: true, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer((claims.iss as string) ?? "https://accounts.google.com")
    .setAudience((claims.aud as string) ?? "ios-client")
    .setSubject((claims.sub as string) ?? "google-123")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "10m")
    .sign(opts.key ?? signingKey);
}

describe("createGoogleVerifier", () => {
  test("accepts a valid token for any configured audience and either issuer form", async () => {
    expect(await verifier.verify(await idToken())).toEqual({ sub: "google-123", email: "a@example.com" });
    expect((await verifier.verify(await idToken({ aud: "web-client", iss: "accounts.google.com" }))).sub).toBe("google-123");
  });

  const rejects: Array<[string, () => Promise<string>]> = [
    ["a foreign audience", () => idToken({ aud: "someone-elses-client" })],
    ["a foreign issuer", () => idToken({ iss: "https://evil.example" })],
    ["an expired token", () => idToken({}, { exp: Math.floor(Date.now() / 1000) - 120 })],
    ["a token signed by another key", () => idToken({}, { key: otherKey })],
    ["an unverified email", () => idToken({ email_verified: false })],
    ["a missing email", () => idToken({ email: undefined })],
    ["an empty subject", () => idToken({ sub: "" })],
    ["an alg=none token", async () => `${btoa('{"alg":"none"}')}.${btoa('{"sub":"x","aud":"ios-client"}')}.`],
    ["garbage", async () => "not.a.jwt"],
    ["an empty string", async () => ""],
  ];
  for (const [name, make] of rejects) {
    test(`rejects ${name}`, async () => {
      await expect(verifier.verify(await make())).rejects.toBeInstanceOf(AuthError);
    });
  }
});

describe("createGoogleOAuthClient", () => {
  const base = { clientId: "web-client", clientSecret: "shh", redirectUri: "https://pager.test/auth/google/callback" };

  test("builds an authorization URL carrying the state", () => {
    const url = new URL(createGoogleOAuthClient(base).authorizationUrl("st&ate=1"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("state")).toBe("st&ate=1");
    expect(url.searchParams.get("client_id")).toBe("web-client");
    expect(url.searchParams.get("redirect_uri")).toBe(base.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email");
  });

  test("exchanges a code and returns the id_token", async () => {
    let sent: URLSearchParams | null = null;
    const client = createGoogleOAuthClient({
      ...base,
      fetchFn: (async (_url: string, init: RequestInit) => {
        sent = new URLSearchParams(init.body as string);
        return new Response(JSON.stringify({ id_token: "the-id-token" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await client.exchangeCode("code-1")).toBe("the-id-token");
    expect(sent!.get("code")).toBe("code-1");
    expect(sent!.get("grant_type")).toBe("authorization_code");
    expect(sent!.get("client_secret")).toBe("shh");
  });

  for (const [name, response] of [
    ["an error status", new Response('{"error":"invalid_grant"}', { status: 400 })],
    ["a missing id_token", new Response("{}", { status: 200 })],
    ["a non-JSON body", new Response("<html>", { status: 200 })],
    ["a null JSON body", new Response("null", { status: 200 })],
    ["a JSON array body", new Response("[]", { status: 200 })],
  ] as const) {
    test(`throws AuthError on ${name}`, async () => {
      const client = createGoogleOAuthClient({ ...base, fetchFn: (async () => response) as unknown as typeof fetch });
      await expect(client.exchangeCode("c")).rejects.toBeInstanceOf(AuthError);
    });
  }

  test("throws AuthError when the network fails", async () => {
    const client = createGoogleOAuthClient({
      ...base,
      fetchFn: (async () => {
        throw new TypeError("network down");
      }) as unknown as typeof fetch,
    });
    await expect(client.exchangeCode("c")).rejects.toBeInstanceOf(AuthError);
  });
});
