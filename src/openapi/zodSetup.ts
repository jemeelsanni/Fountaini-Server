import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

/// Side-effect import: every file in this directory that calls `.openapi()`
/// imports this first. ESM import evaluation order guarantees this module's
/// top-level `extendZodWithOpenApi` call has already run by the time an
/// importing file's own top-level `.openapi()` calls execute, and repeated
/// imports of this module are cached/idempotent — so it's safe for more
/// than one file to import it.
extendZodWithOpenApi(z);
