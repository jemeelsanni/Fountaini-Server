import { Prisma, type Role } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";

interface WriteAuditLogInput {
  actorUserId: string;
  actorRole: Role;
  action: string;
  entityType: string;
  entityId: string;
  beforeData?: Prisma.InputJsonValue;
  afterData?: Prisma.InputJsonValue;
  ipAddress?: string;
  userAgent?: string;
}

export function writeAuditLog(input: WriteAuditLogInput) {
  return prisma.auditLog.create({
    data: {
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      beforeData: input.beforeData,
      afterData: input.afterData,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
  });
}

interface ListAuditLogFilter {
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  limit: number;
}

export function listAuditLog(filter: ListAuditLogFilter) {
  return prisma.auditLog.findMany({
    where: {
      entityType: filter.entityType,
      entityId: filter.entityId,
      actorUserId: filter.actorUserId,
    },
    orderBy: { createdAt: "desc" },
    take: filter.limit,
  });
}
