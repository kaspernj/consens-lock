// @ts-check

import Controller from "velocious/build/src/controller.js";
import VelociousError from "velocious/build/src/velocious-error.js";
import { getAuthority } from "../../lock-server/instance.js";
import { bearerTokenFromRequest, verifyAuthToken } from "../../lock-server/auth.js";
import { PROTOCOL_VERSION } from "../../lock-server/protocol.js";

/**
 * HTTP surface of the lock server. Kept for backward compatibility with the
 * existing npm client, but ownership is now bound to the authenticated
 * transport: any client-supplied `ownerId` is ignored, and every route fails
 * closed without a valid bearer token.
 */
export default class LocksController extends Controller {
  /**
   * Shared fail-closed auth gate for all lock routes.
   * @returns {boolean} - True when the request is authorized.
   */
  authorize() {
    try {
      verifyAuthToken(bearerTokenFromRequest(this.request()));

      return true;
    } catch (error) {
      const status = error instanceof VelociousError && error.safeToExpose ? 401 : 500;

      this.render({
        json: { error: error instanceof Error ? error.message : "Auth failed", status: "error" },
        status
      });

      return false;
    }
  }

  async obtain() {
    if (!this.authorize()) return;

    const { name } = this.params();

    if (!name) {
      this.render({ json: { error: "name is required", status: "error" }, status: 422 });
      return;
    }

    const result = getAuthority().tryAcquire({ holderId: this.#httpHolderId(), name: String(name).trim() });

    this.render({ json: { ...result, name, protocolVersion: PROTOCOL_VERSION } });
  }

  async release() {
    if (!this.authorize()) return;

    const { name } = this.params();

    if (!name) {
      this.render({ json: { error: "name is required", status: "error" }, status: 422 });
      return;
    }

    const result = getAuthority().release({ holderId: this.#httpHolderId(), name: String(name).trim() });

    this.render({ json: { ...result, name, protocolVersion: PROTOCOL_VERSION } });
  }

  async status() {
    if (!this.authorize()) return;

    this.render({ json: { holders: getAuthority().list(), protocolVersion: PROTOCOL_VERSION, status: "ok" } });
  }

  /**
   * Legacy HTTP obtain/release has no persistent transport to bind a lease to,
   * so each request gets a one-shot holder identity. HTTP-obtained locks are
   * reclaimed by the lease sweeper; the WebSocket connection is the intended
   * surface for real holds.
   * @returns {string} - One-shot holder id.
   */
  #httpHolderId() {
    return `http:${this.request().remoteAddress() || "unknown"}`;
  }
}
