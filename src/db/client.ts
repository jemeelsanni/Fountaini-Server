import { PrismaClient } from "../../generated/prisma/index.js";
import { env } from "../config/env.js";

// See DB_TRANSACTION_TIMEOUT_MS and DB_TRANSACTION_MAX_WAIT_MS's own
// comments in config/env.ts. Both apply to every $transaction call made
// through this client, interactive or array-form, with no per-call-site
// change needed — Prisma falls back to its own defaults (5000ms / 2000ms)
// for whichever of these is undefined (always both, in production).
const transactionOptions =
  env.DB_TRANSACTION_TIMEOUT_MS || env.DB_TRANSACTION_MAX_WAIT_MS
    ? {
        ...(env.DB_TRANSACTION_TIMEOUT_MS ? { timeout: env.DB_TRANSACTION_TIMEOUT_MS } : {}),
        ...(env.DB_TRANSACTION_MAX_WAIT_MS ? { maxWait: env.DB_TRANSACTION_MAX_WAIT_MS } : {}),
      }
    : undefined;

export const prisma = new PrismaClient({
  log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  ...(transactionOptions ? { transactionOptions } : {}),
});
