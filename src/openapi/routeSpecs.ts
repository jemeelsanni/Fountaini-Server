import type { RouteParameter } from "@asteasolutions/zod-to-openapi/dist/openapi-registry.js";
import type { ZodTypeAny } from "zod";
import { z } from "zod";
import "./zodSetup.js";
import { createAcademicSessionSchema, createClassFormTeacherSchema, createClassSchema, createClassSubjectAssignmentSchema, createSubjectSchema, createTermSchema, idParamsSchema as academicStructureIdParamsSchema, listClassStudentsQuerySchema } from "../modules/academic-structure/academic-structure.schemas.js";
import { convertEnquirySchema, createEnquirySchema, idParamsSchema as admissionsIdParamsSchema, listEnquiriesQuerySchema, updateEnquirySchema } from "../modules/admissions/admissions.schemas.js";
import {
  changePasswordSchema,
  loginSchema,
  refreshSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
} from "../modules/auth/auth.schemas.js";
import { classAttendanceQuerySchema, correctAttendanceSchema, idParamsSchema as attendanceIdParamsSchema, openSessionSchema, scanSchema } from "../modules/attendance/attendance.schemas.js";
import { listAuditLogQuerySchema } from "../modules/audit/audit.schemas.js";
import { createFeeStructureSchema, idParamsSchema as feesIdParamsSchema, listPaymentsQuerySchema, recordPaymentSchema, updateFeeObligationSchema, updateFeeStructureSchema } from "../modules/fees/fees.schemas.js";
import { createAssessmentComponentSchema, createGradeBandSchema, createGradingScaleSchema, idParamsSchema as gradingIdParamsSchema, updateAssessmentComponentSchema, updateGradeBandSchema } from "../modules/grading/grading.schemas.js";
import { createProgressSchema, idParamsSchema as madrassahIdParamsSchema } from "../modules/madrassah/madrassah.schemas.js";
import {
  idParamsSchema as notificationsIdParamsSchema,
  triggerFeeRemindersSchema,
} from "../modules/notifications/notifications.schemas.js";
import { createParentSchema, idParamsSchema as parentsIdParamsSchema, linkChildSchema, parentChildParamsSchema, updateParentSchema } from "../modules/parents/parents.schemas.js";
import {
  bulkUpsertRatingsSchema,
  classTermParamsSchema as ratingsClassTermParamsSchema,
  createTraitSchema,
  idParamsSchema as ratingsIdParamsSchema,
} from "../modules/ratings/ratings.schemas.js";
import {
  classTermParamsSchema,
  computeResultsSchema,
  computeSessionResultsSchema,
  idParamsSchema as resultsIdParamsSchema,
  listResultsForStudentQuerySchema,
  overrideResultSchema,
  releaseWithholdingSchema,
  studentSessionParamsSchema,
  studentTermParamsSchema,
  writeCommentSchema,
} from "../modules/results/results.schemas.js";
import { createSchoolSchema, updateSchoolSchema } from "../modules/school/school.schemas.js";
import { bulkUpsertScoresSchema, idParamsSchema as scoresIdParamsSchema, scoresForAssignmentQuerySchema, submitScoresSchema } from "../modules/scores/scores.schemas.js";
import { createStaffSchema, idParamsSchema as staffIdParamsSchema, updateStaffSchema } from "../modules/staff/staff.schemas.js";
import { bulkUpdateStudentStatusSchema, createEnrollmentSchema, createStudentSchema, idParamsSchema as studentsIdParamsSchema, transferStudentSchema, updateStudentSchema } from "../modules/students/students.schemas.js";
import { createTimeSlotSchema, createTimetableEntrySchema, idParamsSchema as timetableIdParamsSchema } from "../modules/timetable/timetable.schemas.js";
import { createUserSchema, userIdParamsSchema } from "../modules/users/users.schemas.js";
import {
  AcademicSessionSchema,
  AdmissionEnquirySchema,
  AssessmentComponentSchema,
  AttendanceRecordSchema,
  AttendanceRecordWithSessionClassSchema,
  AttendanceSessionSchema,
  AttendanceSessionWithRecordsAndStudentSchema,
  AttendanceSessionWithRecordsSchema,
  AuditLogSchema,
  AuthTokensSchema,
  ClassFormTeacherSchema,
  ClassFormTeacherWithRelationsSchema,
  ClassSchema,
  ClassSubjectAssignmentSchema,
  ClassSubjectAssignmentWithRelationsSchema,
  ConvertEnquiryResultSchema,
  BulkStudentStatusResultSchema,
  EnrollmentSchema,
  EnrollmentWithRelationsSchema,
  EnrollmentWithStudentSchema,
  FeeObligationSchema,
  FeeObligationWithBalanceSchema,
  FeeStructureSchema,
  GradeBandSchema,
  GradingScaleSchema,
  GradingScaleWithBandsSchema,
  MadrassahProgressSchema,
  MadrassahProgressWithRelationsSchema,
  MarkAllNotificationsReadResultSchema,
  MeResponseSchema,
  NotificationEventSchema,
  NotificationEventWithDeliveriesSchema,
  ParentSchema,
  PaymentQueueResponseSchema,
  PaymentSchema,
  PaymentWithRelationsSchema,
  RatingScaleLevelSchema,
  RatingWithTraitSchema,
  ReceiptSchema,
  ResultListItemSchema,
  ResultSchema,
  ResultWithRatingsSchema,
  ResultWithStudentSchema,
  ScanResultSchema,
  SchoolSchema,
  ScoreSchema,
  ScoreSheetSchema,
  SessionResultWithSubjectAveragesSchema,
  StaffSchema,
  StaffWithUserSchema,
  StudentParentSchema,
  StudentParentWithParentSchema,
  StudentParentWithStudentSchema,
  StudentQrCodeSchema,
  StudentSchema,
  StudentWithOptionalTemporaryPasswordSchema,
  SubjectResultSchema,
  SubjectResultWithRelationsSchema,
  SubjectSchema,
  SurahSchema,
  TermSchema,
  TraitSchema,
  TimeSlotSchema,
  TimetableEntryForClassViewSchema,
  TimetableEntryForStaffViewSchema,
  TimetableEntrySchema,
  UserSummarySchema,
} from "./resourceSchemas.js";

export interface ResponseSpec {
  description: string;
  schema?: ZodTypeAny;
}

export interface RouteSpec {
  summary: string;
  requestBody?: ZodTypeAny;
  requestQuery?: RouteParameter;
  requestParams?: RouteParameter;
  /// Keyed by HTTP status code.
  responses: Record<number, ResponseSpec>;
  /// Hand-written only for routes a requireScope resolver narrows beyond
  /// what the role tag alone says (or, for scope-only routes with no role
  /// tag at all, beyond "any authenticated role") — e.g. "the assigned
  /// teacher, or ADMIN" is more useful than the bare role list "TEACHER,
  /// ADMIN", which doesn't capture that an unassigned teacher is denied.
  /// generateSpec.ts appends this to the operation description it builds
  /// mechanically from route.allowedRoles; nothing here duplicates the role
  /// list itself; see that file's buildAccessDescription().
  scopeNote?: string;
}

const noContent: ResponseSpec = { description: "No Content" };

// Small ad-hoc query schemas for the handful of routes that read req.query
// directly without a validate({query}) schema (see academic-structure/fees
// controllers) — documented here for spec completeness without inventing
// validation the routes don't actually perform.
const classSubjectAssignmentsQuerySchema = z.object({
  teacherId: z.string().optional(),
  classId: z.string().optional(),
});
const classFormTeachersQuerySchema = z.object({
  teacherId: z.string().optional(),
  classId: z.string().optional(),
});
const feeStructuresQuerySchema = z.object({
  academicSessionId: z.string().optional(),
});

// Reused verbatim across every route gated by the same resolver — one
// string per resolver, not one per route, so the wording can't drift
// between two routes that are actually governed by the identical check.
const SCOPE_NOTES = {
  canReadStudent:
    "ADMIN, the student's linked parent, the student themself, or a teacher currently assigned to their class.",
  canReadStudentFinancials: "ADMIN, BURSAR, the student's linked parent, or the student themself.",
  canManageStudentQrCode: "ADMIN, or the student themself, acting on their own code.",
  canReadParent: "ADMIN, or that parent themself.",
  canReadStudentParents:
    "ADMIN, the student's assigned teacher, or the student themself — not a linked parent.",
  canReadClassResults: "ADMIN, or that class's form teacher — not a subject teacher assigned to the class.",
  canActOnAssignment: "ADMIN, or the teacher assigned to this specific class-subject assignment.",
  canReadStaff: "ADMIN, or that staff member themself.",
  canReadClassTimetable:
    "Any TEACHER (assigned or not — timetable data isn't treated as sensitive) or ADMIN; a STUDENT or " +
    "linked PARENT scoped to a class they, or their child, are actually and currently enrolled in.",
  canManageOwnNotification: "ADMIN, or the notification's own recipient.",
  canWriteClassRatings: "ADMIN, or that class's form teacher — not a subject teacher assigned to the class.",
  canReadClassRoster:
    "ADMIN, BURSAR, or a TEACHER assigned to teach some subject in this class for the resolved session — " +
    "not any teacher unconditionally (unlike GET /api/classes/:id/timetable's own rule), and not the " +
    "form teacher specifically (unlike GET /api/classes/:id/results/:termId's).",
  canCreatePaymentForObligation:
    "ADMIN, BURSAR, or the obligation's own linked parent — never the student themself, unlike most " +
    "other fee-read scopes.",
} as const;

/// One entry per route in the live route inventory ("METHOD /path", exactly
/// as buildRouteInventory()/the auth matrix key it) — openapi.test.ts
/// asserts every inventory route has an entry here, so a new route without
/// one fails the build the same way an unguarded one does.
export const ROUTE_SPECS: Record<string, RouteSpec> = {
  // --- academic-structure --------------------------------------------------
  "POST /api/academic-sessions": {
    summary: "Create an academic session",
    requestBody: createAcademicSessionSchema,
    responses: { 201: { description: "Created", schema: AcademicSessionSchema } },
  },
  "GET /api/academic-sessions": {
    summary: "List academic sessions",
    responses: { 200: { description: "OK", schema: z.array(AcademicSessionSchema) } },
  },
  "PATCH /api/academic-sessions/:id/set-current": {
    summary: "Mark an academic session as current, clearing any other current session",
    requestParams: academicStructureIdParamsSchema,
    responses: { 200: { description: "OK", schema: AcademicSessionSchema } },
  },
  "POST /api/academic-sessions/:id/terms": {
    summary: "Create a term within an academic session",
    requestParams: academicStructureIdParamsSchema,
    requestBody: createTermSchema,
    responses: { 201: { description: "Created", schema: TermSchema } },
  },
  "GET /api/academic-sessions/:id/terms": {
    summary: "List terms for an academic session",
    requestParams: academicStructureIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(TermSchema) } },
  },
  "PATCH /api/terms/:id/set-current": {
    summary: "Mark a term as current within its academic session",
    requestParams: academicStructureIdParamsSchema,
    responses: { 200: { description: "OK", schema: TermSchema } },
  },
  "POST /api/classes": {
    summary: "Create a class",
    requestBody: createClassSchema,
    responses: { 201: { description: "Created", schema: ClassSchema } },
  },
  "GET /api/classes": {
    summary: "List classes",
    responses: { 200: { description: "OK", schema: z.array(ClassSchema) } },
  },
  "GET /api/classes/:id/students": {
    summary:
      "List students actively enrolled in a class. Defaults to the current academic session when " +
      "academicSessionId is omitted. Returns { student, enrollment }[] rather than bare students — the " +
      "enrollment carries the join date and status. Not readable by PARENT or STUDENT: a parent seeing " +
      "every child in their child's class is a privacy decision nobody has made.",
    requestParams: academicStructureIdParamsSchema,
    requestQuery: listClassStudentsQuerySchema,
    responses: { 200: { description: "OK", schema: z.array(EnrollmentWithStudentSchema) } },
    scopeNote: SCOPE_NOTES.canReadClassRoster,
  },
  "POST /api/subjects": {
    summary: "Create a subject",
    requestBody: createSubjectSchema,
    responses: { 201: { description: "Created", schema: SubjectSchema } },
  },
  "GET /api/subjects": {
    summary: "List subjects",
    responses: { 200: { description: "OK", schema: z.array(SubjectSchema) } },
  },
  "POST /api/class-subject-assignments": {
    summary: "Assign a teacher to a class/subject for an academic session",
    requestBody: createClassSubjectAssignmentSchema,
    responses: { 201: { description: "Created", schema: ClassSubjectAssignmentSchema } },
  },
  "GET /api/class-subject-assignments": {
    summary: "List class-subject-teacher assignments (a TEACHER caller is always scoped to their own, regardless of the query params)",
    requestQuery: classSubjectAssignmentsQuerySchema,
    responses: { 200: { description: "OK", schema: z.array(ClassSubjectAssignmentWithRelationsSchema) } },
  },
  "DELETE /api/class-subject-assignments/:id": {
    summary:
      "Remove a class-subject-teacher assignment. Its timetable entries are removed along with it " +
      "(pure scheduling data, recreated in seconds). Recorded scores or computed subject results block " +
      "the whole operation with 409 instead — those are a teacher's work and are never deleted as a " +
      "side effect of this route.",
    requestParams: academicStructureIdParamsSchema,
    responses: { 204: noContent },
  },
  "POST /api/class-form-teachers": {
    summary: "Designate a class's form/class teacher for an academic session",
    requestBody: createClassFormTeacherSchema,
    responses: { 201: { description: "Created", schema: ClassFormTeacherSchema } },
  },
  "GET /api/class-form-teachers": {
    summary: "List form-teacher assignments (a TEACHER caller is always scoped to their own, regardless of the query params)",
    requestQuery: classFormTeachersQuerySchema,
    responses: { 200: { description: "OK", schema: z.array(ClassFormTeacherWithRelationsSchema) } },
  },
  "DELETE /api/class-form-teachers/:id": {
    summary: "Remove a form-teacher assignment",
    requestParams: academicStructureIdParamsSchema,
    responses: { 204: noContent },
  },

  // --- admissions -----------------------------------------------------------
  "POST /api/admission-enquiries": {
    summary: "Submit an admission enquiry (public)",
    requestBody: createEnquirySchema,
    responses: { 201: { description: "Created", schema: AdmissionEnquirySchema } },
  },
  "GET /api/admission-enquiries": {
    summary: "List admission enquiries",
    requestQuery: listEnquiriesQuerySchema,
    responses: { 200: { description: "OK", schema: z.array(AdmissionEnquirySchema) } },
  },
  "GET /api/admission-enquiries/:id": {
    summary: "Get one admission enquiry",
    requestParams: admissionsIdParamsSchema,
    responses: { 200: { description: "OK", schema: AdmissionEnquirySchema } },
  },
  "PATCH /api/admission-enquiries/:id": {
    summary: "Update an admission enquiry's status/notes",
    requestParams: admissionsIdParamsSchema,
    requestBody: updateEnquirySchema,
    responses: { 200: { description: "OK", schema: AdmissionEnquirySchema } },
  },
  "POST /api/admission-enquiries/:id/convert": {
    summary: "Convert an enquiry into an enrolled Student record",
    requestParams: admissionsIdParamsSchema,
    requestBody: convertEnquirySchema,
    responses: { 201: { description: "Created", schema: ConvertEnquiryResultSchema } },
  },

  // --- attendance -------------------------------------------------------------
  "POST /api/attendance-sessions": {
    summary: "Open an attendance session for a class",
    requestBody: openSessionSchema,
    responses: { 201: { description: "Created", schema: AttendanceSessionSchema } },
  },
  "POST /api/attendance-sessions/:id/scan": {
    summary: "Scan a student's QR code into an open attendance session",
    requestParams: attendanceIdParamsSchema,
    requestBody: scanSchema,
    responses: {
      200: { description: "Already marked — re-scan of a student already recorded this session", schema: ScanResultSchema },
      201: { description: "Created — new attendance record", schema: ScanResultSchema },
    },
  },
  "POST /api/attendance-sessions/:id/close": {
    summary: "Close an attendance session, marking every un-scanned enrolled student ABSENT",
    requestParams: attendanceIdParamsSchema,
    responses: { 200: { description: "OK", schema: AttendanceSessionWithRecordsSchema } },
  },
  "PATCH /api/attendance-records/:id": {
    summary: "Manually correct an attendance record",
    requestParams: attendanceIdParamsSchema,
    requestBody: correctAttendanceSchema,
    responses: { 200: { description: "OK", schema: AttendanceRecordSchema } },
  },
  "GET /api/students/:id/attendance": {
    summary: "Get a student's attendance history",
    requestParams: attendanceIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(AttendanceRecordWithSessionClassSchema) } },
    scopeNote: SCOPE_NOTES.canReadStudent,
  },
  "GET /api/classes/:id/attendance": {
    summary: "List a class's attendance sessions (optionally filtered to one date)",
    requestParams: attendanceIdParamsSchema,
    requestQuery: classAttendanceQuerySchema,
    responses: { 200: { description: "OK", schema: z.array(AttendanceSessionWithRecordsAndStudentSchema) } },
  },
  "POST /api/students/:id/qr-code/rotate": {
    summary: "Issue a new active QR code for a student, deactivating any previous one",
    requestParams: attendanceIdParamsSchema,
    responses: { 201: { description: "Created", schema: StudentQrCodeSchema } },
    scopeNote: SCOPE_NOTES.canManageStudentQrCode,
  },
  "GET /api/students/:id/qr-code": {
    summary: "Get a student's current active QR code",
    requestParams: attendanceIdParamsSchema,
    responses: { 200: { description: "OK", schema: StudentQrCodeSchema } },
    scopeNote: SCOPE_NOTES.canManageStudentQrCode,
  },

  // --- audit ------------------------------------------------------------------
  "GET /api/audit-log": {
    summary:
      "List audit log entries. beforeData is populated only for actions whose route opted into " +
      "auditMutation()'s fetchBefore (a pre-mutation read of the entity, keyed by req.params.id) — " +
      "everything else still gets afterData only (a snapshot of the route's own response body), same " +
      "as before fetchBefore existed. It's opt-in, not automatic from entityType, because the entity " +
      "isn't always knowable from the route before the handler runs: a bulk-mutation route has no " +
      "single row's id to key on, and a nested-collection create has :id naming the parent, not the " +
      "(not-yet-existing) thing being created — see RESULT_RANKED below for a route that structurally " +
      "can't use it. A throwing fetchBefore never fails the mutation it documents: caught and logged, " +
      "beforeData just comes back null for that row. For entityType \"Result\", all six mutation " +
      "actions are audited equally — RESULT_FINALIZED, RESULT_RANKED, RESULT_OVERRIDDEN, " +
      "RESULT_WITHHOLDING_RELEASED, CLASS_TEACHER_COMMENT_WRITTEN, PRINCIPAL_COMMENT_WRITTEN — none is " +
      "skipped, and every one carries afterData shaped as a single updated Result row, keyed by that " +
      "Result's own id. RESULT_FINALIZED and RESULT_WITHHOLDING_RELEASED carry a real beforeData " +
      "snapshot (fetchBefore wired on their routes); CLASS_TEACHER_COMMENT_WRITTEN and " +
      "PRINCIPAL_COMMENT_WRITTEN don't (not wired — a routine, low-stakes edit while the result is " +
      "still DRAFT). RESULT_OVERRIDDEN deliberately has none either: it already has a more precise " +
      "before/after pair in the dedicated ResultOverride table (fieldName/oldValue/newValue/reason, " +
      "queryable by resultId) — a second, vaguer copy here would only be worse than none. " +
      "RESULT_RANKED is written explicitly by rankClassResults() rather than the generic middleware " +
      "(its route, POST /api/classes/:id/results/:termId/rank, has no single Result id of its own to " +
      "key on): one audit row per Result the ranking pass actually updated, never one row for the " +
      "whole class — most of a class's Results (still DRAFT, or FINALIZED with no submitted subject) " +
      "are untouched by ranking and get no row. Its beforeData (each Result's prior position/outOf) " +
      "comes free as a side effect of the ranking pass itself, which already has to read those values " +
      "to compute the new ones — no extra query spent capturing it, unlike every fetchBefore-wired " +
      "route above. Outside \"Result\": USER_ACTIVATED, USER_DEACTIVATED, PAYMENT_CONFIRMED, " +
      "PAYMENT_REJECTED, FEE_STRUCTURE_UPDATED, FEE_STRUCTURE_DELETED, FEE_OBLIGATION_UPDATED, " +
      "ACADEMIC_SESSION_SET_CURRENT and TERM_SET_CURRENT all carry real beforeData too; every create " +
      "action (nothing existed before it) and every other route not listed here still has none.",
    requestQuery: listAuditLogQuerySchema,
    responses: { 200: { description: "OK", schema: z.array(AuditLogSchema) } },
  },

  // --- auth ---------------------------------------------------------------
  "POST /api/auth/login": {
    summary:
      "BREAKING CHANGE — log in with `identifier` + password (public), not `email` + password. " +
      "`identifier` is whatever this account actually signs in with: an admission number for a " +
      "student, a staff number for staff, or an email for anyone else (a parent, or a bare account " +
      "with no linked record) — resolved by a single lookup, never branched by role. There is no " +
      "backwards-compatible `email` fallback; this is a clean break, not a union of the two shapes.",
    requestBody: loginSchema,
    responses: { 200: { description: "OK", schema: AuthTokensSchema } },
  },
  "POST /api/auth/refresh": {
    summary: "Exchange a refresh token for a new access/refresh token pair (public)",
    requestBody: refreshSchema,
    responses: { 200: { description: "OK", schema: AuthTokensSchema } },
  },
  "POST /api/auth/logout": {
    summary: "Revoke a refresh token (public)",
    requestBody: refreshSchema,
    responses: { 204: noContent },
  },
  "GET /api/auth/me": {
    summary: "Get the authenticated caller's own principal",
    responses: { 200: { description: "OK", schema: MeResponseSchema } },
  },
  "POST /api/auth/change-password": {
    summary: "Change the authenticated caller's own password, revoking existing sessions",
    requestBody: changePasswordSchema,
    responses: { 204: noContent },
  },
  "POST /api/auth/forgot-password": {
    summary:
      "BREAKING CHANGE — takes `identifier` (a loginId or an email), not `email`. Always responds " +
      "204 regardless of whether the identifier belongs to an account, has an email to send to, or " +
      "neither — the response never reveals which case it was. Destination: the account's own " +
      "email if set; otherwise, for a student, their primary-contact (or earliest-linked) parent's " +
      "email; otherwise nothing is sent. This matters more than it did for a bare email lookup: " +
      "admission numbers are sequential and trivially enumerable, so this endpoint's generic " +
      "response and its rate limit are load-bearing, not belt-and-braces.",
    requestBody: requestPasswordResetSchema,
    responses: { 204: noContent },
  },
  "POST /api/auth/reset-password": {
    summary:
      "Complete a password reset using the token emailed by the forgot-password request (public). " +
      "Single-use, short-lived, and revokes every existing refresh token for the account on success.",
    requestBody: resetPasswordSchema,
    responses: { 204: noContent },
  },

  // --- fees -----------------------------------------------------------------
  "POST /api/fee-structures": {
    summary:
      "Create a fee structure. Targets exactly one of classId (a specific class), gradeName (every " +
      "class at that grade level, e.g. \"JSS1\" — resolved fresh each time obligations are generated, " +
      "not baked in here, so a class added later is still covered), or neither (school-wide). 400 if " +
      "both classId and gradeName are set.",
    requestBody: createFeeStructureSchema,
    responses: { 201: { description: "Created", schema: FeeStructureSchema } },
  },
  "GET /api/fee-structures": {
    summary: "List fee structures",
    requestQuery: feeStructuresQuerySchema,
    responses: { 200: { description: "OK", schema: z.array(FeeStructureSchema) } },
  },
  "PATCH /api/fee-structures/:id": {
    summary:
      "Edit a fee structure's name, amount, or targeting (classId/gradeName — see the create route's " +
      "own summary for the targeting rules; 400 if the edit would leave both set, whether both are set " +
      "in this same request or one is set here and the other is already on the row from before). " +
      "Never retroactively alters obligations already generated from it — only the next " +
      "generate-obligations run sees the new amount or targeting.",
    requestParams: feesIdParamsSchema,
    requestBody: updateFeeStructureSchema,
    responses: { 200: { description: "OK", schema: FeeStructureSchema } },
  },
  "DELETE /api/fee-structures/:id": {
    summary:
      "Delete a fee structure. Refuses (409) if it already has generated obligations — deleting it would " +
      "orphan the payment records against them.",
    requestParams: feesIdParamsSchema,
    responses: { 204: noContent },
  },
  "POST /api/fee-structures/:id/generate-obligations": {
    summary:
      "Generate a fee obligation for every actively-enrolled student matching this fee structure's " +
      "scope — a specific class, every class at a grade level, or school-wide (see " +
      "POST /api/fee-structures). Targeting is resolved fresh on every call against the live Class " +
      "table, not fixed at the structure's creation time — a class added to a targeted grade level " +
      "after the structure existed is still covered the next time this runs.",
    requestParams: feesIdParamsSchema,
    responses: { 201: { description: "Created", schema: z.array(FeeObligationSchema) } },
  },
  "GET /api/students/:id/fee-obligations": {
    summary: "List a student's fee obligations, with computed paid/outstanding balances",
    requestParams: feesIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(FeeObligationWithBalanceSchema) } },
    scopeNote: SCOPE_NOTES.canReadStudentFinancials,
  },
  "GET /api/fee-obligations/:id": {
    summary: "Get one fee obligation, with computed paid/outstanding balances",
    requestParams: feesIdParamsSchema,
    responses: { 200: { description: "OK", schema: FeeObligationWithBalanceSchema } },
    scopeNote: SCOPE_NOTES.canReadStudentFinancials,
  },
  "PATCH /api/fee-obligations/:id": {
    summary: "Update a fee obligation",
    requestParams: feesIdParamsSchema,
    requestBody: updateFeeObligationSchema,
    responses: { 200: { description: "OK", schema: FeeObligationSchema } },
  },
  "POST /api/fee-obligations/:id/payments": {
    summary:
      "Record a payment claim against a fee obligation. Always created PENDING regardless of caller — " +
      "a parent-logged payment is a claim, not a fact, and only ADMIN/BURSAR can confirm or reject one " +
      "(see those routes below). A non-ADMIN/BURSAR caller is blocked with 409 if they already have a " +
      "PENDING claim on this same obligation.",
    requestParams: feesIdParamsSchema,
    requestBody: recordPaymentSchema,
    responses: { 201: { description: "Created", schema: PaymentSchema } },
    scopeNote: SCOPE_NOTES.canCreatePaymentForObligation,
  },
  "POST /api/payments/:id/confirm": {
    summary: "Confirm a pending payment",
    requestParams: feesIdParamsSchema,
    responses: { 200: { description: "OK", schema: PaymentSchema } },
  },
  "POST /api/payments/:id/reject": {
    summary: "Reject a pending payment",
    requestParams: feesIdParamsSchema,
    responses: { 200: { description: "OK", schema: PaymentSchema } },
  },
  "GET /api/payments/:id/receipt": {
    summary: "Get the receipt for a confirmed payment",
    requestParams: feesIdParamsSchema,
    responses: { 200: { description: "OK", schema: ReceiptSchema } },
    scopeNote: SCOPE_NOTES.canReadStudentFinancials,
  },
  "GET /api/students/:id/payments": {
    summary: "List a student's payments",
    requestParams: feesIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(PaymentWithRelationsSchema) } },
    scopeNote: SCOPE_NOTES.canReadStudentFinancials,
  },
  "GET /api/payments": {
    summary:
      "The bursar's payment queue — paginated, newest first. Defaults to PENDING (the work queue) when " +
      "status is omitted; pass status explicitly to see confirmed or rejected payments instead. " +
      "classId filters via the student's current ACTIVE enrollment in that class.",
    requestQuery: listPaymentsQuerySchema,
    responses: { 200: { description: "OK", schema: PaymentQueueResponseSchema } },
  },

  // --- grading ----------------------------------------------------------------
  "POST /api/academic-sessions/:id/assessment-components": {
    summary: "Create an assessment component (e.g. CA1, Exam) for an academic session",
    requestParams: gradingIdParamsSchema,
    requestBody: createAssessmentComponentSchema,
    responses: { 201: { description: "Created", schema: AssessmentComponentSchema } },
  },
  "GET /api/academic-sessions/:id/assessment-components": {
    summary: "List assessment components for an academic session",
    requestParams: gradingIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(AssessmentComponentSchema) } },
  },
  "PATCH /api/assessment-components/:id": {
    summary:
      "Partially update an assessment component. Every field is optional; an absent field is left " +
      "untouched. If maxScore changes and the session's components no longer sum to 100, the response " +
      "carries an extra `warning` string rather than rejecting the edit — scores.service.ts's " +
      "submitScores sums raw scores across every component and compares that total directly against " +
      "grade bands calibrated for 0-100, so a non-100 total silently produces an out-of-scale grade on " +
      "the next submit. Editing a component after results have already been computed from it also " +
      "leaves those results stale until someone recomputes: FINALIZED results are immutable and won't " +
      "pick up the edit at all, so a mid-term edit can leave a class with some report cards built from " +
      "the old component set and some from the new. Recomputing affected classes is a manual admin " +
      "follow-up this endpoint does not perform.",
    requestParams: gradingIdParamsSchema,
    requestBody: updateAssessmentComponentSchema,
    responses: { 200: { description: "OK", schema: AssessmentComponentSchema } },
  },
  "DELETE /api/assessment-components/:id": {
    summary:
      "Delete an assessment component. 409 if any score has been recorded against it — unlike a " +
      "class-subject assignment's timetable entries, a score is a teacher's recorded work and is never " +
      "deleted as a side effect.",
    requestParams: gradingIdParamsSchema,
    responses: { 204: noContent },
  },
  "POST /api/academic-sessions/:id/grading-scale": {
    summary:
      "Create the grading scale for an academic session, optionally choosing how SessionResult figures " +
      "are derived (sessionAverageMethod — defaults to SESSION_AVERAGE if omitted)",
    requestParams: gradingIdParamsSchema,
    requestBody: createGradingScaleSchema,
    responses: { 201: { description: "Created", schema: GradingScaleSchema } },
  },
  "GET /api/academic-sessions/:id/grading-scale": {
    summary: "Get an academic session's grading scale with its grade bands",
    requestParams: gradingIdParamsSchema,
    responses: { 200: { description: "OK", schema: GradingScaleWithBandsSchema } },
  },
  "POST /api/grading-scales/:id/bands": {
    summary:
      "Add a grade band to a grading scale. 400 if its range overlaps an existing band on the same " +
      "scale. Gaps between bands (e.g. 0-39 and 50-100, leaving 40-49 ungraded) are allowed, not " +
      "rejected — a score landing in one is handled gracefully at grading time (grade: null on that " +
      "student's report card), not an error. Since it can't be blocked without breaking the ordinary " +
      "one-band-at-a-time setup workflow, the response instead carries a `warning` string whenever the " +
      "scale's bands (including this one) leave any part of 0-100 uncovered.",
    requestParams: gradingIdParamsSchema,
    requestBody: createGradeBandSchema,
    responses: { 201: { description: "Created", schema: GradeBandSchema } },
  },
  "PATCH /api/grade-bands/:id": {
    summary:
      "Partially update a grade band. Every field is optional; an absent field is left untouched, an " +
      "explicit null clears remark or gradePoint. 400 if the resulting range (merged with whatever " +
      "wasn't changed) is invalid or overlaps another band on the same scale — the same check " +
      "POST /api/grading-scales/:id/bands applies on create. Same gap handling too: the response " +
      "carries a `warning` string, never a rejection, whenever the scale's bands leave part of 0-100 " +
      "uncovered after this edit.",
    requestParams: gradingIdParamsSchema,
    requestBody: updateGradeBandSchema,
    responses: { 200: { description: "OK", schema: GradeBandSchema } },
  },
  "DELETE /api/grade-bands/:id": {
    summary: "Delete a grade band",
    requestParams: gradingIdParamsSchema,
    responses: { 204: noContent },
  },

  // --- madrassah --------------------------------------------------------------
  "POST /api/madrassah-progress": {
    summary: "Record a Qur'an/Madrassah progress entry for a student",
    requestBody: createProgressSchema,
    responses: { 201: { description: "Created", schema: MadrassahProgressSchema } },
  },
  "GET /api/students/:id/madrassah-progress": {
    summary: "List a student's Qur'an/Madrassah progress entries",
    requestParams: madrassahIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(MadrassahProgressWithRelationsSchema) } },
    scopeNote: SCOPE_NOTES.canReadStudent,
  },
  "GET /api/surahs": {
    summary: "List the 114 surahs (static reference data)",
    responses: { 200: { description: "OK", schema: z.array(SurahSchema) } },
  },

  // --- notifications ------------------------------------------------------------
  "GET /api/notifications": {
    summary: "List the authenticated caller's own notifications, with delivery attempts",
    responses: { 200: { description: "OK", schema: z.array(NotificationEventWithDeliveriesSchema) } },
  },
  "PATCH /api/notifications/:id/read": {
    summary:
      "Mark one of the caller's own notifications as read. Idempotent — marking an already-read " +
      "notification again is still a 200, and its original readAt is preserved.",
    requestParams: notificationsIdParamsSchema,
    responses: { 200: { description: "OK", schema: NotificationEventSchema } },
    scopeNote: SCOPE_NOTES.canManageOwnNotification,
  },
  "POST /api/notifications/read-all": {
    summary: "Mark every one of the caller's own currently-unread notifications as read",
    responses: { 200: { description: "OK", schema: MarkAllNotificationsReadResultSchema } },
  },
  "POST /api/notifications/fee-reminders/trigger": {
    summary: "Trigger fee-reminder notifications for every student with an outstanding balance",
    requestBody: triggerFeeRemindersSchema,
    responses: { 200: { description: "OK", schema: z.array(NotificationEventSchema) } },
  },

  // --- parents --------------------------------------------------------------
  "GET /api/parents/me/children": {
    summary: "List the authenticated parent's own linked children",
    responses: { 200: { description: "OK", schema: z.array(StudentParentWithStudentSchema) } },
  },
  "POST /api/parents": {
    summary:
      "Atomic: creates the User (loginId = email, generated password, mustChangePassword: " +
      "true, PARENT role) and the Parent profile together, in one transaction. Credentials are " +
      "emailed to `email`. No more `userId` input — POST /api/users no longer accepts PARENT " +
      "(see its own summary).",
    requestBody: createParentSchema,
    responses: { 201: { description: "Created", schema: ParentSchema } },
  },
  "GET /api/parents": {
    summary: "List parents",
    responses: { 200: { description: "OK", schema: z.array(ParentSchema) } },
  },
  "GET /api/parents/:id": {
    summary: "Get one parent",
    requestParams: parentsIdParamsSchema,
    responses: { 200: { description: "OK", schema: ParentSchema } },
  },
  "PATCH /api/parents/:id": {
    summary:
      "Partially update a parent's profile: firstName, lastName, phone, alternatePhone, address. An " +
      "absent field is left untouched; an explicit null clears phone, alternatePhone, or address (all " +
      "nullable). Login email is not editable here — it's the parent's loginId, and changing it changes " +
      "how they sign in; that's a separate, audited endpoint, not folded into this profile edit.",
    requestParams: parentsIdParamsSchema,
    requestBody: updateParentSchema,
    responses: { 200: { description: "OK", schema: ParentSchema } },
  },
  "GET /api/parents/:id/children": {
    summary: "List a parent's linked children",
    requestParams: parentsIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(StudentParentWithStudentSchema) } },
    scopeNote: SCOPE_NOTES.canReadParent,
  },
  "POST /api/parents/:id/children": {
    summary:
      "Link a student to a parent. With isPrimaryContact: true, this is also what issues the " +
      "student's login — the very first time only: a generated password, mustChangePassword: " +
      "true, delivered to this parent's email naming the child. Linking a second (non-primary) " +
      "parent never re-triggers it, and relinking a new primary contact after the original was " +
      "unlinked is silent by design — see POST /api/students/:id/reissue-credentials for that case.",
    requestParams: parentsIdParamsSchema,
    requestBody: linkChildSchema,
    responses: { 201: { description: "Created", schema: StudentParentSchema } },
  },
  "DELETE /api/parents/:id/children/:studentId": {
    summary: "Unlink a student from a parent",
    requestParams: parentChildParamsSchema,
    responses: { 204: noContent },
  },

  // --- ratings ------------------------------------------------------------
  "POST /api/academic-sessions/:id/traits": {
    summary: "Create an affective or psychomotor trait (e.g. Punctuality, Handwriting) for an academic session",
    requestParams: ratingsIdParamsSchema,
    requestBody: createTraitSchema,
    responses: { 201: { description: "Created", schema: TraitSchema } },
  },
  "GET /api/academic-sessions/:id/traits": {
    summary: "List affective/psychomotor traits for an academic session, both categories together",
    requestParams: ratingsIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(TraitSchema) } },
  },
  "GET /api/rating-scale": {
    summary: "List the fixed 5-point rating scale shared by both trait categories (static reference data)",
    responses: { 200: { description: "OK", schema: z.array(RatingScaleLevelSchema) } },
  },
  "PUT /api/classes/:id/results/:termId/ratings": {
    summary:
      "Bulk upsert affective/psychomotor ratings for a class+term. Only while the targeted student's " +
      "Result for this term is DRAFT — same rule as the class-teacher comment; rejects (409) the whole " +
      "batch if any targeted student's result is no longer DRAFT. Appear on the result read once written.",
    requestParams: ratingsClassTermParamsSchema,
    requestBody: bulkUpsertRatingsSchema,
    responses: { 200: { description: "OK", schema: z.array(RatingWithTraitSchema) } },
    scopeNote: SCOPE_NOTES.canWriteClassRatings,
  },

  // --- results ----------------------------------------------------------------
  "POST /api/results/compute": {
    summary: "Compute/refresh DRAFT report-card results for a class/term from submitted subject results",
    requestBody: computeResultsSchema,
    responses: { 200: { description: "OK", schema: z.array(ResultSchema) } },
  },
  "GET /api/results/:studentId/:termId": {
    summary: "Get a student's report-card result for a term, with this term's affective/psychomotor ratings",
    requestParams: studentTermParamsSchema,
    responses: { 200: { description: "OK", schema: ResultWithRatingsSchema } },
    scopeNote:
      `${SCOPE_NOTES.canReadStudent} A PARENT or STUDENT caller only ever sees a FINALIZED result — ` +
      "DRAFT/SUBMITTED reads as 404 for them, the same as if compute had never run. IMPORTANT: for a " +
      "PARENT/STUDENT caller, a FINALIZED result with an outstanding fee balance for this term (or a " +
      "session-wide, not-term-specific fee) is withheld — see the 402 response below, not returned here " +
      "as 200. Released via POST /results/:id/release-withholding.",
  },
  "GET /api/students/:id/results": {
    summary: "List a student's report-card results across terms, newest first",
    requestParams: resultsIdParamsSchema,
    requestQuery: listResultsForStudentQuerySchema,
    responses: { 200: { description: "OK", schema: z.array(ResultListItemSchema) } },
    scopeNote:
      `${SCOPE_NOTES.canReadStudent} A PARENT or STUDENT caller only ever sees FINALIZED results — ` +
      "non-finalized ones are simply omitted from the list, not an error. A FINALIZED term withheld for " +
      "an outstanding fee balance (see GET /results/:studentId/:termId) is NOT omitted here — it's still " +
      "present, but as a reduced WithheldResultListItem (status: \"WITHHELD\" plus the amount owed) in " +
      "place of the normal result fields, distinguishable by that status value.",
  },
  "GET /api/classes/:id/results/:termId": {
    summary: "List a class's report-card results for a term",
    requestParams: classTermParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(ResultWithStudentSchema) } },
    scopeNote: SCOPE_NOTES.canReadClassResults,
  },
  "POST /api/results/:id/finalize": {
    summary:
      "Finalize a report-card result, locking it except via override. Snapshots daysPresent/" +
      "daysSchoolOpened at this moment (never recomputed later). Once every actively-enrolled student " +
      "in this class+term is FINALIZED, this call also triggers the class-wide position/outOf pass " +
      "(ranked strictly among FINALIZED peers, ties sharing a position) — see " +
      "POST /classes/:id/results/:termId/rank for the admin escape hatch if a class never completes.",
    requestParams: resultsIdParamsSchema,
    responses: { 200: { description: "OK", schema: ResultSchema } },
  },
  "POST /api/classes/:id/results/:termId/rank": {
    summary:
      "Admin escape hatch: rank whatever's currently FINALIZED for this class+term, unconditionally — " +
      "for a class that never reaches 100% finalized (e.g. a student withdrew mid-term with incomplete " +
      "data), so report cards aren't permanently stuck without a position. Ties share a position, the " +
      "next position skips (1, 2, 2, 4).",
    requestParams: classTermParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(ResultSchema) } },
  },
  "POST /api/results/:id/override": {
    summary: "Override a field on a FINALIZED result, with a mandatory reason, recorded as an audited ResultOverride",
    requestParams: resultsIdParamsSchema,
    requestBody: overrideResultSchema,
    responses: { 200: { description: "OK", schema: ResultSchema } },
  },
  "POST /api/results/:id/release-withholding": {
    summary:
      "ADMIN release of fee withholding for one FINALIZED result, per term — not per session. A required " +
      "reason is recorded as an audited ResultOverride (fieldName \"feeWithholdingReleased\"), the same " +
      "pattern as /override. Idempotent: releasing an already-released result is still 200, with no " +
      "duplicate audit row.",
    requestParams: resultsIdParamsSchema,
    requestBody: releaseWithholdingSchema,
    responses: { 200: { description: "OK", schema: ResultSchema } },
  },
  "POST /api/session-results/compute": {
    summary:
      "Roll up a class's students' FINALIZED term results into per-session results, per subject then " +
      "overall — averaged or carried-forward per GradingScale.sessionAverageMethod. A student with only " +
      "some terms FINALIZED is averaged over those, never counting a missing term as zero. Purely " +
      "derived, so every row this produces is immediately FINALIZED — there's no separate finalize step.",
    requestBody: computeSessionResultsSchema,
    responses: { 200: { description: "OK", schema: z.array(SessionResultWithSubjectAveragesSchema) } },
  },
  "GET /api/session-results/:studentId/:academicSessionId": {
    summary: "Get a student's session-level rollup result, with its per-subject averages",
    requestParams: studentSessionParamsSchema,
    responses: { 200: { description: "OK", schema: SessionResultWithSubjectAveragesSchema } },
    scopeNote:
      `${SCOPE_NOTES.canReadStudent} Same finalized-only visibility and fee-withholding rules as ` +
      "GET /results/:studentId/:termId, checked session-wide (any outstanding obligation anywhere in " +
      "the session withholds this) rather than against one term — see the 402 response below. Release " +
      "is per-term only; a term's release does not affect this session-wide check.",
  },
  "PATCH /api/results/:id/class-teacher-comment": {
    summary: "Write the class/form teacher's comment on a DRAFT result — not an override, no ResultOverride row",
    requestParams: resultsIdParamsSchema,
    requestBody: writeCommentSchema,
    responses: { 200: { description: "OK", schema: ResultSchema } },
    scopeNote: SCOPE_NOTES.canReadClassResults,
  },
  "PATCH /api/results/:id/principal-comment": {
    summary: "Write the principal's comment on a DRAFT result — not an override, no ResultOverride row",
    requestParams: resultsIdParamsSchema,
    requestBody: writeCommentSchema,
    responses: { 200: { description: "OK", schema: ResultSchema } },
  },

  // --- school -----------------------------------------------------------------
  "GET /api/school": {
    summary: "Get the school's singleton record",
    responses: { 200: { description: "OK", schema: SchoolSchema } },
  },
  "POST /api/school": {
    summary: "Create the school's singleton record — fails once one already exists",
    requestBody: createSchoolSchema,
    responses: { 201: { description: "Created", schema: SchoolSchema } },
  },
  "PATCH /api/school": {
    summary: "Update the school's singleton record",
    requestBody: updateSchoolSchema,
    responses: { 200: { description: "OK", schema: SchoolSchema } },
  },

  // --- scores -----------------------------------------------------------------
  "GET /api/class-subject-assignments/:id/students": {
    summary: "Get the class roster for a class-subject assignment",
    requestParams: scoresIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(StudentSchema) } },
    scopeNote: SCOPE_NOTES.canActOnAssignment,
  },
  "GET /api/class-subject-assignments/:id/scores": {
    summary:
      "Repopulate the entry sheet for a class-subject assignment/term — every enrolled student, every " +
      "assessment component, null where nothing's entered yet. Returns DRAFT scores; not subject to the " +
      "finalized-only filter that governs the parent/student path.",
    requestParams: scoresIdParamsSchema,
    requestQuery: scoresForAssignmentQuerySchema,
    responses: { 200: { description: "OK", schema: ScoreSheetSchema } },
    scopeNote: SCOPE_NOTES.canActOnAssignment,
  },
  "PUT /api/class-subject-assignments/:id/scores": {
    summary: "Bulk upsert DRAFT scores for a class-subject assignment/term",
    requestParams: scoresIdParamsSchema,
    requestBody: bulkUpsertScoresSchema,
    responses: { 200: { description: "OK", schema: z.array(ScoreSchema) } },
    scopeNote: SCOPE_NOTES.canActOnAssignment,
  },
  "POST /api/class-subject-assignments/:id/scores/submit": {
    summary: "Submit a class-subject assignment's scores for a term, computing SubjectResults",
    requestParams: scoresIdParamsSchema,
    requestBody: submitScoresSchema,
    responses: { 200: { description: "OK", schema: z.array(SubjectResultSchema) } },
    scopeNote: SCOPE_NOTES.canActOnAssignment,
  },
  "GET /api/students/:id/scores": {
    summary: "Get a student's subject results",
    requestParams: scoresIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(SubjectResultWithRelationsSchema) } },
    scopeNote: SCOPE_NOTES.canReadStudent,
  },

  // --- staff --------------------------------------------------------------
  "POST /api/staff": {
    summary:
      "BREAKING CHANGE — atomically creates BOTH the User and the Staff record (no more separate " +
      "POST /api/users step first): choose `role` (ADMIN/TEACHER/BURSAR) and supply `email` " +
      "directly here. `staffNumber` is server-generated (FIA/ST<year>/<seq>) unless explicitly " +
      "overridden for a legacy paper-record import. The password is always generated, never " +
      "admin-chosen — mustChangePassword starts true, and credentials are emailed to `email`.",
    requestBody: createStaffSchema,
    responses: { 201: { description: "Created", schema: StaffSchema } },
  },
  "GET /api/staff": {
    summary: "List staff",
    responses: { 200: { description: "OK", schema: z.array(StaffWithUserSchema) } },
  },
  "GET /api/staff/:id": {
    summary: "Get one staff member",
    requestParams: staffIdParamsSchema,
    responses: { 200: { description: "OK", schema: StaffWithUserSchema } },
    scopeNote: SCOPE_NOTES.canReadStaff,
  },
  "PATCH /api/staff/:id": {
    summary:
      "Update a staff member. Changing staffNumber also updates the linked User.loginId, in the " +
      "same transaction — the two can never legitimately disagree.",
    requestParams: staffIdParamsSchema,
    requestBody: updateStaffSchema,
    responses: { 200: { description: "OK", schema: StaffSchema } },
  },

  // --- students ---------------------------------------------------------------
  "POST /api/students": {
    summary:
      "BREAKING CHANGE — admissionNumber is server-generated (FIA/<year>/<seq>) unless explicitly " +
      "overridden for a legacy paper-record import; there is no more `userId`, `issueLogin`, or " +
      "`email` field. A student never gets a login at creation — no parent can be linked yet " +
      "regardless, since studentId doesn't exist until this call returns — see " +
      "POST /api/parents/:id/children instead, which is what actually issues one.",
    requestBody: createStudentSchema,
    responses: { 201: { description: "Created", schema: StudentSchema } },
  },
  "GET /api/students": {
    summary: "List students",
    responses: { 200: { description: "OK", schema: z.array(StudentSchema) } },
  },
  "GET /api/students/:id": {
    summary: "Get one student",
    requestParams: studentsIdParamsSchema,
    responses: { 200: { description: "OK", schema: StudentSchema } },
    scopeNote: SCOPE_NOTES.canReadStudent,
  },
  "PATCH /api/students/:id": {
    summary:
      "BREAKING CHANGE — the old `userId`/`issueLogin`/`email` fields are gone entirely. A " +
      "student's login is issued exactly once, automatically, by the first " +
      "POST /api/parents/:id/children call that links them with isPrimaryContact: true — never " +
      "through this route. Changing admissionNumber still updates the linked User.loginId, in the " +
      "same transaction, when a login exists. Setting status to GRADUATED or WITHDRAWN also closes " +
      "every currently-active enrollment this student holds (see PATCH /api/students/status, which " +
      "shares this exact behavior). Setting status to INACTIVE does NOT: it's a label only — it does " +
      "not end enrollment, does not remove the student from a class roster or score sheet, and does " +
      "not stop billing. WITHDRAWN is the status that does all of that.",
    requestParams: studentsIdParamsSchema,
    requestBody: updateStudentSchema,
    responses: { 200: { description: "OK", schema: StudentSchema } },
  },
  "PATCH /api/students/status": {
    summary:
      "Bulk status update: { ids, status }, up to 500 at once. Partial success, not all-or-nothing — " +
      "returns 200 with { updated: string[], failed: { id, message }[] } always; one bad id never " +
      "blocks a graduation run for the rest of the class. Setting status to GRADUATED or WITHDRAWN " +
      "also closes every currently-active enrollment each affected student holds — not just the " +
      "current session's, since nothing has ever closed a stale one from a past session either. " +
      "Setting status to INACTIVE does NOT close anything: it's a label only, exactly like " +
      "PATCH /api/students/:id's own status field — it does not end enrollment, does not remove the " +
      "student from a class roster or score sheet, and does not stop billing. WITHDRAWN is the status " +
      "that does all of that. Setting status back to ACTIVE never reopens a closed enrollment either — " +
      "re-enrollment is POST /api/students/:id/enrollments, a deliberate action that picks a specific " +
      "class.",
    requestBody: bulkUpdateStudentStatusSchema,
    responses: { 200: { description: "OK", schema: BulkStudentStatusResultSchema } },
  },
  "POST /api/students/:id/reissue-credentials": {
    summary:
      "ADMIN recovery path: generates a fresh temporary password (never admin-chosen) and resets " +
      "mustChangePassword, for a student who already has a login — 409 if they don't (link a " +
      "primary-contact parent first, which is what creates one). Also revokes existing sessions, " +
      "the same posture change-password/reset-password already take. Delivered to the current " +
      "primary-contact (or earliest-linked) parent's email when one exists; if every linked parent " +
      "has since been unlinked, there is nowhere to deliver it, so `temporaryPassword` is returned " +
      "once in the response instead — the only remaining case in this API where a password appears " +
      "in a response body. Audited (no reason field — this is recovery, not an override).",
    requestParams: studentsIdParamsSchema,
    responses: { 200: { description: "OK", schema: StudentWithOptionalTemporaryPasswordSchema } },
  },
  "GET /api/students/:id/parents": {
    summary: "List a student's linked parents, with relationship and primary-contact flag",
    requestParams: studentsIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(StudentParentWithParentSchema) } },
    scopeNote: SCOPE_NOTES.canReadStudentParents,
  },
  "POST /api/students/:id/enrollments": {
    summary: "Enroll a student in a class for an academic session",
    requestParams: studentsIdParamsSchema,
    requestBody: createEnrollmentSchema,
    responses: { 201: { description: "Created", schema: EnrollmentSchema } },
  },
  "GET /api/students/:id/enrollments": {
    summary: "List a student's enrollments",
    requestParams: studentsIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(EnrollmentWithRelationsSchema) } },
    scopeNote: SCOPE_NOTES.canReadStudent,
  },
  "POST /api/students/:id/transfer": {
    summary:
      "Move a student's current-session enrollment to a different class — in place, not a new " +
      "enrollment: scores, subject results, and attendance already recorded stay exactly where they " +
      "are (never repointed to the new class), and remain correctly counted because the compute path " +
      "is scoped by student, not by one class. 400 if the target class is at a different grade level " +
      "than the student's current one (e.g. JSS1 to JSS2) — this endpoint only covers arms of the same " +
      "grade level (e.g. JSS1 A to JSS1 B); a cross-grade move is POST /api/students/:id/enrollments " +
      "instead. No partial-term awareness: a result already FINALIZED before the move is re-ranked " +
      "against its new class's cohort the next time that class is ranked, same as any other re-rank.",
    requestParams: studentsIdParamsSchema,
    requestBody: transferStudentSchema,
    responses: { 200: { description: "OK", schema: EnrollmentSchema } },
  },

  // --- timetable --------------------------------------------------------------
  "POST /api/time-slots": {
    summary: "Create a timetable time slot",
    requestBody: createTimeSlotSchema,
    responses: { 201: { description: "Created", schema: TimeSlotSchema } },
  },
  "GET /api/time-slots": {
    summary: "List timetable time slots",
    responses: { 200: { description: "OK", schema: z.array(TimeSlotSchema) } },
  },
  "POST /api/timetable-entries": {
    summary: "Create a timetable entry, assigning a class-subject-assignment to a day/time slot",
    requestBody: createTimetableEntrySchema,
    responses: { 201: { description: "Created", schema: TimetableEntrySchema } },
  },
  "DELETE /api/timetable-entries/:id": {
    summary: "Remove a timetable entry",
    requestParams: timetableIdParamsSchema,
    responses: { 204: noContent },
  },
  "GET /api/classes/:id/timetable": {
    summary: "Get a class's weekly timetable",
    requestParams: timetableIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(TimetableEntryForClassViewSchema) } },
    scopeNote: SCOPE_NOTES.canReadClassTimetable,
  },
  "GET /api/staff/:id/timetable": {
    summary: "Get a staff member's weekly teaching timetable",
    requestParams: timetableIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(TimetableEntryForStaffViewSchema) } },
    scopeNote: SCOPE_NOTES.canReadStaff,
  },

  // --- users --------------------------------------------------------------
  "POST /api/users": {
    summary:
      "BREAKING CHANGE — narrowed to ADMIN only, for a bare bootstrap account with no Staff " +
      "record of its own. TEACHER/BURSAR are created via POST /api/staff, PARENT via " +
      "POST /api/parents, STUDENT via POST /api/students — all three atomic (User + profile " +
      "record together). No `password` field: the password is always generated, never " +
      "admin-chosen — mustChangePassword starts true, and credentials are emailed to `email`, " +
      "which also becomes this account's loginId.",
    requestBody: createUserSchema,
    responses: { 201: { description: "Created", schema: UserSummarySchema } },
  },
  "GET /api/users": {
    summary: "List user accounts",
    responses: { 200: { description: "OK", schema: z.array(UserSummarySchema) } },
  },
  "GET /api/users/:id": {
    summary: "Get one user account",
    requestParams: userIdParamsSchema,
    responses: { 200: { description: "OK", schema: UserSummarySchema } },
  },
  "POST /api/users/:id/activate": {
    summary: "Reactivate a deactivated user account",
    requestParams: userIdParamsSchema,
    responses: { 200: { description: "OK", schema: UserSummarySchema } },
  },
  "POST /api/users/:id/deactivate": {
    summary: "Deactivate a user account and revoke its live sessions",
    requestParams: userIdParamsSchema,
    responses: { 200: { description: "OK", schema: UserSummarySchema } },
  },
};
