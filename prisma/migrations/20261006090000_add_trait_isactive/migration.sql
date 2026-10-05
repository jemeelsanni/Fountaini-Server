-- Trait.isActive: soft-deactivation for GET/PATCH/POST .../traits/:id/deactivate
-- (see the column's own comment in schema.prisma). Defaults true so every
-- pre-existing trait stays usable with no extra step.
ALTER TABLE "Trait" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
