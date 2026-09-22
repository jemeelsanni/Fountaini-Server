// Demo dataset for the frontend developer — a separate script from
// prisma/seed.ts on purpose (see that file's own scope: bootstrap admin +
// Surah + rating scale only, the minimal set CI runs against real
// migrations). This script builds realistic data covering every role and
// every interesting state, with one known password for every account.
//
// Run via `npm run db:seed:demo`. Designed for a fresh database, right
// after `prisma migrate reset` (or `--force`) and `npm run db:seed`.
//
// ---------------------------------------------------------------------------
// Guard 1: never run against production without an explicit override.
// ---------------------------------------------------------------------------
// Checked before anything else, including before any import that might
// itself talk to a database — a bare `process.env` read has no dependency
// on module load order the way the NOTIFICATION_PROVIDER guard below does.
if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "true") {
  console.error(
    [
      "",
      "Refusing to run against production (NODE_ENV=production) without ALLOW_DEMO_SEED=true.",
      "",
      "This is not a generic safety default — the reason is specific: IdentifierCounter only",
      "moves forward and admission/staff numbers are never reused. Every demo student and staff",
      "member this script creates permanently consumes a number from the real sequence. If this",
      "runs in production, the school's first real student becomes FIA/2026/011 instead of",
      "FIA/2026/001 — permanently, with no way to undo it short of a full reset.",
      "",
      "Set ALLOW_DEMO_SEED=true explicitly if you mean to run this against production anyway —",
      "e.g. the one-time demo dataset before the school enters real records (see",
      "docs/demo-credentials.md for that sequence).",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
if (process.env.NODE_ENV === "production") {
  console.warn(
    [
      "",
      "ALLOW_DEMO_SEED=true set — proceeding against production.",
      "Reminder: every admission/staff number this run consumes is permanent (IdentifierCounter",
      "never reuses one), so this is only safe while the school holds no real records yet.",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Guard 2: force the console notification provider, regardless of the
// environment's own NOTIFICATION_PROVIDER — before any service import.
// ---------------------------------------------------------------------------
// src/modules/notifications/notifications.service.ts picks its provider
// with a top-level `const provider = env.NOTIFICATION_PROVIDER === "resend"
// ? new ResendNotificationProvider() : ...`, and env.ts parses process.env
// once, at import time. Every service function this script calls
// transitively imports env.ts via src/db/client.ts. A static top-of-file
// `import` would be hoisted above this assignment regardless of where it's
// textually written, so every import below is dynamic — the same fix
// vitest.setup.ts already uses for the identical ordering problem. Setting
// this here means it holds even if someone runs `npx tsx prisma/seed-demo.ts`
// directly, bypassing the npm script's own env prefix.
process.env.NOTIFICATION_PROVIDER = "console";

// Same ordering requirement as NOTIFICATION_PROVIDER above — src/db/client.ts
// reads DB_TRANSACTION_TIMEOUT_MS (via env.ts) at PrismaClient construction
// time. Prisma's own default (5000ms) is sized for same-region server-to-
// database traffic; this script runs directly against Railway's public
// proxy, where a single round trip has been measured at 320-700ms and the
// heaviest transaction on this script's path (finalizeResult's class-wide
// ranking pass) runs on the order of 14 round trips — comfortably under
// 30s, with no real margin left at 5s. See config/env.ts's own comment.
process.env.DB_TRANSACTION_TIMEOUT_MS = "30000";
// Separate from timeout above: maxWait bounds getting a connection and
// sending BEGIN in the first place, not the transaction's own duration
// once open. Prisma's 2000ms default was the actual failure the first fix
// missed — a cold connection to Railway's public proxy has been measured
// at 2.2-3.4s for its very first round trip alone, already past 2000ms
// before any query inside the transaction runs.
process.env.DB_TRANSACTION_MAX_WAIT_MS = "15000";
// Suppresses CREDENTIALS_ISSUED notifications specifically (not
// notifications generally) — see config/env.ts's own comment on why.
process.env.SUPPRESS_CREDENTIAL_NOTIFICATIONS = "true";

const { prisma } = await import("../src/db/client.js");
const { drainFireAndForget } = await import("../src/lib/fireAndForget.js");
const { hashPassword } = await import("../src/modules/auth/password.js");
const academicStructure = await import("../src/modules/academic-structure/academic-structure.service.js");
const grading = await import("../src/modules/grading/grading.service.js");
const ratings = await import("../src/modules/ratings/ratings.service.js");
const timetable = await import("../src/modules/timetable/timetable.service.js");
const staffService = await import("../src/modules/staff/staff.service.js");
const studentsService = await import("../src/modules/students/students.service.js");
const parentsService = await import("../src/modules/parents/parents.service.js");
const scoresService = await import("../src/modules/scores/scores.service.js");
const attendanceService = await import("../src/modules/attendance/attendance.service.js");
const resultsService = await import("../src/modules/results/results.service.js");
const feesService = await import("../src/modules/fees/fees.service.js");
const madrassahService = await import("../src/modules/madrassah/madrassah.service.js");
const admissionsService = await import("../src/modules/admissions/admissions.service.js");
const notificationsService = await import("../src/modules/notifications/notifications.service.js");
const auditService = await import("../src/modules/audit/audit.service.js");
const identifiersService = await import("../src/modules/identifiers/identifiers.service.js");

const DEMO_PASSWORD = "Demo@2026!";
const EMAIL_DOMAIN = "example.com"; // IANA-reserved, undeliverable — second safeguard alongside the console provider.

interface CredentialRow {
  role: string;
  name: string;
  loginId: string;
  password: string;
  notes: string;
}
const credentialRows: CredentialRow[] = [];

interface DemoSeedManifest {
  createdAt: string;
  userIds: string[];
  staffIds: string[];
  staffNumbers: string[];
  parentIds: string[];
  studentIds: string[];
  admissionNumbers: string[];
  academicSessionIds: string[];
  termIds: string[];
  classIds: string[];
  subjectIds: string[];
  assessmentComponentIds: string[];
  gradingScaleIds: string[];
  traitIds: string[];
  timeSlotIds: string[];
  classSubjectAssignmentIds: string[];
  classFormTeacherIds: string[];
  timetableEntryIds: string[];
  feeStructureIds: string[];
  attendanceSessionIds: string[];
  admissionEnquiryIds: string[];
}
const manifest: DemoSeedManifest = {
  createdAt: new Date().toISOString(),
  userIds: [],
  staffIds: [],
  staffNumbers: [],
  parentIds: [],
  studentIds: [],
  admissionNumbers: [],
  academicSessionIds: [],
  termIds: [],
  classIds: [],
  subjectIds: [],
  assessmentComponentIds: [],
  gradingScaleIds: [],
  traitIds: [],
  timeSlotIds: [],
  classSubjectAssignmentIds: [],
  classFormTeacherIds: [],
  timetableEntryIds: [],
  feeStructureIds: [],
  attendanceSessionIds: [],
  admissionEnquiryIds: [],
};

function naira(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString("en-NG")}`;
}

// ---------------------------------------------------------------------------
// Guard 3: refuse to double-seed.
// ---------------------------------------------------------------------------
async function guardAgainstDoubleSeed(): Promise<void> {
  const existing = await prisma.student.count();
  if (existing > 0) {
    console.error(
      [
        "",
        `Refusing to run: ${existing} Student row(s) already exist.`,
        "This script is designed to run once, against a fresh database (after `prisma migrate",
        "reset` and `npm run db:seed`) — running it again would consume a fresh batch of",
        "admission/staff numbers on top of whatever's already there, and the resulting dataset",
        "would no longer match what prisma/wipe-demo.ts expects to find.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 1. Academic structure
// ---------------------------------------------------------------------------
async function seedAcademicStructure() {
  const session = await academicStructure.createAcademicSession({
    name: "2026/2027",
    startDate: new Date("2026-09-01"),
    endDate: new Date("2027-07-31"),
  });
  await academicStructure.setCurrentAcademicSession(session.id);
  manifest.academicSessionIds.push(session.id);

  const term1 = await academicStructure.createTerm(session.id, {
    name: "First Term",
    order: 1,
    startDate: new Date("2026-09-01"),
    endDate: new Date("2026-12-12"),
  });
  const term2 = await academicStructure.createTerm(session.id, {
    name: "Second Term",
    order: 2,
    startDate: new Date("2027-01-05"),
    endDate: new Date("2027-04-02"),
  });
  const term3 = await academicStructure.createTerm(session.id, {
    name: "Third Term",
    order: 3,
    startDate: new Date("2027-04-20"),
    endDate: new Date("2027-07-24"),
  });
  await academicStructure.setCurrentTerm(term1.id);
  manifest.termIds.push(term1.id, term2.id, term3.id);

  const jss1a = await academicStructure.createClass({ gradeName: "JSS1", arm: "A", order: 1 });
  const jss1b = await academicStructure.createClass({ gradeName: "JSS1", arm: "B", order: 2 });
  const jss2a = await academicStructure.createClass({ gradeName: "JSS2", arm: "A", order: 1 });
  manifest.classIds.push(jss1a.id, jss1b.id, jss2a.id);

  const mathematics = await academicStructure.createSubject({ name: "Mathematics", code: "MTH", type: "ACADEMIC" });
  const english = await academicStructure.createSubject({ name: "English Language", code: "ENG", type: "ACADEMIC" });
  const basicScience = await academicStructure.createSubject({ name: "Basic Science", code: "BSC", type: "ACADEMIC" });
  const islamicStudies = await academicStructure.createSubject({ name: "Islamic Studies", code: "ISL", type: "ACADEMIC" });
  const quran = await academicStructure.createSubject({ name: "Qur'an Memorisation", code: "QRM", type: "MADRASSAH" });
  manifest.subjectIds.push(mathematics.id, english.id, basicScience.id, islamicStudies.id, quran.id);

  const ca1 = await grading.createAssessmentComponent(session.id, { code: "CA1", name: "First Continuous Assessment", type: "CA", maxScore: 20, order: 1 });
  const ca2 = await grading.createAssessmentComponent(session.id, { code: "CA2", name: "Second Continuous Assessment", type: "CA", maxScore: 20, order: 2 });
  const exam = await grading.createAssessmentComponent(session.id, { code: "EXAM", name: "Examination", type: "EXAM", maxScore: 60, order: 3 });
  manifest.assessmentComponentIds.push(ca1.id, ca2.id, exam.id);

  const gradingScale = await grading.createGradingScale(session.id, { sessionAverageMethod: "SESSION_AVERAGE" });
  manifest.gradingScaleIds.push(gradingScale.id);
  const bands: Array<{ grade: string; minScore: number; maxScore: number; remark: string; gradePoint: number }> = [
    { grade: "A", minScore: 70, maxScore: 100, remark: "Excellent", gradePoint: 4 },
    { grade: "B", minScore: 60, maxScore: 69.99, remark: "Very Good", gradePoint: 3 },
    { grade: "C", minScore: 50, maxScore: 59.99, remark: "Good", gradePoint: 2 },
    { grade: "D", minScore: 40, maxScore: 49.99, remark: "Pass", gradePoint: 1 },
    { grade: "F", minScore: 0, maxScore: 39.99, remark: "Fail", gradePoint: 0 },
  ];
  for (const band of bands) {
    await grading.createGradeBand(gradingScale.id, band);
  }

  const affectiveTraits = ["Punctuality", "Neatness", "Politeness", "Attentiveness in Class"];
  const psychomotorTraits = ["Handwriting", "Games and Sports", "Drawing and Painting", "Verbal Fluency"];
  const traits: Record<string, Awaited<ReturnType<typeof ratings.createTrait>>> = {};
  for (const [index, name] of affectiveTraits.entries()) {
    const trait = await ratings.createTrait(session.id, { category: "AFFECTIVE", name, order: index + 1 });
    traits[name] = trait;
    manifest.traitIds.push(trait.id);
  }
  for (const [index, name] of psychomotorTraits.entries()) {
    const trait = await ratings.createTrait(session.id, { category: "PSYCHOMOTOR", name, order: index + 1 });
    traits[name] = trait;
    manifest.traitIds.push(trait.id);
  }

  const timeSlotDefs = [
    { name: "Period 1", startTime: "08:00", endTime: "08:40" },
    { name: "Period 2", startTime: "08:40", endTime: "09:20" },
    { name: "Period 3", startTime: "09:40", endTime: "10:20" },
    { name: "Period 4", startTime: "10:20", endTime: "11:00" },
    { name: "Period 5", startTime: "11:00", endTime: "11:40" },
    { name: "Period 6", startTime: "11:40", endTime: "12:20" },
  ];
  const timeSlots = [];
  for (const [index, slot] of timeSlotDefs.entries()) {
    const created = await timetable.createTimeSlot({ ...slot, order: index + 1 });
    timeSlots.push(created);
    manifest.timeSlotIds.push(created.id);
  }

  console.log(`Academic structure: session ${session.name}, 3 terms, 3 classes, 5 subjects, grading scale, 8 traits, 6 time slots.`);

  return {
    session,
    term1,
    term2,
    term3,
    jss1a,
    jss1b,
    jss2a,
    mathematics,
    english,
    basicScience,
    islamicStudies,
    quran,
    gradingScale,
    traits,
    timeSlots,
  };
}

// ---------------------------------------------------------------------------
// 2. Staff — every role and relationship
// ---------------------------------------------------------------------------
async function seedStaff() {
  async function staff(role: "ADMIN" | "TEACHER" | "BURSAR", firstName: string, lastName: string, department?: string) {
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${EMAIL_DOMAIN}`;
    const created = await staffService.createStaff({ role, email, firstName, lastName, department });
    manifest.staffIds.push(created.id);
    manifest.staffNumbers.push(created.staffNumber);
    manifest.userIds.push(created.userId);
    return created;
  }

  const admin = await staff("ADMIN", "Abdulrahman", "Yusuf", "Administration");
  const bursar = await staff("BURSAR", "Maryam", "Abubakar", "Finance");
  const formTeacherJss1a = await staff("TEACHER", "Ibrahim", "Suleiman", "Academics");
  const subjectTeacherJss1a = await staff("TEACHER", "Hadiza", "Lawal", "Academics");
  const madrassahTeacher = await staff("TEACHER", "Salihu", "Mohammed", "Madrassah");
  const teacherParent = await staff("TEACHER", "Zainab", "Ahmad", "Academics");
  const mustChangeTeacher = await staff("TEACHER", "Nasiru", "Danladi", "Academics");

  console.log("Staff: 1 admin, 1 bursar, 5 teachers (form teacher, subject teacher, Madrassah, teacher-parent, forced-change).");

  return { admin, bursar, formTeacherJss1a, subjectTeacherJss1a, madrassahTeacher, teacherParent, mustChangeTeacher };
}

// ---------------------------------------------------------------------------
// 3. Students and parents
// ---------------------------------------------------------------------------
interface StudentPlan {
  key: string;
  firstName: string;
  lastName: string;
  classId: string;
  scorePerSubject: { ca1: number; ca2: number; exam: number }; // out of 20/20/60
}

async function createStudentBare(firstName: string, lastName: string) {
  const student = await studentsService.createStudent({ firstName, lastName });
  manifest.studentIds.push(student.id);
  manifest.admissionNumbers.push(student.admissionNumber);
  return student;
}

async function createParentAndLink(
  firstName: string,
  lastName: string,
  studentId: string,
  relationship: "FATHER" | "MOTHER" | "GUARDIAN",
  isPrimaryContact: boolean,
) {
  const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${EMAIL_DOMAIN}`;
  const parent = await parentsService.createParent({ email, firstName, lastName });
  manifest.parentIds.push(parent.id);
  manifest.userIds.push(parent.userId);
  await parentsService.linkChild(parent.id, { studentId, relationship, isPrimaryContact });
  return parent;
}

async function seedStudentsAndParents(structure: Awaited<ReturnType<typeof seedAcademicStructure>>) {
  // --- JSS1A: 8 students, ranks 1-8 with a tie at 3rd (both students 3 and 4
  // get the identical per-subject score, so the tie is robust regardless of
  // whether Result.totalScore is a sum or an average of the 4 subjects). ---
  const jss1aPlans: StudentPlan[] = [
    { key: "aisha", firstName: "Aisha", lastName: "Abdullahi", classId: structure.jss1a.id, scorePerSubject: { ca1: 18, ca2: 17, exam: 50 } }, // 85 -> rank 1
    { key: "ibrahimS", firstName: "Ibrahim", lastName: "Sule", classId: structure.jss1a.id, scorePerSubject: { ca1: 16, ca2: 16, exam: 48 } }, // 80 -> rank 2
    { key: "fatima", firstName: "Fatima", lastName: "Bello", classId: structure.jss1a.id, scorePerSubject: { ca1: 15, ca2: 15, exam: 45 } }, // 75 -> rank 3 (tie)
    { key: "yusuf", firstName: "Yusuf", lastName: "Garba", classId: structure.jss1a.id, scorePerSubject: { ca1: 15, ca2: 15, exam: 45 } }, // 75 -> rank 3 (tie)
    { key: "khadija", firstName: "Khadija", lastName: "Umar", classId: structure.jss1a.id, scorePerSubject: { ca1: 14, ca2: 14, exam: 42 } }, // 70 -> rank 5
    { key: "musa", firstName: "Musa", lastName: "Aliyu", classId: structure.jss1a.id, scorePerSubject: { ca1: 13, ca2: 12, exam: 40 } }, // 65 -> rank 6
    { key: "zainabL", firstName: "Zainab", lastName: "Lawal", classId: structure.jss1a.id, scorePerSubject: { ca1: 12, ca2: 12, exam: 36 } }, // 60 -> rank 7
    { key: "suleiman", firstName: "Suleiman", lastName: "Bala", classId: structure.jss1a.id, scorePerSubject: { ca1: 11, ca2: 11, exam: 33 } }, // 55 -> rank 8
  ];
  const jss1a: Record<string, Awaited<ReturnType<typeof createStudentBare>>> = {};
  for (const plan of jss1aPlans) {
    jss1a[plan.key] = await createStudentBare(plan.firstName, plan.lastName);
    await studentsService.createEnrollment(jss1a[plan.key]!.id, { classId: plan.classId, academicSessionId: structure.session.id });
  }

  // --- JSS1B: 4 students, scores entered but never submitted. ---
  const jss1bPlans: StudentPlan[] = [
    { key: "hauwa", firstName: "Hauwa", lastName: "Bello", classId: structure.jss1b.id, scorePerSubject: { ca1: 14, ca2: 14, exam: 40 } },
    { key: "abdullahiS", firstName: "Abdullahi", lastName: "Sani", classId: structure.jss1b.id, scorePerSubject: { ca1: 15, ca2: 14, exam: 44 } },
    { key: "maryam", firstName: "Maryam", lastName: "Yusuf", classId: structure.jss1b.id, scorePerSubject: { ca1: 13, ca2: 13, exam: 38 } },
    { key: "halima", firstName: "Halima", lastName: "Auwal", classId: structure.jss1b.id, scorePerSubject: { ca1: 12, ca2: 13, exam: 39 } },
  ];
  const jss1b: Record<string, Awaited<ReturnType<typeof createStudentBare>>> = {};
  for (const plan of jss1bPlans) {
    jss1b[plan.key] = await createStudentBare(plan.firstName, plan.lastName);
    await studentsService.createEnrollment(jss1b[plan.key]!.id, { classId: plan.classId, academicSessionId: structure.session.id });
  }

  // --- Parents ---
  // Alhaji Bello Sani: two children in different classes (Fatima in JSS1A,
  // Hauwa in JSS1B) — the child switcher.
  const twoKidsParent = await createParentAndLink("Bello", "Sani", jss1a.fatima!.id, "FATHER", true);
  await parentsService.linkChild(twoKidsParent.id, { studentId: jss1b.hauwa!.id, relationship: "FATHER", isPrimaryContact: true });

  // Hajiya Fatima Idris: one child (Aisha, fully-paid rank 1).
  await createParentAndLink("Fatima", "Idris", jss1a.aisha!.id, "MOTHER", true);

  // Single parents for the rest of the JSS1A fee-scenario roster.
  await createParentAndLink("Tanko", "Sule", jss1a.ibrahimS!.id, "FATHER", true);
  await createParentAndLink("Ladi", "Garba", jss1a.yusuf!.id, "MOTHER", true);
  await createParentAndLink("Umar", "Yakubu", jss1a.khadija!.id, "FATHER", true);
  await createParentAndLink("Aisha", "Aliyu", jss1a.musa!.id, "MOTHER", true);
  await createParentAndLink("Bala", "Ibrahim", jss1a.suleiman!.id, "FATHER", true);

  // Zainab Lawal: two parents, one primary and one not.
  const primaryParent = await createParentAndLink("Sani", "Garba", jss1a.zainabL!.id, "FATHER", true);
  const secondaryParent = await parentsService.createParent({
    email: "amina.garba@" + EMAIL_DOMAIN,
    firstName: "Amina",
    lastName: "Garba",
  });
  manifest.parentIds.push(secondaryParent.id);
  manifest.userIds.push(secondaryParent.userId);
  await parentsService.linkChild(secondaryParent.id, { studentId: jss1a.zainabL!.id, relationship: "MOTHER", isPrimaryContact: false });

  // Abdullahi Sani (JSS1B): child of the teacher-parent, linked after staff
  // creation in main() once teacherParent's Parent record exists.

  // Maryam Yusuf (JSS1B): normal single parent.
  await createParentAndLink("Kande", "Yusuf", jss1b.maryam!.id, "MOTHER", true);

  // Halima Auwal (JSS1B): deliberately left unlinked — no parent, no login
  // yet. Nothing to do here.

  console.log(
    `Students: ${jss1aPlans.length} in JSS1A (2 tied on total), ${jss1bPlans.length} in JSS1B ` +
      `(1 unlinked). Parents: two-children, one-child, two-parents-one-primary, and singles.`,
  );

  return { jss1a, jss1b, jss1aPlans, jss1bPlans, twoKidsParent, primaryParent, secondaryParent };
}

// ---------------------------------------------------------------------------
// 4. Class-subject assignments, form teacher, timetable
// ---------------------------------------------------------------------------
async function seedAssignments(
  structure: Awaited<ReturnType<typeof seedAcademicStructure>>,
  staff: Awaited<ReturnType<typeof seedStaff>>,
) {
  const formTeacher = await academicStructure.createClassFormTeacher({
    classId: structure.jss1a.id,
    teacherId: staff.formTeacherJss1a.id,
    academicSessionId: structure.session.id,
  });
  manifest.classFormTeacherIds.push(formTeacher.id);

  const mathsJss1a = await academicStructure.createClassSubjectAssignment({
    classId: structure.jss1a.id,
    subjectId: structure.mathematics.id,
    teacherId: staff.formTeacherJss1a.id,
    academicSessionId: structure.session.id,
  });
  const englishJss1a = await academicStructure.createClassSubjectAssignment({
    classId: structure.jss1a.id,
    subjectId: structure.english.id,
    teacherId: staff.subjectTeacherJss1a.id,
    academicSessionId: structure.session.id,
  });
  const scienceJss1a = await academicStructure.createClassSubjectAssignment({
    classId: structure.jss1a.id,
    subjectId: structure.basicScience.id,
    teacherId: staff.teacherParent.id,
    academicSessionId: structure.session.id,
  });
  const islamicJss1a = await academicStructure.createClassSubjectAssignment({
    classId: structure.jss1a.id,
    subjectId: structure.islamicStudies.id,
    teacherId: staff.admin.id,
    academicSessionId: structure.session.id,
  });
  const mathsJss1b = await academicStructure.createClassSubjectAssignment({
    classId: structure.jss1b.id,
    subjectId: structure.mathematics.id,
    teacherId: staff.formTeacherJss1a.id,
    academicSessionId: structure.session.id,
  });
  manifest.classSubjectAssignmentIds.push(mathsJss1a.id, englishJss1a.id, scienceJss1a.id, islamicJss1a.id, mathsJss1b.id);

  // Timetable for JSS1A only, covering the week — one assignment per day,
  // rotating through the four subjects.
  const jss1aAssignments = [mathsJss1a, englishJss1a, scienceJss1a, islamicJss1a];
  const days: Array<"MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY"> = [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
  ];
  for (const [index, day] of days.entries()) {
    const assignment = jss1aAssignments[index % jss1aAssignments.length]!;
    const entry = await timetable.createTimetableEntry({
      classSubjectAssignmentId: assignment.id,
      timeSlotId: structure.timeSlots[index % structure.timeSlots.length]!.id,
      dayOfWeek: day,
    });
    manifest.timetableEntryIds.push(entry.id);
  }

  console.log("Assignments: form teacher + 4 subject assignments in JSS1A, 1 in JSS1B, timetable for the week.");

  return { mathsJss1a, englishJss1a, scienceJss1a, islamicJss1a, mathsJss1b };
}

// ---------------------------------------------------------------------------
// 5. Scores, attendance, ratings, comments, finalize, override, release
// ---------------------------------------------------------------------------
async function seedScoresAttendanceAndResults(
  structure: Awaited<ReturnType<typeof seedAcademicStructure>>,
  staff: Awaited<ReturnType<typeof seedStaff>>,
  students: Awaited<ReturnType<typeof seedStudentsAndParents>>,
  assignments: Awaited<ReturnType<typeof seedAssignments>>,
) {
  const actorUserId = staff.admin.userId;

  // --- JSS1A: enter + submit scores for all 4 subjects, all 8 students. ---
  for (const assignment of [assignments.mathsJss1a, assignments.englishJss1a, assignments.scienceJss1a, assignments.islamicJss1a]) {
    const componentEntries = [
      { code: "ca1" as const, id: (await prisma.assessmentComponent.findFirstOrThrow({ where: { code: "CA1", academicSessionId: structure.session.id } })).id },
      { code: "ca2" as const, id: (await prisma.assessmentComponent.findFirstOrThrow({ where: { code: "CA2", academicSessionId: structure.session.id } })).id },
      { code: "exam" as const, id: (await prisma.assessmentComponent.findFirstOrThrow({ where: { code: "EXAM", academicSessionId: structure.session.id } })).id },
    ];
    const scoreEntries = students.jss1aPlans.flatMap((plan) =>
      componentEntries.map((component) => ({
        studentId: students.jss1a[plan.key]!.id,
        assessmentComponentId: component.id,
        rawScore: plan.scorePerSubject[component.code],
      })),
    );
    await scoresService.bulkUpsertScores(assignment.id, actorUserId, { termId: structure.term1.id, entries: scoreEntries });
    await scoresService.submitScores(assignment.id, actorUserId, structure.term1.id);
  }

  // --- JSS1B: enter scores for the one assignment, never submit. ---
  const jss1bComponents = [
    { code: "ca1" as const, id: (await prisma.assessmentComponent.findFirstOrThrow({ where: { code: "CA1", academicSessionId: structure.session.id } })).id },
    { code: "ca2" as const, id: (await prisma.assessmentComponent.findFirstOrThrow({ where: { code: "CA2", academicSessionId: structure.session.id } })).id },
    { code: "exam" as const, id: (await prisma.assessmentComponent.findFirstOrThrow({ where: { code: "EXAM", academicSessionId: structure.session.id } })).id },
  ];
  const jss1bScoreEntries = students.jss1bPlans.flatMap((plan) =>
    jss1bComponents.map((component) => ({
      studentId: students.jss1b[plan.key]!.id,
      assessmentComponentId: component.id,
      rawScore: plan.scorePerSubject[component.code],
    })),
  );
  await scoresService.bulkUpsertScores(assignments.mathsJss1b.id, actorUserId, { termId: structure.term1.id, entries: jss1bScoreEntries });
  // Deliberately no submitScores() call here — this is the DRAFT state.

  // --- Attendance: rotate QR codes, 4 closed sessions + 1 open, for JSS1A. ---
  for (const plan of students.jss1aPlans) {
    await attendanceService.rotateQrCode(students.jss1a[plan.key]!.id);
  }
  const attendanceDates = [
    new Date("2026-09-07"),
    new Date("2026-09-08"),
    new Date("2026-09-09"),
    new Date("2026-09-10"),
  ];
  for (const [dayIndex, date] of attendanceDates.entries()) {
    const session = await attendanceService.openSession(actorUserId, {
      classId: structure.jss1a.id,
      academicSessionId: structure.session.id,
      termId: structure.term1.id,
      date,
    });
    manifest.attendanceSessionIds.push(session.id);

    for (const plan of students.jss1aPlans) {
      const student = students.jss1a[plan.key]!;
      // Musa Aliyu is deliberately never scanned on day 3 — closeSession
      // marks him ABSENT automatically. Ibrahim Sule is scanned LATE on
      // day 2, to confirm LATE still counts toward daysPresent.
      if (dayIndex === 2 && plan.key === "musa") {
        continue;
      }
      const qr = await attendanceService.getActiveQrCode(student.id);
      const late = dayIndex === 1 && plan.key === "ibrahimS";
      await attendanceService.scan(session.id, actorUserId, { code: qr!.code, late });
    }
    await attendanceService.closeSession(session.id, actorUserId);
  }
  // One more, left OPEN, for a live QR-scan demo.
  const openSession = await attendanceService.openSession(actorUserId, {
    classId: structure.jss1a.id,
    academicSessionId: structure.session.id,
    termId: structure.term1.id,
    date: new Date("2026-09-11"),
  });
  manifest.attendanceSessionIds.push(openSession.id);

  // --- Compute DRAFT results for JSS1A (JSS1B stays with no Result row at
  // all — scores were never submitted, so a parent request 404s). ---
  await resultsService.computeResultsForClass({ classId: structure.jss1a.id, termId: structure.term1.id });

  // --- Ratings, while Results are still DRAFT. ---
  const traitIds = Object.values(structure.traits).map((t) => t.id);
  const ratingEntries = students.jss1aPlans.flatMap((plan, studentIndex) =>
    traitIds.map((traitId, traitIndex) => ({
      studentId: students.jss1a[plan.key]!.id,
      traitId,
      // A simple, varied but deterministic 1-5 spread — not meant to mean
      // anything beyond "realistic-looking demo data".
      value: ((studentIndex + traitIndex) % 5) + 1,
    })),
  );
  await ratings.bulkUpsertRatings(structure.jss1a.id, structure.term1.id, actorUserId, { entries: ratingEntries });

  // --- Class teacher + principal comments, while still DRAFT. ---
  const classTeacherComments: Record<string, string> = {
    aisha: "Aisha is an outstanding student who consistently performs at the top of her class. Keep it up.",
    ibrahimS: "Ibrahim shows strong effort across all subjects and continues to improve steadily.",
    fatima: "Fatima is diligent and works well with others. A pleasure to teach.",
    yusuf: "Yusuf shows good understanding but should pay closer attention during Mathematics.",
    khadija: "Khadija participates well in class but needs to improve her examination preparation.",
    musa: "Musa has the ability to do much better with more consistent attendance.",
    zainabL: "Zainab is respectful and hardworking; more revision at home would help her scores.",
    suleiman: "Suleiman needs closer support at home with his studies this term.",
  };
  const principalComments: Record<string, string> = {
    aisha: "An excellent result. Well done, Aisha.",
    ibrahimS: "A commendable result. Keep working hard.",
    fatima: "A good result. Continue in this direction.",
    yusuf: "A fair result — there is room for improvement next term.",
    khadija: "A fair result. More effort is required.",
    musa: "Please ensure improved attendance and effort next term.",
    zainabL: "A satisfactory result. Encourage more study at home.",
    suleiman: "Requires close monitoring and support next term.",
  };
  const jss1aStudentIds = students.jss1aPlans.map((plan) => students.jss1a[plan.key]!.id);
  const jss1aResults = await prisma.result.findMany({ where: { termId: structure.term1.id, studentId: { in: jss1aStudentIds } } });
  const resultByStudentId = new Map(jss1aResults.map((r) => [r.studentId, r]));
  for (const plan of students.jss1aPlans) {
    const result = resultByStudentId.get(students.jss1a[plan.key]!.id)!;
    await resultsService.writeClassTeacherComment(result.id, classTeacherComments[plan.key]!);
    await resultsService.writePrincipalComment(result.id, principalComments[plan.key]!);
  }

  // --- Finalize every JSS1A student — the class-wide re-rank fires
  // automatically once the last one finalizes. ---
  let overriddenResultId: string | null = null;
  for (const plan of students.jss1aPlans) {
    const result = resultByStudentId.get(students.jss1a[plan.key]!.id)!;
    const finalized = await resultsService.finalizeResult(result.id, actorUserId);
    if (plan.key === "aisha") {
      overriddenResultId = finalized.id;
    }
  }

  // --- Result override, so it appears in the audit log. ---
  const overridden = await resultsService.overrideResult(overriddenResultId!, actorUserId, {
    fieldName: "classTeacherComment",
    newValue: "Aisha is an outstanding student who consistently performs at the top of her class. Demo correction: updated after report card review.",
    reason: "Demo data: administrative correction after report card review, to populate the audit log.",
  });
  await auditService.writeAuditLog({
    actorUserId,
    actorRoles: ["ADMIN"],
    action: "RESULT_OVERRIDDEN",
    entityType: "Result",
    entityId: overridden.id,
    afterData: { fieldName: "classTeacherComment", newValue: overridden.classTeacherComment },
  });

  console.log("Scores: JSS1A entered + submitted, JSS1B entered only. Attendance: 4 closed + 1 open session.");
  console.log("Results: JSS1A computed, rated, commented, finalized, ranked (tie at 3rd), one override audited.");

  return { jss1aResults: resultByStudentId };
}

// ---------------------------------------------------------------------------
// 6. Fees — every withholding case
// ---------------------------------------------------------------------------
async function seedFees(
  structure: Awaited<ReturnType<typeof seedAcademicStructure>>,
  staff: Awaited<ReturnType<typeof seedStaff>>,
  students: Awaited<ReturnType<typeof seedStudentsAndParents>>,
  results: Awaited<ReturnType<typeof seedScoresAttendanceAndResults>>,
) {
  const actorUserId = staff.bursar.userId;
  const TUITION_KOBO = 8_500_000; // ₦85,000

  const jss1aTuition = await feesService.createFeeStructure({
    name: "First Term Tuition — JSS1A",
    category: "TUITION",
    classId: structure.jss1a.id,
    academicSessionId: structure.session.id,
    termId: structure.term1.id,
    amountKobo: TUITION_KOBO,
  });
  const jss1bTuition = await feesService.createFeeStructure({
    name: "First Term Tuition — JSS1B",
    category: "TUITION",
    classId: structure.jss1b.id,
    academicSessionId: structure.session.id,
    termId: structure.term1.id,
    amountKobo: TUITION_KOBO,
  });
  const developmentLevy = await feesService.createFeeStructure({
    name: "Development Levy",
    category: "OTHER",
    classId: structure.jss1a.id,
    academicSessionId: structure.session.id,
    // termId omitted — session-wide, so it withholds every term.
    amountKobo: 1_500_000, // ₦15,000
  });
  manifest.feeStructureIds.push(jss1aTuition.id, jss1bTuition.id, developmentLevy.id);

  const jss1aObligations = await feesService.generateObligations(jss1aTuition.id, actorUserId);
  await feesService.generateObligations(jss1bTuition.id, actorUserId);
  const levyObligations = await feesService.generateObligations(developmentLevy.id, actorUserId);

  const obligationByStudentId = new Map(jss1aObligations.map((o) => [o.studentId, o]));
  const levyObligationByStudentId = new Map(levyObligations.map((o) => [o.studentId, o]));

  async function pay(
    studentKey: string,
    amountKobo: number,
    outcome: "confirm" | "reject" | "pending",
    obligationMap: Map<string, { id: string }> = obligationByStudentId,
  ) {
    const obligation = obligationMap.get(students.jss1a[studentKey]!.id)!;
    const payment = await feesService.recordPayment(obligation.id, actorUserId, {
      amountKobo,
      paymentDate: new Date("2026-09-15"),
      bankReference: `DEMO-${studentKey.toUpperCase()}`,
    });
    if (outcome === "confirm") {
      await feesService.confirmPayment(payment.id, actorUserId);
    } else if (outcome === "reject") {
      await feesService.rejectPayment(payment.id, actorUserId);
    }
    // "pending": leave the payment as recorded, unconfirmed.
  }

  await pay("aisha", TUITION_KOBO, "confirm"); // fully paid -> 200
  await pay("ibrahimS", 4_000_000, "confirm"); // partially paid -> 402
  await pay("fatima", TUITION_KOBO, "confirm"); // fully paid -> 200
  await pay("yusuf", TUITION_KOBO, "pending"); // pending, unconfirmed -> still 402
  // khadija: no tuition payment at all -> unpaid -> 402
  // musa: no tuition payment, but released below -> 200 despite unpaid
  await pay("zainabL", 3_000_000, "reject"); // rejected -> balance unaffected -> 402
  await pay("suleiman", TUITION_KOBO, "confirm"); // tuition fully paid, but the development levy stays unpaid -> 402 every term

  // The development levy is session-wide (termId: null) and class-scoped to
  // JSS1A, so generateObligations created one for every JSS1A student, not
  // just Suleiman — a student whose tuition is otherwise fully paid would
  // still be withheld by this unrelated, unpaid levy obligation. Pay it off
  // for everyone except Suleiman (the deliberate session-wide case) and
  // Musa (deliberately left unpaid — releaseWithholding below covers his
  // whole fee picture, levy included, which is the more thorough version of
  // "unpaid but released"), so each student's result status is governed by
  // exactly the one scenario their row in the credentials table describes.
  for (const key of ["aisha", "ibrahimS", "fatima", "yusuf", "khadija", "zainabL"]) {
    await pay(key, 1_500_000, "confirm", levyObligationByStudentId);
  }

  const musaResult = results.jss1aResults.get(students.jss1a.musa!.id)!;
  await resultsService.releaseWithholding(musaResult.id, actorUserId, "Demo data: fee balance waived by administrative decision.");

  console.log(
    `Fees: JSS1A + JSS1B tuition (${naira(TUITION_KOBO)}) + session-wide development levy. ` +
      "Every withholding case covered: paid, partial, unpaid, released, pending, rejected, session-wide.",
  );
}

// ---------------------------------------------------------------------------
// 7. Madrassah progress
// ---------------------------------------------------------------------------
async function seedMadrassah(
  structure: Awaited<ReturnType<typeof seedAcademicStructure>>,
  staff: Awaited<ReturnType<typeof seedStaff>>,
  students: Awaited<ReturnType<typeof seedStudentsAndParents>>,
) {
  const alFatihah = await prisma.surah.findUnique({ where: { number: 1 } });
  const anNas = await prisma.surah.findUnique({ where: { number: 114 } });

  await madrassahService.createProgress(staff.madrassahTeacher.id, {
    studentId: students.jss1a.aisha!.id,
    academicSessionId: structure.session.id,
    termId: structure.term1.id,
    surahId: alFatihah?.id,
    ayahFrom: 1,
    ayahTo: 7,
    progressType: "MEMORIZATION",
    status: "COMPLETED",
    generalNotes: "Confident recitation with correct tajweed.",
  });
  await madrassahService.createProgress(staff.madrassahTeacher.id, {
    studentId: students.jss1a.fatima!.id,
    academicSessionId: structure.session.id,
    termId: structure.term1.id,
    surahId: anNas?.id,
    ayahFrom: 1,
    ayahTo: 6,
    progressType: "MEMORIZATION",
    status: "IN_PROGRESS",
    tajweedNotes: "Needs more practice on elongation (madd) rules.",
  });
  await madrassahService.createProgress(staff.madrassahTeacher.id, {
    studentId: students.jss1a.ibrahimS!.id,
    academicSessionId: structure.session.id,
    termId: structure.term1.id,
    surahId: alFatihah?.id,
    progressType: "TAJWEED_ASSESSMENT",
    status: "NEEDS_REVISION",
    tajweedNotes: "Revisit noon sakinah rules before the next assessment.",
  });

  console.log("Madrassah progress: 3 entries recorded for JSS1A students.");
}

// ---------------------------------------------------------------------------
// 8. Admission enquiries
// ---------------------------------------------------------------------------
async function seedAdmissions(
  structure: Awaited<ReturnType<typeof seedAcademicStructure>>,
  staff: Awaited<ReturnType<typeof seedStaff>>,
) {
  const actorUserId = staff.admin.userId;
  const newEnquiry = await admissionsService.createEnquiry({
    prospectiveFirstName: "Hauwa",
    prospectiveLastName: "Danjuma",
    desiredClassId: structure.jss1a.id,
    parentFullName: "Malam Danjuma Idris",
    parentPhone: "+2348030000001",
    parentEmail: `danjuma.idris@${EMAIL_DOMAIN}`,
    message: "Interested in enrolling for the 2026/2027 session.",
    source: "Walk-in",
  });
  manifest.admissionEnquiryIds.push(newEnquiry.id);

  const contactedEnquiry = await admissionsService.createEnquiry({
    prospectiveFirstName: "Bashir",
    prospectiveLastName: "Kabiru",
    desiredClassId: structure.jss1b.id,
    parentFullName: "Hajiya Kabiru Salamatu",
    parentPhone: "+2348030000002",
    source: "Referral",
  });
  manifest.admissionEnquiryIds.push(contactedEnquiry.id);
  await admissionsService.updateEnquiry(contactedEnquiry.id, actorUserId, { status: "CONTACTED", notes: "Called and invited for a school tour." });

  const convertedEnquiry = await admissionsService.createEnquiry({
    prospectiveFirstName: "Amina",
    prospectiveLastName: "Tijjani",
    desiredClassId: structure.jss1a.id,
    parentFullName: "Malam Tijjani Bashir",
    parentPhone: "+2348030000003",
    source: "Website",
  });
  manifest.admissionEnquiryIds.push(convertedEnquiry.id);
  const year = await identifiersService.getCurrentSessionStartYear(prisma);
  const newAdmissionNumber = await identifiersService.generateAdmissionNumber(prisma, year);
  const { student: convertedStudent } = await admissionsService.convertEnquiry(
    convertedEnquiry.id,
    actorUserId,
    newAdmissionNumber,
  );
  manifest.studentIds.push(convertedStudent.id);
  manifest.admissionNumbers.push(convertedStudent.admissionNumber);

  console.log("Admission enquiries: 1 NEW, 1 CONTACTED, 1 CONVERTED.");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  await guardAgainstDoubleSeed();

  const structure = await seedAcademicStructure();
  const staff = await seedStaff();
  const students = await seedStudentsAndParents(structure);

  // Teacher-parent dual role: no service supports granting an additional
  // role + linked record to an already-created User (out of scope for the
  // whole multi-role migration this codebase already did), so this one
  // link is a direct write — the only place in this script that isn't a
  // real service call, and it's here because no real service exists for
  // this specific operation, not as a shortcut around one that does.
  const teacherParentRecord = await prisma.parent.create({
    data: { userId: staff.teacherParent.userId, firstName: staff.teacherParent.firstName, lastName: staff.teacherParent.lastName },
  });
  await prisma.userRole.create({ data: { userId: staff.teacherParent.userId, role: "PARENT" } });
  manifest.parentIds.push(teacherParentRecord.id);
  await parentsService.linkChild(teacherParentRecord.id, {
    studentId: students.jss1b.abdullahiS!.id,
    relationship: "MOTHER",
    isPrimaryContact: true,
  });

  const assignments = await seedAssignments(structure, staff);
  const results = await seedScoresAttendanceAndResults(structure, staff, students, assignments);
  await seedFees(structure, staff, students, results);
  await seedMadrassah(structure, staff, students);
  await seedAdmissions(structure, staff);

  // Every linkChild() call above fires student credential issuance as
  // fire-and-forget (see parents.service.ts::linkChild) — genuinely
  // detached, not just "awaited internally". Drain it now, before querying
  // for which students actually got a User row: without this, the query
  // below can race issuance that's still in flight and miss some.
  await drainFireAndForget();

  // --- A handful of notifications, some read and some unread — beyond
  // whatever credential-issuance/payment-confirmation notifications the
  // atomic create paths above already fired. ---
  const adminNotification = await notificationsService.createNotification({
    type: "ADMIN_GENERAL",
    recipientUserId: staff.admin.userId,
    subject: "Demo dataset ready",
    body: "The demo dataset has been seeded. See docs/demo-credentials.md for the full account list.",
    channels: ["IN_APP"],
  });
  await notificationsService.markNotificationRead(adminNotification.event.id);
  await notificationsService.createNotification({
    type: "ADMIN_GENERAL",
    recipientUserId: staff.bursar.userId,
    subject: "Outstanding balances to review",
    body: "Several fee obligations remain outstanding this term — see the finance portal.",
    channels: ["IN_APP"],
  });

  // --- Set every demo account's password to the known value, and
  // mustChangePassword: false — except Nasiru Danladi, left true. ---
  const demoPasswordHash = await hashPassword(DEMO_PASSWORD);
  const forcedChangeUserId = staff.mustChangeTeacher.userId;
  const otherUserIds = manifest.userIds.filter((id) => id !== forcedChangeUserId);
  await prisma.user.updateMany({
    where: { id: { in: otherUserIds } },
    data: { passwordHash: demoPasswordHash, mustChangePassword: false },
  });
  await prisma.user.update({
    where: { id: forcedChangeUserId },
    data: { passwordHash: demoPasswordHash, mustChangePassword: true },
  });
  // Every student who has a login by now (all of JSS1A + 3 of 4 JSS1B —
  // Halima Auwal is deliberately unlinked, so she never got one) also
  // needs the known password. Collect their User ids fresh from the DB,
  // since issueFirstLoginForStudent created them internally, not via a
  // return value this script captured directly.
  const studentUsers = await prisma.student.findMany({
    where: { id: { in: manifest.studentIds }, userId: { not: null } },
    select: { userId: true },
  });
  const studentUserIds = studentUsers.map((s) => s.userId!).filter((id) => !manifest.userIds.includes(id));
  manifest.userIds.push(...studentUserIds);
  await prisma.user.updateMany({
    where: { id: { in: studentUserIds } },
    data: { passwordHash: demoPasswordHash, mustChangePassword: false },
  });

  // --- Build the credentials table from what's actually in the database
  // now (loginIds, staff numbers, admission numbers) rather than re-deriving
  // them from in-memory plan objects, so the table can never drift from
  // reality. ---
  await buildCredentialRows(staff, students);

  // A second drain: buildCredentialRows and the password-reset block above
  // don't themselves trigger new fire-and-forget work, but this is cheap
  // insurance against that ever becoming false without someone noticing.
  await drainFireAndForget();

  const manifestPath = new URL("./demo-seed-manifest.json", import.meta.url);
  const fs = await import("node:fs/promises");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Manifest written: ${manifestPath.pathname}`);

  await writeCredentialsDoc();
  printCredentialsTable();
}

async function buildCredentialRows(
  staff: Awaited<ReturnType<typeof seedStaff>>,
  students: Awaited<ReturnType<typeof seedStudentsAndParents>>,
) {
  const staffUsers = await prisma.staff.findMany({
    where: { id: { in: manifest.staffIds } },
  });
  const staffById = new Map(staffUsers.map((s) => [s.id, s]));

  function pushStaff(id: string, roleLabel: string, notes: string) {
    const record = staffById.get(id)!;
    credentialRows.push({
      role: roleLabel,
      name: `${record.firstName} ${record.lastName}`,
      loginId: record.staffNumber,
      password: DEMO_PASSWORD,
      notes,
    });
  }

  pushStaff(staff.admin.id, "ADMIN", "Full admin access, created via POST /api/staff (not the bootstrap account). Also teaches Islamic Studies, JSS1A.");
  pushStaff(staff.bursar.id, "BURSAR", "Finance portal — fee structures, obligations, payment confirmation.");
  pushStaff(staff.formTeacherJss1a.id, "TEACHER", "Form teacher, JSS1A — full ratings/comments access for the class; also teaches Mathematics in JSS1A and JSS1B.");
  pushStaff(staff.subjectTeacherJss1a.id, "TEACHER", "Subject teacher, JSS1A (English Language) — NOT the form teacher; must be denied ratings/comments.");
  pushStaff(staff.madrassahTeacher.id, "TEACHER", "Madrassah/Qur'an teacher — records memorisation and tajweed progress.");
  pushStaff(staff.teacherParent.id, "TEACHER + PARENT", "Teaches Basic Science, JSS1A. Also the parent of Abdullahi Sani, JSS1B (draft results — finalized-only view).");
  pushStaff(staff.mustChangeTeacher.id, "TEACHER", "mustChangePassword: true — logs in, then every route except /me and change-password returns MUST_CHANGE_PASSWORD.");

  const parentUsers = await prisma.parent.findMany({
    where: { id: { in: manifest.parentIds } },
    include: { user: true },
  });
  const parentById = new Map(parentUsers.map((p) => [p.id, p]));

  function pushParent(id: string, notes: string) {
    const record = parentById.get(id)!;
    credentialRows.push({
      role: "PARENT",
      name: `${record.firstName} ${record.lastName}`,
      loginId: record.user.loginId,
      password: DEMO_PASSWORD,
      notes,
    });
  }

  pushParent(students.twoKidsParent.id, "Two children: Fatima Bello (JSS1A, fully paid) and Hauwa Bello (JSS1B, draft) — the child switcher.");
  pushParent(students.primaryParent.id, "Primary contact for Zainab Lawal (JSS1A) — one of two linked parents.");
  pushParent(students.secondaryParent.id, "Non-primary contact for Zainab Lawal (JSS1A) — same student as the row above, isPrimaryContact: false.");

  const singleParents: Array<{ studentKey: keyof typeof students.jss1a | keyof typeof students.jss1b; notes: string }> = [
    { studentKey: "aisha", notes: "Parent of Aisha Abdullahi (JSS1A, rank 1, fully paid) — request the result: 200 with position and ratings." },
    { studentKey: "ibrahimS", notes: "Parent of Ibrahim Sule (JSS1A, rank 2, partially paid) — request the result: 402 withheld." },
    { studentKey: "yusuf", notes: "Parent of Yusuf Garba (JSS1A, tied rank 3, payment pending/unconfirmed) — request the result: 402 withheld." },
    { studentKey: "khadija", notes: "Parent of Khadija Umar (JSS1A, rank 5, unpaid) — request the result: 402 withheld." },
    { studentKey: "musa", notes: "Parent of Musa Aliyu (JSS1A, rank 6, unpaid but admin-released) — request the result: 200 despite the outstanding balance." },
    { studentKey: "suleiman", notes: "Parent of Suleiman Bala (JSS1A, tuition paid, development levy unpaid) — request the result: 402, session-wide charge withholds every term." },
    { studentKey: "maryam", notes: "Parent of Maryam Yusuf (JSS1B, draft results) — request the result: 404, not published yet." },
  ];
  for (const { studentKey, notes } of singleParents) {
    const student = (students.jss1a as Record<string, { id: string }>)[studentKey] ?? (students.jss1b as Record<string, { id: string }>)[studentKey];
    const link = await prisma.studentParent.findFirst({ where: { studentId: student!.id }, include: { parent: { include: { user: true } } } });
    if (link) {
      credentialRows.push({
        role: "PARENT",
        name: `${link.parent.firstName} ${link.parent.lastName}`,
        loginId: link.parent.user.loginId,
        password: DEMO_PASSWORD,
        notes,
      });
    }
  }

  const studentRows: Array<{ key: keyof typeof students.jss1a; classLabel: string; notes: string }> = [
    { key: "aisha", classLabel: "JSS1A", notes: "Rank 1, fully paid — see everything: finalized report card, position, ratings, comments." },
  ];
  for (const { key, classLabel, notes } of studentRows) {
    const student = await prisma.student.findUniqueOrThrow({ where: { id: students.jss1a[key]!.id } });
    credentialRows.push({
      role: "STUDENT",
      name: `${student.firstName} ${student.lastName}`,
      loginId: student.admissionNumber,
      password: DEMO_PASSWORD,
      notes: `${classLabel}. ${notes}`,
    });
  }

  const halima = await prisma.student.findUniqueOrThrow({ where: { id: students.jss1b.halima!.id } });
  credentialRows.push({
    role: "STUDENT (no login yet)",
    name: `${halima.firstName} ${halima.lastName}`,
    loginId: "— none —",
    password: "— none —",
    notes: `JSS1B, admission number ${halima.admissionNumber}. No parent linked — no User account exists yet. Link a primary-contact parent via POST /api/parents/:id/children to see credential issuance fire live.`,
  });
}

function renderCredentialsMarkdown(): string {
  const header = "| Role | Name | Login identifier | Password | Notes |\n|---|---|---|---|---|";
  const rows = credentialRows
    .map((r) => `| ${r.role} | ${r.name} | \`${r.loginId}\` | \`${r.password}\` | ${r.notes} |`)
    .join("\n");
  return `${header}\n${rows}`;
}

async function writeCredentialsDoc() {
  const fs = await import("node:fs/promises");
  const content = `# Demo credentials

Generated by \`npm run db:seed:demo\` on ${new Date().toISOString()}. Regenerated on every run — do not hand-edit.

Every account uses the password **\`${DEMO_PASSWORD}\`**, except the one flagged \`mustChangePassword: true\` below, which
uses the same password to log in once and is then required to change it before doing anything else.

${renderCredentialsMarkdown()}

## Running against Railway production

This seed is intended to run against Railway production **once**, before the school enters real records, with the
data wiped afterward via \`npm run db:wipe:demo\`. The sequence:

1. \`npx prisma migrate reset --force\` — drops and rebuilds the schema, then runs \`seed.ts\`.
   **This step is only safe right now, while production holds no real school data.** Production currently holds
   ad-hoc test data from earlier manual testing (unrelated to this seed, and what caused the duplicate-primary-contact
   migration failure) — this reset clears that too. **Never run this once the school is live**: it destroys
   every row in the database, real records included.
2. \`ALLOW_DEMO_SEED=true npm run db:seed:demo\` — the demo dataset described above.
3. Before go-live: \`npm run db:wipe:demo\` — removes every row the demo seed created, plus every
   \`IdentifierCounter\` row, so the school's first real student/staff member gets \`FIA/2026/001\`/\`FIA/ST2026/001\`,
   not a number that continues from where the demo data left off. Refuses to run if any Student or Staff row exists
   whose number wasn't issued by this seed — see \`prisma/wipe-demo.ts\`'s own comments for why.
`;
  const path = new URL("../docs/demo-credentials.md", import.meta.url);
  await fs.mkdir(new URL("../docs/", import.meta.url), { recursive: true });
  await fs.writeFile(path, content);
  console.log(`Credentials written: ${path.pathname}`);
}

function printCredentialsTable() {
  console.log("\n" + renderCredentialsMarkdown() + "\n");
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
