import { prisma } from "../db/client.js";

/// auditMutation fires its write from a res.on("finish") handler without
/// being awaited before the response returns (deliberately — a slow/failing
/// audit write must never delay or break the actual request). A test that
/// queries the audit log immediately after the HTTP call returns can race
/// that write. Poll briefly instead of assuming the row already landed.
export async function waitForAuditLog(
  entityType: string,
  entityId: string,
  action?: string,
  timeoutMs = 2000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entry = await prisma.auditLog.findFirst({ where: { entityType, entityId, action } });
    if (entry) {
      return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}
