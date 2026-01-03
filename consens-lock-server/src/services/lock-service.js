import Lock from "../models/lock.js";

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeName(value) {
  return value.trim();
}

/**
 * @param {{name: string, ownerId: string}} args
 * @returns {Promise<{status: string, ownerId?: string}>}
 */
export async function obtainLock({ name, ownerId }) {
  const normalizedName = normalizeName(name);

  const existingLock = await Lock.findBy({ name: normalizedName });

  if (!existingLock) {
    await Lock.create({
      acquiredAt: new Date(),
      name: normalizedName,
      ownerId,
    });

    return { status: "acquired" };
  }

  if (existingLock.ownerId() === ownerId) {
    return { status: "already-held" };
  }

  return { status: "busy", ownerId: existingLock.ownerId() };
}

/**
 * @param {{name: string, ownerId: string}} args
 * @returns {Promise<{status: string}>}
 */
export async function releaseLock({ name, ownerId }) {
  const normalizedName = normalizeName(name);

  const existingLock = await Lock.findBy({ name: normalizedName });

  if (!existingLock) {
    return { status: "not-found" };
  }

  if (existingLock.ownerId() !== ownerId) {
    return { status: "not-owner" };
  }

  await existingLock.destroy();

  return { status: "released" };
}

/**
 * @param {string} ownerId
 * @returns {Promise<void>}
 */
export async function releaseAllLocksForOwner(ownerId) {
  await Lock.where({ ownerId }).destroyAll();
}
