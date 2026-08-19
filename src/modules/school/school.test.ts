import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { createAdmin, createTeacher } from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("GET /api/school", () => {
  it("404s before the school has ever been created", async () => {
    const { token } = await createAdmin("admin@test.local");
    const res = await request(app).get("/api/school").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns the singleton once created", async () => {
    const { token } = await createAdmin("admin@test.local");
    await request(app)
      .post("/api/school")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Fountaini International School" });

    const res = await request(app).get("/api/school").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Fountaini International School");
  });

  it("rejects a non-admin caller", async () => {
    const { token } = await createTeacher("teacher@test.local");
    const res = await request(app).get("/api/school").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated caller", async () => {
    const res = await request(app).get("/api/school");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/school", () => {
  it("creates the singleton", async () => {
    const { token } = await createAdmin("admin@test.local");
    const res = await request(app)
      .post("/api/school")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Fountaini International School", contactEmail: "info@fountaini.test" });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Fountaini International School");
    expect(res.body.contactEmail).toBe("info@fountaini.test");
  });

  it("rejects creating a second School record", async () => {
    const { token } = await createAdmin("admin@test.local");
    await request(app)
      .post("/api/school")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "First" });

    const res = await request(app)
      .post("/api/school")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Second" });

    expect(res.status).toBe(409);
    const rows = await prisma.school.count();
    expect(rows, "the losing request must not have created a row").toBe(1);
  });

  it("resolves two concurrent creates as exactly one winner, never two rows", async () => {
    const { token } = await createAdmin("admin@test.local");

    const [a, b] = await Promise.all([
      request(app).post("/api/school").set("Authorization", `Bearer ${token}`).send({ name: "Race A" }),
      request(app).post("/api/school").set("Authorization", `Bearer ${token}`).send({ name: "Race B" }),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 409]);
    expect(await prisma.school.count()).toBe(1);
  });

  it("rejects a missing name", async () => {
    const { token } = await createAdmin("admin@test.local");
    const res = await request(app).post("/api/school").set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
  });

  it("rejects a non-admin caller", async () => {
    const { token } = await createTeacher("teacher@test.local");
    const res = await request(app).post("/api/school").set("Authorization", `Bearer ${token}`).send({ name: "X" });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/school", () => {
  it("updates fields on the existing singleton", async () => {
    const { token } = await createAdmin("admin@test.local");
    await request(app).post("/api/school").set("Authorization", `Bearer ${token}`).send({ name: "Original Name" });

    const res = await request(app)
      .patch("/api/school")
      .set("Authorization", `Bearer ${token}`)
      .send({ address: "1 Example Street" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Original Name");
    expect(res.body.address).toBe("1 Example Street");
  });

  it("404s before the school has ever been created", async () => {
    const { token } = await createAdmin("admin@test.local");
    const res = await request(app)
      .patch("/api/school")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Doesn't matter" });
    expect(res.status).toBe(404);
  });

  it("rejects a non-admin caller", async () => {
    const { token } = await createTeacher("teacher@test.local");
    const res = await request(app).patch("/api/school").set("Authorization", `Bearer ${token}`).send({ name: "X" });
    expect(res.status).toBe(403);
  });
});
