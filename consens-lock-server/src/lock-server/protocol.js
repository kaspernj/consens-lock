// @ts-check

/** Wire protocol version for the lock-server tier (STC-210 design §6). */
export const PROTOCOL_VERSION = 2;

/** Default lease duration for a granted lock. */
export const DEFAULT_LEASE_MS = 30_000;

/** Default client renewal interval (one third of the lease). */
export const DEFAULT_RENEW_INTERVAL_MS = 10_000;

/** Default interval between server-side lease/deadline sweeps. */
export const DEFAULT_SWEEP_INTERVAL_MS = 200;

/** Default bounded acquire timeout for `waitForLock`. */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;

/**
 * Reads a positive-integer setting from the environment.
 * @param {string} name - Environment variable name.
 * @param {number} fallback - Value used when unset or invalid.
 * @returns {number} - Resolved value.
 */
function readIntSetting(name, fallback) {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue === "") return fallback;

  const parsedValue = Number(rawValue);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${rawValue}`);
  }

  return parsedValue;
}

/**
 * Resolves the daemon's lease/renewal/sweep settings.
 * @returns {{leaseMs: number, renewIntervalMs: number, sweepIntervalMs: number}} - Resolved settings.
 */
export function readServerSettings() {
  const leaseMs = readIntSetting("CONSENS_LOCK_LEASE_MS", DEFAULT_LEASE_MS);
  const renewIntervalMs = readIntSetting("CONSENS_LOCK_RENEW_INTERVAL_MS", DEFAULT_RENEW_INTERVAL_MS);
  const sweepIntervalMs = readIntSetting("CONSENS_LOCK_SWEEP_INTERVAL_MS", DEFAULT_SWEEP_INTERVAL_MS);

  if (renewIntervalMs >= leaseMs) {
    throw new Error(`CONSENS_LOCK_RENEW_INTERVAL_MS (${renewIntervalMs}) must be smaller than CONSENS_LOCK_LEASE_MS (${leaseMs})`);
  }

  return { leaseMs, renewIntervalMs, sweepIntervalMs };
}

/**
 * Runs is protocol version supported.
 * @param {unknown} candidateVersion - Version presented by a client.
 * @returns {boolean} - Whether the daemon speaks this protocol version.
 */
export function isSupportedProtocolVersion(candidateVersion) {
  return candidateVersion === PROTOCOL_VERSION;
}
