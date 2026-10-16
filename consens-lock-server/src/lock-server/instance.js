// @ts-check

/** @type {import("./lock-authority.js").default | null} */
let authority = null;

/**
 * Stores the process-wide lock authority created at server boot.
 * @param {import("./lock-authority.js").default} instance - Authority instance.
 * @returns {void} - No return value.
 */
export function setAuthority(instance) {
  authority = instance;
}

/**
 * Runs get authority. Throws when the daemon has not booted yet.
 * @returns {import("./lock-authority.js").default} - The live authority.
 */
export function getAuthority() {
  if (!authority) {
    throw new Error("Lock authority is not initialized - start the server first");
  }

  return authority;
}
