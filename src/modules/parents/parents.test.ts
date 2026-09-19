import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { createAdmin, createBareStudent, createParent, createStaffParent, createTeacher } from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";
import { waitForNotification } from "../../test/waitForNotification.js";

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("POST /api/parents", () => {
  it("atomically creates the User and Parent profile, generates a login, and emails it to the parent", async () => {
    const { token } = await createAdmin("admin@test.local");

    const res = await request(app)
      .post("/api/parents")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "newparent@test.local", firstName: "Grace", lastName: "Hopper" });

    expect(res.status).toBe(201);
    expect(res.body.firstName).toBe("Grace");
    // Unlike student creation's no-destination fallback, a parent always has
    // their own email — the password is only ever delivered by notification.
    expect(res.body.temporaryPassword).toBeUndefined();

    const user = await prisma.user.findUniqueOrThrow({ where: { id: res.body.userId as string } });
    expect(user.loginId).toBe("newparent@test.local");
    expect(user.mustChangePassword).toBe(true);
    const roles = await prisma.userRole.findMany({ where: { userId: user.id } });
    expect(roles.map((r) => r.role)).toEqual(["PARENT"]);

    const notification = await waitForNotification(user.id, "Parent", res.body.id as string);
    expect(notification, "creating a parent must email them their credentials").toBeTruthy();
    expect(notification?.body).toMatch(/Temporary password: \S+/);
  });

  it("rejects a duplicate email with 409, never creating a second User or Parent", async () => {
    const { token } = await createAdmin("admin@test.local");
    const body = { email: "dupe-parent@test.local", firstName: "Grace", lastName: "Hopper" };

    const first = await request(app).post("/api/parents").set("Authorization", `Bearer ${token}`).send(body);
    expect(first.status).toBe(201);
    // Drain the fire-and-forget credential-issuance notification this
    // create triggers before moving on — an unawaited one can otherwise
    // land mid-way through a later test's resetDb() and trip its FK.
    await waitForNotification(first.body.userId as string, "Parent", first.body.id as string);

    const second = await request(app).post("/api/parents").set("Authorization", `Bearer ${token}`).send(body);
    expect(second.status).toBe(409);

    const users = await prisma.user.findMany({ where: { email: "dupe-parent@test.local" } });
    expect(users).toHaveLength(1);
    const parents = await prisma.parent.findMany({ where: { userId: users[0]?.id } });
    expect(parents).toHaveLength(1);
  });

  // loginId is one shared namespace across every account-creation path —
  // this proves a PARENT's email is checked against it even when the
  // existing collision came from a completely different creation route
  // (POST /api/users, a bare ADMIN account), not just a second parent.
  it("rejects an email that collides with an existing (different-route) account's loginId", async () => {
    const { token } = await createAdmin("admin@test.local");

    const adminRes = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "shared-identifier@test.local", role: "ADMIN" });
    expect(adminRes.status).toBe(201);
    // Same drain as above, for POST /api/users's own fire-and-forget
    // credential notification.
    await waitForNotification(adminRes.body.id as string, "User", adminRes.body.id as string);

    const res = await request(app)
      .post("/api/parents")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "shared-identifier@test.local", firstName: "Grace", lastName: "Hopper" });

    expect(res.status).toBe(409);
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

    // isPrimaryContact: true fires an unawaited credential-issuance
    // background task (bcrypt hashing is slow) — drain it before this test
    // ends, or its late NotificationEvent write can land mid-way through
    // the next test's resetDb() and violate the FK it deletes under.
    await waitForNotification(parent.userId, "Student", child.id);

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

  it("rejects a second parent marked primary contact for the same student", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { parent: firstParent } = await createParent("first-parent@test.local");
    const { parent: secondParent } = await createParent("second-parent@test.local");
    const child = await createBareStudent("ADM-602");

    const first = await request(app)
      .post(`/api/parents/${firstParent.id}/children`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ studentId: child.id, relationship: "MOTHER", isPrimaryContact: true });
    expect(first.status).toBe(201);
    // Drain the fire-and-forget credential issuance this primary-contact
    // link triggers before moving on — see the identical comment above.
    await waitForNotification(firstParent.userId, "Student", child.id);

    const second = await request(app)
      .post(`/api/parents/${secondParent.id}/children`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ studentId: child.id, relationship: "FATHER", isPrimaryContact: true });
    expect(second.status).toBe(409);

    // Not linked at all as a side effect of the rejected attempt — this
    // student still has exactly one linked parent.
    const links = await prisma.studentParent.findMany({ where: { studentId: child.id } });
    expect(links).toHaveLength(1);
  });

  it("issues a student login the first time a primary-contact parent is linked", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { parent } = await createParent("parent@test.local");
    const child = await createBareStudent("ADM-610", { firstName: "Ada" });
    expect(child.userId).toBeNull();

    const res = await request(app)
      .post(`/api/parents/${parent.id}/children`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ studentId: child.id, relationship: "MOTHER", isPrimaryContact: true });
    expect(res.status).toBe(201);

    const notification = await waitForNotification(parent.userId, "Student", child.id);
    expect(notification, "issuing a login must notify the primary-contact parent").toBeTruthy();
    expect(notification?.subject).toContain("Ada");
    expect(notification?.body).toMatch(/Temporary password: \S+/);

    const issued = await prisma.student.findUniqueOrThrow({ where: { id: child.id } });
    expect(issued.userId).not.toBeNull();
    const loginUser = await prisma.user.findUniqueOrThrow({ where: { id: issued.userId! } });
    expect(loginUser.loginId).toBe(child.admissionNumber);
    expect(loginUser.mustChangePassword).toBe(true);
    const roles = await prisma.userRole.findMany({ where: { userId: loginUser.id } });
    expect(roles.map((r) => r.role)).toEqual(["STUDENT"]);
  });

  it("does not reissue a login when a second, non-primary parent is linked", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { parent: primaryParent } = await createParent("primary-parent@test.local");
    const { parent: secondParent } = await createParent("second-parent@test.local");
    const child = await createBareStudent("ADM-611");

    await request(app)
      .post(`/api/parents/${primaryParent.id}/children`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ studentId: child.id, relationship: "MOTHER", isPrimaryContact: true });
    const firstNotification = await waitForNotification(primaryParent.userId, "Student", child.id);
    expect(firstNotification).toBeTruthy();
    const issuedOnce = await prisma.student.findUniqueOrThrow({ where: { id: child.id } });
    expect(issuedOnce.userId).not.toBeNull();

    const res = await request(app)
      .post(`/api/parents/${secondParent.id}/children`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ studentId: child.id, relationship: "FATHER" });
    expect(res.status).toBe(201);

    const secondParentNotification = await waitForNotification(secondParent.userId, "Student", child.id);
    expect(secondParentNotification, "a non-primary link must never trigger issuance").toBeNull();
    const stillSame = await prisma.student.findUniqueOrThrow({ where: { id: child.id } });
    expect(stillSame.userId).toBe(issuedOnce.userId);
  });

  it("relinking a new primary-contact parent after the original is unlinked stays silent — reissue is the admin's fix", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { parent: originalParent } = await createParent("original-parent@test.local");
    const { parent: newParent } = await createParent("new-parent@test.local");
    const child = await createBareStudent("ADM-612");

    await request(app)
      .post(`/api/parents/${originalParent.id}/children`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ studentId: child.id, relationship: "MOTHER", isPrimaryContact: true });
    await waitForNotification(originalParent.userId, "Student", child.id);
    const issuedOnce = await prisma.student.findUniqueOrThrow({ where: { id: child.id } });
    expect(issuedOnce.userId).not.toBeNull();

    const unlinkRes = await request(app)
      .delete(`/api/parents/${originalParent.id}/children/${child.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(unlinkRes.status).toBe(204);

    const relinkRes = await request(app)
      .post(`/api/parents/${newParent.id}/children`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ studentId: child.id, relationship: "FATHER", isPrimaryContact: true });
    expect(relinkRes.status).toBe(201);

    const newParentNotification = await waitForNotification(newParent.userId, "Student", child.id);
    expect(newParentNotification, "relinking a new primary contact must not silently reissue").toBeNull();
    const stillSame = await prisma.student.findUniqueOrThrow({ where: { id: child.id } });
    expect(stillSame.userId).toBe(issuedOnce.userId);
  });
});

describe("GET /api/parents/:id/children", () => {
  async function buildLinkedParentWithChild() {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { parent, token: parentToken } = await createParent("parent@test.local");
    const child = await createBareStudent("ADM-700");
    await request(app)
      .post(`/api/parents/${parent.id}/children`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ studentId: child.id, relationship: "MOTHER" });
    return { adminToken, parent, parentToken, child };
  }

  it("lets an admin list a parent's linked children, same shape as /me/children", async () => {
    const { adminToken, parent, child } = await buildLinkedParentWithChild();

    const res = await request(app)
      .get(`/api/parents/${parent.id}/children`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].studentId).toBe(child.id);
    expect(res.body[0].student.id).toBe(child.id);
  });

  it("lets a parent list their own children via their own id", async () => {
    const { parent, parentToken, child } = await buildLinkedParentWithChild();

    const res = await request(app)
      .get(`/api/parents/${parent.id}/children`)
      .set("Authorization", `Bearer ${parentToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].studentId).toBe(child.id);
  });

  it("denies a parent reading another family's children with 403 — an ownership mismatch, not a visibility filter", async () => {
    const { parent } = await buildLinkedParentWithChild();
    const { token: otherParentToken } = await createParent("other-parent@test.local");

    const res = await request(app)
      .get(`/api/parents/${parent.id}/children`)
      .set("Authorization", `Bearer ${otherParentToken}`);

    expect(res.status).toBe(403);
  });

  it("denies a TEACHER outright — a teacher must not be able to enumerate a family's structure from a parent id", async () => {
    const { parent } = await buildLinkedParentWithChild();
    const { token: teacherToken } = await createTeacher("teacher@test.local");

    const res = await request(app)
      .get(`/api/parents/${parent.id}/children`)
      .set("Authorization", `Bearer ${teacherToken}`);

    expect(res.status).toBe(403);
  });

  it("a staff-parent may read their own children via their own parent id, holding TEACHER too notwithstanding", async () => {
    const staffParent = await createStaffParent("staff-parent@test.local");
    const child = await createBareStudent("ADM-701");
    await prisma.studentParent.create({
      data: { parentId: staffParent.parent.id, studentId: child.id, relationship: "FATHER" },
    });

    const res = await request(app)
      .get(`/api/parents/${staffParent.parent.id}/children`)
      .set("Authorization", `Bearer ${staffParent.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].studentId).toBe(child.id);
  });
});
