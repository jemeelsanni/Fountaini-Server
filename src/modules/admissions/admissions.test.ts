import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { createAdmin, createBareStudent, createClass } from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("POST /api/admission-enquiries — public", () => {
  it("accepts a submission with no authentication at all", async () => {
    const res = await request(app).post("/api/admission-enquiries").send({
      prospectiveFirstName: "Amina",
      prospectiveLastName: "Bello",
      parentFullName: "Musa Bello",
      parentPhone: "+2348012345678",
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("NEW");
  });

  it("rejects a desiredClassId that doesn't exist", async () => {
    const res = await request(app).post("/api/admission-enquiries").send({
      prospectiveFirstName: "Amina",
      prospectiveLastName: "Bello",
      parentFullName: "Musa Bello",
      parentPhone: "+2348012345678",
      desiredClassId: "does-not-exist",
    });

    expect(res.status).toBe(404);
  });

  it("accepts a valid desiredClassId", async () => {
    const klass = await createClass("JSS1", "A");

    const res = await request(app).post("/api/admission-enquiries").send({
      prospectiveFirstName: "Amina",
      prospectiveLastName: "Bello",
      parentFullName: "Musa Bello",
      parentPhone: "+2348012345678",
      desiredClassId: klass.id,
    });

    expect(res.status).toBe(201);
    expect(res.body.desiredClassId).toBe(klass.id);
  });
});

describe("staff triage — admin only", () => {
  it("lists, filters by status, and updates an enquiry's status/notes", async () => {
    const { token, user } = await createAdmin("admin@test.local");
    await request(app).post("/api/admission-enquiries").send({
      prospectiveFirstName: "Amina",
      prospectiveLastName: "Bello",
      parentFullName: "Musa Bello",
      parentPhone: "+2348012345678",
    });
    const enquiry = await prisma.admissionEnquiry.findFirstOrThrow();

    const updateRes = await request(app)
      .patch(`/api/admission-enquiries/${enquiry.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "CONTACTED", notes: "Called the family, scheduling a visit" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.status).toBe("CONTACTED");
    expect(updateRes.body.handledByUserId).toBe(user.id);

    const filtered = await request(app)
      .get("/api/admission-enquiries?status=CONTACTED")
      .set("Authorization", `Bearer ${token}`);
    expect(filtered.body).toHaveLength(1);

    const filteredOther = await request(app)
      .get("/api/admission-enquiries?status=NEW")
      .set("Authorization", `Bearer ${token}`);
    expect(filteredOther.body).toHaveLength(0);
  });
});

describe("POST /api/admission-enquiries/:id/convert", () => {
  it("creates a real student from the enquiry and links it back", async () => {
    const { token, user } = await createAdmin("admin@test.local");
    await request(app).post("/api/admission-enquiries").send({
      prospectiveFirstName: "Amina",
      prospectiveLastName: "Bello",
      parentFullName: "Musa Bello",
      parentPhone: "+2348012345678",
    });
    const enquiry = await prisma.admissionEnquiry.findFirstOrThrow();

    const convertRes = await request(app)
      .post(`/api/admission-enquiries/${enquiry.id}/convert`)
      .set("Authorization", `Bearer ${token}`)
      .send({ admissionNumber: "ADM-2027-001" });

    expect(convertRes.status).toBe(201);
    expect(convertRes.body.student.firstName).toBe("Amina");
    expect(convertRes.body.student.admissionNumber).toBe("ADM-2027-001");
    expect(convertRes.body.enquiry.status).toBe("CONVERTED");
    expect(convertRes.body.enquiry.convertedStudentId).toBe(convertRes.body.student.id);
    expect(convertRes.body.enquiry.handledByUserId).toBe(user.id);

    const studentRow = await prisma.student.findUnique({ where: { id: convertRes.body.student.id } });
    expect(studentRow).not.toBeNull();
  });

  it("rejects converting the same enquiry twice", async () => {
    const { token } = await createAdmin("admin@test.local");
    await request(app).post("/api/admission-enquiries").send({
      prospectiveFirstName: "Amina",
      prospectiveLastName: "Bello",
      parentFullName: "Musa Bello",
      parentPhone: "+2348012345678",
    });
    const enquiry = await prisma.admissionEnquiry.findFirstOrThrow();

    await request(app)
      .post(`/api/admission-enquiries/${enquiry.id}/convert`)
      .set("Authorization", `Bearer ${token}`)
      .send({ admissionNumber: "ADM-2027-001" });

    const res = await request(app)
      .post(`/api/admission-enquiries/${enquiry.id}/convert`)
      .set("Authorization", `Bearer ${token}`)
      .send({ admissionNumber: "ADM-2027-002" });

    expect(res.status).toBe(409);
  });

  it("rejects converting into a duplicate admission number", async () => {
    const { token } = await createAdmin("admin@test.local");
    await createBareStudent("ADM-DUPLICATE");
    await request(app).post("/api/admission-enquiries").send({
      prospectiveFirstName: "Amina",
      prospectiveLastName: "Bello",
      parentFullName: "Musa Bello",
      parentPhone: "+2348012345678",
    });
    const enquiry = await prisma.admissionEnquiry.findFirstOrThrow();

    const res = await request(app)
      .post(`/api/admission-enquiries/${enquiry.id}/convert`)
      .set("Authorization", `Bearer ${token}`)
      .send({ admissionNumber: "ADM-DUPLICATE" });

    expect(res.status).toBe(409);
  });
});
