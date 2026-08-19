import type { Role } from "../../generated/prisma/index.js";
import { prisma } from "../db/client.js";
import {
  createAdmin,
  createAssessmentComponent,
  createAssignment,
  createBursar,
  createClass,
  createCurrentAcademicSession,
  createParent,
  createStaffParent,
  createStudentWithLogin,
  createSubject,
  createTeacher,
  createTermForSession,
  enrollStudent,
} from "../test/factories.js";
import { PUBLIC_ROUTES } from "./publicRoutes.js";
import { ALL_ROLES } from "./types.js";
import type { DiscoveredRoute } from "./routeInventory.js";

/// The eight actor types named in the task, plus "unauthenticated" and
/// "staffParent" — every bespoke/auto row expresses its cases in terms of
/// this fixed vocabulary. Not every row exercises every column (e.g. a route
/// with no notion of "assignment" has no meaningful
/// assignedTeacher/unassignedTeacher split) — an omitted case just means
/// that column is inapplicable to that row, not a gap.
///
/// staffParent holds TEACHER and PARENT at once — the one actor type this
/// vocabulary didn't have room for before UserRole existed. It only appears
/// in bespoke rows (buildSharedWorld), not in createGenericActors/auto rows:
/// the auto-generated rows are pure role-gate checks, one generic actor per
/// Role, and multi-role composition is a scope-resolver concern, not a
/// role-gate one.
export type ActorKey =
  | "unauthenticated"
  | "admin"
  | "bursar"
  | "assignedTeacher"
  | "unassignedTeacher"
  | "linkedParent"
  | "unlinkedParent"
  | "ownStudent"
  | "otherStudent"
  | "staffParent"
  | "formTeacher";

/// A concrete rejection status, or "allowed" — meaning the request must reach
/// past the authorization layer (i.e. NOT be blocked with 401/403). Business
/// -logic status codes beyond that boundary (200 vs 400 vs 404 for a
/// placeholder/incomplete payload) are a correctness concern for each
/// module's own tests, not this matrix — this matrix's job is proving WHO is
/// let through, not WHAT happens next.
export type ExpectedStatus = 401 | 403 | "allowed";

export interface MatrixCase {
  actor: ActorKey;
  expectedStatus: ExpectedStatus;
}

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface MatrixRow {
  /// "METHOD /path" — must match a DiscoveredRoute key from routeInventory.
  name: string;
  method: HttpMethod;
  cases: MatrixCase[];
  /// Resolves this row's concrete URL/body and each case's bearer token.
  /// Auto-generated rows just echo the shared generic actors; bespoke rows
  /// build their own real fixtures (a specific assigned teacher, a linked
  /// parent, etc.) so the "allowed" cases exercise the actual scope resolver
  /// logic, not just the role gate in front of it.
  setup: () => Promise<{ url: string; body?: unknown; tokens: Partial<Record<ActorKey, string>> }>;
}

export interface GenericActors {
  admin: Awaited<ReturnType<typeof createAdmin>>;
  bursar: Awaited<ReturnType<typeof createBursar>>;
  /// Deliberately given no assignment — stands in for "unassignedTeacher" in
  /// every auto-generated row and most bespoke rows.
  teacher: Awaited<ReturnType<typeof createTeacher>>;
  /// Deliberately given no StudentParent link — stands in for
  /// "unlinkedParent".
  parent: Awaited<ReturnType<typeof createParent>>;
  /// Deliberately unrelated to any bespoke row's target student — stands in
  /// for "otherStudent".
  student: Awaited<ReturnType<typeof createStudentWithLogin>>;
}

export async function createGenericActors(): Promise<GenericActors> {
  // Sequential, not Promise.all: createTeacher/createBursar derive
  // Staff.staffNumber from a slice of the new User's cuid, and cuids
  // generated in the same tick can share that slice — a real collision seen
  // when these were created concurrently.
  const admin = await createAdmin("matrix-generic-admin@test.local");
  const bursar = await createBursar("matrix-generic-bursar@test.local");
  const teacher = await createTeacher("matrix-generic-teacher@test.local");
  const parent = await createParent("matrix-generic-parent@test.local");
  const student = await createStudentWithLogin("matrix-generic-student@test.local", "MATRIX-GENERIC-STU");
  return { admin, bursar, teacher, parent, student };
}

function routeKey(route: DiscoveredRoute): string {
  return `${route.method} ${route.path}`;
}

function fillPathParams(path: string): string {
  return path.replace(/:[a-zA-Z]+/g, "route-guard-matrix-placeholder");
}

const ROLE_TO_GENERIC_ACTOR: Record<Role, ActorKey> = {
  ADMIN: "admin",
  BURSAR: "bursar",
  TEACHER: "unassignedTeacher",
  PARENT: "unlinkedParent",
  STUDENT: "otherStudent",
};

/// Routes eligible for auto-generation: guarded by requireRole and NOTHING
/// else (no requireScope in the chain). Routes that mix role + scope (the
/// three scores routes) need bespoke fixtures because the role gate alone
/// doesn't determine who's actually allowed through.
function isAutoEligible(route: DiscoveredRoute): boolean {
  return (
    route.guardTypes.has("role") &&
    !route.guardTypes.has("scope") &&
    route.allowedRoles !== undefined &&
    !PUBLIC_ROUTES.has(routeKey(route))
  );
}

/// The route keys the auto-generator will cover, computed synchronously from
/// the (already-built, DB-free) route inventory. Used by the route-guard
/// inventory test's cross-check — it doesn't touch the DB, so it can't call
/// buildBespokeRows(), only this.
export function autoGeneratedRouteKeys(inventory: DiscoveredRoute[]): string[] {
  return inventory.filter(isAutoEligible).map(routeKey);
}

const METHODS_WITH_BODY: ReadonlySet<HttpMethod> = new Set(["post", "put", "patch"]);

export function buildAutoRows(inventory: DiscoveredRoute[], generics: GenericActors): MatrixRow[] {
  return inventory.filter(isAutoEligible).map((route) => {
    const allowedRoles = route.allowedRoles ?? new Set<Role>();
    const cases: MatrixCase[] = [{ actor: "unauthenticated", expectedStatus: 401 }];
    for (const role of ALL_ROLES) {
      cases.push({
        actor: ROLE_TO_GENERIC_ACTOR[role],
        expectedStatus: allowedRoles.has(role) ? "allowed" : 403,
      });
    }
    const method = route.method.toLowerCase() as HttpMethod;
    return {
      name: routeKey(route),
      method,
      cases,
      setup: () =>
        Promise.resolve({
          url: fillPathParams(route.path),
          body: METHODS_WITH_BODY.has(method) ? {} : undefined,
          tokens: {
            admin: generics.admin.token,
            bursar: generics.bursar.token,
            unassignedTeacher: generics.teacher.token,
            unlinkedParent: generics.parent.token,
            otherStudent: generics.student.token,
          },
        }),
    };
  });
}

/// Static mirror of every route name buildBespokeRows() produces. Kept as a
/// literal list (rather than derived) so the route-guard inventory test can
/// assert coverage without hitting the DB; authMatrix.test.ts separately
/// self-checks that the built rows' names match this list exactly, so the
/// two can't silently drift apart.
export const BESPOKE_ROUTE_KEYS: readonly string[] = [
  "GET /api/students/:id",
  "GET /api/students/:id/enrollments",
  "GET /api/students/:id/attendance",
  "GET /api/students/:id/scores",
  "GET /api/students/:id/madrassah-progress",
  "GET /api/results/:studentId/:termId",
  "GET /api/students/:id/fee-obligations",
  "GET /api/students/:id/payments",
  "GET /api/payments/:id/receipt",
  "GET /api/class-subject-assignments/:id/students",
  "PUT /api/class-subject-assignments/:id/scores",
  "POST /api/class-subject-assignments/:id/scores/submit",
  "GET /api/staff/:id",
  "GET /api/staff/:id/timetable",
  "GET /api/classes/:id/timetable",
  "PATCH /api/results/:id/class-teacher-comment",
];

let uniqueCounter = 0;
function unique(label: string): string {
  uniqueCounter += 1;
  return `${label}-${Date.now()}-${uniqueCounter}`;
}

function generateReceiptNumber(): string {
  return `RCPT-${unique("matrix")}`;
}

/// One connected set of real fixtures shared across every bespoke row: a
/// target student enrolled in a class, a teacher actually assigned to that
/// class+subject ("assignedTeacher"), a parent actually linked to the target
/// student ("linkedParent"), plus a confirmed payment/receipt for the fee
/// side. Built once per test run; every bespoke row's "allowed" cases
/// exercise this same real data through the real scope resolvers.
async function buildSharedWorld(generics: GenericActors) {
  const session = await createCurrentAcademicSession(unique("matrix-session"));
  const term = await createTermForSession(session.id, "Matrix Term", 1);
  const klass = await createClass(unique("Matrix Class"));
  const subject = await createSubject(unique("Matrix Subject"), unique("MSJ"));

  const { student: targetStudent, token: ownStudentToken } = await createStudentWithLogin(
    `${unique("matrix-target")}@test.local`,
    unique("MATRIX-TGT"),
  );
  const targetEnrollment = await enrollStudent(targetStudent.id, klass.id, session.id);

  const { staff: assignedTeacherStaff, token: assignedTeacherToken } = await createTeacher(
    `${unique("matrix-assigned-teacher")}@test.local`,
  );
  const assignment = await createAssignment(klass.id, subject.id, assignedTeacherStaff.id, session.id);
  const component = await createAssessmentComponent(session.id, unique("CA"), "CA", 40, 1);

  // A form teacher for `klass`, distinct from assignedTeacherStaff (who is
  // only a SUBJECT teacher there) — proves canWriteClassTeacherComment's
  // TEACHER branch checks the form-teacher assignment specifically, not
  // "any teacher connected to this class somehow." targetResult is the
  // DRAFT report card the class-teacher-comment/principal-comment routes
  // are tested against.
  const { staff: formTeacherStaff, token: formTeacherToken } = await createTeacher(
    `${unique("matrix-form-teacher")}@test.local`,
  );
  await prisma.classFormTeacher.create({
    data: { classId: klass.id, teacherId: formTeacherStaff.id, academicSessionId: session.id },
  });
  const targetResult = await prisma.result.create({
    data: {
      studentId: targetStudent.id,
      enrollmentId: targetEnrollment.id,
      termId: term.id,
      status: "DRAFT",
    },
  });

  const { parent: linkedParentRow, token: linkedParentToken } = await createParent(
    `${unique("matrix-linked-parent")}@test.local`,
  );
  await prisma.studentParent.create({
    data: { studentId: targetStudent.id, parentId: linkedParentRow.id, relationship: "GUARDIAN" },
  });

  // A user who holds TEACHER and PARENT at once — proves a dual-role caller
  // gets the union of what each role grants, not just whichever branch a
  // scope resolver happens to check first. Linked to targetStudent as a
  // SECOND parent (a student having two guardians is a real, already-
  // supported case) so the PARENT half is provable via canReadStudent/
  // canReadStudentFinancials; given their own, independent class (NOT
  // `klass`, targetStudent's own enrolled class) + subject + assignment so
  // the TEACHER half is provable via canActOnAssignment without reusing —
  // and thereby conflating with — assignedTeacher's fixture. Keeping the
  // teaching class genuinely separate from targetStudent's class also
  // matters for isolating what "allowed" below is actually proving: if
  // staffParent taught a different subject inside `klass` itself,
  // targetStudent's canReadStudent "allowed" case would be reachable via
  // EITHER the PARENT link OR the TEACHER-in-the-same-class branch, and the
  // row would no longer cleanly prove "PARENT alone is enough."
  const staffParent = await createStaffParent(`${unique("matrix-staff-parent")}@test.local`);
  await prisma.studentParent.create({
    data: { studentId: targetStudent.id, parentId: staffParent.parent.id, relationship: "GUARDIAN" },
  });
  const staffParentClass = await createClass(unique("Matrix StaffParent Class"));
  const staffParentSubject = await createSubject(unique("Matrix StaffParent Subject"), unique("MSP"));
  const staffParentAssignment = await createAssignment(
    staffParentClass.id,
    staffParentSubject.id,
    staffParent.staff.id,
    session.id,
  );

  // A student staffParent has NO connection to on either role: not their
  // child (no StudentParent link) and not enrolled in any class they teach
  // (enrolled nowhere at all, so canActOnAssignment's TEACHER-assignment
  // check never even gets a class to match against). This is the mirror
  // image of the "allowed" targetStudent case above — proves that merely
  // HOLDING TEACHER and PARENT doesn't itself grant anything; each grant
  // still depends on the real relationship the role is supposed to check.
  const { student: disjointStudent } = await createStudentWithLogin(
    `${unique("matrix-disjoint-target")}@test.local`,
    unique("MATRIX-DISJOINT"),
  );

  const feeStructure = await prisma.feeStructure.create({
    data: {
      name: "Matrix Tuition",
      category: "TUITION",
      classId: klass.id,
      academicSessionId: session.id,
      amountKobo: 5_000_00,
    },
  });
  const feeObligation = await prisma.feeObligation.create({
    data: {
      studentId: targetStudent.id,
      feeStructureId: feeStructure.id,
      academicSessionId: session.id,
      amountDueKobo: 5_000_00,
      createdByUserId: generics.admin.user.id,
    },
  });
  const payment = await prisma.payment.create({
    data: {
      feeObligationId: feeObligation.id,
      amountKobo: 5_000_00,
      paymentDate: new Date(),
      status: "CONFIRMED",
      recordedByUserId: generics.admin.user.id,
      confirmedByUserId: generics.admin.user.id,
      confirmedAt: new Date(),
    },
  });
  await prisma.receipt.create({
    data: { paymentId: payment.id, receiptNumber: generateReceiptNumber(), issuedByUserId: generics.admin.user.id },
  });

  // Real (not 404-shaped) fee/payment/receipt fixtures for disjointStudent
  // too — the receipt route resolves canReadPayment -> canReadStudentFinancials
  // by first looking up a real payment row. Without a real payment here, a
  // "denied" assertion on that route would trivially pass via "payment not
  // found" (also a 403 today per canReadPayment's `if (!payment) return
  // false`) instead of actually exercising the role-membership denial this
  // is meant to prove.
  const disjointFeeObligation = await prisma.feeObligation.create({
    data: {
      studentId: disjointStudent.id,
      feeStructureId: feeStructure.id,
      academicSessionId: session.id,
      amountDueKobo: 5_000_00,
      createdByUserId: generics.admin.user.id,
    },
  });
  const disjointPayment = await prisma.payment.create({
    data: {
      feeObligationId: disjointFeeObligation.id,
      amountKobo: 5_000_00,
      paymentDate: new Date(),
      status: "CONFIRMED",
      recordedByUserId: generics.admin.user.id,
      confirmedByUserId: generics.admin.user.id,
      confirmedAt: new Date(),
    },
  });
  await prisma.receipt.create({
    data: {
      paymentId: disjointPayment.id,
      receiptNumber: generateReceiptNumber(),
      issuedByUserId: generics.admin.user.id,
    },
  });

  const studentScopeTokens: Partial<Record<ActorKey, string>> = {
    admin: generics.admin.token,
    bursar: generics.bursar.token,
    assignedTeacher: assignedTeacherToken,
    unassignedTeacher: generics.teacher.token,
    linkedParent: linkedParentToken,
    unlinkedParent: generics.parent.token,
    ownStudent: ownStudentToken,
    otherStudent: generics.student.token,
    staffParent: staffParent.token,
  };

  return {
    session,
    term,
    class: klass,
    subject,
    targetStudent,
    assignment,
    component,
    assignedTeacherStaff,
    assignedTeacherToken,
    payment,
    studentScopeTokens,
    staffParentToken: staffParent.token,
    staffParentAssignment,
    disjointStudent,
    disjointPayment,
    formTeacherToken,
    targetResult,
  };
}

const STUDENT_SCOPE_CASES: MatrixCase[] = [
  { actor: "unauthenticated", expectedStatus: 401 },
  { actor: "admin", expectedStatus: "allowed" },
  { actor: "bursar", expectedStatus: 403 },
  { actor: "assignedTeacher", expectedStatus: "allowed" },
  { actor: "unassignedTeacher", expectedStatus: 403 },
  { actor: "linkedParent", expectedStatus: "allowed" },
  { actor: "unlinkedParent", expectedStatus: 403 },
  { actor: "ownStudent", expectedStatus: "allowed" },
  { actor: "otherStudent", expectedStatus: 403 },
  // A user who is also TEACHER elsewhere must still get through here on the
  // strength of their PARENT link alone — proves canReadStudent's PARENT
  // branch isn't suppressed by an earlier branch matching a role they also
  // happen to hold but that isn't what's granting access on this row.
  { actor: "staffParent", expectedStatus: "allowed" },
];

/// canReadStudentFinancials is deliberately narrower than canReadStudent:
/// BURSAR instead of TEACHER. Even the assigned teacher is denied here —
/// that's the point of the row, not a bug in it.
const STUDENT_FINANCIALS_SCOPE_CASES: MatrixCase[] = [
  { actor: "unauthenticated", expectedStatus: 401 },
  { actor: "admin", expectedStatus: "allowed" },
  { actor: "bursar", expectedStatus: "allowed" },
  { actor: "assignedTeacher", expectedStatus: 403 },
  { actor: "unassignedTeacher", expectedStatus: 403 },
  { actor: "linkedParent", expectedStatus: "allowed" },
  { actor: "unlinkedParent", expectedStatus: 403 },
  { actor: "ownStudent", expectedStatus: "allowed" },
  { actor: "otherStudent", expectedStatus: 403 },
  // Same point as STUDENT_SCOPE_CASES above, on the narrower BURSAR-instead-
  // of-TEACHER resolver: staffParent holds TEACHER (which grants nothing
  // here) and PARENT (which does) — PARENT alone must be enough.
  { actor: "staffParent", expectedStatus: "allowed" },
];

/// canActOnAssignment sits behind requireRole("ADMIN", "TEACHER") — so
/// BURSAR/PARENT/STUDENT are rejected by the role gate itself, before the
/// scope resolver ever runs. unassignedTeacher passes the role gate but
/// fails the scope check: this is the exact "teacher writing scores for an
/// unassigned class-subject" case named in the coverage audit.
const ASSIGNMENT_SCOPE_CASES: MatrixCase[] = [
  { actor: "unauthenticated", expectedStatus: 401 },
  { actor: "admin", expectedStatus: "allowed" },
  { actor: "assignedTeacher", expectedStatus: "allowed" },
  { actor: "unassignedTeacher", expectedStatus: 403 },
  { actor: "bursar", expectedStatus: 403 },
  { actor: "unlinkedParent", expectedStatus: 403 },
  { actor: "otherStudent", expectedStatus: 403 },
];

/// canWriteClassTeacherComment sits behind requireRole("ADMIN", "TEACHER"),
/// same as canActOnAssignment. The sharp negative case here is
/// assignedTeacher: they teach a SUBJECT in this exact class (a real
/// ClassSubjectAssignment) but are not its form teacher — 403 for them is
/// what proves this resolver checks the form-teacher assignment
/// specifically, not "any teacher with some connection to this class."
/// unassignedTeacher (no connection at all) is the weaker, redundant-but-
/// cheap sanity check alongside it.
const CLASS_TEACHER_COMMENT_CASES: MatrixCase[] = [
  { actor: "unauthenticated", expectedStatus: 401 },
  { actor: "admin", expectedStatus: "allowed" },
  { actor: "formTeacher", expectedStatus: "allowed" },
  { actor: "assignedTeacher", expectedStatus: 403 },
  { actor: "unassignedTeacher", expectedStatus: 403 },
  { actor: "bursar", expectedStatus: 403 },
  { actor: "unlinkedParent", expectedStatus: 403 },
  { actor: "otherStudent", expectedStatus: 403 },
];

/// canReadStaff: ADMIN or self (staffId match) only. Neither role nor link
/// status distinguishes parent/student cases here, so only one representative
/// case of each is included.
const STAFF_SCOPE_CASES: MatrixCase[] = [
  { actor: "unauthenticated", expectedStatus: 401 },
  { actor: "admin", expectedStatus: "allowed" },
  { actor: "assignedTeacher", expectedStatus: "allowed" }, // self
  { actor: "unassignedTeacher", expectedStatus: 403 }, // a different staff member
  { actor: "bursar", expectedStatus: 403 },
  { actor: "unlinkedParent", expectedStatus: 403 },
  { actor: "otherStudent", expectedStatus: 403 },
];

/// canReadClassTimetable: ADMIN and ANY teacher (assigned or not — timetable
/// data isn't treated as sensitive), students/parents scoped to actual
/// enrollment/linkage, BURSAR denied. unassignedTeacher is "allowed" here —
/// unlike the assignment-scoped rows, that's the correct, deliberate
/// business rule for this route, not an oversight.
const TIMETABLE_SCOPE_CASES: MatrixCase[] = [
  { actor: "unauthenticated", expectedStatus: 401 },
  { actor: "admin", expectedStatus: "allowed" },
  { actor: "assignedTeacher", expectedStatus: "allowed" },
  { actor: "unassignedTeacher", expectedStatus: "allowed" },
  { actor: "bursar", expectedStatus: 403 },
  { actor: "linkedParent", expectedStatus: "allowed" },
  { actor: "unlinkedParent", expectedStatus: 403 },
  { actor: "ownStudent", expectedStatus: "allowed" },
  { actor: "otherStudent", expectedStatus: 403 },
];

/// The risk in the fall-through restructuring is over-permission (an OR that
/// accidentally grants), not under-permission — so "allowed" cases alone
/// don't prove it's safe. This is the denied-direction proof: staffParent
/// against disjointStudent, who they have neither a PARENT link to nor a
/// TEACHER assignment reaching. Both branches that COULD grant access are
/// actually evaluated (this student has real enrollments/fee data, not a
/// 404) and both correctly fail — confirming the OR of two denials is still
/// a denial, not "any held role passes."
const STAFF_PARENT_DENIED_DISJOINT_STUDENT: MatrixCase[] = [
  { actor: "staffParent", expectedStatus: 403 },
];

export async function buildBespokeRows(generics: GenericActors): Promise<MatrixRow[]> {
  const world = await buildSharedWorld(generics);

  const studentScopeRow = (name: string, path: string): MatrixRow => ({
    name,
    method: "get",
    cases: STUDENT_SCOPE_CASES,
    setup: () => Promise.resolve({ url: path, tokens: world.studentScopeTokens }),
  });

  const financialsScopeRow = (name: string, path: string): MatrixRow => ({
    name,
    method: "get",
    cases: STUDENT_FINANCIALS_SCOPE_CASES,
    setup: () => Promise.resolve({ url: path, tokens: world.studentScopeTokens }),
  });

  const staffScopeTokens: Partial<Record<ActorKey, string>> = {
    admin: generics.admin.token,
    assignedTeacher: world.assignedTeacherToken, // "self" for the staff/:id target below
    unassignedTeacher: generics.teacher.token, // a genuinely different staff member
    bursar: generics.bursar.token,
    unlinkedParent: generics.parent.token,
    otherStudent: generics.student.token,
  };

  const assignmentScopeTokens: Partial<Record<ActorKey, string>> = {
    admin: generics.admin.token,
    assignedTeacher: world.assignedTeacherToken,
    unassignedTeacher: generics.teacher.token,
    bursar: generics.bursar.token,
    unlinkedParent: generics.parent.token,
    otherStudent: generics.student.token,
  };

  const classTeacherCommentTokens: Partial<Record<ActorKey, string>> = {
    admin: generics.admin.token,
    formTeacher: world.formTeacherToken,
    assignedTeacher: world.assignedTeacherToken,
    unassignedTeacher: generics.teacher.token,
    bursar: generics.bursar.token,
    unlinkedParent: generics.parent.token,
    otherStudent: generics.student.token,
  };

  return [
    studentScopeRow("GET /api/students/:id", `/api/students/${world.targetStudent.id}`),
    studentScopeRow(
      "GET /api/students/:id/enrollments",
      `/api/students/${world.targetStudent.id}/enrollments`,
    ),
    studentScopeRow(
      "GET /api/students/:id/attendance",
      `/api/students/${world.targetStudent.id}/attendance`,
    ),
    studentScopeRow("GET /api/students/:id/scores", `/api/students/${world.targetStudent.id}/scores`),
    studentScopeRow(
      "GET /api/students/:id/madrassah-progress",
      `/api/students/${world.targetStudent.id}/madrassah-progress`,
    ),
    studentScopeRow(
      "GET /api/results/:studentId/:termId",
      `/api/results/${world.targetStudent.id}/${world.term.id}`,
    ),
    financialsScopeRow(
      "GET /api/students/:id/fee-obligations",
      `/api/students/${world.targetStudent.id}/fee-obligations`,
    ),
    financialsScopeRow(
      "GET /api/students/:id/payments",
      `/api/students/${world.targetStudent.id}/payments`,
    ),
    financialsScopeRow("GET /api/payments/:id/receipt", `/api/payments/${world.payment.id}/receipt`),
    {
      name: "GET /api/class-subject-assignments/:id/students",
      method: "get",
      cases: ASSIGNMENT_SCOPE_CASES,
      setup: () =>
        Promise.resolve({
          url: `/api/class-subject-assignments/${world.assignment.id}/students`,
          tokens: assignmentScopeTokens,
        }),
    },
    // Second row for the same route key, against staffParent's own
    // independent assignment: canActOnAssignment never even looks at
    // PARENT, so a staffParent "allowed" here can only be coming through
    // the TEACHER branch — proving the dual-role user's teacher-side access
    // works, isolated from the parent-side proof above. Deliberately not a
    // fresh entry in BESPOKE_ROUTE_KEYS (that list tracks which ROUTES have
    // matrix coverage, not how many fixtures exercise each one) — see the
    // Set-based comparison in authMatrix.test.ts's bookkeeping check.
    {
      name: "GET /api/class-subject-assignments/:id/students",
      method: "get",
      cases: [{ actor: "staffParent", expectedStatus: "allowed" }],
      setup: () =>
        Promise.resolve({
          url: `/api/class-subject-assignments/${world.staffParentAssignment.id}/students`,
          tokens: { staffParent: world.staffParentToken },
        }),
    },
    {
      name: "PUT /api/class-subject-assignments/:id/scores",
      method: "put",
      cases: ASSIGNMENT_SCOPE_CASES,
      setup: () =>
        Promise.resolve({
          url: `/api/class-subject-assignments/${world.assignment.id}/scores`,
          body: {
            termId: world.term.id,
            entries: [
              {
                studentId: world.targetStudent.id,
                assessmentComponentId: world.component.id,
                rawScore: 33,
              },
            ],
          },
          tokens: assignmentScopeTokens,
        }),
    },
    {
      name: "POST /api/class-subject-assignments/:id/scores/submit",
      method: "post",
      cases: ASSIGNMENT_SCOPE_CASES,
      setup: () =>
        Promise.resolve({
          url: `/api/class-subject-assignments/${world.assignment.id}/scores/submit`,
          body: { termId: world.term.id },
          tokens: assignmentScopeTokens,
        }),
    },
    {
      name: "GET /api/staff/:id",
      method: "get",
      cases: STAFF_SCOPE_CASES,
      setup: () =>
        Promise.resolve({ url: `/api/staff/${world.assignedTeacherStaff.id}`, tokens: staffScopeTokens }),
    },
    {
      name: "GET /api/staff/:id/timetable",
      method: "get",
      cases: STAFF_SCOPE_CASES,
      setup: () =>
        Promise.resolve({
          url: `/api/staff/${world.assignedTeacherStaff.id}/timetable`,
          tokens: staffScopeTokens,
        }),
    },
    {
      name: "GET /api/classes/:id/timetable",
      method: "get",
      cases: TIMETABLE_SCOPE_CASES,
      setup: () =>
        Promise.resolve({
          url: `/api/classes/${world.class.id}/timetable`,
          tokens: world.studentScopeTokens,
        }),
    },
    {
      name: "PATCH /api/results/:id/class-teacher-comment",
      method: "patch",
      cases: CLASS_TEACHER_COMMENT_CASES,
      setup: () =>
        Promise.resolve({
          url: `/api/results/${world.targetResult.id}/class-teacher-comment`,
          body: { comment: "Matrix test comment" },
          tokens: classTeacherCommentTokens,
        }),
    },

    // --- staffParent denied on a genuinely disjoint student -------------
    // Mirror-image of every "staffParent: allowed" case above, now against
    // disjointStudent: not staffParent's child, not enrolled in any class
    // they teach. "GET /api/students/:id" is the one that most directly
    // demonstrates BOTH of canReadStudent's grantable branches (PARENT-link
    // and TEACHER-assignment) being evaluated and BOTH failing — the other
    // canReadStudent rows exercise the identical resolver call and are
    // included for parity with the "allowed" side's coverage, not because
    // they add new resolver-logic signal beyond the first.
    //
    // Deliberately NOT mirrored here: GET /api/classes/:id/timetable.
    // canReadClassTimetable's business rule (TIMETABLE_SCOPE_CASES's own
    // comment) is that ANY teacher — assigned or not — may view ANY class's
    // timetable; timetables aren't treated as sensitive. staffParent holds
    // TEACHER, so they are CORRECTLY "allowed" on disjointStudent's class
    // timetable too. A "denied" expectation there would assert behavior
    // this resolver was never supposed to have — flagging it instead of
    // adding a case that contradicts the documented, intentional rule.
    {
      name: "GET /api/students/:id",
      method: "get",
      cases: STAFF_PARENT_DENIED_DISJOINT_STUDENT,
      setup: () =>
        Promise.resolve({
          url: `/api/students/${world.disjointStudent.id}`,
          tokens: { staffParent: world.staffParentToken },
        }),
    },
    {
      name: "GET /api/students/:id/enrollments",
      method: "get",
      cases: STAFF_PARENT_DENIED_DISJOINT_STUDENT,
      setup: () =>
        Promise.resolve({
          url: `/api/students/${world.disjointStudent.id}/enrollments`,
          tokens: { staffParent: world.staffParentToken },
        }),
    },
    {
      name: "GET /api/students/:id/attendance",
      method: "get",
      cases: STAFF_PARENT_DENIED_DISJOINT_STUDENT,
      setup: () =>
        Promise.resolve({
          url: `/api/students/${world.disjointStudent.id}/attendance`,
          tokens: { staffParent: world.staffParentToken },
        }),
    },
    {
      name: "GET /api/students/:id/scores",
      method: "get",
      cases: STAFF_PARENT_DENIED_DISJOINT_STUDENT,
      setup: () =>
        Promise.resolve({
          url: `/api/students/${world.disjointStudent.id}/scores`,
          tokens: { staffParent: world.staffParentToken },
        }),
    },
    {
      name: "GET /api/students/:id/madrassah-progress",
      method: "get",
      cases: STAFF_PARENT_DENIED_DISJOINT_STUDENT,
      setup: () =>
        Promise.resolve({
          url: `/api/students/${world.disjointStudent.id}/madrassah-progress`,
          tokens: { staffParent: world.staffParentToken },
        }),
    },
    {
      name: "GET /api/results/:studentId/:termId",
      method: "get",
      cases: STAFF_PARENT_DENIED_DISJOINT_STUDENT,
      setup: () =>
        Promise.resolve({
          url: `/api/results/${world.disjointStudent.id}/${world.term.id}`,
          tokens: { staffParent: world.staffParentToken },
        }),
    },
    {
      name: "GET /api/students/:id/fee-obligations",
      method: "get",
      cases: STAFF_PARENT_DENIED_DISJOINT_STUDENT,
      setup: () =>
        Promise.resolve({
          url: `/api/students/${world.disjointStudent.id}/fee-obligations`,
          tokens: { staffParent: world.staffParentToken },
        }),
    },
    {
      name: "GET /api/students/:id/payments",
      method: "get",
      cases: STAFF_PARENT_DENIED_DISJOINT_STUDENT,
      setup: () =>
        Promise.resolve({
          url: `/api/students/${world.disjointStudent.id}/payments`,
          tokens: { staffParent: world.staffParentToken },
        }),
    },
    {
      name: "GET /api/payments/:id/receipt",
      method: "get",
      cases: STAFF_PARENT_DENIED_DISJOINT_STUDENT,
      setup: () =>
        Promise.resolve({
          url: `/api/payments/${world.disjointPayment.id}/receipt`,
          tokens: { staffParent: world.staffParentToken },
        }),
    },
  ];
}
