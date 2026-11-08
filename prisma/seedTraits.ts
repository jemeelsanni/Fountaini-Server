// Seeds the default behaviour (affective) and skills (psychomotor) trait
// lists for the CURRENT academic session. Split out of seed.ts (which ran
// this silently, and only for whichever session happened to be current at
// the time it ran — almost always none, since seed.ts runs before any
// session exists) because "the school was told its trait lists are rows,
// not migrations" and this was, in practice, the one thing in that script
// that still required a developer to run it again, by hand, after every
// new session was created. Run it the same way: `npm run db:seed:traits`,
// any time a new session becomes current and needs its default trait
// lists populated. Idempotent (upsert) — safe to re-run.
import { PrismaClient } from "../generated/prisma/index.js";
import { earlyYearsTraitRows } from "./earlyYearsChecklist.js";

const prisma = new PrismaClient();

// The school's own list, in the order its Basic and Islamiyyah report
// sheets print it. Upsert-only: a session seeded with an older list keeps
// those names until an admin deactivates them — nothing is removed here.
const AFFECTIVE_TRAITS = [
  "Attentiveness",
  "Attitude to work",
  "Punctuality",
  "Neatness",
  "Politeness",
  "Cooperation with others",
  "Health",
  "Speaking and writing",
];

const PSYCHOMOTOR_TRAITS = ["Handwriting", "Games and Sports", "Drawing and Painting", "Craftwork", "Musical Skills", "Verbal Fluency"];

async function main() {
  const currentSession = await prisma.academicSession.findFirst({ where: { isCurrent: true } });
  if (!currentSession) {
    console.error(
      [
        "",
        "Refusing to seed traits: no academic session is marked current.",
        "",
        "Trait rows are session-scoped (see prisma/schema.prisma's Trait model) — there is no session",
        "to attach them to. Mark one current first:",
        "  POST /api/academic-sessions, then PATCH /api/academic-sessions/:id/set-current",
        "then re-run `npm run db:seed:traits`.",
        "",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  for (const [index, name] of AFFECTIVE_TRAITS.entries()) {
    await prisma.trait.upsert({
      where: {
        academicSessionId_category_name: { academicSessionId: currentSession.id, category: "AFFECTIVE", name },
      },
      update: { order: index + 1 },
      create: { academicSessionId: currentSession.id, category: "AFFECTIVE", name, order: index + 1 },
    });
  }
  for (const [index, name] of PSYCHOMOTOR_TRAITS.entries()) {
    await prisma.trait.upsert({
      where: {
        academicSessionId_category_name: { academicSessionId: currentSession.id, category: "PSYCHOMOTOR", name },
      },
      update: { order: index + 1 },
      create: { academicSessionId: currentSession.id, category: "PSYCHOMOTOR", name, order: index + 1 },
    });
  }

  // The Creche/Early Years checklist — see prisma/earlyYearsChecklist.ts.
  const earlyYears = earlyYearsTraitRows();
  for (const { section, name, order } of earlyYears) {
    await prisma.trait.upsert({
      where: {
        academicSessionId_category_name: { academicSessionId: currentSession.id, category: "EARLY_YEARS", name },
      },
      update: { section, order },
      create: { academicSessionId: currentSession.id, category: "EARLY_YEARS", name, section, order },
    });
  }

  console.log(
    `Seeded ${AFFECTIVE_TRAITS.length} affective + ${PSYCHOMOTOR_TRAITS.length} psychomotor + ` +
      `${earlyYears.length} Early Years traits for session ${currentSession.name}.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
