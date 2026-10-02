import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Identity } from "../services/accounts";

export class AuthError extends Error {}

export interface GoogleVerifier {
  verify(idToken: string): Promise<Identity>;
}

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");

export function createGoogleVerifier(
  audiences: string[],
  keys: JWTVerifyGetKey = createRemoteJWKSet(GOOGLE_JWKS_URL),
): GoogleVerifier {
  // Fail closed: jose treats an empty audience list as "no audience check".
  if (audiences.length === 0 || audiences.some((aud) => aud.trim() === "")) {
    throw new Error("createGoogleVerifier requires at least one non-empty audience");
  }
  return {
    async verify(idToken) {
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(idToken, keys, {
          issuer: GOOGLE_ISSUERS,
          audience: audiences,
          algorithms: ["RS256"],
          clockTolerance: 30,
        }));
      } catch {
        throw new AuthError("invalid_id_token");
      }
      if (typeof payload.sub !== "string" || payload.sub === "") throw new AuthError("missing_subject");
      if (typeof payload.email !== "string" || payload.email_verified !== true) throw new AuthError("unverified_email");
      return { sub: payload.sub, email: payload.email };
    },
  };
}
