import { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { SubjectTemplateInput } from "./subject-templates.schemas.js";

/// Every route returns this shape: subjects in template order, each with
/// its full Subject nested. templateId/order are the join row's own keys
/// and stay out of the response — order is already the array position.
const templateInclude = {
  subjects: {
    orderBy: { order: "asc" },
    select: { subjectId: true, optional: true, subject: true },
  },
} satisfies Prisma.SubjectTemplateInclude;

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/// The only unique constraint a template write can trip is the lower(name)
/// index — the join table's (templateId, subjectId) key is already ruled
/// out by assertValidSubjects' duplicate check.
function duplicateNameError(name: string): AppError {
  return AppError.badRequest(`A subject template named "${name}" already exists`);
}

async function assertValidSubjects(
  tx: Prisma.TransactionClient,
  subjects: SubjectTemplateInput["subjects"],
): Promise<void> {
  const ids = subjects.map((s) => s.subjectId);
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (duplicates.length > 0) {
    throw AppError.badRequest(
      `Each subject can only appear once in a template (listed more than once: ${duplicates.join(", ")})`,
    );
  }

  const found = await tx.subject.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const foundIds = new Set(found.map((s) => s.id));
  const unknown = ids.filter((id) => !foundIds.has(id));
  if (unknown.length > 0) {
    throw AppError.badRequest(`Unknown subject${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

function assertName(name: string): void {
  if (name.length === 0) {
    throw AppError.badRequest("Template name is required");
  }
}

function subjectRows(subjects: SubjectTemplateInput["subjects"]) {
  return subjects.map(({ subjectId, optional }, order) => ({ subjectId, optional, order }));
}

export function listSubjectTemplates() {
  return prisma.subjectTemplate.findMany({ orderBy: { name: "asc" }, include: templateInclude });
}

export async function createSubjectTemplate(input: SubjectTemplateInput) {
  assertName(input.name);
  try {
    return await prisma.$transaction(async (tx) => {
      await assertValidSubjects(tx, input.subjects);
      return tx.subjectTemplate.create({
        data: {
          name: input.name,
          description: input.description,
          subjects: { create: subjectRows(input.subjects) },
        },
        include: templateInclude,
      });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw duplicateNameError(input.name);
    throw err;
  }
}

/// Full replace: the subject list is deleted and recreated rather than
/// diffed — it's a handful of rows, and recreating makes the new array
/// order the stored order with no reshuffling logic.
export async function updateSubjectTemplate(id: string, input: SubjectTemplateInput) {
  assertName(input.name);
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.subjectTemplate.findUnique({ where: { id }, select: { id: true } });
      if (!existing) {
        throw AppError.notFound("Subject template not found");
      }
      await assertValidSubjects(tx, input.subjects);
      await tx.subjectTemplateSubject.deleteMany({ where: { templateId: id } });
      return tx.subjectTemplate.update({
        where: { id },
        data: {
          name: input.name,
          description: input.description,
          subjects: { create: subjectRows(input.subjects) },
        },
        include: templateInclude,
      });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw duplicateNameError(input.name);
    throw err;
  }
}

/// Removes the template and (by cascade) its subject list only — any
/// ClassSubjectAssignment rows created by applying it are independent and
/// stay put.
export async function deleteSubjectTemplate(id: string) {
  // deleteMany + count, same reasoning as deleteClassFormTeacher: a
  // concurrent double-delete becomes a 404, not an unhandled P2025.
  const { count } = await prisma.subjectTemplate.deleteMany({ where: { id } });
  if (count === 0) {
    throw AppError.notFound("Subject template not found");
  }
}
