import { z } from "zod";
import "./zodSetup.js";
import { registry } from "./registry.js";

/// One Zod schema per shape a route actually returns, hand-written against
/// prisma/schema.prisma and cross-checked against every controller/service
/// in src/modules — not generated from the Prisma models directly (Prisma's
/// own types don't distinguish "raw model" from "model with this specific
/// include", which is the thing that actually varies route to route here).
/// Grouped in the same order as schema.prisma's own section headers.

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const id = () => z.string().openapi({ description: "cuid" });
const isoDateTime = () => z.string().openapi({ format: "date-time" });
const isoDate = () => z.string().openapi({ format: "date", description: "YYYY-MM-DD, no time component" });
/// Prisma's Decimal fields (scores, money-adjacent academic values — NOT
/// kobo, which is a plain Int) serialize through res.json() as strings, not
/// JSON numbers: Decimal.prototype.toJSON() returns .toString(). Modeling
/// them as z.number() here would document a shape the API never actually
/// sends.
const decimalString = () => z.string().openapi({ description: "Decimal value, serialized as a string" });
const kobo = () => z.number().int().openapi({ description: "Amount in kobo (1/100 of a naira)" });

// ---------------------------------------------------------------------------
// Enums (mirrors every enum in schema.prisma)
// ---------------------------------------------------------------------------

export const RoleSchema = z.enum(["ADMIN", "TEACHER", "PARENT", "STUDENT", "BURSAR"]).openapi("Role");
const StudentStatusSchema = z.enum(["ACTIVE", "GRADUATED", "WITHDRAWN", "INACTIVE"]).openapi("StudentStatus");
const GenderSchema = z.enum(["MALE", "FEMALE"]).openapi("Gender");
const FamilyRelationshipSchema = z
  .enum(["FATHER", "MOTHER", "GUARDIAN", "OTHER"])
  .openapi("FamilyRelationship");
const SubjectTypeSchema = z.enum(["ACADEMIC", "MADRASSAH"]).openapi("SubjectType");
const EnrollmentStatusSchema = z
  .enum(["ACTIVE", "TRANSFERRED_OUT", "WITHDRAWN", "GRADUATED"])
  .openapi("EnrollmentStatus");
const AssessmentTypeSchema = z.enum(["CA", "EXAM"]).openapi("AssessmentType");
const ScoreStatusSchema = z.enum(["DRAFT", "SUBMITTED"]).openapi("ScoreStatus");
const ResultStatusSchema = z.enum(["DRAFT", "SUBMITTED", "FINALIZED"]).openapi("ResultStatus");
const MadrassahProgressTypeSchema = z
  .enum(["MEMORIZATION", "REVISION", "TAJWEED_ASSESSMENT"])
  .openapi("MadrassahProgressType");
const MadrassahProgressStatusSchema = z
  .enum(["IN_PROGRESS", "COMPLETED", "NEEDS_REVISION"])
  .openapi("MadrassahProgressStatus");
const DayOfWeekSchema = z
  .enum(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"])
  .openapi("DayOfWeek");
const FeeCategorySchema = z.enum(["TUITION", "REGISTRATION", "EXAM", "UNIFORM", "OTHER"]).openapi("FeeCategory");
const FeeObligationStatusSchema = z
  .enum(["PENDING", "PARTIALLY_PAID", "PAID", "WAIVED"])
  .openapi("FeeObligationStatus");
const PaymentMethodSchema = z.enum(["BANK_TRANSFER"]).openapi("PaymentMethod");
const PaymentStatusSchema = z.enum(["PENDING", "CONFIRMED", "REJECTED"]).openapi("PaymentStatus");
const AttendanceSessionStatusSchema = z.enum(["OPEN", "CLOSED"]).openapi("AttendanceSessionStatus");
const AttendanceStatusSchema = z.enum(["PRESENT", "ABSENT", "LATE"]).openapi("AttendanceStatus");
const AttendanceMethodSchema = z.enum(["QR_SCAN", "MANUAL"]).openapi("AttendanceMethod");
const EnquiryStatusSchema = z.enum(["NEW", "CONTACTED", "CONVERTED", "CLOSED"]).openapi("EnquiryStatus");
const NotificationTypeSchema = z
  .enum(["FEE_REMINDER", "PAYMENT_CONFIRMATION", "ACADEMIC", "ADMIN_GENERAL"])
  .openapi("NotificationType");
const NotificationChannelSchema = z.enum(["SMS", "EMAIL", "WHATSAPP", "IN_APP"]).openapi("NotificationChannel");
const NotificationDeliveryStatusSchema = z
  .enum(["PENDING", "SENT", "FAILED", "DELIVERED"])
  .openapi("NotificationDeliveryStatus");

// ---------------------------------------------------------------------------
// School / auth / users
// ---------------------------------------------------------------------------

export const SchoolSchema = z
  .object({
    id: id(),
    name: z.string(),
    address: z.string().nullable(),
    contactEmail: z.string().nullable(),
    contactPhone: z.string().nullable(),
    createdAt: isoDateTime(),
    updatedAt: isoDateTime(),
  })
  .openapi("School");

/// The only User shape any route ever returns — a fixed subset
/// (passwordHash/phone/updatedAt are never sent). See users.service.ts's
/// userListSelect + flattenRoles().
export const UserSummarySchema = z
  .object({
    id: id(),
    email: z.string().nullable(),
    roles: z.array(RoleSchema),
    isActive: z.boolean(),
    createdAt: isoDateTime(),
    lastLoginAt: isoDateTime().nullable(),
  })
  .openapi("UserSummary");

export const StaffSchema = z
  .object({
    id: id(),
    userId: id(),
    staffNumber: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    otherNames: z.string().nullable(),
    department: z.string().nullable(),
    employmentDate: isoDateTime().nullable(),
    isActive: z.boolean(),
    createdAt: isoDateTime(),
    updatedAt: isoDateTime(),
  })
  .openapi("Staff");

/// staff.service.ts's listStaff()/getStaffById() shape — createStaff()
/// deliberately returns plain StaffSchema instead, with no `user` field.
export const StaffWithUserSchema = StaffSchema.extend({
  user: z.object({ email: z.string().nullable(), roles: z.array(RoleSchema) }),
}).openapi("StaffWithUser");

export const ParentSchema = z
  .object({
    id: id(),
    userId: id(),
    firstName: z.string(),
    lastName: z.string(),
    phone: z.string().nullable(),
    alternatePhone: z.string().nullable(),
    address: z.string().nullable(),
    createdAt: isoDateTime(),
    updatedAt: isoDateTime(),
  })
  .openapi("Parent");

export const StudentSchema = z
  .object({
    id: id(),
    admissionNumber: z.string(),
    userId: id().nullable(),
    firstName: z.string(),
    lastName: z.string(),
    otherNames: z.string().nullable(),
    dateOfBirth: isoDateTime().nullable(),
    gender: GenderSchema.nullable(),
    admissionDate: isoDateTime(),
    status: StudentStatusSchema,
    createdAt: isoDateTime(),
    updatedAt: isoDateTime(),
  })
  .openapi("Student");

export const StudentParentSchema = z
  .object({
    id: id(),
    studentId: id(),
    parentId: id(),
    relationship: FamilyRelationshipSchema,
    isPrimaryContact: z.boolean(),
    createdAt: isoDateTime(),
  })
  .openapi("StudentParent");

export const StudentParentWithStudentSchema = StudentParentSchema.extend({
  student: StudentSchema,
}).openapi("StudentParentWithStudent");

// ---------------------------------------------------------------------------
// Academic structure
// ---------------------------------------------------------------------------

export const AcademicSessionSchema = z
  .object({
    id: id(),
    name: z.string(),
    startDate: isoDateTime(),
    endDate: isoDateTime(),
    isCurrent: z.boolean(),
    createdAt: isoDateTime(),
    updatedAt: isoDateTime(),
  })
  .openapi("AcademicSession");

export const TermSchema = z
  .object({
    id: id(),
    academicSessionId: id(),
    name: z.string(),
    order: z.number().int(),
    startDate: isoDateTime(),
    endDate: isoDateTime(),
    isCurrent: z.boolean(),
    createdAt: isoDateTime(),
  })
  .openapi("Term");

export const ClassSchema = z
  .object({
    id: id(),
    gradeName: z.string(),
    arm: z.string().nullable(),
    order: z.number().int(),
    createdAt: isoDateTime(),
  })
  .openapi("Class");

export const SubjectSchema = z
  .object({
    id: id(),
    name: z.string(),
    code: z.string(),
    type: SubjectTypeSchema,
    createdAt: isoDateTime(),
  })
  .openapi("Subject");

export const ClassSubjectAssignmentSchema = z
  .object({
    id: id(),
    classId: id(),
    subjectId: id(),
    teacherId: id(),
    academicSessionId: id(),
    createdAt: isoDateTime(),
  })
  .openapi("ClassSubjectAssignment");

export const ClassSubjectAssignmentWithRelationsSchema = ClassSubjectAssignmentSchema.extend({
  class: ClassSchema,
  subject: SubjectSchema,
  teacher: StaffSchema,
  academicSession: AcademicSessionSchema,
}).openapi("ClassSubjectAssignmentWithRelations");

export const ClassFormTeacherSchema = z
  .object({
    id: id(),
    classId: id(),
    teacherId: id(),
    academicSessionId: id(),
    createdAt: isoDateTime(),
  })
  .openapi("ClassFormTeacher");

export const ClassFormTeacherWithRelationsSchema = ClassFormTeacherSchema.extend({
  class: ClassSchema,
  teacher: StaffSchema,
  academicSession: AcademicSessionSchema,
}).openapi("ClassFormTeacherWithRelations");

export const EnrollmentSchema = z
  .object({
    id: id(),
    studentId: id(),
    classId: id(),
    academicSessionId: id(),
    status: EnrollmentStatusSchema,
    enrolledAt: isoDateTime(),
    createdAt: isoDateTime(),
  })
  .openapi("Enrollment");

export const EnrollmentWithRelationsSchema = EnrollmentSchema.extend({
  class: ClassSchema,
  academicSession: AcademicSessionSchema,
}).openapi("EnrollmentWithRelations");

// ---------------------------------------------------------------------------
// Grading configuration, scores, results
// ---------------------------------------------------------------------------

export const AssessmentComponentSchema = z
  .object({
    id: id(),
    academicSessionId: id(),
    code: z.string(),
    name: z.string(),
    type: AssessmentTypeSchema,
    maxScore: decimalString(),
    order: z.number().int(),
    createdAt: isoDateTime(),
  })
  .openapi("AssessmentComponent");

export const ScoreSchema = z
  .object({
    id: id(),
    studentId: id(),
    classSubjectAssignmentId: id(),
    termId: id(),
    assessmentComponentId: id(),
    rawScore: decimalString(),
    status: ScoreStatusSchema,
    enteredByUserId: id(),
    enteredAt: isoDateTime(),
    updatedByUserId: id().nullable(),
    updatedAt: isoDateTime(),
  })
  .openapi("Score");

export const GradeBandSchema = z
  .object({
    id: id(),
    gradingScaleId: id(),
    grade: z.string(),
    minScore: decimalString(),
    maxScore: decimalString(),
    remark: z.string().nullable(),
    gradePoint: decimalString().nullable(),
  })
  .openapi("GradeBand");

export const GradingScaleSchema = z
  .object({
    id: id(),
    academicSessionId: id(),
    createdAt: isoDateTime(),
  })
  .openapi("GradingScale");

export const GradingScaleWithBandsSchema = GradingScaleSchema.extend({
  bands: z.array(GradeBandSchema),
}).openapi("GradingScaleWithBands");

export const SubjectResultSchema = z
  .object({
    id: id(),
    studentId: id(),
    classSubjectAssignmentId: id(),
    termId: id(),
    totalScore: decimalString(),
    grade: z.string().nullable(),
    gradePoint: decimalString().nullable(),
    remark: z.string().nullable(),
    status: ScoreStatusSchema,
    submittedByUserId: id().nullable(),
    submittedAt: isoDateTime().nullable(),
    computedAt: isoDateTime(),
  })
  .openapi("SubjectResult");

export const SubjectResultWithRelationsSchema = SubjectResultSchema.extend({
  classSubjectAssignment: ClassSubjectAssignmentSchema.extend({ subject: SubjectSchema }),
  term: TermSchema,
}).openapi("SubjectResultWithRelations");

export const ResultSchema = z
  .object({
    id: id(),
    studentId: id(),
    enrollmentId: id(),
    termId: id(),
    status: ResultStatusSchema,
    totalScore: decimalString().nullable(),
    averageScore: decimalString().nullable(),
    position: z.number().int().nullable(),
    outOf: z.number().int().nullable(),
    classTeacherComment: z.string().nullable(),
    principalComment: z.string().nullable(),
    submittedByUserId: id().nullable(),
    submittedAt: isoDateTime().nullable(),
    finalizedByUserId: id().nullable(),
    finalizedAt: isoDateTime().nullable(),
    createdAt: isoDateTime(),
    updatedAt: isoDateTime(),
  })
  .openapi("Result");

export const ResultWithStudentSchema = ResultSchema.extend({
  student: StudentSchema,
}).openapi("ResultWithStudent");

// ---------------------------------------------------------------------------
// Madrassah / Qur'an progress
// ---------------------------------------------------------------------------

export const SurahSchema = z
  .object({
    id: id(),
    number: z.number().int(),
    name: z.string(),
    englishName: z.string().nullable(),
    totalAyahs: z.number().int(),
  })
  .openapi("Surah");

export const MadrassahProgressSchema = z
  .object({
    id: id(),
    studentId: id(),
    staffId: id(),
    academicSessionId: id(),
    termId: id(),
    surahId: id().nullable(),
    ayahFrom: z.number().int().nullable(),
    ayahTo: z.number().int().nullable(),
    juzNumber: z.number().int().nullable(),
    progressType: MadrassahProgressTypeSchema,
    status: MadrassahProgressStatusSchema,
    tajweedNotes: z.string().nullable(),
    generalNotes: z.string().nullable(),
    recordedAt: isoDateTime(),
  })
  .openapi("MadrassahProgress");

export const MadrassahProgressWithRelationsSchema = MadrassahProgressSchema.extend({
  surah: SurahSchema.nullable(),
  // Deliberately NOT the full Staff shape — listProgressForStudent() selects
  // only these two fields.
  staff: z.object({ firstName: z.string(), lastName: z.string() }),
  term: TermSchema,
}).openapi("MadrassahProgressWithRelations");

// ---------------------------------------------------------------------------
// Timetable
// ---------------------------------------------------------------------------

export const TimeSlotSchema = z
  .object({
    id: id(),
    name: z.string(),
    startTime: z.string().openapi({ description: "HH:mm, no calendar date attached" }),
    endTime: z.string().openapi({ description: "HH:mm" }),
    order: z.number().int(),
  })
  .openapi("TimeSlot");

export const TimetableEntrySchema = z
  .object({
    id: id(),
    classSubjectAssignmentId: id(),
    classId: id(),
    teacherId: id(),
    academicSessionId: id(),
    timeSlotId: id(),
    dayOfWeek: DayOfWeekSchema,
    createdAt: isoDateTime(),
  })
  .openapi("TimetableEntry");

/// GET /api/classes/:id/timetable's shape — includes `teacher` since the
/// class is already known from the URL and the caller needs to know who
/// teaches each slot.
export const TimetableEntryForClassViewSchema = TimetableEntrySchema.extend({
  classSubjectAssignment: ClassSubjectAssignmentSchema.extend({ subject: SubjectSchema }),
  timeSlot: TimeSlotSchema,
  teacher: StaffSchema,
}).openapi("TimetableEntryForClassView");

/// GET /api/staff/:id/timetable's shape — no `teacher` field (the teacher
/// is already known from the URL), but does include `class` since that's
/// what varies entry to entry from this angle.
export const TimetableEntryForStaffViewSchema = TimetableEntrySchema.extend({
  classSubjectAssignment: ClassSubjectAssignmentSchema.extend({ subject: SubjectSchema, class: ClassSchema }),
  timeSlot: TimeSlotSchema,
}).openapi("TimetableEntryForStaffView");

// ---------------------------------------------------------------------------
// Fees & payments (money fields are Int kobo, never Decimal)
// ---------------------------------------------------------------------------

export const FeeStructureSchema = z
  .object({
    id: id(),
    name: z.string(),
    category: FeeCategorySchema,
    classId: id().nullable().openapi({ description: "null = applies to all classes" }),
    academicSessionId: id(),
    termId: id().nullable().openapi({ description: "null = session-wide, not tied to one term" }),
    amountKobo: kobo(),
    isActive: z.boolean(),
    createdAt: isoDateTime(),
  })
  .openapi("FeeStructure");

export const PaymentSchema = z
  .object({
    id: id(),
    feeObligationId: id(),
    amountKobo: kobo(),
    method: PaymentMethodSchema,
    bankReference: z.string().nullable(),
    paymentDate: isoDateTime(),
    status: PaymentStatusSchema,
    recordedByUserId: id(),
    confirmedByUserId: id().nullable(),
    confirmedAt: isoDateTime().nullable(),
    notes: z.string().nullable(),
    createdAt: isoDateTime(),
    updatedAt: isoDateTime(),
  })
  .openapi("Payment");

export const ReceiptSchema = z
  .object({
    id: id(),
    paymentId: id(),
    receiptNumber: z.string(),
    issuedByUserId: id(),
    issuedAt: isoDateTime(),
  })
  .openapi("Receipt");

export const PaymentWithRelationsSchema = PaymentSchema.extend({
  feeObligation: z.object({
    id: id(),
    studentId: id(),
    feeStructureId: id(),
    academicSessionId: id(),
    termId: id().nullable(),
    amountDueKobo: kobo(),
    dueDate: isoDateTime().nullable(),
    status: FeeObligationStatusSchema,
    createdByUserId: id(),
    createdAt: isoDateTime(),
    updatedAt: isoDateTime(),
    feeStructure: FeeStructureSchema,
  }),
  receipt: ReceiptSchema.nullable(),
}).openapi("PaymentWithRelations");

export const FeeObligationSchema = z
  .object({
    id: id(),
    studentId: id(),
    feeStructureId: id(),
    academicSessionId: id(),
    termId: id().nullable(),
    amountDueKobo: kobo(),
    dueDate: isoDateTime().nullable(),
    status: FeeObligationStatusSchema,
    createdByUserId: id(),
    createdAt: isoDateTime(),
    updatedAt: isoDateTime(),
  })
  .openapi("FeeObligation");

/// GET /api/students/:id/fee-obligations's shape — withBalance() in
/// fees.service.ts adds the two computed totals and the CONFIRMED-only
/// payments list; PATCH /fee-obligations/:id returns plain FeeObligationSchema.
export const FeeObligationWithBalanceSchema = FeeObligationSchema.extend({
  feeStructure: FeeStructureSchema,
  payments: z.array(PaymentSchema).openapi({ description: "Only CONFIRMED payments" }),
  totalPaidKobo: kobo(),
  outstandingKobo: kobo(),
}).openapi("FeeObligationWithBalance");

// ---------------------------------------------------------------------------
// Attendance (QR-based)
// ---------------------------------------------------------------------------

export const AttendanceRecordSchema = z
  .object({
    id: id(),
    attendanceSessionId: id(),
    studentId: id(),
    status: AttendanceStatusSchema,
    method: AttendanceMethodSchema,
    scannedAt: isoDateTime().nullable(),
    qrCodeVersionUsed: z.number().int().nullable(),
    recordedByUserId: id(),
    correctedByUserId: id().nullable(),
    correctedAt: isoDateTime().nullable(),
    correctionReason: z.string().nullable(),
    createdAt: isoDateTime(),
  })
  .openapi("AttendanceRecord");

export const AttendanceRecordWithStudentSchema = AttendanceRecordSchema.extend({
  student: StudentSchema,
}).openapi("AttendanceRecordWithStudent");

export const AttendanceSessionSchema = z
  .object({
    id: id(),
    classId: id(),
    academicSessionId: id(),
    termId: id(),
    date: isoDate(),
    status: AttendanceSessionStatusSchema,
    openedByUserId: id(),
    openedAt: isoDateTime(),
    closedAt: isoDateTime().nullable(),
  })
  .openapi("AttendanceSession");

export const AttendanceRecordWithSessionClassSchema = AttendanceRecordSchema.extend({
  attendanceSession: AttendanceSessionSchema.extend({ class: ClassSchema }),
}).openapi("AttendanceRecordWithSessionClass");

/// POST /api/attendance-sessions/:id/close's shape.
export const AttendanceSessionWithRecordsSchema = AttendanceSessionSchema.extend({
  records: z.array(AttendanceRecordSchema),
}).openapi("AttendanceSessionWithRecords");

/// GET /api/classes/:id/attendance's shape — each record additionally
/// carries its student, unlike the close() response above.
export const AttendanceSessionWithRecordsAndStudentSchema = AttendanceSessionSchema.extend({
  records: z.array(AttendanceRecordWithStudentSchema),
}).openapi("AttendanceSessionWithRecordsAndStudent");

export const StudentQrCodeSchema = z
  .object({
    id: id(),
    studentId: id(),
    code: z.string(),
    version: z.number().int(),
    isActive: z.boolean(),
    issuedAt: isoDateTime(),
    revokedAt: isoDateTime().nullable(),
  })
  .openapi("StudentQrCode");

/// POST /api/attendance-sessions/:id/scan's shape. successStatus is 200
/// when the scan hit an already-marked student (no-op re-scan) and 201 on a
/// genuine new record — same body shape either way, so both status codes
/// are registered against this one schema (see routeSpecs.ts).
export const ScanResultSchema = z
  .object({
    record: AttendanceRecordSchema,
    alreadyMarked: z.boolean(),
  })
  .openapi("ScanResult");

// ---------------------------------------------------------------------------
// Admissions / enquiries
// ---------------------------------------------------------------------------

export const AdmissionEnquirySchema = z
  .object({
    id: id(),
    prospectiveFirstName: z.string(),
    prospectiveLastName: z.string(),
    dateOfBirth: isoDateTime().nullable(),
    desiredClassId: id().nullable(),
    parentFullName: z.string(),
    parentPhone: z.string(),
    parentEmail: z.string().nullable(),
    message: z.string().nullable(),
    status: EnquiryStatusSchema,
    enquiryDate: isoDateTime(),
    source: z.string().nullable(),
    handledByUserId: id().nullable(),
    convertedStudentId: id().nullable(),
    notes: z.string().nullable(),
    createdAt: isoDateTime(),
    updatedAt: isoDateTime(),
  })
  .openapi("AdmissionEnquiry");

/// POST /api/admission-enquiries/:id/convert's shape.
export const ConvertEnquiryResultSchema = z
  .object({
    student: StudentSchema,
    enquiry: AdmissionEnquirySchema,
  })
  .openapi("ConvertEnquiryResult");

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const NotificationEventSchema = z
  .object({
    id: id(),
    type: NotificationTypeSchema,
    recipientUserId: id(),
    subject: z.string(),
    body: z.string(),
    relatedEntityType: z.string().nullable(),
    relatedEntityId: z.string().nullable(),
    createdAt: isoDateTime(),
  })
  .openapi("NotificationEvent");

export const NotificationDeliverySchema = z
  .object({
    id: id(),
    notificationEventId: id(),
    channel: NotificationChannelSchema,
    status: NotificationDeliveryStatusSchema,
    providerName: z.string().nullable(),
    providerMessageId: z.string().nullable(),
    error: z.string().nullable(),
    attemptedAt: isoDateTime().nullable(),
    deliveredAt: isoDateTime().nullable(),
    createdAt: isoDateTime(),
  })
  .openapi("NotificationDelivery");

export const NotificationEventWithDeliveriesSchema = NotificationEventSchema.extend({
  deliveries: z.array(NotificationDeliverySchema),
}).openapi("NotificationEventWithDeliveries");

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const AuditLogSchema = z
  .object({
    id: id(),
    actorUserId: id().nullable(),
    actorRoles: z.array(RoleSchema),
    action: z.string(),
    entityType: z.string(),
    entityId: z.string(),
    beforeData: z.unknown().nullable(),
    afterData: z.unknown().nullable(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: isoDateTime(),
  })
  .openapi("AuditLog");

// ---------------------------------------------------------------------------
// Auth — hand-shaped, not a Prisma model
// ---------------------------------------------------------------------------

export const AuthTokensSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
  })
  .openapi("AuthTokens");

/// GET /api/auth/me's shape.
export const PrincipalSchema = z
  .object({
    userId: id(),
    roles: z.array(RoleSchema),
    staffId: id().nullable(),
    parentId: id().nullable(),
    studentId: id().nullable(),
  })
  .openapi("Principal");

export const MeResponseSchema = z.object({ principal: PrincipalSchema }).openapi("MeResponse");

// Registering every schema with the shared registry happens implicitly via
// `.openapi("Name")` above (that's what names+registers a schema in this
// library — see zod-to-openapi's README, "Defining schemas"). This
// re-export exists only so route registration files can trigger this
// module's evaluation (and therefore every registration) via a single
// import, without needing to import each schema individually just for the
// side effect.
export const _resourceSchemasRegistered = registry;
