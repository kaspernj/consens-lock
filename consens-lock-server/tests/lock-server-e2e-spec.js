// @ts-check

import ConsensLockClient from "../../consens-lock-npm-client/src/index.js";
import { RawLockSocket, pollUntil, startTestServer } from "./helpers/test-helpers.js";
import { describe, expect, it } from "velocious/build/src/testing/test.js";

/**
 * @param {() => Promise<void>} action - Action expected to throw.
 * @returns {Promise<string>} - The thrown error message.
 */
async function captureError(action) {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("Expected the action to throw, but it resolved");
}

describe("consens-lock client", {databaseCleaning: {transaction: false, truncate: false}}, () => {
  it("obtains and releases locks across connections with leases and fencing epochs", async () => {
    const { application, wsUrl } = await startTestServer({ authToken: "test-secret" });

    const clientA = new ConsensLockClient({ authToken: "test-secret", url: wsUrl });
    const clientB = new ConsensLockClient({ authToken: "test-secret", url: wsUrl });

    try {
      const first = await clientA.obtainLock("alpha");
      expect(first.status).toEqual("acquired");
      expect(typeof first.epoch).toEqual("number");
      expect(first.epoch).toBeGreaterThan(0);

      const second = await clientB.obtainLock("alpha");
      expect(second.status).toEqual("busy");
      expect(second.ownerId).toEqual(first.holderId);

      await clientA.close();
      await pollUntil({ condition: async () => await clientB.whoHolds("alpha") === null });

      const third = await clientB.obtainLock("alpha");
      expect(third.status).toEqual("acquired");
      expect(third.epoch).toBeGreaterThan(first.epoch);

      const released = await clientB.releaseLock("alpha");
      expect(released.status).toEqual("released");
    } finally {
      await clientA.close();
      await clientB.close();
      await application.stop();
    }
  });

  it("reclaims a killed holder's lock within the lease window without a clean disconnect", async () => {
    const { application, wsUrl } = await startTestServer({ authToken: "test-secret", leaseMs: 1_000, sweepIntervalMs: 100 });

    const killer = new RawLockSocket({ wsUrl });
    const observer = new ConsensLockClient({ authToken: "test-secret", url: wsUrl });

    try {
      await killer.connect();

      const grant = await killer.request({ name: "killed-lock", type: "try-acquire" });
      expect(grant.status).toEqual("acquired");

      // SIGKILL simulation: terminate the TCP connection without a close
      // frame or connection-close message.
      killer.terminate();

      const reclaimed = await pollUntil({
        condition: async () => await observer.whoHolds("killed-lock") === null,
        timeoutMs: 6_000
      });

      expect(reclaimed).toEqual(true);

      const acquired = await observer.obtainLock("killed-lock");
      expect(acquired.status).toEqual("acquired");
    } finally {
      await observer.close();
      await application.stop();
    }
  });

  it("serves two waiters FIFO through the server-side queue", async () => {
    const { application, wsUrl } = await startTestServer({ authToken: "test-secret" });

    const holder = new ConsensLockClient({ authToken: "test-secret", url: wsUrl });
    const waiterOne = new ConsensLockClient({ authToken: "test-secret", url: wsUrl });
    const waiterTwo = new ConsensLockClient({ authToken: "test-secret", url: wsUrl });

    try {
      const grant = await holder.obtainLock("fifo-lock");
      expect(grant.status).toEqual("acquired");

      const firstWait = waiterOne.waitForLock("fifo-lock", { timeoutMs: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const secondWait = waiterTwo.waitForLock("fifo-lock", { timeoutMs: 10_000 });

      await new Promise((resolve) => setTimeout(resolve, 200));

      const holders = await waiterTwo.listLocks();
      const fifoEntry = holders.find((entry) => entry.name === "fifo-lock");
      expect(fifoEntry?.waiterCount).toEqual(2);

      await holder.releaseLock("fifo-lock");

      const firstResult = await firstWait;
      expect(firstResult.status).toEqual("acquired");

      // The first waiter now holds the name; releasing it hands the name to
      // the second waiter, proving the FIFO order.
      await waiterOne.releaseLock("fifo-lock");

      const secondResult = await secondWait;

      expect(secondResult.status).toEqual("acquired");
      expect(firstResult.epoch).toBeLessThan(secondResult.epoch);
    } finally {
      for (const client of [holder, waiterOne, waiterTwo]) {
        try {
          await client.releaseLock("fifo-lock");
        } catch {
          // Already released or fenced.
        }

        await client.close();
      }

      await application.stop();
    }
  });

  it("rejects a superseded holder through its fencing token", async () => {
    const { application, wsUrl } = await startTestServer({ authToken: "test-secret", leaseMs: 1_000, sweepIntervalMs: 100 });

    const staleHolder = new RawLockSocket({ wsUrl });
    const observer = new ConsensLockClient({ authToken: "test-secret", url: wsUrl });

    try {
      await staleHolder.connect();

      const grant = await staleHolder.request({ name: "fenced-lock", type: "try-acquire" });
      expect(grant.status).toEqual("acquired");
      // Epochs survive daemon restarts via the durable mirror, so the exact
      // value depends on earlier runs; only monotonicity is asserted.
      expect(typeof grant.epoch).toEqual("number");

      // The stale holder goes silent (no renewals); the sweeper expires the
      // lease and a new holder takes over with a higher epoch.
      const reclaimed = await pollUntil({
        condition: async () => {
          const acquired = await observer.obtainLock("fenced-lock");
          return acquired.status === "acquired" ? acquired : null;
        },
        timeoutMs: 6_000
      });

      expect(reclaimed.epoch).toBeGreaterThan(grant.epoch);

      // The server pushes `lost` to the fenced holder.
      const lostPush = await staleHolder.nextLostPush();
      expect(lostPush.name).toEqual("fenced-lock");
      expect(lostPush.epoch).toEqual(grant.epoch);

      // The stale holder's renew and release are both rejected by the epoch.
      const staleRenew = await staleHolder.request({ epoch: grant.epoch, name: "fenced-lock", type: "renew" });
      expect(staleRenew.status).toEqual("lost");
      expect(staleRenew.currentEpoch).toEqual(reclaimed.epoch);

      const staleRelease = await staleHolder.request({ epoch: grant.epoch, name: "fenced-lock", type: "release" });
      expect(staleRelease.status).toEqual("not-holder");

      // The new holder is untouched.
      expect((await observer.whoHolds("fenced-lock"))?.epoch).toEqual(reclaimed.epoch);
    } finally {
      await staleHolder.close();
      await observer.close();
      await application.stop();
    }
  });

  it("returns busy for concurrent obtains instead of throwing", async () => {
    const { application, wsUrl } = await startTestServer({ authToken: "test-secret" });

    const clients = Array.from({ length: 6 }, () => new ConsensLockClient({ authToken: "test-secret", url: wsUrl }));

    try {
      const results = await Promise.all(clients.map((client) => client.obtainLock("race-lock")));

      const acquired = results.filter((result) => result.status === "acquired");
      const busy = results.filter((result) => result.status === "busy");

      expect(acquired.length).toEqual(1);
      expect(busy.length).toEqual(5);
    } finally {
      for (const client of clients) {
        await client.close();
      }

      await application.stop();
    }
  });

  it("refuses a release from a client that does not own the lock", async () => {
    const { application, wsUrl } = await startTestServer({ authToken: "test-secret" });

    const owner = new ConsensLockClient({ authToken: "test-secret", url: wsUrl });
    const thief = new ConsensLockClient({ authToken: "test-secret", url: wsUrl });

    try {
      const grant = await owner.obtainLock("owned-lock");
      expect(grant.status).toEqual("acquired");

      const thiefRelease = await thief.releaseLock("owned-lock");
      expect(thiefRelease.status).toEqual("not-holder");

      // The owner still holds it.
      expect((await owner.whoHolds("owned-lock"))?.holderId).toEqual(grant.holderId);

      const ownerRelease = await owner.releaseLock("owned-lock");
      expect(ownerRelease.status).toEqual("released");
    } finally {
      await owner.close();
      await thief.close();
      await application.stop();
    }
  });

  it("binds ownership to the socket and ignores client-supplied owner ids", async () => {
    const { application, wsUrl } = await startTestServer({ authToken: "test-secret" });

    const owner = new ConsensLockClient({ authToken: "test-secret", url: wsUrl });
    const impersonator = new RawLockSocket({ wsUrl });

    try {
      const grant = await owner.obtainLock("socket-bound-lock");
      expect(grant.status).toEqual("acquired");

      await impersonator.connect();

      // Even knowing the real holderId from the busy response, an
      // impersonating socket gets its own server-minted identity and cannot
      // release the owner's lock.
      const busy = await impersonator.request({ name: "socket-bound-lock", type: "try-acquire" });
      expect(busy.status).toEqual("busy");
      expect(busy.ownerId).toEqual(grant.holderId);

      const foreignRelease = await impersonator.request({ name: "socket-bound-lock", type: "release" });
      expect(foreignRelease.status).toEqual("not-holder");

      expect((await owner.whoHolds("socket-bound-lock"))?.holderId).toEqual(grant.holderId);
    } finally {
      await impersonator.close();
      await owner.close();
      await application.stop();
    }
  });

  it("fails closed when no shared secret is configured", async () => {
    const { application, httpUrl, wsUrl } = await startTestServer({ authToken: null });

    try {
      const httpProbe = await fetch(`${httpUrl}/locks/obtain`, {
        body: JSON.stringify({ name: "closed-lock" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });

      expect(httpProbe.status).toEqual(401);

      const unconfigured = new RawLockSocket({ authToken: null, wsUrl });
      const message = await captureError(async () => await unconfigured.connect());
      expect(message).toMatch(/fail closed/);

      await unconfigured.close();
    } finally {
      await application.stop();
    }
  });

  it("rejects a wrong auth token and a wrong protocol version", async () => {
    const { application, wsUrl } = await startTestServer({ authToken: "test-secret" });

    try {
      const wrongToken = new RawLockSocket({ authToken: "wrong", wsUrl });
      const tokenMessage = await captureError(async () => await wrongToken.connect());
      expect(tokenMessage).toMatch(/Invalid lock-server auth token/);
      await wrongToken.close();

      const wrongProtocol = new RawLockSocket({ protocolVersion: 1, wsUrl });
      const protocolMessage = await captureError(async () => await wrongProtocol.connect());
      expect(protocolMessage).toMatch(/Unsupported lock protocol version/);
      await wrongProtocol.close();
    } finally {
      await application.stop();
    }
  });

  it("renews leases in the background so a long hold survives the lease window", async () => {
    const { application, wsUrl } = await startTestServer({ authToken: "test-secret", leaseMs: 1_000, sweepIntervalMs: 100 });

    const holder = new ConsensLockClient({ authToken: "test-secret", url: wsUrl });

    try {
      const grant = await holder.obtainLock("renewed-lock");
      expect(grant.status).toEqual("acquired");

      // Hold far past the lease duration; background renewal must keep it.
      await new Promise((resolve) => setTimeout(resolve, 2_500));

      const holderNow = await holder.whoHolds("renewed-lock");
      expect(holderNow?.holderId).toEqual(grant.holderId);
      expect(holderNow?.epoch).toEqual(grant.epoch);
    } finally {
      await holder.close();
      await application.stop();
    }
  });
});
