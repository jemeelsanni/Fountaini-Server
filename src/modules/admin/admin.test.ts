import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { createAdmin, createBursar, createParent, createTeacher } from "../../test/factories.js";
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

describe("GET /api/admin/contact-gaps", () => {
  it("lists a parent missing a phone number, and excludes one with a valid phone on file", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { parent: missingParent } = await createParent("missing@test.local");
    await prisma.parent.update({ where: { id: missingParent.id }, data: { firstName: "Grace", lastName: "Hopper" } });
    const { parent: coveredParent } = await createParent("covered@test.local");
    await prisma.parent.update({
      where: { id: coveredParent.id },
      data: { firstName: "Ada", lastName: "Lovelace", phone: "+2348012345678" },
    });

    const res = await request(server).get("/api/admin/contact-gaps").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(missingParent.id);
    expect(ids).not.toContain(coveredParent.id);

    const entry = (res.body as Array<{ id: string; name: string; role: string; missingField: string }>).find(
      (r) => r.id === missingParent.id,
    );
    expect(entry?.name).toBe("Grace Hopper");
    expect(entry?.role).toBe("PARENT");
    expect(entry?.missingField).toBe("phone");
  });

  it("is reachable by BURSAR as well as ADMIN", async () => {
    const { token } = await createBursar("bursar@test.local");
    await createParent("nophone@test.local");

    const res = await request(server).get("/api/admin/contact-gaps").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("blocks a TEACHER", async () => {
    const { token } = await createTeacher("teacher@test.local");

    const res = await request(server).get("/api/admin/contact-gaps").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});
