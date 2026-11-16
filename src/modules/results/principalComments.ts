import type { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type {
  CreatePrincipalCommentTemplateBody,
  UpdatePrincipalCommentTemplateBody,
} from "./results.schemas.js";

/// The head of school's predefined comments. The admin sees every template
/// whose range holds a card's average as a suggestion, and can still write
/// their own. Publishing a card with no principal comment fills it from the
/// first matching template (pickPrincipalComment) — so a whole-school
/// "Publish all" on the last day doesn't need a comment typed per student.

const ORDER_BY = [{ order: "asc" }, { minAverage: "desc" }] satisfies Prisma.PrincipalCommentTemplateOrderByWithRelationInput[];

export function listPrincipalCommentTemplates() {
  return prisma.principalCommentTemplate.findMany({ orderBy: ORDER_BY });
}

export function createPrincipalCommentTemplate(input: CreatePrincipalCommentTemplateBody) {
  return prisma.principalCommentTemplate.create({
    data: {
      minAverage: input.minAverage,
      maxAverage: input.maxAverage,
      comment: input.comment,
      order: input.order ?? 0,
    },
  });
}

export async function updatePrincipalCommentTemplate(id: string, input: UpdatePrincipalCommentTemplateBody) {
  const existing = await prisma.principalCommentTemplate.findUnique({ where: { id } });
  if (!existing) {
    throw AppError.notFound("Comment template not found");
  }
  const min = input.minAverage ?? existing.minAverage.toNumber();
  const max = input.maxAverage ?? existing.maxAverage.toNumber();
  if (max < min) {
    throw AppError.badRequest("maxAverage must be at least minAverage");
  }
  return prisma.principalCommentTemplate.update({ where: { id }, data: input });
}

export async function deletePrincipalCommentTemplate(id: string) {
  const { count } = await prisma.principalCommentTemplate.deleteMany({ where: { id } });
  if (count === 0) {
    throw AppError.notFound("Comment template not found");
  }
}

/// The comment a card with this average gets when it's published without
/// one: the first matching template by `order`. Null when there's no
/// average (no subjects submitted) or nothing in the bank covers it.
export async function pickPrincipalComment(
  db: Prisma.TransactionClient,
  averageScore: Prisma.Decimal | number | null,
): Promise<string | null> {
  if (averageScore === null) {
    return null;
  }
  const average = typeof averageScore === "number" ? averageScore : averageScore.toNumber();
  const template = await db.principalCommentTemplate.findFirst({
    where: { minAverage: { lte: average }, maxAverage: { gte: average } },
    orderBy: ORDER_BY,
    select: { comment: true },
  });
  return template?.comment ?? null;
}
