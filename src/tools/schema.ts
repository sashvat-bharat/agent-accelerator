import { z } from "zod";

/**
 * Converts a Zod schema or plain JSON object schema into standard JSON Schema for LLMs
 */
export function zodToJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema) {
    return {
      type: "object",
      properties: {},
    };
  }

  // If already a plain JSON Schema object
  if (
    typeof schema === "object" &&
    schema !== null &&
    !("parse" in schema) &&
    !("safeParse" in schema) &&
    !("_def" in schema)
  ) {
    return schema as Record<string, unknown>;
  }

  // Check if Zod schema
  if (
    typeof schema === "object" &&
    schema !== null &&
    ("parse" in schema || "_def" in schema || "~standard" in schema)
  ) {
    try {
      // Use zod's native toJSONSchema if available (Zod 4+)
      if (typeof (z as any).toJSONSchema === "function") {
        const jsonSchema = (z as any).toJSONSchema(schema);
        return cleanJsonSchema(jsonSchema);
      }
      if (typeof (schema as any).toJSONSchema === "function") {
        const jsonSchema = (schema as any).toJSONSchema();
        return cleanJsonSchema(jsonSchema);
      }
    } catch {
      // Fallback manual schema extractor below
    }

    return extractZodObjectSchema(schema);
  }

  return {
    type: "object",
    properties: {},
  };
}

/**
 * Recursively removes $schema/$defs/definitions but preserves additionalProperties when explicitly set (S4 fix)
 * S10: resolves $ref against $defs before stripping (pi typebox-helpers inline)
 */
export function cleanJsonSchema(schema: any, rootDefs?: Record<string, any>): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null) {
    return schema;
  }
  // Capture defs at root for $ref resolution
  const defs = rootDefs ?? schema.$defs ?? schema.definitions;
  // Handle $ref first
  if (schema.$ref && typeof schema.$ref === "string" && defs) {
    const refName = schema.$ref.replace(/^#\/\$defs\//, "").replace(/^#\/definitions\//, "");
    const target = defs[refName];
    if (target) {
      // Merge sibling props (e.g. description) with target
      const { $ref, ...siblings } = schema;
      const resolved = cleanJsonSchema(target, defs);
      return { ...resolved, ...cleanJsonSchema(siblings, defs) } as any;
    }
  }
  const { $schema, $defs, definitions, ...rest } = schema;

  // Preserve additionalProperties if it was explicitly false, otherwise omit if undefined to keep strictness opt-in
  // (previous version stripped it unconditionally, breaking strict schemas)

  if (rest.type === "object" && !rest.properties) {
    rest.properties = {};
  }

  if (rest.properties && typeof rest.properties === "object") {
    const cleanedProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest.properties)) {
      cleanedProps[key] = cleanJsonSchema(value, defs);
    }
    rest.properties = cleanedProps;
  }

  if (rest.items) {
    rest.items = cleanJsonSchema(rest.items, defs);
  }
  if (rest.anyOf) rest.anyOf = (rest.anyOf as any[]).map((v: any) => cleanJsonSchema(v, defs));
  if (rest.oneOf) rest.oneOf = (rest.oneOf as any[]).map((v: any) => cleanJsonSchema(v, defs));
  if (rest.allOf) rest.allOf = (rest.allOf as any[]).map((v: any) => cleanJsonSchema(v, defs));
  if (rest.prefixItems) rest.prefixItems = (rest.prefixItems as any[]).map((v: any) => cleanJsonSchema(v, defs));
  // Recursively clean nested $ref inside properties that were not top-level
  for (const k of Object.keys(rest)) {
    if (rest[k] && typeof rest[k] === "object" && !Array.isArray(rest[k]) && (rest[k] as any).$ref) {
      rest[k] = cleanJsonSchema(rest[k], defs);
    }
  }
  return rest;
}

/**
 * Fallback schema extractor if toJSONSchema is not directly called
 */
function extractZodObjectSchema(zodSchema: any): Record<string, unknown> {
  const shape = zodSchema?.shape || zodSchema?._def?.shape?.() || zodSchema?._def?.shape;
  if (!shape) {
    return {
      type: "object",
      properties: {},
    };
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, propSchema] of Object.entries(shape as Record<string, any>)) {
    const isOptional =
      propSchema.isOptional?.() ||
      propSchema._def?.typeName === "ZodOptional" ||
      propSchema._def?.type === "optional";

    if (!isOptional) {
      required.push(key);
    }

    properties[key] = inferZodPropertyType(propSchema);
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function inferZodPropertyType(prop: any): Record<string, unknown> {
  const unwrapped = prop.unwrap?.() || prop._def?.innerType || prop;
  const description = prop.description || unwrapped.description || prop._def?.description;

  const typeName = unwrapped._def?.typeName || unwrapped._def?.type || unwrapped.constructor?.name || "";
  const tn = String(typeName).toLowerCase();

  if (tn.includes("number") || tn === "zodnumber") return { type: "number", ...(description ? { description } : {}) };
  if (tn.includes("boolean") || tn === "zodboolean") return { type: "boolean", ...(description ? { description } : {}) };
  if (tn.includes("integer")) return { type: "integer", ...(description ? { description } : {}) };
  if (tn.includes("enum") || tn === "zodenum") {
    const vals = unwrapped._def?.values || unwrapped._def?.entries || [];
    const arr = Array.isArray(vals) ? vals : Object.values(vals);
    return { type: "string", enum: arr, ...(description ? { description } : {}) };
  }
  if (tn.includes("literal")) {
    const val = unwrapped._def?.value;
    return { type: typeof val, enum: [val], ...(description ? { description } : {}) };
  }
  if (tn.includes("array") || tn === "zodarray") {
    const elem = unwrapped._def?.type || unwrapped._def?.element || unwrapped._def?.valueType || {};
    return {
      type: "array",
      items: inferZodPropertyType(elem),
      ...(description ? { description } : {}),
    };
  }
  if (tn.includes("object") || tn === "zodobject") {
    return {
      ...extractZodObjectSchema(unwrapped),
      ...(description ? { description } : {}),
    };
  }
  if (tn.includes("union") || tn === "zodunion") {
    const opts = unwrapped._def?.options || [];
    return { anyOf: opts.map((o: any) => inferZodPropertyType(o)), ...(description ? { description } : {}) };
  }

  return {
    type: "string",
    ...(description ? { description } : {}),
  };
}
