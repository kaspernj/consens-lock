// @ts-check

import { randomUUID } from "node:crypto";
import WebsocketConnection from "velocious/build/src/http-server/websocket-connection.js";
import { isSupportedProtocolVersion, PROTOCOL_VERSION } from "../lock-server/protocol.js";
import { getAuthority } from "../lock-server/instance.js";
import { verifyAuthToken } from "../lock-server/auth.js";

/**
 * WebSocket surface of the centralized lock server (protocol v2).
 *
 * Ownership is bound to this server-side connection: the holderId is minted
 * here and client-supplied owner ids are ignored entirely. A transport close
 * releases every lease of this connection (immediate dead-holder detection);
 * the authority's sweeper is the backstop for half-open connections.
 */
export default class LockConnection extends WebsocketConnection {
  async onConnect() {
    const params = this.params || {};

    // Fail closed on auth before anything else: no configured secret means
    // no connections at all.
    verifyAuthToken(params.authToken);

    if (!isSupportedProtocolVersion(params.protocolVersion)) {
      throw new Error(`Unsupported lock protocol version: ${String(params.protocolVersion)} (server speaks ${PROTOCOL_VERSION})`);
    }

    this.holderId = randomUUID();
    this.authority = getAuthority();

    this.authority.registerHolder(this.holderId, (name, epoch) => {
      if (this.isClosed()) return;

      try {
        this.sendMessage({ epoch, name, type: "lost" });
      } catch {
        // Transport already gone; the lease is released regardless.
      }
    });

    this.sendMessage({
      leaseMs: this.authority.leaseMs,
      protocolVersion: PROTOCOL_VERSION,
      type: "hello-ack"
    });
  }

  async onMessage(body) {
    if (!body || typeof body !== "object") {
      this.#respond(body, { error: "Message must be an object", status: "error", type: "response" });
      return;
    }

    const { correlationId, name, type } = /** @type {{correlationId?: string, name?: string, type?: string}} */ (body);

    if (type !== "list" && (typeof name !== "string" || name.trim() === "")) {
      this.#respond(body, { error: "name is required", status: "error", type: "response" });
      return;
    }

    const normalizedName = typeof name === "string" ? name.trim() : "";

    switch (type) {
      case "acquire": {
        // Do NOT await the grant here: the session dispatches messages in a
        // serialized FIFO, and a queued acquire can wait for the whole lease
        // window. Blocking would starve every other request on this socket
        // (including diagnostics and the holder's own release). The response
        // is pushed when the grant settles, matched by correlationId.
        const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : 30_000;

        void this.authority.acquire({
          deadlineAt: Date.now() + timeoutMs,
          holderId: this.holderId,
          name: normalizedName
        }).then(async (result) => {
          if (this.isClosed()) return;

          await this.authority.flushEpochWrites();

          if (this.isClosed()) return;

          this.#respond(body, { ...result, type: "response" });
        }).catch((error) => {
          this.#respond(body, { error: error instanceof Error ? error.message : "Acquire failed", status: "error", type: "response" });
        });
        return;
      }

      case "try-acquire": {
        const result = this.authority.tryAcquire({ holderId: this.holderId, name: normalizedName });

        await this.authority.flushEpochWrites();

        this.#respond(body, { ...result, type: "response" });
        return;
      }

      case "renew": {
        if (typeof body.epoch !== "number") {
          this.#respond(body, { error: "epoch is required for renew", status: "error", type: "response" });
          return;
        }

        const result = this.authority.renew({ epoch: body.epoch, holderId: this.holderId, name: normalizedName });

        this.#respond(body, { ...result, type: "response" });
        return;
      }

      case "release": {
        const result = this.authority.release({
          epoch: typeof body.epoch === "number" ? body.epoch : undefined,
          holderId: this.holderId,
          name: normalizedName
        });

        // A release may have handed the name to a queued waiter (a new grant
        // with a new epoch); flush that mirror write too.
        await this.authority.flushEpochWrites();

        this.#respond(body, { ...result, type: "response" });
        return;
      }

      case "who-holds": {
        this.#respond(body, { holder: this.authority.whoHolds(normalizedName), type: "response" });
        return;
      }

      case "list": {
        this.#respond(body, { holders: this.authority.list(), type: "response" });
        return;
      }

      default:
        this.#respond(body, { error: `Unknown message type: ${String(type)}`, status: "error", type: "response" });
    }
  }

  async onClose(_reason) {
    if (!this.holderId) return;

    // Immediate dead-holder detection: every lease of this transport goes
    // with it, and queued waiters for those names are drained.
    this.authority.releaseAllForHolder(this.holderId);
    this.authority.unregisterHolder(this.holderId);
  }

  /**
   * Echoes the client's correlationId so responses can be matched.
   * @param {ReturnType<typeof JSON.parse>} request - Original client message.
   * @param {Record<string, any>} payload - Response payload.
   * @returns {void} - No return value.
   */
  #respond(request, payload) {
    if (this.isClosed()) return;

    const correlationId = request && typeof request === "object" ? request.correlationId : undefined;

    try {
      this.sendMessage({
        ...payload,
        ...(typeof correlationId === "string" ? { correlationId } : {})
      });
    } catch {
      // Transport died mid-response; the client's own timeout cleans up.
    }
  }
}
