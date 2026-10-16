// @ts-check

import ConsensLockClient from "../src/index.js";
import { describe, expect, it } from "velocious/build/src/testing/test.js";

describe("consens-lock client unit", {databaseCleaning: {transaction: false, truncate: false}}, () => {
  it("constructs without connecting and closes idempotently", async () => {
    const client = new ConsensLockClient({ authToken: "test-secret", url: "ws://127.0.0.1:1/websocket" });

    expect(client.connection).toEqual(null);
    expect(client.closed).toEqual(false);

    await client.close();
    await client.close();

    expect(client.closed).toEqual(true);
  });
});
