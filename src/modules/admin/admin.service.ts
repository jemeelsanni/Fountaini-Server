import { prisma } from "../../db/client.js";

export interface ContactGap {
  id: string;
  name: string;
  role: "PARENT";
  missingField: "phone";
}

/// Parents only for now — Staff has no phone field anywhere in the schema
/// (not even indirectly: User.phone, the one place it could live, has no
/// write path for a staff account either), so there's nothing to check for
/// them without a schema change nobody's asked for. Scoped to Parent.phone
/// specifically, not alternatePhone: phone is what a broadcast actually
/// needs, and a missing alternate isn't something worth chasing before one.
export async function listContactGaps(): Promise<ContactGap[]> {
  const parents = await prisma.parent.findMany({
    where: { phone: null },
    select: { id: true, firstName: true, lastName: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  return parents.map((p) => ({
    id: p.id,
    name: `${p.firstName} ${p.lastName}`,
    role: "PARENT" as const,
    missingField: "phone" as const,
  }));
}
