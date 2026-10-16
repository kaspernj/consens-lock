// @ts-check

import Configuration from "velocious/build/src/configuration.js";
import SqliteDriver from "velocious/build/src/database/drivers/sqlite/index.js";
import AsyncTrackedMultiConnection from "velocious/build/src/database/pool/async-tracked-multi-connection.js";
import NodeEnvironmentHandler from "velocious/build/src/environment-handlers/node.js";

// The npm client package has no database of its own; this minimal sqlite
// configuration only exists so `velocious test` can boot the test runner for
// client specs (the specs drive the real daemon from the server package).
const database = {
  development: {
    default: {
      driver: SqliteDriver,
      migrations: false,
      name: "consens_lock_npm_client",
      poolType: AsyncTrackedMultiConnection,
      type: "sqlite"
    }
  },
  test: {
    default: {
      driver: SqliteDriver,
      migrations: false,
      name: "consens_lock_npm_client_test",
      poolType: AsyncTrackedMultiConnection,
      type: "sqlite"
    }
  },
  production: {
    default: {
      driver: SqliteDriver,
      migrations: false,
      name: "consens_lock_npm_client",
      poolType: AsyncTrackedMultiConnection,
      type: "sqlite"
    }
  }
};

const configuration = new Configuration({
  database,
  environmentHandler: new NodeEnvironmentHandler()
});

configuration.setCurrent();

export default configuration;
