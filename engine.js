/*
 * llm-json-schema engine — provider-correct JSON Schema transforms + linting.
 *
 * Dependency-free. Runs in the browser and in Node (for tests).
 *
 * Rules are sourced from the provider's CURRENT official docs AND, where the
 * vendor ships one, from the vendor's own client SDK — which encodes the
 * ACCEPTED keyword set, while the docs only describe the SUPPORTED subset.
 * The two differ, and the SDK wins. Each rule carries the URL it came from so
 * the UI can cite it — the provider-divergence logic IS the product's value.
 *
 * Sources:
 *   OpenAI    https://developers.openai.com/api/docs/guides/structured-outputs
 *             + `openai@7.4.0` lib/transform `toStrictJsonSchema()`  [2026-08-08]
 *   Anthropic https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview
 *   Gemini    https://ai.google.dev/gemini-api/docs/structured-output
 *             + `@google/genai@2.16.0` `Schema` type, `processJsonSchema()`,
 *               `maybeMoveToResponseJsonSchema()`                    [2026-08-09]
 */

(function (root) {
  "use strict";

  var DOCS = {
    openai: "https://developers.openai.com/api/docs/guides/structured-outputs",
    anthropic: "https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview",
    "anthropic-json": "https://platform.claude.com/docs/en/docs/build-with-claude/structured-outputs",
    "anthropic-json-python": "https://platform.claude.com/docs/en/docs/build-with-claude/structured-outputs",
    "anthropic-go": "https://platform.claude.com/docs/en/docs/build-with-claude/structured-outputs",
    gemini: "https://ai.google.dev/gemini-api/docs/structured-output",
    "gemini-json": "https://ai.google.dev/gemini-api/docs/structured-output",
    "openai-nonstrict": "https://platform.openai.com/docs/guides/function-calling",
    "openai-realtime": "https://platform.openai.com/docs/guides/realtime-conversations"
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

  // An OPEN MAP is `{"type":"object", "additionalProperties": <schema|true>}`
  // with no declared `properties` — the standard rendering of `Dict[str, V]`
  // (Pydantic), `Record<string, V>` / `z.record()` (Zod) and OpenAPI free-form
  // objects. All of the node's content lives in `additionalProperties`.
  //
  // This matters because the usual repair is to set `additionalProperties:
  // false`, and on a node with no `properties` that does not close the object —
  // it EMPTIES it. The map becomes a schema whose only legal instance is `{}`,
  // so the field can never be populated, and nothing in the request says so.
  // A rule that deletes the only content a node has must fail closed.
  function isOpenMap(node) {
    if (!isPlainObject(node)) return false;
    if (!("additionalProperties" in node)) return false;
    var ap = node.additionalProperties;
    if (ap === false) return false;                       // already closed on purpose
    if (ap !== true && !isPlainObject(ap)) return false;  // not a schema we understand
    if (isPlainObject(node.properties) && Object.keys(node.properties).length) return false;
    // `type` may be absent or an array (a nullable map) — treat any of those as
    // an object, per the spec's second form of `type`.
    var t = node.type;
    if (t === undefined) return true;
    if (t === "object") return true;
    if (Array.isArray(t) && t.indexOf("object") !== -1) return true;
    return false;
  }

  // An EMPTIED map is the fossil an open map leaves behind after something has
  // already "repaired" it: `additionalProperties: false` and NO `properties` key
  // at all. Its only legal instance is `{}`, so the field can never be
  // populated — but it is perfectly valid, every provider accepts it, and by the
  // time you are looking at it the value type is GONE. Nothing downstream can
  // recover what it used to be, which is why this is worth saying out loud.
  //
  // Measured against @mastra/schema-compat@1.3.5, whose
  // `prepareJsonSchemaForOpenAIStrictMode` produces exactly this from an
  // ordinary `z.record(z.string())`: the vendor then ACCEPTS the result.
  //
  // The discriminator is the ABSENCE of the `properties` key, not an empty one.
  // Measured: a deliberate `z.object({})` emits `properties: {}`, so requiring
  // the key to be missing separates a real empty object from an emptied map.
  // Being merely noisier than the vendor is this project's most repeated bug,
  // so this is advisory-only and never fails a gate.
  function isEmptiedMap(node) {
    if (!isPlainObject(node)) return false;
    if (node.additionalProperties !== false) return false;
    if ("properties" in node) return false;
    var t = node.type;
    if (t === "object") return true;
    if (Array.isArray(t) && t.indexOf("object") !== -1) return true;
    return false;
  }

  // ---- boolean subschemas ---------------------------------------------------
  //
  // JSON Schema defines a schema as "an object OR a boolean": `true` matches any
  // value, `false` matches none. Every walker in this file starts with
  // `if (!isPlainObject(node)) return;`, so a boolean node silently ends that
  // branch — not skipped-and-reported, skipped-and-SILENT. It is the same shape
  // as the container-spelling misses (`definitions` vs `$defs`, array-form
  // `items`, `/$defs/` vs `#/$defs/`, an array-valued `type`), except the
  // alternate spelling here is the spec's second form of a SCHEMA ITSELF.
  //
  // Not exotic. Go's canonical generator emits it for the four idiomatic ways of
  // saying "arbitrary JSON": `any`, `interface{}`, `json.RawMessage` and the
  // element type of `[]any` all reflect to a literal `true`.
  //
  // NOTE which positions count. `additionalProperties`, `unevaluatedProperties`
  // and `additionalItems` take a boolean BY DESIGN — flagging those would fire on
  // every closed object in existence. Only positions that hold a schema proper
  // are checked.
  function findBooleanSubschemas(root) {
    var hits = [];
    function visit(node, path) {
      if (node === true || node === false) { hits.push({ path: path, value: node }); return; }
      if (!isPlainObject(node)) return;
      if (isPlainObject(node.properties)) {
        Object.keys(node.properties).forEach(function (k) {
          visit(node.properties[k], path + "." + k);
        });
      }
      visit(node.items, path + "[]");
      if (Array.isArray(node.items)) {
        node.items.forEach(function (it, i) { visit(it, path + "[" + i + "]"); });
      }
      if (Array.isArray(node.prefixItems)) {
        node.prefixItems.forEach(function (it, i) { visit(it, path + "[" + i + "]"); });
      }
      ["anyOf", "oneOf", "allOf"].forEach(function (kw) {
        if (Array.isArray(node[kw])) {
          node[kw].forEach(function (sub, i) { visit(sub, path + "/" + kw + "[" + i + "]"); });
        }
      });
      ["$defs", "definitions"].forEach(function (bag) {
        if (isPlainObject(node[bag])) {
          Object.keys(node[bag]).forEach(function (k) { visit(node[bag][k], bag + "." + k); });
        }
      });
    }
    visit(root, "root");
    return hits;
  }

  // The node is left in place on purpose (#318): the reader has to be able to see
  // the shape in their own file. There is no repair — an unconstrained value has
  // no representation in a constrained-decoding dialect — so this names the
  // remodelling instead of inventing a type.
  function booleanSubschemaMessage(value, vendorNote) {
    return value === true
      ? "This is a boolean subschema (`true`), which matches ANY value. " + vendorNote +
        " There is no repair: a dialect that constrains decoding has no way to say " +
        "\"anything goes\", so a type has to be chosen rather than guessed. Declare the " +
        "shape you actually expect, or — if the value really is arbitrary — type it as " +
        "`{\"type\": \"string\"}` and have the model emit serialized JSON you parse yourself. " +
        "In Go this is what `any`, `interface{}`, `json.RawMessage` and the element type of " +
        "`[]any` reflect to."
      : "This is a boolean subschema (`false`), which matches NO value — nothing can ever " +
        "satisfy it, so the field is unsatisfiable as written. " + vendorNote +
        " Give it a real schema, or remove it (and drop it from `required`).";
  }

  var OPEN_MAP_REMEDY =
    "An open map cannot be expressed here, and closing it would leave an object " +
    "whose only legal value is `{}` — the field could never be populated. Remodel " +
    "it as an array of `{\"key\": ..., \"value\": ...}` objects (both halves stay " +
    "fully typed), or declare the keys you actually expect as fixed `properties`.";

  // Ledger entry: { op: "+"|"~"|"x"|"!", path, msg, ruleUrl, advisory }
  //   +  added        ~  changed        x  removed        !  violation (cannot auto-fix)
  //
  // `advisory: true` marks an OPTIONAL improvement — the schema is already
  // accepted without it. `--check` must not fail CI on these: a gate that goes
  // red on a valid schema is the same false-failure class as a doc-derived
  // allowlist rejecting a payload the vendor accepts.
  function entry(op, path, msg, ruleUrl, advisory) {
    var e = { op: op, path: path || "root", msg: msg, ruleUrl: ruleUrl };
    if (advisory) e.advisory = true;
    return e;
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
  //              dependentRequired dependencies if then else
  //              prefixItems maxContains contentEncoding contentMediaType
  //              contentSchema $anchor $dynamicRef $recursiveRef
  //
  // `prefixItems` was originally classified as structural-and-supported here
  // WITHOUT being probed. It is in the SDK's unsupported set, and array-form
  // `items` throws separately ("uses tuple-form `items`"). Both are what an
  // ordinary tuple compiles to — Pydantic `Tuple[float, float, float, float]`
  // emits `prefixItems`, zod `z.tuple()` emits either depending on target
  // dialect — so both leaked through and produced a schema the API rejects.
  // See normalizeTuple.
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
    // `items` only in its OBJECT form — the draft-07 ARRAY form is a tuple and
    // is rejected ("uses tuple-form `items`"). normalizeTuple owns that case.
    // `prefixItems` is NOT here: it is in the SDK's own unsupported set.
    items: 1, anyOf: 1, enum: 1, "const": 1, $ref: 1, $defs: 1,
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

  // A local pointer is spelled `#/$defs/X`. LiteLLM deliberately emits `/$defs/X`
  // instead — it passes `ref_template="/$defs/{model}"` to Pydantic's
  // `model_json_schema()` (litellm/llms/anthropic/chat/transformation.py), so this
  // is the DEFAULT shape for every Python caller using `response_format=<Model>`.
  //
  // That spelling is not a local pointer. Per RFC 3986 it is a path-absolute
  // URI-reference with no fragment, so it addresses a different document and never
  // resolves against the local `$defs`. LiteLLM's own code agrees: its OTHER
  // Anthropic path calls `unpack_defs()` first, commented "Anthropic doesn't
  // support external schema references (e.g., /$defs/CalendarEvent)".
  //
  // Every rule below matches `#/$defs/...`, so before this normalisation an
  // unrecognised spelling did not merely go unfixed — the orphan-`$defs` pruner
  // found no reference to the definition and DELETED it, leaving a dangling
  // pointer, and `inlineRootRef` no-oped so a root `$ref` sailed through as
  // "already valid". That is the single most destructive Anthropic input there is.
  //
  // Conditional, not unconditional (#318): rewrite only when the target actually
  // exists locally. A `/$defs/X` with no local `X` really is external, and no
  // provider resolves those — that gets named as a blocker instead of quietly
  // rewritten into a pointer at something that was never there.
  function normalizeRefSpelling(s, ledger, docUrl, why) {
    var bags = ["$defs", "definitions"];
    var rewritten = 0, external = [];
    (function visit(v) {
      if (Array.isArray(v)) { v.forEach(visit); return; }
      if (!isPlainObject(v)) return;
      if (typeof v.$ref === "string" && v.$ref.charAt(0) !== "#") {
        var m = /^\/(\$defs|definitions)\/(.+)$/.exec(v.$ref);
        var name = m ? m[2] : null;
        if (m && isPlainObject(s[m[1]]) && isPlainObject(s[m[1]][name])) {
          v.$ref = "#" + v.$ref;
          rewritten++;
        } else if (external.indexOf(v.$ref) === -1) {
          external.push(v.$ref);
        }
      }
      Object.keys(v).forEach(function (k) { visit(v[k]); });
    })(s);

    if (rewritten) {
      ledger.push(entry("~", "root",
        "Rewrote " + rewritten + " `$ref` from `/$defs/...` to `#/$defs/...`. Only the second form is " +
        "a pointer into this document; the first addresses a different document and leaves the " +
        "reference dangling. " + (why || "") + " LiteLLM emits this spelling by default for Python " +
        "callers — it passes `ref_template=\"/$defs/{model}\"` to Pydantic — and its own " +
        "`output_format` path inlines such refs first, commented \"Anthropic doesn't support " +
        "external schema references\". The `tools[].input_schema` path it uses for " +
        "`response_format=<Model>` does not.",
        docUrl || DOCS.openai));
    }
    external.forEach(function (ref) {
      ledger.push(entry("!", "root",
        "`$ref: \"" + ref + "\"` points outside this document and there is no matching local " +
        "definition to resolve it against. No provider fetches external schema references — the " +
        "reference arrives dangling. Inline the definition or add it to `$defs`.",
        docUrl || DOCS.openai));
    });
    return s;
  }

  // `definitions` is draft-07 (what zod-to-json-schema emits); OpenAI's doc and
  // examples use `$defs`. Rename it and repoint every `$ref` that used it.
  function normalizeDefs(s, ledger, docUrl, why) {
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
      why || "Renamed draft-07 `definitions` to `$defs` and repointed every `$ref` — OpenAI's schema dialect uses `$defs`. (zod-to-json-schema emits `definitions`.)",
      docUrl || DOCS.openai));
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
  // True when the root is a `$ref` whose target is actually present in `$defs`.
  // Used to decide whether inlining is REQUIRED or merely harmless: a pointer
  // with no local target is dead everywhere, so it never qualifies.
  function rootRefResolvesInDefs(s) {
    if (typeof s.$ref !== "string") return false;
    var m = /^#\/\$defs\/(.+)$/.exec(s.$ref);
    if (!m) return false;
    return isPlainObject(s.$defs) && isPlainObject(s.$defs[m[1]]);
  }

  function inlineRootRef(s, ledger, docUrl, why) {
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
      "Inlined the root `$ref` (`#/$defs/" + name + "`) into the root. " + (why ||
        "OpenAI requires the root to be an object schema, and a bare `$ref` root leaves " +
        "`additionalProperties`/`required` unset on the real object."),
      docUrl || DOCS.openai));
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
  function resolveRefSiblings(s, ledger, docUrl, whyFixed, whyRecursive) {
    if (!isPlainObject(s.$defs)) return s;
    var defs = s.$defs, fixed = 0, unresolved = [];

    function visit(node, stack) {
      if (Array.isArray(node)) return node.map(function (n) { return visit(n, stack); });
      if (!isPlainObject(node)) return node;

      // `$defs` is the definition bag, not a constraining sibling: `{$ref, $defs}`
      // is the canonical root-ref shape every generator emits, and counting it
      // here would force an inline even where the vendor resolves the pointer
      // correctly. Every other target inlines a root `$ref` earlier anyway, so
      // this only changes the one path that deliberately does not.
      var siblings = Object.keys(node).filter(function (k) {
        return k !== "$ref" && k !== "$defs";
      });
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
        "Inlined " + fixed + " `$ref` that carried sibling keywords — " + (whyFixed ||
          "OpenAI rejects those with \"$ref cannot have keywords\"." ) +
        " Pydantic emits this for a nested-model or Enum field that also has a `description`.",
        docUrl || DOCS.openai));
    }
    unresolved.forEach(function (name) {
      ledger.push(entry("!", "root",
        "`" + name + "` is recursive and its `$ref` carries sibling keywords, which " + (whyRecursive ||
          "OpenAI rejects") + ". Move those keywords into the definition itself — a recursive `$ref` " +
        "cannot be inlined.",
        docUrl || DOCS.openai));
    });
    return result;
  }

  // Key-order-independent structural identity, so two tuple entries that a
  // generator emitted with the same shape compare equal regardless of key order.
  function canonical(v) {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (isPlainObject(v)) {
      return "{" + Object.keys(v).sort().map(function (k) {
        return JSON.stringify(k) + ":" + canonical(v[k]);
      }).join(",") + "}";
    }
    return JSON.stringify(v);
  }

  // ---- oneOf exclusivity (OpenAI strict) -----------------------------------
  //
  // `oneOf` means EXACTLY ONE branch matches; `anyOf` means AT LEAST ONE. So
  // rewriting one to the other is only lossless when the branches cannot both
  // match. Rewriting unconditionally silently WIDENS the schema, which is the
  // same class of harm as silently stripping it.
  //
  // This is not our judgement call — it is openai@7.4.0's. The five builders in
  // `helpers/zod.js` run only `toStrictJsonSchema()`, which passes `oneOf`
  // through untouched. But `helpers/standard-schema.js` (four MORE builders,
  // uncounted until now) runs `normalizeStructuredOutputSchema()` first, and
  // that function rewrites `oneOf` to `anyOf` ONLY when it can prove the
  // branches mutually exclusive. When it cannot, it throws:
  //
  //   "Standard JSON Schema generated a `oneOf` whose branches are not provably
  //    mutually exclusive. OpenAI strict schemas do not support `oneOf`; use
  //    `anyOf` or add a discriminator with distinct literal values."
  //
  // The proof below mirrors the vendor's, deliberately clause for clause. It
  // must not be MORE conservative than theirs: a schema they accept and we
  // block is a false CI failure, which is the bug this project keeps shipping
  // (#312, #314, #317). The test suite pins our verdict against theirs.
  var ANNOTATION_KW = {
    $comment: 1, "default": 1, description: 1, examples: 1,
    readOnly: 1, title: 1, writeOnly: 1
  };
  var JSON_SCHEMA_TYPES = {
    string: 1, number: 1, integer: 1, boolean: 1, object: 1, array: 1, "null": 1
  };

  function isJSONPrimitive(v) {
    return v === null || typeof v === "string" || typeof v === "boolean" ||
      (typeof v === "number" && isFinite(v));
  }

  // `const`, else a fully-primitive `enum`. Anything else: not a literal node.
  function literalValues(node) {
    if (!isPlainObject(node)) return null;
    if ("const" in node && isJSONPrimitive(node["const"])) return [node["const"]];
    var e = node.enum;
    if (Array.isArray(e) && e.length && e.every(isJSONPrimitive)) return e;
    return null;
  }

  function schemaTypes(node) {
    if (!isPlainObject(node)) return null;
    if (node.type === undefined) {
      var lits = literalValues(node);
      if (!lits) return null;
      return lits.map(function (v) { return v === null ? "null" : typeof v; });
    }
    var types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.length) return null;
    if (!types.every(function (t) { return typeof t === "string" && JSON_SCHEMA_TYPES[t]; })) return null;
    return types;
  }

  // `integer` is a subset of `number`, so those two overlap.
  function typesOverlap(a, b) {
    return a === b ||
      (a === "integer" && b === "number") ||
      (a === "number" && b === "integer");
  }

  function disjointLiterals(l, r) {
    var lv = literalValues(l), rv = literalValues(r);
    if (!lv || !rv) return false;
    return lv.every(function (a) {
      return !rv.some(function (b) { return a === b; });
    });
  }

  function objectOnly(node) {
    var t = schemaTypes(node);
    return !!t && t.length === 1 && t[0] === "object";
  }

  // Two closed objects that each require a property the other does not declare
  // can never both validate: the extra key is rejected as an additional
  // property by whichever branch omits it.
  function closedPropertySet(node) {
    if (!objectOnly(node)) return null;
    var props = node.properties, req = node.required;
    if (node.additionalProperties !== false) return null;
    if (!isPlainObject(props) || !Array.isArray(req)) return null;
    if (!req.every(function (p) { return typeof p === "string"; })) return null;
    var declared = Object.keys(props);
    // A required-but-undeclared property makes the branch unsatisfiable; leave
    // that to normal validation rather than treating it as a proof.
    if (req.some(function (p) { return declared.indexOf(p) === -1; })) return null;
    return { declared: declared, required: req };
  }

  function disjointClosedObjects(l, r) {
    var ls = closedPropertySet(l), rs = closedPropertySet(r);
    if (!ls || !rs) return false;
    return ls.required.some(function (p) { return rs.declared.indexOf(p) === -1; }) ||
      rs.required.some(function (p) { return ls.declared.indexOf(p) === -1; });
  }

  // A shared required property whose literal values are disjoint = a
  // discriminated union, the shape the vendor's error message recommends.
  function disjointDiscriminator(l, r, root) {
    if (!objectOnly(l) || !objectOnly(r)) return false;
    var lp = l.properties, rp = r.properties, lr = l.required, rr = r.required;
    if (!isPlainObject(lp) || !isPlainObject(rp)) return false;
    if (!Array.isArray(lr) || !Array.isArray(rr)) return false;
    return lr.some(function (p) {
      if (typeof p !== "string" || rr.indexOf(p) === -1) return false;
      return disjointLiterals(exclResolve(lp[p], root), exclResolve(rp[p], root));
    });
  }

  function hasOnlyRefAndAnnotations(node) {
    return Object.keys(node).every(function (k) {
      return k === "$ref" || k === "$defs" || k === "definitions" || ANNOTATION_KW[k];
    });
  }

  // Follow a local `$ref` only when it carries no sibling CONSTRAINTS — a
  // sibling `minLength` beside a `$ref` changes what the branch accepts, so the
  // target alone would not prove anything. Returns undefined = unprovable.
  function exclResolve(node, root, seen) {
    if (!isPlainObject(node)) return node;
    seen = seen || {};
    if (node.$ref !== undefined) {
      if (typeof node.$ref !== "string" || !hasOnlyRefAndAnnotations(node)) return undefined;
      if (seen[node.$ref]) return undefined;
      var target = derefLocal(root, node.$ref);
      if (target === undefined) return undefined;
      var next = {};
      Object.keys(seen).forEach(function (k) { next[k] = 1; });
      next[node.$ref] = 1;
      return exclResolve(target, root, next);
    }
    return node;
  }

  // "#/$defs/A" style pointers only; anything else is not locally resolvable.
  function derefLocal(root, ref) {
    if (ref.charAt(0) !== "#") return undefined;
    var body = ref.slice(1);
    if (body === "" || body === "/") return root;
    if (body.charAt(0) !== "/") return undefined;
    var parts = body.slice(1).split("/");
    var cur = root;
    for (var i = 0; i < parts.length; i++) {
      var key = decodeURIComponent(parts[i]).replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isPlainObject(cur) && !Array.isArray(cur)) return undefined;
      if (!(key in cur)) return undefined;
      cur = cur[key];
    }
    return cur;
  }

  function mutuallyExclusive(l, r, root) {
    var lt = schemaTypes(l), rt = schemaTypes(r);
    if (lt && rt && lt.every(function (a) {
      return rt.every(function (b) { return !typesOverlap(a, b); });
    })) return true;
    return disjointLiterals(l, r) ||
      disjointDiscriminator(l, r, root) ||
      disjointClosedObjects(l, r);
  }

  function oneOfProvablyExclusive(branches, root) {
    if (!Array.isArray(branches)) return false;
    // `false` can never validate, so it cannot overlap anything.
    var live = branches.filter(function (b) { return b !== false; });
    for (var i = 0; i < live.length; i++) {
      for (var j = i + 1; j < live.length; j++) {
        var l = exclResolve(live[i], root), r = exclResolve(live[j], root);
        if (l === undefined || r === undefined) return false;
        if (!mutuallyExclusive(l, r, root)) return false;
      }
    }
    return true;
  }

  // OpenAI strict mode has NO tuple form. openai@7.4.0's toStrictJsonSchema
  // throws on `prefixItems` ("uses unsupported keyword `prefixItems`") and on
  // array-form `items` ("uses tuple-form `items`"). A fixed-length tuple whose
  // entries are all the same schema is exactly a fixed-length array, so it
  // converts losslessly to `items` + `minItems`/`maxItems`. A heterogeneous
  // tuple is genuinely not representable: collapsing it would either widen it
  // (union of the entries, losing per-position typing) or drop positions
  // entirely. That is a human fix, so it becomes a blocker rather than a
  // silent rewrite. Returns true when the tuple keyword must be left in place.
  // `why` names the provider-specific reason a tuple cannot survive; both
  // OpenAI strict mode and Anthropic's structured-output transformer lack a
  // tuple form, but they fail differently, so the message must not be shared
  // blindly. (#314's rule: do not port one provider's wording or policy to
  // another without reading what that provider actually does.)
  function normalizeTuple(node, path, ledger, docUrl, whyBlocked, whyCollapsed) {
    var tuple = null, kw = null;
    if (Array.isArray(node.prefixItems)) { tuple = node.prefixItems; kw = "prefixItems"; }
    else if (Array.isArray(node.items)) { tuple = node.items; kw = "items"; }
    if (!tuple || !tuple.length) return false;

    var head = canonical(tuple[0]);
    var homogeneous = tuple.every(function (t) { return canonical(t) === head; });

    if (!homogeneous) {
      ledger.push(entry("!", path,
        "This is a " + tuple.length + "-element tuple with differently-typed positions (`" + kw + "`). " +
        (whyBlocked ||
          "OpenAI strict mode cannot represent it — it has no tuple form.") +
        " Model it as an object with one named property per position instead; that keeps each " +
        "position's type and is what the model fills in more reliably anyway.",
        docUrl || DOCS.openai));
      return true;
    }

    var n = tuple.length;
    node.items = clone(tuple[0]);
    if (kw === "prefixItems") delete node.prefixItems;
    if (node.minItems === undefined) node.minItems = n;
    if (node.maxItems === undefined) node.maxItems = n;
    ledger.push(entry("~", path,
      "Collapsed a " + n + "-element tuple (`" + kw + "`) into `items` with `minItems`/`maxItems` of " + n +
      ". " + (whyCollapsed ||
        "OpenAI strict mode has no tuple form, but every position here has the same schema, so the " +
        "fixed length survives as a constraint."),
      docUrl || DOCS.openai));
    return false;
  }

  function toOpenAI(schema) {
    var s = clone(schema);
    var ledger = [];

    s = normalizeRefSpelling(s, ledger);
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

    // Measured against openai@7.4.0's toStrictJsonSchema(): a boolean at any of
    // the six sub-schema positions throws `Expected object schema but got
    // boolean`, and a boolean ROOT throws `Root schema must have type: 'object'`.
    // Eight positions, eight throws — so this is a blocker, not over-strictness.
    findBooleanSubschemas(s).forEach(function (h) {
      ledger.push(entry("!", h.path,
        booleanSubschemaMessage(h.value,
          "OpenAI strict mode rejects it: `toStrictJsonSchema()` throws " +
          "`Expected object schema but got boolean`."),
        DOCS.openai));
    });

    walk(s, "root", function (node, path) {
      // `allOf` is NOT flatly unsupported, and treating it that way deleted
      // whole subschemas. Measured against openai@7.4.0's toStrictJsonSchema:
      //   allOf with ONE member                  -> flattened, annotations kept
      //   allOf of OPEN objects (no additionalProperties:false)
      //                                          -> merged (properties+required)
      //   allOf of CLOSED objects                -> throws, "cannot be merged
      //                                             without changing Draft 7 validation"
      //   allOf of non-objects, 2+ members       -> throws, unsupported keyword
      // We had a blanket strip, so `{allOf:[<object>], description:"..."}` —
      // exactly what Pydantic emits for a $ref'd model with a field
      // description — came out as `{"description":"..."}`: the entire shape
      // gone, reported as a successful fix. Silent widening, again.
      var allOfBlocked = false;
      if (Array.isArray(node.allOf) && node.allOf.length) {
        var members = node.allOf;
        var mergeable =
          members.length === 1 ||
          members.every(function (m) {
            return isPlainObject(m) && m.type === "object" &&
              isPlainObject(m.properties) && m.additionalProperties !== false;
          });
        if (!mergeable) {
          allOfBlocked = true;
          ledger.push(entry("!", path,
            "`allOf` with " + members.length + " members that OpenAI cannot merge. Its transformer " +
            "merges an `allOf` of OPEN object schemas and flattens a single-member one, but throws on " +
            "anything else — closed objects (`additionalProperties: false`) \"cannot be merged without " +
            "changing Draft 7 validation\", and non-object members are simply unsupported. Express the " +
            "combined shape as one object schema. We will not drop the `allOf` for you: that would " +
            "silently remove every constraint inside it.",
            DOCS.openai));
        } else if (members.length === 1) {
          var only = members[0];
          if (isPlainObject(only)) {
            Object.keys(only).forEach(function (k) {
              if (!(k in node)) node[k] = clone(only[k]);
            });
          }
          delete node.allOf;
          ledger.push(entry("~", path,
            "Flattened a single-member `allOf` into this node — OpenAI's own transformer does exactly " +
            "this, keeping the wrapper's annotations. Nothing is lost. (A `$ref` wrapped in `allOf` " +
            "beside a `description` is the standard Pydantic output for a referenced model with a " +
            "field description.)",
            DOCS.openai));
        } else {
          var mergedProps = {}, mergedReq = [];
          members.forEach(function (m) {
            Object.keys(m.properties).forEach(function (k) {
              if (!(k in mergedProps)) mergedProps[k] = clone(m.properties[k]);
            });
            (Array.isArray(m.required) ? m.required : []).forEach(function (k) {
              if (mergedReq.indexOf(k) === -1) mergedReq.push(k);
            });
          });
          Object.keys(mergedProps).forEach(function (k) {
            if (!node.properties) node.properties = {};
            if (!(k in node.properties)) node.properties[k] = mergedProps[k];
          });
          var nodeReq = Array.isArray(node.required) ? node.required : [];
          mergedReq.forEach(function (k) { if (nodeReq.indexOf(k) === -1) nodeReq.push(k); });
          node.required = nodeReq;
          if (node.type === undefined) node.type = "object";
          delete node.allOf;
          ledger.push(entry("~", path,
            "Merged an `allOf` of " + members.length + " open object schemas into one object — the " +
            "union of their properties and of their `required` lists. This is what OpenAI's " +
            "transformer does with the same input.",
            DOCS.openai));
        }
      }

      // `anyOf` is the union OpenAI supports; `oneOf` is not representable.
      // Rewriting is only lossless when the branches are provably disjoint —
      // see oneOfProvablyExclusive above for why, and whose rule this is.
      var oneOfBlocked = false;
      if (Array.isArray(node.oneOf)) {
        if (node.anyOf !== undefined) {
          oneOfBlocked = true;
          ledger.push(entry("!", path,
            "This node has both `anyOf` and `oneOf`. OpenAI's own transformer refuses this outright " +
            "(\"Standard JSON Schema generated both `anyOf` and `oneOf`, which cannot be represented " +
            "in an OpenAI strict schema\"). Merge them into a single `anyOf` yourself — we will not " +
            "guess which one you meant, because either guess changes what the schema accepts.",
            DOCS.openai));
        } else if (oneOfProvablyExclusive(node.oneOf, s)) {
          node.anyOf = node.oneOf;
          delete node.oneOf;
          ledger.push(entry("~", path,
            "Rewrote `oneOf` as `anyOf` — `anyOf` is the only union keyword OpenAI strict mode can " +
            "represent, and these branches are provably mutually exclusive, so \"exactly one\" and " +
            "\"at least one\" mean the same thing here. Nothing is widened.",
            DOCS.openai));
        } else {
          oneOfBlocked = true;
          ledger.push(entry("!", path,
            "`oneOf` here is NOT provably mutually exclusive, so it cannot be rewritten as `anyOf` " +
            "without widening the schema — `oneOf` means exactly one branch matches, `anyOf` means at " +
            "least one. OpenAI strict mode has no `oneOf`, and its own transformer throws on this case " +
            "rather than widening. Fix it the way OpenAI recommends: use `anyOf` if overlap is " +
            "acceptable, or add a discriminator property with distinct literal values to each branch.",
            DOCS.openai));
        }
      }

      // `$id` is retained at the ROOT (it is in the SDK's own rootMetadata set),
      // but a NESTED `$id` opens a separate resource scope and is fatal:
      // "Nested $id at ... cannot be represented in strict Structured Outputs."
      // Deleting it is not safe — refs may resolve against that scope — so this
      // is a human fix, like a heterogeneous tuple.
      if (path !== "root" && node.$id !== undefined) {
        ledger.push(entry("!", path,
          "Nested `$id` — OpenAI's transformer throws here (\"Nested $id at \\\"" + path + "\\\" " +
          "establishes a separate JSON Schema resource scope and cannot be represented in strict " +
          "Structured Outputs\"). Note `$id` is fine on the ROOT; only nested ones are fatal. " +
          "Remove it, and if any `$ref` resolved against it, rewrite that ref as a plain " +
          "`#/$defs/...` pointer.",
          DOCS.openai));
      }

      var tupleBlocked = normalizeTuple(node, path, ledger);

      // An array MUST declare `items`. This is not a keyword the allowlist can
      // express — it is a structural OBLIGATION, so a presence/absence
      // allowlist is blind to it, exactly as it was blind to nested `$id`
      // being fatal while root `$id` is fine. Verified: toStrictJsonSchema
      // throws "declares an array without `items`, which cannot be represented
      // in strict Structured Outputs". We cannot invent the element type, so
      // this is a human fix.
      if (!tupleBlocked && node.items === undefined) {
        var t = schemaTypes(node);
        if (t && t.indexOf("array") !== -1) {
          ledger.push(entry("!", path,
            "This is an array with no `items`. OpenAI strict mode throws on it (\"declares an array " +
            "without `items`\") because a constrained decoder has no element type to emit. Give it an " +
            "`items` schema — even `{\"type\": \"string\"}` — or drop the field.",
            DOCS.openai));
        }
      }

      // strip every keyword outside the supported set (unsupported => API error)
      Object.keys(node).forEach(function (k) {
        if (OPENAI_SUPPORTED[k]) return;
        // A blocked tuple stays visible so the reader can see the shape they
        // have to remodel; deleting it would hide the very thing to fix.
        if (k === "prefixItems" && tupleBlocked) return;
        // Same reasoning for a blocked `oneOf`: stripping it would delete the
        // "exactly one" constraint entirely — a silent widening on top of an
        // unreported one — and hide the keyword the reader has to remodel.
        if (k === "oneOf" && oneOfBlocked) return;
        if (k === "allOf" && allOfBlocked) return;
        var why = OPENAI_STRIP_REASON[k] ||
          "not in OpenAI's supported keyword set, and strict mode errors on unsupported keywords.";
        delete node[k];
        ledger.push(entry("x", path, "Removed `" + k + "` — " + why, DOCS.openai));
      });

      if (isObjectSchema(node) || isOpenMap(node)) {
        // additionalProperties: false on every object
        if (isOpenMap(node)) {
          // Do NOT rewrite: setting `false` here deletes the node's only content.
          // Left visible so the reader can see the shape they have to remodel.
          ledger.push(entry("!", path,
            "This is an open map (`additionalProperties` with no `properties`). OpenAI " +
            "strict mode requires `additionalProperties: false` on every object. " +
            OPEN_MAP_REMEDY,
            DOCS.openai));
        } else if (node.additionalProperties !== false) {
          var was = "additionalProperties" in node;
          var lost = was && node.additionalProperties !== false;
          node.additionalProperties = false;
          ledger.push(entry(was ? "~" : "+", path,
            "Set `additionalProperties: false` — required on every object." +
            (lost ? " The extra keys your `additionalProperties` allowed are no longer " +
              "accepted; only the declared `properties` survive." : ""),
            DOCS.openai));
        }
        // every property must be required; keep optionals optional-in-spirit via nullable
        var props = node.properties ? Object.keys(node.properties) : [];
        var prev = Array.isArray(node.required)
          ? node.required.filter(function (k) { return typeof k === "string"; })
          : [];

        // A key in `required` that `properties` never declares. The vendor
        // REFUSES this outright — openai@7.4.0 throws "requires property `x`
        // but does not declare it in `properties`" — so it cannot be waved
        // through. It also cannot be repaired: the rewrite below sets
        // `required` to the declared keys, and doing that DELETES the
        // undeclared name, silently dropping a constraint the caller wrote
        // (and, where `properties` is absent entirely, leaves output the
        // vendor still rejects while the ledger claims a fix). Neither branch
        // is guessable from the schema — the name might be a stale leftover,
        // or a property whose declaration was lost — so name it and stop.
        var undeclared = prev.filter(function (k) { return props.indexOf(k) === -1; });
        if (undeclared.length) {
          ledger.push(entry("!", path,
            "`required` lists " + undeclared.map(function (k) { return "`" + k + "`"; }).join(", ") +
            ", which `properties` does not declare. OpenAI strict mode rejects this outright " +
            "(`requires property `" + undeclared[0] + "` but does not declare it in `properties``), " +
            "and there is no safe automatic fix: dropping the name from `required` would silently " +
            "remove a constraint you wrote, and declaring it here would mean inventing a type for it. " +
            "Either declare each one in `properties` (strict mode then also requires it to stay in " +
            "`required`), or remove it from `required` if it is stale.",
            DOCS.openai));
        }

        if (props.length) {
          var added = props.filter(function (k) { return prev.indexOf(k) === -1; });
          // Undeclared names are carried through rather than dropped, so the
          // shape stays visible in the output the reader is looking at.
          node.required = props.slice().concat(undeclared);
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

    // Every edit above is justified by strict mode, and `strict` is optional at four
    // declaration sites in openai@7.4.0 — so a caller who never set it is being shown
    // work they do not need to do. Only say so when we actually changed something,
    // and keep it advisory: it must not fail a gate that legitimately passed.
    if (ledger.length) {
      ledger.push(entry("=", "root",
        "These changes are required by strict mode only. If you are NOT setting " +
        "`strict: true` (it is optional and defaults off — Instructor omits it on every " +
        "OpenAI path, including the deprecated `Mode.TOOLS_STRICT`), the keyword subset " +
        "does not apply and your schema is already valid: re-run with `--to openai-nonstrict`.",
        DOCS.openai, true));
    }

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

  // ---- Anthropic: TWO paths, and the switch is WHICH API FEATURE you call ---
  //
  // Verified 2026-08-09 against the vendor SDK `@anthropic-ai/sdk@0.116.0`, not
  // the doc. Like Gemini (#314) Anthropic has two accepted dialects, but the
  // routing is different: Gemini switches on a key inside the schema
  // (`$schema`), Anthropic switches on the request field you put it in.
  //
  //   Path T — `tools[].input_schema`   (helpers/beta `betaTool`, `betaZodTool`)
  //       NO client-side transform at all. Your JSON Schema is attached
  //       verbatim. The only client-side check is that the ROOT is
  //       `type: "object"`, which throws otherwise.
  //
  //   Path O — `output_format: { type: "json_schema" }`
  //       (`helpers/json-schema.js` -> `jsonSchemaOutputFormat`, `zodOutputFormat`,
  //        and the beta variants) runs `lib/transform-json-schema.js`, which
  //       REBUILDS the schema from a small allowlist.
  //
  // The policy on Path O is a THIRD kind, and it is the reason this converter
  // exists. OpenAI ERRORS on an unsupported keyword (#312). Gemini's
  // `responseJsonSchema` IGNORES it (#314). Anthropic DEMOTES it: every
  // unrecognised keyword left on a node is `JSON.stringify`'d and appended to
  // that node's `description`. Measured:
  //
  //   {type:"string", enum:["low","high"]}
  //     -> {"type":"string","description":"{enum: [\"low\",\"high\"]}"}
  //
  // The enum still reaches the model, as a sentence. It is no longer enforced.
  // Nothing errors, nothing warns — the constraint just silently stops being a
  // constraint, which is the worst of the three policies to debug.
  //
  // Recognised on Path O (everything else is demoted to prose):
  //   any node : $ref (returns EARLY — all siblings dropped), $defs, type,
  //              anyOf, oneOf (rewritten to anyOf), allOf, description, title
  //   object   : properties, required (passed through AS GIVEN — Anthropic does
  //              NOT require every key, unlike OpenAI), additionalProperties
  //              (popped and forced to false regardless of your value)
  //   string   : format, but only the 10 in SUPPORTED_STRING_FORMATS
  //   array    : items, and minItems only when it is exactly 0 or 1
  //
  // And it THROWS ("JSON schema must have a type defined if anyOf/oneOf/allOf
  // are not used") on any node with no `type`, because it recurses into that
  // node and finds nothing to key on.
  //
  // The two tuple spellings fail DIFFERENTLY here, and the difference matters:
  //   `items: [A, B]`  (draft-07)          -> recursed into as a schema -> THROWS
  //   `prefixItems: [A, B]` + `items:false` -> `items:false` recursed into -> THROWS
  //   `prefixItems: [A, B]` alone           -> NOT recognised -> demoted to prose,
  //        leaving a bare `{"type":"array"}` — an array with NO item schema and
  //        NO length, i.e. totally unconstrained. That is the worse outcome, and
  //        it is exactly what zod v4's `z.toJSONSchema(z.tuple([...]))` emits.

  var ANTHROPIC_STRING_FORMATS = {
    "date-time": 1, "time": 1, "date": 1, "duration": 1, "email": 1,
    "hostname": 1, "uri": 1, "ipv4": 1, "ipv6": 1, "uuid": 1
  };

  // Keys `transform-json-schema.js` consumes; anything else on a node is
  // stringified into `description`.
  // `pythonSdk` selects which of the vendor's TWO SDK implementations to model.
  // They are not a version skew: `anthropic==0.116.0` (Python) and
  // `@anthropic-ai/sdk@0.116.0` (JS) carry the SAME version string and disagree.
  // Measured over 43 schema shapes, they agree semantically on 41; `enum` is one
  // of the two exceptions (Python keeps it, JS stringifies it into `description`).
  // ---- Anthropic's THIRD SDK: `anthropic-sdk-go` ---------------------------
  //
  // Measured 2026-08-09 against `github.com/anthropics/anthropic-sdk-go@v1.62.0`
  // by calling its exported helpers directly, not by reading the diff.
  //
  // Three things make Go its own target rather than an alias of the other two:
  //
  //  1. THERE IS NO VERBATIM PATH. In TypeScript and Python `tools[].input_schema`
  //     applies no transform at all (#315/#321), which is what `--to anthropic`
  //     exists for. In Go BOTH exported helpers — `BetaJSONSchemaOutputFormat`
  //     and `BetaToolInputSchema` — call the same `transformSchemaMap`, so a Go
  //     caller gets the rebuild on the tools path too. Verified: identical output
  //     from both helpers on all 19 shapes probed.
  //
  //  2. IT KEEPS MORE. `supportedSchemaKeys` (schemautil.go) is a flat set that
  //     includes `enum`, `const` AND `pattern`. TypeScript demotes all three to
  //     prose; Python keeps `enum` only. So the three SDKs have three different
  //     supported-key sets at the same vendor, and `pattern` is kept only by Go.
  //
  //  3. IT CAN LOSE EVERYTHING. `transformSchemaMap` round-trips your map through
  //     `invopop/jsonschema.Schema` and `return nil`s on any unmarshal error,
  //     swallowing it. That struct types `Type` as a `string` and `Items` as a
  //     `*Schema`, so an array-valued `type` or a draft-07 tuple (`items: [A,B]`)
  //     ANYWHERE in the document — including inside `$defs` — makes the WHOLE
  //     schema come back `nil`. Measured, both at the root and nested.
  //
  // And a fourth difference that is not a policy but a bug, reported upstream:
  // `formatExtraValue` walks pointers with reflect but then formats the ORIGINAL
  // value, so every pointer-typed field renders as a hexadecimal address. The
  // demote-to-prose policy is defeated for exactly those keys — the model is told
  // `{maxLength: 0x162d307bcc80}`.
  var ANTHROPIC_GO_SUPPORTED = {
    "$ref": 1, "$defs": 1, "type": 1, "anyOf": 1, "oneOf": 1, "allOf": 1,
    "description": 1, "title": 1, "enum": 1, "const": 1, "properties": 1,
    "additionalProperties": 1, "required": 1, "items": 1, "minItems": 1,
    "format": 1, "pattern": 1
  };

  // Keys `invopop/jsonschema@v0.14.0` gives a struct field. Anything OUTSIDE
  // this set never survives the round-trip at all: `Schema.UnmarshalJSON` is a
  // plain alias unmarshal, so unknown keys are dropped before `transformSchema`
  // ever runs and never reach the extras-to-description path. Two different
  // severities hide behind one "unsupported": modelled keys become prose,
  // unmodelled keys vanish without a trace.
  var GO_INVOPOP_MODELLED = {
    "$schema": 1, "$id": 1, "$anchor": 1, "$ref": 1, "$dynamicRef": 1, "$defs": 1,
    "$comment": 1, "allOf": 1, "anyOf": 1, "oneOf": 1, "not": 1, "if": 1, "then": 1,
    "else": 1, "dependentSchemas": 1, "prefixItems": 1, "items": 1, "contains": 1,
    "properties": 1, "patternProperties": 1, "additionalProperties": 1,
    "propertyNames": 1, "type": 1, "enum": 1, "const": 1, "multipleOf": 1,
    "maximum": 1, "exclusiveMaximum": 1, "minimum": 1, "exclusiveMinimum": 1,
    "maxLength": 1, "minLength": 1, "pattern": 1, "maxItems": 1, "minItems": 1,
    "uniqueItems": 1, "maxContains": 1, "minContains": 1, "maxProperties": 1,
    "minProperties": 1, "required": 1, "dependentRequired": 1, "format": 1,
    "contentEncoding": 1, "contentMediaType": 1, "contentSchema": 1, "title": 1,
    "description": 1, "default": 1, "deprecated": 1, "readOnly": 1,
    "writeOnly": 1, "examples": 1
  };

  // Fields invopop declares as `*uint64`, i.e. the ones `formatExtraValue`
  // renders as a pointer address instead of a number. `minItems` is the one
  // near-miss: the array branch dereferences it explicitly before demoting, so
  // it is the only length keyword that prints its value.
  var GO_POINTER_FORMATTED = {
    "maxLength": 1, "minLength": 1, "maxItems": 1, "maxContains": 1,
    "minContains": 1, "maxProperties": 1, "minProperties": 1
  };

  function anthropicGoRecognises(node, key) {
    if (!ANTHROPIC_GO_SUPPORTED[key]) return false;
    // `supportedSchemaKeys` is consulted before the per-type switch, so a key in
    // the set survives on a node of any type. Only two get a second, type-gated
    // demotion afterwards.
    if (key === "format") {
      return node.type !== "string" || !!ANTHROPIC_STRING_FORMATS[node.format];
    }
    if (key === "minItems") {
      return node.type !== "array" || node.minItems === 0 || node.minItems === 1;
    }
    return true;
  }

  function anthropicRecognises(node, key, sdk) {
    if (sdk === "go") return anthropicGoRecognises(node, key);
    var pythonSdk = sdk === "python";
    switch (key) {
      case "$ref": case "$defs": case "type": case "anyOf": case "oneOf":
      case "allOf": case "description": case "title":
        return true;
      case "enum":
        // Python: `enum = json_schema.pop("enum"); if is_list(enum): keep`.
        // JS has no such clause, so it falls through to the prose demotion.
        return !!pythonSdk;
      case "properties": case "required": case "additionalProperties":
        return node.type === "object";
      case "format":
        return node.type === "string" && !!ANTHROPIC_STRING_FORMATS[node.format];
      case "items":
        return node.type === "array";
      case "minItems":
        return node.type === "array" && (node.minItems === 0 || node.minItems === 1);
      default:
        return false;
    }
  }

  // ---- Anthropic: an array-valued `type` is a DISPATCH MISS, and the two SDKs
  // fail on it in opposite directions ----------------------------------------
  //
  // Measured 2026-08-09 against `@anthropic-ai/sdk@0.116.0` and
  // `anthropic==0.121.0`:
  //
  //   * JS `_transformJSONSchema` dispatches on `type === "object" | "string" |
  //     "array"` — strict equality against a STRING — so an array-valued `type`
  //     matches no branch. The branch that would have copied `properties`,
  //     `items` or `format` never runs, and those keys fall through to the
  //     catch-all that stringifies leftovers into `description`. For
  //     `{type:["object","null"], properties:{…}, required:[…]}` the ENTIRE
  //     subtree becomes one line of prose and the transformer never recurses
  //     into it. No error, no warning. That is a different kind of loss from an
  //     ordinary demotion (#315): it is the structure, not a constraint.
  //   * Python `transform_schema` types `type` as a `Literal` of seven scalars
  //     and ends in `assert_never`, so ANY list raises `AssertionError: Expected
  //     code to be unreachable` — including the one-element `["string"]` and the
  //     canonical nullable spelling `["string","null"]`. The request cannot be
  //     built at all.
  //
  // `anyOf` is the form BOTH accept: the JS transformer maps itself over the
  // variants (so the subtree survives AND is processed properly — a nested
  // `minLength` is demoted at the leaf, which is the correct minimal loss) and
  // the Python transformer passes it through verbatim. Verified on both.
  //
  // Not exotic: our own `--to openai` output creates `type:["object","null"]`
  // for an optional object property (the forced-required rewrite from #311), and
  // `zod-to-json-schema` emits `type:["string","null"]` for a nullable primitive.
  // (Corrected while measuring: Zod v4's native `z.toJSONSchema` and Pydantic
  // v2 both emit `anyOf` instead, so this reaches Anthropic mainly through
  // hand-written / OpenAPI-derived schemas and through our own output — not
  // through those two generators, as I had first assumed.)
  function anthropicTypeBranchKeys(member) {
    if (member === "object") return ["properties", "required"];
    if (member === "array") return ["items", "minItems"];
    if (member === "string") return ["format"];
    return [];
  }

  // What an array-valued `type` costs, per SDK. The Go entry is the loudest of
  // the three and the only one that is not confined to this node.
  var ANTHROPIC_UNION_TYPE_COST = {
    python: "The Python `anthropic` SDK REFUSES TO BUILD the request for any array-valued `type` — " +
      "`transform_schema` types it as a `Literal` of seven scalars and falls through to " +
      "`assert_never`, raising `AssertionError: Expected code to be unreachable`. Even a " +
      "one-element list raises. ",
    go: "The Go SDK loses the ENTIRE DOCUMENT here, not just this node. `transformSchemaMap` " +
      "unmarshals your map into `invopop/jsonschema.Schema`, whose `Type` field is a `string`; " +
      "an array fails to unmarshal and the function `return nil`s, swallowing the error. Both " +
      "`BetaJSONSchemaOutputFormat` and `BetaToolInputSchema` then hand the API a null schema, " +
      "with nothing raised client-side. Measured on anthropic-sdk-go@v1.62.0 — and it fires " +
      "wherever the union is, including inside `$defs`. "
  };

  function normalizeAnthropicUnionType(node, path, ledger, url, sdk) {
    var pythonSdk = sdk !== "js";  // both Python and Go fail on ANY list
    var raw = node.type;
    if (!Array.isArray(raw)) return;
    // `type` beside a combinator: rewriting would have to invent a merge, so the
    // keyword is left visible. But bailing silently is only safe for the JS SDK,
    // which ignores the `type` once it sees `anyOf`. The Python SDK asserts on
    // the LIST before it ever looks at the combinator, so the request still
    // cannot be built — measured: `{type:["string","null"], anyOf:[…]}` raises
    // `AssertionError` there. Say so rather than exit 0 on a schema that throws.
    if (node.anyOf !== undefined || node.oneOf !== undefined || node.allOf !== undefined) {
      if (pythonSdk) {
        ledger.push(entry("!", path,
          "This node has an array-valued `type` (`" + JSON.stringify(raw) + "`) alongside " +
          "`anyOf`/`oneOf`/`allOf`. " + (sdk === "go"
            ? "The Go SDK fails on the list before any of this is interpreted — the unmarshal into " +
              "`invopop/jsonschema.Schema` errors on an array in `Type` and `transformSchemaMap` " +
              "returns nil, so the WHOLE schema is dropped, combinator included."
            : "The Python `anthropic` SDK raises `AssertionError: Expected code to be unreachable` on " +
              "the list REGARDLESS of the combinator — the assert runs before the combinator is " +
              "consulted — so the request cannot be built.") +
          " (The TypeScript SDK ignores the `type` once it sees a combinator, which is why this is " +
          "not a failure there.) Merging these two is a semantic decision only you can make, so drop " +
          "whichever one is redundant.",
          url));
      }
      return;
    }

    var members = [];
    raw.forEach(function (t) { if (members.indexOf(t) === -1) members.push(t); });
    var nonNull = members.filter(function (t) { return t !== "null"; });
    var hasNull = nonNull.length !== members.length;
    var others = Object.keys(node).filter(function (k) { return k !== "type"; });

    // Did the union actually SKIP a branch that would otherwise have run? That
    // is the only thing the JS SDK loses here. The Python SDK loses the whole
    // request whatever the members are, so it always needs the rewrite.
    var skippedBranch = nonNull.length === 1 &&
      anthropicTypeBranchKeys(nonNull[0]).some(function (k) { return node[k] !== undefined; });
    if (!pythonSdk && !skippedBranch) return;

    var before = JSON.stringify(raw);
    var loudly = pythonSdk
      ? ANTHROPIC_UNION_TYPE_COST[sdk]
      : "`@anthropic-ai/sdk` dispatches on `type === \"object\"`/`\"string\"`/`\"array\"` — strict " +
        "equality against a string — so an array-valued `type` matches no branch and the branch " +
        "that would have copied " +
        anthropicTypeBranchKeys(nonNull[0]).map(function (k) { return "`" + k + "`"; }).join("/") +
        " never runs. Those keys are stringified into this node's `description` instead, and the " +
        "transformer never recurses into them — so the whole subtree stops being schema. It does " +
        "not throw and it does not warn. ";

    // Several non-null members WITH keywords attached: there is no safe way to
    // decide which branch each keyword belongs to. Guessing would silently
    // re-attach a constraint to a type it never applied to, so say so instead.
    if (nonNull.length > 1 && others.length > 0) {
      if (pythonSdk) {
        ledger.push(entry("!", path,
          loudly + "This node also carries " +
          others.map(function (k) { return "`" + k + "`"; }).join(", ") +
          ", and with more than one non-null member there is no way to tell which branch each of " +
          "those belongs to — re-attaching them to the wrong type would be a silent semantic " +
          "change, so this is left for you. Rewrite it by hand as `anyOf`, one branch per type, " +
          "with each keyword on the branch it constrains.",
          url));
      }
      return;
    }

    var moved = {};
    others.forEach(function (k) {
      // Annotations are recognised at any node, including an `anyOf` node, so
      // they stay where the reader put them.
      if (k === "description" || k === "title") return;
      moved[k] = node[k];
      delete node[k];
    });

    var shape;
    if (nonNull.length === 0) {
      // `["null"]` — the scalar spelling is accepted verbatim by both SDKs.
      node.type = "null";
      Object.keys(moved).forEach(function (k) { node[k] = moved[k]; });
      shape = "`type: \"null\"`";
    } else if (nonNull.length === 1 && !hasNull) {
      // `["string"]` — a one-element list means exactly the scalar.
      node.type = nonNull[0];
      Object.keys(moved).forEach(function (k) { node[k] = moved[k]; });
      shape = "`type: " + JSON.stringify(nonNull[0]) + "`";
    } else if (nonNull.length === 1) {
      var branch = { type: nonNull[0] };
      Object.keys(moved).forEach(function (k) { branch[k] = moved[k]; });
      delete node.type;
      node.anyOf = [branch, { type: "null" }];
      shape = "`anyOf: [{type: " + JSON.stringify(nonNull[0]) + ", …}, {type: \"null\"}]`";
    } else {
      delete node.type;
      node.anyOf = members.map(function (t) { return { type: t }; });
      shape = "`anyOf` with one branch per type";
    }

    ledger.push(entry("~", path,
      "Rewrote `type: " + before + "` to " + shape + ". " + loudly +
      "`anyOf` is the form ALL THREE SDKs handle: the TypeScript transformer maps itself over the " +
      "variants, so the subtree survives and is processed properly; the Python transformer passes " +
      "`anyOf` through verbatim; and the Go transformer recurses into the variants (`AnyOf` is a " +
      "`[]*Schema`, so it unmarshals cleanly where an array in `type` does not). Lossless — every " +
      "keyword moves onto the branch it already " +
      "constrained (`properties` never applied to `null` in the first place), and `description`/" +
      "`title` stay where they are because they are recognised at any node.",
      url));
  }

  // A node with no `type` (and no anyOf/oneOf/allOf/$ref) throws on Path O.
  // When the node carries an `enum` or `const` the intended type is recoverable
  // losslessly, so add it rather than making the user do it.
  function inferTypeFromValues(values) {
    var types = {};
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v === null) types["null"] = 1;
      else if (Array.isArray(v)) types["array"] = 1;
      else if (typeof v === "object") types["object"] = 1;
      else if (typeof v === "number") types[Number.isInteger(v) ? "integer" : "number"] = 1;
      else if (typeof v === "boolean") types["boolean"] = 1;
      else if (typeof v === "string") types["string"] = 1;
      else return null;
    }
    var keys = Object.keys(types);
    if (keys.length === 1) return keys[0];
    if (keys.length === 2 && types["integer"] && types["number"]) return "number";
    return null;
  }

  // Anthropic is a TWO-PATH provider and the switch is not in the schema — it
  // is WHICH REQUEST FIELD you use (#315). Which one you are on is a fact only
  // the caller has, so it is an explicit target, never inferred (#319):
  //
  //   `--to anthropic`       -> tools[].input_schema. NO transform runs at all.
  //                             Re-verified 2026-08-09 against
  //                             @anthropic-ai/sdk@0.116.0: `betaTool()` returns
  //                             `input_schema` byte-identical, and the ONLY way
  //                             to make it throw is a root that is not
  //                             `type: "object"`. A tuple, a `definitions` bag,
  //                             a typeless nested node and a non-exclusive
  //                             `oneOf` all pass through untouched.
  //   `--to anthropic-json`  -> output_format:{type:"json_schema"}. Full rebuild
  //                             by `lib/transform-json-schema`, which demotes
  //                             every unrecognised keyword to prose.
  //
  // Conflating them is a false CI failure for the larger audience: Instructor's
  // default Anthropic mode is ANTHROPIC_TOOLS, so an ordinary Pydantic model
  // (tuple field, maxLength, $defs) is perfectly valid on the wire while the
  // old single target exited 1 and proposed a lossy tuple collapse.
  function toAnthropic(schema, outputFormatPath, sdk) {
    sdk = sdk || "js";
    var goSdk = sdk === "go";
    var pythonSdk = sdk === "python";
    var s = clone(schema);
    var ledger = [];
    var url = outputFormatPath ? DOCS["anthropic-json"] : DOCS.anthropic;
    // On the Go SDK the tools path runs the SAME transform, so the sentence
    // every other Anthropic message ends with — "it survives on
    // tools[].input_schema" — is false there and must not be printed.
    var VERBATIM_ESCAPE = goSdk
      ? " Note there is no verbatim escape hatch in Go: `BetaToolInputSchema` calls the same " +
        "`transformSchemaMap` as `BetaJSONSchemaOutputFormat`, so `--to anthropic` (which models the " +
        "TypeScript/Python tools path, where no transform runs) does NOT describe your client."
      : " It IS sent as-is on the `tools[].input_schema` path, so this is kept, not stripped.";

    // Both paths: nothing on Anthropic's side ever RESOLVES a `$ref`, so a
    // pointer in a spelling that does not resolve locally is dead either way.
    // Rewriting is conditional and lossless (#320) — it only fires when the
    // target is really there.
    s = normalizeRefSpelling(s, ledger, url, outputFormatPath
      ? "Anthropic's transformer passes a `$ref` through verbatim without resolving or validating it, " +
        "so a mis-spelled pointer reaches the model dangling rather than erroring."
      : "This path sends the schema verbatim — nothing resolves or validates a `$ref` — so a pointer " +
        "in a spelling that does not resolve locally reaches the model dangling, with no error.");

    // A boolean subschema is the FOURTH thing this vendor's three SDKs disagree
    // about, and the disagreement is measured, not ported:
    //   TypeScript `transformJSONSchema`  -> THROWS "JSON schema must have a type
    //                                        defined if anyOf/oneOf/allOf are not
    //                                        used" (control: the same schema with
    //                                        `{"type":"string"}` in that slot is
    //                                        accepted, so the boolean is the cause)
    //   Go `BetaJSONSchemaOutputFormat`
    //      and `BetaToolInputSchema`      -> preserved VERBATIM, both surfaces
    //   TypeScript `betaTool`             -> preserved verbatim (no transform runs)
    // The Python client was not probed for this shape, so nothing is claimed for
    // `--to anthropic-json-python` and its behaviour is left unchanged.
    if (outputFormatPath) {
      findBooleanSubschemas(s).forEach(function (h) {
        if (goSdk) {
          ledger.push(entry("=", h.path,
            "This is a boolean subschema (`" + h.value + "`), and the Go SDK keeps it — measured " +
            "verbatim through both `BetaJSONSchemaOutputFormat` and `BetaToolInputSchema` on " +
            "anthropic-sdk-go@v1.62.0. Nothing to fix. Worth knowing only because the clients " +
            "differ: the TypeScript `output_format` transformer THROWS on the same bytes, and " +
            "`--to openai` blocks it outright.",
            url, true));
          return;
        }
        if (pythonSdk) return;   // not probed for this shape — claim nothing
        ledger.push(entry("!", h.path,
          booleanSubschemaMessage(h.value,
            "The TypeScript `output_format` transformer rejects it: `transformJSONSchema` throws " +
            "`JSON schema must have a type defined if anyOf/oneOf/allOf are not used`, because a " +
            "boolean carries no `type` for it to dispatch on." + VERBATIM_ESCAPE),
          url));
      });

      // `definitions` is draft-07; the transformer only knows `$defs`. Left
      // alone it is not merely ignored — it is stringified into the root
      // `description` and every `#/definitions/...` pointer is left dangling.
      s = normalizeDefs(s, ledger, url, goSdk
        ? "Renamed draft-07 `definitions` to `$defs` and repointed every `$ref`. The Go SDK does not " +
          "merely ignore a `definitions` bag — `invopop/jsonschema.Schema` has no field for that " +
          "spelling, so the whole bag is dropped during the unmarshal inside `transformSchemaMap`, " +
          "silently, leaving every `#/definitions/...` pointer dangling with nothing to resolve to. " +
          "Measured: `{$ref:\"#/definitions/T\", definitions:{...}}` nested under a property comes " +
          "back as `{\"$ref\":\"#/definitions/T\"}` alone. This is the default output shape of " +
          "`zod-to-json-schema`."
        : "Renamed draft-07 `definitions` to `$defs` and repointed every `$ref`. Anthropic's " +
        "structured-output transformer only reads `$defs`; a `definitions` bag is not ignored, it is " +
        "stringified into the root `description` while every `#/definitions/...` pointer is left dangling.");
    }

    // A root `$ref` breaks BOTH paths, but for different reasons — so the fix
    // is shared and the explanation is not.
    //
    // On the structured-output path this is the ONE place the two SDKs disagree
    // about the shape of the output (the other, `enum`, only changes a warning).
    // The Python transformer pops `$defs` BEFORE its `$ref` early-return, with a
    // source comment naming exactly this case, so `{$ref, $defs}` survives intact
    // and needs no edit. The JS transformer returns first and drops the bag,
    // leaving a dangling pointer with the whole schema gone and no error raised.
    // Measured, not inferred — and note the draft-07 spelling `{$ref, definitions}`
    // is destroyed by BOTH, which is why the `definitions` -> `$defs` rename above
    // is unconditional and this skip is not.
    if (outputFormatPath && pythonSdk && rootRefResolvesInDefs(s)) {
      ledger.push(entry("=", "root",
        "Left the root `$ref` (`" + s.$ref + "`) alone. The Python `anthropic` SDK calls " +
        "`transform_schema()` with no root-type guard, and that function pops `$defs` BEFORE its " +
        "`$ref` early-return, so the definition travels with the pointer and the schema arrives " +
        "whole. This is the one case where the two SDKs produce different SCHEMAS rather than " +
        "different warnings — but note the TypeScript failure is LOUD, not silent: both public " +
        "helpers (`jsonSchemaOutputFormat`, `betaJSONSchemaOutputFormat`) reject a root `$ref` " +
        "outright with \"JSON schema must be an object, but got undefined\", because a `$ref` root " +
        "has no `type`. (Only the internal `transformJSONSchema`, called directly, loses `$defs` " +
        "quietly.) So if a TypeScript service also sends this schema it will fail fast rather than " +
        "mis-send — run `--to anthropic-json` and take its edit.",
        url, true));
    } else {
      s = inlineRootRef(s, ledger, url, (outputFormatPath && goSdk)
        ? "A root `$ref` costs you the entire schema on the Go SDK, silently. `transformSchema` " +
          "starts with `if s.Ref != \"\" { *s = jsonschema.Schema{Ref: s.Ref}; return }` — every " +
          "sibling is discarded, `$defs` included, and neither `BetaJSONSchemaOutputFormat` nor " +
          "`BetaToolInputSchema` has a root-type guard to catch it, so what reaches the API is a lone " +
          "dangling pointer with no error raised. (The TypeScript helpers at least throw \"JSON schema " +
          "must be an object\"; the Python SDK pops `$defs` first and survives.) Inlining fixes it on " +
          "all three. `{$ref, $defs}` from Pydantic's `RootModel` and `{$ref, definitions}` from " +
          "zod-to-json-schema are the two shapes that land here."
        : outputFormatPath
        ? "A root `$ref` has no `type`, and `@anthropic-ai/sdk`'s public helpers " +
          "(`jsonSchemaOutputFormat`, `betaJSONSchemaOutputFormat`) reject that outright: \"JSON " +
          "schema must be an object, but got undefined\". Call the internal `transformJSONSchema` " +
          "directly instead and it fails the other way — it returns as soon as it sees the `$ref` " +
          "and drops `$defs`, leaving a dangling pointer with the whole schema gone and no error. " +
          "Inlining fixes both. `{$ref, $defs}` from Pydantic's `RootModel` and `{$ref, definitions}` " +
          "from zod-to-json-schema are the two shapes that land here. (The Python SDK has no root-type " +
          "guard and keeps `$defs`, so it accepts the first shape — but the draft-07 `definitions` " +
          "spelling is lost there too.)"
        : "A root `$ref` has no `type` of its own, and `betaTool()` throws \"JSON schema for tool ... " +
          "must be an object, but got undefined\" on any root that is not `type: \"object\"`. Inlining " +
          "the referenced definition gives the root its object type back. (Measured against " +
          "@anthropic-ai/sdk@0.116.0.)");
    }

    if (outputFormatPath) {
      // The same early return means `$ref` siblings are dropped outright — not
      // even demoted to prose, which is how other unknown keywords survive.
      s = resolveRefSiblings(s, ledger, url,
        "Anthropic's transformer returns immediately on `$ref` and drops every sibling key silently — " +
        "a `description` next to a `$ref` simply vanishes rather than being demoted to prose",
        "Anthropic's transformer drops silently");
    }

    if (!s.type && isObjectSchema(s)) {
      s.type = "object";
      ledger.push(entry("+", "root",
        "Added `type: object` at the root. Both Anthropic paths require it: `betaTool()` throws " +
        "unless `input_schema.type === \"object\"`, and `jsonSchemaOutputFormat()` throws " +
        "\"JSON schema must be an object\".",
        url));
    } else if (s.type && s.type !== "object") {
      ledger.push(entry("!", "root",
        "The root must be an object on BOTH Anthropic paths — `betaTool()` and " +
        "`jsonSchemaOutputFormat()` each throw on a non-object root. Wrap this schema in an object.",
        url));
    }

    if (!outputFormatPath) {
      // Nothing else is a defect here, because nothing else runs. Saying so is
      // the whole value of this target — the alternative is a gate that fails
      // on a payload the vendor accepts byte-for-byte (#312/#317).
      ledger.push(entry("=", "root",
        "On `tools[].input_schema` Anthropic applies NO transform: the schema below goes on the wire " +
        "byte-identical, so tuples (`prefixItems`), `maxLength`/`minimum`, `format`, a `definitions` " +
        "bag and a non-exclusive `oneOf` all survive intact — none of them need fixing here. What is " +
        "NOT automatic is enforcement: set `strict: true` on the TOOL definition (not inside the " +
        "schema) — the SDK documents it as \"guarantees schema validation on tool names and inputs\". " +
        "Without it the schema is guidance the model can violate, so keep validating the response.",
        url, true));
      ledger.push(entry("=", "root",
        "If you are actually using the structured-output path (`output_format` / `output_config`: " +
        "`{type: \"json_schema\"}`) rather than a tool, this is the WRONG target — that path rebuilds " +
        "the schema and demotes every keyword it does not recognise into `description` prose. Re-run " +
        "with `--to anthropic-json` (TypeScript SDK) or `--to anthropic-json-python` (Python SDK); " +
        "they differ on `enum` and on a root `$ref`.",
        url, true));
      ledger.push(entry("=", "root",
        "And if your client is `anthropic-sdk-go`, this target is wrong even for tools. Go is the one " +
        "SDK where `tools[].input_schema` is NOT verbatim: `BetaToolInputSchema` calls the same " +
        "`transformSchemaMap` as `BetaJSONSchemaOutputFormat` (schemautil.go), so both surfaces get " +
        "the rebuild. Use `--to anthropic-go`.",
        url, true));
      return { schema: s, ledger: ledger };
    }

    // Pre-pass, deliberately BEFORE the main walk: an array-valued `type` makes
    // the transformer skip its per-type branch, so the demotion pass below would
    // otherwise report a gutted subtree as an ordinary unenforced keyword. The
    // root is left out on purpose — a union root is a genuine blocker (both
    // paths require `type === "object"`) and is already reported as one above.
    // An open map survives the tools path untouched, so this is not a defect of
    // the schema — it is a defect of THIS path, and it is silent: the
    // transformer rebuilds the node as `{"type":"object","properties":{},
    // "additionalProperties":false}`, i.e. a field that can only ever be `{}`.
    // Advisory, never a gate failure, because the request still returns 200 —
    // that is the established policy for everything this path destroys.
    walk(s, "root", function (node, path) {
      if (!isOpenMap(node)) return;
      // Measured: the Go SDK is the only one of the three that gets this right.
      // `transformSchema`'s object branch has an explicit dictionary clause —
      // no `properties`, `additionalProperties` non-nil -> preserve and recurse
      // into the value schema. Reporting a loss here would be the
      // stricter-than-the-vendor bug this project has shipped four times.
      if (goSdk) {
        ledger.push(entry("=", path,
          "This is an open map (`additionalProperties` with no `properties`), and the Go SDK keeps it " +
          "— `transformSchema` has an explicit dictionary clause that preserves `additionalProperties` " +
          "and recurses into the value schema. Nothing to fix. Worth knowing only because the other " +
          "two paths differ: `--to anthropic-json` (TypeScript) rebuilds this node as " +
          "`{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}`, so the field can " +
          "never be populated, and `--to openai` blocks it outright.",
          url, true));
        return;
      }
      ledger.push(entry("=", path,
        "This is an open map (`additionalProperties` with no `properties`). The " +
        "`output_format` transformer discards your `additionalProperties` and forces " +
        "`false`, leaving `{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}` " +
        "— an object whose only legal value is `{}`, so the model can never populate this " +
        "field. No error is raised. " + OPEN_MAP_REMEDY +
        " It survives intact on `tools[].input_schema` (`--to anthropic`), which applies no " +
        "transform at all.",
        url, true));
    });

    walk(s, "root", function (node, path) {
      if (path === "root") return;
      normalizeAnthropicUnionType(node, path, ledger, url, sdk);
    });

    var demoted = [];
    walk(s, "root", function (node, path) {
      // Tuples: `items`-as-array and `prefixItems` both reach the transformer
      // with no `type` and throw. The error text ("must have a type defined")
      // points nowhere near the real cause, so say what it is.
      if (normalizeTuple(node, path, ledger, url, goSdk
            ? "The Go SDK has no tuple form, and the two spellings fail differently — the draft-07 " +
              "one catastrophically. Array-form `items: [A, B]` cannot be unmarshalled into " +
              "`invopop/jsonschema.Schema` at all (its `Items` field is a `*Schema`), so " +
              "`transformSchemaMap` returns nil and the WHOLE document is dropped, swallowing the " +
              "error — measured on anthropic-sdk-go@v1.62.0. A bare `prefixItems` survives the " +
              "unmarshal but is not in `supportedSchemaKeys`, so it is demoted to prose, leaving an " +
              "array with no item schema and no length at all."
            : "Anthropic's structured-output transformer has no tuple form, and the two spellings fail " +
            "differently: array-form `items` (and `prefixItems` next to `items: false`) makes it throw " +
            "\"JSON schema must have a type defined if anyOf/oneOf/allOf are not used\" — a message " +
            "that never mentions tuples — while a bare `prefixItems` is quietly demoted to prose, " +
            "leaving an array with no item schema and no length at all.",
            goSdk
            ? "The Go SDK has no tuple form — array-form `items` makes the whole document come back " +
              "nil, and a bare `prefixItems` leaves an array with no item schema at all — so this " +
              "recovers the element type, which is the part that was being lost outright. The length " +
              "is a weaker guarantee here: `minItems` survives only when it is 0 or 1, and `maxItems` " +
              "is not in `supportedSchemaKeys` at all, so a fixed length of 2+ reaches the model as " +
              "prose only (and, because of the pointer-formatting bug, as a memory address)."
            : "Anthropic's transformer has no tuple form — it would either throw or, for a bare " +
            "`prefixItems`, leave an array with no item schema at all — so this recovers the element " +
            "type, which is the part that was being lost outright. The length is a weaker guarantee " +
            "here: on the `output_format` path `minItems` survives only when it is 0 or 1 and " +
            "`maxItems` never does, so a fixed length of 2+ reaches the model as prose only. On the " +
            "`tools[].input_schema` path both are sent as-is and do constrain.")) {
        return;
      }

      // `oneOf` is rewritten to `anyOf` by the transformer. Do it here so the
      // output matches the wire payload instead of differing from it.
      if (Array.isArray(node.oneOf) && !Array.isArray(node.anyOf)) {
        node.anyOf = node.oneOf;
        delete node.oneOf;
        ledger.push(entry("~", path,
          "Rewrote `oneOf` to `anyOf` — the transformer does this itself, so this is what actually " +
          "goes on the wire. Note the semantics differ: `oneOf` means exactly one branch matches, " +
          "`anyOf` means at least one.",
          url));
        // Anthropic and OpenAI diverge here, so the rule is NOT ported between
        // them (#314). `transformJSONSchema` maps oneOf -> anyOf with NO
        // exclusivity proof, so when branches can both match the constraint is
        // genuinely weakened on the wire — by the vendor, not by us. OpenAI's
        // transformer throws in that case; Anthropic's does not, so this is a
        // warning, never a gate failure.
        if (!oneOfProvablyExclusive(node.anyOf, s)) {
          ledger.push(entry("!", path,
            "These `oneOf` branches are not provably mutually exclusive, so \"exactly one\" becomes " +
            "\"at least one\" on the wire. Anthropic's own transformer performs this rewrite " +
            "unconditionally, so the widening happens with or without this tool — but nothing warns " +
            "you. If exclusivity matters, add a discriminator property with distinct literal values.",
            url, true));
        }
      } else if (Array.isArray(node.oneOf) && Array.isArray(node.anyOf)) {
        // `_transformJSONSchema` pops both and takes `anyOf` first, so a
        // co-existing `oneOf` is discarded outright — silently, like every
        // other Anthropic loss on this path.
        ledger.push(entry("!", path,
          "This node has both `anyOf` and `oneOf`. Anthropic's transformer reads `anyOf` first and " +
          "DISCARDS `oneOf` entirely — no error, no warning, the constraint is simply gone. Merge " +
          "them into one `anyOf` so what you send is what you meant.",
          url, true));
      }

      // No `type` and nothing to stand in for it -> throws on Path O.
      if (node.type === undefined && !node.$ref &&
          !Array.isArray(node.anyOf) && !Array.isArray(node.oneOf) && !Array.isArray(node.allOf)) {
        var vals = Array.isArray(node.enum) ? node.enum
                 : (node.const !== undefined ? [node.const] : null);
        var inferred = vals ? inferTypeFromValues(vals) : null;
        if (inferred) {
          node.type = inferred;
          ledger.push(entry("+", path,
            "Added `type: " + inferred + "`, inferred from the " +
            (Array.isArray(node.enum) ? "`enum` members" : "`const` value") + ". " + (goSdk
              ? "The Go SDK treats a typeless node as unusable, but it does not say so: " +
                "`transformSchema` overwrites it with the zero `jsonschema.Schema`, which marshals as " +
                "the literal JSON `true` — a match-anything schema. (A bare `enum`/`const` node is " +
                "actually spared, because those count as shape information, but adding the `type` " +
                "makes the intent explicit and is lossless.)"
              : "Without a `type` the transformer throws \"JSON schema must have a type defined if " +
                "anyOf/oneOf/allOf are not used\" — a bare enum is the most common way to hit that."),
            url));
        } else {
          ledger.push(entry("!", path, goSdk
            ? "This node has no `type` and no `anyOf`/`oneOf`/`allOf`/`enum`/`const`, and the Go SDK " +
              "does not reject it — it REPLACES it with the literal JSON `true`, a schema that " +
              "matches anything. `transformSchema` bails on a node it cannot key on by assigning the " +
              "zero `jsonschema.Schema`, and `MarshalJSON` renders that as `true`. Measured: a node " +
              "carrying only `{\"description\": \"...\"}` comes back as `true`, description included. " +
              "Give it an explicit `type`."
            : "This node has no `type` and no `anyOf`/`oneOf`/`allOf`, so Anthropic's " +
              "structured-output transformer throws \"JSON schema must have a type defined if " +
              "anyOf/oneOf/allOf are not used\". Give it an explicit `type`.",
            url));
        }
      }

      // Everything the transformer does not recognise survives only as prose.
      Object.keys(node).forEach(function (k) {
        if (anthropicRecognises(node, k, sdk)) return;
        if (k === "$schema" && path !== "root") return;
        demoted.push({ path: path, key: k, node: node });
      });

      // The SDKs disagree about `enum`, so whichever target you picked, say what
      // the OTHER one would do with this exact node. Advisory only: an `enum` is
      // kept either way, so it can never be a gate failure (#317).
      // On the JS target `enum` is already reported by the demotion pass below,
      // so only the Python target needs a note here — otherwise the same node
      // would be described twice in one ledger.
      if (goSdk && (Array.isArray(node.enum) || node.pattern !== undefined || node.const !== undefined)) {
        var kept = ["enum", "const", "pattern"].filter(function (k) {
          return k === "enum" ? Array.isArray(node.enum) : node[k] !== undefined;
        });
        ledger.push(entry("=", path,
          kept.map(function (k) { return "`" + k + "`"; }).join(" and ") +
          " survive here — `anthropic-sdk-go`'s `supportedSchemaKeys` lists all three, so they reach " +
          "the API rather than this node's `description`. Worth knowing if this schema is shared: the " +
          "vendor's three SDKs have three different supported-key sets at the same vendor. " +
          "`@anthropic-ai/sdk` demotes all three to prose; `anthropic` (Python) keeps `enum` only; " +
          "`pattern` is kept by Go alone. Check the other two with `--to anthropic-json` and " +
          "`--to anthropic-json-python`.",
          url, true));
      }

      if (pythonSdk && Array.isArray(node.enum)) {
        ledger.push(entry("=", path,
          "`enum` IS enforced here — the Python `anthropic` SDK preserves it verbatim. Worth knowing " +
          "if this schema is shared: the TypeScript SDK at the SAME version number does not. " +
          "`@anthropic-ai/sdk@0.116.0` stringifies it into this node's `description`, so a service " +
          "sending this file from TypeScript gets an unenforced enum. Check with `--to anthropic-json`.",
          url, true));
      }
    });

    // These are reported, never stripped. Stripping would destroy a constraint
    // that IS still enforced on the tools path and buys nothing on either —
    // the #314 rule: read the provider's error policy before porting a strip.
    demoted.forEach(function (d) {
      // Go splits "unsupported" into two very different outcomes, and the worse
      // one is invisible: a keyword `invopop/jsonschema` does not model is
      // dropped by `Schema.UnmarshalJSON` before `transformSchema` runs, so it
      // never reaches the extras-to-description path at all.
      if (goSdk && !GO_INVOPOP_MODELLED[d.key]) {
        ledger.push(entry("=", d.path,
          "`" + d.key + "` is DELETED without a trace by the Go SDK — not demoted to prose like the " +
          "keywords below it. `transformSchemaMap` round-trips your map through " +
          "`invopop/jsonschema.Schema`, whose `UnmarshalJSON` is a plain alias unmarshal with no " +
          "catch-all, so a keyword that library does not model is gone before Anthropic's own " +
          "transform runs and cannot be appended to any `description`. Nothing is logged. If this " +
          "keyword carries meaning for a downstream consumer, keep it somewhere other than the " +
          "schema you hand the SDK." + VERBATIM_ESCAPE,
          url, true));
        return;
      }
      if (goSdk && GO_POINTER_FORMATTED[d.key]) {
        ledger.push(entry("=", d.path,
          "`" + d.key + "` is not enforced by the Go SDK — and it does not even arrive as readable " +
          "prose. `formatExtraValue` (schemautil.go) dereferences pointers with reflect but then " +
          "formats the ORIGINAL value, and `invopop` declares this field as `*uint64`, so this node's " +
          "`description` gets a hexadecimal address: `{" + d.key + ": 0x162d307bcc80}`. The model is " +
          "told a memory address. Measured on anthropic-sdk-go@v1.62.0; reported upstream. " +
          "(`minItems` is the one length keyword that escapes this — the array branch dereferences it " +
          "explicitly before demoting.) Kept here, not stripped, because your value is the thing that " +
          "should have been quoted." + VERBATIM_ESCAPE,
          url, true));
        return;
      }
      var extra = "";
      if (d.key === "format") {
        extra = " Only these 10 `format` values survive: " +
          Object.keys(ANTHROPIC_STRING_FORMATS).join(", ") + ".";
      } else if (d.key === "minItems") {
        extra = " `minItems` survives only when it is exactly 0 or 1; any other value is demoted.";
      } else if (d.key === "additionalProperties") {
        extra = " On the output_format path the transformer discards your value and forces " +
          "`additionalProperties: false` regardless; on the tools path your value is sent as-is.";
      } else if (d.key === "enum") {
        // The one keyword where the vendor's two SDKs disagree about enforcement.
        extra = " This one is SDK-specific: the Python `anthropic` SDK PRESERVES `enum` on this same " +
          "path, so it really is enforced there. Not a version skew you can upgrade past — measured " +
          "identical on Python 0.110.0/0.116.0/0.121.0 against `@anthropic-ai/sdk@0.116.0`, i.e. the " +
          "same version string, opposite behaviour. If your request is built in Python, re-run with " +
          "`--to anthropic-json-python`.";
      }
      ledger.push(entry("=", d.path,
        "`" + d.key + "` is NOT enforced" + (goSdk
          ? " by the Go SDK — " + (ANTHROPIC_GO_SUPPORTED[d.key]
              ? "`supportedSchemaKeys` lists it, but `transformSchema`'s per-type branch demotes this " +
                "particular value anyway, so"
              : "it is not in `supportedSchemaKeys`, so")
          : " on the `output_format` (structured output) path. Anthropic's transformer does not " +
            "recognise it, so") +
        " it is appended to this node's `description` as text — the model is told about it but " +
        "nothing validates it." + VERBATIM_ESCAPE + extra,
        url, true));
    });

    var hasSubstantive = ledger.some(function (e) { return !e.advisory && e.op !== "="; });
    if (!hasSubstantive) {
      ledger.push(entry("=", "root", goSdk
        ? "No structural changes needed for `anthropic-sdk-go` — but read the notes above, because " +
          "they are the point: `transformSchemaMap` accepts this schema and then quietly demotes what " +
          "`supportedSchemaKeys` does not list, and deletes outright what `invopop/jsonschema` does " +
          "not model. Both of Go's helpers run it, so there is no verbatim surface to fall back to."
        : "No structural changes needed for the `output_format` path — but read the unenforced-keyword " +
        "notes above, because they are the point: the transformer accepts this schema and then " +
        "silently demotes what it does not recognise to `description` prose. If you are sending the " +
        "schema as `tools[].input_schema` instead, use `--to anthropic`, where it goes on the wire " +
        "verbatim and none of those notes apply.",
        url));
    }
    return { schema: s, ledger: ledger };
  }

  // ---- Gemini: TWO paths, and `$schema` is the switch between them ----------
  //
  // Verified 2026-08-09 against the vendor SDK `@google/genai@2.16.0`, not the
  // doc — the doc describes only the narrow path and never mentions the switch.
  //
  //   `GoogleGenAI.maybeMoveToResponseJsonSchema()`: if the schema handed to
  //   `responseSchema` contains a `$schema` key, the SDK MOVES it to the
  //   `responseJsonSchema` request field and sends it VERBATIM (`tJsonSchema`
  //   is the identity function). That path is full JSON Schema — `$ref`,
  //   `$defs` and recursion all survive to the wire.
  //
  //   With no `$schema` key it goes to `responseSchema`, which is the narrow
  //   `Schema` proto: `processJsonSchema()` upper-cases `type` and drops
  //   `additionalProperties`.
  //
  // This matters because `zod-to-json-schema` ALWAYS emits `$schema` and
  // `pydantic.model_json_schema()` never does — so the two generators our
  // audience uses land on opposite paths by default.
  //
  // GEMINI_ALLOWED below is the field list of the SDK's own exported `Schema`
  // interface (dist/genai.d.ts) — the vendor's encoding of what the proto
  // accepts. It is NOT the SDK's pass-through behaviour: `processJsonSchema`
  // is close to an identity function and forwards unknown keywords untouched,
  // so "the SDK didn't strip it" proves nothing here. (Contrast OpenAI, where
  // the transformer throws and pass-through IS the signal — see #312.)
  //
  // Corrections this list encodes, both directions:
  //   ADDED   pattern, minLength, maxLength, minProperties, maxProperties,
  //           default, example — all in the vendor `Schema` type, all of which
  //           the previous doc-derived list deleted. Pydantic emits
  //           minLength/maxLength/pattern/title constantly.
  //   REMOVED prefixItems — absent from `Schema` (same false pass as the
  //           OpenAI `prefixItems` bug fixed in the previous cycle).
  //   REMOVED additionalProperties — absent from `Schema`, and the SDK
  //           explicitly skips it ("not included in JSONSchema, skipping it").
  var GEMINI_ALLOWED = {
    "anyOf": 1, "default": 1, "description": 1, "enum": 1, "example": 1,
    "format": 1, "items": 1, "maxItems": 1, "maxLength": 1, "maxProperties": 1,
    "maximum": 1, "minItems": 1, "minLength": 1, "minProperties": 1,
    "minimum": 1, "nullable": 1, "pattern": 1, "properties": 1,
    "propertyOrdering": 1, "required": 1, "title": 1, "type": 1
  };
  var GEMINI_STRING_FORMATS = { "date-time": 1, "date": 1, "time": 1, "enum": 1 };

  // The OTHER path. `google-genai` (Python) 2.17.0 documents the backend's
  // accepted set for `response_json_schema` verbatim on the field itself:
  //   "While the full JSON Schema may be sent, not all features are supported.
  //    Specifically, only the following properties are supported: $id, $defs,
  //    $ref, $anchor, type, format, title, description, enum (for strings and
  //    numbers), items, prefixItems, minItems, maxItems, minimum, maximum,
  //    anyOf, oneOf (interpreted the same as anyOf), properties,
  //    additionalProperties, required. The non-standard propertyOrdering
  //    property may also be set."
  //
  // So "the JS SDK sends it verbatim" describes the TRANSPORT, not acceptance.
  // Both SDKs' JSON-Schema path is a literal identity function (`t_json_schema`
  // in Python, `tJsonSchema` in JS), so — unlike the `responseSchema` path,
  // where `types.Schema` is `extra="forbid"` and therefore a hard oracle — the
  // vendor gives NO machine verdict here. The field text is the only source,
  // and it says the full schema MAY BE SENT: unsupported keywords are ignored,
  // not rejected. That is why unsupported keywords are kept + flagged advisory
  // below instead of stripped. Two clauses ARE phrased as prohibitions, and
  // those are treated as real findings: a `$ref` sub-schema may carry no
  // non-`$` siblings, and cyclic refs may only be used in non-required
  // properties.
  //
  // The two paths are partly COMPLEMENTARY, and neither is a superset:
  //   only responseSchema     : pattern, minLength, maxLength, minProperties,
  //                             maxProperties, default, example, nullable
  //   only responseJsonSchema : $ref, $defs, $anchor, $id, prefixItems,
  //                             additionalProperties, oneOf
  var GEMINI_JSON_ALLOWED = {
    "$schema": 1, "$id": 1, "$defs": 1, "$ref": 1, "$anchor": 1,
    "type": 1, "format": 1, "title": 1, "description": 1, "enum": 1,
    "items": 1, "prefixItems": 1, "minItems": 1, "maxItems": 1,
    "minimum": 1, "maximum": 1, "anyOf": 1, "oneOf": 1, "properties": 1,
    "additionalProperties": 1, "required": 1, "propertyOrdering": 1
  };

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
        " and dropped the `$defs`/`definitions` block — `@google/genai`'s `Schema` type has " +
        "no `$ref`, so inlining is the form that works on this path. (Keep a top-level " +
        "`$schema` instead and you stay on `responseJsonSchema`, where `$ref`/`$defs` are accepted.) " +
        "What an un-inlined `$ref` costs depends on your client: JS forwards it and the API " +
        "answers `Unknown name \"$defs\" … Cannot find field`; Python refuses to build the " +
        "request; Go DROPS IT SILENTLY — `json.Unmarshal` into `genai.Schema` returns nil " +
        "error and the referencing property becomes `{}`, so the call succeeds with the " +
        "referenced model no longer described at all.",
        docUrl));
    }
    recursive.forEach(function (name) {
      ledger.push(entry("!", "root",
        "`" + name + "` is recursive (it references itself). Gemini cannot express a recursive schema — flatten it to a fixed depth before sending.",
        docUrl));
    });
    return result;
  }

  // Paths of `required` properties whose type is cyclic. Gemini's JSON-Schema
  // path unrolls cycles only inside NON-required properties, so a recursive
  // required field is a human fix, not something we can rewrite.
  function cyclicRequired(s) {
    var defs = {};
    [s.$defs, s.definitions].forEach(function (bag) {
      if (isPlainObject(bag)) Object.keys(bag).forEach(function (k) { defs[k] = bag[k]; });
    });
    if (!Object.keys(defs).length) return [];
    var out = [];

    function refName(node) {
      var m = isPlainObject(node) && typeof node.$ref === "string"
        ? /^#\/(?:\$defs|definitions)\/(.+)$/.exec(node.$ref) : null;
      return m ? m[1] : null;
    }

    function reachesCycle(node, stack) {
      if (Array.isArray(node)) {
        return node.some(function (n) { return reachesCycle(n, stack); });
      }
      if (!isPlainObject(node)) return false;
      var name = refName(node);
      if (name) {
        if (stack.indexOf(name) !== -1) return true;
        if (!defs[name]) return false;
        return reachesCycle(defs[name], stack.concat([name]));
      }
      return Object.keys(node).some(function (k) { return reachesCycle(node[k], stack); });
    }

    function scan(node, path, seen) {
      if (!isPlainObject(node)) return;
      if (isPlainObject(node.properties) && Array.isArray(node.required)) {
        node.required.forEach(function (k) {
          var child = node.properties[k];
          if (child && reachesCycle(child, [])) out.push(path + "." + k);
        });
      }
      if (isPlainObject(node.properties)) {
        Object.keys(node.properties).forEach(function (k) {
          scan(node.properties[k], path + "." + k, seen);
        });
      }
      if (isPlainObject(node.items)) scan(node.items, path + "[]", seen);
      var n = refName(node);
      if (n && defs[n] && seen.indexOf(n) === -1) scan(defs[n], path, seen.concat([n]));
    }

    scan(s, "root", []);
    Object.keys(defs).forEach(function (k) { scan(defs[k], "$defs." + k, [k]); });
    // de-dupe
    return out.filter(function (v, i) { return out.indexOf(v) === i; });
  }

  // `jsonPath` selects WHICH Gemini request field this schema is destined for:
  //   false -> `responseSchema`     (the narrow `Schema` proto)  = `--to gemini`
  //   true  -> `responseJsonSchema` (full JSON Schema)      = `--to gemini-json`
  //
  // It is a parameter and not an inference, and that is the whole point. #314
  // found that `@google/genai` routes on a top-level `$schema` key and this
  // function used to read that key as if it settled the question. It does not:
  // the routing lives in ONE client, not in Gemini. Measured (#319):
  //   @google/genai (JS)        — `maybeMoveToResponseJsonSchema()` auto-routes on `$schema`
  //   google-genai (Python)     — no `$schema` handling at all; you set the field yourself
  //   @google/generative-ai     — the LEGACY client, which `@langchain/google-genai@2.2.0`
  //                               depends on: ZERO occurrences of `responseJsonSchema`.
  //                               Everything goes to the narrow proto, `$schema` or not.
  // So for a LangChain caller a top-level `$schema` routes nothing, and reading
  // it as "permissive path" green-lit a payload the live API rejects with
  // `Unknown name "prefixItems" ... Cannot find field`. Only the caller knows
  // which client they hold, so the caller picks the target.
  // Union `type` for the narrow `responseSchema` proto.
  //
  // `type` is in GEMINI_ALLOWED, so an ARRAY sitting in `type` sailed straight
  // through the allowlist and `--check --to gemini` exited 0 — the same
  // alternate-spelling false pass as array-form `items`, one field over
  // (`definitions` vs `$defs` #311, array-`items` #313/#316, `/$defs/` #320).
  //
  // `types.Schema.type` is a SINGLE-valued enum, so `google-genai` (Python)
  // 2.17.0 refuses to build the request at all:
  //   properties.a.type: Input should be 'TYPE_UNSPECIFIED', 'STRING', 'NUMBER',
  //   'INTEGER', 'BOOLEAN', 'ARRAY' or 'NULL'
  // — even for a single-element list like ["string"]. `@google/genai` (JS)
  // 2.16.0 does NOT throw; it rewrites. The rewrite below is copied from what
  // that SDK actually emits, measured shape by shape rather than guessed:
  //   ["string","null"]           -> {type:"STRING", nullable:true}
  //   ["string","integer"]        -> {anyOf:[{STRING},{INTEGER}]}   (no `type`)
  //   ["string","integer","null"] -> {anyOf:[...], nullable:true}
  //   ["string"]                  -> {type:"STRING"}
  // Constraining siblings (`items`, `minLength`, …) stay OUTSIDE the generated
  // `anyOf`, which is also what the JS SDK does.
  //
  // Two deliberate divergences from that SDK, both because it is wrong there:
  //   * a null-only type. JS emits `{nullable:true, anyOf:[]}` for ["null"] but
  //     THROWS on the equivalent bare `"null"` ("type: null can not be the only
  //     possible type for the field."). Python is inconsistent in the mirror
  //     direction: it ACCEPTS bare `"null"` and rewrites it to `{nullable:true}`
  //     with no `type`, and throws on ["null"]. We emit `{nullable:true}` for
  //     both, the one form neither SDK rejects.
  //   * duplicates are collapsed. JS emits `anyOf:[{STRING},{STRING}]` for
  //     ["string","string","null"]; deduping makes that a plain nullable string.
  //
  // Not exotic: `zod-to-json-schema` emits `type:["string","null"]` for
  // `.nullable()`, and our own `--to openai` output CREATES it (the forced-
  // required rewrite shipped in #311).
  function normalizeUnionType(node, path, ledger) {
    var raw = node.type;
    var isList = Array.isArray(raw);
    if (!isList && raw !== "null") return;

    var list = isList ? raw : ["null"];
    var hasNull = false;
    var rest = [];
    list.forEach(function (t) {
      if (t === "null") { hasNull = true; return; }
      if (rest.indexOf(t) === -1) rest.push(t);
    });

    // `type` + `anyOf` together is already reported as a blocker upstream, and
    // this rewrite would have to invent a merge. Leave it visible instead.
    if (rest.length > 1 && node.anyOf !== undefined) return;

    var before = JSON.stringify(raw);
    var why;

    if (rest.length === 0) {
      delete node.type;
      node.nullable = true;
      why = "a null-only type has no proto spelling both SDKs accept; `{nullable: true}` " +
        "with no `type` is the form `google-genai` itself produces";
    } else if (rest.length === 1) {
      node.type = rest[0];
      if (hasNull) node.nullable = true;
      why = "`Schema.type` holds one value, and `nullable` is the proto's way to say " +
        "\"or null\"";
    } else {
      delete node.type;
      node.anyOf = rest.map(function (t) { return { type: t }; });
      if (hasNull) node.nullable = true;
      why = "a multi-type union has no single `Schema.type`, so it becomes `anyOf` — " +
        "which is what `@google/genai` emits for this input";
    }

    ledger.push(entry("~", path,
      "Rewrote `type: " + before + "` to " +
      JSON.stringify(node.anyOf !== undefined && rest.length > 1
        ? { anyOf: node.anyOf, nullable: node.nullable }
        : { type: node.type, nullable: node.nullable }, function (k, v) {
          return v === undefined ? undefined : v;
        }) + ". " +
      "`types.Schema.type` is a single-valued enum, so `google-genai` (Python) REFUSES TO " +
      "BUILD the request — `Input should be 'TYPE_UNSPECIFIED', 'STRING', … or 'NULL'` — " +
      "even for a one-element list. `@google/genai` (JS) does not throw; it performs this " +
      "same rewrite silently, so the two clients disagree about whether your schema is " +
      "sendable at all. Lossless: " + why + ".",
      DOCS.gemini));
  }

  function toGemini(schema, jsonPath) {
    var s = clone(schema);
    var ledger = [];

    // Applies to BOTH paths: the narrow proto has no `$ref` at all, and the
    // JSON-Schema path accepts `$ref`/`$defs` but resolves only real local
    // pointers. Either way a `/$defs/X` spelling is broken, so fix it before
    // the paths diverge.
    s = normalizeRefSpelling(s, ledger, DOCS.gemini,
      "Gemini resolves `$ref` only on the `responseJsonSchema` path, and only for genuine local " +
      "pointers.");

    // Narrow path only. `types.Schema` is declared `extra="forbid"` and every
    // sub-schema slot is typed as a `Schema`, never a bool — measured on
    // google-genai==2.17.0, `model_validate` REJECTS a boolean at
    // `properties.a`, `properties.a.items` and `properties.a.anyOf.1`. The
    // `responseJsonSchema` path is ordinary JSON Schema and is left alone.
    if (!jsonPath) {
      findBooleanSubschemas(s).forEach(function (h) {
        ledger.push(entry("!", h.path,
          booleanSubschemaMessage(h.value,
            "The narrow `responseSchema` proto has no boolean form: `types.Schema` is " +
            "`extra=\"forbid\"` and types every sub-schema slot as a `Schema`, so " +
            "`model_validate()` rejects it. It IS legal on the `responseJsonSchema` path — " +
            "see `--to gemini-json`."),
          DOCS.gemini));
      });
    }

    // ---- Path A: `responseJsonSchema` -> the SDK sends this VERBATIM --------
    // Subsetting here would be actively destructive: it would throw away
    // constraints this path accepts. This is what the doc-derived version did
    // to every `zod-to-json-schema` user.
    if (jsonPath === true) {
      if (typeof s.$schema === "string") {
        // "sent verbatim" is the TRANSPORT, not acceptance — the backend still
        // has its own allowlist.
        ledger.push(entry("=", "root",
          "Kept `$schema`. It is not merely decorative: @google/genai (JS) reads a TOP-LEVEL " +
          "`$schema` and moves the schema to the `responseJsonSchema` request field for you. " +
          "No other client does — in Python set `response_json_schema` yourself, and the legacy " +
          "`@google/generative-ai` (what @langchain/google-genai uses) has no such field at all. " +
          "This path keeps `$ref`/`$defs` and recursion, but it does NOT ENFORCE `pattern`, " +
          "`minLength`, `maxLength`, `min/maxProperties`, `default` or `example` — those are " +
          "silently ignored here and work only on the narrow `responseSchema` path. The two " +
          "subsets are complementary; neither is a superset. Nothing below is an error: " +
          "unsupported keywords are ignored, so `--check` stays green.",
          DOCS.gemini, true));
      } else {
        ledger.push(entry("=", "root",
          "No top-level `$schema`, so @google/genai (JS) will NOT auto-route this — it would " +
          "send it as `responseSchema`, the narrow proto, where much of the output below is " +
          "rejected outright. Put this schema in the `responseJsonSchema` request field " +
          "explicitly (Python: `response_json_schema=`), or add a top-level `$schema` if you " +
          "are on @google/genai. If you actually meant the narrow path, use `--to gemini`.",
          DOCS.gemini, true));
      }

      // `definitions` is the draft-07 spelling zod-to-json-schema emits, and it
      // is NOT in the accepted list — only `$defs` is. Renaming it (and
      // repointing every `$ref`) is the fix; deleting it as an unknown keyword
      // would orphan every reference and leave a schema of nothing but `$ref`.
      s = normalizeDefs(s, ledger, DOCS.gemini,
        "Renamed draft-07 `definitions` to `$defs` and repointed every `$ref` — " +
        "`responseJsonSchema` accepts `$defs`, not `definitions`. (zod-to-json-schema emits `definitions`.)");

      // Array-form `items` is the DRAFT-07 spelling of a tuple, and it is the
      // one the Vercel AI SDK actually puts on the wire for `z.tuple()`. The
      // accepted list above names `items` and `prefixItems` separately, in the
      // 2020-12 sense: `items` is the schema for every element, `prefixItems`
      // is the positional list. So an array sitting in `items` is not the
      // "items" that list accepts. Renaming it is lossless and lands on a
      // keyword this path explicitly accepts — unlike the narrow path below,
      // no positions have to be given up. Must run before the allowlist walk,
      // which would otherwise wave the array through as an accepted `items`.
      walk(s, "root", function (node, path) {
        if (!Array.isArray(node.items)) return;
        node.prefixItems = node.items;
        delete node.items;
        ledger.push(entry("~", path,
          "Rewrote draft-07 tuple-form `items` (an array of schemas) as `prefixItems`. " +
          "`responseJsonSchema` accepts `prefixItems` for positional tuples; an array inside " +
          "`items` is the draft-07 spelling and is not what that list means by `items`. " +
          "Nothing is lost — every position keeps its own schema. (`z.tuple()` through the " +
          "Vercel AI SDK emits exactly this array form.)",
          DOCS.gemini));
      });

      walk(s, "root", function (node, path) {
        Object.keys(node).forEach(function (k) {
          if (!GEMINI_JSON_ALLOWED[k]) {
            // KEPT, not removed — and the wording of the source is the whole
            // reason. The field doc says "While the full JSON Schema MAY BE
            // SENT, not all features are supported", i.e. an unsupported
            // keyword is IGNORED, not rejected. Contrast OpenAI, whose doc
            // says outright "you will receive an error" — that is what makes
            // stripping correct there and wrong here. Deleting a keyword the
            // request would have accepted destroys a real constraint to buy
            // nothing, which is precisely the bug the previous cycle fixed.
            ledger.push(entry("=", path,
              "Kept `" + k + "`, but it is NOT enforced on this path — it is absent from the " +
              "accepted property list enumerated on the `response_json_schema` field of " +
              "`google-genai`. The full JSON Schema may be sent, so this is ignored rather " +
              "than rejected; your request still succeeds, but nothing constrains `" + k + "`. " +
              "If you need it enforced, drop the top-level `$schema` to take the narrow " +
              "`responseSchema` path (which does enforce `pattern`, `minLength`, `maxLength`, " +
              "`min/maxProperties`, `default`, `example`), or restate it in `description`.",
              DOCS.gemini, true));
          }
        });

        // "If $ref is set on a sub-schema, no other properties, except for
        //  than those starting as a `$`, may be set."
        if (typeof node.$ref === "string") {
          Object.keys(node).forEach(function (k) {
            if (k.charAt(0) !== "$") {
              ledger.push(entry("x", path,
                "Removed `" + k + "` alongside `$ref` — on the `responseJsonSchema` path a " +
                "`$ref` sub-schema may carry no properties except ones starting with `$`. " +
                "Inline the definition if you need `" + k + "` on it.",
                DOCS.gemini));
              delete node[k];
            }
          });
        }
      });

      // Cyclic refs are allowed here, but only in NON-required properties.
      var cyc = cyclicRequired(s);
      cyc.forEach(function (p) {
        ledger.push(entry("!", p,
          "This property is `required` and its type is cyclic. Gemini unrolls cyclic " +
          "references only to a limited degree and only within non-required properties " +
          "(nullable is not sufficient) — make it optional or flatten it to a fixed depth.",
          DOCS.gemini));
      });
      return { schema: s, ledger: ledger };
    }

    // ---- Path B: `responseSchema`, the narrow `Schema` proto ----------------
    // Reachable WITH a top-level `$schema` now, which is the #319 fix. A
    // LangChain caller has one (zod/`z.toJSONSchema()` emits it) and still
    // lands here, because their client cannot route. Strip it explicitly with
    // its own ledger line rather than letting the allowlist walk drop it as a
    // nameless unknown — the reason matters more than the removal.
    if (typeof s.$schema === "string") {
      delete s.$schema;
      ledger.push(entry("-", "root",
        "Removed `$schema`. The narrow `responseSchema` proto has no such field, and " +
        "`types.Schema` is declared `extra=\"forbid\"`, so leaving it is a rejection. Note this " +
        "key is ALSO the auto-routing switch in @google/genai (JS) only — if that is your " +
        "client and you wanted the permissive path, re-run with `--to gemini-json` instead of " +
        "taking this narrow-path output.",
        DOCS.gemini));
    }

    s = inlineRefs(s, ledger, DOCS.gemini);

    // The SDK throws outright before the request is even built.
    walk(s, "root", function (node, path) {
      if (node.type !== undefined && node.anyOf !== undefined) {
        ledger.push(entry("!", path,
          "`type` and `anyOf` are both set. @google/genai throws " +
          "\"type and anyOf cannot be both populated.\" before it sends anything — " +
          "drop one of them.",
          DOCS.gemini));
      }
    });

    walk(s, "root", function (node, path) {
      // Union `type`. Runs before the allowlist strip below so the `nullable` /
      // `anyOf` it produces are already in place when the allowlist sees them
      // (both are fields of `Schema`).
      normalizeUnionType(node, path, ledger);

      // Tuples. `items` is in GEMINI_ALLOWED, so an ARRAY sitting in `items`
      // used to sail straight through the allowlist untouched — the third time
      // an alternate spelling of a container has hidden from a keyword check
      // (`definitions` vs `$defs`, then the same array-`items` false pass in
      // OpenAI). `types.Schema` is `extra="forbid"` and its `items` is a single
      // Schema, so it rejects the array outright:
      //   "properties.bbox.items: Input should be a valid dictionary or object"
      // `minItems`/`maxItems` ARE fields of `Schema` (verified against the same
      // oracle), so the homogeneous collapse keeps the fixed length here.
      var tupleBlocked = normalizeTuple(node, path, ledger, DOCS.gemini,
        "Gemini's `responseSchema` proto has no tuple form — `types.Schema` declares `items` " +
        "as a single schema and is `extra=\"forbid\"`, so it rejects both an array in `items` " +
        "and `prefixItems`.",
        "The `responseSchema` proto has no tuple form, but every position here has the same " +
        "schema, and `minItems`/`maxItems` are fields of `types.Schema`, so the fixed length " +
        "survives as a real constraint on this path.");

      // drop keywords outside the supported subset
      Object.keys(node).forEach(function (k) {
        // A blocked (heterogeneous) tuple stays visible so the reader can see
        // the shape they have to remodel.
        if (tupleBlocked && (k === "prefixItems" || k === "items")) return;
        if (!GEMINI_ALLOWED[k]) {
          if (k === "$ref") {
            ledger.push(entry("!", path,
              "`$ref` is not supported by Gemini (except recursive `#`). Inline the referenced schema.",
              DOCS.gemini));
          } else if (k === "additionalProperties" && isOpenMap(node)) {
            // Dropping it here is the same deletion as OpenAI's rewrite: the
            // proto has no field for it, so the map's element type simply
            // vanishes and `{"type":"OBJECT"}` is left behind. Keep it visible.
            ledger.push(entry("!", path,
              "This is an open map (`additionalProperties` with no `properties`). The " +
              "`responseSchema` proto has no `additionalProperties` field, so the element " +
              "type would be dropped and this node would become a bare object with no " +
              "declared contents. " + OPEN_MAP_REMEDY +
              " (The `responseJsonSchema` path DOES accept `additionalProperties` — if you " +
              "can use it, run `--to gemini-json` instead.) Note that only a JS caller is " +
              "told about this: the API answers `Unknown name \"additionalProperties\"`, but " +
              "Go's `genai.Schema` has no such field and drops it during unmarshal with no " +
              "error, so the request succeeds and the map's element type is simply gone.",
              DOCS.gemini));
          } else if (k === "additionalProperties") {
            ledger.push(entry("x", path,
              "Removed `additionalProperties` — @google/genai strips it on the way out " +
              "(\"additionalProperties is not included in JSONSchema, skipping it\"), and live " +
              "v1beta calls reject it with `Unknown name \"additionalProperties\" at " +
              "generation_config.response_schema … Cannot find field`. (Note the Python " +
              "`Schema` type does declare it, so it may be accepted on Vertex; it is also " +
              "accepted on the `responseJsonSchema` path.) Unlike OpenAI, Gemini does not " +
              "need it to get strict behaviour.",
              DOCS.gemini));
            delete node[k];
          } else if (k === "prefixItems") {
            ledger.push(entry("x", path,
              "Removed `prefixItems` — not a field of the SDK's `Schema` type, so the " +
              "`responseSchema` proto has nowhere to put it. Gemini has no tuple form; " +
              "model it as an object with named fields, or a homogeneous `items` array.",
              DOCS.gemini));
            delete node[k];
          } else {
            ledger.push(entry("x", path,
              "Removed `" + k + "` — not a field of the SDK's `Schema` type " +
              "(`@google/genai` dist/genai.d.ts), so the `responseSchema` proto cannot carry it.",
              DOCS.gemini));
            delete node[k];
          }
        }
      });

      // Non-string `enum` values. `Schema.enum` is declared `list[str]` — a
      // NUMERIC enum is rejected by the oracle ("enum.0: Input should be a
      // valid string"), which is the live 400 people actually see:
      //   response_schema.properties[x].enum: only allowed for STRING type
      // The field's own doc gives the accepted form and it is not "drop it":
      //   "To mark a field as an enum, set `format` to `enum` and provide the
      //    list of possible values in `enum`. ... To define apartment numbers:
      //    {type:INTEGER, format:enum, enum:["101", "201", ...]}"
      // So the values are stringified and `format: "enum"` is set, while `type`
      // stays INTEGER/NUMBER/BOOLEAN — verified ACCEPTED for all three. The
      // constraint survives intact; only its encoding changes.
      // Narrow path only: `responseJsonSchema` accepts "enum (for strings and
      // numbers)" verbatim, so nothing needs rewriting there.
      if (Array.isArray(node.enum) && node.enum.some(function (v) { return typeof v !== "string"; })) {
        var before = JSON.stringify(node.enum);
        node.enum = node.enum.map(function (v) { return v === null ? "null" : String(v); });
        node.format = "enum";
        ledger.push(entry("~", path,
          "Rewrote `enum` " + before + " to " + JSON.stringify(node.enum) + " and set " +
          "`format: \"enum\"`. `Schema.enum` is declared `list[str]`, so a non-string enum is " +
          "rejected — this is the live `enum: only allowed for STRING type` 400. The vendor " +
          "field doc gives this exact form (`{type:INTEGER, format:enum, enum:[\"101\"]}`), so " +
          "`type` is left as-is and the allowed set is fully preserved; only its encoding " +
          "changes. `z.literal(15)` and any numeric enum land here.",
          DOCS.gemini));
      }

      // string `format` limited to date-time / date / time.
      // NOTE: doc-sourced, not SDK-verified — the SDK types `format` as a bare
      // `string` and gives no verdict. Kept as a strip because the asymmetry
      // favours it: an unsupported `format` is a hard 400, while `format` is
      // advisory, so dropping it costs little.
      if (node.type === "string" && node.format && !GEMINI_STRING_FORMATS[node.format]) {
        ledger.push(entry("x", path,
          "Removed `format: " + node.format + "` — Gemini supports only date-time, date, time for strings.",
          DOCS.gemini));
        delete node.format;
      }

      // `default: null` survives this path in JS and Python and is DROPPED in Go.
      // `google.golang.org/genai`'s `Schema.Default` is `any` with `omitempty`,
      // so an explicit JSON `null` unmarshals to a nil interface and is then
      // omitted on the way out — indistinguishable from "no default at all".
      // Measured on v1.67.0, and it is the ONLY key our converted output loses
      // when a Go caller round-trips it through `genai.Schema`. The proto itself
      // accepts it (live v1beta pre-auth check passes), so this is a client
      // limitation, not a schema error — advisory, never a gate failure.
      // Pydantic emits `"default": null` for every `Optional[x] = None` field,
      // so Go callers converting Pydantic output hit this constantly.
      if (Object.prototype.hasOwnProperty.call(node, "default") && node.default === null) {
        ledger.push(entry("=", path,
          "`default: null` is kept — the proto accepts it and `@google/genai` (JS) and " +
          "`google-genai` (Python) both send it. If your client is Go, it will NOT arrive: " +
          "`google.golang.org/genai`'s `Schema.Default` is `any` with `omitempty`, so an " +
          "explicit null unmarshals to a nil interface and is dropped with no error. Set the " +
          "default in your Go struct literal if you need it.",
          DOCS.gemini, true));
      }

      // add propertyOrdering so field order is deterministic (Gemini honors it)
      if (isObjectSchema(node) && node.properties) {
        var keys = Object.keys(node.properties);
        if (keys.length && !node.propertyOrdering) {
          node.propertyOrdering = keys.slice();
          ledger.push(entry("+", path,
            "Added `propertyOrdering` — Gemini uses it to fix the field order it emits. " +
            "Optional: the schema is already accepted without it.",
            DOCS.gemini, true));
        }
      }
    });

    if (ledger.length === 0) {
      ledger.push(entry("=", "root",
        "No changes needed. Every keyword here is a field of the SDK's `Schema` type, " +
        "so the `responseSchema` proto can carry all of it. (Adding a top-level `$schema` " +
        "would instead route you to `responseJsonSchema`, which accepts full JSON Schema " +
        "including `$ref` and recursion.)",
        DOCS.gemini));
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
    // draft-07 tuple form: `items` is an ARRAY of schemas. Descending only into
    // the object form left every sub-schema of a `z.tuple()` unvisited, so a
    // nested object inside a tuple never got `additionalProperties: false`.
    if (Array.isArray(node.items)) {
      node.items.forEach(function (it, i) { walk(it, path + "[" + i + "]", fn); });
    }
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

  // ---- OpenAI, NON-strict surfaces -----------------------------------------
  //
  // `openai` above models Structured Outputs / strict mode. That is not the only
  // OpenAI dialect, and the switch is not in the schema — it is which API you call.
  //
  // openai@7.4.0's `helpers/zod.js` exports FIVE schema builders. Four of them
  // (`zodResponseFormat`, `zodTextFormat`, `zodFunction`, `zodResponsesFunction`)
  // hardcode `strict: true` and run the schema through `toStrictJsonSchema()`.
  // The fifth, `zodRealtimeFunction`, calls `zodV3ToNonStrictJsonSchema` /
  // `zodV4ToNonStrictJsonSchema` — which never call `toStrictJsonSchema()` — and
  // deliberately omits `strict`, with this docstring:
  //
  //   "Unlike zodResponsesFunction, this helper does not add `strict` because
  //    Realtime function tools do not support that field."
  //
  // Corroborated by the request types themselves:
  //   - `FunctionDefinition` (chat/responses) has `strict?: boolean | null`, documented
  //     "Only a subset of JSON Schema is supported when `strict` is `true`."
  //     The subset restriction is CONDITIONAL on strict.
  //   - `RealtimeFunctionTool` has exactly four fields — description, name,
  //     `parameters?: unknown`, type. There is NO `strict` field at all, and
  //     `parameters` is documented as plain "Parameters of the function in JSON Schema"
  //     with no subset caveat.
  //
  // So the strip list in `toOpenAI` is justified by "unsupported schema -> you will
  // receive an error", which is a claim about STRICT MODE, not about OpenAI. Applying
  // it here would destroy real constraints to buy nothing — the same cross-policy
  // strip mistake the Gemini path already had.
  //
  // Error policy on this surface: the subset rule does not apply, so nothing is
  // stripped and nothing is rewritten. Constraints are not grammar-enforced either
  // (there is no constrained decoder without strict), so they are advisory to the
  // model — which is worth SAYING, and is the whole value of this target.
  //
  // #322 — THE NAME WAS THE DEFECT. Shipping this as `openai-realtime` only scoped it
  // to the surface where the condition was FIRST FOUND. The condition that actually
  // selects this dialect is `strict` being absent or false, and in openai@7.4.0 that
  // flag is optional at FOUR declaration sites outside Realtime:
  //   shared.d.ts:112   FunctionDefinition.strict?: boolean | null
  //   shared.d.ts:251   ResponseFormatJSONSchema.JSONSchema.strict?: boolean | null
  //   responses.d.ts:741, :2456 (responses tools / text.format)
  // each documented "Only a subset of JSON Schema is supported when `strict` is `true`".
  // Realtime is the special case where non-strict is not a choice (no field at all);
  // everywhere else it is the DEFAULT, because omitting `strict` is non-strict.
  //
  // This is not hypothetical. Instructor — Python-native, Pydantic-first, and the
  // most common way Python code gets structured output — omits `strict` on EVERY
  // OpenAI path: `Mode.TOOLS` (the default), `Mode.JSON_SCHEMA`, and even
  // `Mode.TOOLS_STRICT`, which is deprecated and collapses to `Mode.TOOLS`, so a
  // user who explicitly asks for strict silently gets non-strict. Measured on
  // instructor==1.15.4 via an intercepted `httpx.Client.send`: no `strict` key in
  // any of the three payloads. For those users `--to openai` exits 1 and proposes
  // four edits to a schema their API accepts as written — a false CI failure, the
  // #312/#314/#317 class — and the correct verdict was reachable only by typing a
  // Realtime-named target they have no reason to try.
  //
  // `surfaceHasNoStrictField` distinguishes the two, because the REASON differs and
  // the reader needs the true one: on Realtime there is no `strict` field to set;
  // elsewhere the field exists and is simply unset, which means the fix for someone
  // who WANTED enforcement is "set strict: true and re-run `--to openai`".
  function toOpenAINonStrict(input, surfaceHasNoStrictField) {
    var schema = clone(input);
    var ledger = [];
    var url = surfaceHasNoStrictField
      ? DOCS["openai-realtime"] : DOCS["openai-nonstrict"];

    ledger.push(entry("=", "root", surfaceHasNoStrictField
      ? "No changes needed. This surface has no `strict` field, so the Structured Outputs " +
        "keyword subset does not apply — your schema is sent as plain JSON Schema."
      : "No changes needed. `strict` is absent or false, so the Structured Outputs keyword " +
        "subset does not apply — your schema is sent as plain JSON Schema.", url));

    // Everything `toOpenAI` would have removed or rewritten is legal here. Name the
    // specific keywords found so the reader can see the divergence is real and is
    // about their schema, not a generic disclaimer.
    var kept = [];
    walk(schema, "root", function (node, path) {
      Object.keys(node).forEach(function (k) {
        if (OPENAI_SUPPORTED[k] || kept.indexOf(k) !== -1) return;
        if (k === "properties" || k === "$defs" || k === "definitions") return;
        kept.push(k);
        ledger.push(entry("=", path,
          "`" + k + "` is kept. Strict mode cannot represent it, but this surface is not " +
          "strict, so it is neither an error nor stripped.", url));
      });
    });

    ledger.push(entry("!", "root",
      "Without `strict`, the model is not grammar-constrained: every constraint here is " +
      "guidance the model can violate, so keep validating the response yourself.",
      url, true));

    // Name the sibling target, the same way the Anthropic and Gemini pairs do. The
    // reader picked a target from a flag they may not control (Instructor omits
    // `strict` even in Mode.TOOLS_STRICT), so say what switching would cost.
    ledger.push(entry("=", "root", surfaceHasNoStrictField
      ? "Realtime function tools have no `strict` field, so there is no enforced " +
        "alternative on this surface. On chat/responses you can set `strict: true` and " +
        "re-run with `--to openai`."
      : "If you want the constraints actually enforced, set `strict: true` on the tool or " +
        "response_format and re-run with `--to openai` — but that dialect is a subset, so " +
        "expect real edits. Note that some clients omit `strict` for you: Instructor's " +
        "`Mode.TOOLS_STRICT` is deprecated and sends a non-strict payload.",
      url, true));

    return { schema: schema, ledger: ledger };
  }

  var CONVERTERS = {
    openai: toOpenAI,
    // Anthropic is two request fields, two dialects, two targets — same shape
    // as Gemini below. `tools[].input_schema` applies no transform at all;
    // `output_format` rebuilds the schema. Which one you are on is the
    // caller's fact, so it is never inferred from the schema (#315/#319).
    anthropic: function (s) { return toAnthropic(s, false); },
    // The structured-output path is split again, by which SDK builds the request.
    // That is a fact only the caller has (#319) and it is NOT inferable from the
    // schema — and NOT a version skew: the SDKs ship the same version string
    // with different behaviour, so it will not resolve itself. Three now, and
    // `anthropic-go` also covers the Go tools path, because Go is the one SDK
    // where `tools[].input_schema` runs the transform too.
    "anthropic-json": function (s) { return toAnthropic(s, true, "js"); },
    "anthropic-json-python": function (s) { return toAnthropic(s, true, "python"); },
    "anthropic-go": function (s) { return toAnthropic(s, true, "go"); },
    // Two request fields, two dialects, two targets. Never inferred — see the
    // note on toGemini(): the routing switch belongs to one client, not to
    // Gemini, so guessing it produces a false pass for everyone else.
    gemini: function (s) { return toGemini(s, false); },
    "gemini-json": function (s) { return toGemini(s, true); },
    // Non-strict is a property of the `strict` flag, not of one API surface, so the
    // primary name is the CONDITION. `openai-realtime` stays as the surface where
    // that condition is forced rather than chosen (and so nobody's script breaks).
    "openai-nonstrict": function (s) { return toOpenAINonStrict(s, false); },
    "openai-realtime": function (s) { return toOpenAINonStrict(s, true); }
  };

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

    // An emptied map is provider-independent: it is a fact about the document
    // the caller is holding, not about who accepts it, and EVERY provider
    // accepts it. So it is reported once, here, for every target — and only as
    // an advisory, because there is genuinely nothing to fix in this file. The
    // value type is already gone; the fix belongs upstream, in whatever
    // compatibility layer ran before us.
    //
    // Reported on the INPUT, because a converter that legitimately closes an
    // object would otherwise make us report our own edit back to the caller.
    walk(schema, "root", function (node, path) {
      if (!isEmptiedMap(node)) return;
      result.ledger.push(entry("=", path,
        "This object is closed (`additionalProperties: false`) and declares no `properties`, " +
        "so its only legal value is `{}` — the model can never put anything in it. Every " +
        "provider accepts this, so nothing will warn you. Most often it is not what anyone " +
        "wrote: it is what is left after a compatibility layer \"fixed\" a map/dictionary by " +
        "setting `additionalProperties: false`, which does not close an open map, it empties " +
        "it (measured: `@mastra/schema-compat`'s `prepareJsonSchemaForOpenAIStrictMode` does " +
        "exactly this to an ordinary `z.record(z.string())`). The value type is already gone " +
        "here and cannot be recovered — check the schema BEFORE that layer runs. If you really " +
        "did mean an always-empty object, ignore this. " + OPEN_MAP_REMEDY,
        DOCS[provider], true));
    });

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
    DOCS: DOCS,
    // The narrow `responseSchema` subset, exported so it can be diffed against
    // the vendor artifact it is derived from. It is now confirmed by three
    // independent ones: the JS `Schema` interface (dist/genai.d.ts), the Python
    // `types.Schema` model (`extra="forbid"`), and the Go `Schema` struct's
    // json tags (google.golang.org/genai v1.67.0) — all 22, identical.
    GEMINI_ALLOWED_KEYS: Object.keys(GEMINI_ALLOWED)
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LLMSchema = api;
})(typeof window !== "undefined" ? window : this);
