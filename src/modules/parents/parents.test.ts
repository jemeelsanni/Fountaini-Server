import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { createAdmin, createBareStudent, createParent, createTeacher } from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";

const app = createApp();

async function createParentUserRecord(email: string) {
  const passwordHash = "unused";
  return prisma.user.create({ data: { email, passwordHash, role: "PARENT" } });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("POST /api/parents", () => {
  it("allows an admin to create a parent profile linked to a PARENT user", async () => {
    const { token } = await createAdmin("admin@test.local");
    const parentUser = await createParentUserRecord("newparent@test.local");

    const res = await request(app)
      .post("/api/parents")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: parentUser.id, firstName: "Grace", lastName: "Hopper" });

    expect(res.status).toBe(201);
    expect(res.body.firstName).toBe("Grace");
  });

  it("rejects linking to a user that isn't the PARENT role", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { user: teacherUser } = await createTeacher("teacher@test.local");

    const res = await request(app)
      .post("/api/parents")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: teacherUser.id, firstName: "Grace", lastName: "Hopper" });

    expect(res.status).toBe(400);
  });

});

describe("child linking", () => {
  it("links a child, lists it under /me/children, and unlinks it", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { parent, token: parentToken } = await createParent("parent@test.local");
    const child = await createBareStudent("ADM-600");

    const linkRes = await request(app)
      .post(`/api/parents/${parent.id}/children`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ studentId: child.id, relationship: "MOTHER", isPrimaryContact: true });
    expect(linkRes.status).toBe(201);

    const myChildren = await request(app)
      .get("/api/parents/me/children")
      .set("Authorization", `Bearer ${parentToken}`);
    expect(myChildren.status).toBe(200);
    expect(myChildren.body).toHaveLength(1);
    expect(myChildren.body[0].studentId).toBe(child.id);

    const unlinkRes = await request(app)
      .delete(`/api/parents/${parent.id}/children/${child.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(unlinkRes.status).toBe(204);

    const afterUnlink = await request(app)
      .get("/api/parents/me/children")
      .set("Authorization", `Bearer ${parentToken}`);
    expect(afterUnlink.body).toHaveLength(0);
  });

  it("rejects linking the same child to the same parent twice", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { parent } = await createParent("parent@test.local");
    const child = await createBareStudent("ADM-601");
    const body = { studentId: child.id, relationship: "FATHER" };

    await request(app)
      .post(`/api/parents/${parent.id}/children`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body);
    const res = await request(app)
      .post(`/api/parents/${parent.id}/children`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body);

    expect(res.status).toBe(409);
  });
});
