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

      const updatedEnquiry = await tx.admissionEnquiry.update({
        where: { id },
        data: { status: "CONVERTED", convertedStudentId: student.id, handledByUserId: actorUserId },
      });

      return { student, enquiry: updatedEnquiry };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw AppError.conflict("A student with this admission number already exists");
    }
    throw err;
  }
}
