// @ts-check

import configuration from "../config/configuration.js";
import LockEpoch from "../models/lock-epoch.js";

/**
 * Durable mirror of the fencing epochs (STC-210 §8: "persisted in the
 * server's own durable store so a server restart cannot rewind it").
 *
 * Written on grant only - never while waiting or holding - so the daemon's
 * own store never pins a connection during the hot lock path.
 */
export default class EpochStore {
  /**
   * Loads persisted epochs into the authority before it starts granting.
   * @param {import("./lock-authority.js").default} authority - Authority to seed.
   * @returns {Promise<void>} - Resolves when all epochs are loaded.
   */
  async loadInto(authority) {
    await configuration.ensureConnections(async () => {
      const epochs = await LockEpoch.all().toArray();

      for (const epochRecord of epochs) {
        authority.seedEpoch(epochRecord.name(), Number(epochRecord.epoch()));
      }
    });
  }

  /**
   * Persists one epoch bump for a lock name.
   * @param {string} name - Lock name.
   * @param {number} epoch - New monotonic epoch.
   * @returns {Promise<void>} - Resolves when the mirror row is written.
   */
  async persist(name, epoch) {
    await configuration.ensureConnections(async () => {
      const existingRecord = await LockEpoch.findBy({ name });

      if (existingRecord) {
        existingRecord.setAttribute("epoch", epoch);
        await existingRecord.save();
        return;
      }

      await LockEpoch.create({ epoch, name });
    });
  }
}
