import type { RouteParameter } from "@asteasolutions/zod-to-openapi/dist/openapi-registry.js";
import type { ZodTypeAny } from "zod";
import { z } from "zod";
import "./zodSetup.js";
import { createAcademicSessionSchema, createClassFormTeacherSchema, createClassSchema, createClassSubjectAssignmentSchema, createSubjectSchema, createTermSchema, idParamsSchema as academicStructureIdParamsSchema } from "../modules/academic-structure/academic-structure.schemas.js";
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
import { createFeeStructureSchema, idParamsSchema as feesIdParamsSchema, recordPaymentSchema, updateFeeObligationSchema } from "../modules/fees/fees.schemas.js";
import { createAssessmentComponentSchema, createGradeBandSchema, idParamsSchema as gradingIdParamsSchema } from "../modules/grading/grading.schemas.js";
import { createProgressSchema, idParamsSchema as madrassahIdParamsSchema } from "../modules/madrassah/madrassah.schemas.js";
import { triggerFeeRemindersSchema } from "../modules/notifications/notifications.schemas.js";
import { createParentSchema, idParamsSchema as parentsIdParamsSchema, linkChildSchema, parentChildParamsSchema } from "../modules/parents/parents.schemas.js";
import {
  classTermParamsSchema,
  computeResultsSchema,
  idParamsSchema as resultsIdParamsSchema,
  overrideResultSchema,
  studentTermParamsSchema,
  writeCommentSchema,
} from "../modules/results/results.schemas.js";
import { createSchoolSchema, updateSchoolSchema } from "../modules/school/school.schemas.js";
import { bulkUpsertScoresSchema, idParamsSchema as scoresIdParamsSchema, submitScoresSchema } from "../modules/scores/scores.schemas.js";
import { createStaffSchema, idParamsSchema as staffIdParamsSchema, updateStaffSchema } from "../modules/staff/staff.schemas.js";
import { createEnrollmentSchema, createStudentSchema, idParamsSchema as studentsIdParamsSchema, updateStudentSchema } from "../modules/students/students.schemas.js";
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
  EnrollmentSchema,
  EnrollmentWithRelationsSchema,
  FeeObligationSchema,
  FeeObligationWithBalanceSchema,
  FeeStructureSchema,
  GradeBandSchema,
  GradingScaleSchema,
  GradingScaleWithBandsSchema,
  MadrassahProgressSchema,
  MadrassahProgressWithRelationsSchema,
  MeResponseSchema,
  NotificationEventSchema,
  NotificationEventWithDeliveriesSchema,
  ParentSchema,
  PaymentSchema,
  PaymentWithRelationsSchema,
  ReceiptSchema,
  ResultSchema,
  ResultWithStudentSchema,
  ScanResultSchema,
  SchoolSchema,
  ScoreSchema,
  StaffSchema,
  StaffWithUserSchema,
  StudentParentSchema,
  StudentParentWithStudentSchema,
  StudentQrCodeSchema,
  StudentSchema,
  SubjectResultSchema,
  SubjectResultWithRelationsSchema,
  SubjectSchema,
  SurahSchema,
  TermSchema,
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
    summary: "Remove a class-subject-teacher assignment",
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
  },
  "GET /api/students/:id/qr-code": {
    summary: "Get a student's current active QR code",
    requestParams: attendanceIdParamsSchema,
    responses: { 200: { description: "OK", schema: StudentQrCodeSchema } },
  },

  // --- audit ------------------------------------------------------------------
  "GET /api/audit-log": {
    summary: "List audit log entries",
    requestQuery: listAuditLogQuerySchema,
    responses: { 200: { description: "OK", schema: z.array(AuditLogSchema) } },
  },

  // --- auth ---------------------------------------------------------------
  "POST /api/auth/login": {
    summary: "Log in with email and password (public)",
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
      "Request a password reset email (public). Always responds 204 regardless of whether the email " +
      "belongs to an account — the response never reveals whether an address is registered.",
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
    summary: "Create a fee structure",
    requestBody: createFeeStructureSchema,
    responses: { 201: { description: "Created", schema: FeeStructureSchema } },
  },
  "GET /api/fee-structures": {
    summary: "List fee structures",
    requestQuery: feeStructuresQuerySchema,
    responses: { 200: { description: "OK", schema: z.array(FeeStructureSchema) } },
  },
  "POST /api/fee-structures/:id/generate-obligations": {
    summary: "Generate a fee obligation for every actively-enrolled student against this fee structure",
    requestParams: feesIdParamsSchema,
    responses: { 201: { description: "Created", schema: z.array(FeeObligationSchema) } },
  },
  "GET /api/students/:id/fee-obligations": {
    summary: "List a student's fee obligations, with computed paid/outstanding balances",
    requestParams: feesIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(FeeObligationWithBalanceSchema) } },
  },
  "PATCH /api/fee-obligations/:id": {
    summary: "Update a fee obligation",
    requestParams: feesIdParamsSchema,
    requestBody: updateFeeObligationSchema,
    responses: { 200: { description: "OK", schema: FeeObligationSchema } },
  },
  "POST /api/fee-obligations/:id/payments": {
    summary: "Record a payment against a fee obligation",
    requestParams: feesIdParamsSchema,
    requestBody: recordPaymentSchema,
    responses: { 201: { description: "Created", schema: PaymentSchema } },
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
  },
  "GET /api/students/:id/payments": {
    summary: "List a student's payments",
    requestParams: feesIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(PaymentWithRelationsSchema) } },
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
  "POST /api/academic-sessions/:id/grading-scale": {
    summary: "Create the grading scale for an academic session",
    requestParams: gradingIdParamsSchema,
    responses: { 201: { description: "Created", schema: GradingScaleSchema } },
  },
  "GET /api/academic-sessions/:id/grading-scale": {
    summary: "Get an academic session's grading scale with its grade bands",
    requestParams: gradingIdParamsSchema,
    responses: { 200: { description: "OK", schema: GradingScaleWithBandsSchema } },
  },
  "POST /api/grading-scales/:id/bands": {
    summary: "Add a grade band to a grading scale",
    requestParams: gradingIdParamsSchema,
    requestBody: createGradeBandSchema,
    responses: { 201: { description: "Created", schema: GradeBandSchema } },
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
    summary: "Create a parent profile linked to a PARENT-role user",
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
  "POST /api/parents/:id/children": {
    summary: "Link a student to a parent",
    requestParams: parentsIdParamsSchema,
    requestBody: linkChildSchema,
    responses: { 201: { description: "Created", schema: StudentParentSchema } },
  },
  "DELETE /api/parents/:id/children/:studentId": {
    summary: "Unlink a student from a parent",
    requestParams: parentChildParamsSchema,
    responses: { 204: noContent },
  },

  // --- results ----------------------------------------------------------------
  "POST /api/results/compute": {
    summary: "Compute/refresh DRAFT report-card results for a class/term from submitted subject results",
    requestBody: computeResultsSchema,
    responses: { 200: { description: "OK", schema: z.array(ResultSchema) } },
  },
  "GET /api/results/:studentId/:termId": {
    summary: "Get a student's report-card result for a term",
    requestParams: studentTermParamsSchema,
    responses: { 200: { description: "OK", schema: ResultSchema } },
  },
  "GET /api/classes/:id/results/:termId": {
    summary: "List a class's report-card results for a term",
    requestParams: classTermParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(ResultWithStudentSchema) } },
  },
  "POST /api/results/:id/finalize": {
    summary: "Finalize a report-card result, locking it except via override",
    requestParams: resultsIdParamsSchema,
    responses: { 200: { description: "OK", schema: ResultSchema } },
  },
  "POST /api/results/:id/override": {
    summary: "Override a field on a FINALIZED result, with a mandatory reason, recorded as an audited ResultOverride",
    requestParams: resultsIdParamsSchema,
    requestBody: overrideResultSchema,
    responses: { 200: { description: "OK", schema: ResultSchema } },
  },
  "PATCH /api/results/:id/class-teacher-comment": {
    summary: "Write the class/form teacher's comment on a DRAFT result (the class's form teacher, or an admin) — not an override, no ResultOverride row",
    requestParams: resultsIdParamsSchema,
    requestBody: writeCommentSchema,
    responses: { 200: { description: "OK", schema: ResultSchema } },
  },
  "PATCH /api/results/:id/principal-comment": {
    summary: "Write the principal's comment on a DRAFT result (admin only) — not an override, no ResultOverride row",
    requestParams: resultsIdParamsSchema,
    requestBody: writeCommentSchema,
    responses: { 200: { description: "OK", schema: ResultSchema } },
  },

  // --- school -----------------------------------------------------------------
  "GET /api/school": {
    summary: "Get the school's singleton record (admin only)",
    responses: { 200: { description: "OK", schema: SchoolSchema } },
  },
  "POST /api/school": {
    summary: "Create the school's singleton record (admin only) — fails once one already exists",
    requestBody: createSchoolSchema,
    responses: { 201: { description: "Created", schema: SchoolSchema } },
  },
  "PATCH /api/school": {
    summary: "Update the school's singleton record (admin only)",
    requestBody: updateSchoolSchema,
    responses: { 200: { description: "OK", schema: SchoolSchema } },
  },

  // --- scores -----------------------------------------------------------------
  "GET /api/class-subject-assignments/:id/students": {
    summary: "Get the class roster for a class-subject assignment (the assigned teacher, or an admin)",
    requestParams: scoresIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(StudentSchema) } },
  },
  "PUT /api/class-subject-assignments/:id/scores": {
    summary: "Bulk upsert DRAFT scores for a class-subject assignment/term",
    requestParams: scoresIdParamsSchema,
    requestBody: bulkUpsertScoresSchema,
    responses: { 200: { description: "OK", schema: z.array(ScoreSchema) } },
  },
  "POST /api/class-subject-assignments/:id/scores/submit": {
    summary: "Submit a class-subject assignment's scores for a term, computing SubjectResults",
    requestParams: scoresIdParamsSchema,
    requestBody: submitScoresSchema,
    responses: { 200: { description: "OK", schema: z.array(SubjectResultSchema) } },
  },
  "GET /api/students/:id/scores": {
    summary: "Get a student's subject results",
    requestParams: scoresIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(SubjectResultWithRelationsSchema) } },
  },

  // --- staff --------------------------------------------------------------
  "POST /api/staff": {
    summary: "Create a staff profile for a TEACHER/ADMIN/BURSAR user",
    requestBody: createStaffSchema,
    responses: { 201: { description: "Created", schema: StaffSchema } },
  },
  "GET /api/staff": {
    summary: "List staff",
    responses: { 200: { description: "OK", schema: z.array(StaffWithUserSchema) } },
  },
  "GET /api/staff/:id": {
    summary: "Get one staff member (self, or admin)",
    requestParams: staffIdParamsSchema,
    responses: { 200: { description: "OK", schema: StaffWithUserSchema } },
  },
  "PATCH /api/staff/:id": {
    summary: "Update a staff member",
    requestParams: staffIdParamsSchema,
    requestBody: updateStaffSchema,
    responses: { 200: { description: "OK", schema: StaffSchema } },
  },

  // --- students ---------------------------------------------------------------
  "POST /api/students": {
    summary: "Create a student",
    requestBody: createStudentSchema,
    responses: { 201: { description: "Created", schema: StudentSchema } },
  },
  "GET /api/students": {
    summary: "List students",
    responses: { 200: { description: "OK", schema: z.array(StudentSchema) } },
  },
  "GET /api/students/:id": {
    summary: "Get one student (admin; the student themself; a linked parent; or a teacher assigned to their currently-enrolled class)",
    requestParams: studentsIdParamsSchema,
    responses: { 200: { description: "OK", schema: StudentSchema } },
  },
  "PATCH /api/students/:id": {
    summary: "Update a student",
    requestParams: studentsIdParamsSchema,
    requestBody: updateStudentSchema,
    responses: { 200: { description: "OK", schema: StudentSchema } },
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
    summary: "Get a class's weekly timetable (any staff member; students/parents scoped to their own/linked enrollment)",
    requestParams: timetableIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(TimetableEntryForClassViewSchema) } },
  },
  "GET /api/staff/:id/timetable": {
    summary: "Get a staff member's weekly teaching timetable (self, or admin)",
    requestParams: timetableIdParamsSchema,
    responses: { 200: { description: "OK", schema: z.array(TimetableEntryForStaffViewSchema) } },
  },

  // --- users --------------------------------------------------------------
  "POST /api/users": {
    summary: "Create a user account with one role",
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
