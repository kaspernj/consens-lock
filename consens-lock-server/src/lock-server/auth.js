// @ts-check

import { timingSafeEqual } from "node:crypto";
import VelociousError from "velocious/build/src/velocious-error.js";

/**
 * Reads the configured shared auth token.
 * Read lazily so deployments and tests can configure it through the
 * environment without module-import ordering issues.
 * @returns {string | null} - The configured token, or null when unconfigured.
 */
export function getAuthToken() {
  const token = process.env.CONSENS_LOCK_AUTH_TOKEN;

  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * Constant-time compare of a candidate token against the configured secret.
 * @param {string | null | undefined} candidateToken - Token presented by a client.
 * @param {string} expectedToken - Configured shared secret.
 * @returns {boolean} - Whether the tokens match.
 */
function tokensMatch(candidateToken, expectedToken) {
  if (typeof candidateToken !== "string") return false;

  const candidateBuffer = Buffer.from(candidateToken);
  const expectedBuffer = Buffer.from(expectedToken);

  if (candidateBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

/**
 * Extracts a bearer token from an HTTP request surface.
 * @param {{header: (name: string) => string | null}} request - Request surface.
 * @returns {string | null} - Bearer token, or null when absent.
 */
export function bearerTokenFromRequest(request) {
  const headerValue = request?.header?.("authorization");

  if (typeof headerValue !== "string") return null;

  const match = headerValue.match(/^Bearer\s+(.+)$/i);

  return match ? match[1] : null;
}

/**
 * Verifies a client-supplied auth token against the shared secret.
 * Fails closed: with no configured token, every verification throws.
 * Throws a safe (client-exposable) VelociousError so the transport layer
 * reports the refusal without leaking the secret.
 * @param {string | null | undefined} candidateToken - Token presented by a client.
 * @returns {void} - Returns when authorized; throws otherwise.
 */
export function verifyAuthToken(candidateToken) {
  const expectedToken = getAuthToken();

  if (!expectedToken) {
    throw VelociousError.safe("Lock server auth token is not configured - refusing access (fail closed)");
  }

  if (!tokensMatch(candidateToken, expectedToken)) {
    throw VelociousError.safe("Invalid lock-server auth token");
  }
}
