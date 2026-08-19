import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { prisma } from "./db/client.js";

const app = createApp();

// Explicit host, not just a bare port: Node's default (no host given) binds
// every available interface too, but Railway's containers are exactly the
// environment where "just works implicitly" is the wrong thing to depend
// on — 0.0.0.0 is the one host argument guaranteed to accept connections
// from the platform's proxy regardless of container networking specifics.
const server = app.listen(env.PORT, "0.0.0.0", () => {
  logger.info(`Server listening on 0.0.0.0:${env.PORT}`);
});

/// Railway sends SIGTERM on every redeploy/restart, expecting the process
/// to actually exit — not react to it. Without this handler, Node's default
/// behavior for SIGTERM on an app with an open HTTP server and open DB
/// connections is to terminate immediately, mid-request, rather than let
/// in-flight work finish. `server.close()` alone stops accepting *new*
/// connections but resolves only once every in-flight one has finished on
/// its own, which is the actual "finish in-flight requests" behavior this
/// needs — Prisma disconnects only after that resolves, not before.
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info(`${signal} received — closing server and finishing in-flight requests`);

  server.close((err) => {
    if (err) {
      logger.error({ err }, "Error while closing server");
    }
    prisma
      .$disconnect()
      .catch((disconnectErr: unknown) => {
        logger.error({ err: disconnectErr }, "Error while disconnecting Prisma");
      })
      .finally(() => {
        logger.info("Shutdown complete");
        process.exit(err ? 1 : 0);
      });
  });

  // Railway's own grace period before it force-kills is longer than this,
  // but this process shouldn't itself hang forever on a request that never
  // finishes — a bounded-but-generous fallback rather than no fallback at
  // all.
  setTimeout(() => {
    logger.error("Forced shutdown after timeout — some in-flight requests may not have completed");
    process.exit(1);
  }, 30_000).unref();
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
