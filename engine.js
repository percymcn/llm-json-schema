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

  // OpenAI strict mode has NO tuple form. openai@7.4.0's toStrictJsonSchema
  // throws on `prefixItems` ("uses unsupported keyword `prefixItems`") and on
  // array-form `items` ("uses tuple-form `items`"). A fixed-length tuple whose
  // entries are all the same schema is exactly a fixed-length array, so it
  // converts losslessly to `items` + `minItems`/`maxItems`. A heterogeneous
  // tuple is genuinely not representable: collapsing it would either widen it
  // (union of the entries, losing per-position typing) or drop positions
  // entirely. That is a human fix, so it becomes a blocker rather than a
  // silent rewrite. Returns true when the tuple keyword must be left in place.
  function normalizeTuple(node, path, ledger) {
    var tuple = null, kw = null;
    if (Array.isArray(node.prefixItems)) { tuple = node.prefixItems; kw = "prefixItems"; }
    else if (Array.isArray(node.items)) { tuple = node.items; kw = "items"; }
    if (!tuple || !tuple.length) return false;

    var head = canonical(tuple[0]);
    var homogeneous = tuple.every(function (t) { return canonical(t) === head; });

    if (!homogeneous) {
      ledger.push(entry("!", path,
        "This is a " + tuple.length + "-element tuple with differently-typed positions (`" + kw +
        "`), which OpenAI strict mode cannot represent — it has no tuple form. Model it as an object " +
        "with one named property per position instead; that keeps each position's type and is what the " +
        "model fills in more reliably anyway.",
        DOCS.openai));
      return true;
    }

    var n = tuple.length;
    node.items = clone(tuple[0]);
    if (kw === "prefixItems") delete node.prefixItems;
    if (node.minItems === undefined) node.minItems = n;
    if (node.maxItems === undefined) node.maxItems = n;
    ledger.push(entry("~", path,
      "Collapsed a " + n + "-element tuple (`" + kw + "`) into `items` with `minItems`/`maxItems` of " + n +
      " — OpenAI strict mode has no tuple form, but every position here has the same schema, so the " +
      "fixed length survives as a constraint.",
      DOCS.openai));
    return false;
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

      var tupleBlocked = normalizeTuple(node, path, ledger);

      // strip every keyword outside the supported set (unsupported => API error)
      Object.keys(node).forEach(function (k) {
        if (OPENAI_SUPPORTED[k]) return;
        // A blocked tuple stays visible so the reader can see the shape they
        // have to remodel; deleting it would hide the very thing to fix.
        if (k === "prefixItems" && tupleBlocked) return;
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
        "`$schema` instead and you stay on `responseJsonSchema`, where `$ref`/`$defs` are accepted.)",
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

  function toGemini(schema) {
    var s = clone(schema);
    var ledger = [];

    // ---- Path A: top-level `$schema` -> the SDK sends this VERBATIM ---------
    // `maybeMoveToResponseJsonSchema` only inspects TOP-LEVEL keys, so a nested
    // `$schema` does not route (and is stripped below as an unknown keyword).
    // Subsetting here would be actively destructive: it would delete the very
    // key that buys the user the permissive path, then throw away constraints
    // that path accepts. This is what the previous doc-derived version did to
    // every `zod-to-json-schema` user.
    if (typeof s.$schema === "string") {
      // Keep `$schema`: it is the routing switch. Stripping it would silently
      // downgrade the caller to the narrow proto path. But "sent verbatim" is
      // the TRANSPORT, not acceptance — the backend still has its own allowlist.
      ledger.push(entry("=", "root",
        "Kept `$schema` — it is the routing switch. With it, @google/genai moves this to the " +
        "`responseJsonSchema` request field (in Python, set `response_json_schema` yourself). " +
        "That path keeps `$ref`/`$defs` and recursion, but it does NOT ENFORCE `pattern`, " +
        "`minLength`, `maxLength`, `min/maxProperties`, `default` or `example` — those are " +
        "silently ignored here and work only on the narrow `responseSchema` path. The two " +
        "subsets are complementary; neither is a superset. Nothing below is an error: " +
        "unsupported keywords are ignored, so `--check` stays green.",
        DOCS.gemini, true));

      // `definitions` is the draft-07 spelling zod-to-json-schema emits, and it
      // is NOT in the accepted list — only `$defs` is. Renaming it (and
      // repointing every `$ref`) is the fix; deleting it as an unknown keyword
      // would orphan every reference and leave a schema of nothing but `$ref`.
      s = normalizeDefs(s, ledger, DOCS.gemini,
        "Renamed draft-07 `definitions` to `$defs` and repointed every `$ref` — " +
        "`responseJsonSchema` accepts `$defs`, not `definitions`. (zod-to-json-schema emits `definitions`.)");

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

    // ---- Path B: no `$schema` -> the narrow `Schema` proto ------------------
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
      // drop keywords outside the supported subset
      Object.keys(node).forEach(function (k) {
        if (!GEMINI_ALLOWED[k]) {
          if (k === "$ref") {
            ledger.push(entry("!", path,
              "`$ref` is not supported by Gemini (except recursive `#`). Inline the referenced schema.",
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
