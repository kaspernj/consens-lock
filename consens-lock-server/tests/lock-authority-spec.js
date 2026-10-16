// @ts-check

import LockAuthority from "../src/lock-server/lock-authority.js";
import { describe, expect, it } from "velocious/build/src/testing/test.js";

/**
 * @param {object} [args] - Options.
 * @param {number} [args.leaseMs] - Lease duration.
 * @returns {LockAuthority} - A sweeper-less authority for unit specs.
 */
function buildAuthority({ leaseMs = 1000 } = {}) {
  return new LockAuthority({ leaseMs, sweepIntervalMs: 50 });
}

describe("lock authority", {databaseCleaning: {transaction: false, truncate: false}}, () => {
  it("grants a free name and bumps the fencing epoch on every acquisition", () => {
    const authority = buildAuthority();

    const first = authority.tryAcquire({ holderId: "holder-1", name: "alpha" });
    expect(first.status).toEqual("acquired");
    expect(first.epoch).toEqual(1);

    const released = authority.release({ epoch: 1, holderId: "holder-1", name: "alpha" });
    expect(released.status).toEqual("released");

    const second = authority.tryAcquire({ holderId: "holder-2", name: "alpha" });
    expect(second.status).toEqual("acquired");
    expect(second.epoch).toEqual(2);
  });

  it("returns busy for a concurrent obtain instead of throwing", () => {
    const authority = buildAuthority();

    authority.tryAcquire({ holderId: "holder-1", name: "alpha" });
    const busy = authority.tryAcquire({ holderId: "holder-2", name: "alpha" });

    expect(busy.status).toEqual("busy");
    expect(busy.ownerId).toEqual("holder-1");
  });

  it("treats a re-obtain by the same holder as already-held", () => {
    const authority = buildAuthority();

    authority.tryAcquire({ holderId: "holder-1", name: "alpha" });
    const again = authority.tryAcquire({ holderId: "holder-1", name: "alpha" });

    expect(again.status).toEqual("already-held");
    expect(again.epoch).toEqual(1);
  });

  it("rejects a renew with a stale fencing epoch", () => {
    const authority = buildAuthority();

    authority.tryAcquire({ holderId: "holder-1", name: "alpha" });
    authority.release({ epoch: 1, holderId: "holder-1", name: "alpha" });
    authority.tryAcquire({ holderId: "holder-2", name: "alpha" });

    const staleRenew = authority.renew({ epoch: 1, holderId: "holder-1", name: "alpha" });

    expect(staleRenew.status).toEqual("lost");
    expect(staleRenew.currentEpoch).toEqual(2);
  });

  it("refuses a release from a holder that does not own the lock", () => {
    const authority = buildAuthority();

    authority.tryAcquire({ holderId: "holder-1", name: "alpha" });
    const foreignRelease = authority.release({ epoch: 1, holderId: "holder-2", name: "alpha" });

    expect(foreignRelease.status).toEqual("not-holder");
    expect(authority.whoHolds("alpha")?.holderId).toEqual("holder-1");
  });

  it("serves waiters in FIFO order", async () => {
    const authority = buildAuthority();

    authority.tryAcquire({ holderId: "holder-1", name: "alpha" });

    const firstWaiter = authority.acquire({ deadlineAt: Date.now() + 5_000, holderId: "waiter-1", name: "alpha" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const secondWaiter = authority.acquire({ deadlineAt: Date.now() + 5_000, holderId: "waiter-2", name: "alpha" });

    authority.release({ epoch: 1, holderId: "holder-1", name: "alpha" });

    const firstResult = await firstWaiter;

    // The first waiter now holds the name; releasing it hands the name to
    // the second waiter, proving the queue order.
    authority.release({ epoch: firstResult.epoch, holderId: "waiter-1", name: "alpha" });

    const secondResult = await secondWaiter;

    expect(firstResult.status).toEqual("acquired");
    expect(firstResult.holderId).toEqual("waiter-1");
    expect(secondResult.status).toEqual("acquired");
    expect(secondResult.holderId).toEqual("waiter-2");
    expect(firstResult.epoch).toBeLessThan(secondResult.epoch);
  });

  it("times out a waiter at its bounded deadline", async () => {
    const authority = buildAuthority();

    authority.tryAcquire({ holderId: "holder-1", name: "alpha" });

    const waiter = await authority.acquire({ deadlineAt: Date.now() + 100, holderId: "waiter-1", name: "alpha" });

    expect(waiter.status).toEqual("timeout");
    expect(authority.whoHolds("alpha")?.holderId).toEqual("holder-1");
  });

  it("expires an unrenewed lease in the sweeper and notifies the holder it was fenced", async () => {
    const authority = buildAuthority({ leaseMs: 200 });
    const lostPushes = [];

    authority.registerHolder("holder-1", (name, epoch) => lostPushes.push({ epoch, name }));
    authority.start();

    const grant = authority.tryAcquire({ holderId: "holder-1", name: "alpha" });
    expect(grant.status).toEqual("acquired");

    const reclaimed = await new Promise((resolve) => {
      const intervalId = setInterval(() => {
        const holder = authority.whoHolds("alpha");

        if (!holder) {
          clearInterval(intervalId);
          resolve(true);
        }
      }, 50);

      intervalId.unref?.();
    });

    authority.stop();

    expect(reclaimed).toEqual(true);
    expect(lostPushes).toEqual([{ epoch: 1, name: "alpha" }]);
  });

  it("releases every lease of a holder on transport close and wakes the waiter", async () => {
    const authority = buildAuthority();

    authority.tryAcquire({ holderId: "holder-1", name: "alpha" });
    const waiter = authority.acquire({ deadlineAt: Date.now() + 5_000, holderId: "waiter-1", name: "alpha" });

    const releasedNames = authority.releaseAllForHolder("holder-1");

    expect(releasedNames).toEqual(["alpha"]);

    const result = await waiter;
    expect(result.status).toEqual("acquired");
  });

  it("drops a queued waiter when its holder disconnects", async () => {
    const authority = buildAuthority();

    authority.tryAcquire({ holderId: "holder-1", name: "alpha" });
    const waiter = authority.acquire({ deadlineAt: Date.now() + 5_000, holderId: "waiter-1", name: "alpha" });

    authority.releaseAllForHolder("waiter-1");

    const result = await waiter;
    expect(result.status).toEqual("timeout");
  });

  it("seeds persisted epochs so a restart cannot rewind the fencing sequence", () => {
    const authority = buildAuthority();

    authority.seedEpoch("alpha", 7);

    const grant = authority.tryAcquire({ holderId: "holder-1", name: "alpha" });
    expect(grant.epoch).toEqual(8);

    // A lower persisted value must never lower the live epoch.
    authority.seedEpoch("alpha", 3);
    expect(authority.currentEpoch("alpha")).toEqual(8);
  });
});
