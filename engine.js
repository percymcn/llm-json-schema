/*
 * llm-json-schema engine — provider-correct JSON Schema transforms + linting.
 *
 * Dependency-free. Runs in the browser and in Node (for tests).
 *
 * Every rule encoded here is sourced from the provider's CURRENT official docs
 * (fetched 2026-07-30). Each RULE carries the doc URL it came from so the UI can
 * cite it — the provider-divergence logic IS the product's value.
 *
 * Sources:
 *   OpenAI    https://developers.openai.com/api/docs/guides/structured-outputs
 *   Anthropic https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview
 *   Gemini    https://ai.google.dev/gemini-api/docs/structured-output
 */

(function (root) {
  "use strict";

  var DOCS = {
    openai: "https://developers.openai.com/api/docs/guides/structured-outputs",
    anthropic: "https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview",
    gemini: "https://ai.google.dev/gemini-api/docs/structured-output"
  };

  // ---- small helpers -------------------------------------------------------

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function isPlainObject(v) {
    return v && typeof v === "object" && !Array.isArray(v);
  }

  // A node is an "object schema" if it declares type:object or carries properties.
  function isObjectSchema(node) {
    if (!isPlainObject(node)) return false;
    if (node.type === "object") return true;
    if (node.properties && isPlainObject(node.properties)) return true;
    return false;
  }

  // Ledger entry: { op: "+"|"~"|"x"|"!", path, msg, rule, ruleUrl }
  //   +  added        ~  changed        x  removed        !  violation (cannot auto-fix)
  function entry(op, path, msg, ruleUrl) {
    return { op: op, path: path || "root", msg: msg, ruleUrl: ruleUrl };
  }

  // ---- schema inference from a JSON example --------------------------------

  function inferSchema(value) {
    if (value === null) return { type: "null" };
    if (Array.isArray(value)) {
      var out = { type: "array" };
      if (value.length) out.items = inferSchema(value[0]);
      return out;
    }
    if (typeof value === "object") {
      var props = {};
      var required = [];
      Object.keys(value).forEach(function (k) {
        props[k] = inferSchema(value[k]);
        required.push(k);
      });
      return { type: "object", properties: props, required: required };
    }
    if (typeof value === "string") return { type: "string" };
    if (typeof value === "number") {
      return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
    }
    if (typeof value === "boolean") return { type: "boolean" };
    return {};
  }

  // Detect whether pasted JSON is a schema or an example.
  function looksLikeSchema(obj) {
    if (!isPlainObject(obj)) return false;
    return (
      "type" in obj ||
      "properties" in obj ||
      "$schema" in obj ||
      "$ref" in obj ||
      "anyOf" in obj ||
      "oneOf" in obj ||
      "allOf" in obj ||
      "enum" in obj
    );
  }

  // ---- OpenAI Structured Outputs (strict) ----------------------------------
  // Rules (all quoted/derived from the OpenAI doc):
  //  - "additionalProperties: false must always be set in objects"
  //  - "All fields ... must be specified as required" (optional => union with null)
  //  - "the root level object of a schema must be an object, and not use anyOf"
  //  - Unsupported: allOf, not, dependentRequired, dependentSchemas, if, then, else
  var OPENAI_UNSUPPORTED = ["allOf", "not", "dependentRequired", "dependentSchemas", "if", "then", "else", "patternProperties"];

  function toOpenAI(schema) {
    var s = clone(schema);
    var ledger = [];

    if (s.type && s.type !== "object") {
      ledger.push(entry("!", "root",
        "Root must be an object. OpenAI strict mode rejects a non-object root — wrap your schema in an object.",
        DOCS.openai));
    }
    if (s.anyOf) {
      ledger.push(entry("!", "root",
        "Root schema cannot use anyOf. Move the anyOf under a named property.",
        DOCS.openai));
    }

    walk(s, "root", function (node, path) {
      // strip unsupported composition keywords
      OPENAI_UNSUPPORTED.forEach(function (kw) {
        if (kw in node) {
          delete node[kw];
          ledger.push(entry("x", path,
            "Removed unsupported keyword `" + kw + "` (OpenAI strict mode does not support it).",
            DOCS.openai));
        }
      });

      if (isObjectSchema(node)) {
        // additionalProperties: false on every object
        if (node.additionalProperties !== false) {
          var was = "additionalProperties" in node;
          node.additionalProperties = false;
          ledger.push(entry(was ? "~" : "+", path,
            "Set `additionalProperties: false` — required on every object.",
            DOCS.openai));
        }
        // every property must be required; keep optionals optional-in-spirit via nullable
        var props = node.properties ? Object.keys(node.properties) : [];
        if (props.length) {
          var prev = Array.isArray(node.required) ? node.required.slice() : [];
          var added = props.filter(function (k) { return prev.indexOf(k) === -1; });
          node.required = props.slice();
          added.forEach(function (k) {
            var pnode = node.properties[k];
            // make forced-required fields nullable so their optional semantics survive
            makeNullable(pnode);
            ledger.push(entry("~", path + "." + k,
              "`" + k + "` added to required (all fields must be required); made nullable to preserve optionality.",
              DOCS.openai));
          });
        }
      }
    });

    return { schema: s, ledger: ledger };
  }

  function makeNullable(node) {
    if (!isPlainObject(node)) return;
    if (Array.isArray(node.type)) {
      if (node.type.indexOf("null") === -1) node.type.push("null");
    } else if (typeof node.type === "string") {
      if (node.type !== "null") node.type = [node.type, "null"];
    }
  }

  // ---- Anthropic tool input_schema -----------------------------------------
  // "pass a tool with an input_schema" — standard JSON Schema, light constraints.
  // No forced required, no additionalProperties requirement. `strict: true` on the
  // tool definition is the opt-in for guaranteed conformance.
  function toAnthropic(schema) {
    var s = clone(schema);
    var ledger = [];

    if (!s.type) {
      s.type = "object";
      ledger.push(entry("+", "root",
        "Added `type: object` — a tool input_schema is an object schema.",
        DOCS.anthropic));
    } else if (s.type !== "object") {
      ledger.push(entry("!", "root",
        "A tool input_schema must be an object at the root. Wrap this schema in an object.",
        DOCS.anthropic));
    }
    if (s.type === "object" && !s.properties) {
      s.properties = {};
      ledger.push(entry("+", "root",
        "Added an empty `properties` — an object input_schema declares its properties.",
        DOCS.anthropic));
    }

    if (ledger.length === 0) {
      ledger.push(entry("=", "root",
        "No changes needed. Anthropic accepts standard JSON Schema as a tool `input_schema`. Add `strict: true` to the tool (not the schema) for guaranteed conformance.",
        DOCS.anthropic));
    } else {
      ledger.push(entry("=", "root",
        "Anthropic accepts standard JSON Schema; add `strict: true` to the tool definition for guaranteed conformance.",
        DOCS.anthropic));
    }
    return { schema: s, ledger: ledger };
  }

  // ---- Gemini responseSchema -----------------------------------------------
  // Supported subset (from the Gemini doc): type, title, description, properties,
  // required, additionalProperties, enum, format (string: date-time|date|time),
  // minimum, maximum, items, prefixItems, minItems, maxItems, anyOf, nullable,
  // propertyOrdering. NOT supported: $ref/$defs (except recursive "#"), pattern,
  // minLength, maxLength, multipleOf, allOf/not/if/then/else, patternProperties.
  var GEMINI_ALLOWED = {
    "type": 1, "title": 1, "description": 1, "properties": 1, "required": 1,
    "additionalProperties": 1, "enum": 1, "format": 1, "minimum": 1, "maximum": 1,
    "items": 1, "prefixItems": 1, "minItems": 1, "maxItems": 1, "anyOf": 1,
    "nullable": 1, "propertyOrdering": 1
  };
  var GEMINI_STRING_FORMATS = { "date-time": 1, "date": 1, "time": 1, "enum": 1 };

  function toGemini(schema) {
    var s = clone(schema);
    var ledger = [];

    if (s.$defs || s.definitions) {
      ledger.push(entry("!", "root",
        "Gemini does not support `$defs`/`definitions` + `$ref`. Inline your definitions before sending.",
        DOCS.gemini));
    }

    walk(s, "root", function (node, path) {
      // drop keywords outside the supported subset
      Object.keys(node).forEach(function (k) {
        if (!GEMINI_ALLOWED[k]) {
          if (k === "$ref") {
            ledger.push(entry("!", path,
              "`$ref` is not supported by Gemini (except recursive `#`). Inline the referenced schema.",
              DOCS.gemini));
          } else {
            ledger.push(entry("x", path,
              "Removed `" + k + "` — not in Gemini's supported schema subset.",
              DOCS.gemini));
            delete node[k];
          }
        }
      });

      // string `format` limited to date-time / date / time
      if (node.type === "string" && node.format && !GEMINI_STRING_FORMATS[node.format]) {
        ledger.push(entry("x", path,
          "Removed `format: " + node.format + "` — Gemini supports only date-time, date, time for strings.",
          DOCS.gemini));
        delete node.format;
      }

      // add propertyOrdering so field order is deterministic (Gemini honors it)
      if (isObjectSchema(node) && node.properties) {
        var keys = Object.keys(node.properties);
        if (keys.length && !node.propertyOrdering) {
          node.propertyOrdering = keys.slice();
          ledger.push(entry("+", path,
            "Added `propertyOrdering` — Gemini uses it to fix the field order it emits.",
            DOCS.gemini));
        }
      }
    });

    if (ledger.length === 0) {
      ledger.push(entry("=", "root", "No changes needed. This schema is within Gemini's supported subset.", DOCS.gemini));
    }
    return { schema: s, ledger: ledger };
  }

  // ---- generic recursive walk ----------------------------------------------
  // Applies fn(node, path) to every schema node, depth-first.
  function walk(node, path, fn) {
    if (!isPlainObject(node)) return;
    fn(node, path);
    if (isPlainObject(node.properties)) {
      Object.keys(node.properties).forEach(function (k) {
        walk(node.properties[k], path + "." + k, fn);
      });
    }
    if (isPlainObject(node.items)) walk(node.items, path + "[]", fn);
    if (Array.isArray(node.prefixItems)) {
      node.prefixItems.forEach(function (it, i) { walk(it, path + "[" + i + "]", fn); });
    }
    ["anyOf", "oneOf", "allOf"].forEach(function (kw) {
      if (Array.isArray(node[kw])) {
        node[kw].forEach(function (sub, i) { walk(sub, path + "/" + kw + "[" + i + "]", fn); });
      }
    });
    if (isPlainObject(node.$defs)) {
      Object.keys(node.$defs).forEach(function (k) { walk(node.$defs[k], "$defs." + k, fn); });
    }
  }

  var CONVERTERS = { openai: toOpenAI, anthropic: toAnthropic, gemini: toGemini };

  // ---- public API ----------------------------------------------------------

  // convert(rawText, provider, opts) -> {ok, schema, ledger, inferred, error}
  function convert(rawText, provider, opts) {
    opts = opts || {};
    var parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      return { ok: false, error: "That isn't valid JSON: " + e.message };
    }
    var conv = CONVERTERS[provider];
    if (!conv) return { ok: false, error: "Unknown provider: " + provider };

    var inferred = false;
    var schema = parsed;
    var treatAsExample = opts.mode === "example" || (opts.mode !== "schema" && !looksLikeSchema(parsed));
    if (treatAsExample) {
      schema = inferSchema(parsed);
      inferred = true;
    }

    var result = conv(schema);
    return {
      ok: true,
      schema: result.schema,
      ledger: result.ledger,
      inferred: inferred,
      docUrl: DOCS[provider]
    };
  }

  var api = {
    convert: convert,
    inferSchema: inferSchema,
    looksLikeSchema: looksLikeSchema,
    toOpenAI: toOpenAI,
    toAnthropic: toAnthropic,
    toGemini: toGemini,
    DOCS: DOCS
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LLMSchema = api;
})(typeof window !== "undefined" ? window : this);
