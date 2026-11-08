-- Corrects 20261105150000_fee_structure_targeting's backfill, which set every
-- existing FeeStructure to programme ACADEMIC — including ones that already
-- targeted a Weekday Madrasa class or grade, which the programme-aware
-- matcher would then never bill anyone for. Derives programme from the
-- target instead. School-wide structures (no class, no grade) stay ACADEMIC,
-- which is what they always billed in practice.

-- Targeted at one class: that class's programme.
UPDATE "FeeStructure" fs
SET "programme" = c."programme"
FROM "Class" c
WHERE fs."classId" = c."id"
  AND fs."programme" <> c."programme";

-- Targeted at a grade level: MADRASSAH only when every class at that grade is
-- a Madrasa class (a grade with any academic class stays ACADEMIC).
UPDATE "FeeStructure" fs
SET "programme" = 'MADRASSAH'
WHERE fs."classId" IS NULL
  AND fs."gradeName" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "Class" c WHERE c."gradeName" = fs."gradeName" AND c."programme" = 'MADRASSAH')
  AND NOT EXISTS (SELECT 1 FROM "Class" c WHERE c."gradeName" = fs."gradeName" AND c."programme" = 'ACADEMIC');
