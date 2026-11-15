import { z } from "zod";

/** A JSON Schema fragment. */
type Json = Record<string, unknown>;

// Reads one property of an unknown value, `undefined` when it is not an object; in: the Zod fallback below, out: the property.
const at = (o: unknown, key: string): unknown =>
  o !== null && (typeof o === "object" || typeof o === "function") ? (o as Json)[key] : undefined;
// Calls a method of an unknown value when it has one; in: the Zod fallback below, out: its result.
const call = (o: unknown, key: string): unknown => {
  const f = at(o, key);
  return typeof f === "function" ? (f as () => unknown).call(o) : undefined;
};
// A plain, non-array object; in: the schema helpers, out: a type guard.
const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Converts a Zod schema or plain JSON object schema into standard JSON Schema for LLMs
 */
/**
 * Converts a Zod schema or JSON Schema object into provider-compatible JSON Schema.
 *
 * @example `const parameters = zodToJsonSchema(z.object({ query: z.string() }));`
 */
export function zodToJsonSchema(schema: unknown): Json {
  if (!schema) {
    return {
      type: "object",
      properties: {},
    };
  }

  // If already a plain JSON Schema object
  if (isJson(schema) && !("parse" in schema) && !("safeParse" in schema) && !("_def" in schema)) {
    return schema;
  }

  // Check if Zod schema
  if (isJson(schema) && ("parse" in schema || "_def" in schema || "~standard" in schema)) {
    try {
      // Use zod's native toJSONSchema if available (Zod 4+)
      if (typeof z.toJSONSchema === "function") {
        return cleanJsonSchema(z.toJSONSchema(schema as unknown as z.ZodType));
      }
      const own = call(schema, "toJSONSchema");
      if (isJson(own)) return cleanJsonSchema(own);
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
 * S10: resolves $ref against $defs before stripping (agent-accel typebox-helpers inline)
 */
/**
 * Removes unsupported schema metadata and resolves local `$ref` definitions.
 *
 * @example `const clean = cleanJsonSchema(rawSchema);`
 */
export function cleanJsonSchema(schema: Json, rootDefs?: Json, seenRefs: Set<string> = new Set()): Json {
  if (typeof schema !== "object" || schema === null) {
    return schema;
  }
  // Capture defs at root for $ref resolution
  const defs = rootDefs ?? (schema["$defs"] as Json | undefined) ?? (schema["definitions"] as Json | undefined);
  // Handle $ref first
  if (typeof schema["$ref"] === "string" && defs) {
    const refName = schema["$ref"].replace(/^#\/\$defs\//, "").replace(/^#\/definitions\//, "");
    const target = defs[refName];
    if (isJson(target)) {
      // Merge sibling props (e.g. description) with target
      const { $ref: _ref, ...siblings } = schema;
      if (seenRefs.has(refName)) {
        // Recursive schema (AST nodes, trees, nested categories): stop
        // expanding to avoid overflowing the stack; keep siblings.
        return { type: "object", ...cleanJsonSchema(siblings, defs, seenRefs) };
      }
      seenRefs.add(refName);
      try {
        const resolved = cleanJsonSchema(target, defs, seenRefs);
        return { ...resolved, ...cleanJsonSchema(siblings, defs, seenRefs) };
      } finally {
        seenRefs.delete(refName);
      }
    }
  }
  const { $schema: _schema, $defs: _defs, definitions: _definitions, ...rest } = schema;

  // Preserve additionalProperties if it was explicitly false, otherwise omit if undefined to keep strictness opt-in
  // (previous version stripped it unconditionally, breaking strict schemas)

  if (rest["type"] === "object" && !rest["properties"]) {
    rest["properties"] = {};
  }

  if (isJson(rest["properties"])) {
    const cleanedProps: Json = {};
    for (const [key, value] of Object.entries(rest["properties"])) {
      cleanedProps[key] = isJson(value) ? cleanJsonSchema(value, defs, seenRefs) : value;
    }
    rest["properties"] = cleanedProps;
  }

  if (isJson(rest["items"])) {
    rest["items"] = cleanJsonSchema(rest["items"], defs, seenRefs);
  }
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    const list = rest[key];
    if (Array.isArray(list)) rest[key] = list.map((v) => (isJson(v) ? cleanJsonSchema(v, defs, seenRefs) : v));
  }
  // Recursively clean nested $ref inside properties that were not top-level
  for (const k of Object.keys(rest)) {
    const v = rest[k];
    if (isJson(v) && v["$ref"]) {
      rest[k] = cleanJsonSchema(v, defs, seenRefs);
    }
  }
  return rest;
}

/**
 * Fallback schema extractor if toJSONSchema is not directly called
 */
function extractZodObjectSchema(zodSchema: unknown): Json {
  const def = at(zodSchema, "_def");
  const rawShape = at(zodSchema, "shape") || call(def, "shape") || at(def, "shape");
  const shape = isJson(rawShape) ? rawShape : undefined;
  if (!shape) {
    return {
      type: "object",
      properties: {},
    };
  }

  const properties: Json = {};
  const required: string[] = [];

  for (const [key, propSchema] of Object.entries(shape)) {
    const propDef = at(propSchema, "_def");
    const isOptional =
      call(propSchema, "isOptional") === true ||
      at(propDef, "typeName") === "ZodOptional" ||
      at(propDef, "type") === "optional";

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

// Best-effort JSON Schema for one Zod property when toJSONSchema is unavailable; in: extractZodObjectSchema, out: a schema fragment.
function inferZodPropertyType(prop: unknown): Json {
  const propDef = at(prop, "_def");
  const unwrapped = call(prop, "unwrap") || at(propDef, "innerType") || prop;
  const def = at(unwrapped, "_def");
  const description = at(prop, "description") || at(unwrapped, "description") || at(propDef, "description");
  const described = description ? { description } : {};

  const typeName = at(def, "typeName") || at(def, "type") || at(at(unwrapped, "constructor"), "name") || "";
  const tn = String(typeName).toLowerCase();

  if (tn.includes("number") || tn === "zodnumber") return { type: "number", ...described };
  if (tn.includes("boolean") || tn === "zodboolean") return { type: "boolean", ...described };
  if (tn.includes("integer")) return { type: "integer", ...described };
  if (tn.includes("enum") || tn === "zodenum") {
    const vals = at(def, "values") || at(def, "entries") || [];
    const arr = Array.isArray(vals) ? vals : Object.values(vals as Json);
    return { type: "string", enum: arr, ...described };
  }
  if (tn.includes("literal")) {
    const val = at(def, "value");
    return { type: val === null ? "null" : typeof val, enum: [val], ...described };
  }
  if (tn.includes("array") || tn === "zodarray") {
    const elem = at(def, "type") || at(def, "element") || at(def, "valueType") || {};
    return {
      type: "array",
      items: inferZodPropertyType(elem),
      ...described,
    };
  }
  if (tn.includes("object") || tn === "zodobject") {
    return {
      ...extractZodObjectSchema(unwrapped),
      ...described,
    };
  }
  if (tn.includes("union") || tn === "zodunion") {
    const opts = at(def, "options");
    return { anyOf: (Array.isArray(opts) ? opts : []).map((o) => inferZodPropertyType(o)), ...described };
  }

  return {
    type: "string",
    ...described,
  };
}

// Removes JSON Schema keywords rejected by Google OpenAPI 3 schemas, deeply; in: stripSchemaForGoogle, out: the cleaned value.
function stripKeywords(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripKeywords);
  if (!isJson(schema)) return schema;
  const {
    $schema: _schema,
    $defs: _defs,
    definitions: _definitions,
    additionalProperties: _additional,
    ...rest
  } = schema;
  const out: Json = { ...rest };
  if (isJson(out["properties"])) {
    const cleaned: Json = {};
    for (const [k, v] of Object.entries(out["properties"])) cleaned[k] = stripKeywords(v);
    out["properties"] = cleaned;
  }
  if (out["items"]) out["items"] = stripKeywords(out["items"]);
  for (const key of ["anyOf", "oneOf", "allOf"])
    if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).map(stripKeywords);
  return out;
}

/**
 * Google uses OpenAPI 3.0 Schema and strictly rejects JSON Schema keywords
 * such as $schema, $defs, definitions, and additionalProperties.
 */
/** Removes JSON Schema keywords rejected by Google OpenAPI 3 schemas. */
export function stripSchemaForGoogle(schema: Json): Json {
  return stripKeywords(schema) as Json;
}
