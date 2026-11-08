import type { Server } from "node:http";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { computeResultsForClass } from "./results.service.js";
import {
  createAdmin,
  createBareStudent,
  createCurrentAcademicSession,
  createTeacher,
  createTermForSession,
  enrollStudent,
} from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";
import { waitForAuditLog } from "../../test/waitForAuditLog.js";

/// Admin → Results' whole-school "Publish all": GET /results/term-summary
/// and POST /results/finalize-all.

const app = createApp();
let server: Server;

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
});

afterAll(() => {
  server.close();
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/// Basic 5 with two SUBMITTED and one DRAFT result; a Madrasa group with one
/// SUBMITTED and one FINALIZED.
async function setup() {
  const { token } = await createAdmin("admin@test.local");
  const session = await createCurrentAcademicSession("2026/2027");
  const term = await createTermForSession(session.id, "First Term", 1);
  const basic5 = await prisma.class.create({ data: { gradeName: "Basic 5", order: 5 } });
  const madrasa = await prisma.class.create({
    data: { gradeName: "Weekday Madrasa", arm: "Level 1", order: 100, programme: "MADRASSAH" },
  });
  const students: Array<Awaited<ReturnType<typeof createBareStudent>>> = [];
  for (const n of [1, 2, 3]) {
    const s = await createBareStudent(`ADM-00${n}`);
    await enrollStudent(s.id, basic5.id, session.id);
    students.push(s);
  }
  for (const s of students.slice(0, 2)) {
    await enrollStudent(s.id, madrasa.id, session.id);
  }
  await computeResultsForClass({ classId: basic5.id, termId: term.id });
  await computeResultsForClass({ classId: madrasa.id, termId: term.id });

  const resultFor = (studentIndex: number, programme: "ACADEMIC" | "MADRASSAH") =>
    prisma.result.findUniqueOrThrow({
      where: { studentId_termId_programme: { studentId: students[studentIndex]!.id, termId: term.id, programme } },
    });
  const setStatus = async (studentIndex: number, programme: "ACADEMIC" | "MADRASSAH", status: "SUBMITTED" | "FINALIZED") =>
    prisma.result.update({ where: { id: (await resultFor(studentIndex, programme)).id }, data: { status } });
  await setStatus(0, "ACADEMIC", "SUBMITTED");
  await setStatus(1, "ACADEMIC", "SUBMITTED");
  await setStatus(0, "MADRASSAH", "SUBMITTED");
  await setStatus(1, "MADRASSAH", "FINALIZED");

  const summary = (query: string) =>
    request(server).get(`/api/results/term-summary?${query}`).set("Authorization", `Bearer ${token}`);
  const finalizeAll = (body: object) =>
    request(server).post("/api/results/finalize-all").set("Authorization", `Bearer ${token}`).send(body);
  return { token, session, term, basic5, madrasa, students, resultFor, summary, finalizeAll };
}

describe("GET /api/results/term-summary", () => {
  it("counts the term's results per class by status, in class order", async () => {
    const { term, basic5, madrasa, summary } = await setup();

    const res = await summary(`termId=${term.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      termId: term.id,
      classes: [
        { classId: basic5.id, gradeName: "Basic 5", arm: null, programme: "ACADEMIC", draft: 1, submitted: 2, finalized: 0 },
        {
          classId: madrasa.id,
          gradeName: "Weekday Madrasa",
          arm: "Level 1",
          programme: "MADRASSAH",
          draft: 0,
          submitted: 1,
          finalized: 1,
        },
      ],
      totals: { draft: 1, submitted: 3, finalized: 1 },
    });
  });

  it("narrows to one programme, and 404s for an unknown term", async () => {
    const { term, madrasa, summary } = await setup();

    const madrasaOnly = await summary(`termId=${term.id}&programme=MADRASSAH`);
    const unknown = await summary("termId=nope");

    expect(madrasaOnly.body.classes.map((c: { classId: string }) => c.classId)).toEqual([madrasa.id]);
    expect(madrasaOnly.body.totals).toEqual({ draft: 0, submitted: 1, finalized: 1 });
    expect(unknown.status).toBe(404);
  });
});

describe("POST /api/results/finalize-all", () => {
  it("publishes only SUBMITTED results, leaves DRAFT alone, and audits each one plus the batch", async () => {
    const { term, basic5, madrasa, resultFor, finalizeAll } = await setup();
    const draftBefore = await resultFor(2, "ACADEMIC");

    const res = await finalizeAll({ termId: term.id });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ finalized: 3, skippedDraft: 1, failed: [] });
    expect(res.body.classes).toEqual(
      expect.arrayContaining([
        { classId: basic5.id, finalized: 2 },
        { classId: madrasa.id, finalized: 1 },
      ]),
    );
    const published = await resultFor(0, "ACADEMIC");
    expect(published.status).toBe("FINALIZED");
    expect(published.finalizedAt).not.toBeNull();
    expect(published.daysSchoolOpened).toBe(0);
    expect(await resultFor(2, "ACADEMIC")).toEqual(draftBefore);
    expect(await waitForAuditLog("Result", published.id, "RESULT_FINALIZED")).not.toBeNull();
    const batch = await waitForAuditLog("Term", term.id, "RESULTS_FINALIZED_IN_BULK");
    expect(batch?.afterData).toMatchObject({ termId: term.id, programme: null, count: 3, skippedDraft: 1 });
  });

  it("leaves a result alone if it was returned to draft after the release picked it up", async () => {
    const { term, resultFor, finalizeAll } = await setup();
    const withdrawn = await resultFor(1, "ACADEMIC");
    // The release reads its SUBMITTED list first; simulate the form teacher
    // withdrawing one right after that read by handing back the list as it
    // was, then flipping the row to DRAFT before any publish happens.
    const findMany = prisma.result.findMany.bind(prisma.result);
    vi.spyOn(prisma.result, "findMany").mockImplementationOnce((async (args: Parameters<typeof findMany>[0]) => {
      const rows = await findMany(args);
      await prisma.result.update({ where: { id: withdrawn.id }, data: { status: "DRAFT" } });
      return rows;
    }) as unknown as typeof prisma.result.findMany);

    const res = await finalizeAll({ termId: term.id, programme: "ACADEMIC" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ finalized: 1, skippedDraft: 2, failed: [] });
    expect((await resultFor(1, "ACADEMIC")).status).toBe("DRAFT");
  });

  it("only publishes the requested programme", async () => {
    const { term, resultFor, finalizeAll } = await setup();

    const res = await finalizeAll({ termId: term.id, programme: "MADRASSAH" });

    expect(res.body).toMatchObject({ finalized: 1, skippedDraft: 0 });
    expect((await resultFor(0, "MADRASSAH")).status).toBe("FINALIZED");
    expect((await resultFor(0, "ACADEMIC")).status).toBe("SUBMITTED");
  });

  it("returns finalized: 0 for a term with nothing submitted, and 404s for an unknown term", async () => {
    const { session, finalizeAll } = await setup();
    const emptyTerm = await prisma.term.create({
      data: {
        academicSessionId: session.id,
        name: "Second Term",
        order: 2,
        startDate: new Date("2027-01-05"),
        endDate: new Date("2027-04-02"),
      },
    });

    const empty = await finalizeAll({ termId: emptyTerm.id });
    const unknown = await finalizeAll({ termId: "nope" });

    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ finalized: 0, skippedDraft: 0, failed: [], classes: [] });
    expect(unknown.status).toBe(404);
  });

  it("is ADMIN-only", async () => {
    const { term } = await setup();
    const { token: teacherToken } = await createTeacher("teacher@test.local");

    const publish = await request(server)
      .post("/api/results/finalize-all")
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ termId: term.id });
    const summary = await request(server)
      .get(`/api/results/term-summary?termId=${term.id}`)
      .set("Authorization", `Bearer ${teacherToken}`);

    expect(publish.status).toBe(403);
    expect(summary.status).toBe(403);
  });
});
