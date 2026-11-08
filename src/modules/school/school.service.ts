import type { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { CreateSchoolBody, UpdateSchoolBody } from "./school.schemas.js";

export const HEAD_SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;

const SIGNATURE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/// Magic bytes per accepted type, so a data URL can't claim image/png while
/// carrying something else — the value is rendered as an <img> on every
/// report card.
const SIGNATURE_MAGIC: Record<string, (bytes: Buffer) => boolean> = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

/// School is a literal singleton — "never create a second School record"
/// (see the model's own comment in schema.prisma) — but nothing at the
/// database level actually enforces that (no natural unique field to hang
/// a constraint on, unlike isCurrent's partial unique indexes elsewhere in
/// this schema). createSchool() below is the one place that invariant is
/// actually upheld, the same transaction-scoped-advisory-lock pattern
/// setCurrentAcademicSession() already uses for the identical
/// read-then-conditionally-write race.
/// Every School response leaves the signature image out — it can be ~2.7 MB
/// of base64, and GET /school is loaded by every role on every app start
/// just for the name and address. `hasHeadSignature` says whether one is
/// set; the image itself is GET /school/signature (getHeadSignature).
export const OMIT_SIGNATURE = { headSignature: true } as const;

async function withSignatureFlag<T extends { id: string }>(school: T) {
  const hasHeadSignature =
    (await prisma.school.count({ where: { id: school.id, headSignature: { not: null } } })) > 0;
  return { ...school, hasHeadSignature };
}

export async function getSchool() {
  const school = await prisma.school.findFirst({ omit: OMIT_SIGNATURE });
  if (!school) {
    throw AppError.notFound("School has not been configured yet");
  }
  return withSignatureFlag(school);
}

export async function getHeadSignature() {
  const school = await prisma.school.findFirst({ select: { headSignature: true } });
  if (!school) {
    throw AppError.notFound("School has not been configured yet");
  }
  return school;
}

export async function createSchool(input: CreateSchoolBody) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('school_create'))`;
    const existing = await tx.school.findFirst();
    if (existing) {
      throw AppError.conflict("A School record already exists — use PATCH /api/school to update it");
    }
    return tx.school.create({ data: input, omit: OMIT_SIGNATURE });
  }).then((school) => ({ ...school, hasHeadSignature: false }));
}

async function updateSingleton(data: Prisma.SchoolUpdateInput) {
  const existing = await prisma.school.findFirst({ select: { id: true } });
  if (!existing) {
    throw AppError.notFound("School has not been configured yet — create it first");
  }
  return withSignatureFlag(await prisma.school.update({ where: { id: existing.id }, data, omit: OMIT_SIGNATURE }));
}

export function updateSchool(input: UpdateSchoolBody) {
  return updateSingleton(input);
}

export async function setHeadSignature(dataUrl: string) {
  const match = SIGNATURE_DATA_URL.exec(dataUrl.trim());
  if (!match) {
    throw AppError.badRequest(
      "Signature must be a base64 PNG, JPEG or WebP data URL (data:image/png;base64,…)",
    );
  }
  const [, type, payload] = match as unknown as [string, string, string];
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length > HEAD_SIGNATURE_MAX_BYTES) {
    throw AppError.badRequest("Signature image is too large (max 2 MB)");
  }
  if (!SIGNATURE_MAGIC[type]?.(bytes)) {
    throw AppError.badRequest(`Signature data is not a valid ${type.toUpperCase()} image`);
  }
  return updateSingleton({ headSignature: dataUrl.trim() });
}

export function clearHeadSignature() {
  return updateSingleton({ headSignature: null });
}
