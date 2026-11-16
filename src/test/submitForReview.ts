import { prisma } from "../db/client.js";

/// The form teacher's hand-off (DRAFT -> SUBMITTED), for tests that only
/// care what happens when an admin then publishes: finalizeResult accepts
/// SUBMITTED results only. Leaves anything not DRAFT alone.
export async function submitForReview(...resultIds: string[]): Promise<void> {
  await prisma.result.updateMany({
    where: { id: { in: resultIds }, status: "DRAFT" },
    data: { status: "SUBMITTED", submittedAt: new Date() },
  });
}
