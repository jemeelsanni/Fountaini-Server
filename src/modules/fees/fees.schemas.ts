import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

// A structure targets exactly one of classId, gradeName, or neither
// (school-wide) — this refine catches the same-request case (both set in
// one payload); updateFeeStructure's own merge check catches the other
// case a partial update can produce (this request sets one, the row
// already has the other from before) — see that function's comment for
// why Zod alone can't catch that half.
function targetsAtMostOne(classId: string | undefined, gradeName: string | undefined): boolean {
  return !(classId !== undefined && gradeName !== undefined);
}

export const createFeeStructureSchema = z
  .object({
    name: z.string().min(1),
    category: z.enum(["TUITION", "REGISTRATION", "EXAM", "UNIFORM", "OTHER"]),
    classId: z.string().min(1).optional(),
    gradeName: z.string().min(1).optional(),
    academicSessionId: z.string().min(1),
    termId: z.string().min(1).optional(),
    amountKobo: z.coerce.number().int().positive(),
  })
  .refine((data) => targetsAtMostOne(data.classId, data.gradeName), {
    message: "A fee structure may target a specific class or a grade level, not both",
    path: ["gradeName"],
  });
export type CreateFeeStructureBody = z.infer<typeof createFeeStructureSchema>;

// dueDate is deliberately not here: FeeStructure has no dueDate field in
// the schema (it lives per-obligation, on FeeObligation, set at
// generation time). classId/gradeName became editable specifically to
// make their exclusivity meaningful on update (a Zod-level check needs
// both fields possibly present in the same payload to check anything at
// all) — not a general "retarget an existing structure" feature request;
// nullable so either can be explicitly cleared back to unset, matching the
// undefined-(leave alone)-vs-null-(clear) convention used elsewhere.
export const updateFeeStructureSchema = z
  .object({
    name: z.string().min(1).optional(),
    classId: z.string().min(1).nullable().optional(),
    gradeName: z.string().min(1).nullable().optional(),
    amountKobo: z.coerce.number().int().positive().optional(),
  })
  .refine((data) => targetsAtMostOne(data.classId ?? undefined, data.gradeName ?? undefined), {
    message: "A fee structure may target a specific class or a grade level, not both",
    path: ["gradeName"],
  });
export type UpdateFeeStructureBody = z.infer<typeof updateFeeStructureSchema>;

export const updateFeeObligationSchema = z.object({
  amountDueKobo: z.coerce.number().int().nonnegative().optional(),
  dueDate: z.coerce.date().optional(),
  status: z.enum(["PENDING", "PARTIALLY_PAID", "PAID", "WAIVED"]).optional(),
});
export type UpdateFeeObligationBody = z.infer<typeof updateFeeObligationSchema>;

export const recordPaymentSchema = z.object({
  amountKobo: z.coerce.number().int().positive(),
  bankReference: z.string().min(1).optional(),
  paymentDate: z.coerce.date(),
  notes: z.string().min(1).optional(),
});
export type RecordPaymentBody = z.infer<typeof recordPaymentSchema>;

// status omitted entirely (not just an empty string) means PENDING — the
// bursar's work queue is the default view, not "every payment ever."
// Pass status=CONFIRMED (etc.) explicitly to see anything else.
export const listPaymentsQuerySchema = z.object({
  status: z.enum(["PENDING", "CONFIRMED", "REJECTED"]).default("PENDING"),
  classId: z.string().min(1).optional(),
  studentId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;
