import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { createAdmin, createBursar, createParent, createStudentWithLogin, createTeacher } from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";
import { waitForAuditLog } from "../../test/waitForAuditLog.js";

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

describe("GET /api/school", () => {
  it("404s before the school has ever been created", async () => {
    const { token } = await createAdmin("admin@test.local");
    const res = await request(server).get("/api/school").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns the singleton once created", async () => {
    const { token } = await createAdmin("admin@test.local");
    await request(server)
      .post("/api/school")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Fountaini International School" });

    const res = await request(server).get("/api/school").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Fountaini International School");
  });

  // Widened to every authenticated role — school-wide name/address/contact
  // info carries nothing a parent or student shouldn't see (see
  // school.routes.ts's own comment); only the writes (POST/PATCH) stay
  // ADMIN-only, covered separately below.
  it("allows every authenticated role to read it", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    await request(server)
      .post("/api/school")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Fountaini International School" });

    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { token: bursarToken } = await createBursar("bursar@test.local");
    const { token: parentToken } = await createParent("parent@test.local");
    const { token: studentToken } = await createStudentWithLogin("student@test.local", "SCH-STU-001");

    for (const token of [teacherToken, bursarToken, parentToken, studentToken]) {
      const res = await request(server).get("/api/school").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    }
  });

  it("rejects an unauthenticated caller", async () => {
    const res = await request(server).get("/api/school");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/school", () => {
  it("creates the singleton", async () => {
    const { token } = await createAdmin("admin@test.local");
    const res = await request(server)
      .post("/api/school")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Fountaini International School", contactEmail: "info@fountaini.test" });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Fountaini International School");
    expect(res.body.contactEmail).toBe("info@fountaini.test");
  });

  it("rejects creating a second School record", async () => {
    const { token } = await createAdmin("admin@test.local");
    await request(server)
      .post("/api/school")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "First" });

    const res = await request(server)
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
      request(server).post("/api/school").set("Authorization", `Bearer ${token}`).send({ name: "Race A" }),
      request(server).post("/api/school").set("Authorization", `Bearer ${token}`).send({ name: "Race B" }),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 409]);
    expect(await prisma.school.count()).toBe(1);
  });

  it("rejects a missing name", async () => {
    const { token } = await createAdmin("admin@test.local");
    const res = await request(server).post("/api/school").set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
  });

  it("rejects a non-admin caller", async () => {
    const { token } = await createTeacher("teacher@test.local");
    const res = await request(server).post("/api/school").set("Authorization", `Bearer ${token}`).send({ name: "X" });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/school", () => {
  it("updates fields on the existing singleton", async () => {
    const { token } = await createAdmin("admin@test.local");
    await request(server).post("/api/school").set("Authorization", `Bearer ${token}`).send({ name: "Original Name" });

    const res = await request(server)
      .patch("/api/school")
      .set("Authorization", `Bearer ${token}`)
      .send({ address: "1 Example Street" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Original Name");
    expect(res.body.address).toBe("1 Example Street");
  });

  it("404s before the school has ever been created", async () => {
    const { token } = await createAdmin("admin@test.local");
    const res = await request(server)
      .patch("/api/school")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Doesn't matter" });
    expect(res.status).toBe(404);
  });

  it("rejects a non-admin caller", async () => {
    const { token } = await createTeacher("teacher@test.local");
    const res = await request(server).patch("/api/school").set("Authorization", `Bearer ${token}`).send({ name: "X" });
    expect(res.status).toBe(403);
  });
});

describe("PUT/DELETE /api/school/signature", () => {
  const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngDataUrl = (size: number, fill = 0) =>
    `data:image/png;base64,${Buffer.concat([PNG_HEADER, Buffer.alloc(size - PNG_HEADER.length, fill)]).toString("base64")}`;

  async function setup() {
    const { token } = await createAdmin("admin@test.local");
    const school = await prisma.school.create({ data: { name: "Fountain-I Academy" } });
    const put = (dataUrl: unknown) =>
      request(server).put("/api/school/signature").set("Authorization", `Bearer ${token}`).send({ dataUrl });
    return { token, school, put };
  }

  it("sets the signature, flags it on GET /api/school and serves it from GET /api/school/signature to every role", async () => {
    const { put } = await setup();
    const dataUrl = pngDataUrl(30 * 1024);

    const res = await put(dataUrl);

    expect(res.status).toBe(200);
    expect(res.body.hasHeadSignature).toBe(true);
    expect(res.body).not.toHaveProperty("headSignature");
    const { token: parentToken } = await createParent("parent@test.local");
    const school = await request(server).get("/api/school").set("Authorization", `Bearer ${parentToken}`);
    const signature = await request(server).get("/api/school/signature").set("Authorization", `Bearer ${parentToken}`);
    expect(school.body).toMatchObject({ hasHeadSignature: true });
    expect(school.body).not.toHaveProperty("headSignature");
    expect(signature.body).toEqual({ headSignature: dataUrl });
  });

  it("is reachable past the JSON limit at a differently-cased path with a trailing slash", async () => {
    const { token } = await setup();

    const res = await request(server)
      .put("/api/School/Signature/")
      .set("Authorization", `Bearer ${token}`)
      .send({ dataUrl: pngDataUrl(500 * 1024) });

    expect(res.status).toBe(200);
  });

  it("accepts a 2 MB image, past the app-wide 100 KB JSON limit", async () => {
    const { put } = await setup();

    const res = await put(pngDataUrl(2 * 1024 * 1024));

    expect(res.status).toBe(200);
  });

  it("replaces an existing signature", async () => {
    const { token, put } = await setup();
    await put(pngDataUrl(1024, 1));
    const replacement = pngDataUrl(1024, 2);

    const res = await put(replacement);

    expect(res.status).toBe(200);
    const read = await request(server).get("/api/school/signature").set("Authorization", `Bearer ${token}`);
    expect(read.body.headSignature).toBe(replacement);
  });

  it("clears it with DELETE", async () => {
    const { token, put } = await setup();
    await put(pngDataUrl(1024));

    const res = await request(server).delete("/api/school/signature").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.hasHeadSignature).toBe(false);
    const read = await request(server).get("/api/school/signature").set("Authorization", `Bearer ${token}`);
    expect(read.body.headSignature).toBeNull();
  });

  it("rejects an image over 2 MB with a readable 400", async () => {
    const { put } = await setup();

    const res = await put(pngDataUrl(2 * 1024 * 1024 + 1));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Signature image is too large (max 2 MB)");
  });

  it("rejects a body past the route's own 3 MB limit with the same 400, not a 500", async () => {
    const { put } = await setup();

    const res = await put(pngDataUrl(3 * 1024 * 1024));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Signature image is too large (max 2 MB)");
  });

  it("rejects a disallowed MIME type", async () => {
    const { put } = await setup();

    const res = await put(`data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/PNG, JPEG or WebP/);
  });

  it("rejects data whose bytes don't match the declared type", async () => {
    const { put } = await setup();

    const res = await put(`data:image/png;base64,${Buffer.from("not really a png").toString("base64")}`);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Signature data is not a valid PNG image");
  });

  it("rejects a malformed value", async () => {
    const { put } = await setup();

    const notADataUrl = await put("hello");
    const notAString = await put(42);

    expect(notADataUrl.status).toBe(400);
    expect(notAString.status).toBe(400);
  });

  it("is ADMIN-only", async () => {
    await setup();
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { token: bursarToken } = await createBursar("bursar@test.local");

    for (const token of [teacherToken, bursarToken]) {
      const put = await request(server)
        .put("/api/school/signature")
        .set("Authorization", `Bearer ${token}`)
        .send({ dataUrl: pngDataUrl(1024) });
      const del = await request(server).delete("/api/school/signature").set("Authorization", `Bearer ${token}`);
      expect(put.status).toBe(403);
      expect(del.status).toBe(403);
    }
  });

  it("audits set and clear without storing the image", async () => {
    const { token, school, put } = await setup();
    await put(pngDataUrl(1024));
    await request(server).delete("/api/school/signature").set("Authorization", `Bearer ${token}`);

    const set = await waitForAuditLog("School", school.id, "SCHOOL_SIGNATURE_SET");
    const cleared = await waitForAuditLog("School", school.id, "SCHOOL_SIGNATURE_CLEARED");

    expect(set?.afterData).toMatchObject({ hasHeadSignature: true });
    expect(cleared?.afterData).toMatchObject({ hasHeadSignature: false });
    expect(JSON.stringify(set?.afterData)).not.toContain("base64");
  });
});
