import { PrismaClient } from "../../generated/prisma/index.js";
import { env } from "../config/env.js";

export const prisma = new PrismaClient({
  log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});
