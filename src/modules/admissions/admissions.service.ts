import { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { CreateEnquiryBody, ListEnquiriesQuery, UpdateEnquiryBody } from "./admissions.schemas.js";

export async function createEnquiry(input: CreateEnquiryBody) {
  if (input.desiredClassId) {
    const klass = await prisma.class.findUnique({ where: { id: input.desiredClassId } });
    if (!klass) {
      throw AppError.notFound("Desired class not found");
    }
  }
  return prisma.admissionEnquiry.create({ data: input });
}

export function listEnquiries(filter: ListEnquiriesQuery) {
  return prisma.admissionEnquiry.findMany({
    where: { status: filter.status },
    orderBy: { enquiryDate: "desc" },
  });
}

export async function getEnquiryById(id: string) {
  const enquiry = await prisma.admissionEnquiry.findUnique({ where: { id } });
  if (!enquiry) {
    throw AppError.notFound("Enquiry not found");
  }
  return enquiry;
}

export async function updateEnquiry(id: string, actorUserId: string, input: UpdateEnquiryBody) {
  const enquiry = await prisma.admissionEnquiry.findUnique({ where: { id } });
  if (!enquiry) {
    throw AppError.notFound("Enquiry not found");
  }

  return prisma.admissionEnquiry.update({
    where: { id },
    data: { ...input, handledByUserId: actorUserId },
  });
}

export async function convertEnquiry(id: string, actorUserId: string, admissionNumber: string) {
  const enquiry = await prisma.admissionEnquiry.findUnique({ where: { id } });
  if (!enquiry) {
    throw AppError.notFound("Enquiry not found");
  }
  if (enquiry.status === "CONVERTED") {
    throw AppError.conflict("This enquiry has already been converted");
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const student = await tx.student.create({
        data: {
          admissionNumber,
          firstName: enquiry.prospectiveFirstName,
          lastName: enquiry.prospectiveLastName,
          dateOfBirth: enquiry.dateOfBirth,
        },
      });

      // Conditional-update claim, same pattern as auth.service.ts refresh():
      // the WHERE clause re-checks status !== CONVERTED at write time, not
      // just at this function's initial read time, so only one of two
      // concurrent converts can actually flip it. The loser throws here,
      // which rolls back this whole transaction — including the student
      // row just created above — instead of leaving an orphaned duplicate
      // Student with no enquiry pointing at it.
      const claimed = await tx.admissionEnquiry.updateMany({
        where: { id, status: { not: "CONVERTED" } },
        data: { status: "CONVERTED", convertedStudentId: student.id, handledByUserId: actorUserId },
      });
      if (claimed.count === 0) {
        throw AppError.conflict("This enquiry has already been converted");
      }

      const updatedEnquiry = await tx.admissionEnquiry.findUniqueOrThrow({ where: { id } });
      return { student, enquiry: updatedEnquiry };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw AppError.conflict("A student with this admission number already exists");
    }
    throw err;
  }
}
