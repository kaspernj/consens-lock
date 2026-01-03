import Configuration from "velocious/build/src/configuration.js";
import SqliteDriver from "velocious/build/src/database/drivers/sqlite/index.js";
import AsyncTrackedMultiConnection from "velocious/build/src/database/pool/async-tracked-multi-connection.js";
import NodeEnvironmentHandler from "velocious/build/src/environment-handlers/node.js";
import Lock from "../models/lock.js";
import LocksChannel from "../websocket/locks-channel.js";

const environmentHandler = new NodeEnvironmentHandler();

const database = {
  development: {
    default: {
      driver: SqliteDriver,
      migrations: true,
      name: "consens_lock",
      poolType: AsyncTrackedMultiConnection,
      type: "sqlite",
    },
  },
  test: {
    default: {
      driver: SqliteDriver,
      migrations: true,
      name: "consens_lock_test",
      poolType: AsyncTrackedMultiConnection,
      type: "sqlite",
    },
  },
  production: {
    default: {
      driver: SqliteDriver,
      migrations: true,
      name: "consens_lock",
      poolType: AsyncTrackedMultiConnection,
      type: "sqlite",
    },
  },
};

const configuration = new Configuration({
  database,
  environmentHandler,
  initializeModels: async ({ configuration: currentConfiguration }) => {
    await currentConfiguration.ensureConnections(async () => {
      await Lock.initializeRecord({ configuration: currentConfiguration });
    });
  },
  websocketChannelResolver: ({ subscription }) => {
    if (subscription?.channel === "locks") return LocksChannel;
  },
});

configuration.setCurrent();

export default configuration;
