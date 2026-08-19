import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp, routeMounts } from "../src/app.js";
import { generateOpenApiDocument } from "../src/openapi/generateSpec.js";

/// Writes the same document GET /api/openapi.json serves, to a file
/// committed at the repo root — the point being DOCS_ENABLED=off in
/// production (the default there) still leaves a frontend developer with
/// something authoritative to read: version control, not a live endpoint.
/// generateOpenApiDocument() never touches the database (Prisma's client is
/// lazy — connections happen on first query, not construction), so this
/// only needs env.ts's validation to pass, not a real, reachable
/// DATABASE_URL — see how CI's "Generate openapi.json" step sets it.
const app = createApp();
const doc = generateOpenApiDocument(app, routeMounts);

const outPath = fileURLToPath(new URL("../openapi.json", import.meta.url));
writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);

// eslint-disable-next-line no-console -- a build script, not app runtime code with a logger
console.log(`Wrote ${outPath}`);
