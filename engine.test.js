/* Minimal, dependency-free tests for the transform engine. Run: node engine.test.js */
var E = require("./engine.js");

var pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("FAIL  " + name); }
}
function has(ledger, substr) {
  return ledger.some(function (l) { return l.msg.indexOf(substr) !== -1; });
}

// --- OpenAI: additionalProperties:false + all-required + nullable optional ---
(function () {
  var r = E.toOpenAI({
    type: "object",
    properties: { name: { type: "string" }, age: { type: "integer" } },
    required: ["name"]
  });
  ok("openai sets additionalProperties:false", r.schema.additionalProperties === false);
  ok("openai forces all props required", r.schema.required.length === 2 &&
    r.schema.required.indexOf("age") !== -1);
  ok("openai makes forced-required field nullable",
    Array.isArray(r.schema.properties.age.type) &&
    r.schema.properties.age.type.indexOf("null") !== -1);
  ok("openai ledger cites the rule", has(r.ledger, "additionalProperties"));
})();

// --- OpenAI: strips unsupported composition + flags root anyOf ---
(function () {
  var r = E.toOpenAI({ anyOf: [{ type: "object" }], allOf: [{ type: "object" }] });
  ok("openai removes allOf", !("allOf" in r.schema));
  ok("openai flags root anyOf as violation", r.ledger.some(function (l) {
    return l.op === "!" && l.msg.indexOf("anyOf") !== -1;
  }));
})();

// --- OpenAI: nested objects also get additionalProperties:false ---
(function () {
  var r = E.toOpenAI({
    type: "object",
    properties: { addr: { type: "object", properties: { city: { type: "string" } } } }
  });
  ok("openai recurses into nested objects",
    r.schema.properties.addr.additionalProperties === false);
})();

// --- Gemini: adds propertyOrdering, drops unsupported keywords ---
(function () {
  var r = E.toGemini({
    type: "object",
    properties: {
      email: { type: "string", format: "email", pattern: "^.+@.+$", minLength: 3 }
    },
    required: ["email"]
  });
  ok("gemini adds propertyOrdering", Array.isArray(r.schema.propertyOrdering) &&
    r.schema.propertyOrdering[0] === "email");
  ok("gemini drops unsupported `pattern`", !("pattern" in r.schema.properties.email));
  ok("gemini drops unsupported `minLength`", !("minLength" in r.schema.properties.email));
  ok("gemini drops unsupported string format `email`", !("format" in r.schema.properties.email));
})();

// --- Gemini: flags $ref / $defs ---
(function () {
  var r = E.toGemini({ $defs: { X: { type: "string" } }, type: "object",
    properties: { x: { $ref: "#/$defs/X" } } });
  ok("gemini flags $defs", r.ledger.some(function (l) { return l.msg.indexOf("$defs") !== -1; }));
  ok("gemini flags $ref", r.ledger.some(function (l) { return l.msg.indexOf("$ref") !== -1; }));
})();

// --- Anthropic: passes standard schema, notes strict:true ---
(function () {
  var r = E.toAnthropic({ type: "object", properties: { q: { type: "string" } }, required: ["q"] });
  ok("anthropic keeps standard schema unchanged", r.schema.additionalProperties === undefined);
  ok("anthropic mentions strict:true", has(r.ledger, "strict"));
})();

// --- inference from a JSON example ---
(function () {
  var s = E.inferSchema({ id: 1, tags: ["a"], meta: { ok: true } });
  ok("infer: integer", s.properties.id.type === "integer");
  ok("infer: array items", s.properties.tags.type === "array" && s.properties.tags.items.type === "string");
  ok("infer: nested object required", s.properties.meta.required.indexOf("ok") !== -1);
})();

// --- convert() end to end + example auto-detect ---
(function () {
  var r = E.convert('{"id": 1, "name": "x"}', "openai", {});
  ok("convert auto-detects example and infers", r.ok && r.inferred === true);
  ok("convert output valid for openai", r.schema.additionalProperties === false);
  var bad = E.convert("{not json", "openai", {});
  ok("convert reports invalid JSON", bad.ok === false && /isn't valid JSON/.test(bad.error));
})();

// --- REAL generator output: zod v3 + zod-to-json-schema ----------------------
// Verbatim `zodToJsonSchema()` output (zod 3, zod-to-json-schema 3.25.2) for a
// schema using the most common idioms: .uuid() .min() .max() .email() .default()
// .optional(). Before 2026-08-08 the engine reported this as "already valid":
// the root is `{$ref, definitions}`, so every object rule no-opped on it.
var ZOD_V3 = {
  $ref: "#/definitions/Ticket",
  definitions: {
    Ticket: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        title: { type: "string", minLength: 1, maxLength: 120 },
        priority: { type: "string", enum: ["low", "high"], "default": "low" },
        score: { type: "number", minimum: 0, maximum: 100 },
        notes: { type: "string" }
      },
      required: ["id", "title", "score"],
      additionalProperties: false
    }
  },
  $schema: "http://json-schema.org/draft-07/schema#"
};

(function () {
  var r = E.toOpenAI(ZOD_V3);
  var s = r.schema;
  ok("zod-v3 root $ref is inlined to a real object root", s.type === "object" && !!s.properties);
  ok("zod-v3 root $ref leaves no dangling $ref", s.$ref === undefined);
  ok("zod-v3 definitions block is consumed", s.definitions === undefined && s.$defs === undefined);
  ok("zod-v3 every property ends up required", s.required.length === 5);
  ok("zod-v3 additionalProperties:false survives", s.additionalProperties === false);
  // These four were previously asserted as STRIPPED. That was wrong: openai@7.4.0's
  // own `toStrictJsonSchema()` — the function building the payload the SDK sends —
  // preserves all of them. Stripping them made `--check` fail on schemas OpenAI
  // itself emits (any Zod `.describe()`/`.min()`/`.default()`). See engine.js.
  ok("openai preserves $schema (SDK retains it as root metadata)", s.$schema === "http://json-schema.org/draft-07/schema#");
  ok("openai preserves default", s.properties.priority["default"] === "low");
  ok("openai preserves minLength", s.properties.title.minLength === 1);
  ok("openai preserves maxLength", s.properties.title.maxLength === 120);
  ok("openai keeps supported minimum/maximum", s.properties.score.minimum === 0 && s.properties.score.maximum === 100);
  ok("openai keeps supported format", s.properties.id.format === "uuid");
  // Guard from #311: real generator input must not silently no-op. Anchored to the
  // substantive fixes themselves, not to a count the bogus strips used to inflate.
  var subst = r.ledger.filter(function (l) { return l.op !== "="; });
  ok("zod-v3 conversion is not a silent no-op", subst.length >= 4);
  ok("ledger reports the root $ref inlining", has(r.ledger, "Inlined the root `$ref`"));
  ok("ledger reports definitions -> $defs", has(r.ledger, "Renamed draft-07 `definitions` to `$defs`"));
  ok("optional fields are the fix that actually matters", has(r.ledger, "`priority` added to required") && has(r.ledger, "`notes` added to required"));
})();

// --- forced-required enum must admit null, or it is unsatisfiable ------------
(function () {
  var r = E.toOpenAI(ZOD_V3);
  var p = r.schema.properties.priority;
  ok("nullable enum field is typed nullable", p.type.indexOf("null") !== -1);
  ok("nullable enum field admits null in enum", p.enum.indexOf(null) !== -1);
})();

// --- idempotence: the gate must not flag its own output ----------------------
["openai", "anthropic", "gemini"].forEach(function (provider) {
  var once = E.convert(ZOD_V3, provider, { mode: "schema" });
  var twice = E.convert(once.schema, provider, { mode: "schema" });
  var changes = twice.ledger.filter(function (l) { return l.op !== "="; });
  ok(provider + " conversion is idempotent", changes.length === 0);
});

// --- oneOf is rewritten, not dropped ----------------------------------------
(function () {
  var r = E.toOpenAI({
    type: "object",
    properties: { v: { oneOf: [{ type: "string" }, { type: "integer" }] } }
  });
  var v = r.schema.properties.v;
  ok("openai rewrites oneOf to anyOf", Array.isArray(v.anyOf) && v.anyOf.length === 2 && v.oneOf === undefined);
})();

// --- Gemini inlines $refs rather than emitting an empty schema --------------
(function () {
  var r = E.toGemini(ZOD_V3);
  ok("gemini inlines the zod-v3 root $ref", r.schema.type === "object" && !!r.schema.properties);
  ok("gemini output has no $ref left", JSON.stringify(r.schema).indexOf("$ref") === -1);
  var rec = E.toGemini({
    type: "object",
    $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } },
    properties: { root: { $ref: "#/$defs/Node" } }
  });
  ok("gemini still blocks a genuinely recursive $ref", rec.ledger.some(function (l) {
    return l.op === "!" && l.msg.indexOf("recursive") !== -1;
  }));
})();

// --- REAL generator output: Pydantic 2.13.4 ---------------------------------
// Verbatim `model_json_schema()`. A field whose type is a nested model or Enum
// AND which carries a Field(description=...) emits `$ref` WITH a sibling, which
// OpenAI rejects: "$ref cannot have keywords {'description'}". A plain str field
// with a description does not — which is why the failure looks input-dependent.
// Seen in the wild: destiny-evidence/data-extraction-evaluation-toolkit#338.
var PYDANTIC = {
  $defs: {
    Grade: { "enum": ["low", "high"], title: "Grade", type: "string" },
    Nested: { properties: { v: { title: "V", type: "string" } }, required: ["v"], title: "Nested", type: "object" }
  },
  properties: {
    attribute_2: { $ref: "#/$defs/Nested", description: "the annotation for attribute 2" },
    grade: { $ref: "#/$defs/Grade", description: "a graded enum with a description" },
    plain: { description: "a plain string", title: "Plain", type: "string" }
  },
  required: ["attribute_2", "grade", "plain"],
  title: "Resp",
  type: "object"
};

(function () {
  var r = E.toOpenAI(PYDANTIC);
  var s = r.schema;
  ok("pydantic $ref+description is inlined", s.properties.attribute_2.$ref === undefined &&
    s.properties.attribute_2.type === "object");
  ok("the sibling description survives inlining", s.properties.attribute_2.description === "the annotation for attribute 2");
  ok("enum $ref+description is inlined too", s.properties.grade.$ref === undefined &&
    Array.isArray(s.properties.grade.enum));
  ok("orphaned $defs are pruned", s.$defs === undefined);
  ok("no $ref-with-sibling survives anywhere", JSON.stringify(s).indexOf('"$ref"') === -1);
  ok("ledger names the rule", has(r.ledger, "$ref cannot have keywords"));
})();

(function () {
  // A bare $ref (no siblings) is legal for OpenAI — leave it alone.
  var r = E.toOpenAI({
    type: "object",
    $defs: { A: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } },
    properties: { a: { $ref: "#/$defs/A" } },
    required: ["a"]
  });
  ok("bare $ref is preserved (OpenAI supports it)", r.schema.properties.a.$ref === "#/$defs/A");
  ok("its definition is kept", !!r.schema.$defs && !!r.schema.$defs.A);
})();

(function () {
  // Recursive + sibling cannot be inlined; must be reported, not silently wrong.
  var r = E.toOpenAI({
    type: "object",
    $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node", description: "d" } } } },
    properties: { root: { $ref: "#/$defs/Node" } }
  });
  ok("recursive $ref-with-sibling is reported as a blocker", r.ledger.some(function (l) {
    return l.op === "!" && l.msg.indexOf("recursive") !== -1;
  }));
})();

// --- tuples: verbatim generator output ------------------------------------
// Both fixtures below are copied unmodified from real generators:
//   PYD_TUPLE  = pydantic 2.x  `Tuple[float, float, float, float]` + `Set[str]`
//   ZOD_TUPLE7 = zod 4.4.3     z.toJSONSchema(schema, { target: "draft-7" })
// openai@7.4.0's toStrictJsonSchema throws on both shapes; before this, the
// engine passed them through and reported "Already valid for openai".
var PYD_TUPLE = {
  type: "object",
  properties: {
    labels: { items: { type: "string" }, title: "Labels", type: "array", uniqueItems: true },
    bbox: {
      maxItems: 4, minItems: 4, title: "Bbox", type: "array",
      prefixItems: [{ type: "number" }, { type: "number" }, { type: "number" }, { type: "number" }]
    }
  },
  required: ["labels", "bbox"],
  title: "Span"
};

(function () {
  var r = E.toOpenAI(PYD_TUPLE);
  var bbox = r.schema.properties.bbox;
  ok("homogeneous prefixItems collapses into object-form items",
    !("prefixItems" in bbox) && !Array.isArray(bbox.items) && bbox.items.type === "number");
  ok("collapsed tuple keeps its fixed length", bbox.minItems === 4 && bbox.maxItems === 4);
  ok("the collapse is reported, not silent", has(r.ledger, "Collapsed a 4-element tuple"));
  ok("uniqueItems is still stripped alongside it", !("uniqueItems" in r.schema.properties.labels));
})();

(function () {
  // draft-07 tuple form: `items` is an ARRAY. Same rejection, different keyword.
  var ZOD_TUPLE7 = {
    type: "object",
    properties: { bbox: { type: "array", items: [{ type: "number" }, { type: "number" }] } },
    required: ["bbox"],
    additionalProperties: false
  };
  var r = E.toOpenAI(ZOD_TUPLE7);
  ok("homogeneous draft-07 tuple-form items collapses too",
    !Array.isArray(r.schema.properties.bbox.items) &&
    r.schema.properties.bbox.items.type === "number" &&
    r.schema.properties.bbox.maxItems === 2);
})();

(function () {
  // A heterogeneous tuple genuinely cannot be represented. Claiming a fix here
  // would be the false pass this whole class of bug is about.
  var r = E.toOpenAI({
    type: "object",
    properties: { pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] } },
    required: ["pair"]
  });
  ok("heterogeneous tuple is a blocker, not a silent rewrite",
    r.ledger.some(function (l) { return l.op === "!" && l.msg.indexOf("differently-typed") !== -1; }));
  ok("a blocked tuple is left visible so the shape can be remodelled",
    Array.isArray(r.schema.properties.pair.prefixItems));
})();

(function () {
  // The walker skipped array-form `items` entirely, so nested objects inside a
  // tuple were never visited and kept their optional fields.
  var r = E.toOpenAI({
    type: "object",
    properties: {
      pairs: {
        type: "array",
        items: [{ type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"] }]
      }
    },
    required: ["pairs"]
  });
  ok("objects nested inside a tuple are visited and made strict",
    r.schema.properties.pairs.items.required.indexOf("b") !== -1);
})();

["openai", "anthropic", "gemini"].forEach(function (provider) {
  var once = E.convert(PYD_TUPLE, provider, { mode: "schema" });
  var twice = E.convert(once.schema, provider, { mode: "schema" });
  ok(provider + " is idempotent on pydantic tuple output",
    twice.ledger.filter(function (l) { return l.op !== "="; }).length === 0);
});

["openai", "anthropic", "gemini"].forEach(function (provider) {
  var once = E.convert(PYDANTIC, provider, { mode: "schema" });
  var twice = E.convert(once.schema, provider, { mode: "schema" });
  ok(provider + " is idempotent on pydantic output",
    twice.ledger.filter(function (l) { return l.op !== "="; }).length === 0);
});

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
