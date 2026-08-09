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
    gemini: "https://ai.google.dev/gemini-api/docs/structured-output",
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
  function anthropicRecognises(node, key) {
    switch (key) {
      case "$ref": case "$defs": case "type": case "anyOf": case "oneOf":
      case "allOf": case "description": case "title":
        return true;
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

  function toAnthropic(schema) {
    var s = clone(schema);
    var ledger = [];

    // `definitions` is draft-07; the transformer only knows `$defs`. Left alone
    // it is not merely ignored — it is stringified into the root `description`
    // and every `#/definitions/...` pointer is left dangling.
    s = normalizeDefs(s, ledger, DOCS.anthropic,
      "Renamed draft-07 `definitions` to `$defs` and repointed every `$ref`. Anthropic's " +
      "structured-output transformer only reads `$defs`; a `definitions` bag is not ignored, it is " +
      "stringified into the root `description` while every `#/definitions/...` pointer is left dangling.");

    // A root `$ref` is the single most destructive input on Path O: the
    // transformer returns immediately on `$ref`, so a real
    // `{$ref:"#/definitions/X", definitions:{...}}` from zod-to-json-schema
    // reduces to exactly `{"$ref":"#/definitions/X"}` — dangling pointer, whole
    // schema gone, no error raised. Measured against the SDK.
    s = inlineRootRef(s, ledger, DOCS.anthropic,
      "Anthropic's transformer returns as soon as it sees a `$ref`, so a root `$ref` discards " +
      "everything beside it: a real `{$ref, definitions}` from zod-to-json-schema comes out the " +
      "other side as just `{\"$ref\":\"#/definitions/X\"}` — a dangling pointer with the whole schema " +
      "gone, and no error raised.");
    // Same early return means `$ref` siblings are dropped outright — not even
    // demoted to prose, which is how the rest of the unknown keywords survive.
    s = resolveRefSiblings(s, ledger, DOCS.anthropic,
      "Anthropic's transformer returns immediately on `$ref` and drops every sibling key silently — " +
      "a `description` next to a `$ref` simply vanishes rather than being demoted to prose",
      "Anthropic's transformer drops silently");

    if (!s.type && isObjectSchema(s)) {
      s.type = "object";
      ledger.push(entry("+", "root",
        "Added `type: object` at the root. Both Anthropic paths require it: `betaTool()` throws " +
        "unless `input_schema.type === \"object\"`, and `jsonSchemaOutputFormat()` throws " +
        "\"JSON schema must be an object\".",
        DOCS.anthropic));
    } else if (s.type && s.type !== "object") {
      ledger.push(entry("!", "root",
        "The root must be an object on BOTH Anthropic paths — `betaTool()` and " +
        "`jsonSchemaOutputFormat()` each throw on a non-object root. Wrap this schema in an object.",
        DOCS.anthropic));
    }

    var demoted = [];
    walk(s, "root", function (node, path) {
      // Tuples: `items`-as-array and `prefixItems` both reach the transformer
      // with no `type` and throw. The error text ("must have a type defined")
      // points nowhere near the real cause, so say what it is.
      if (normalizeTuple(node, path, ledger, DOCS.anthropic,
            "Anthropic's structured-output transformer has no tuple form, and the two spellings fail " +
            "differently: array-form `items` (and `prefixItems` next to `items: false`) makes it throw " +
            "\"JSON schema must have a type defined if anyOf/oneOf/allOf are not used\" — a message " +
            "that never mentions tuples — while a bare `prefixItems` is quietly demoted to prose, " +
            "leaving an array with no item schema and no length at all.",
            "Anthropic's transformer has no tuple form — it would either throw or, for a bare " +
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
          DOCS.anthropic));
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
            DOCS.anthropic, true));
        }
      } else if (Array.isArray(node.oneOf) && Array.isArray(node.anyOf)) {
        // `_transformJSONSchema` pops both and takes `anyOf` first, so a
        // co-existing `oneOf` is discarded outright — silently, like every
        // other Anthropic loss on this path.
        ledger.push(entry("!", path,
          "This node has both `anyOf` and `oneOf`. Anthropic's transformer reads `anyOf` first and " +
          "DISCARDS `oneOf` entirely — no error, no warning, the constraint is simply gone. Merge " +
          "them into one `anyOf` so what you send is what you meant.",
          DOCS.anthropic, true));
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
            (Array.isArray(node.enum) ? "`enum` members" : "`const` value") +
            ". Without a `type` the transformer throws \"JSON schema must have a type defined if " +
            "anyOf/oneOf/allOf are not used\" — a bare enum is the most common way to hit that.",
            DOCS.anthropic));
        } else {
          ledger.push(entry("!", path,
            "This node has no `type` and no `anyOf`/`oneOf`/`allOf`, so Anthropic's " +
            "structured-output transformer throws \"JSON schema must have a type defined if " +
            "anyOf/oneOf/allOf are not used\". Give it an explicit `type`.",
            DOCS.anthropic));
        }
      }

      // Everything the transformer does not recognise survives only as prose.
      Object.keys(node).forEach(function (k) {
        if (anthropicRecognises(node, k)) return;
        if (k === "$schema" && path !== "root") return;
        demoted.push({ path: path, key: k, node: node });
      });
    });

    // These are reported, never stripped. Stripping would destroy a constraint
    // that IS still enforced on the tools path and buys nothing on either —
    // the #314 rule: read the provider's error policy before porting a strip.
    demoted.forEach(function (d) {
      var extra = "";
      if (d.key === "format") {
        extra = " Only these 10 `format` values survive: " +
          Object.keys(ANTHROPIC_STRING_FORMATS).join(", ") + ".";
      } else if (d.key === "minItems") {
        extra = " `minItems` survives only when it is exactly 0 or 1; any other value is demoted.";
      } else if (d.key === "additionalProperties") {
        extra = " On the output_format path the transformer discards your value and forces " +
          "`additionalProperties: false` regardless; on the tools path your value is sent as-is.";
      }
      ledger.push(entry("=", d.path,
        "`" + d.key + "` is NOT enforced on the `output_format` (structured output) path. " +
        "Anthropic's transformer does not recognise it, so it is appended to this node's " +
        "`description` as text — the model is told about it but nothing validates it. It IS sent " +
        "as-is on the `tools[].input_schema` path, so this is kept, not stripped." + extra,
        DOCS.anthropic, true));
    });

    var hasSubstantive = ledger.some(function (e) { return !e.advisory && e.op !== "="; });
    if (!hasSubstantive) {
      ledger.push(entry("=", "root",
        "No structural changes needed. On `tools[].input_schema` this schema is sent verbatim — " +
        "Anthropic applies no transform there; add `strict: true` to the TOOL definition (not the " +
        "schema) for guaranteed conformance. On `output_format` see the unenforced-keyword notes above.",
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
  function toOpenAIRealtime(input) {
    var schema = clone(input);
    var ledger = [];
    var url = DOCS["openai-realtime"];

    ledger.push(entry("=", "root",
      "No changes needed. This surface has no `strict` field, so the Structured Outputs " +
      "keyword subset does not apply — your schema is sent as plain JSON Schema.", url));

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

    return { schema: schema, ledger: ledger };
  }

  var CONVERTERS = {
    openai: toOpenAI,
    anthropic: toAnthropic,
    gemini: toGemini,
    "openai-realtime": toOpenAIRealtime
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
