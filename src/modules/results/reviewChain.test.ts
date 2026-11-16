import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import {
  createAdmin,
  createAssessmentComponent,
  createAssignment,
  createBareStudent,
  createClass,
  createCurrentAcademicSession,
  createParent,
  createSubject,
  createTeacher,
  createTermForSession,
  enrollStudent,
} from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";

/// The three hand-offs a report card goes through:
///   1. subject teacher submits their sheet → it's with the form teacher
///   2. form teacher adds remarks, submits the card → it's with the admin
///   3. admin publishes → families see it
/// Nothing reaches a parent before step 3, and each step can be sent back.

const app = createApp();
let server: Server;

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
});

afterAll(async () => {
  server.close();
  await resetDb();
});

beforeEach(async () => {
  await resetDb();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function setupWorld() {
  const { token: adminToken } = await createAdmin("admin@test.local");
  const session = await createCurrentAcademicSession("2026/2027");
  const term = await createTermForSession(session.id, "First Term", 1);
  const klass = await createClass("JSS1", "A");
  const ca = await createAssessmentComponent(session.id, "CA", "CA", 40, 1);
  const exam = await createAssessmentComponent(session.id, "EXAM", "EXAM", 60, 2);

  const { staff: formStaff, token: formToken } = await createTeacher("form@test.local");
  await prisma.classFormTeacher.create({
    data: { classId: klass.id, teacherId: formStaff.id, academicSessionId: session.id },
  });
  const { staff: mathsStaff, token: mathsToken } = await createTeacher("maths@test.local");
  const maths = await createSubject("Mathematics", "MTH");
  const mathsAssignment = await createAssignment(klass.id, maths.id, mathsStaff.id, session.id);
  const { staff: englishStaff, token: englishToken } = await createTeacher("english@test.local");
  const english = await createSubject("English", "ENG");
  const englishAssignment = await createAssignment(klass.id, english.id, englishStaff.id, session.id);

  const student = await createBareStudent("ADM-001");
  await enrollStudent(student.id, klass.id, session.id);
  const { parent, token: parentToken } = await createParent("parent@test.local");
  await prisma.studentParent.create({ data: { parentId: parent.id, studentId: student.id, relationship: "MOTHER" } });

  async function enterAndSubmit(token: string, assignmentId: string, caScore: number, examScore: number) {
    const put = await request(server)
      .put(`/api/class-subject-assignments/${assignmentId}/scores`)
      .set(auth(token))
      .send({
        termId: term.id,
        entries: [
          { studentId: student.id, assessmentComponentId: ca.id, rawScore: caScore },
          { studentId: student.id, assessmentComponentId: exam.id, rawScore: examScore },
        ],
      });
    expect(put.status).toBe(200);
    return request(server)
      .post(`/api/class-subject-assignments/${assignmentId}/scores/submit`)
      .set(auth(token))
      .send({ termId: term.id });
  }

  const card = () =>
    prisma.result.findUniqueOrThrow({
      where: { studentId_termId_programme: { studentId: student.id, termId: term.id, programme: "ACADEMIC" } },
    });

  return {
    adminToken,
    formToken,
    mathsToken,
    englishToken,
    parentToken,
    term,
    klass,
    student,
    mathsAssignment,
    englishAssignment,
    enterAndSubmit,
    card,
  };
}

describe("subject teacher → form teacher", () => {
  it("builds the form teacher's DRAFT report card as soon as a subject is submitted — no admin compute", async () => {
    const w = await setupWorld();

    expect(await prisma.result.count()).toBe(0);
    expect((await w.enterAndSubmit(w.mathsToken, w.mathsAssignment.id, 30, 50)).status).toBe(200);

    const afterMaths = await w.card();
    expect(afterMaths.status).toBe("DRAFT");
    expect(Number(afterMaths.totalScore)).toBe(80);

    expect((await w.enterAndSubmit(w.englishToken, w.englishAssignment.id, 20, 40)).status).toBe(200);
    const afterEnglish = await w.card();
    expect(Number(afterEnglish.totalScore)).toBe(140);
    expect(Number(afterEnglish.averageScore)).toBe(70);

    const list = await request(server).get(`/api/classes/${w.klass.id}/results/${w.term.id}`).set(auth(w.formToken));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
  });

  it("lists each subject sheet's status for the form teacher", async () => {
    const w = await setupWorld();
    await w.enterAndSubmit(w.mathsToken, w.mathsAssignment.id, 30, 50);

    const res = await request(server)
      .get(`/api/classes/${w.klass.id}/score-sheets/${w.term.id}`)
      .set(auth(w.formToken));
    expect(res.status).toBe(200);
    const bySubject = Object.fromEntries(
      (res.body as Array<{ subject: { name: string }; status: string; enteredCount: number; expectedCount: number }>).map(
        (r) => [r.subject.name, r],
      ),
    );
    expect(bySubject.Mathematics?.status).toBe("SUBMITTED");
    expect(bySubject.Mathematics?.enteredCount).toBe(2);
    expect(bySubject.Mathematics?.expectedCount).toBe(2);
    expect(bySubject.English?.status).toBe("NOT_STARTED");

    // A subject teacher isn't the reviewer.
    const denied = await request(server)
      .get(`/api/classes/${w.klass.id}/score-sheets/${w.term.id}`)
      .set(auth(w.mathsToken));
    expect(denied.status).toBe(403);
  });

  it("lets the form teacher return a sheet: editable again and off the card until resubmitted", async () => {
    const w = await setupWorld();
    await w.enterAndSubmit(w.mathsToken, w.mathsAssignment.id, 30, 50);
    await w.enterAndSubmit(w.englishToken, w.englishAssignment.id, 20, 40);

    // The subject teacher can't send their own sheet back.
    const selfReturn = await request(server)
      .post(`/api/class-subject-assignments/${w.mathsAssignment.id}/scores/return`)
      .set(auth(w.mathsToken))
      .send({ termId: w.term.id });
    expect(selfReturn.status).toBe(403);

    const returned = await request(server)
      .post(`/api/class-subject-assignments/${w.mathsAssignment.id}/scores/return`)
      .set(auth(w.formToken))
      .send({ termId: w.term.id });
    expect(returned.status).toBe(200);
    expect(returned.body.status).toBe("DRAFT");

    // Only English is on the card now.
    expect(Number((await w.card()).totalScore)).toBe(60);

    // Returning again: nothing submitted to return.
    const again = await request(server)
      .post(`/api/class-subject-assignments/${w.mathsAssignment.id}/scores/return`)
      .set(auth(w.formToken))
      .send({ termId: w.term.id });
    expect(again.status).toBe(400);

    // The maths teacher fixes a mark and resubmits.
    expect((await w.enterAndSubmit(w.mathsToken, w.mathsAssignment.id, 35, 55)).status).toBe(200);
    expect(Number((await w.card()).totalScore)).toBe(150);
  });

  it("locks subject sheets once the form teacher sends the card to the admin", async () => {
    const w = await setupWorld();
    await w.enterAndSubmit(w.mathsToken, w.mathsAssignment.id, 30, 50);
    const { id } = await w.card();

    expect((await request(server).post(`/api/results/${id}/submit`).set(auth(w.formToken))).status).toBe(200);

    const lateSubmit = await w.enterAndSubmit(w.englishToken, w.englishAssignment.id, 20, 40);
    expect(lateSubmit.status).toBe(409);
    expect(lateSubmit.body.error.message).toMatch(/withdraw/);

    const lateReturn = await request(server)
      .post(`/api/class-subject-assignments/${w.mathsAssignment.id}/scores/return`)
      .set(auth(w.formToken))
      .send({ termId: w.term.id });
    expect(lateReturn.status).toBe(409);

    // Withdrawn back to the form teacher, the late subject can come in.
    expect((await request(server).post(`/api/results/${id}/return-to-draft`).set(auth(w.formToken))).status).toBe(200);
    expect((await w.enterAndSubmit(w.englishToken, w.englishAssignment.id, 20, 40)).status).toBe(200);
  });
});

describe("form teacher → admin → published", () => {
  it("only publishes what the form teacher submitted", async () => {
    const w = await setupWorld();
    await w.enterAndSubmit(w.mathsToken, w.mathsAssignment.id, 30, 50);
    const { id } = await w.card();

    const tooEarly = await request(server).post(`/api/results/${id}/finalize`).set(auth(w.adminToken));
    expect(tooEarly.status).toBe(400);
    expect(tooEarly.body.error.message).toMatch(/form teacher/);
    expect((await w.card()).status).toBe("DRAFT");

    await request(server)
      .patch(`/api/results/${id}/class-teacher-comment`)
      .set(auth(w.formToken))
      .send({ comment: "A focused and helpful student." });
    expect((await request(server).post(`/api/results/${id}/submit`).set(auth(w.formToken))).status).toBe(200);

    const published = await request(server).post(`/api/results/${id}/finalize`).set(auth(w.adminToken));
    expect(published.status).toBe(200);
    expect(published.body.status).toBe("FINALIZED");
    expect(published.body.classTeacherComment).toBe("A focused and helpful student.");
  });

  it("hides submitted subject marks from parents until the card is published", async () => {
    const w = await setupWorld();
    await w.enterAndSubmit(w.mathsToken, w.mathsAssignment.id, 30, 50);
    const { id } = await w.card();

    const scoresUrl = `/api/students/${w.student.id}/scores`;
    expect((await request(server).get(scoresUrl).set(auth(w.parentToken))).body).toEqual([]);
    // Staff still see them.
    expect((await request(server).get(scoresUrl).set(auth(w.adminToken))).body).toHaveLength(1);

    await request(server).post(`/api/results/${id}/submit`).set(auth(w.formToken));
    expect((await request(server).get(scoresUrl).set(auth(w.parentToken))).body).toEqual([]);

    await request(server).post(`/api/results/${id}/finalize`).set(auth(w.adminToken));
    const afterPublish = await request(server).get(scoresUrl).set(auth(w.parentToken));
    expect(afterPublish.body).toHaveLength(1);
    expect(afterPublish.body[0].totalScore).toBe("80");
  });
});

describe("head of school's comment bank", () => {
  async function seedBank(adminToken: string) {
    for (const [minAverage, maxAverage, comment, order] of [
      [70, 100, "Excellent work.", 0],
      [70, 100, "Outstanding effort this term.", 1],
      [0, 69.99, "Keep working hard.", 2],
    ] as const) {
      const res = await request(server)
        .post("/api/principal-comment-templates")
        .set(auth(adminToken))
        .send({ minAverage, maxAverage, comment, order });
      expect(res.status).toBe(201);
    }
  }

  it("fills an empty comment from the bank on publish, by the card's average", async () => {
    const w = await setupWorld();
    await seedBank(w.adminToken);
    await w.enterAndSubmit(w.mathsToken, w.mathsAssignment.id, 30, 50); // average 80
    const { id } = await w.card();
    await request(server).post(`/api/results/${id}/submit`).set(auth(w.formToken));

    const published = await request(server).post(`/api/results/${id}/finalize`).set(auth(w.adminToken));
    expect(published.body.principalComment).toBe("Excellent work.");
  });

  it("keeps a comment the admin wrote, and finalize-all fills the rest", async () => {
    const w = await setupWorld();
    await seedBank(w.adminToken);
    await w.enterAndSubmit(w.mathsToken, w.mathsAssignment.id, 20, 30); // average 50
    const { id } = await w.card();
    await request(server).post(`/api/results/${id}/submit`).set(auth(w.formToken));

    const all = await request(server)
      .post("/api/results/finalize-all")
      .set(auth(w.adminToken))
      .send({ termId: w.term.id });
    expect(all.body.finalized).toBe(1);
    expect((await w.card()).principalComment).toBe("Keep working hard.");

    // A second card the admin comments on by hand keeps that comment.
    await prisma.result.update({
      where: { id },
      data: { status: "SUBMITTED", principalComment: "Written by the head." },
    });
    await request(server).post(`/api/results/${id}/finalize`).set(auth(w.adminToken));
    expect((await w.card()).principalComment).toBe("Written by the head.");
  });

  it("manages the bank (admin only) and rejects an inverted range", async () => {
    const { token: adminToken } = await createAdmin("bank-admin@test.local");
    const { token: teacherToken } = await createTeacher("bank-teacher@test.local");

    expect((await request(server).get("/api/principal-comment-templates").set(auth(teacherToken))).status).toBe(403);

    const created = await request(server)
      .post("/api/principal-comment-templates")
      .set(auth(adminToken))
      .send({ minAverage: 50, maxAverage: 60, comment: "Good." });
    expect(created.status).toBe(201);

    const inverted = await request(server)
      .patch(`/api/principal-comment-templates/${created.body.id}`)
      .set(auth(adminToken))
      .send({ maxAverage: 40 });
    expect(inverted.status).toBe(400);

    const edited = await request(server)
      .patch(`/api/principal-comment-templates/${created.body.id}`)
      .set(auth(adminToken))
      .send({ comment: "A good term." });
    expect(edited.body.comment).toBe("A good term.");

    const list = await request(server).get("/api/principal-comment-templates").set(auth(adminToken));
    expect(list.body).toHaveLength(1);

    expect(
      (await request(server).delete(`/api/principal-comment-templates/${created.body.id}`).set(auth(adminToken))).status,
    ).toBe(204);
    expect(
      (await request(server).delete(`/api/principal-comment-templates/${created.body.id}`).set(auth(adminToken))).status,
    ).toBe(404);
  });
});
