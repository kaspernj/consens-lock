// @ts-check

import WebsocketClient from "velocious/build/src/http-client/websocket-client.js";
import WebSocket from "ws";

if (!globalThis.WebSocket) {
  globalThis.WebSocket = WebSocket;
}

/** Protocol version spoken by this client. */
const PROTOCOL_VERSION = 2;

/**
 * Standalone npm client for the centralized lock server.
 *
 * Ownership is bound server-side to the authenticated connection: the client
 * never sends owner ids. Holds are leases renewed automatically in the
 * background; a lost lease (fenced or expired) fires the `lost` event and
 * rejects pending renew expectations.
 */
export default class ConsensLockClient {
  /**
   * Runs constructor.
   * @param {object} [args] - Options.
   * @param {string} [args.url] - Websocket URL of the lock server.
   * @param {string} [args.authToken] - Shared secret for the lock server.
   * @param {(name: string, epoch: number) => void} [args.onLost] - Fired when the server fences one of our holds.
   */
  constructor({ authToken, onLost, url } = {}) {
    this.client = new WebsocketClient({
      heartbeatIntervalMs: 10_000,
      url,
      // Node `ws` gives real ping/pong so a half-open client socket is
      // noticed by the server heartbeat instead of lingering.
      webSocketImplementation: WebSocket
    });
    this.authToken = authToken;
    this.onLost = onLost;
    /** @type {import("snapreq/websocket").default extends {openConnection: (...args: any) => infer R} ? R : any} */
    this.connection = null;
    this.connectionPromise = null;
    this.helloAck = null;
    /** @type {Map<string, {epoch: number, name: string, renewTimer: ReturnType<typeof setInterval>}>} */
    this.holds = new Map();
    /** @type {Map<string, {correlationId: string, reject: (error: Error) => void, resolve: (value: any) => void}>} */
    this.pendingRequests = new Map();
    this.requestCounter = 0;
    this.closed = false;
  }

  /**
   * Opens the lock connection and waits for the server's `hello-ack`.
   * @returns {Promise<{leaseMs: number, protocolVersion: number}>} - Server handshake result.
   */
  async connect() {
    if (this.helloAck) return this.helloAck;
    if (this.connectionPromise) return this.connectionPromise;

    this.connectionPromise = (async () => {
      // Open the transport first: snapreq's `openConnection` requires an
      // open socket before the 1:1 connection frame can be sent.
      await this.client.connect();

      const connection = this.client.openConnection("lock", {
        onMessage: (body) => this.#handleMessage(body),
        params: {
          authToken: this.authToken,
          protocolVersion: PROTOCOL_VERSION
        },
        timeoutMs: 10_000
      });

      this.connection = connection;
      await connection.ready;

      if (!this.helloAck) {
        throw new Error("Lock server did not confirm the handshake");
      }

      return this.helloAck;
    })();

    return await this.connectionPromise;
  }

  /**
   * Closes the connection, releasing every held lease explicitly first.
   * @returns {Promise<void>} - Resolves when the client is shut down.
   */
  async close() {
    if (this.closed) return;
    this.closed = true;

    const heldNames = [...this.holds.keys()];

    for (const name of heldNames) {
      try {
        await this.releaseLock(name);
      } catch {
        // Transport may already be gone; the server's close handler and the
        // lease sweeper reclaim the lock either way.
      }
    }

    for (const hold of this.holds.values()) {
      clearInterval(hold.renewTimer);
    }

    this.holds.clear();

    try {
      this.connection?.close();
    } catch {
      // Already closed.
    }

    await this.client.close();
  }

  /**
   * Tries to obtain a lock without waiting (maps to `withAdvisoryLockOrFail`).
   * @param {string} name - Lock name.
   * @returns {Promise<{epoch?: number, holderId?: string, leaseExpiresAt?: string, name: string, ownerId?: string, status: string}>} - Server decision.
   */
  async obtainLock(name) {
    await this.connect();

    const response = await this.#request({ name, type: "try-acquire" });

    if (response.status === "acquired") this.#startHold(name, response);

    return response;
  }

  /**
   * Waits in the server-side FIFO queue until the lock is ours or the bounded
   * timeout expires (maps to `withAdvisoryLock`).
   * @param {string} name - Lock name.
   * @param {object} [args] - Options.
   * @param {number} [args.timeoutMs] - Bounded acquire timeout (default 30 000).
   * @returns {Promise<any>} - Server decision (`acquired` or `timeout`).
   */
  async waitForLock(name, { timeoutMs = 30_000 } = {}) {
    await this.connect();

    const response = await this.#request({ name, timeoutMs, type: "acquire" });

    if (response.status === "acquired") this.#startHold(name, response);

    return response;
  }

  /**
   * Releases a held lock.
   * @param {string} name - Lock name.
   * @returns {Promise<{status: string}>} - Server decision.
   */
  async releaseLock(name) {
    await this.connect();

    const hold = this.holds.get(name);
    const response = await this.#request({ epoch: hold?.epoch, name, type: "release" });

    if (hold) {
      clearInterval(hold.renewTimer);
      this.holds.delete(name);
    }

    return response;
  }

  /**
   * Runs live holders (diagnostics surface).
   * @returns {Promise<any[]>} - Current holders with epochs and lease expiries.
   */
  async listLocks() {
    await this.connect();

    const response = await this.#request({ type: "list" });

    return response.holders || [];
  }

  /**
   * Runs who holds a name (diagnostics surface).
   * @param {string} name - Lock name.
   * @returns {Promise<any | null>} - Current holder, or null.
   */
  async whoHolds(name) {
    await this.connect();

    const response = await this.#request({ name, type: "who-holds" });

    return response.holder ?? null;
  }

  /**
   * Sends one request on the lock connection and awaits its response.
   * @param {Record<string, any>} payload - Request payload (without correlationId).
   * @returns {Promise<any>} - Matching response body.
   */
  #request(payload) {
    const connection = this.connection;

    if (!connection) throw new Error("Not connected to the lock server");

    const correlationId = `req-${++this.requestCounter}`;

    return new Promise((resolve, reject) => {
      const timerId = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error(`Lock server request timed out: ${payload.type} ${payload.name || ""}`));
      }, 60_000);

      timerId.unref?.();

      this.pendingRequests.set(correlationId, {
        correlationId,
        reject: (error) => {
          clearTimeout(timerId);
          reject(error);
        },
        resolve: (value) => {
          clearTimeout(timerId);
          resolve(value);
        }
      });

      try {
        connection.sendMessage({ ...payload, correlationId });
      } catch (error) {
        this.pendingRequests.delete(correlationId);
        clearTimeout(timerId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Dispatches one server message.
   * @param {any} body - Server message body.
   * @returns {void} - No return value.
   */
  #handleMessage(body) {
    if (!body || typeof body !== "object") return;

    if (body.type === "hello-ack") {
      this.helloAck = body;
      return;
    }

    if (body.type === "lost") {
      const hold = this.holds.get(body.name);

      if (hold) {
        clearInterval(hold.renewTimer);
        this.holds.delete(body.name);
      }

      this.onLost?.(body.name, body.epoch);
      return;
    }

    if (body.type === "response" && typeof body.correlationId === "string") {
      const pending = this.pendingRequests.get(body.correlationId);

      if (!pending) return;

      this.pendingRequests.delete(body.correlationId);

      if (body.status === "error") {
        pending.reject(new Error(body.error || "Lock server error"));
        return;
      }

      pending.resolve(body);
    }
  }

  /**
   * Starts the background renewal for a fresh lease.
   * @param {string} name - Lock name.
   * @param {{epoch?: number}} grant - Grant response.
   * @returns {void} - No return value.
   */
  #startHold(name, grant) {
    const leaseMs = this.helloAck?.leaseMs || 30_000;
    const renewIntervalMs = Math.max(1_000, Math.floor(leaseMs / 3));
    const epoch = grant.epoch ?? 0;

    const renewTimer = setInterval(() => {
      void this.#renewHold(name, epoch);
    }, renewIntervalMs);

    renewTimer.unref?.();

    this.holds.set(name, { epoch, name, renewTimer });
  }

  /**
   * One background renewal. A `lost` answer stops the renewal loop; the
   * server's async `lost` push handles the fencing notification as well.
   * @param {string} name - Lock name.
   * @param {number} epoch - Epoch the hold believes it owns.
   * @returns {Promise<void>} - Resolves when the renewal round-trip settles.
   */
  async #renewHold(name, epoch) {
    const hold = this.holds.get(name);

    if (!hold) return;

    try {
      const response = await this.#request({ epoch, name, type: "renew" });

      if (response.status === "lost" || response.status === "not-found") {
        const currentHold = this.holds.get(name);

        if (currentHold) {
          clearInterval(currentHold.renewTimer);
          this.holds.delete(name);
          this.onLost?.(name, response.currentEpoch ?? epoch);
        }
      }
    } catch {
      // Renewal failure while disconnected: the lease expires server-side
      // and the `lost` push (or the next reconnect) surfaces it.
    }
  }
}
