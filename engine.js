/*
 * llm-json-schema engine — provider-correct JSON Schema transforms + linting.
 *
 * Dependency-free. Runs in the browser and in Node (for tests).
 *
 * Every rule encoded here is sourced from the provider's CURRENT official docs
 * (fetched 2026-07-30; OpenAI keyword set re-verified 2026-08-08). Each RULE
 * carries the doc URL it came from so the UI can cite it — the provider-
 * divergence logic IS the product's value.
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
  //  - "If you turn on Structured Outputs by supplying strict: true and call the
  //     API with an unsupported JSON Schema, you will receive an error."
  //
  // Because unsupported keywords ERROR rather than being ignored, this is an
  // ALLOWLIST, not a blocklist.
  //
  // SECOND SOURCE (added after the doc alone proved too coarse): OpenAI's own
  // official SDK ships the strict transformer that builds the exact payload it
  // sends — `toStrictJsonSchema()` in openai@7.4.0 (`openai/lib/transform`). It
  // throws on keywords the API cannot represent, and silently PRESERVES the
  // rest. Running every keyword through it yields a sharper rule than the doc's
  // "Supported properties" list, which under-reports what is actually accepted:
  //
  //   PRESERVED  minLength maxLength default examples readOnly writeOnly
  //              deprecated $comment $id $schema title description
  //   THROWS     uniqueItems minProperties maxProperties patternProperties
  //              propertyNames unevaluatedProperties unevaluatedItems
  //              additionalItems contains minContains not allOf
  //              dependentRequired if then else
  //
  // The split is coherent: strict mode errors on keywords whose validation
  // semantics its constrained decoder cannot compile, and accepts (ignores)
  // annotations and soft constraints. So we strip only the first class.
  // Stripping the second class was WRONG — it made `--check` fail on schemas
  // OpenAI's own SDK sends verbatim, i.e. on any Zod `.describe()` / `.min()` /
  // `.default()` or Pydantic `Field(description=..., default=...)`, which is
  // most real generator output. Verified against openai@7.4.0.
  var OPENAI_SUPPORTED = {
    // structural
    type: 1, properties: 1, required: 1, additionalProperties: 1,
    items: 1, prefixItems: 1, anyOf: 1, enum: 1, "const": 1, $ref: 1, $defs: 1,
    // root metadata — explicitly retained by toStrictJsonSchema as rootMetadata
    $schema: 1, $id: 1,
    // annotations — preserved by the SDK transformer, and they steer the model
    description: 1, title: 1, $comment: 1,
    "default": 1, examples: 1, readOnly: 1, writeOnly: 1, deprecated: 1,
    // string
    pattern: 1, format: 1, minLength: 1, maxLength: 1,
    // number
    multipleOf: 1, maximum: 1, exclusiveMaximum: 1, minimum: 1, exclusiveMinimum: 1,
    // array
    minItems: 1, maxItems: 1
  };

  // Why a given keyword is stripped. Anything not named here gets the generic
  // reason. These are the ones real generators actually emit.
  // Every reason below is a keyword that openai@7.4.0's own `toStrictJsonSchema`
  // THROWS on ("uses unsupported keyword `X` and cannot be represented in strict
  // Structured Outputs"), i.e. the API genuinely cannot accept it.
  var OPENAI_STRIP_REASON = {
    "uniqueItems": "OpenAI's supported array properties are `minItems` and `maxItems` only.",
    "contains": "a conditional array constraint strict mode cannot compile.",
    "minContains": "a conditional array constraint strict mode cannot compile.",
    "additionalItems": "tuple-tail validation is not representable in strict mode; use `items`/`prefixItems`.",
    "unevaluatedItems": "annotation-dependent array validation is not representable in strict mode.",
    "minProperties": "OpenAI's only supported object property is `additionalProperties`.",
    "maxProperties": "OpenAI's only supported object property is `additionalProperties`.",
    "patternProperties": "OpenAI's only supported object property is `additionalProperties`.",
    "propertyNames": "OpenAI's only supported object property is `additionalProperties`.",
    "unevaluatedProperties": "OpenAI's only supported object property is `additionalProperties`.",
    "allOf": "the doc names `allOf` unsupported; express the merged shape as one object instead.",
    "not": "the doc names `not` unsupported.",
    "dependentRequired": "the doc names `dependentRequired` unsupported.",
    "dependentSchemas": "the doc names `dependentSchemas` unsupported.",
    "if": "the doc names `if`/`then`/`else` unsupported.",
    "then": "the doc names `if`/`then`/`else` unsupported.",
    "else": "the doc names `if`/`then`/`else` unsupported."
  };

  // `definitions` is draft-07 (what zod-to-json-schema emits); OpenAI's doc and
  // examples use `$defs`. Rename it and repoint every `$ref` that used it.
  function normalizeDefs(s, ledger) {
    if (!isPlainObject(s.definitions)) return s;
    if (isPlainObject(s.$defs)) {
      // both present — merge `definitions` in without clobbering `$defs`
      Object.keys(s.definitions).forEach(function (k) {
        if (!(k in s.$defs)) s.$defs[k] = s.definitions[k];
      });
    } else {
      s.$defs = s.definitions;
    }
    delete s.definitions;
    deepRepointRefs(s);
    ledger.push(entry("~", "root",
      "Renamed draft-07 `definitions` to `$defs` and repointed every `$ref` — OpenAI's schema dialect uses `$defs`. (zod-to-json-schema emits `definitions`.)",
      DOCS.openai));
    return s;
  }

  // Structural (not string-replace) rewrite of #/definitions/X -> #/$defs/X.
  function deepRepointRefs(v) {
    if (Array.isArray(v)) { v.forEach(deepRepointRefs); return; }
    if (!isPlainObject(v)) return;
    if (typeof v.$ref === "string" && v.$ref.indexOf("#/definitions/") === 0) {
      v.$ref = "#/$defs/" + v.$ref.slice("#/definitions/".length);
    }
    Object.keys(v).forEach(function (k) { deepRepointRefs(v[k]); });
  }

  // A root of `{ "$ref": "#/$defs/X", "$defs": {...} }` has no `type`, no
  // `properties` and no `additionalProperties`, so every object rule below
  // silently no-ops on it and the tool reports "already valid" for a schema
  // that is not. Hoist the referenced definition to the root instead.
  function inlineRootRef(s, ledger) {
    if (typeof s.$ref !== "string") return s;
    var m = /^#\/\$defs\/(.+)$/.exec(s.$ref);
    if (!m) return s;
    var name = m[1];
    if (!isPlainObject(s.$defs) || !isPlainObject(s.$defs[name])) return s;

    var out = clone(s.$defs[name]);
    var defs = s.$defs;

    // carry over any sibling keys the generator left next to `$ref`
    Object.keys(s).forEach(function (k) {
      if (k !== "$ref" && k !== "$defs" && !(k in out)) out[k] = s[k];
    });

    // keep only the definitions something still points at (recursive schemas
    // reference themselves, so `name` may need to stay)
    var remaining = {};
    Object.keys(defs).forEach(function (k) { if (k !== name) remaining[k] = defs[k]; });
    if (JSON.stringify([out, remaining]).indexOf('"#/$defs/' + name + '"') !== -1) {
      remaining[name] = defs[name];
    }
    if (Object.keys(remaining).length) out.$defs = remaining;

    ledger.push(entry("~", "root",
      "Inlined the root `$ref` (`#/$defs/" + name + "`) into the root. OpenAI requires the root to be an object schema, and a bare `$ref` root leaves `additionalProperties`/`required` unset on the real object.",
      DOCS.openai));
    return out;
  }

  // OpenAI supports `$ref`, but rejects a `$ref` that carries sibling keywords:
  //   Invalid schema ... context=('properties','x'), $ref cannot have keywords {'description'}
  // Pydantic emits exactly that shape for any field whose type is a nested model
  // or Enum AND which has a Field(description=...) — verified against pydantic
  // 2.13.4. A plain `str` field with a description does NOT produce it, which is
  // why the failure looks maddeningly input-dependent.
  // Fix: inline the referenced definition at the use site and let the siblings
  // win. Bare `$ref`s (no siblings) are left alone — those are legal.
  function resolveRefSiblings(s, ledger) {
    if (!isPlainObject(s.$defs)) return s;
    var defs = s.$defs, fixed = 0, unresolved = [];

    function visit(node, stack) {
      if (Array.isArray(node)) return node.map(function (n) { return visit(n, stack); });
      if (!isPlainObject(node)) return node;

      var siblings = Object.keys(node).filter(function (k) { return k !== "$ref"; });
      var m = typeof node.$ref === "string" ? /^#\/\$defs\/(.+)$/.exec(node.$ref) : null;

      if (m && siblings.length && isPlainObject(defs[m[1]])) {
        var name = m[1];
        if (stack.indexOf(name) !== -1) {
          if (unresolved.indexOf(name) === -1) unresolved.push(name);
        } else {
          var target = visit(clone(defs[name]), stack.concat([name]));
          siblings.forEach(function (k) { target[k] = visit(node[k], stack); });
          fixed++;
          return target;
        }
      }

      var out = {};
      Object.keys(node).forEach(function (k) { out[k] = visit(node[k], stack); });
      return out;
    }

    var result = visit(s, []);
    // once refs are inlined the definitions they pointed at may be orphaned;
    // dead `$defs` still count against OpenAI's 5000-property budget.
    if (isPlainObject(result.$defs)) {
      var kept = {};
      Object.keys(result.$defs).forEach(function (k) {
        var probe = clone(result); delete probe.$defs;
        if (JSON.stringify([probe, result.$defs]).indexOf('"#/$defs/' + k + '"') !== -1) kept[k] = result.$defs[k];
      });
      if (Object.keys(kept).length) result.$defs = kept; else delete result.$defs;
    }
    if (fixed) {
      ledger.push(entry("~", "root",
        "Inlined " + fixed + " `$ref` that carried sibling keywords — OpenAI rejects those with \"$ref cannot have keywords\". Pydantic emits this for a nested-model or Enum field that also has a `description`.",
        DOCS.openai));
    }
    unresolved.forEach(function (name) {
      ledger.push(entry("!", "root",
        "`" + name + "` is recursive and its `$ref` carries sibling keywords, which OpenAI rejects. Move those keywords into the definition itself — a recursive `$ref` cannot be inlined.",
        DOCS.openai));
    });
    return result;
  }

  function toOpenAI(schema) {
    var s = clone(schema);
    var ledger = [];

    s = normalizeDefs(s, ledger);
    s = inlineRootRef(s, ledger);
    s = resolveRefSiblings(s, ledger);

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
      // `anyOf` is the union OpenAI supports; `oneOf` is never named in the doc.
      // Rewrite rather than strip — dropping it would silently widen the schema.
      if (Array.isArray(node.oneOf) && !node.anyOf) {
        node.anyOf = node.oneOf;
        delete node.oneOf;
        ledger.push(entry("~", path,
          "Rewrote `oneOf` as `anyOf` — `anyOf` is the only union keyword in OpenAI's supported set.",
          DOCS.openai));
      }

      // strip every keyword outside the supported set (unsupported => API error)
      Object.keys(node).forEach(function (k) {
        if (OPENAI_SUPPORTED[k]) return;
        var why = OPENAI_STRIP_REASON[k] ||
          "not in OpenAI's supported keyword set, and strict mode errors on unsupported keywords.";
        delete node[k];
        ledger.push(entry("x", path, "Removed `" + k + "` — " + why, DOCS.openai));
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
    // An `enum` alongside a nullable type has to admit null as well, or the two
    // constraints are unsatisfiable and the model can never legally emit null.
    // zod `z.enum([...]).optional()` / `.default()` hits this every time.
    if (Array.isArray(node.enum) && node.enum.indexOf(null) === -1) {
      node.enum = node.enum.concat([null]);
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

  // Gemini has no `$ref`, so the only correct transform is to inline the
  // definitions — not to warn and then strip the `$defs` bag, which is what
  // this used to do and which turned `{ $ref, definitions }` (the exact shape
  // zod-to-json-schema emits) into an empty `{ "$ref": ... }`.
  // Returns the inlined schema; pushes a blocker for genuinely recursive refs,
  // which Gemini cannot express at all.
  function inlineRefs(s, ledger, docUrl) {
    var defs = {};
    [s.$defs, s.definitions].forEach(function (bag) {
      if (isPlainObject(bag)) Object.keys(bag).forEach(function (k) { defs[k] = bag[k]; });
    });
    if (!Object.keys(defs).length) return s;

    var inlined = 0, recursive = [];

    function resolve(node, stack) {
      if (Array.isArray(node)) return node.map(function (n) { return resolve(n, stack); });
      if (!isPlainObject(node)) return node;

      var ref = typeof node.$ref === "string" ? /^#\/(?:\$defs|definitions)\/(.+)$/.exec(node.$ref) : null;
      if (ref && defs[ref[1]]) {
        var name = ref[1];
        if (stack.indexOf(name) !== -1) {
          if (recursive.indexOf(name) === -1) recursive.push(name);
          return node; // leave it; a blocker is reported below
        }
        var target = resolve(clone(defs[name]), stack.concat([name]));
        // siblings alongside `$ref` win over the definition's own keys
        Object.keys(node).forEach(function (k) { if (k !== "$ref") target[k] = resolve(node[k], stack); });
        inlined++;
        return target;
      }

      var out = {};
      Object.keys(node).forEach(function (k) { out[k] = resolve(node[k], stack); });
      return out;
    }

    var result = resolve(s, []);
    delete result.$defs;
    delete result.definitions;

    if (inlined) {
      ledger.push(entry("~", "root",
        "Inlined " + inlined + " `$ref` reference" + (inlined === 1 ? "" : "s") +
        " and dropped the `$defs`/`definitions` block — Gemini's schema subset has no `$ref`.",
        docUrl));
    }
    recursive.forEach(function (name) {
      ledger.push(entry("!", "root",
        "`" + name + "` is recursive (it references itself). Gemini cannot express a recursive schema — flatten it to a fixed depth before sending.",
        docUrl));
    });
    return result;
  }

  function toGemini(schema) {
    var s = clone(schema);
    var ledger = [];

    s = inlineRefs(s, ledger, DOCS.gemini);

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
    ["$defs", "definitions"].forEach(function (bag) {
      if (isPlainObject(node[bag])) {
        Object.keys(node[bag]).forEach(function (k) { walk(node[bag][k], bag + "." + k, fn); });
      }
    });
  }

  var CONVERTERS = { openai: toOpenAI, anthropic: toAnthropic, gemini: toGemini };

  // ---- public API ----------------------------------------------------------

  // convert(input, provider, opts) -> {ok, schema, ledger, inferred, error}
  // `input` may be a JSON string (browser textarea, CLI file read) OR an
  // already-parsed object — library callers hand us the object that
  // zod-to-json-schema / Pydantic .model_json_schema() just produced, and
  // making them JSON.stringify it first was pointless friction.
  function convert(input, provider, opts) {
    opts = opts || {};
    var parsed;
    if (typeof input === "string") {
      try {
        parsed = JSON.parse(input);
      } catch (e) {
        return { ok: false, error: "That isn't valid JSON: " + e.message };
      }
    } else if (input && typeof input === "object") {
      parsed = input;
    } else {
      return { ok: false, error: "Expected a JSON string or an object, got " + (input === null ? "null" : typeof input) };
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
