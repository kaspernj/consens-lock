// @ts-check

import path from "node:path";
import Configuration from "velocious/build/src/configuration.js";
import SqliteDriver from "velocious/build/src/database/drivers/sqlite/index.js";
import AsyncTrackedMultiConnection from "velocious/build/src/database/pool/async-tracked-multi-connection.js";
import NodeEnvironmentHandler from "velocious/build/src/environment-handlers/node.js";
import LockEpoch from "../models/lock-epoch.js";
import LockConnection from "../websocket/lock-connection.js";

const environmentHandler = new NodeEnvironmentHandler();

const database = {
  development: {
    default: {
      driver: SqliteDriver,
      migrations: true,
      name: "consens_lock",
      poolType: AsyncTrackedMultiConnection,
      type: "sqlite"
    }
  },
  test: {
    default: {
      driver: SqliteDriver,
      migrations: true,
      name: "consens_lock_test",
      poolType: AsyncTrackedMultiConnection,
      type: "sqlite"
    }
  },
  production: {
    default: {
      driver: SqliteDriver,
      migrations: true,
      name: "consens_lock",
      poolType: AsyncTrackedMultiConnection,
      type: "sqlite"
    }
  }
};

// Pin the package root so routes/models/migrations resolve from this
// package even when the daemon is booted from another package's test runner.
const packageRoot = path.resolve(path.dirname(import.meta.url.replace("file://", "")), "../..");

const configuration = new Configuration({
  database,
  directory: packageRoot,
  environmentHandler,
  initializeModels: async ({ configuration: currentConfiguration }) => {
    await currentConfiguration.ensureConnections(async () => {
      await LockEpoch.initializeRecord({ configuration: currentConfiguration });
    });
  }
});

// A lock server is a single-writer daemon: a dropped transport must tear the
// session down fast so `onClose` releases its leases immediately, instead of
// parking the connection in the resumable grace registry for five minutes.
configuration.setWebsocketSessionGraceSeconds(2);
configuration.setWebsocketSessionHeartbeatSeconds(2);

configuration.registerWebsocketConnection("lock", LockConnection);

configuration.setCurrent();

export default configuration;
