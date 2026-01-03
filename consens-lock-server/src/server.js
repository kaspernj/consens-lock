import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Application from "velocious/build/src/application.js";
import FilesFinder from "velocious/build/src/database/migrator/files-finder.js";
import Migrator from "velocious/build/src/database/migrator.js";
import configuration from "./config/configuration.js";

/**
 * @param {object} [args]
 * @param {string} [args.host]
 * @param {number} [args.port]
 * @returns {Promise<Application>}
 */
export async function startServer({ host = "127.0.0.1", port = 3006 } = {}) {
  await ensureDatabaseDirectory();
  await runMigrations();

  const application = new Application({
    configuration,
    httpServer: { host, port },
    type: "server",
  });

  await application.initialize();
  await application.startHttpServer();

  return application;
}

/**
 * @returns {Promise<void>}
 */
async function ensureDatabaseDirectory() {
  const databaseDir = path.join(process.cwd(), "db");
  await fs.mkdir(databaseDir, { recursive: true });
}

/**
 * @returns {Promise<void>}
 */
async function runMigrations() {
  const migrationsPath = path.join(
    process.cwd(),
    "src",
    "database",
    "migrations",
  );

  const files = await new FilesFinder({ path: migrationsPath }).findFiles();

  await configuration.ensureConnections(async () => {
    const migrator = new Migrator({ configuration });
    await migrator.prepare();
    await migrator.migrateFiles(
      files,
      async (fullPath) => await import(pathToFileURL(fullPath).href),
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
