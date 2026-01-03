import { randomUUID } from "node:crypto";
import WebsocketChannel from "velocious/build/src/http-server/websocket-channel.js";
import { releaseAllLocksForOwner } from "../services/lock-service.js";

export default class LocksChannel extends WebsocketChannel {
  async subscribed() {
    this.connectionId = randomUUID();

    await this.streamFrom("locks");

    await this.websocketSession.sendEvent("locks", {
      connectionId: this.connectionId,
      type: "connected",
    });
  }

  async unsubscribed() {
    if (!this.connectionId) return;

    await releaseAllLocksForOwner(this.connectionId);
  }
}
