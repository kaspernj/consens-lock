// @ts-check

import net from "node:net";
import WebSocket from "ws";

/**
 * @returns {Promise<number>} - An available TCP port.
 */
export function getAvailablePort() {
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
 * Boots the real daemon for a spec with short lease/sweep timings.
 * @param {object} [args] - Options.
 * @param {string | null} [args.authToken] - Shared secret (null leaves it unconfigured for fail-closed specs).
 * @param {number} [args.leaseMs] - Lease duration.
 * @param {number} [args.sweepIntervalMs] - Sweeper interval.
 * @returns {Promise<{application: import("velocious/build/src/application.js").default, httpUrl: string, port: number, wsUrl: string}>} - Running server handles.
 */
export async function startTestServer({ authToken = "test-secret", leaseMs = 1200, sweepIntervalMs = 200 } = {}) {
  process.env.NODE_ENV = "test";

  if (authToken) {
    process.env.CONSENS_LOCK_AUTH_TOKEN = authToken;
  } else {
    delete process.env.CONSENS_LOCK_AUTH_TOKEN;
  }

  const { startServer } = await import("../../src/server.js");
  const port = await getAvailablePort();
  const application = await startServer({ leaseMs, port, sweepIntervalMs });

  return {
    application,
    httpUrl: `http://127.0.0.1:${port}`,
    port,
    wsUrl: `ws://127.0.0.1:${port}/websocket`
  };
}

/**
 * Raw websocket transport for specs that must control the socket directly
 * (abrupt termination, wrong protocol version, raw auth params).
 */
export class RawLockSocket {
  /**
   * Runs constructor.
   * @param {object} args - Options.
   * @param {string | null} [args.authToken] - Auth token param sent in the open handshake.
   * @param {number} [args.protocolVersion] - Protocol version param.
   * @param {string} args.wsUrl - Websocket URL.
   */
  constructor({ authToken = "test-secret", protocolVersion = 2, wsUrl }) {
    this.authToken = authToken;
    this.connectionId = `raw-${Math.random().toString(36).slice(2, 10)}`;
    this.counter = 0;
    /** @type {{epoch: number, name: string} | null} */
    this.lastLostPush = null;
    /** @type {Array<(push: {epoch: number, name: string}) => void>} */
    this.lostWaiters = [];
    /** @type {Map<string, {reject: (error: Error) => void, resolve: (value: any) => void}>} */
    this.pending = new Map();
    this.protocolVersion = protocolVersion;
    /** @type {WebSocket | null} */
    this.socket = null;
    this.wsUrl = wsUrl;
  }

  /**
   * Opens the socket and the lock connection, resolving on `connection-opened`.
   * @returns {Promise<void>} - Resolves when the connection is open.
   */
  async connect() {
    const socket = new WebSocket(this.wsUrl);

    this.socket = socket;

    await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error("Raw socket connect timed out")), 10_000);

      socket.on("message", (raw) => {
        /** @type {any} */
        let message;

        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (message.type === "session-established") {
          socket.send(JSON.stringify({
            connectionId: this.connectionId,
            connectionType: "lock",
            params: { authToken: this.authToken, protocolVersion: this.protocolVersion },
            type: "connection-open"
          }));
          return;
        }

        if (message.type === "connection-opened") {
          clearTimeout(timeoutId);
          resolve();
          return;
        }

        if (message.type === "connection-error") {
          clearTimeout(timeoutId);
          reject(new Error(message.message || "Connection error"));
          return;
        }

        if (message.type === "connection-message") {
          this.#handleBody(message.body);
        }
      });

      socket.on("error", (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });

      socket.on("close", () => {
        clearTimeout(timeoutId);
        reject(new Error("Raw socket closed before opening"));
      });
    });
  }

  /**
   * Sends one protocol request and awaits its correlated response.
   * @param {Record<string, any>} payload - Request payload.
   * @returns {Promise<any>} - Response body.
   */
  async request(payload) {
    const socket = this.socket;

    if (!socket) throw new Error("Raw socket not connected");

    const correlationId = `raw-req-${++this.counter}`;

    return await new Promise((resolve, reject) => {
      const timerId = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new Error(`Raw request timed out: ${payload.type} ${payload.name || ""}`));
      }, 10_000);

      this.pending.set(correlationId, {
        reject: (error) => {
          clearTimeout(timerId);
          reject(error);
        },
        resolve: (value) => {
          clearTimeout(timerId);
          resolve(value);
        }
      });

      socket.send(JSON.stringify({
        body: { ...payload, correlationId },
        connectionId: this.connectionId,
        type: "connection-message"
      }));
    });
  }

  /**
   * Awaits the next asynchronous `lost` push from the server.
   * @param {number} [timeoutMs] - Maximum wait.
   * @returns {Promise<{epoch: number, name: string}>} - The lost push body.
   */
  async nextLostPush(timeoutMs = 8_000) {
    if (this.lastLostPush) {
      const push = this.lastLostPush;
      this.lastLostPush = null;

      return push;
    }

    return await new Promise((resolve, reject) => {
      const timerId = setTimeout(() => reject(new Error("No lost push received in time")), timeoutMs);

      this.lostWaiters.push((push) => {
        clearTimeout(timerId);
        resolve(push);
      });
    });
  }

  /**
   * Abruptly kills the TCP connection (SIGKILL simulation: no close frame).
   * @returns {void} - No return value.
   */
  terminate() {
    this.socket?.terminate();
  }

  /**
   * Closes cleanly: `connection-close` first, then the socket.
   * @returns {Promise<void>} - Resolves when the socket is closed.
   */
  async close() {
    const socket = this.socket;

    if (!socket) return;

    try {
      socket.send(JSON.stringify({ connectionId: this.connectionId, type: "connection-close" }));
    } catch {
      // Socket already gone.
    }

    await new Promise((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }

      socket.on("close", resolve);
      socket.close();
    });
  }

  /**
   * Dispatches one connection-message body.
   * @param {any} body - Server message body.
   * @returns {void} - No return value.
   */
  #handleBody(body) {
    if (!body || typeof body !== "object") return;

    if (body.type === "hello-ack") {
      this.helloAck = body;
      return;
    }

    if (body.type === "lost") {
      const waiter = this.lostWaiters.shift();

      if (waiter) {
        waiter(body);
        return;
      }

      this.lastLostPush = body;
      return;
    }

    if (body.type === "response" && typeof body.correlationId === "string") {
      const pending = this.pending.get(body.correlationId);

      if (!pending) return;

      this.pending.delete(body.correlationId);

      if (body.status === "error") {
        pending.reject(new Error(body.error || "Lock server error"));
        return;
      }

      pending.resolve(body);
    }
  }
}

/**
 * Polls until the condition returns a truthy value, or throws on timeout.
 * @param {object} args - Options.
 * @param {() => Promise<any>} args.condition - Poll step.
 * @param {number} [args.intervalMs] - Delay between polls.
 * @param {number} [args.timeoutMs] - Hard deadline.
 * @returns {Promise<any>} - First truthy result.
 */
export async function pollUntil({ condition, intervalMs = 100, timeoutMs = 8_000 }) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await condition();

    if (result) return result;

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("pollUntil timed out");
}
