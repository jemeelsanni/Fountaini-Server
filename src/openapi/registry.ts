import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import "./zodSetup.js";

/// Single shared registry every schema/route registration in this directory
/// writes into — the OpenApiGeneratorV31 in generateSpec.ts reads it back
/// via `registry.definitions`.
export const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});
