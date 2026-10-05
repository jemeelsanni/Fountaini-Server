import { env } from "../../config/env.js";
import { prisma } from "../../db/client.js";
import { bandsOverlap, findCoverageGaps } from "../grading/grading.service.js";

export type SetupCheckStatus = "PASS" | "FAIL" | "WARN";

export interface SetupCheck {
  key: string;
  label: string;
  status: SetupCheckStatus;
  message: string;
  fixHint: string;
}

export interface SetupStatus {
  ready: boolean;
  checks: SetupCheck[];
}

/// The literal default prisma/seed.ts uses (SEED_ADMIN_EMAIL unset) — not
/// read from env, since the point of this check is "is the account the
/// bootstrap script creates by default still around," regardless of what a
/// later-created real admin's own email happens to be.
const BOOTSTRAP_ADMIN_EMAIL = "admin@school.test";

// Takes (and ignores) the same four-argument shape as fail/warn below,
// purely so every call site below reads uniformly — a PASS has nothing to
// fix, so fixHint is always "" regardless of what's passed.
function pass(key: string, label: string, message: string, _fixHint?: string): SetupCheck {
  return { key, label, status: "PASS", message, fixHint: "" };
}
function fail(key: string, label: string, message: string, fixHint: string): SetupCheck {
  return { key, label, status: "FAIL", message, fixHint };
}
function warn(key: string, label: string, message: string, fixHint: string): SetupCheck {
  return { key, label, status: "WARN", message, fixHint };
}

/// A read-only checklist an admin (or `npm run preflight`, against
/// production, see scripts/preflight.ts) can run before — and at any time
/// after — go-live to see what's actually configured versus what a freshly
/// reset database only looks configured for. Every check here is a genuine,
/// previously-silent failure mode found during the go-live audit: each one
/// either 404s a real screen, corrupts a computed grade, or quietly leaves
/// `grade: null` with no error anywhere (see this function's own checks for
/// which). Issues NO writes — every check below is a plain read.
///
/// Checks run in dependency order (school before session before term before
/// anything that needs a current session) so the FIRST failing check an
/// admin sees is usually also the first thing to actually fix — later
/// checks that transitively depend on an earlier one still run and still
/// report their own FAIL (there's no short-circuiting), since the goal is
/// a complete picture in one call, not just "stop at the first problem."
export async function getSetupStatus(): Promise<SetupStatus> {
  const checks: SetupCheck[] = [];

  // --- 1. School record ---------------------------------------------------
  const school = await prisma.school.findFirst();
  if (!school) {
    checks.push(
      fail(
        "school",
        "School record",
        "Statements and report cards will 404 until a school record exists.",
        "POST /api/school",
      ),
    );
  } else {
    const missing: string[] = [];
    if (!school.address) missing.push("address");
    if (!school.contactEmail) missing.push("contact email");
    if (!school.contactPhone) missing.push("contact phone");
    if (missing.length > 0) {
      checks.push(
        warn(
          "school",
          "School record",
          `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} empty — ${missing.join("/")} ` +
            "will be blank on every statement and report card.",
          "PATCH /api/school",
        ),
      );
    } else {
      checks.push(pass("school", "School record", "School record is complete.", ""));
    }
  }

  // --- 2. Current academic session ----------------------------------------
  const currentSession = await prisma.academicSession.findFirst({ where: { isCurrent: true } });
  if (!currentSession) {
    checks.push(
      fail(
        "currentSession",
        "Current academic session",
        "Staff and student creation will fail — admission/staff numbers can't be issued without a " +
          "current academic session.",
        "POST /api/academic-sessions, then PATCH /api/academic-sessions/:id/set-current",
      ),
    );
  } else {
    checks.push(
      pass("currentSession", "Current academic session", `${currentSession.name} is marked current.`, ""),
    );
  }

  // --- 3. Current term -----------------------------------------------------
  const currentTerm = currentSession
    ? await prisma.term.findFirst({ where: { academicSessionId: currentSession.id, isCurrent: true } })
    : null;
  if (!currentTerm) {
    checks.push(
      fail(
        "currentTerm",
        "Current term",
        currentSession
          ? "No term is marked current within the current session — anything that defaults to " +
            "\"this term\" (report cards, dashboards) has nothing to default to yet."
          : "No current academic session, so no term can be current either.",
        "POST /api/academic-sessions/:id/terms, then PATCH /api/terms/:id/set-current",
      ),
    );
  } else {
    checks.push(pass("currentTerm", "Current term", `${currentTerm.name} is marked current.`, ""));
  }

  // --- 4. Assessment components --------------------------------------------
  const components = currentSession
    ? await prisma.assessmentComponent.findMany({ where: { academicSessionId: currentSession.id } })
    : [];
  if (components.length === 0) {
    checks.push(
      fail(
        "assessmentComponents",
        "Assessment components",
        currentSession
          ? "No assessment components exist for the current session — scores can't be entered."
          : "No current academic session, so no assessment components can exist for it.",
        "POST /api/academic-sessions/:id/assessment-components",
      ),
    );
  } else {
    const total = components.reduce((sum, c) => sum + c.maxScore.toNumber(), 0);
    if (total !== 100) {
      checks.push(
        fail(
          "assessmentComponents",
          "Assessment components",
          `Components sum to ${total}, not 100 — every score computed against them will be off-scale, ` +
            "not an error, just a wrong number on every report card.",
          "PATCH /api/assessment-components/:id",
        ),
      );
    } else {
      checks.push(
        pass(
          "assessmentComponents",
          "Assessment components",
          `${components.length} component(s), summing to 100.`,
          "",
        ),
      );
    }
  }

  // --- 5. Grading scale -----------------------------------------------------
  const gradingScale = currentSession
    ? await prisma.gradingScale.findUnique({ where: { academicSessionId: currentSession.id } })
    : null;
  if (!gradingScale) {
    checks.push(
      fail(
        "gradingScale",
        "Grading scale",
        currentSession
          ? "No grading scale exists for the current session — every computed score will grade as null."
          : "No current academic session, so no grading scale can exist for it.",
        "POST /api/academic-sessions/:id/grading-scale",
      ),
    );
  } else {
    const bands = await prisma.gradeBand.findMany({ where: { gradingScaleId: gradingScale.id } });
    const numericBands = bands.map((b) => ({ minScore: b.minScore.toNumber(), maxScore: b.maxScore.toNumber() }));
    let overlapping = false;
    for (let i = 0; i < numericBands.length && !overlapping; i++) {
      for (let j = i + 1; j < numericBands.length; j++) {
        if (bandsOverlap(numericBands[i]!.minScore, numericBands[i]!.maxScore, numericBands[j]!.minScore, numericBands[j]!.maxScore)) {
          overlapping = true;
          break;
        }
      }
    }
    const gaps = findCoverageGaps(numericBands);
    if (overlapping) {
      checks.push(
        fail(
          "gradingScale",
          "Grading scale",
          "Two or more grade bands overlap — a score in the overlap could grade as either one, " +
            "unpredictably.",
          "PATCH /api/grade-bands/:id",
        ),
      );
    } else if (gaps.length > 0) {
      checks.push(
        fail(
          "gradingScale",
          "Grading scale",
          `The scale doesn't cover ${gaps.map((g) => `${g.from}-${g.to}`).join(", ")} — a score landing ` +
            "there will grade as null on a report card, with no error.",
          "POST /api/grading-scales/:id/bands",
        ),
      );
    } else {
      checks.push(
        pass("gradingScale", "Grading scale", `${bands.length} band(s), covering 0-100 with no overlap.`, ""),
      );
    }
  }

  // --- 6. Behaviour and skills traits ---------------------------------------
  const ratingScaleCount = await prisma.ratingScaleLevel.count();
  const [affectiveCount, psychomotorCount] = currentSession
    ? await Promise.all([
        prisma.trait.count({ where: { academicSessionId: currentSession.id, category: "AFFECTIVE" } }),
        prisma.trait.count({ where: { academicSessionId: currentSession.id, category: "PSYCHOMOTOR" } }),
      ])
    : [0, 0];
  if (ratingScaleCount === 0 || affectiveCount === 0 || psychomotorCount === 0) {
    const missing: string[] = [];
    if (ratingScaleCount === 0) missing.push("the rating scale (1-5) isn't seeded");
    if (affectiveCount === 0) missing.push("no behaviour (affective) traits for the current session");
    if (psychomotorCount === 0) missing.push("no skills (psychomotor) traits for the current session");
    checks.push(
      fail(
        "behaviourSkillsTraits",
        "Behaviour and skills traits",
        `Report-card ratings will have nothing to rate against: ${missing.join("; ")}.`,
        "npm run db:seed:traits (seeds the default lists for whichever session is current when it " +
          "runs — fails loudly if none is)",
      ),
    );
  } else {
    checks.push(
      pass(
        "behaviourSkillsTraits",
        "Behaviour and skills traits",
        `${affectiveCount} affective + ${psychomotorCount} psychomotor trait(s), rating scale seeded.`,
        "",
      ),
    );
  }

  // --- 7. Structure -----------------------------------------------------------
  const [subjectCount, classCount, timeSlotCount] = await Promise.all([
    prisma.subject.count(),
    prisma.class.count(),
    prisma.timeSlot.count(),
  ]);
  if (subjectCount === 0 || classCount === 0 || timeSlotCount === 0) {
    const missing: string[] = [];
    if (subjectCount === 0) missing.push("subjects");
    if (classCount === 0) missing.push("classes");
    if (timeSlotCount === 0) missing.push("time slots");
    checks.push(
      fail(
        "structure",
        "Structure",
        `No ${missing.join(", ")} exist — class assignments, timetables and enrollment have nothing ` +
          "to attach to.",
        "POST /api/subjects, POST /api/classes, POST /api/time-slots",
      ),
    );
  } else {
    checks.push(
      pass(
        "structure",
        "Structure",
        `${subjectCount} subject(s), ${classCount} class(es), ${timeSlotCount} time slot(s).`,
        "",
      ),
    );
  }

  // --- 8. Admin account ---------------------------------------------------
  const realAdminCount = await prisma.user.count({
    where: { isActive: true, roles: { some: { role: "ADMIN" } }, staff: { isNot: null } },
  });
  if (realAdminCount === 0) {
    checks.push(
      fail(
        "adminAccount",
        "Admin account",
        "Only the bootstrap admin exists — it has no staff record and is meant to be retired, not " +
          "used day to day.",
        "POST /api/staff (role: ADMIN), then deactivate the bootstrap admin",
      ),
    );
  } else {
    checks.push(
      pass("adminAccount", "Admin account", `${realAdminCount} active admin account(s) with a staff record.`, ""),
    );
  }

  // --- 9. Bootstrap admin (warn only) --------------------------------------
  const bootstrapAdmin = await prisma.user.findUnique({ where: { email: BOOTSTRAP_ADMIN_EMAIL } });
  if (bootstrapAdmin?.isActive) {
    checks.push(
      warn(
        "bootstrapAdmin",
        "Bootstrap admin",
        `${BOOTSTRAP_ADMIN_EMAIL} is still active — retire it once a real admin account exists.`,
        "POST /api/users/:id/deactivate",
      ),
    );
  } else {
    checks.push(pass("bootstrapAdmin", "Bootstrap admin", "Bootstrap admin is retired or absent.", ""));
  }

  // --- 10. Demo data (warn only) --------------------------------------------
  const demoUserCount = await prisma.user.count({ where: { email: { endsWith: "@example.com" } } });
  if (demoUserCount > 0) {
    checks.push(
      warn(
        "demoData",
        "Demo data",
        `${demoUserCount} account(s) with an @example.com address — looks like demo data is still ` +
          "in this database.",
        "npm run db:wipe:demo, or npm run db:reset before real records are entered",
      ),
    );
  } else {
    checks.push(pass("demoData", "Demo data", "No demo (@example.com) accounts found.", ""));
  }

  // --- 11. Notification provider (warn only) --------------------------------
  if (env.NOTIFICATION_PROVIDER === "console") {
    checks.push(
      warn(
        "notificationProvider",
        "Notification provider",
        "Provider is \"console\" — credential and password-reset emails are only logged, never " +
          "actually delivered.",
        "Set NOTIFICATION_PROVIDER=resend and RESEND_API_KEY",
      ),
    );
  } else {
    checks.push(
      pass("notificationProvider", "Notification provider", `Provider is "${env.NOTIFICATION_PROVIDER}".`, ""),
    );
  }

  return { ready: checks.every((c) => c.status !== "FAIL"), checks };
}
