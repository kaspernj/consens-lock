// @ts-check

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Application from "velocious/build/src/application.js";
import FilesFinder from "velocious/build/src/database/migrator/files-finder.js";
import Migrator from "velocious/build/src/database/migrator.js";
import configuration from "./config/configuration.js";
import LockAuthority from "./lock-server/lock-authority.js";
import EpochStore from "./lock-server/epoch-store.js";
import { readServerSettings } from "./lock-server/protocol.js";
import { setAuthority } from "./lock-server/instance.js";

/**
 * @param {object} [args]
 * @param {string} [args.host]
 * @param {number} [args.leaseMs] - Override the lease duration (tests).
 * @param {number} [args.port]
 * @param {number} [args.sweepIntervalMs] - Override the sweeper interval (tests).
 * @returns {Promise<Application>} - Running application.
 */
export async function startServer({ host = "127.0.0.1", leaseMs, port = 3006, sweepIntervalMs } = {}) {
  await ensureDatabaseDirectory();
  await runMigrations();

  // The lock authority is in-memory state in this process: HTTP/websocket
  // handlers must run in-process, not in worker threads with their own
  // module graphs (a worker would see an uninitialized authority).
  const application = new Application({
    configuration,
    httpServer: { host, inProcess: true, port },
    type: "server"
  });

  // Initialize first so the LockEpoch model is ready for the epoch mirror.
  await application.initialize();

  const settings = readServerSettings();
  const epochStore = new EpochStore();
  const authority = new LockAuthority({
    leaseMs: leaseMs ?? settings.leaseMs,
    persistEpoch: (name, epoch) => epochStore.persist(name, epoch),
    sweepIntervalMs: sweepIntervalMs ?? settings.sweepIntervalMs
  });

  // Restart cannot rewind the fencing sequence: seed epochs from the durable
  // mirror before any grant happens.
  await epochStore.loadInto(authority);
  authority.start();
  setAuthority(authority);

  await application.startHttpServer();

  const originalStop = application.stop.bind(application);

  application.stop = async () => {
    authority.stop();
    await originalStop();
  };

  return application;
}

/**
 * @returns {Promise<void>}
 */
/** Package root resolved from this module, not process.cwd(), so the daemon
 * can also be booted from another package's test runner. */
const packageRoot = path.resolve(path.dirname(import.meta.url.replace("file://", "")), "..");

async function ensureDatabaseDirectory() {
  const databaseDir = path.join(packageRoot, "db");

  await fs.mkdir(databaseDir, { recursive: true });
}

/**
 * @returns {Promise<void>}
 */
async function runMigrations() {
  const migrationsPath = path.join(
    packageRoot,
    "src",
    "database",
    "migrations"
  );

  const files = await new FilesFinder({ path: migrationsPath }).findFiles();

  await configuration.ensureConnections(async () => {
    const migrator = new Migrator({ configuration });
    await migrator.prepare();
    await migrator.migrateFiles(
      files,
      async (fullPath) => {
        const migrationModule = await import(pathToFileURL(fullPath).href);

        return migrationModule.default;
      }
    );
  });
}

if (process.env.NODE_ENV !== "test") {
  const host = process.env.HOST || "127.0.0.1";
  const port = process.env.PORT ? Number(process.env.PORT) : 3006;

  startServer({ host, port })
    .then(() => {
      console.log(`Consens Lock server listening on ${host}:${port}`);
    })
    .catch((error) => {
      console.error("Failed to start server", error);
      process.exitCode = 1;
    });
}
