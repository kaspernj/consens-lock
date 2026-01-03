import net from "node:net";
import ConsensLockClient from "../src/index.js";
import { describe, expect, it } from "velocious/build/src/testing/test.js";

/**
 * @returns {Promise<number>}
 */
function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });

    server.on("error", (error) => {
      reject(error);
    });
  });
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("consens-lock client", () => {
  it("obtains and releases locks across connections", async () => {
    process.env.NODE_ENV = "test";

    const { startServer } = await import("../../consens-lock-server/src/server.js");
    const port = await getAvailablePort();
    const server = await startServer({ port });
    const url = `ws://127.0.0.1:${port}/websocket`;

    const clientA = new ConsensLockClient({ url });
    const clientB = new ConsensLockClient({ url });

    try {
      const first = await clientA.obtainLock("alpha");
      expect(first.status).toEqual("acquired");

      const second = await clientB.obtainLock("alpha");
      expect(second.status).toEqual("busy");

      await clientA.close();
      await wait(50);

      const third = await clientB.obtainLock("alpha");
      expect(third.status).toEqual("acquired");

      const released = await clientB.releaseLock("alpha");
      expect(released.status).toEqual("released");
    } finally {
      await clientA.close();
      await clientB.close();
      await server.stop();
    }
  });
});
