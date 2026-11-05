import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import {
  createAdmin,
  createAssignment,
  createBursar,
  createClass,
  createCurrentAcademicSession,
  createSubject,
  createTeacher,
} from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";

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

interface TemplateBody {
  id: string;
  name: string;
  description: string | null;
  subjects: { subjectId: string; optional: boolean; subject: { id: string; name: string } }[];
}

async function setup() {
  const { token } = await createAdmin("admin@test.local");
  const maths = await createSubject("Mathematics", "MTH");
  const english = await createSubject("English", "ENG");
  const hadith = await createSubject("Hadith", "ISL-HAD");
  return { token, maths, english, hadith };
}

function post(token: string, body: object) {
  return request(server).post("/api/subject-templates").set("Authorization", `Bearer ${token}`).send(body);
}

describe("subject templates", () => {
  it("creates a template, returning subjects in order with the nested subject", async () => {
    const { token, maths, english } = await setup();

    const res = await post(token, {
      name: "Primary",
      description: "Primary 1–6",
      subjects: [{ subjectId: english.id }, { subjectId: maths.id, optional: true }],
    });

    expect(res.status).toBe(201);
    const body = res.body as TemplateBody;
    expect(body.name).toBe("Primary");
    expect(body.description).toBe("Primary 1–6");
    expect(body.subjects.map((s) => [s.subjectId, s.optional, s.subject.name])).toEqual([
      [english.id, false, "English"],
      [maths.id, true, "Mathematics"],
    ]);
  });

  it("stores an omitted or empty description as null", async () => {
    const { token } = await setup();

    const omitted = await post(token, { name: "Creche", subjects: [] });
    const empty = await post(token, { name: "Early Years", description: "  ", subjects: [] });

    expect((omitted.body as TemplateBody).description).toBeNull();
    expect((empty.body as TemplateBody).description).toBeNull();
  });

  it("lists templates by name", async () => {
    const { token, maths } = await setup();
    await post(token, { name: "SSS", subjects: [] });
    await post(token, { name: "JSS", subjects: [{ subjectId: maths.id }] });

    const res = await request(server).get("/api/subject-templates").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const body = res.body as TemplateBody[];
    expect(body.map((t) => t.name)).toEqual(["JSS", "SSS"]);
    expect(body[0]?.subjects[0]?.subject.id).toBe(maths.id);
  });

  it("rejects a blank name with a 400", async () => {
    const { token } = await setup();

    const res = await post(token, { name: "   ", subjects: [] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "BAD_REQUEST", message: "Template name is required" } });
  });

  it("rejects a duplicate name in a different case with a 400, not a 500", async () => {
    const { token } = await setup();
    await post(token, { name: "Primary", subjects: [] });

    const res = await post(token, { name: "PRIMARY", subjects: [] });

    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toMatch(/already exists/);
  });

  it("rejects an unknown subjectId with a 400", async () => {
    const { token, maths } = await setup();

    const res = await post(token, { name: "Primary", subjects: [{ subjectId: maths.id }, { subjectId: "nope" }] });

    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toMatch(/Unknown subject: nope/);
    expect(await prisma.subjectTemplate.count()).toBe(0);
  });

  it("rejects a subjectId listed twice with a 400", async () => {
    const { token, maths } = await setup();

    const res = await post(token, { name: "Primary", subjects: [{ subjectId: maths.id }, { subjectId: maths.id }] });

    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toMatch(/only appear once/);
  });

  it("PATCH replaces the subject list and reorders it", async () => {
    const { token, maths, english, hadith } = await setup();
    const created = await post(token, {
      name: "Primary",
      subjects: [{ subjectId: maths.id }, { subjectId: english.id }],
    });
    const { id } = created.body as TemplateBody;

    const res = await request(server)
      .patch(`/api/subject-templates/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Primary 1–6",
        description: "Renamed",
        subjects: [{ subjectId: hadith.id, optional: true }, { subjectId: maths.id }],
      });

    expect(res.status).toBe(200);
    const body = res.body as TemplateBody;
    expect(body.name).toBe("Primary 1–6");
    expect(body.description).toBe("Renamed");
    expect(body.subjects.map((s) => [s.subjectId, s.optional])).toEqual([
      [hadith.id, true],
      [maths.id, false],
    ]);
    expect(await prisma.subjectTemplateSubject.count({ where: { templateId: id } })).toBe(2);
  });

  it("PATCH can keep the template's own name in a different case", async () => {
    const { token } = await setup();
    const created = await post(token, { name: "Primary", subjects: [] });

    const res = await request(server)
      .patch(`/api/subject-templates/${(created.body as TemplateBody).id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "PRIMARY", subjects: [] });

    expect(res.status).toBe(200);
    expect((res.body as TemplateBody).name).toBe("PRIMARY");
  });

  it("PATCH to another template's name is a 400", async () => {
    const { token } = await setup();
    await post(token, { name: "JSS", subjects: [] });
    const sss = await post(token, { name: "SSS", subjects: [] });

    const res = await request(server)
      .patch(`/api/subject-templates/${(sss.body as TemplateBody).id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "jss", subjects: [] });

    expect(res.status).toBe(400);
  });

  it("PATCH on a missing template is a 404", async () => {
    const { token } = await setup();

    const res = await request(server)
      .patch("/api/subject-templates/missing")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "X", subjects: [] });

    expect(res.status).toBe(404);
  });

  it("DELETE removes the template but leaves class-subject assignments alone", async () => {
    const { token, maths } = await setup();
    const { staff } = await createTeacher("teacher@test.local");
    const klass = await createClass("Basic 1");
    const session = await createCurrentAcademicSession("2026/2027");
    const assignment = await createAssignment(klass.id, maths.id, staff.id, session.id);
    const created = await post(token, { name: "Basic", subjects: [{ subjectId: maths.id }] });

    const res = await request(server)
      .delete(`/api/subject-templates/${(created.body as TemplateBody).id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(await prisma.subjectTemplate.count()).toBe(0);
    expect(await prisma.subjectTemplateSubject.count()).toBe(0);
    expect(await prisma.classSubjectAssignment.findUnique({ where: { id: assignment.id } })).not.toBeNull();
  });

  it("deleting a subject drops it from templates instead of failing", async () => {
    const { token, maths, english } = await setup();
    const created = await post(token, {
      name: "Primary",
      subjects: [{ subjectId: maths.id }, { subjectId: english.id }],
    });

    await prisma.subject.delete({ where: { id: maths.id } });

    const template = await prisma.subjectTemplate.findUnique({
      where: { id: (created.body as TemplateBody).id },
      include: { subjects: true },
    });
    expect(template?.subjects.map((s) => s.subjectId)).toEqual([english.id]);
  });

  it("is ADMIN-only", async () => {
    const { token: bursarToken } = await createBursar("bursar@test.local");
    const { token: teacherToken } = await createTeacher("teacher@test.local");

    for (const token of [bursarToken, teacherToken]) {
      const list = await request(server).get("/api/subject-templates").set("Authorization", `Bearer ${token}`);
      const create = await post(token, { name: "Primary", subjects: [] });
      expect(list.status).toBe(403);
      expect(create.status).toBe(403);
    }
  });

  it("still lets POST /api/subjects create a MADRASSAH subject sharing an academic subject's name", async () => {
    const { token } = await setup();

    const res = await request(server)
      .post("/api/subjects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Mathematics", code: "ISL-MTH", type: "MADRASSAH" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Mathematics", type: "MADRASSAH" });
  });
});
