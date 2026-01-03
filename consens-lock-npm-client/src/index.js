import WebsocketClient from "velocious/build/src/http-client/websocket-client.js";
import WebSocket from "ws";

if (!globalThis.WebSocket) {
  globalThis.WebSocket = WebSocket;
}

export default class ConsensLockClient {
  /**
   * @param {object} [args]
   * @param {string} [args.url]
   */
  constructor({ url } = {}) {
    this.client = new WebsocketClient({ url });
    this.connectionId = null;
    this.connectionPromise = null;
  }

  /**
   * @returns {Promise<string>}
   */
  async connect() {
    if (this.connectionId) return this.connectionId;
    if (this.connectionPromise) return this.connectionPromise;

    this.connectionPromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error("Timed out waiting for lock channel handshake"));
      }, 5000);

      const unsubscribe = this.client.on("locks", (payload) => {
        if (!payload || payload.type !== "connected") return;
        if (!payload.connectionId) return;

        clearTimeout(timeoutId);
        unsubscribe();

        this.connectionId = payload.connectionId;
        resolve(payload.connectionId);
      });
    });

    await this.client.connect();
    return this.connectionPromise;
  }

  /**
   * @returns {Promise<void>}
   */
  async close() {
    await this.client.close();
    this.connectionId = null;
    this.connectionPromise = null;
  }

  /**
   * @param {string} name
   * @returns {Promise<{status: string, ownerId?: string, name?: string}>}
   */
  async obtainLock(name) {
    const ownerId = await this.connect();

    const response = await this.client.post("/locks/obtain", {
      name,
      ownerId,
    });

    return response.json();
  }

  /**
   * @param {string} name
   * @returns {Promise<{status: string, name?: string}>}
   */
  async releaseLock(name) {
    const ownerId = await this.connect();

    const response = await this.client.post("/locks/release", {
      name,
      ownerId,
    });

    return response.json();
  }
}
