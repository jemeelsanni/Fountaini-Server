import { PrismaClient } from "../../generated/prisma/index.js";
import { env } from "../config/env.js";

export const prisma = new PrismaClient({
  log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  // See DB_TRANSACTION_TIMEOUT_MS's own comment in config/env.ts. Applies
  // to every $transaction call made through this client, interactive or
  // array-form, with no per-call-site change needed — Prisma falls back to
  // its own 5000ms default when this is undefined (production).
  ...(env.DB_TRANSACTION_TIMEOUT_MS ? { transactionOptions: { timeout: env.DB_TRANSACTION_TIMEOUT_MS } } : {}),
});
