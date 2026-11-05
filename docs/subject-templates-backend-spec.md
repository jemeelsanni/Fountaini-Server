# Subject templates — backend spec

Admin → Settings → **Subject Templates** lets the school keep a named subject
list per level ("Primary", "JSS", "SSS — Science"…) and apply it to a class
in one go. The frontend is built (`apps/admin/app/(portal)/admin/settings/subject-templates/page.tsx`,
client in `packages/api/subject-templates.ts`); it needs the four routes
below. Until they exist the page shows the built-in templates read-only — it
treats a **404 on `GET /api/subject-templates`** as "not supported yet", so
keep that route absent rather than stubbed until it works.

All routes: ADMIN role. Errors use the existing `{ "error": { "code", "message" } }`
shape; the frontend shows `message` for 4xx.

## Model

```
SubjectTemplate         id (cuid), name (unique, case-insensitive), description?, createdAt, updatedAt
SubjectTemplateSubject  templateId, subjectId → Subject, optional (bool), order (int)
                        unique (templateId, subjectId)
```

Deleting a Subject should remove it from templates (cascade), not fail.

## Response shape

Every route that returns a template returns this, `subjects` sorted by `order`:

```json
{
  "id": "<cuid>",
  "name": "Primary",
  "description": "Primary 1–6",
  "subjects": [
    {
      "subjectId": "<cuid>",
      "optional": false,
      "subject": { "id": "<cuid>", "name": "Mathematics", "code": "MTH", "type": "ACADEMIC", "createdAt": "…" }
    }
  ],
  "createdAt": "…",
  "updatedAt": "…"
}
```

## Routes

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/subject-templates` | — | `SubjectTemplate[]`, by name |
| POST | `/api/subject-templates` | `SubjectTemplateInput` | `201` `SubjectTemplate` |
| PATCH | `/api/subject-templates/{id}` | `SubjectTemplateInput` | `SubjectTemplate` |
| DELETE | `/api/subject-templates/{id}` | — | `204` |

```json
SubjectTemplateInput = {
  "name": "Primary",
  "description": "Primary 1–6",
  "subjects": [{ "subjectId": "<cuid>", "optional": false }]
}
```

- `subjects` **replaces** the whole list; array order becomes `order`.
- 400 if `name` is blank, a duplicate (case-insensitive), a `subjectId`
  doesn't exist, or appears twice.
- `description` may be omitted / empty → `null`.
- PATCH sends the full body (frontend always sends all three fields).
- DELETE only removes the template; it never touches class–subject
  assignments already created from it.

## Backend checklist

The same file is in both repos (`docs/subject-templates-backend-spec.md`);
keep them identical.

- [ ] Prisma models + migration (above). Name uniqueness is case-insensitive:
      use a unique index on `lower(name)` (raw SQL in the migration) or check
      in the service inside the same transaction. Either way, return a 400 with
      a readable message, not a 500 from a raw P2002.
- [ ] `SubjectTemplateSubject.subject` → `onDelete: Cascade`. There is no
      DELETE `/api/subjects/{id}` today; this keeps a future one from failing.
- [ ] Routes in `src/modules/academic-structure/` alongside `/subjects`
      (or a new `subject-templates` module), behind `requireRole("ADMIN")`.
- [ ] Authorization matrix rows (`src/authorization/authMatrix.data.ts`) for
      all four routes: ADMIN allowed, every other role 403, unauthenticated 401.
- [ ] OpenAPI: `SubjectTemplate` + `SubjectTemplateInput` in
      `resourceSchemas.ts`, routes in `routeSpecs.ts`, regenerate
      `openapi.json`. Schema names must be exactly `SubjectTemplate`,
      `SubjectTemplateSubject` and `SubjectTemplateInput`; the frontend
      swaps its hand-written types for those.
- [ ] Add `subjectTemplateSubject` / `subjectTemplate` to `src/test/resetDb.ts`.
- [ ] Tests: create, duplicate name (different case) → 400, unknown
      `subjectId` → 400, duplicate `subjectId` → 400, PATCH replaces the list
      and reorders, DELETE leaves `ClassSubjectAssignment` rows alone,
      non-admin → 403.
- [ ] `POST /api/subjects` must keep accepting `type: "MADRASSAH"`. The
      frontend creates the Weekday Madrasa subjects with it, and they share
      names with academic subjects (Hadith, Seerah, Qur'an Memorisation).
      Subject `name` must **not** become unique. Only `code` is unique, and the
      frontend generates `ISL-…` codes for madrasa subjects.

**No seeding needed.** The school's lists (Creche, Early Years, Basic 1–5,
Weekday Madrasa, plus draft JSS/SSS) live in the frontend
(`apps/admin/components/admin/subject-templates.ts`, from
`docs/school-info.md`). Admin → Settings → Subject Templates → "Start from
built-in templates" creates the missing subjects and saves the templates
through these routes. Don't add a seed for them in the backend.

**Applying a template stays client-side.** The class page loops
`POST /api/class-subject-assignments` per subject, because each needs a
teacher. No apply endpoint is needed.

## After shipping

1. Regenerate `packages/api/types/api.d.ts`; swap the hand-written types in
   `packages/api/subject-templates.ts` for the generated ones.
2. ~~Switch the class page's Apply subject template modal to `useSubjectTemplates()`~~: done; it uses saved templates when there are any and falls back to the built-ins otherwise.
