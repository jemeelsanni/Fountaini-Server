// The Creche/Early Years report's checklist, exactly as the school's
// printed sheet (fia-frontend/pdf/Fountain-I Early Years Report.pdf) lays it
// out: EARLY_YEARS traits, section by section, in print order. "___" marks a
// fill-in blank, recorded in Rating.note. Shared by prisma/seedTraits.ts and
// prisma/seed-demo.ts — a plain data module, safe to import anywhere.

export const EARLY_YEARS_CHECKLIST: ReadonlyArray<{ section: string; items: readonly string[] }> = [
  {
    section: "Literacy",
    items: [
      "Group 1 — s a t p i n",
      "Group 2 — c k h d r e m",
      "Group 3 — g o u l f b",
      "Group 4 — x y v w z j",
      "Associates objects with sounds",
      "Blends two-letter sounds",
      "Blends three-letter sounds",
      "Identifies beginning sounds",
      "Writes all the letter sounds",
      "Makes pre-writing patterns",
      "Reads simple sentences",
    ],
  },
  {
    section: "Numeracy",
    items: [
      "Rote counts to ___",
      "Orders numbers to ___",
      "Matches number to quantity, to ___",
      "Identifies colours",
      "Identifies 2D shapes",
      "Writes numbers to ___",
      "Links numbers up to ___",
      "Differentiates empty and full",
    ],
  },
  {
    section: "Montessori Practical Life",
    items: ["Preparatory exercise", "Grace and courtesy", "Control of movement", "Care of environment"],
  },
  {
    section: "Science",
    items: [
      "Harmful objects",
      "Living and non-living things",
      "Animals and their babies",
      "Cleanliness",
      "Safety rules (outside and home)",
      "Animal sounds",
      "Good and bad habits",
    ],
  },
  {
    section: "Social & Living Habits",
    items: ["Greetings", "Cleaning tools", "Good manners", "Emotions", "Friendship", "Our world"],
  },
  {
    section: "Qur'an",
    items: ["Memorised from ___ to ___", "Recalls without assistance", "Recalls with assistance"],
  },
  {
    section: "Arabic Language",
    items: [
      "Knows Arabic sounds to ___",
      "Knows Arabic numbers to ___",
      "Writes Arabic letters to ___",
      "Writes Arabic numbers to ___",
      "Mentions some fruits in Arabic",
      "Identifies some shapes in Arabic",
      "Identifies some colours in Arabic",
    ],
  },
  {
    section: "Learning Attributes",
    items: [
      "Interested in learning",
      "Listens attentively",
      "Works well independently",
      "Works well with other children",
      "Resilient with difficult tasks",
      "Presents work carefully",
      "Responds to direction",
      "Reproduces Qur'an verses learnt",
    ],
  },
  {
    section: "Personal & Social",
    items: [
      "Happy at school",
      "Behaves well in class",
      "Interacts with other children",
      "Behaves well while playing",
      "Expresses own feelings",
      "Able to share",
      "Able to wait turn",
      "Uses appropriate Adhkar",
    ],
  },
  {
    section: "Physical & Other Areas",
    items: [
      "Age-appropriate focus",
      "Level of independence",
      "Balance and poise",
      "Gross and fine motor skills",
      "Organises task by self",
      "Attentive to details",
      "Potty training",
    ],
  },
];

/// Flattened in print order, with `order` as one running sequence across
/// every section (1, 2, 3, …) so sorting by order keeps sections grouped.
export function earlyYearsTraitRows(): Array<{ section: string; name: string; order: number }> {
  return EARLY_YEARS_CHECKLIST.flatMap(({ section, items }) => items.map((name) => ({ section, name }))).map(
    (item, index) => ({ ...item, order: index + 1 }),
  );
}
