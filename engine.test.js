/* Minimal, dependency-free tests for the transform engine. Run: node engine.test.js */
var E = require("./engine.js");

var pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("FAIL  " + name); }
}
function has(ledger, substr) {
  // A converter that does not exist returns {ok:false} with no ledger. Treating
  // that as a crash aborts the file and hides every assertion after it, so a
  // missing ledger is simply "does not contain" — it reports as a failure.
  if (!ledger || typeof ledger.some !== "function") return false;
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
  // `pattern` and `minLength` ARE fields of the SDK's `Schema` type
  // (@google/genai dist/genai.d.ts) — the doc's narrower "supported properties"
  // list is what made us delete them. Verified 2026-08-09 by capturing the wire
  // payload the SDK builds: both arrive at `responseSchema` untouched.
  ok("gemini KEEPS `pattern` (in the SDK Schema type)", r.schema.properties.email.pattern === "^.+@.+$");
  ok("gemini KEEPS `minLength` (in the SDK Schema type)", r.schema.properties.email.minLength === 3);
  // This assertion used to read "gemini drops unsupported string format
  // `email`". It encoded a premise the vendor contradicts: `email` is the FIRST
  // value named in `Schema.format`'s own field description. Nothing is stripped
  // now, and a named format draws no advisory either.
  ok("gemini KEEPS `format: email` (first value the vendor names)",
    r.schema.properties.email.format === "email");
  ok("...and a vendor-named format is not flagged",
    !has(r.ledger, "Kept `format: email`"));
})();

// --- Gemini: keywords the vendor Schema type does NOT have ------------------
(function () {
  var r = E.toGemini({
    type: "object",
    additionalProperties: false,
    properties: { pair: { type: "array", prefixItems: [{ type: "string" }] } }
  });
  ok("gemini drops additionalProperties (SDK skips it)", !("additionalProperties" in r.schema));
  ok("gemini drops prefixItems (no tuple form in Schema)",
    !("prefixItems" in r.schema.properties.pair));
})();

// --- Gemini: `type` + `anyOf` together makes the SDK throw ------------------
(function () {
  var r = E.toGemini({ type: "object", anyOf: [{ type: "string" }] });
  ok("gemini blocks type+anyOf co-population", r.ledger.some(function (l) {
    return l.op === "!" && l.msg.indexOf("anyOf cannot be both populated") !== -1;
  }));
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

// The output_format path is now an explicit target (`--to anthropic-json`);
// `toAnthropic(s)` alone means tools[].input_schema, where NO transform runs.
function toAnthropicJSON(s) { return E.toAnthropic(s, true); }

// --- Anthropic: the two paths, pinned to @anthropic-ai/sdk@0.116.0 ----------
// Every assertion below was measured by running the input through the vendor's
// own `lib/transform-json-schema.js`, not read off a doc page.

// A root `$ref` + `definitions` (verbatim zod-to-json-schema output) is the
// worst input on the output_format path: the transformer returns early on
// `$ref`, so the SDK reduces it to exactly {"$ref":"#/definitions/Ticket"} —
// dangling pointer, whole schema gone, and nothing throws.
(function () {
  var r = toAnthropicJSON({
    $ref: "#/definitions/Ticket",
    definitions: {
      Ticket: {
        type: "object",
        properties: { title: { type: "string" }, priority: { type: "string", enum: ["low", "high"] } },
        required: ["title", "priority"]
      }
    }
  });
  ok("anthropic inlines a root $ref instead of shipping a dangling pointer",
    r.schema.$ref === undefined && r.schema.type === "object");
  ok("anthropic recovers the properties the SDK would have dropped",
    !!r.schema.properties && !!r.schema.properties.title);
  ok("anthropic renames definitions to $defs", r.schema.definitions === undefined);
})();

// The transformer throws on any node with no `type`. A bare enum is the most
// common way to hit it, and the type is recoverable from the members.
(function () {
  var r = toAnthropicJSON({
    type: "object",
    properties: { lvl: { enum: ["low", "high"] }, n: { enum: [1, 2] } }
  });
  ok("anthropic infers string type for a bare enum", r.schema.properties.lvl.type === "string");
  ok("anthropic infers integer type for a numeric enum", r.schema.properties.n.type === "integer");
  ok("anthropic explains the throw it prevents", has(r.ledger, "must have a type defined"));
})();

// A typeless node with nothing to infer from is a genuine blocker.
(function () {
  var r = toAnthropicJSON({ type: "object", properties: { x: { description: "mystery" } } });
  ok("anthropic reports an un-inferable typeless node as a blocker",
    r.ledger.some(function (l) { return l.op === "!"; }));
})();

// Demotion, the finding this whole path exists for: `enum` on a typed node is
// NOT stripped and NOT enforced — the SDK appends it to `description`.
(function () {
  var r = toAnthropicJSON({
    type: "object",
    properties: {
      lvl: { type: "string", enum: ["low", "high"] },
      title: { type: "string", minLength: 3, maxLength: 80 },
      tags: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5 },
      mail: { type: "string", format: "email" },
      slug: { type: "string", format: "slug" }
    }
  });
  ok("anthropic keeps enum rather than stripping it",
    r.schema.properties.lvl.enum.length === 2);
  ok("anthropic flags enum as unenforced on the output_format path",
    r.ledger.some(function (l) { return l.path === "root.lvl" && l.advisory && l.msg.indexOf("`enum`") === 0; }));
  ok("anthropic flags minLength/maxLength as unenforced",
    r.ledger.some(function (l) { return l.msg.indexOf("`minLength`") === 0; }) &&
    r.ledger.some(function (l) { return l.msg.indexOf("`maxLength`") === 0; }));
  ok("anthropic flags minItems 2 (only 0 and 1 survive)",
    r.ledger.some(function (l) { return l.msg.indexOf("`minItems`") === 0; }));
  ok("anthropic does NOT flag a supported format",
    !r.ledger.some(function (l) { return l.path === "root.mail" && l.msg.indexOf("`format`") === 0; }));
  ok("anthropic DOES flag an unsupported format",
    r.ledger.some(function (l) { return l.path === "root.slug" && l.msg.indexOf("`format`") === 0; }));
  // A gate that fails CI on these would be the #312 false-failure bug again:
  // the schema is legal, the constraints just are not enforced on one path.
  ok("every unenforced-keyword note is advisory so --check stays green",
    r.ledger.filter(function (l) { return l.msg.indexOf("NOT enforced") !== -1; })
      .every(function (l) { return l.advisory === true; }));
})();

// Anthropic must NOT inherit OpenAI's all-keys-required rule: the transformer
// passes `required` through exactly as given.
(function () {
  var r = toAnthropicJSON({
    type: "object",
    properties: { a: { type: "string" }, b: { type: "string" } },
    required: ["a"]
  });
  ok("anthropic leaves a partial required list alone",
    r.schema.required.length === 1 && r.schema.required[0] === "a");
  ok("anthropic does not force additionalProperties on the tools path",
    r.schema.additionalProperties === undefined);
})();

// The shared helpers (normalizeDefs / inlineRootRef / resolveRefSiblings) are
// used by more than one provider and used to hardcode OpenAI's wording, so the
// Anthropic path printed "OpenAI requires the root to be an object schema" to
// users. Every reason a provider gives must name that provider.
(function () {
  var r = toAnthropicJSON({
    $ref: "#/definitions/T",
    definitions: {
      T: { type: "object", properties: { a: { $ref: "#/definitions/U", description: "d" } }, required: ["a"] },
      U: { type: "string" }
    }
  });
  ok("anthropic ledger never cites OpenAI",
    !r.ledger.some(function (l) { return /OpenAI/.test(l.msg); }));
  ok("anthropic ledger never links an OpenAI doc",
    !r.ledger.some(function (l) { return /openai/.test(l.ruleUrl || ""); }));
  var g = E.toGemini({ $ref: "#/definitions/T", definitions: { T: { type: "object", properties: { a: { type: "string" } } } } });
  ok("gemini ledger never cites OpenAI either",
    !g.ledger.some(function (l) { return /OpenAI/.test(l.msg); }));
})();

// `oneOf` is rewritten to `anyOf` by the transformer itself.
(function () {
  var r = toAnthropicJSON({
    type: "object",
    properties: { v: { oneOf: [{ type: "string" }, { type: "number" }] } }
  });
  ok("anthropic rewrites oneOf to anyOf like the SDK does",
    Array.isArray(r.schema.properties.v.anyOf) && r.schema.properties.v.oneOf === undefined);
})();

// Both tuple spellings reach the transformer with no `type` and throw.
(function () {
  var homo = toAnthropicJSON({
    type: "object",
    properties: { bbox: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }] } }
  });
  ok("anthropic collapses a homogeneous tuple losslessly",
    homo.schema.properties.bbox.items.type === "number" &&
    homo.schema.properties.bbox.minItems === 2 && homo.schema.properties.bbox.maxItems === 2);

  var hetero = toAnthropicJSON({
    type: "object",
    properties: { pair: { type: "array", items: [{ type: "string" }, { type: "number" }] } }
  });
  ok("anthropic blocks a heterogeneous tuple", hetero.ledger.some(function (l) { return l.op === "!"; }));
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
// Idempotence is a property of the SCHEMA, and this test used to check it via
// an empty ledger, which conflates the two. An advisory is a statement about
// the input that stays true however many times you look at it, so it MUST
// repeat — the thing that must not repeat is an EDIT. Both halves are asserted
// now, and the schema half is stricter than the old proxy was.
["openai", "anthropic", "gemini"].forEach(function (provider) {
  var once = E.convert(ZOD_V3, provider, { mode: "schema" });
  var twice = E.convert(once.schema, provider, { mode: "schema" });
  var edits = twice.ledger.filter(function (l) { return l.op !== "=" && !l.advisory; });
  ok(provider + " conversion is idempotent", edits.length === 0);
  ok(provider + " second pass returns a byte-identical schema",
    JSON.stringify(twice.schema) === JSON.stringify(once.schema));
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

// --- oneOf -> anyOf is CONDITIONAL on provable exclusivity ------------------
// `oneOf` = exactly one branch matches; `anyOf` = at least one. Rewriting when
// the branches can BOTH match silently widens the schema. openai@7.4.0's
// `helpers/standard-schema.js` proves exclusivity first and THROWS when it
// cannot. The old unconditional rewrite happened to survive its own test only
// because that test used `string|integer`, which is disjoint by luck.
function blockers(r) {
  return r.ledger.filter(function (l) { return l.op === "!" && !l.advisory; });
}
(function () {
  var overlapping = E.toOpenAI({
    type: "object",
    properties: { v: { oneOf: [{ type: "string" }, { type: "string", minLength: 2 }] } }
  });
  var v = overlapping.schema.properties.v;
  ok("openai does NOT rewrite a non-exclusive oneOf", Array.isArray(v.oneOf) && v.anyOf === undefined);
  ok("openai blocks a non-exclusive oneOf", blockers(overlapping).length > 0);
  ok("openai leaves the blocked oneOf visible to fix", Array.isArray(v.oneOf) && v.oneOf.length === 2);
  ok("openai names the vendor's own remedy",
    has(overlapping.ledger, "discriminator"));

  // integer is a subset of number, so these two overlap.
  var subset = E.toOpenAI({
    type: "object",
    properties: { v: { oneOf: [{ type: "integer" }, { type: "number" }] } }
  });
  ok("openai treats integer|number as overlapping", blockers(subset).length > 0);

  // A discriminated union IS provable — but only when the discriminant is
  // REQUIRED on both branches. An optional discriminant proves nothing, since
  // an instance can omit it and satisfy both. Verified against the vendor:
  // dropping `required` here flips its verdict to "not provably mutually
  // exclusive", so this fixture must carry it.
  var disc = E.toOpenAI({
    type: "object",
    properties: {
      v: {
        oneOf: [
          { type: "object", properties: { kind: { const: "a" }, a: { type: "string" } }, required: ["kind", "a"] },
          { type: "object", properties: { kind: { const: "b" }, b: { type: "string" } }, required: ["kind", "b"] }
        ]
      }
    }
  });
  ok("openai still rewrites a discriminated oneOf",
    Array.isArray(disc.schema.properties.v.anyOf) && blockers(disc).length === 0);

  var optionalDiscriminant = E.toOpenAI({
    type: "object",
    properties: {
      v: {
        oneOf: [
          { type: "object", properties: { kind: { const: "a" }, a: { type: "string" } } },
          { type: "object", properties: { kind: { const: "b" }, b: { type: "string" } } }
        ]
      }
    }
  });
  ok("openai does not accept an OPTIONAL discriminant as proof",
    blockers(optionalDiscriminant).length > 0);
})();

// --- anyOf + oneOf siblings are a blocker, never a silent strip -------------
(function () {
  var r = E.toOpenAI({
    type: "object",
    properties: { v: { oneOf: [{ type: "string" }], anyOf: [{ type: "number" }] } }
  });
  ok("openai blocks anyOf+oneOf siblings", blockers(r).length > 0);
  ok("openai does not silently drop the sibling oneOf",
    Array.isArray(r.schema.properties.v.oneOf));
})();

// --- $id is root-only: nested $id is fatal ----------------------------------
// A flat keyword allowlist cannot express this — `$id` is legal at the root
// (it is in the SDK's own rootMetadata set) and fatal anywhere else.
(function () {
  var nested = E.toOpenAI({
    type: "object",
    properties: { v: { $ref: "#/$defs/A" } },
    $defs: { A: { $id: "https://x/a", type: "string" } }
  });
  ok("openai blocks a nested $id", blockers(nested).length > 0);
  ok("openai explains nested $id vs root $id", has(nested.ledger, "resource scope"));

  var rootOnly = E.toOpenAI({
    type: "object",
    $id: "https://x/root",
    properties: { v: { type: "string" } }
  });
  ok("openai keeps a ROOT $id and does not block it",
    rootOnly.schema.$id === "https://x/root" && blockers(rootOnly).length === 0);
})();

// --- an array must declare `items` ------------------------------------------
// Another obligation a presence/absence allowlist is blind to: `type: "array"`
// is allowed, but it is fatal without `items`.
(function () {
  var bare = E.toOpenAI({
    type: "object",
    properties: { v: { type: "array" } }
  });
  ok("openai blocks an array with no items", blockers(bare).length > 0);

  var withItems = E.toOpenAI({
    type: "object",
    properties: { v: { type: "array", items: { type: "string" } } }
  });
  ok("openai accepts an array that declares items", blockers(withItems).length === 0);
})();

// --- allOf is not flatly unsupported; the blanket strip deleted subschemas --
// `{allOf:[<object>], description:"..."}` is what Pydantic emits for a $ref'd
// model carrying a field description. Stripping `allOf` reduced it to
// `{"description":"..."}` — the whole shape gone, reported as a fix.
(function () {
  var singleton = E.toOpenAI({
    type: "object",
    properties: {
      f: { allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }], description: "d" }
    },
    required: ["f"]
  });
  var f = singleton.schema.properties.f;
  ok("openai flattens a single-member allOf", f.type === "object" && !!f.properties &&
    f.properties.a !== undefined && f.allOf === undefined);
  ok("openai keeps the wrapper annotation when flattening", f.description === "d");
  ok("openai does not blow away a single-member allOf", blockers(singleton).length === 0);

  var open = E.toOpenAI({
    type: "object",
    properties: {
      f: {
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "string" } }, required: ["b"] }
        ]
      }
    },
    required: ["f"]
  });
  var of = open.schema.properties.f;
  ok("openai merges an allOf of open objects", of.properties.a !== undefined && of.properties.b !== undefined);
  ok("openai unions required across merged allOf members",
    of.required.indexOf("a") !== -1 && of.required.indexOf("b") !== -1);

  // Closed members cannot be merged without changing Draft 7 validation, and
  // non-object members are unsupported outright — both are blockers, never a
  // silent strip.
  var closed = E.toOpenAI({
    type: "object",
    properties: {
      f: {
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false },
          { type: "object", properties: { b: { type: "string" } }, required: ["b"], additionalProperties: false }
        ]
      }
    },
    required: ["f"]
  });
  ok("openai blocks an unmergeable allOf of closed objects", blockers(closed).length > 0);
  ok("openai leaves the unmergeable allOf visible",
    Array.isArray(closed.schema.properties.f.allOf));

  var scalars = E.toOpenAI({
    type: "object",
    properties: { f: { allOf: [{ type: "string", minLength: 1 }, { type: "string", maxLength: 5 }] } },
    required: ["f"]
  });
  ok("openai blocks a multi-member allOf of non-objects", blockers(scalars).length > 0);
})();

// --- Anthropic diverges here, and the rule must NOT be ported ---------------
// `transformJSONSchema` rewrites oneOf -> anyOf with no exclusivity proof, so
// the same input that is a hard blocker for OpenAI is only a warning here.
(function () {
  var r = toAnthropicJSON({
    type: "object",
    properties: { v: { oneOf: [{ type: "string" }, { type: "string", minLength: 2 }] } }
  });
  ok("anthropic still rewrites a non-exclusive oneOf",
    Array.isArray(r.schema.properties.v.anyOf));
  ok("anthropic warns about the widening", has(r.ledger, "at least one"));
  ok("anthropic does NOT fail the gate for it", blockers(r).length === 0);

  var both = toAnthropicJSON({
    type: "object",
    properties: { v: { oneOf: [{ type: "string" }], anyOf: [{ type: "number" }] } }
  });
  ok("anthropic warns that a co-existing oneOf is discarded", has(both.ledger, "DISCARDS"));
  ok("anthropic keeps that as advisory too", blockers(both).length === 0);
})();

// --- Gemini inlines $refs rather than emitting an empty schema --------------
(function () {
  // ZOD_V3 is verbatim zod-to-json-schema output, so it HAS a top-level
  // `$schema`. That key makes @google/genai (JS) route to `responseJsonSchema`
  // — but ONLY that client, so the path is now an explicit argument rather
  // than something read off the schema (#319). These assertions are about the
  // `responseJsonSchema` dialect, so they ask for it.
  var keep = E.toGemini(ZOD_V3, true);
  ok("gemini preserves $schema (it is the routing switch)", keep.schema.$schema === ZOD_V3.$schema);
  ok("gemini leaves the $schema path's $ref intact",
    JSON.stringify(keep.schema).indexOf("$ref") !== -1);
  ok("gemini explains the responseJsonSchema routing", keep.ledger.some(function (l) {
    return l.msg.indexOf("responseJsonSchema") !== -1;
  }));

  // $ref sub-schemas may carry no non-`$` siblings on this path.
  var sib = E.toGemini({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { u: { $ref: "#/$defs/U", description: "the user" } },
    $defs: { U: { type: "object", properties: { n: { type: "string" } } } }
  }, true);
  ok("gemini drops non-$ siblings of a $ref on the $schema path",
    !("description" in sib.schema.properties.u) && sib.schema.properties.u.$ref === "#/$defs/U");

  // Cycles are allowed, but only inside NON-required properties.
  var cyc = E.toGemini({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { root: { $ref: "#/$defs/Node" } },
    required: ["root"],
    $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } }
  }, true);
  ok("gemini flags a required cyclic property", cyc.ledger.some(function (l) {
    return l.op === "!" && l.msg.indexOf("cyclic") !== -1;
  }));
  var cycOk = E.toGemini({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { root: { $ref: "#/$defs/Node" } },
    $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } }
  }, true);
  ok("gemini allows a cycle in a non-required property",
    !cycOk.ledger.some(function (l) { return l.op === "!"; }));
  // "Sent verbatim" is the TRANSPORT, not acceptance: the accepted property
  // list for `responseJsonSchema` (enumerated on the Python SDK's
  // `response_json_schema` field) has no `minLength`/`maxLength`/`default`.
  // But that field says the full JSON Schema MAY BE SENT and merely that not
  // all features are supported — i.e. unsupported keywords are IGNORED, not
  // rejected (contrast OpenAI, whose doc says "you will receive an error").
  // So we KEEP them and warn that they are unenforced; deleting a keyword the
  // request tolerates would destroy a real constraint to buy nothing.
  ok("gemini keeps minLength on the $schema path", keep.schema.$defs.Ticket.properties.title.minLength === 1);
  ok("gemini warns minLength is unenforced there", keep.ledger.some(function (l) {
    return l.advisory && l.msg.indexOf("minLength") !== -1 && l.msg.indexOf("NOT enforced") !== -1;
  }));
  ok("gemini keeps default on the $schema path", keep.schema.$defs.Ticket.properties.priority["default"] === "low");
  // ...and an unenforced keyword must not fail a CI gate.
  ok("unenforced-keyword notes are advisory, not changes",
    keep.ledger.filter(function (l) { return l.op !== "=" && !l.advisory; })
      .every(function (l) { return l.msg.indexOf("definitions") !== -1; }));
  // ...but keeps what that path DOES accept, incl. additionalProperties, which
  // the narrow proto path drops. The two subsets are complementary.
  ok("gemini keeps additionalProperties on the $schema path",
    keep.schema.$defs.Ticket.additionalProperties === false);
  ok("gemini keeps minimum/maximum on the $schema path",
    keep.schema.$defs.Ticket.properties.score.minimum === 0);
  // `definitions` is not in the accepted list — but deleting it would orphan
  // every $ref, so it must be RENAMED to $defs and the refs repointed.
  ok("gemini renames definitions -> $defs rather than deleting the bag",
    !!keep.schema.$defs && !keep.schema.definitions &&
    keep.schema.$ref === "#/$defs/Ticket");

  // The strongest guard against re-introducing the strip. This is verbatim
  // `z.toJSONSchema()` output from zod 4.4.3 — the generator our audience uses,
  // and one that ALWAYS emits `$schema`, so it always lands on this path. Every
  // constraint here (minLength/maxLength/pattern/minimum/maximum/minItems) is
  // absent from the `responseJsonSchema` accepted list, so a strip-based
  // implementation would silently gut all of them. The schema must come back
  // BYTE-IDENTICAL, and the only ledger output may be advisory.
  var ZOD_V4 = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      title: { type: "string", minLength: 3, maxLength: 80, description: "Headline" },
      slug: { type: "string", pattern: "^[a-z-]+$" },
      score: { type: "number", minimum: 0, maximum: 100 },
      tags: { minItems: 1, type: "array", items: { type: "string" } },
      status: { type: "string", enum: ["draft", "live"] }
    },
    required: ["title", "slug", "score", "tags", "status"],
    additionalProperties: false
  };
  var z4 = E.toGemini(JSON.parse(JSON.stringify(ZOD_V4)), true);
  ok("gemini is a NO-OP on real zod-v4 output (nothing stripped)",
    JSON.stringify(z4.schema) === JSON.stringify(ZOD_V4));
  ok("gemini reports zod-v4 constraints as advisory only (CI stays green)",
    z4.ledger.length > 0 &&
    z4.ledger.every(function (l) { return l.op === "=" && l.advisory; }));
  ok("gemini names each unenforced zod-v4 constraint",
    ["minLength", "maxLength", "pattern"].every(function (kw) {
      return z4.ledger.some(function (l) { return l.advisory && l.msg.indexOf(kw) !== -1; });
    }));

  // Same generator output with `$schema` removed = the narrow proto path, where
  // #311's inlining fix must still hold (that bug emptied the whole schema).
  var noDollar = JSON.parse(JSON.stringify(ZOD_V3));
  delete noDollar.$schema;
  var r = E.toGemini(noDollar);
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

// --- Gemini tuples: the false pass the other two providers had already fixed --
// `items` is in GEMINI_ALLOWED, so an ARRAY in `items` used to pass the
// allowlist untouched and the tool reported "Valid for gemini" for a schema
// `types.Schema` (extra="forbid") rejects outright. This is the exact shape the
// Vercel AI SDK puts on the wire for `z.tuple()`.
(function () {
  var AI_SDK_TUPLE = {
    type: "object",
    properties: {
      bbox: { type: "array", items: [{ type: "number" }, { type: "number" }, { type: "number" }, { type: "number" }] }
    },
    required: ["bbox"]
  };

  var copy = function (o) { return JSON.parse(JSON.stringify(o)); };

  var r = E.toGemini(copy(AI_SDK_TUPLE));
  var bbox = r.schema.properties.bbox;
  ok("gemini collapses a homogeneous array-form tuple",
    !Array.isArray(bbox.items) && bbox.items.type === "number");
  ok("gemini keeps the fixed length via minItems/maxItems",
    bbox.minItems === 4 && bbox.maxItems === 4);
  ok("gemini array-form tuple is NOT a silent pass",
    r.ledger.some(function (l) { return l.op !== "=" && !l.advisory; }));

  // prefixItems used to be deleted outright, which threw away the element type.
  var p = E.toGemini({
    type: "object",
    properties: { xs: { type: "array", prefixItems: [{ type: "string" }, { type: "string" }] } },
    required: ["xs"]
  });
  ok("gemini recovers the element type from a homogeneous prefixItems",
    p.schema.properties.xs.items && p.schema.properties.xs.items.type === "string");

  var het = E.toGemini({
    type: "object",
    properties: { pair: { type: "array", items: [{ type: "string" }, { type: "number" }] } },
    required: ["pair"]
  });
  ok("gemini heterogeneous tuple is a blocker, not a silent rewrite",
    het.ledger.some(function (l) { return l.op === "!" && l.msg.indexOf("differently-typed") !== -1; }));
  ok("gemini leaves a blocked tuple visible",
    Array.isArray(het.schema.properties.pair.items));

  // Path A ($schema present) routes to responseJsonSchema, whose accepted list
  // names `prefixItems` — so there the tuple survives losslessly instead.
  var jsonPath = copy(AI_SDK_TUPLE);
  jsonPath.$schema = "http://json-schema.org/draft-07/schema#";
  var j = E.toGemini(jsonPath, true);
  ok("gemini JSON path rewrites array-form items to prefixItems",
    Array.isArray(j.schema.properties.bbox.prefixItems) &&
    j.schema.properties.bbox.prefixItems.length === 4 &&
    j.schema.properties.bbox.items === undefined);
})();

// --- Gemini numeric enum: the second false pass ------------------------------
// `Schema.enum` is declared `list[str]`, so {type:number, enum:[15]} is
// REJECTED by the oracle ("enum.0: Input should be a valid string") — the live
// 400 is `enum: only allowed for STRING type`. We used to wave it through.
// This is exactly what `z.literal(15)` emits through the Vercel AI SDK.
(function () {
  var r = E.toGemini({
    type: "object",
    properties: { sceneCount: { type: "number", enum: [15] } },
    required: ["sceneCount"]
  });
  var n = r.schema.properties.sceneCount;
  ok("gemini stringifies a numeric enum", n.enum.length === 1 && n.enum[0] === "15");
  ok("gemini sets format:enum, the documented carrier", n.format === "enum");
  ok("gemini keeps the numeric type", n.type === "number");
  ok("gemini numeric enum is not a silent pass",
    r.ledger.some(function (l) { return l.op !== "=" && !l.advisory; }));

  // A plain string enum is already accepted and must be left alone.
  var s = E.toGemini({
    type: "object",
    properties: { v: { type: "string", enum: ["foo", "bar"] } },
    required: ["v"]
  });
  ok("gemini leaves a string enum untouched",
    s.schema.properties.v.enum[0] === "foo" && s.schema.properties.v.format === undefined);

  // The JSON-Schema path accepts "enum (for strings and numbers)" verbatim.
  var j = E.toGemini({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { n: { type: "number", enum: [15] } },
    required: ["n"]
  }, true);
  ok("gemini JSON path leaves a numeric enum numeric",
    j.schema.properties.n.enum[0] === 15);
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

// --- OpenAI non-strict (Realtime) is a SEPARATE surface, not a second opinion ---
// openai@7.4.0 helpers/zod.js: zodRealtimeFunction uses zodV3/V4ToNonStrictJsonSchema
// (never toStrictJsonSchema) and omits `strict`, because RealtimeFunctionTool has no
// such field. "Only a subset of JSON Schema is supported when `strict` is `true`" is
// therefore a claim about strict mode, not about OpenAI — so nothing may be stripped.
(function () {
  var SRC = {
    type: "object",
    properties: {
      name: { type: "string" },
      tags: { type: "array", uniqueItems: true, items: { type: "string" } }
    },
    required: ["name"]
  };
  var rt = E.convert(SRC, "openai-realtime", { mode: "schema" });
  var strict = E.convert(SRC, "openai", { mode: "schema" });

  ok("openai-realtime leaves the schema byte-identical",
    JSON.stringify(rt.schema) === JSON.stringify(SRC));
  ok("openai-realtime keeps uniqueItems, which strict mode strips",
    JSON.stringify(rt.schema).indexOf("uniqueItems") !== -1 &&
    JSON.stringify(strict.schema).indexOf("uniqueItems") === -1);
  ok("openai-realtime does NOT force optional props into required",
    rt.schema.required.length === 1);
  ok("openai-realtime does NOT force additionalProperties:false",
    rt.schema.additionalProperties === undefined);
  ok("openai-realtime names the kept keyword so the divergence is visible",
    has(rt.ledger, "`uniqueItems` is kept"));
  ok("openai-realtime warns constraints are not grammar-enforced",
    has(rt.ledger, "not grammar-constrained"));
  ok("openai-realtime reports no substantive change",
    rt.ledger.filter(function (l) { return !l.advisory && l.op !== "="; }).length === 0);
  ok("openai-realtime is idempotent",
    E.convert(rt.schema, "openai-realtime", { mode: "schema" }).ledger
      .filter(function (l) { return !l.advisory && l.op !== "="; }).length === 0);

  // The gate must not go red on an advisory, whatever op it carries. A `!` that is
  // also advisory is a contradiction; letting one through red-flags a valid schema.
  ok("no advisory entry is ever a blocker",
    rt.ledger.filter(function (l) { return l.op === "!" && !l.advisory; }).length === 0);
})();

// --- LiteLLM's ref spelling ------------------------------------------------
// Pinned to the VERBATIM wire payload captured from litellm==1.96.0 by
// intercepting httpx, from an ordinary Pydantic model. LiteLLM passes
// `ref_template="/$defs/{model}"` to `model_json_schema()`, so `/$defs/X` — not
// `#/$defs/X` — is the default shape for every Python caller doing
// `response_format=<Model>` against Anthropic.
//
// Before the fix this was not merely unfixed. Every rule matches `#/$defs/`, so
// the orphan-`$defs` pruner saw no reference to `Priority`, DELETED the
// definition, and left the `$ref` pointing at nothing — while `inlineRootRef`
// no-oped, so a root `$ref` was certified "already valid" (exit 0). That is the
// exact shape the SDK reduces to a bare dangling pointer with the whole schema
// gone. Verified against @anthropic-ai/sdk@0.116.0's transformJSONSchema.
var LITELLM_ANTHROPIC = {
  type: "object",
  $defs: {
    Priority: {
      properties: {
        level: { description: "how urgent", pattern: "^(low|high)$", title: "Level", type: "string" },
        score: { maximum: 10, minimum: 1, title: "Score", type: "integer" }
      },
      required: ["level", "score"], title: "Priority", type: "object"
    }
  },
  properties: {
    title: { description: "short title", maxLength: 80, minLength: 3, title: "Title", type: "string" },
    priority: { $ref: "/$defs/Priority" },
    assignee: { anyOf: [{ type: "string" }, { type: "null" }], "default": null, title: "Assignee" }
  },
  required: ["title", "priority"], title: "Ticket"
};

(function () {
  var r = toAnthropicJSON(JSON.parse(JSON.stringify(LITELLM_ANTHROPIC)));
  ok("litellm's /$defs/ ref is repointed to a real local pointer",
    r.schema.properties.priority.$ref === "#/$defs/Priority");
  // The regression that mattered most: the definition used to be deleted.
  ok("the $defs bag survives instead of being pruned as orphaned",
    !!r.schema.$defs && !!r.schema.$defs.Priority);
  ok("the repoint is reported, not done silently",
    has(r.ledger, "/$defs/") && has(r.ledger, "ref_template"));
  // Coverage inside $defs was lost as a CONSEQUENCE of the deletion — the walker
  // was always correct, the bag was simply gone by the time it ran.
  ok("demote-to-prose advisories now reach inside $defs",
    r.ledger.some(function (l) { return l.path.indexOf("$defs.Priority") === 0; }));
})();

// A root `$ref` in litellm's spelling: the false pass that started this.
(function () {
  var r = toAnthropicJSON({
    $ref: "/$defs/Priority",
    $defs: { Priority: { type: "object", properties: { level: { type: "string" } }, required: ["level"] } }
  });
  ok("a root $ref in litellm's spelling is inlined, not passed as valid",
    r.schema.$ref === undefined && r.schema.type === "object");
  ok("the inlined root keeps the real properties",
    !!r.schema.properties && !!r.schema.properties.level);
})();

// Conditional, not unconditional (#318): a `/$defs/X` with no local `X` really
// IS external. Rewriting it would invent a pointer to something never there.
(function () {
  var r = E.toOpenAI({ type: "object", properties: { a: { $ref: "/$defs/Nowhere" } }, required: ["a"] });
  ok("an unresolvable external ref is left alone, not rewritten",
    r.schema.properties.a.$ref === "/$defs/Nowhere");
  ok("an unresolvable external ref is a blocker, not a silent pass",
    r.ledger.some(function (l) { return l.op === "!" && !l.advisory && has([l], "outside this document"); }));
})();

// All three providers share the normalisation — the #314 lesson (a fix to a
// shared code path is not done until every provider is re-probed).
(function () {
  ["toOpenAI", "toAnthropic", "toGemini"].forEach(function (fn) {
    var r = E[fn]({ type: "object", properties: { p: { $ref: "/$defs/P" } },
      $defs: { P: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } },
      required: ["p"] });
    var str = JSON.stringify(r.schema);
    ok(fn + " repoints litellm's ref spelling", str.indexOf('"/$defs/P"') === -1);
  });
})();

// --- #321 Instructor: Anthropic's two paths are two TARGETS -----------------
// Captured verbatim from instructor==1.15.4 + anthropic SDK by intercepting
// httpx (`Mode.ANTHROPIC_TOOLS`, the default) on an ordinary Pydantic model.
// Re-verified against @anthropic-ai/sdk@0.116.0: `betaTool()` returns this
// byte-identical, and the ONLY input that makes it throw is a root that is not
// `type: "object"`. The old single `anthropic` target exited 1 on this payload.
var INSTRUCTOR_ANTHROPIC = {
  "$defs": {
    "Priority": {
      "enum": [
        "low",
        "high"
      ],
      "title": "Priority",
      "type": "string"
    },
    "Tag": {
      "properties": {
        "name": {
          "maxLength": 20,
          "minLength": 1,
          "title": "Name",
          "type": "string"
        },
        "score": {
          "maximum": 1.0,
          "minimum": 0.0,
          "title": "Score",
          "type": "number"
        }
      },
      "required": [
        "name",
        "score"
      ],
      "title": "Tag",
      "type": "object"
    }
  },
  "description": "A support ticket.",
  "properties": {
    "title": {
      "description": "Short title",
      "maxLength": 80,
      "title": "Title",
      "type": "string"
    },
    "priority": {
      "$ref": "#/$defs/Priority"
    },
    "tags": {
      "items": {
        "$ref": "#/$defs/Tag"
      },
      "title": "Tags",
      "type": "array"
    },
    "bbox": {
      "maxItems": 4,
      "minItems": 4,
      "prefixItems": [
        {
          "type": "integer"
        },
        {
          "type": "integer"
        },
        {
          "type": "integer"
        },
        {
          "type": "integer"
        }
      ],
      "title": "Bbox",
      "type": "array"
    },
    "assignee": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "default": null,
      "title": "Assignee"
    },
    "retries": {
      "default": 0,
      "title": "Retries",
      "type": "integer"
    }
  },
  "required": [
    "title",
    "priority",
    "tags",
    "bbox"
  ],
  "title": "Ticket",
  "type": "object"
};

(function () {
  var src = JSON.parse(JSON.stringify(INSTRUCTOR_ANTHROPIC));
  var r = E.toAnthropic(src);
  var substantive = r.ledger.filter(function (l) { return !l.advisory && l.op !== "="; });
  ok("anthropic tools path reports no substantive change on the real Instructor payload",
    substantive.length === 0);
  ok("anthropic tools path keeps the tuple intact (sent verbatim)",
    Array.isArray(r.schema.properties.bbox.prefixItems) &&
    r.schema.properties.bbox.prefixItems.length === 4);
  ok("anthropic tools path keeps maxLength",
    r.schema.properties.title.maxLength === 80);
  ok("anthropic tools path keeps $defs rather than inlining",
    r.schema.$defs && r.schema.$defs.Tag !== undefined);
  ok("anthropic tools path emits the schema byte-identical",
    JSON.stringify(r.schema) === JSON.stringify(INSTRUCTOR_ANTHROPIC));
  ok("anthropic tools path says the schema goes on the wire verbatim",
    has(r.ledger, "byte-identical"));
  ok("anthropic tools path points at anthropic-json for the other path",
    has(r.ledger, "--to anthropic-json"));
})();

(function () {
  // Same file, other target: the two paths must DISAGREE, which is the whole
  // reason the path is an explicit parameter rather than an inference.
  var tools = E.toAnthropic(JSON.parse(JSON.stringify(INSTRUCTOR_ANTHROPIC)));
  var json = toAnthropicJSON(JSON.parse(JSON.stringify(INSTRUCTOR_ANTHROPIC)));
  ok("the two anthropic targets disagree on the same schema",
    JSON.stringify(tools.schema) !== JSON.stringify(json.schema));
  ok("anthropic-json collapses the tuple the tools path keeps",
    json.schema.properties.bbox.prefixItems === undefined &&
    json.schema.properties.bbox.items !== undefined);
  ok("anthropic-json still reports maxLength as demoted to prose",
    has(json.ledger, "NOT enforced on the `output_format`"));
  ok("anthropic tools path does NOT emit the demote-to-prose notes",
    !has(tools.ledger, "NOT enforced on the `output_format`"));
})();

(function () {
  // Real blockers survive on the tools path — they are just a much shorter list.
  var rootRef = E.toAnthropic({ $ref: "#/$defs/T",
    $defs: { T: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } } });
  ok("anthropic tools path still inlines a root $ref (betaTool needs a type)",
    rootRef.schema.type === "object" && rootRef.schema.$ref === undefined);
  ok("anthropic tools path cites the betaTool throw, not the transformer",
    has(rootRef.ledger, "must be an object, but got undefined"));

  var strRoot = E.toAnthropic({ type: "string" });
  ok("anthropic tools path still blocks a non-object root",
    strRoot.ledger.some(function (l) { return l.op === "!" && !l.advisory; }));

  // ...and the edits the tools path must NOT make, because nothing transforms.
  var defs = E.toAnthropic({ type: "object", properties: { p: { $ref: "#/definitions/X" } },
    definitions: { X: { type: "string" } }, required: ["p"] });
  ok("anthropic tools path leaves a draft-07 definitions bag alone",
    defs.schema.definitions !== undefined && defs.schema.$defs === undefined);

  var one = E.toAnthropic({ type: "object", properties: {
    u: { oneOf: [{ type: "string" }, { type: "string", minLength: 2 }] } } });
  ok("anthropic tools path does not rewrite oneOf to anyOf",
    Array.isArray(one.schema.properties.u.oneOf) && one.schema.properties.u.anyOf === undefined);
})();

(function () {
  ["anthropic", "anthropic-json"].forEach(function (p) {
    var once = E.convert(JSON.parse(JSON.stringify(INSTRUCTOR_ANTHROPIC)), p);
    var twice = E.convert(JSON.parse(JSON.stringify(once.schema)), p);
    ok(p + " is idempotent on the Instructor payload",
      JSON.stringify(once.schema) === JSON.stringify(twice.schema));
  });
})();

// --- #322: non-strict is a CONDITION, not one API surface --------------------
//
// Verbatim wire payload captured from instructor==1.15.4 (Mode.TOOLS, the default)
// via an intercepted httpx.Client.send. Instructor omits `strict` on every OpenAI
// path — including the deprecated Mode.TOOLS_STRICT — so this is the schema a very
// large Python audience actually sends, and `--to openai` proposed four edits to it.
var INSTRUCTOR_OPENAI = {
  type: "object",
  properties: {
    title: { description: "Short title", maxLength: 80, title: "Title", type: "string" },
    priority: { default: "low", pattern: "^(low|high)$", title: "Priority", type: "string" },
    score: { maximum: 100, minimum: 0, title: "Score", type: "integer" },
    bbox: {
      maxItems: 4, minItems: 4, title: "Bbox", type: "array",
      prefixItems: [{ type: "integer" }, { type: "integer" },
                    { type: "integer" }, { type: "integer" }]
    },
    tags: { items: { type: "string" }, title: "Tags", type: "array" },
    assignee: { anyOf: [{ type: "string" }, { type: "null" }], default: null, title: "Assignee" }
  },
  required: ["bbox", "score", "tags", "title"]
};

// A missing target makes convert() return {ok:false} with no schema. Reading
// through that would crash the file and hide every assertion below it, so these
// blocks navigate defensively — a failure must report, not abort the suite.
function at(obj, path) {
  return path.split(".").reduce(function (o, k) {
    return o && typeof o === "object" ? o[k] : undefined;
  }, obj);
}

(function () {
  var input = JSON.parse(JSON.stringify(INSTRUCTOR_OPENAI));
  var r = E.convert(JSON.parse(JSON.stringify(input)), "openai-nonstrict");

  ok("openai-nonstrict is a registered target", r.ok === true);
  ok("openai-nonstrict passes the Instructor payload through byte-identical",
    JSON.stringify(r.schema) === JSON.stringify(input));
  ok("openai-nonstrict keeps the tuple strict mode has no form for",
    Array.isArray(at(r, "schema.properties.bbox.prefixItems")));
  ok("openai-nonstrict does not force every property required",
    (at(r, "schema.required") || []).length === 4);
  ok("openai-nonstrict does not add additionalProperties:false",
    !!r.schema && !("additionalProperties" in r.schema));

  // The reason non-strict applies differs between the two targets, and the reader
  // needs the true one: on Realtime there is no field; elsewhere it is simply unset.
  ok("openai-nonstrict says strict is absent or false, not that the field is missing",
    has(r.ledger, "`strict` is absent or false"));
  var rt = E.convert(JSON.parse(JSON.stringify(input)), "openai-realtime");
  ok("openai-realtime still says the surface has no strict field",
    has(rt.ledger, "has no `strict` field"));
  ok("the two non-strict targets produce the SAME schema, differing only in wording",
    JSON.stringify(rt.schema) === JSON.stringify(r.schema));

  // Each target names its sibling, the way the Anthropic and Gemini pairs do.
  ok("openai-nonstrict tells you how to get enforcement", has(r.ledger, "--to openai"));
  ok("openai-nonstrict warns that some clients omit strict for you",
    has(r.ledger, "Mode.TOOLS_STRICT"));
  ok("openai-realtime does not claim strict is available on that surface",
    has(rt.ledger, "no enforced"));

  // Advisory only: a valid schema must not fail a CI gate (#317's property).
  ok("openai-nonstrict raises no non-advisory blocker",
    !!r.ledger && r.ledger.every(function (l) { return l.op !== "!" || l.advisory === true; }));
})();

(function () {
  // The strict target must point at the escape hatch, but only when it changed
  // something, and never in a way that fails a gate that legitimately passed.
  var changed = E.toOpenAI(JSON.parse(JSON.stringify(INSTRUCTOR_OPENAI)));
  ok("openai names openai-nonstrict when it proposes strict-only edits",
    has(changed.ledger, "--to openai-nonstrict"));
  ok("that cross-reference is advisory, so it cannot fail --check",
    changed.ledger.filter(function (l) {
      return l.msg.indexOf("--to openai-nonstrict") !== -1;
    }).every(function (l) { return l.advisory === true; }));

  var clean = E.toOpenAI({
    type: "object", additionalProperties: false,
    properties: { a: { type: "string" } }, required: ["a"]
  });
  ok("openai stays silent about openai-nonstrict when it changed nothing",
    clean.ledger.length === 0);

  // The whole point of the split: the same file gets different answers.
  var strict = E.convert(JSON.parse(JSON.stringify(INSTRUCTOR_OPENAI)), "openai");
  var loose = E.convert(JSON.parse(JSON.stringify(INSTRUCTOR_OPENAI)), "openai-nonstrict");
  ok("openai and openai-nonstrict disagree on the same Instructor payload",
    JSON.stringify(strict.schema) !== JSON.stringify(loose.schema));

  ok("openai-nonstrict has its own doc URL, not the Realtime one",
    E.DOCS["openai-nonstrict"] && E.DOCS["openai-nonstrict"] !== E.DOCS["openai-realtime"]);
})();

(function () {
  ["openai-nonstrict", "openai-realtime"].forEach(function (p) {
    var once = E.convert(JSON.parse(JSON.stringify(INSTRUCTOR_OPENAI)), p);
    var twice = once.schema
      ? E.convert(JSON.parse(JSON.stringify(once.schema)), p) : {};
    ok(p + " is idempotent on the Instructor payload",
      !!once.schema && JSON.stringify(once.schema) === JSON.stringify(twice.schema));
  });
})();

// --- LangChain Python (#324): the vendor's TWO SDKs disagree about one schema ---
// Fixtures are verbatim generator output (#311): `Ticket.model_json_schema()` from
// pydantic 2.13.4, the exact object langchain-openai 1.4.2 / langchain-anthropic
// 1.5.4 / langchain-google-genai 4.3.2 put on the wire.
var LC_PY_PYDANTIC = {
  "$defs": {
    "Priority": {
      "description": "How urgent this is.",
      "properties": {
        "level": {
          "description": "one of low/med/high",
          "title": "Level",
          "type": "string"
        },
        "score": {
          "maximum": 100,
          "minimum": 0,
          "title": "Score",
          "type": "integer"
        }
      },
      "required": [
        "level",
        "score"
      ],
      "title": "Priority",
      "type": "object"
    }
  },
  "description": "A support ticket.",
  "properties": {
    "title": {
      "description": "Short summary",
      "maxLength": 120,
      "minLength": 2,
      "title": "Title",
      "type": "string"
    },
    "count": {
      "title": "Count",
      "type": "integer"
    },
    "kind": {
      "enum": [
        "bug",
        "feature"
      ],
      "title": "Kind",
      "type": "string"
    },
    "tags": {
      "items": {
        "type": "string"
      },
      "title": "Tags",
      "type": "array"
    },
    "bbox": {
      "description": "x1,y1,x2,y2",
      "maxItems": 4,
      "minItems": 4,
      "prefixItems": [
        {
          "type": "integer"
        },
        {
          "type": "integer"
        },
        {
          "type": "integer"
        },
        {
          "type": "integer"
        }
      ],
      "title": "Bbox",
      "type": "array"
    },
    "priority": {
      "$ref": "#/$defs/Priority"
    },
    "assignee": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "default": null,
      "title": "Assignee"
    }
  },
  "required": [
    "title",
    "count",
    "kind",
    "tags",
    "bbox",
    "priority"
  ],
  "title": "Ticket",
  "type": "object"
};

// A Pydantic RootModel/discriminated-union root, the shape where the two Anthropic
// SDKs produce different SCHEMAS rather than different warnings.
var LC_PY_ROOT_REF = {
  "$ref": "#/$defs/Ticket",
  "$defs": {
    "Ticket": {
      "type": "object", "title": "Ticket",
      "properties": { "kind": { "type": "string", "enum": ["bug", "feature"] } },
      "required": ["kind"]
    }
  }
};

(function () {
  ok("anthropic-json-python is a registered target",
    E.PROVIDERS ? E.PROVIDERS.indexOf("anthropic-json-python") !== -1
                : !!E.convert(JSON.parse(JSON.stringify(LC_PY_PYDANTIC)), "anthropic-json-python").ok);
  ok("anthropic-json-python has a doc URL", !!E.DOCS["anthropic-json-python"]);
})();

(function () {
  // `enum`: Python keeps it, JS stringifies it into `description`. Measured on
  // anthropic 0.110.0/0.116.0/0.121.0 vs @anthropic-ai/sdk@0.116.0 -- the same
  // version string, opposite behaviour, so this is not a skew that self-heals.
  var js = E.convert(JSON.parse(JSON.stringify(LC_PY_PYDANTIC)), "anthropic-json");
  var py = E.convert(JSON.parse(JSON.stringify(LC_PY_PYDANTIC)), "anthropic-json-python");

  ok("anthropic-json reports enum as unenforced",
    has(js.ledger, "`enum` is NOT enforced"));
  ok("anthropic-json points a Python caller at the other target",
    has(js.ledger, "--to anthropic-json-python"));
  ok("anthropic-json-python does NOT report enum as unenforced",
    !has(py.ledger, "`enum` is NOT enforced"));
  ok("anthropic-json-python says enum IS enforced",
    has(py.ledger, "`enum` IS enforced"));
  ok("anthropic-json-python warns that TypeScript callers lose the enum",
    has(py.ledger, "--to anthropic-json"));

  // Neither may fail a gate: `enum` is kept on both, so this is information,
  // not a defect (#317 -- an advisory that fails CI is the bug we keep shipping).
  // `ledgerOf` for the same reason `has()` is defensive: a converter that does
  // not exist returns {ok:false} with no ledger, and dereferencing it aborts the
  // file, hiding every assertion after it (#322).
  function ledgerOf(r) { return (r && Array.isArray(r.ledger)) ? r.ledger : []; }
  var enumRefs = ledgerOf(js).concat(ledgerOf(py)).filter(function (l) {
    return l.msg.indexOf("enum") !== -1 && l.msg.indexOf("anthropic-json") !== -1;
  });
  ok("every enum cross-reference is advisory on both targets",
    enumRefs.length > 0 && enumRefs.every(function (l) { return l.advisory === true; }));
})();

(function () {
  // The root `$ref`: the one case where the split changes the OUTPUT.
  var js = E.convert(JSON.parse(JSON.stringify(LC_PY_ROOT_REF)), "anthropic-json");
  var py = E.convert(JSON.parse(JSON.stringify(LC_PY_ROOT_REF)), "anthropic-json-python");

  // Defensive reads for the same reason as `has()`: a missing converter must
  // report a failure, not abort the file and hide every later assertion (#322).
  var jsS = (js && js.schema) || {}, pyS = (py && py.schema) || {};
  var pyL = (py && Array.isArray(py.ledger)) ? py.ledger : null;

  ok("anthropic-json inlines a root $ref (JS SDK drops $defs and loses everything)",
    jsS.$ref === undefined && jsS.type === "object");
  ok("anthropic-json-python leaves the root $ref alone",
    pyS.$ref === "#/$defs/Ticket" && !!(pyS.$defs && pyS.$defs.Ticket));
  ok("the two anthropic-json targets disagree on the same root-ref file",
    !!js && !!py && JSON.stringify(jsS) !== JSON.stringify(pyS));
  ok("anthropic-json-python needs no edit for a root $ref",
    !!pyL && pyL.every(function (l) { return l.advisory === true || l.op === "="; }));
  ok("anthropic-json-python still explains what a TypeScript caller must do",
    has(py.ledger, "run `--to anthropic-json`"));
})();

(function () {
  // draft-07 spelling is destroyed by BOTH SDKs (the Python early-return only
  // rescues `$defs`), so the fix there stays unconditional.
  var d7 = {
    "$ref": "#/definitions/T",
    "definitions": { "T": { "type": "object", "properties": { "a": { "type": "string" } } } }
  };
  var py = E.convert(JSON.parse(JSON.stringify(d7)), "anthropic-json-python");
  var pyS = (py && py.schema) || null;
  ok("anthropic-json-python still repairs a draft-07 root $ref",
    !!pyS && (pyS.$ref === undefined || !!pyS.$defs));
  ok("draft-07 root $ref is a real change, not an advisory, on the Python target",
    !!py && Array.isArray(py.ledger) &&
    py.ledger.some(function (l) { return l.advisory !== true; }));
})();

(function () {
  // The `$defs`-is-not-a-sibling fix must not stop any other target inlining.
  ["openai", "anthropic-json"].forEach(function (p) {
    var r = E.convert(JSON.parse(JSON.stringify(LC_PY_ROOT_REF)), p);
    ok(p + " still inlines a root $ref", r.schema && r.schema.$ref === undefined);
  });
  // gemini-json deliberately does NOT: `$ref`/`$defs` are on the accepted list
  // for `responseJsonSchema` (#314), so inlining there would be a pointless
  // rewrite. Pinned so the fix above cannot silently turn it into one.
  var g = E.convert(JSON.parse(JSON.stringify(LC_PY_ROOT_REF)), "gemini-json");
  ok("gemini-json still preserves a root $ref rather than inlining it",
    g.schema && g.schema.$ref === "#/$defs/Ticket" && !!g.schema.$defs);
  // A $ref with a REAL constraining sibling is still resolved on both.
  var sib = {
    type: "object",
    properties: { p: { "$ref": "#/$defs/X", description: "d" } },
    "$defs": { X: { type: "object", properties: { a: { type: "string" } } } }
  };
  var sibRes = E.convert(JSON.parse(JSON.stringify(sib)), "anthropic-json-python");
  var sp = sibRes && sibRes.schema && sibRes.schema.properties && sibRes.schema.properties.p;
  ok("anthropic-json-python still inlines a $ref carrying a description",
    !!sp && sp.$ref === undefined && sp.description === "d");
})();

(function () {
  ["anthropic-json", "anthropic-json-python"].forEach(function (p) {
    [["pydantic", LC_PY_PYDANTIC], ["root-ref", LC_PY_ROOT_REF]].forEach(function (pair) {
      var once = E.convert(JSON.parse(JSON.stringify(pair[1])), p);
      var twice = once.schema ? E.convert(JSON.parse(JSON.stringify(once.schema)), p) : {};
      ok(p + " is idempotent on the LangChain Python " + pair[0] + " schema",
        !!once.schema && JSON.stringify(once.schema) === JSON.stringify(twice.schema));
    });
  });
})();

// --- OpenAI's PYTHON SDK does not validate what its JS SDK refuses to send ---
// openai@7.4.0 (JS) runs every strict schema through toStrictJsonSchema(), which
// THROWS on an unrepresentable keyword before the request leaves the process.
// openai==2.53.0 (Python) runs _ensure_strict_json_schema(), which only ADDS
// `additionalProperties: false` and widens `required` -- it validates nothing --
// and then hardcodes `strict: True` at all three of its builders
// (lib/_parsing/_completions.py:286, lib/_parsing/_responses.py:47, lib/_tools.py:54).
// So the same model that fails at build time in TypeScript ships to production in
// Python and fails as a runtime 400. These fixtures are the VERBATIM output of
// openai.lib._pydantic.to_strict_json_schema() for ordinary Pydantic models.
var PY_SDK_BBOX = {"properties":{"bbox":{"maxItems":4,"minItems":4,"prefixItems":[{"type":"integer"},{"type":"integer"},{"type":"integer"},{"type":"integer"}],"title":"Bbox","type":"array"}},"required":["bbox"],"title":"BBox","type":"object","additionalProperties":false};
var PY_SDK_UNIQUE = {"properties":{"ids":{"items":{"type":"integer"},"title":"Ids","type":"array","uniqueItems":true}},"required":["ids"],"title":"UniqueList","type":"object","additionalProperties":false};
var PY_SDK_SHAPE = {"properties":{"kind":{"anyOf":[{"const":"circle","type":"string"},{"const":"square","type":"string"}],"title":"Kind"},"dims":{"maxItems":2,"minItems":2,"prefixItems":[{"type":"number"},{"type":"number"}],"title":"Dims","type":"array"}},"required":["kind","dims"],"title":"Shape","type":"object","additionalProperties":false};
// Control: the Python SDK sends this one and the JS SDK accepts it byte-identical.
// If our gate ever starts editing it, we have become stricter than the vendor --
// the false-CI-failure class of #312/#314/#317/#322.
var PY_SDK_OK = {"properties":{"title":{"maxLength":80,"minLength":2,"pattern":"^[A-Z]","title":"Title","type":"string"},"count":{"maximum":10,"minimum":0,"title":"Count","type":"integer"}},"required":["title","count"],"title":"Constrained","type":"object","additionalProperties":false};

(function () {
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };

  var bbox = E.convert(clone(PY_SDK_BBOX), "openai");
  var bboxOut = bbox.schema.properties.bbox;
  ok("python-sdk tuple payload: prefixItems is removed",
    bboxOut.prefixItems === undefined);
  ok("python-sdk tuple payload: collapses losslessly to items + fixed length",
    !!bboxOut.items && bboxOut.items.type === "integer" &&
    bboxOut.minItems === 4 && bboxOut.maxItems === 4);

  var uniq = E.convert(clone(PY_SDK_UNIQUE), "openai");
  ok("python-sdk uniqueItems payload: uniqueItems is removed",
    uniq.schema.properties.ids.uniqueItems === undefined);
  ok("python-sdk uniqueItems payload: the array itself survives",
    uniq.schema.properties.ids.items.type === "integer");

  var shape = E.convert(clone(PY_SDK_SHAPE), "openai");
  ok("python-sdk mixed payload: the tuple field is repaired",
    shape.schema.properties.dims.prefixItems === undefined &&
    shape.schema.properties.dims.items.type === "number");
  ok("python-sdk mixed payload: the const-union field is left alone",
    Array.isArray(shape.schema.properties.kind.anyOf) &&
    shape.schema.properties.kind.anyOf.length === 2 &&
    shape.schema.properties.kind.anyOf[0].const === "circle");

  [["bbox", PY_SDK_BBOX], ["unique", PY_SDK_UNIQUE], ["shape", PY_SDK_SHAPE]].forEach(function (pair) {
    var r = E.convert(clone(pair[1]), "openai");
    ok("python-sdk " + pair[0] + " payload is reported as needing a fix",
      blockers(r).length > 0 || JSON.stringify(r.schema) !== JSON.stringify(pair[1]));
    var twice = E.convert(clone(r.schema), "openai");
    ok("openai is idempotent on the python-sdk " + pair[0] + " payload",
      JSON.stringify(r.schema) === JSON.stringify(twice.schema));
  });

  var control = E.convert(clone(PY_SDK_OK), "openai");
  ok("python-sdk payload the vendor accepts is NOT edited by us",
    JSON.stringify(control.schema) === JSON.stringify(PY_SDK_OK));
  ok("python-sdk payload the vendor accepts raises no blocker",
    blockers(control).length === 0);
})();

// --- Gemini union `type` -----------------------------------------------------
// Cycle #326. `type` is on the Gemini allowlist, so an ARRAY in `type` used to
// pass straight through and `--check --to gemini` exited 0 — a false pass on a
// schema `google-genai` (Python) 2.17.0 REFUSES TO BUILD, because
// `types.Schema.type` is a single-valued enum. `@google/genai` (JS) 2.16.0 does
// not throw on any of these; it silently performs the rewrite below.
//
// Every expectation here was measured against both SDKs. Each raw shape fails
// in ONE language and builds in the other -- in BOTH directions, `bare-null`
// going the opposite way from the rest -- and every converted output was
// verified to build in BOTH.
(function () {
  function gem(schema) { return E.convert(JSON.parse(JSON.stringify(schema)), "gemini"); }
  function propA(r) { return r.schema.properties.a; }

  // The plain nullable field. `zod-to-json-schema` emits exactly this for
  // `.nullable()`, and our own `--to openai` output creates it.
  var r = gem({ type: "object", properties: { a: { type: ["string", "null"] } } });
  ok("gemini union type is not a silent pass",
    JSON.stringify(r.schema) !== JSON.stringify({ type: "object", properties: { a: { type: ["string", "null"] } } }));
  ok("gemini ['string','null'] becomes type:string", propA(r).type === "string");
  ok("gemini ['string','null'] sets nullable", propA(r).nullable === true);
  ok("gemini nullable rewrite leaves no array type", !Array.isArray(propA(r).type));

  // Multi-type union -> anyOf, which is what the JS SDK emits.
  var m = gem({ type: "object", properties: { a: { type: ["string", "integer"] } } });
  ok("gemini multi-type union becomes anyOf",
    Array.isArray(propA(m).anyOf) && propA(m).anyOf.length === 2);
  ok("gemini multi-type union drops `type` (proto forbids type+anyOf)",
    propA(m).type === undefined);
  // Guarded: with the rewrite absent these are `undefined`, and a suite that
  // crashes instead of reporting cannot tell you what depends on the fix (#322).
  ok("gemini multi-type union preserves both branches",
    (propA(m).anyOf || []).length === 2 &&
    propA(m).anyOf[0].type === "string" && propA(m).anyOf[1].type === "integer");

  var t = gem({ type: "object", properties: { a: { type: ["string", "integer", "null"] } } });
  ok("gemini union with null keeps anyOf AND nullable",
    (propA(t).anyOf || []).length === 2 && propA(t).nullable === true);

  // Divergences from the JS SDK, both deliberate: it emits an empty `anyOf`
  // here, and does not dedupe.
  var n0 = gem({ type: "object", properties: { a: { type: ["null"] } } });
  ok("gemini null-only type becomes bare nullable, not an empty anyOf",
    propA(n0).nullable === true && propA(n0).type === undefined && propA(n0).anyOf === undefined);
  var d = gem({ type: "object", properties: { a: { type: ["string", "string", "null"] } } });
  ok("gemini dedupes a repeated member instead of emitting anyOf",
    propA(d).type === "string" && propA(d).anyOf === undefined && propA(d).nullable === true);

  // Bare `type: "null"` is the one shape going the OTHER way: Python accepts it,
  // JS throws ("type: null can not be the only possible type for the field.").
  var b = gem({ type: "object", properties: { a: { type: "null" } } });
  ok("gemini bare null type is normalised for the JS client that throws on it",
    propA(b).nullable === true && propA(b).type === undefined);

  // A one-element list is semantically identical to the bare string, and Python
  // rejects it anyway.
  var one = gem({ type: "object", properties: { a: { type: ["string"] } } });
  ok("gemini single-element type list is unwrapped",
    propA(one).type === "string" && one.ledger.length > 0);

  // Depth: the walk must reach nested objects and item schemas.
  var deep = gem({ type: "object", properties: { o: { type: "object", properties: { a: { type: ["string", "null"] } } } } });
  ok("gemini union rewrite reaches a nested object",
    deep.schema.properties.o.properties.a.nullable === true &&
    deep.schema.properties.o.properties.a.type === "string");
  var inItems = gem({ type: "object", properties: { a: { type: "array", items: { type: ["string", "null"] } } } });
  ok("gemini union rewrite reaches an items schema",
    propA(inItems).items.nullable === true && propA(inItems).items.type === "string");

  // Root position.
  var root = gem({ type: ["object", "null"], properties: { a: { type: "string" } } });
  ok("gemini union rewrite applies at the root", root.schema.type === "object" && root.schema.nullable === true);

  // Constraining siblings stay outside the generated anyOf (JS does the same).
  var sib = gem({ type: "object", properties: { a: { type: ["string", "array"], items: { type: "integer" }, minLength: 2 } } });
  ok("gemini keeps constraining siblings beside the generated anyOf",
    propA(sib).items !== undefined && propA(sib).minLength === 2);

  // A pre-existing `anyOf` beside a union `type` is already a blocker; do not
  // invent a merge on top of it.
  var conflict = gem({ type: "object", properties: { a: { type: ["string", "integer"], anyOf: [{ type: "boolean" }] } } });
  ok("gemini leaves a type+anyOf conflict visible instead of merging",
    blockers(conflict).length > 0);

  // Idempotence, and the permissive path must NOT be touched: a union `type` is
  // ordinary JSON Schema and `responseJsonSchema` takes it verbatim.
  var again = E.convert(JSON.parse(JSON.stringify(r.schema)), "gemini");
  ok("gemini union rewrite is idempotent", JSON.stringify(again.schema) === JSON.stringify(r.schema));
  var js = E.convert({ type: "object", properties: { a: { type: ["string", "null"] } } }, "gemini-json");
  ok("gemini-json leaves a union type alone (legal JSON Schema there)",
    Array.isArray(js.schema.properties.a.type) && js.schema.properties.a.type.length === 2);
})();

// --- Anthropic: an array-valued `type` is a DISPATCH MISS (Cycle #327) ------
//
// Rule 0-bis: #326 fixed union `type` for Gemini's narrow path only, and every
// provider sharing the code path owes a re-probe. Measured against
// `@anthropic-ai/sdk@0.116.0` and `anthropic==0.121.0`, the two SDKs fail in
// OPPOSITE directions:
//   * JS `_transformJSONSchema` dispatches on `type === "object"` (strict string
//     equality), so a union `type` skips every branch and `properties`/`items`
//     are stringified into `description` — the whole subtree stops being schema,
//     silently, and the transformer never recurses into it.
//   * Python `transform_schema` types `type` as a `Literal` of seven scalars and
//     ends in `assert_never`, so ANY list raises `AssertionError` — including
//     `["string"]` and the canonical `["string","null"]`. No request is built.
// `anyOf` is the form both accept, verified through both transformers.
//
// The input is not hypothetical: it is what OUR OWN `--to openai` emits for an
// optional object property (the forced-required rewrite from #311).
(function () {
  function ant(schema, target) {
    return E.convert(JSON.parse(JSON.stringify(schema)), target || "anthropic-json");
  }
  var OPTIONAL_OBJECT = {
    type: "object",
    properties: {
      o: {
        type: ["object", "null"],
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: false
      },
      s: { type: "string" }
    },
    required: ["o", "s"],
    additionalProperties: false
  };

  var js = ant(OPTIONAL_OBJECT);
  var o = (js && js.schema && js.schema.properties && js.schema.properties.o) || {};
  ok("anthropic-json rewrites a union `type` that hides an object subtree",
    Array.isArray(o.anyOf) && o.type === undefined);
  ok("the object branch keeps `properties`, `required` and `additionalProperties`",
    Array.isArray(o.anyOf) && !!o.anyOf[0].properties && !!o.anyOf[0].properties.a &&
    JSON.stringify(o.anyOf[0].required) === '["a"]' &&
    o.anyOf[0].additionalProperties === false);
  ok("the null member survives as its own branch",
    Array.isArray(o.anyOf) && o.anyOf.some(function (b) { return b.type === "null"; }));
  ok("the rewrite is a real change, not an advisory",
    !!js && js.ledger.some(function (l) { return l.op === "~" && l.advisory !== true; }));
  ok("the ledger says the subtree was being stringified, not merely unenforced",
    has(js.ledger, "never recurses"));

  // Idempotence: an already-`anyOf` schema must not be touched again.
  var again = ant(js.schema);
  ok("anthropic-json union rewrite is idempotent",
    JSON.stringify(again.schema) === JSON.stringify(js.schema));

  // An `array` union hides `items` the same way.
  var arr = ant({ type: "object", properties: { l: { type: ["array", "null"], items: { type: "string" } } } });
  var l = arr.schema.properties.l;
  ok("anthropic-json rewrites a union `type` that hides an array's `items`",
    Array.isArray(l.anyOf) && !!l.anyOf[0].items && l.anyOf[0].items.type === "string");

  // A `string` union hides `format`, which the string branch WOULD have kept.
  var fmt = ant({ type: "object", properties: { e: { type: ["string", "null"], format: "email" } } });
  ok("anthropic-json recovers a `format` the string branch would have kept",
    Array.isArray(fmt.schema.properties.e.anyOf) &&
    fmt.schema.properties.e.anyOf[0].format === "email");

  // ...but a union with nothing for the skipped branch to carry loses NOTHING
  // in JS, so rewriting it would be churn. Being merely stricter than the
  // vendor is this project's most repeated bug (#312/#314/#317/#322).
  var bare = ant({ type: "object", properties: { s: { type: ["string", "null"] } } });
  ok("anthropic-json leaves a bare union `type` alone (JS loses nothing there)",
    Array.isArray(bare.schema.properties.s.type) &&
    bare.schema.properties.s.anyOf === undefined);
  ok("a bare union `type` is not a gate failure on the JS target",
    blockers(bare).length === 0);

  // The Python target is different in kind: EVERY list throws, so every list
  // must be rewritten, including the bare one the JS target leaves alone.
  var pyBare = ant({ type: "object", properties: { s: { type: ["string", "null"] } } }, "anthropic-json-python");
  ok("anthropic-json-python rewrites even a bare union `type`",
    Array.isArray(pyBare.schema.properties.s.anyOf));
  ok("the two anthropic-json targets disagree about the same bare union `type`",
    JSON.stringify(bare.schema) !== JSON.stringify(pyBare.schema));
  ok("the Python ledger cites the assert, not the demotion",
    has(pyBare.ledger, "assert_never"));

  // A one-element list is still a list, so Python still raises on it.
  var single = ant({ type: "object", properties: { s: { type: ["string"] } } }, "anthropic-json-python");
  ok("anthropic-json-python unwraps a one-element `type` list",
    single.schema.properties.s.type === "string");

  // `["null"]` -> the scalar spelling, which both SDKs accept verbatim.
  var nullOnly = ant({ type: "object", properties: { n: { type: ["null"] } } }, "anthropic-json-python");
  ok("anthropic-json-python rewrites a null-only list to the scalar `\"null\"`",
    nullOnly.schema.properties.n.type === "null");

  // Several non-null members WITH keywords: there is no safe way to decide
  // which branch a keyword belongs to, so this is a human-fix blocker rather
  // than a guess that silently re-attaches a constraint to the wrong type.
  var multi = ant({ type: "object", properties: { v: { type: ["string", "integer"], minLength: 2 } } }, "anthropic-json-python");
  ok("a multi-type union carrying keywords is a blocker, not a guessed split",
    blockers(multi).length > 0);
  ok("the multi-type blocker leaves the keyword visible",
    Array.isArray(multi.schema.properties.v.type));

  // ...but with NO keywords attached the split is exact.
  var multiBare = ant({ type: "object", properties: { v: { type: ["string", "integer"] } } }, "anthropic-json-python");
  ok("a multi-type union with no keywords splits exactly",
    Array.isArray(multiBare.schema.properties.v.anyOf) &&
    multiBare.schema.properties.v.anyOf.length === 2);

  // `type` beside a combinator: the JS SDK ignores the `type` once it sees
  // `anyOf`, but Python asserts on the LIST before consulting the combinator.
  // Bailing silently would be a false pass on a schema that cannot be built.
  var conflictPy = ant({ type: "object", properties: { v: { type: ["string", "null"], anyOf: [{ type: "string" }] } } }, "anthropic-json-python");
  ok("a union `type` beside `anyOf` is a blocker on the Python target",
    blockers(conflictPy).length > 0);
  var conflictJs = ant({ type: "object", properties: { v: { type: ["string", "null"], anyOf: [{ type: "string" }] } } });
  ok("...and not a gate failure on the JS target, which ignores the `type`",
    blockers(conflictJs).length === 0);

  // The tools path applies NO transform, so a union `type` goes on the wire
  // verbatim and needs no edit there. Verified against `betaTool()`.
  var tools = ant(OPTIONAL_OBJECT, "anthropic");
  ok("`--to anthropic` (tools) leaves a union `type` untouched",
    Array.isArray(tools.schema.properties.o.type) &&
    !!tools.schema.properties.o.properties);
  ok("`--to anthropic` reports no blocker for a union `type`",
    blockers(tools).length === 0);

  // The root is deliberately excluded: a union root is a genuine blocker on
  // both paths (each helper requires `type === "object"`), already reported.
  var unionRoot = ant({ type: ["object", "null"], properties: { a: { type: "string" } } });
  ok("a union `type` at the ROOT stays a blocker rather than being rewritten",
    blockers(unionRoot).length > 0);
})();

// --- an OPEN MAP must never be "repaired" into an empty object --------------
// `{"type":"object","additionalProperties":<schema>}` with no `properties` is
// how `Dict[str, V]` (Pydantic), `Record<string, V>` / `z.record()` (Zod) and
// OpenAPI free-form objects render. Setting `additionalProperties: false` on a
// node with no `properties` does not close it, it EMPTIES it: the only legal
// instance becomes `{}`, so the field can never be populated and nothing says
// so. Third instance of a repair that deletes (#318 `allOf`, #320 `$defs`).
//
// The three inputs below are the VERBATIM output of
// `openai.lib._pydantic.to_strict_json_schema()` on openai==2.53.0 /
// pydantic==2.13.4 -- i.e. the payload the OpenAI Python SDK actually builds
// and stamps `strict: True` on. `openai@7.4.0`'s `toStrictJsonSchema()` THROWS
// on all three ("must set `additionalProperties: false`"), so these are also a
// pin on the fourth same-vendor SDK disagreement.
var PY_DICT_STR = { properties: { name: { title: "Name", type: "string" }, meta: { additionalProperties: { type: "string" }, title: "Meta", type: "object" } }, required: ["name", "meta"], title: "M1", type: "object", additionalProperties: false };
var PY_DICT_ANY = { properties: { name: { title: "Name", type: "string" }, meta: { additionalProperties: true, title: "Meta", type: "object" } }, required: ["name", "meta"], title: "M2", type: "object", additionalProperties: false };
var PY_EXTRA_ALLOW = { additionalProperties: true, properties: { name: { title: "Name", type: "string" } }, required: ["name"], title: "M3", type: "object" };
(function () {
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var dictStr = E.convert(clone(PY_DICT_STR), "openai");
  ok("openai blocks an open map rather than emptying it",
    blockers(dictStr).length > 0);
  ok("...and leaves the map's element type visible for remodelling",
    dictStr.schema.properties.meta.additionalProperties &&
    dictStr.schema.properties.meta.additionalProperties.type === "string");
  ok("...and names the array-of-pairs remedy",
    has(dictStr.ledger, "array of `{\"key\": ..., \"value\": ...}` objects"));

  var dictAny = E.convert(clone(PY_DICT_ANY), "openai");
  ok("`additionalProperties: true` with no properties is the same open map",
    blockers(dictAny).length > 0 && dictAny.schema.properties.meta.additionalProperties === true);

  // extra="allow" puts the open flag on a node that DOES declare properties, so
  // closing it is a real (and the only) repair -- not a deletion. Being merely
  // stricter than the vendor is this project's most repeated bug, so the
  // blocker must not fire here.
  var extraAllow = E.convert(clone(PY_EXTRA_ALLOW), "openai");
  ok("a node WITH properties is closed, not blocked",
    blockers(extraAllow).length === 0 && extraAllow.schema.additionalProperties === false);
  ok("...and the ledger says the extra keys are no longer accepted",
    has(extraAllow.ledger, "no longer"));
  ok("...and the declared properties survive",
    !!extraAllow.schema.properties.name);

  // `additionalProperties: false` with no properties is the user's own choice
  // (an intentionally empty object), not something to block.
  var closedEmpty = E.convert({ type: "object", properties: { e: { type: "object", additionalProperties: false } }, required: ["e"], additionalProperties: false }, "openai");
  ok("a deliberately closed empty object is not blocked",
    blockers(closedEmpty).length === 0);

  // The narrow Gemini proto has no `additionalProperties` field at all, so
  // dropping it is the same deletion by another route.
  var gem = E.convert(clone(PY_DICT_STR), "gemini");
  ok("gemini (narrow proto) blocks an open map instead of dropping its element type",
    blockers(gem).length > 0);
  ok("...and points at the responseJsonSchema path, which does accept it",
    has(gem.ledger, "--to gemini-json"));
  var gemJson = E.convert(clone(PY_DICT_STR), "gemini-json");
  ok("gemini-json accepts an open map unchanged",
    blockers(gemJson).length === 0 &&
    gemJson.schema.properties.meta.additionalProperties.type === "string");

  // Anthropic: the tools path sends it verbatim, so nothing to say. The
  // output_format path destroys it vendor-side (measured: the transformer
  // returns `{"type":"object","properties":{},"additionalProperties":false}`),
  // which is silent and returns 200 -- advisory, never a gate failure, which is
  // the established policy for everything that path demotes.
  var antTools = E.convert(clone(PY_DICT_STR), "anthropic");
  ok("anthropic (tools) leaves an open map alone",
    blockers(antTools).length === 0 &&
    antTools.schema.properties.meta.additionalProperties.type === "string");
  var antJson = E.convert(clone(PY_DICT_STR), "anthropic-json");
  ok("anthropic-json warns that the transformer empties an open map",
    has(antJson.ledger, "only legal value is `{}`"));
  ok("...as an advisory, not a gate failure",
    blockers(antJson).length === 0);

  // A nullable map -- `type: ["object","null"]` -- is the same shape wearing
  // the spec's second form of `type` (#327). A walker that only knows the
  // scalar spelling skips it.
  var nullableMap = E.convert({ type: "object", properties: { m: { type: ["object", "null"], additionalProperties: { type: "string" } } }, required: ["m"], additionalProperties: false }, "openai");
  ok("a union-typed open map is still recognised as an open map",
    blockers(nullableMap).length > 0);

  // A typeless node whose only content is `additionalProperties` is the same
  // shape again -- `type` is optional in JSON Schema and generators omit it.
  var typelessMap = E.convert({ type: "object", properties: { m: { additionalProperties: { type: "string" } } }, required: ["m"], additionalProperties: false }, "openai");
  ok("a typeless open map is still recognised as an open map",
    blockers(typelessMap).length > 0);

  // Non-strict OpenAI surfaces have no additionalProperties requirement at all,
  // so the map is legal there and must NOT be blocked (#322).
  var nonStrict = E.convert(clone(PY_DICT_STR), "openai-nonstrict");
  ok("openai-nonstrict does not block an open map",
    blockers(nonStrict).length === 0 &&
    nonStrict.schema.properties.meta.additionalProperties.type === "string");
})();

// ---------------------------------------------------------------------------
// #330: `required` naming a key `properties` does not declare.
//
// The forced-required rewrite set `required` to the keys of `properties`. That
// is the documented strict-mode rule and it is also a repair that DELETES:
// any name the caller put in `required` that `properties` does not declare was
// dropped, silently, with no ledger entry -- and where `properties` was absent
// entirely the rewrite was skipped, so the ledger claimed "Fixed" while the
// output stayed REJECTED by openai@7.4.0's own transformer.
//
// Vendor verdicts measured 2026-08-09, not ported:
//   openai@7.4.0 toStrictJsonSchema   -> THROWS on both shapes
//   @anthropic-ai/sdk@0.116.0 (both paths) -> accepts, keeps `required` as given
//   google-genai types.Schema         -> accepts
// so the rule belongs to the strict OpenAI target and nowhere else.
(function () {
  var clone = function (x) { return JSON.parse(JSON.stringify(x)); };
  var EXTRA = {
    type: "object",
    properties: { f: { type: "object", properties: { a: { type: "string" } }, required: ["a", "ghost"] } },
    required: ["f"], additionalProperties: false
  };
  var NOPROPS = {
    type: "object",
    properties: { f: { type: "object", required: ["a"] } },
    required: ["f"], additionalProperties: false
  };

  var r1 = E.convert(clone(EXTRA), "openai");
  ok("an undeclared `required` key is a blocker, not a silent deletion",
    blockers(r1).length > 0);
  ok("...the blocker names the offending key",
    has(r1.ledger, "`ghost`"));
  ok("...and `ghost` is still in the output, not quietly dropped",
    r1.schema.properties.f.required.indexOf("ghost") !== -1);
  ok("...while the declared key is still forced required",
    r1.schema.properties.f.required.indexOf("a") !== -1);

  var r2 = E.convert(clone(NOPROPS), "openai");
  ok("`required` with no `properties` at all is the same blocker",
    blockers(r2).length > 0);
  ok("...and the required key survives the conversion",
    r2.schema.properties.f.required.indexOf("a") !== -1);

  // Guard against over-blocking -- being merely stricter than the vendor is
  // this project's most repeated bug (#312/#314/#317/#322).
  var normal = E.convert({
    type: "object",
    properties: { f: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } },
    required: ["f"], additionalProperties: false
  }, "openai");
  ok("an ordinary schema whose `required` matches `properties` is NOT blocked",
    blockers(normal).length === 0);

  var noRequired = E.convert({
    type: "object",
    properties: { f: { type: "object", properties: { a: { type: "string" } } } },
    required: ["f"], additionalProperties: false
  }, "openai");
  ok("a node with `properties` and no `required` is NOT blocked",
    blockers(noRequired).length === 0);

  // The vendor accepts these two shapes on every other target, so blocking
  // there would be a false CI failure.
  ["openai-nonstrict", "openai-realtime", "anthropic", "anthropic-json",
   "anthropic-json-python", "gemini", "gemini-json"].forEach(function (t) {
    ok("`required` mismatch is not blocked on " + t + " (the vendor accepts it)",
      blockers(E.convert(clone(EXTRA), t)).length === 0);
  });
})();

// ---------------------------------------------------------------------------
// #331: real payloads from a Go framework -- microsoft/agent-framework-go.
//
// Every fixture below is the VERBATIM output of `jsonschema.For[T]` from
// google/jsonschema-go v0.4.3 (the version that repo pins) run through the
// `makeStrict` rewrite proposed in agent-framework-go PR #689 -- i.e. what that
// framework would put on the wire, not a schema we wrote. First Go-language
// framework in the fixture set; the previous six probes were JS/Python.
//
// Vendor verdicts measured 2026-08-09 against openai@7.4.0 toStrictJsonSchema:
//   Plain    -> ACCEPTED   (repaired only by reordering `required`)
//   map[string]string -> THROWS  (`properties/tags` must set additionalProperties:false)
//   map[string]any    -> THROWS  (same, from additionalProperties:true)
//   required naming an undeclared key -> THROWS
//   required with no `properties`     -> THROWS
// Our gate agreed on all five. These pin that agreement: they are the shapes
// #329 (open map) and #330 (required mismatch) were built for, arriving from a
// third party rather than from a fixture of our own.
(function () {
  var clone = function (x) { return JSON.parse(JSON.stringify(x)); };

  var GO_PLAIN = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
      email: { type: ["string", "null"] }
    },
    required: ["age", "email", "name"],
    additionalProperties: false
  };
  var GO_MAP_STRING = {
    type: "object",
    properties: {
      name: { type: "string" },
      tags: { type: "object", additionalProperties: { type: "string" } }
    },
    required: ["name", "tags"],
    additionalProperties: false
  };
  var GO_MAP_ANY = {
    type: "object",
    properties: {
      name: { type: "string" },
      meta: { type: "object", additionalProperties: true }
    },
    required: ["meta", "name"],
    additionalProperties: false
  };
  var GO_GHOST = {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a", "ghost"],
    additionalProperties: false
  };
  var GO_NO_PROPS = {
    type: "object",
    required: ["a"],
    additionalProperties: false
  };

  // The vendor accepts this one, so blocking it would be a false CI failure --
  // being merely stricter than the vendor is this project's most repeated bug.
  ok("agent-framework-go: an ordinary struct is not blocked (vendor ACCEPTS)",
    blockers(E.convert(clone(GO_PLAIN), "openai")).length === 0);

  // `makeStrict` early-returns on a node with no `properties`, so a Go map
  // field keeps its open `additionalProperties` and the vendor throws.
  ok("agent-framework-go: a map[string]string field is blocked as an open map",
    blockers(E.convert(clone(GO_MAP_STRING), "openai")).length === 1);
  ok("agent-framework-go: a map[string]any field is blocked as an open map",
    blockers(E.convert(clone(GO_MAP_ANY), "openai")).length === 1);

  // The element type must survive into the output so the reader can see what
  // needs remodelling (#318) -- a blocker that hides the shape is not a fix.
  var mapOut = E.convert(clone(GO_MAP_STRING), "openai");
  ok("agent-framework-go: the map's element type is carried through, not dropped",
    mapOut.schema.properties.tags.additionalProperties.type === "string");

  // Both directions of the required/properties correspondence.
  ok("agent-framework-go: `required` naming an undeclared key is blocked",
    blockers(E.convert(clone(GO_GHOST), "openai")).length === 1);
  ok("agent-framework-go: `required` with no `properties` at all is blocked",
    blockers(E.convert(clone(GO_NO_PROPS), "openai")).length === 1);

  // The undeclared name must stay visible rather than being silently deleted --
  // that deletion IS the defect #330 found in our own engine and in this PR.
  var ghostOut = E.convert(clone(GO_GHOST), "openai");
  ok("agent-framework-go: the undeclared name is not silently dropped",
    ghostOut.schema.required.indexOf("ghost") !== -1);

  // Non-strict OpenAI accepts every one of these, so none may be blocked there.
  [GO_PLAIN, GO_MAP_STRING, GO_MAP_ANY, GO_GHOST, GO_NO_PROPS].forEach(function (s, i) {
    ok("agent-framework-go: payload " + i + " is not blocked on openai-nonstrict",
      blockers(E.convert(clone(s), "openai-nonstrict")).length === 0);
  });
})();

// --- Anthropic SDK #3: `anthropic-sdk-go` is its own dialect --------------
//
// Measured 2026-08-09 against github.com/anthropics/anthropic-sdk-go@v1.62.0 by
// calling `BetaJSONSchemaOutputFormat` / `BetaToolInputSchema` directly. Every
// "the Go SDK does X" comment below is the verbatim observed output, not a
// reading of the diff. The raw-vs-converted round trip was run through that
// same binary: 4 raw shapes come back as a literal `null` (the whole document
// dropped) and all 4 converted outputs come back whole.
(function () {
  function blockers(r) {
    if (!r || !r.ledger) return [];
    return r.ledger.filter(function (l) { return l.op === "!" && !l.advisory; });
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  // A target that does not exist returns {ok:false} with no schema. Dereferencing
  // that aborts the whole file and hides every later assertion (#322), so every
  // lookup below goes through `at()`, which reports a failure instead.
  function at(r, path) {
    var cur = r && r.schema;
    var parts = path ? path.split(".") : [];
    for (var i = 0; i < parts.length && cur !== undefined && cur !== null; i++) cur = cur[parts[i]];
    return cur;
  }

  // 1. An array-valued `type` fails the unmarshal into invopop's `Type string`,
  //    so `transformSchemaMap` returns nil and the ENTIRE schema is dropped --
  //    including when the union is buried in `$defs` and nothing else is wrong.
  var UNION = { type: "object", properties: { a: { type: ["string", "null"] } }, required: ["a"] };
  var rUnion = E.convert(clone(UNION), "anthropic-go");
  ok("anthropic-go rewrites a bare nullable union to anyOf",
    Array.isArray(at(rUnion, "properties.a.anyOf")) &&
    at(rUnion, "properties.a.type") === undefined);
  ok("anthropic-go says the WHOLE document is lost, not just the node",
    has(rUnion.ledger, "ENTIRE DOCUMENT"));
  // The TypeScript target must NOT touch this one: JS loses nothing on a bare
  // `["string","null"]` (#327), so editing it there would be over-strictness.
  var rUnionJs = E.convert(clone(UNION), "anthropic-json");
  ok("anthropic-json still leaves the same bare union alone (targets disagree)",
    at(rUnionJs, "properties.a.type") !== undefined);

  // The `$defs` member must be REFERENCED, or the orphan pruner deletes it and
  // the schema "survives" for the wrong reason -- caught by checking that the
  // definition is still there afterwards, not just that the document is.
  var UNION_DEFS = {
    type: "object",
    properties: { a: { type: "string" }, t: { $ref: "#/$defs/T" } },
    required: ["a", "t"],
    $defs: { T: { type: ["string", "null"] } }
  };
  var rUnionDefs = E.convert(clone(UNION_DEFS), "anthropic-go");
  ok("anthropic-go rewrites a union buried in a referenced $defs",
    Array.isArray(at(rUnionDefs, "$defs.T.anyOf")) &&
    at(rUnionDefs, "$defs.T.type") === undefined);

  // 2. Draft-07 array-form `items` cannot unmarshal into `Items *Schema`
  //    either -- same total loss, and the collapse is what rescues it.
  var TUPLE07 = {
    type: "object",
    properties: { b: { type: "array", items: [{ type: "integer" }, { type: "integer" }] } },
    required: ["b"]
  };
  var rTuple = E.convert(clone(TUPLE07), "anthropic-go");
  ok("anthropic-go collapses a homogeneous draft-07 tuple to items+min/maxItems",
    at(rTuple, "properties.b.items.type") === "integer" &&
    at(rTuple, "properties.b.minItems") === 2);
  ok("anthropic-go names the nil-return as the cost of array-form items",
    has(rTuple.ledger, "come back nil") || has(rTuple.ledger, "return nil"));

  // 3. `definitions` has no field on invopop's Schema, so the bag is dropped
  //    during the unmarshal -- earlier than Anthropic's own transform, which is
  //    why it is not even demoted to prose. This is zod-to-json-schema's default.
  var DEFINITIONS = {
    type: "object", properties: { t: { $ref: "#/definitions/T" } }, required: ["t"],
    definitions: { T: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } }
  };
  var rDefs = E.convert(clone(DEFINITIONS), "anthropic-go");
  ok("anthropic-go renames definitions to $defs so the bag survives",
    !!at(rDefs, "$defs") && !at(rDefs, "definitions") &&
    at(rDefs, "properties.t.$ref") === "#/$defs/T");

  // 4. Go keeps MORE than the other two: enum, const AND pattern are all in
  //    `supportedSchemaKeys`. Reporting them as unenforced here would be the
  //    stricter-than-the-vendor bug -- verified byte-identical through the SDK.
  var KEPT = {
    type: "object",
    properties: { p: { type: "string", enum: ["a", "b"], pattern: "^a" }, c: { type: "string", const: "x" } },
    required: ["p", "c"]
  };
  var rKept = E.convert(clone(KEPT), "anthropic-go");
  ok("anthropic-go leaves enum/const/pattern untouched",
    JSON.stringify(at(rKept, "")) === JSON.stringify(KEPT));
  ok("anthropic-go reports enum/const/pattern as SURVIVING, not demoted",
    has(rKept.ledger, "survive here"));
  ok("anthropic-go does not fail the gate on a schema the Go SDK keeps verbatim",
    blockers(rKept).length === 0);
  // The TypeScript SDK demotes all three, so that target must still say so.
  ok("anthropic-json still reports enum as unenforced (the SDKs disagree)",
    has(E.convert(clone(KEPT), "anthropic-json").ledger, "NOT enforced"));

  // 5. An open map is the one place Go is the CORRECT SDK: `transformSchema`
  //    has an explicit dictionary clause. #329 blocks this for OpenAI and
  //    advises for TypeScript; here it must do neither.
  var OPEN_MAP = { type: "object", additionalProperties: { type: "string" } };
  var rMap = E.convert(clone(OPEN_MAP), "anthropic-go");
  ok("anthropic-go keeps an open map byte-identical",
    JSON.stringify(at(rMap, "")) === JSON.stringify(OPEN_MAP));
  ok("anthropic-go does not block an open map",
    blockers(rMap).length === 0);
  ok("anthropic-go says the Go SDK keeps the open map",
    has(rMap.ledger, "the Go SDK keeps it"));
  ok("openai still blocks the same open map (per-provider, not ported)",
    blockers(E.convert(clone(OPEN_MAP), "openai")).length === 1);

  // 6. The pointer-formatting bug: `formatExtraValue` dereferences with reflect
  //    but formats the original value, and invopop declares these as *uint64.
  //    Measured output: {maxLength: 0x162d307bcc80, minLength: 0x162d307bcc88}.
  var LENGTHS = {
    type: "object", properties: { p: { type: "string", minLength: 2, maxLength: 8 } }, required: ["p"]
  };
  var rLen = E.convert(clone(LENGTHS), "anthropic-go");
  ok("anthropic-go warns that length keywords arrive as a memory address",
    has(rLen.ledger, "hexadecimal address"));
  ok("anthropic-go keeps the length keywords rather than stripping them",
    at(rLen, "properties.p.minLength") === 2);

  // 7. Two severities behind one word: a keyword invopop does not model is
  //    deleted before the demote-to-prose path can see it.
  var UNMODELLED = {
    type: "object", properties: { a: { type: "string" } }, required: ["a"],
    unevaluatedProperties: false
  };
  ok("anthropic-go distinguishes silent deletion from demotion to prose",
    has(E.convert(clone(UNMODELLED), "anthropic-go").ledger, "DELETED without a trace"));

  // 8. A typeless node is not rejected by Go -- it is replaced with the literal
  //    JSON `true`, i.e. match-anything. Blocker, because no type is inferable.
  var TYPELESS = {
    type: "object",
    properties: { n: { properties: { a: { type: "string" } }, required: ["a"] } },
    required: ["n"]
  };
  var rTypeless = E.convert(clone(TYPELESS), "anthropic-go");
  ok("anthropic-go blocks a typeless node", blockers(rTypeless).length === 1);
  ok("anthropic-go names the `true` replacement rather than a throw",
    has(rTypeless.ledger, "literal JSON `true`"));

  // 9. A root `$ref` loses everything on Go with no root-type guard to catch it.
  var ROOT_REF = {
    $ref: "#/$defs/T",
    $defs: { T: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } }
  };
  var rRoot = E.convert(clone(ROOT_REF), "anthropic-go");
  ok("anthropic-go inlines a root $ref", at(rRoot, "type") === "object" && !at(rRoot, "$ref"));
  // Python is the one SDK that survives this shape, so it must still skip.
  ok("anthropic-json-python still leaves the same root $ref alone",
    at(E.convert(clone(ROOT_REF), "anthropic-json-python"), "$ref") === "#/$defs/T");

  // 10. Go has no verbatim surface: BetaToolInputSchema runs the same
  //     transform, so the `--to anthropic` target must not be recommended blind.
  ok("the tools target points Go callers at anthropic-go",
    has(E.convert({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, "anthropic").ledger,
      "anthropic-go"));
  ok("anthropic-go never claims the tools path is verbatim",
    !has(rLen.ledger, "sent as-is on the `tools[].input_schema` path"));

  // 11. An ordinary schema the Go SDK accepts unchanged must not be edited.
  var PLAIN = {
    type: "object", properties: { a: { type: "string" }, b: { type: "integer" } }, required: ["a", "b"]
  };
  var rPlain = E.convert(clone(PLAIN), "anthropic-go");
  ok("anthropic-go leaves an ordinary schema byte-identical",
    JSON.stringify(at(rPlain, "")) === JSON.stringify(PLAIN));
  ok("anthropic-go does not block an ordinary schema", blockers(rPlain).length === 0);
})();

// ---------------------------------------------------------------------------
// 25. BOOLEAN SUBSCHEMAS (Cycle #333)
//
// JSON Schema defines a schema as "an object OR a boolean". Every walker in
// engine.js begins `if (!isPlainObject(node)) return;`, so a boolean node ended
// its branch SILENTLY and six of eight positions exited 0 as "already valid".
//
// The input below is not hypothetical: it is the VERBATIM output of the
// `GenerateSchema[T]()` recipe printed in openai-go@v3.50.0's own README
// (invopop/jsonschema v0.14.0, `AllowAdditionalProperties:false,
// DoNotReference:true`) for ordinary Go structs. `any`, `interface{}`,
// `json.RawMessage` and the element type of `[]any` all reflect to `true`.
(function () {
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  // --- verbatim openai-go README-recipe output ---
  var GO_ANY = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "additionalProperties": false,
    "properties": {
      "data": true,
      "name": {
        "type": "string"
      }
    },
    "required": [
      "name",
      "data"
    ],
    "type": "object"
  };
  var GO_RAWMSG = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "additionalProperties": false,
    "properties": {
      "name": {
        "type": "string"
      },
      "raw": true
    },
    "required": [
      "name",
      "raw"
    ],
    "type": "object"
  };
  var GO_ANYSLICE = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "additionalProperties": false,
    "properties": {
      "items": {
        "items": true,
        "type": "array"
      }
    },
    "required": [
      "items"
    ],
    "type": "object"
  };

  // openai@7.4.0 toStrictJsonSchema() THROWS on all three (measured).
  [["any", GO_ANY], ["json.RawMessage", GO_RAWMSG], ["[]any", GO_ANYSLICE]].forEach(function (p) {
    var r = E.convert(clone(p[1]), "openai");
    ok("openai blocks the boolean subschema Go emits for " + p[0], blockers(r).length === 1);
    ok("openai names the remodelling for " + p[0], has(r.ledger, "serialized JSON"));
  });

  // Every schema position, not just `properties`.
  function propBool(v) {
    return { type: "object", properties: { a: v }, required: ["a"], additionalProperties: false };
  }
  var POSITIONS = {
    "properties": propBool(true),
    "items": { type: "object", properties: { a: { type: "array", items: true } }, required: ["a"], additionalProperties: false },
    "anyOf": { type: "object", properties: { a: { anyOf: [{ type: "string" }, true] } }, required: ["a"], additionalProperties: false },
    "$defs": { type: "object", properties: { a: { $ref: "#/$defs/T" } }, required: ["a"], additionalProperties: false, $defs: { T: true } },
    "nested": { type: "object", properties: { o: propBool(true) }, required: ["o"], additionalProperties: false }
  };
  Object.keys(POSITIONS).forEach(function (pos) {
    ok("openai blocks a boolean subschema at " + pos,
      blockers(E.convert(clone(POSITIONS[pos]), "openai")).length === 1);
  });

  // `false` is a different defect and gets a different sentence.
  var rFalse = E.convert(propBool(false), "openai");
  ok("openai blocks a `false` subschema", blockers(rFalse).length === 1);
  ok("`false` is described as unsatisfiable, not as match-anything",
    has(rFalse.ledger, "matches NO value") && !has(rFalse.ledger, "matches ANY value"));

  // The node is left VISIBLE — a blocker must not delete the shape (#318).
  ok("the boolean is carried through to the output, not stripped",
    E.convert(propBool(true), "openai").schema.properties.a === true);

  // --- per-provider, MEASURED not ported ---
  // TS output_format THROWS; Go keeps it verbatim on BOTH surfaces; TS tools
  // applies no transform at all.
  ok("anthropic-json blocks a boolean subschema (TS transformer throws)",
    blockers(E.convert(propBool(true), "anthropic-json")).length === 1);
  ok("anthropic (tools, verbatim) does NOT block it",
    blockers(E.convert(propBool(true), "anthropic")).length === 0);
  ok("anthropic-go does NOT block it — measured verbatim through both Go surfaces",
    blockers(E.convert(propBool(true), "anthropic-go")).length === 0);
  ok("anthropic-go says the TypeScript path disagrees",
    has(E.convert(propBool(true), "anthropic-go").ledger, "the Go SDK keeps it"));
  // Never probed for this shape -> claim nothing.
  ok("anthropic-json-python is left unchanged (not probed for this shape)",
    blockers(E.convert(propBool(true), "anthropic-json-python")).length === 0);

  // Gemini: narrow proto rejects it, JSON-Schema path accepts it.
  ok("gemini (narrow proto) blocks a boolean subschema",
    blockers(E.convert(propBool(true), "gemini")).length === 1);
  ok("gemini-json does NOT block it",
    blockers(E.convert(propBool(true), "gemini-json")).length === 0);

  // Non-strict OpenAI surfaces have no subset restriction at all.
  ok("openai-nonstrict does NOT block it",
    blockers(E.convert(propBool(true), "openai-nonstrict")).length === 0);
  ok("openai-realtime does NOT block it",
    blockers(E.convert(propBool(true), "openai-realtime")).length === 0);

  // --- over-blocking guards: booleans that are LEGAL by design ---
  // `additionalProperties`/`unevaluatedProperties`/`additionalItems` take a
  // boolean as their normal spelling. Flagging those would fire on every closed
  // object in existence.
  var LEGAL = {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
    additionalProperties: false,
    unevaluatedProperties: false
  };
  ok("a normal `additionalProperties: false` is not mistaken for a boolean subschema",
    blockers(E.convert(clone(LEGAL), "openai")).filter(function (b) {
      return /boolean subschema/.test(b.msg || "");
    }).length === 0);
  var OPEN = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: true };
  ok("`additionalProperties: true` is still the open-map/extra-keys rule, not this one",
    blockers(E.convert(clone(OPEN), "openai")).filter(function (b) {
      return /boolean subschema/.test(b.msg || "");
    }).length === 0);
  ok("an ordinary schema gains no boolean blocker",
    blockers(E.convert({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, "openai"))
      .filter(function (b) { return /boolean subschema/.test(b.msg || ""); }).length === 0);
})();

// --- Gemini, THIRD client: google.golang.org/genai (Go) ------------------
// Cycle #334. The narrow `responseSchema` path now has three clients and three
// behaviours for the SAME unsupported keyword:
//   JS     forwards it   -> backend 400, `Unknown name "$defs" … Cannot find field`
//   Python `extra="forbid"` -> raises locally, request never built
//   Go     `json.Unmarshal` into `genai.Schema` -> nil error, key silently gone,
//          request succeeds with a weakened schema
// Go is the only one that produces NO signal anywhere, which is why `--check`
// is the only thing in a Go caller's stack that will ever report the loss.
//
// The fixtures below are the VERBATIM Pydantic 2.13 output and the VERBATIM
// key-paths measured lost by `genai@v1.67.0` on this host. `GO_SCHEMA_FIELDS`
// is the mechanically-extracted json tag list of the Go `Schema` struct — a
// third, independent vendor artifact for GEMINI_ALLOWED, after the JS `.d.ts`
// (#314) and the Python `types.Schema` (#314b). It is a static type, so it is
// the strongest of the three: a field that is not there cannot be carried.
(function () {
  var GO_SCHEMA_FIELDS = [
    "anyOf", "default", "description", "enum", "example", "format", "items",
    "maxItems", "maxLength", "maxProperties", "maximum", "minItems",
    "minLength", "minProperties", "minimum", "nullable", "pattern",
    "properties", "propertyOrdering", "required", "title", "type"
  ].sort();

  var ours = Object.keys(E.DOCS ? {} : {}); // placeholder, replaced below
  ours = E.GEMINI_ALLOWED_KEYS ? E.GEMINI_ALLOWED_KEYS.slice().sort() : null;
  ok("the Go `Schema` struct's json tags are exported for comparison", !!ours);
  ok("GEMINI_ALLOWED matches the Go `Schema` struct field-for-field",
    !!ours && ours.join(",") === GO_SCHEMA_FIELDS.join(","));

  // Verbatim `Ticket.model_json_schema()` from pydantic 2.13.4.
  var PYD = {
    "$defs": {
      "Addr": {
        properties: {
          city: { minLength: 2, title: "City", type: "string" },
          zip: { pattern: "^\\d{5}$", title: "Zip", type: "string" }
        },
        required: ["city", "zip"], title: "Addr", type: "object"
      }
    },
    properties: {
      title: { description: "short title", maxLength: 80, title: "Title", type: "string" },
      priority: { enum: ["low", "high"], title: "Priority", type: "string" },
      score: { maximum: 10, minimum: 0, title: "Score", type: "integer" },
      addr: { "$ref": "#/$defs/Addr" },
      tags: { items: { type: "string" }, title: "Tags", type: "array" },
      bbox: {
        maxItems: 4, minItems: 4,
        prefixItems: [{ type: "integer" }, { type: "integer" }, { type: "integer" }, { type: "integer" }],
        title: "Bbox", type: "array"
      },
      note: { anyOf: [{ type: "string" }, { type: "null" }], default: null, title: "Note" }
    },
    required: ["title", "priority", "score", "addr", "tags", "bbox"],
    title: "Ticket", type: "object"
  };

  var r = E.convert(JSON.parse(JSON.stringify(PYD)), "gemini");
  ok("go/pydantic: converts without a blocker", r.ok &&
    !r.ledger.some(function (l) { return l.op === "!" && !l.advisory; }));

  // Everything Go silently deleted from the RAW schema is gone from our output
  // too — because we either inlined it, collapsed it, or rewrote it FIRST.
  // Measured loss on the raw input: 16 key-paths, unmarshalErr = nil.
  ok("go/pydantic: the `$ref` property is a real object, not the `{}` Go leaves behind",
    r.schema.properties.addr.type === "object" &&
    r.schema.properties.addr.properties.zip.pattern === "^\\d{5}$");
  ok("go/pydantic: `$defs` is gone (Go drops the bag and the pointer both)",
    !("$defs" in r.schema) && !("$ref" in r.schema.properties.addr));
  ok("go/pydantic: the tuple keeps its element type (Go leaves a bare array)",
    r.schema.properties.bbox.items && r.schema.properties.bbox.items.type === "integer" &&
    r.schema.properties.bbox.minItems === 4 && r.schema.properties.bbox.maxItems === 4);
  ok("go/pydantic: `prefixItems` is gone — the one key Go drops with no error",
    !("prefixItems" in r.schema.properties.bbox));

  // Every key we emit must exist on the Go struct, or a Go caller loses it
  // silently while we report success.
  function keysOutsideGoStruct(schema) {
    var offenders = [];
    (function walkKeys(node, path) {
      if (Array.isArray(node)) return node.forEach(function (n, i) { walkKeys(n, path + "/" + i); });
      if (!node || typeof node !== "object") return;
      Object.keys(node).forEach(function (k) {
        // property NAMES are data, not keywords
        if (/\/properties$/.test(path)) return walkKeys(node[k], path + "/" + k);
        if (GO_SCHEMA_FIELDS.indexOf(k) === -1) offenders.push(path + "/" + k);
        walkKeys(node[k], path + "/" + k);
      });
    })(schema, "");
    return offenders;
  }
  ok("go/pydantic: every key in our output is a field of the Go `Schema` struct",
    keysOutsideGoStruct(r.schema).length === 0);
  // Control: the check above is only worth anything if it can FAIL. A planted
  // key at a nested position must be caught, and a property literally NAMED
  // after an unsupported keyword must NOT be.
  (function () {
    var planted = JSON.parse(JSON.stringify(r.schema));
    planted.properties.addr.additionalProperties = false;
    ok("go: the struct-field check catches a planted out-of-struct key",
      keysOutsideGoStruct(planted).join(",") === "/properties/addr/additionalProperties");
    var named = { type: "object", properties: { "$ref": { type: "string" }, allOf: { type: "string" } }, required: ["$ref"] };
    ok("go: a property NAMED after an unsupported keyword is not a false positive",
      keysOutsideGoStruct(named).length === 0);
  })();

  // The single measured exception, and it is an advisory rather than a blocker
  // because the proto accepts it (verified live) — it is the CLIENT that cannot
  // carry it. `Schema.Default` is `any` with `omitempty`, so an explicit null
  // unmarshals to nil and is omitted again on the way out.
  ok("go: an explicit `default: null` is flagged as a Go-only loss",
    has(r.ledger, "`Schema.Default` is `any` with `omitempty`"));
  ok("go: that flag is advisory and never fails the gate",
    r.ledger.filter(function (l) { return /Schema.Default/.test(l.msg); })
      .every(function (l) { return l.advisory === true; }));
  var noDefault = E.convert({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, "gemini");
  ok("go: a schema with no null default gains no such note",
    !has(noDefault.ledger, "`Schema.Default` is `any` with `omitempty`"));
  var zeroDefault = E.convert({ type: "object", properties: { a: { type: "integer", "default": 0 } }, required: ["a"] }, "gemini");
  ok("go: `default: 0` is NOT flagged — only an explicit null is unrepresentable",
    !has(zeroDefault.ledger, "`Schema.Default` is `any` with `omitempty`"));

  // The consequence text has to name the client, because the consequence
  // differs by client and only the caller knows which one they are (#319).
  ok("go: the `$ref` inlining note names Go's silent drop",
    has(r.ledger, "Go DROPS IT SILENTLY"));
  var openMap = E.convert({ type: "object", additionalProperties: { type: "string" } }, "gemini");
  ok("go: the open-map blocker names Go's silent drop",
    has(openMap.ledger, "drops it during unmarshal with no error"));
  ok("go: the open-map blocker is still a blocker, not downgraded",
    openMap.ledger.some(function (l) { return l.op === "!" && !l.advisory; }));

  // Over-blocking guards: none of this may leak into the other targets.
  ["gemini-json", "openai", "anthropic", "anthropic-go"].forEach(function (p) {
    var x = E.convert(JSON.parse(JSON.stringify(PYD)), p);
    ok(p + " gains no Go `Schema.Default` note",
      !has(x.ledger, "`Schema.Default` is `any` with `omitempty`"));
  });
})();

// ---------------------------------------------------------------------------
// Cycle #335 — the emptied-map fossil, and the Mastra battery it came from.
//
// Fixtures are the VERBATIM output of @mastra/schema-compat@1.3.5's
// `prepareJsonSchemaForOpenAIStrictMode` (#311: pin to real generator output,
// not something we wrote). The point of the whole block is that our verdict
// agrees with the vendor's on both the raw input and Mastra's wire payload.
(function () {
  // Verbatim: zod@3.25.76 + zod-to-json-schema, `z.record(z.string())`, run
  // through Mastra's strict-mode prep. Measured: the vendor ACCEPTS this and
  // the `tags` field can then only ever be `{}`.
  var MASTRA_WIRE = {
    type: "object",
    properties: { title: { type: "string" }, tags: { type: "object", additionalProperties: false } },
    required: ["title", "tags"],
    additionalProperties: false
  };
  var MASTRA_RAW = {
    type: "object",
    properties: { title: { type: "string" }, tags: { type: "object", additionalProperties: { type: "string" } } },
    required: ["title", "tags"],
    additionalProperties: false
  };

  var wire = E.convert(JSON.parse(JSON.stringify(MASTRA_WIRE)), "openai");
  ok("mastra: the emptied map left behind is reported",
    has(wire.ledger, "compatibility layer"));
  ok("mastra: it is ADVISORY — there is nothing to fix in this file",
    wire.ledger.filter(function (l) { return /compatibility layer/.test(l.msg); })
      .every(function (l) { return l.advisory === true; }));
  ok("mastra: it names the upstream cause rather than blaming the schema",
    has(wire.ledger, "z.record"));

  // #335 asserted here that `properties: {}` proves a DELIBERATE empty object
  // and must not fire. #340 REVERSED that, on measurement rather than taste:
  // crewai 1.15.14's `force_additional_properties_false` empties a
  // `Dict[str, str]` and then adds `properties: {}` + `required: []`, producing
  // bytes identical to a genuinely empty BaseModel. The premise that
  // `properties: {}` exonerates a node is simply false, so the advisory now
  // fires on both and says out loud that it cannot tell them apart. It stays an
  // advisory, and the statement it makes ("only legal value is `{}`") is true of
  // a deliberate empty object too -- that field is dead either way.
  var legit = E.convert({
    type: "object",
    properties: { e: { type: "object", properties: {}, additionalProperties: false } },
    required: ["e"], additionalProperties: false
  }, "openai");
  ok("mastra: `properties: {}` no longer exonerates a node (#340 reversal)",
    has(legit.ledger, "only legal value is `{}`"));
  // `.every()` on an empty array is vacuously true, so require a hit first --
  // otherwise this assertion passes on an engine that reports nothing at all.
  var legitHits = legit.ledger.filter(function (l) { return /only legal value is/.test(l.msg); });
  ok("mastra: and that report is advisory, never a gate failure",
    legitHits.length > 0 && legitHits.every(function (l) { return l.advisory === true; }));
  ok("mastra: the `properties: {}` form admits it cannot name the cause",
    has(legit.ledger, "It no longer settles it"));
  ok("mastra: while the no-`properties` form still names the cause outright",
    !has(E.convert(JSON.parse(JSON.stringify(MASTRA_WIRE)), "openai").ledger,
      "It no longer settles it"));

  // No double-report: a live open map is a blocker, not a fossil.
  var live = E.convert(JSON.parse(JSON.stringify(MASTRA_RAW)), "openai");
  ok("mastra: a LIVE open map gets the blocker, not the fossil advisory",
    has(live.ledger, "This is an open map") && !has(live.ledger, "compatibility layer"));

  // Provider-independent: every target accepts an emptied map, so every target
  // says so, and none of them turns it into a gate failure.
  ["openai", "openai-nonstrict", "anthropic", "anthropic-json", "gemini", "gemini-json", "anthropic-go"].forEach(function (p) {
    var x = E.convert(JSON.parse(JSON.stringify(MASTRA_WIRE)), p);
    ok(p + ": reports the emptied map",     has(x.ledger, "compatibility layer"));
    ok(p + ": and only as an advisory",
      x.ledger.filter(function (l) { return /compatibility layer/.test(l.msg); })
        .every(function (l) { return l.advisory === true; }));
  });

  // Regression pins on the Mastra battery itself (#331: a differential test
  // against a live third party beats another fixture we wrote ourselves).
  // Each of these is a shape Mastra's strict prep FAILS to fix or silently
  // damages, with our verdict measured against `toStrictJsonSchema`.
  var ghost = E.convert({ type: "object", properties: { a: { type: "string" } }, required: ["a", "ghost"] }, "openai");
  ok("mastra: `required` naming an undeclared key is still a blocker (#330)",
    ghost.ledger.some(function (l) { return l.op === "!" && !l.advisory; }));
  var noProps = E.convert({ type: "object", required: ["a"] }, "openai");
  ok("mastra: `required` with no `properties` — the shape Mastra's prep skips",
    noProps.ledger.some(function (l) { return l.op === "!" && !l.advisory; }));
})();

// ---------------------------------------------------------------------------
// #336 — google-adk 2.6.3, the first framework probed here whose input dialect
// is MUTUALLY EXCLUSIVE with the vendor's own request field.
//
// Measured, not reasoned (google-adk==2.6.3, google-genai==2.17.0, live v1beta
// pre-auth proto oracle, control-checked with `{"type":"frobnicate"}`):
//   * straight to `responseSchema`: `{type:"STRING", nullable:true}` ACCEPTED,
//     `{type:["string","null"]}` REJECTED (`Unknown name "type"`).
//   * through ADK: the reverse — `nullable` is dropped (not a field of its
//     `_ExtendedJSONSchema`), the union form becomes `nullable` correctly.
// So there is no intersection document, which is why this is its own target.
(function () {
  var UNION_NULL = { type: "object", properties: { v: { type: ["string", "null"] } }, required: ["v"] };
  var MULTI      = { type: "object", properties: { x: { type: ["string", "integer"] } }, required: ["x"] };
  var LOOSE      = { type: "object", properties: { a: { type: "array" } }, required: ["a"] };
  var TUPLE      = { type: "object", properties: { b: { type: "array", prefixItems: [{ type: "integer" }, { type: "integer" }] } }, required: ["b"] };

  // A missing converter returns no `schema`, so every dereference below goes
  // through `at()`. Without this the whole file aborts when the fix is reverted
  // and the revert check proves nothing (#322, fifth occurrence).
  function conv(sch, p) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), p) || {};
    if (!r.schema) r.schema = {};
    if (!r.ledger) r.ledger = [];
    return r;
  }
  function prop(r, k) {
    return (r.schema && r.schema.properties && r.schema.properties[k]) || {};
  }

  // --- the exclusivity, both directions -----------------------------------
  var narrow = conv(UNION_NULL, "gemini");
  var client = conv(UNION_NULL, "gemini-client");
  ok("adk: --to gemini emits the proto spelling `nullable`",
    prop(narrow, "v").nullable === true && prop(narrow, "v").type === "string");
  ok("adk: --to gemini-client KEEPS the JSON Schema union spelling",
    Array.isArray(prop(client, "v").type) &&
    prop(client, "v").nullable === undefined);
  ok("adk: the two targets genuinely disagree about the same file",
    JSON.stringify(prop(narrow, "v")) !== JSON.stringify(prop(client, "v")));

  // The advisory that tells a `--to gemini` user their output is destination-
  // specific. Advisory ONLY — an advisory that failed CI would be #317's bug.
  ok("adk: --to gemini warns that `nullable` is dropped by a converting client",
    has(narrow.ledger, "silently stop being nullable"));
  ok("adk: ...and never as a gate failure",
    narrow.ledger.filter(function (l) { return /silently stop being nullable/.test(l.msg); })
      .every(function (l) { return l.advisory === true; }));
  ok("adk: the warning names the target that fixes it",
    has(narrow.ledger, "--to gemini-client"));
  ok("adk: no such warning when nothing nullable was emitted",
    !has(conv({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, "gemini").ledger,
      "silently stop being nullable"));

  // --- multi-member unions: the client keeps exactly ONE member ------------
  var m = conv(MULTI, "gemini-client");
  ok("adk: a multi-type union becomes `anyOf` (which survives the conversion)",
    Array.isArray(prop(m, "x").anyOf) && prop(m, "x").anyOf.length === 2 &&
    prop(m, "x").type === undefined);
  ok("adk: ...and carries no sibling `nullable`, which would be dropped",
    prop(m, "x").nullable === undefined);
  var mn = conv({ type: "object", properties: { x: { type: ["string", "integer", "null"] } }, required: ["x"] }, "gemini-client");
  ok("adk: a nullable multi-union puts `null` INSIDE the anyOf",
    Array.isArray(prop(mn, "x").anyOf) && prop(mn, "x").anyOf.length === 3 &&
    prop(mn, "x").anyOf.some(function (b) { return b.type === "null"; }) &&
    prop(mn, "x").nullable === undefined);

  // --- an array with no element type --------------------------------------
  // The proto accepts it, so this is an advisory on every path, never a blocker.
  var loose = conv(LOOSE, "gemini");
  ok("adk: an itemless array is reported", has(loose.ledger, "declares no element type"));
  ok("adk: ...as an advisory only (the proto accepts it)",
    loose.ledger.filter(function (l) { return /declares no element type/.test(l.msg); })
      .every(function (l) { return l.advisory === true; }));
  ok("adk: itemless array does not fail the gate", loose.ok !== false);
  ok("adk: an array WITH items is not flagged",
    !has(conv({ type: "object", properties: { a: { type: "array", items: { type: "integer" } } }, required: ["a"] }, "gemini").ledger,
      "declares no element type"));
  ok("adk: a tuple is not flagged as itemless (prefixItems is an element type)",
    !has(conv(TUPLE, "gemini").ledger, "declares no element type"));
  // Union spelling of `type` — the trap that has hidden a subtree seven times.
  ok("adk: an itemless array is found through a UNION `type` too",
    has(conv({ type: "object", properties: { a: { type: ["array", "null"] } }, required: ["a"] }, "gemini").ledger,
      "declares no element type"));
  // ...but a typeless node is NOT an array to the converting layer, so silence.
  ok("adk: a typeless node is not treated as an array",
    !has(conv({ type: "object", properties: { a: { minItems: 1 } }, required: ["a"] }, "gemini").ledger,
      "declares no element type"));
  ok("adk: the itemless-array note is narrow-path only, not on gemini-json",
    !has(conv(LOOSE, "gemini-json").ledger, "declares no element type"));

  // --- the proto constraints still apply on the client target -------------
  // A converting client cannot send what the proto has no field for, so every
  // narrow rule but the nullability spelling is unchanged.
  var t = conv(TUPLE, "gemini-client");
  ok("adk: the tuple is still collapsed on the client target",
    (prop(t, "b").items || {}).type === "integer" && prop(t, "b").maxItems === 2);
  var ie = conv({ type: "object", properties: { c: { type: "integer", enum: [101, 102] } }, required: ["c"] }, "gemini-client");
  ok("adk: the integer-enum encoding is unchanged (it survives ADK *and* the backend)",
    JSON.stringify(prop(ie, "c").enum) === JSON.stringify(["101", "102"]));

  // --- verbatim ADK-measured payloads as regression fixtures (#311/#331) ---
  // Left exactly as `_to_gemini_schema` receives them from an MCP tool schema.
  var ADK_IN = { type: "object", properties: {
    v: { type: ["string", "null"] },
    bbox: { type: "array", prefixItems: [{ type: "integer" }, { type: "integer" }] },
    mix: { type: ["string", "integer"] },
    loose: { type: "array" } }, required: ["v", "bbox", "mix", "loose"] };
  var cc = conv(ADK_IN, "gemini-client");
  ok("adk: the full battery keeps nullability, element type and every union member",
    Array.isArray(prop(cc, "v").type) &&
    (prop(cc, "bbox").items || {}).type === "integer" &&
    (prop(cc, "mix").anyOf || []).length === 2);
})();

// ---------------------------------------------------------------------------
// Cycle #337 — a null BRANCH is not a null-only TYPE.
//
// `{"anyOf":[{"type":"string"},{"type":"null"}]}` is the canonical pydantic v2
// rendering of `Optional[str]`, i.e. the most common shape in Python structured
// output. We were rewriting the `{"type":"null"}` member to `{"nullable":true}`,
// which deletes the branch's only content (#329's tell) and made `--check --to
// gemini` exit 1 on a document the live v1beta proto accepts VERBATIM.
//
// Measured 2026-08-09 against the live pre-auth proto parse (control:
// `{"type":"frobnicate"}` in the same slot is REJECTED, so the oracle was live
// and discriminating), against `google-genai==2.17.0` and `@google/genai@2.16.0`:
//   anyOf[string, null]        ACCEPTED by the proto, both clients build it
//   anyOf[string, {nullable}]  ACCEPTED too — so this is not about acceptance,
//                              it is about proposing a needless, weakening edit
//   bare {type:"null"}         ACCEPTED by the proto and by google-genai, but
//                              @google/genai THROWS "type: null can not be the
//                              only possible type for the field" -> the rewrite
//                              is still right for the STANDALONE form.
// So the rule is POSITIONAL, like `$id` in #318: fine as a branch, fatal alone.
(function () {
  // Same guarded helpers as the #336 block: a missing converter must REPORT,
  // not crash the file, or the revert check proves nothing (#322).
  function conv(sch, p) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), p) || {};
    if (!r.schema) r.schema = {};
    if (!r.ledger) r.ledger = [];
    return r;
  }
  function prop(r, k) {
    return (r.schema && r.schema.properties && r.schema.properties[k]) || {};
  }

  var OPTIONAL_STR = {
    type: "object",
    properties: {
      title: { type: "string" },
      note: { anyOf: [{ type: "string" }, { type: "null" }], default: null }
    },
    required: ["title"]
  };

  ["gemini", "gemini-client"].forEach(function (target) {
    var r = conv(OPTIONAL_STR, target);
    var note = prop(r, "note");
    var branches = note.anyOf || [];
    ok(target + ": a `{type:null}` anyOf branch keeps its type",
      branches.length === 2 && branches[1].type === "null");
    ok(target + ": the null branch is not replaced by a typeless `nullable`",
      branches.every(function (b) { return b.nullable === undefined; }));
    ok(target + ": no edit is proposed for a schema the proto accepts verbatim",
      !has(r.ledger, "Rewrote `type: \"null\"`"));
  });

  // The standalone form must still be rewritten — @google/genai refuses it.
  var alone = conv({ type: "object", properties: { n: { type: "null" } }, required: ["n"] }, "gemini");
  ok("a STANDALONE null-only type is still rewritten to `nullable`",
    prop(alone, "n").nullable === true && prop(alone, "n").type === undefined);

  // A one-element LIST is a different input: `types.Schema.type` is single
  // valued, so google-genai refuses `["null"]` even inside a union branch.
  var listInBranch = conv({
    type: "object",
    properties: { n: { anyOf: [{ type: "string" }, { type: ["null"] }] } },
    required: ["n"]
  }, "gemini");
  ok("a one-element LIST `[\"null\"]` in a branch is still normalized",
    (prop(listInBranch, "n").anyOf || [])[1].nullable === true);

  // The flag must not be inherited: a null-only type nested INSIDE a branch is
  // standalone at its own position and still needs the rewrite.
  var nested = conv({
    type: "object",
    properties: {
      n: { anyOf: [{ type: "object", properties: { deep: { type: "null" } }, required: ["deep"] }, { type: "null" }] }
    },
    required: ["n"]
  }, "gemini");
  var deep = ((prop(nested, "n").anyOf || [])[0] || {}).properties || {};
  ok("the combinator flag is not inherited by nodes inside a branch",
    deep.deep && deep.deep.nullable === true && deep.deep.type === undefined);

  // Verbatim agno 2.8.7 / pydantic 2.13.4 payloads (#311: fixtures must be real
  // generator output). `needs_conversion()` is agno's switch into its own Gemini
  // converter, and it is blind to `$defs`/`$ref` and `anyOf`, so an identical
  // `Dict[str,str]` field is treated three different ways depending on where it
  // sits. All three of these are ours to blocker, and measured that way.
  var AGNO_NESTED_DICT = {
    $defs: { Inner: { type: "object", title: "Inner",
      properties: { tags: { type: "object", additionalProperties: { type: "string" }, title: "Tags" } },
      required: ["tags"] } },
    type: "object", title: "NestedWithDict",
    properties: { title: { type: "string", title: "Title" }, inner: { $ref: "#/$defs/Inner" } },
    required: ["title", "inner"]
  };
  var AGNO_OPTIONAL_DICT = {
    type: "object", title: "OptionalDict",
    properties: {
      title: { type: "string", title: "Title" },
      tags: { anyOf: [{ type: "object", additionalProperties: { type: "string" } }, { type: "null" }],
        default: null, title: "Tags" }
    },
    required: ["title"]
  };
  ok("agno: a Dict hidden behind a `$ref` is still an open map to us",
    has(conv(AGNO_NESTED_DICT, "gemini").ledger, "open map"));
  ok("agno: a Dict hidden inside `anyOf` is still an open map to us",
    has(conv(AGNO_OPTIONAL_DICT, "gemini").ledger, "open map"));
  // ...and the null branch of that same optional dict is left alone.
  ok("agno: fixing the null branch did not disturb the open-map blocker",
    !has(conv(AGNO_OPTIONAL_DICT, "gemini").ledger, "Rewrote `type: \"null\"`"));
})();

// --- agno 2.8.7 TOOLS path: a SECOND module, with a different Dict policy ----
// #337 measured agno's response-schema/Gemini layer. `process_schema_for_strict`
// (`agno/tools/function.py:643`) is a different module reached by every @tool,
// and it disagrees with that layer about Dict fields in the opposite direction.
// All payloads below are the VERBATIM output of that function on agno 2.8.7 /
// pydantic 2.13.4 (#311), and each verdict is pinned against `openai@7.4.0`'s
// `toStrictJsonSchema()` as measured, not assumed.
(function () {
  function conv(sch, p) {
    var r = E.convert(sch, p);
    return r && r.ledger ? r : { schema: {}, ledger: [] };
  }

  // `Dict[str, str]` -> the value schema is REPLACED by `false`. Vendor THROWS
  // (on the surviving `propertyNames`), so the emptying does not even buy
  // acceptance -- it only changes which error you get.
  var AGNO_TOOL_EMPTIED_MAP = {
    type: "object",
    properties: { tags: { type: "object", propertyNames: { type: "string" }, additionalProperties: false } },
    additionalProperties: false, required: ["tags"]
  };
  ok("agno tools: an emptied Dict param is reported as a fossil, not silently 'fixed'",
    has(conv(AGNO_TOOL_EMPTIED_MAP, "openai").ledger, "its only legal value is `{}`"));
  ok("agno tools: the unsupported `propertyNames` beside it is still removed",
    has(conv(AGNO_TOOL_EMPTIED_MAP, "openai").ledger, "propertyNames"));
  // The advisory cites the layers that PRODUCE this, and there are now two
  // measured ones in different ecosystems -- citing only the first would
  // under-state it as a JS/Zod quirk when it also hits Python tool params.
  ok("agno tools: the fossil advisory names both measured producers",
    has(conv(AGNO_TOOL_EMPTIED_MAP, "openai").ledger, "make_nested_strict") &&
    has(conv(AGNO_TOOL_EMPTIED_MAP, "openai").ledger, "schema-compat"));

  // Both gaps reported in agno-agi/agno#9413, in one payload: `p` keeps
  // pydantic's `required` (1 of 2 properties), and the `Inner` object sitting
  // inside `anyOf` was never visited at all -- no `additionalProperties: false`,
  // `required` short by one. Vendor THROWS on the nested defaulted field.
  var AGNO_TOOL_ANYOF = {
    type: "object",
    properties: { p: {
      properties: {
        name: { title: "Name", type: "string" },
        inner: { anyOf: [
          { properties: { label: { title: "Label", type: "string" },
                          weight: { default: 1.0, title: "Weight", type: "number" } },
            required: ["label"], title: "Inner", type: "object" },
          { type: "null" }
        ], default: null }
      },
      required: ["name"], title: "WithOptModel", type: "object", additionalProperties: false
    } },
    additionalProperties: false, required: ["p"]
  };
  var anyofLedger = conv(AGNO_TOOL_ANYOF, "openai").ledger;
  ok("agno tools: an under-populated nested `required` is caught",
    has(anyofLedger, "added to required"));
  ok("agno tools: the object inside `anyOf` that agno never visited is reached by us",
    has(anyofLedger, "weight"));

  // Over-blocking guards: agno's processing is CORRECT for these two, the vendor
  // accepts both verbatim, and so must we. Without these the block above could
  // pass by being merely stricter than the vendor (#312/#314/#317/#322).
  ok("agno tools: an ordinary tool schema is left alone",
    conv({ type: "object", properties: { name: { type: "string" }, count: { type: "integer" } },
           additionalProperties: false, required: ["name", "count"] }, "openai").ledger.length === 0);
  ok("agno tools: a collapsed tuple param is left alone",
    conv({ type: "object", properties: { bbox: { type: "array", items: { type: "integer" } } },
           additionalProperties: false, required: ["bbox"] }, "openai").ledger.length === 0);

  // The OTHER Dict policy, for contrast: agno's response path PRESERVES the open
  // map and drops the field from `required`; openai-python's own
  // `to_strict_json_schema` preserves it and keeps it in `required`. The vendor
  // THROWS on both, so neither is a reference implementation to copy.
  var AGNO_RESPONSE_PATH_DICT = {
    properties: { tags: { additionalProperties: { type: "string" }, title: "Tags", type: "object" },
                  name: { title: "Name", type: "string" } },
    required: ["name"], title: "DictModel", type: "object", additionalProperties: false
  };
  ok("agno response path: the preserved open map is a blocker, not an advisory",
    has(conv(AGNO_RESPONSE_PATH_DICT, "openai").ledger, "open map"));
  ok("agno response path: the Dict dropped from `required` is also caught",
    has(conv(AGNO_RESPONSE_PATH_DICT, "openai").ledger, "added to required"));
})();


// --- semantic-kernel 1.44.1: the generator ITSELF empties the map ------------
// A fourth independent generator in this fixture set: `KernelJsonSchemaBuilder`
// builds JSON Schema straight from Python type hints, with no pydantic, no Zod
// and no invopop anywhere in the path. Reached by
// `_handle_structured_output` (`connectors/ai/open_ai/services/open_ai_handler.py:195`)
// whenever `response_format` is a plain class rather than a `BaseModel`; the
// result is then wrapped by `generate_structured_output_response_format_schema`,
// which applies NO transform and stamps `strict: True`.
//
// Every payload below is the VERBATIM output of
// `KernelJsonSchemaBuilder.build(parameter_type=..., structured_output=True)`
// on semantic-kernel 1.44.1 / python 3.12 (#311), and every verdict is pinned
// against `openai@7.4.0`'s `toStrictJsonSchema()` as MEASURED, not assumed.
(function () {
  function conv(sch, p) {
    var r = E.convert(sch, p);
    return r && r.ledger ? r : { schema: {}, ledger: [] };
  }
  // Match the advisory on its SEMANTIC core ("its only legal value is `{}`"),
  // not on an incidental clause. #340 changed "declares no `properties`" to
  // "declares no usable `properties`" when the rule widened to cover
  // `properties: {}`, and this helper -- keyed on the old literal -- reported
  // three failures in code that was working correctly.
  function emptiedMapEntry(r) {
    for (var i = 0; i < r.ledger.length; i++) {
      var l = r.ledger[i];
      if (l.op === "=" && l.advisory === true &&
          String(l.msg || "").indexOf("only legal value is `{}`") !== -1) return l;
    }
    return null;
  }
  // The emptied-map advisory ends with the shared open-map remedy, so its text
  // mentions "open map" too. Discriminate on the OP, not on the prose: a
  // blocker is `!` and never advisory.
  function openMapBlocker(r) {
    return r.ledger.some(function (l) {
      return l.op === "!" && !l.advisory && String(l.msg || "").indexOf("This is an open map") !== -1;
    });
  }

  // Vendor: ACCEPT verbatim. We must not touch it (over-blocking guard).
  var SK_PLAIN = {
    type: "object",
    properties: { title: { type: "string" }, count: { type: "integer" } },
    required: ["title", "count"], additionalProperties: false
  };
  ok("semantic-kernel: an ordinary class the vendor accepts verbatim is left alone",
    conv(SK_PLAIN, "openai").ledger.length === 0);

  // `Optional[str]` is dropped from `required` by the builder, and the builder
  // ALSO staples `additionalProperties: false` onto the string node. Vendor
  // REPAIRS (widens `required`), so a change is genuinely owed here -- and
  // semantic-kernel's own path applies no transform, so nothing repairs it.
  var SK_OPTIONAL = {
    type: "object",
    properties: { title: { type: "string" },
                  note: { type: ["string", "null"], additionalProperties: false } },
    required: ["title"], additionalProperties: false
  };
  ok("semantic-kernel: the optional field missing from `required` is caught",
    has(conv(SK_OPTIONAL, "openai").ledger, "added to required"));
  // `additionalProperties: false` on a STRING node is not an emptied map --
  // there is no `object` in its `type`. Guard against a false advisory.
  ok("semantic-kernel: a closed non-object node is not reported as an emptied map",
    emptiedMapEntry(conv(SK_OPTIONAL, "openai")) === null);

  // `Dict[str, str]`: the builder computes the value schema and then overwrites
  // it with `false` three lines later. Vendor ACCEPTS this VERBATIM -- a silent
  // 200 with a field that can never be populated.
  var SK_DICT = {
    type: "object",
    properties: { title: { type: "string" }, tags: { type: "object", additionalProperties: false } },
    required: ["title", "tags"], additionalProperties: false
  };
  ok("semantic-kernel: the emptied map is reported",
    emptiedMapEntry(conv(SK_DICT, "openai")) !== null);
  ok("semantic-kernel: the emptied map is ADVISORY, never a gate failure",
    (emptiedMapEntry(conv(SK_DICT, "openai")) || {}).advisory === true);
  ok("semantic-kernel: the advisory cites the third producer by name",
    has(conv(SK_DICT, "openai").ledger, "semantic-kernel"));
  ok("semantic-kernel: the advisory says there is no earlier point to check",
    has(conv(SK_DICT, "openai").ledger, "no earlier point to check"));
  ok("semantic-kernel: the advisory still names the post-hoc-layer case too",
    has(conv(SK_DICT, "openai").ledger, "BEFORE that layer runs"));

  // THE FINDING: the same logical model down the OTHER branch of the same
  // function. `_handle_structured_output` case 1 sends a `BaseModel` through
  // openai-python's `type_to_response_format_param`, which PRESERVES the open
  // map (#329). Vendor THROWS on that one and ACCEPTS the emptied one, so the
  // two branches of one function fail in OPPOSITE directions for one field --
  // and our verdicts have to disagree in the same way.
  var SK_PYDANTIC_DICT = {
    properties: { title: { title: "Title", type: "string" },
                  tags: { additionalProperties: { type: "string" }, title: "Tags", type: "object" } },
    required: ["title", "tags"], title: "DictM", type: "object", additionalProperties: false
  };
  ok("semantic-kernel: the pydantic branch keeps the map OPEN -> blocker",
    openMapBlocker(conv(SK_PYDANTIC_DICT, "openai")));
  ok("semantic-kernel: the two branches of one function get opposite verdicts",
    openMapBlocker(conv(SK_PYDANTIC_DICT, "openai")) &&
    !openMapBlocker(conv(SK_DICT, "openai")) &&
    emptiedMapEntry(conv(SK_DICT, "openai")) !== null);

  // `Tuple[int, int, int, int]` -> draft-07 array-form `items`, which the
  // vendor THROWS on. Homogeneous, so the collapse is lossless.
  var SK_TUPLE = {
    type: "object",
    properties: { title: { type: "string" },
                  bbox: { type: "array",
                          items: [{ type: "integer" }, { type: "integer" },
                                  { type: "integer" }, { type: "integer" }],
                          additionalProperties: false } },
    required: ["title", "bbox"], additionalProperties: false
  };
  ok("semantic-kernel: the array-form tuple is caught, not passed through",
    has(conv(SK_TUPLE, "openai").ledger, "Collapsed a 4-element tuple"));
})();

// ---------------------------------------------------------------------------
// Cycle #340 -- crewai 1.15.14, and a repair that forges its own alibi.
//
// Every fixture below is the VERBATIM output of crewai's own public functions in
// `crewai/utilities/pydantic_schema_utils.py`, captured 2026-08-09, and every
// verdict is `openai@7.4.0`'s `toStrictJsonSchema()`.
//
// The module ships TWO pipelines over the same four passes:
//   `_common_strict_pipeline`   -> `sanitize_tool_params_for_{openai,anthropic,
//                                   bedrock}_strict`  (tools path)
//   `generate_model_description` -> 16 call sites, and it stamps `strict: True`
// and they apply those passes in a DIFFERENT ORDER, which is why one field can
// come out of the two surfaces in two different broken states.
(function () {
  function conv(sch, p) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), p);
    return r && r.ledger ? r : { schema: {}, ledger: [] };
  }
  // Key on the ledger OP, not on the prose. The open-map BLOCKER explains that
  // closing the map would leave "an object whose only legal value is `{}`", so
  // matching that phrase alone cannot tell the blocker from the advisory --
  // the same trap #339 hit and recorded. A fossil is `=` and always advisory.
  function fossil(r) {
    return r.ledger.filter(function (l) {
      return l.op === "=" && l.advisory === true &&
        String(l.msg || "").indexOf("only legal value is `{}`") !== -1;
    });
  }

  // `Dict[str, str]` through the tool path. `force_additional_properties_false`
  // overwrites `additionalProperties` with `false` AND adds `properties: {}` +
  // `required: []`.
  var CW_MAP_TOOLS = {
    type: "object", additionalProperties: false, required: ["name", "tags"],
    properties: {
      name: { type: "string" },
      tags: { type: "object", additionalProperties: false, properties: {}, required: [] }
    }
  };
  // A genuinely EMPTY BaseModel through the same path.
  var CW_EMPTY_TOOLS = {
    type: "object", additionalProperties: false, required: ["name", "blank"],
    properties: {
      name: { type: "string" },
      blank: { type: "object", additionalProperties: false, properties: {}, required: [] }
    }
  };

  // THE FINDING: the two nodes are byte-identical. The repair did not merely
  // delete the value type, it manufactured the evidence that would have told
  // the two apart.
  ok("crewai: an emptied map and a real empty model are byte-identical",
    JSON.stringify(CW_MAP_TOOLS.properties.tags) ===
    JSON.stringify(CW_EMPTY_TOOLS.properties.blank));

  // Vendor ACCEPTS both verbatim, so nothing downstream will ever warn. Before
  // #340 our advisory was silent on both -- the false negative this block fixes.
  ok("crewai: the emptied map is now reported", fossil(conv(CW_MAP_TOOLS, "openai")).length === 1);
  ok("crewai: and only as an advisory",
    fossil(conv(CW_MAP_TOOLS, "openai")).every(function (l) { return l.advisory === true; }));
  ok("crewai: the advisory does not fail the gate",
    conv(CW_MAP_TOOLS, "openai").ledger.every(function (l) { return l.advisory === true; }));
  ok("crewai: the advisory names crewai as the producer that erases the marker",
    has(conv(CW_MAP_TOOLS, "openai").ledger, "force_additional_properties_false"));
  ok("crewai: and refuses to claim which cause it was",
    has(conv(CW_MAP_TOOLS, "openai").ledger, "It no longer settles it"));

  // `type: ["object", "null"]` matches neither `force_additional_properties_false`
  // nor `ensure_all_properties_required` (both compare `type == "object"` with
  // strict equality), so the node is neither closed nor required-completed and
  // the VENDOR THROWS on the sanitizer's own output. We must catch what crewai's
  // own strict-mode sanitizer does not.
  var CW_UNIONOBJ_TOOLS = {
    type: "object", additionalProperties: false, required: ["inner"],
    properties: { inner: { type: ["object", "null"], properties: { a: { type: "string" } } } }
  };
  ok("crewai: a union-typed object skipped by its `== \"object\"` dispatch is caught",
    conv(CW_UNIONOBJ_TOOLS, "openai").ledger.length > 0);
  // Guarded: a reverted engine must REPORT these as failures, not crash the file
  // and hide every assertion after it (#322's trap, hit five times now).
  function innerOf(r) {
    return (((r || {}).schema || {}).properties || {}).inner || {};
  }
  ok("crewai: and our repair closes it",
    innerOf(conv(CW_UNIONOBJ_TOOLS, "openai")).additionalProperties === false);
  ok("crewai: and completes its `required`",
    JSON.stringify(innerOf(conv(CW_UNIONOBJ_TOOLS, "openai")).required) ===
    JSON.stringify(["a"]));

  // Same dispatch miss, opposite consequence: the union `type` is what SAVES the
  // open map from being emptied -- and the vendor then rejects it. A live open
  // map is a blocker, not a fossil, and our detector must see through the union.
  var CW_UNIONMAP_TOOLS = {
    type: "object", additionalProperties: false, required: ["tags"],
    properties: { tags: { type: ["object", "null"], additionalProperties: { type: "string" } } }
  };
  ok("crewai: a union-typed OPEN map is a blocker, not the fossil advisory",
    conv(CW_UNIONMAP_TOOLS, "openai").ledger.some(function (l) {
      return l.op === "!" && !l.advisory && /This is an open map/.test(l.msg);
    }) && fossil(conv(CW_UNIONMAP_TOOLS, "openai")).length === 0);

  // ORDERING: `Optional[Any] = None` out of the two surfaces. The tools path
  // keeps a closed `anyOf`; the response-format path -- which runs
  // `force_additional_properties_false` BEFORE `ensure_type_in_schemas`, so the
  // object that pass invents is never closed -- emits a bare `{"type":"object"}`
  // that the vendor then repairs. Same field, same version, two shapes.
  var CW_OPTANY_RF = {
    type: "object", additionalProperties: false, required: ["name", "payload"], title: "OptAnyField",
    properties: { name: { type: "string", title: "Name" },
                  payload: { type: "object", title: "Payload", default: null } }
  };
  var CW_OPTANY_TOOLS = {
    type: "object", additionalProperties: false, required: ["name", "payload"],
    properties: { name: { type: "string" },
                  payload: { anyOf: [{ type: "object", additionalProperties: false,
                                       properties: {}, required: [] }, { type: "null" }] } }
  };
  ok("crewai: the response-format surface leaves the invented object OPEN",
    conv(CW_OPTANY_RF, "openai").ledger.some(function (l) { return !l.advisory; }));
  ok("crewai: the tools surface does not, and we leave it alone",
    conv(CW_OPTANY_TOOLS, "openai").ledger.every(function (l) { return l.advisory === true; }));

  // Over-blocking guards. crewai already deleted the undeclared `required` name
  // upstream (`["a","ghost"]` -> `["a"]`), and the vendor accepts the result --
  // so there is nothing left for us to report on THIS file.
  var CW_GHOST_TOOLS = {
    type: "object", additionalProperties: false, required: ["a"],
    properties: { a: { type: "string" } }
  };
  ok("crewai: a required list crewai already pruned needs no change from us",
    conv(CW_GHOST_TOOLS, "openai").ledger.length === 0);
  var CW_PLAIN_TOOLS = {
    type: "object", additionalProperties: false, required: ["name", "count"],
    properties: { name: { type: "string" }, count: { type: "integer" } }
  };
  ok("crewai: an ordinary sanitized model is left untouched",
    conv(CW_PLAIN_TOOLS, "openai").ledger.length === 0);

  // `prefixItems` survives BOTH pipelines untouched and the vendor throws on all
  // four surfaces -- while `generate_model_description` stamps `strict: True`.
  var CW_TUPLE_RF = {
    type: "object", additionalProperties: false, required: ["bbox"], title: "Tup",
    properties: { bbox: { type: "array", title: "Bbox", minItems: 4, maxItems: 4,
                          prefixItems: [{ type: "integer" }, { type: "integer" },
                                        { type: "integer" }, { type: "integer" }] } }
  };
  ok("crewai: the tuple its sanitizer never touches is caught",
    has(conv(CW_TUPLE_RF, "openai").ledger, "Collapsed a 4-element tuple"));
})();

// --- #341 llama-index-core: a five-key top-level KEEP-list, and the classifier
// --- that decides whether the input is a schema at all -----------------------
//
// `ToolMetadata.get_parameters_dict()` (llama-index-core==0.14.23) filters the
// pydantic schema down to exactly {type, properties, required, definitions,
// $defs}. VERBATIM outputs of that filter, captured 2026-08-09 against
// pydantic==2.13.4, with the top-level `additionalProperties = False` that
// llama-index-llms-openai then bolts on (base.py:997 unconditionally,
// responses.py:901 only under strict).
(function () {
  // RootModel[Inner]: pydantic emits {$ref, $defs, title}; the filter keeps the
  // BAG and drops the POINTER, so the tool arrives describing nothing at all.
  var LI_ROOT_REF = {
    "$defs": { "Inner": { "properties": { "x": { "title": "X", "type": "integer" } },
                          "required": ["x"], "title": "Inner", "type": "object" } },
    "additionalProperties": false
  };
  // RootModel[Union[A,B]]: the same, via a dropped root `anyOf`.
  var LI_ROOT_UNION = {
    "$defs": { "A": { "properties": { "kind": { "const": "a", "title": "Kind", "type": "string" } },
                      "required": ["kind"], "title": "A", "type": "object" },
               "B": { "properties": { "kind": { "const": "b", "title": "Kind", "type": "string" } },
                      "required": ["kind"], "title": "B", "type": "object" } },
    "additionalProperties": false
  };

  // (1) THE CLASSIFIER. `looksLikeSchema()` was an eight-key allowlist, so this
  // document -- which has none of those eight -- was classified as DATA and fed
  // to inferSchema(), producing a schema OF THE SCHEMA that the vendor accepts
  // verbatim. `inferred` is the observable.
  ok("li: a $defs-only root is classified as a schema, not data",
    E.convert(LI_ROOT_REF, "openai").inferred === false);
  ok("li: a dropped root anyOf is classified as a schema, not data",
    E.convert(LI_ROOT_UNION, "openai").inferred === false);

  // Every root-keyword-only shape measured this cycle. Annotation-only keys and
  // `{}` are DELIBERATELY left ambiguous (a book record has `title` and
  // `description` too), so they are asserted the other way, below.
  var KEYWORD_ROOTS = [
    ["definitions bag", { definitions: { I: { type: "object" } } }],
    ["open map, no type", { additionalProperties: { type: "string" } }],
    ["items, no type", { items: { type: "string" } }],
    ["prefixItems, no type", { prefixItems: [{ type: "integer" }] }],
    ["const only", { "const": "x" }],
    ["not only", { "not": { type: "string" } }],
    ["required only", { required: ["a"] }],
    ["patternProperties", { patternProperties: { "^a": { type: "string" } } }],
    ["format only", { format: "email" }],
    ["minimum only", { minimum: 0 }],
    ["if/then", { "if": { type: "string" }, "then": { minLength: 1 } }],
    ["contains", { contains: { type: "integer" } }],
    ["propertyNames", { propertyNames: { pattern: "^a" } }],
    ["unevaluatedProperties", { unevaluatedProperties: false }],
    ["dependentRequired", { dependentRequired: { a: ["b"] } }]
  ];
  var misread = KEYWORD_ROOTS.filter(function (c) {
    return E.convert(c[1], "openai").inferred !== false;
  });
  ok("li: no root-keyword-only schema is misread as data (" +
     KEYWORD_ROOTS.length + " shapes)", KEYWORD_ROOTS.length > 0 && misread.length === 0);

  // The other direction, and it is why the rule is not "any key is a keyword":
  // ordinary data objects carry keys that happen to be keywords.
  var DATA = [
    ["invoice: items + total", { items: [{ sku: "a" }], total: 12.5 }],
    ["items holding numbers", { items: [1, 2, 3] }],
    ["book: title + description", { title: "Dune", description: "a novel" }],
    ["plain record", { name: "ada", age: 36 }],
    ["format as a data key", { format: "pdf", url: "x" }],
    ["required as a boolean", { required: true }],
    ["pattern as a fabric", { pattern: "stripes", color: "red" }],
    ["default alone", { "default": 5 }],
    ["empty object", {}]
  ];
  var flipped = DATA.filter(function (c) { return E.convert(c[1], "openai").inferred !== true; });
  ok("li: ordinary data objects are still inferred from (" + DATA.length + " controls)",
    DATA.length > 0 && flipped.length === 0);

  // (2) THE ROOT RULE. Measured on openai@7.4.0's toStrictJsonSchema(): the root
  // test is a literal `type === "object"` comparison, so EVERY typeless root
  // throws -- including one that declares `properties`.
  var ro = E.convert(LI_ROOT_REF, "openai");
  var roBlockers = ro.ledger.filter(function (l) { return l.op === "!" && !l.advisory; });
  ok("openai: a root with no type and no properties is a blocker", roBlockers.length >= 1);
  ok("openai: the blocker names the surviving bag and the dropped pointer",
    has(ro.ledger, "definitions survived and the pointer"));
  ok("openai: the blocker names llama-index as a measured producer",
    has(ro.ledger, "get_parameters_dict"));
  ok("openai: the blocker refuses the type: object repair by name",
    has(ro.ledger, "only legal value is `{}`"));
  ok("openai: and does NOT add type: object to a rootless schema",
    ro.schema.type === undefined);

  // The other arm: a typeless root that DOES describe an object is repaired
  // losslessly, because supplying the `type` leaves the properties intact.
  var tp = E.convert({ properties: { a: { type: "string" } }, required: ["a"] }, "openai");
  ok("openai: a typeless root WITH properties gets type: object added",
    tp.schema.type === "object" &&
    tp.ledger.filter(function (l) { return l.op === "!" && !l.advisory; }).length === 0);
  ok("openai: and says why declaring properties was not enough",
    has(tp.ledger, "declaring `properties` is not enough"));

  // ORDERING GUARD. A single-member object `allOf` is ACCEPT-repaired by the
  // vendor because it flattens first. The root check therefore has to run after
  // the walk; running it earlier blocked a schema the vendor accepts.
  var ao = E.convert({ allOf: [{ type: "object", properties: { a: { type: "string" } },
                                 required: ["a"], additionalProperties: false }] }, "openai");
  ok("openai: a single-member object allOf root is NOT blocked",
    ao.schema.type === "object" &&
    ao.ledger.filter(function (l) { return l.op === "!" && !l.advisory; }).length === 0);

  // (3) ANTHROPIC. Measured on @anthropic-ai/sdk@0.116.0: betaTool() AND
  // betaJSONSchemaOutputFormat() each throw `JSON schema ... must be an object,
  // but got undefined`. The tools target had two arms (typeless-but-object,
  // typed-as-something-else) and this fell through both, exiting 0.
  ["anthropic", "anthropic-json"].forEach(function (tgt) {
    var r = E.convert(LI_ROOT_REF, tgt);
    ok(tgt + ": a rootless schema is a blocker",
      r.ledger.filter(function (l) { return l.op === "!" && !l.advisory; }).length >= 1);
  });
  ok("anthropic: the blocker quotes both helpers",
    has(E.convert(LI_ROOT_REF, "anthropic").ledger, "must be an object, but got undefined"));

  // GUARD: the Python target deliberately keeps a root `$ref` (the Python SDK
  // passes it verbatim). A `$ref` root is typeless but is NOT rootless, so the
  // new arm must not fire on it.
  var REF_ROOT = { "$ref": "#/$defs/I",
                   "$defs": { I: { type: "object", properties: { x: { type: "integer" } } } } };
  ok("anthropic-json-python: a root $ref is still not a rootless blocker",
    !has(E.convert(REF_ROOT, "anthropic-json-python").ledger, "declares no object shape at all"));

  // (4) GEMINI IS DELIBERATELY UNCHANGED, and it was measured rather than
  // assumed (#314's no-porting rule): google-genai==2.17.0's `types.Schema`
  // ACCEPTS a typeless root with properties and accepts a bare `{}`. There is no
  // root-must-be-object rule in that proto, so adding one would be the
  // over-strictness class this project has shipped five times.
  ["gemini", "gemini-json", "gemini-client"].forEach(function (tgt) {
    ok(tgt + ": a typeless root with properties is not blocked",
      E.convert({ properties: { a: { type: "string" } }, required: ["a"] }, tgt)
        .ledger.filter(function (l) { return l.op === "!" && !l.advisory; }).length === 0);
  });
})();


// --- DANGLING LOCAL `$ref` (strands-agents 1.51.0) --------------------------
//
// `normalizeRefSpelling` only ever inspected refs that do NOT start with `#`,
// so a local pointer with an absent target was never checked: `--check --to
// openai` exited 0 while `toStrictJsonSchema()` (openai@7.4.0) throws
// "Local $ref at `properties/a` does not resolve to an object or boolean
// schema". Fixtures are the VERBATIM output of strands-agents 1.51.0's
// `convert_pydantic_to_tool_spec` (#311: test against real generator input).
//
// These go through convert(), not the raw converters: the check is a
// convert()-level post-pass that runs on the OUTPUT, so it also audits our own
// ref rewrites and the orphan-`$defs` pruner.
(function () {
  function blockers(l) {
    return (l || []).filter(function (e) { return e.op === "!" && !e.advisory; });
  }
  function dangling(l) {
    return (l || []).filter(function (e) { return e.msg.indexOf("the reference is dangling") !== -1; });
  }

  var DANGLING = { type: "object", title: "T", additionalProperties: false,
                   required: ["a"], properties: { a: { $ref: "#/$defs/Missing" } } };
  var NESTED = { type: "object", title: "T2", additionalProperties: false, required: ["a"],
                 properties: { a: { type: "array", items: { $ref: "#/$defs/Gone" } } } };

  // Measured: the vendor THROWS on both, so both are blockers.
  ["openai", "gemini"].forEach(function (tgt) {
    ok(tgt + ": a dangling local $ref is a blocker",
      blockers(E.convert(DANGLING, tgt).ledger).length >= 1);
    ok(tgt + ": a dangling $ref inside `items` is a blocker",
      blockers(E.convert(NESTED, tgt).ledger).length >= 1);
  });

  // OVER-BLOCK GUARD, and it is the whole reason this is conditional: measured
  // on @anthropic-ai/sdk 0.116.0, BOTH `betaTool()` and
  // `betaJSONSchemaOutputFormat()` ACCEPT a dangling ref and forward it
  // verbatim. Flagging it as a gate failure there would be the false-CI class
  // this project has shipped five times.
  ["anthropic", "anthropic-json"].forEach(function (tgt) {
    var r = E.convert(DANGLING, tgt);
    ok(tgt + ": a dangling $ref is reported but never fails the gate",
      dangling(r.ledger).length >= 1 && blockers(r.ledger).length === 0);
    // Requires a HIT first: `.every()` on an empty array is vacuously true, so
    // without this the assertion passes against an engine that reports nothing.
    ok(tgt + ": and it is marked advisory",
      dangling(r.ledger).length >= 1 &&
      dangling(r.ledger).every(function (e) { return e.advisory === true; }));
  });

  // The verbatim strands payload: `_flatten_schema` keeps `oneOf` + its `$ref`s
  // and drops the `$defs` bag those refs point at.
  var STRANDS_DISC = { type: "object", title: "Disc", additionalProperties: false, required: ["pet"],
    properties: { pet: { title: "Pet",
      discriminator: { propertyName: "kind", mapping: { cat: "#/$defs/Cat", dog: "#/$defs/Dog" } },
      oneOf: [{ $ref: "#/$defs/Cat" }, { $ref: "#/$defs/Dog" }] } } };
  ok("openai: strands' discriminator payload is caught as dangling",
    dangling(E.convert(STRANDS_DISC, "openai").ledger).length >= 1);
  ok("openai: the dangling blocker names the measured producer",
    has(E.convert(STRANDS_DISC, "openai").ledger, "strands-agents 1.51.0"));

  // --- OVER-BLOCK GUARDS: everything below MUST NOT be reported ------------
  var RESOLVES = { type: "object", additionalProperties: false, required: ["a"],
    $defs: { T: { type: "object", properties: { x: { type: "integer" } } } },
    properties: { a: { $ref: "#/$defs/T" } } };
  ok("a $ref whose target exists is not reported",
    dangling(E.convert(RESOLVES, "openai").ledger).length === 0);

  // draft-07 `definitions` is renamed to `$defs` and every ref repointed. The
  // check runs AFTER that, so it must see the renamed bag, not report the
  // pre-rename spelling as dangling.
  var DRAFT07 = { type: "object", additionalProperties: false, required: ["a"],
    definitions: { T: { type: "object", properties: { x: { type: "integer" } } } },
    properties: { a: { $ref: "#/definitions/T" } } };
  ok("a `#/definitions/...` ref that survives the $defs rename is not reported",
    dangling(E.convert(DRAFT07, "openai").ledger).length === 0);

  // A property literally NAMED `$ref` is data, not a reference (#334's control
  // pair): its value is a schema object, not a string, so it must not match.
  var PROP_NAMED_REF = { type: "object", additionalProperties: false, required: ["$ref"],
    properties: { $ref: { type: "string" } } };
  ok("a property NAMED `$ref` is not a false positive",
    dangling(E.convert(PROP_NAMED_REF, "openai").ledger).length === 0);

  // RFC 6901 escapes: `~1` is `/`, `~0` is `~`. A definition whose NAME contains
  // a slash resolves only if the pointer is unescaped properly.
  var ESCAPED = { type: "object", additionalProperties: false, required: ["a"],
    $defs: { "a/b": { type: "object", properties: { x: { type: "integer" } } } },
    properties: { a: { $ref: "#/$defs/a~1b" } } };
  ok("an escaped JSON pointer (`~1`) resolves and is not reported",
    dangling(E.convert(ESCAPED, "openai").ledger).length === 0);

  // `#` alone is the root document — a legal self-reference, not a dangling one.
  ok("a bare `#` self-reference is not reported",
    dangling(E.convert({ type: "object", additionalProperties: false, required: ["a"],
      properties: { a: { $ref: "#" } } }, "openai").ledger).length === 0);

  // --- The orphan-`$defs` pruner, which the check above caught deleting -----
  //
  // The pruner decided what to KEEP by string-matching `"#/$defs/<name>"`, so
  // two ordinary spellings of the same pointer looked like no reference at all
  // and the definition was deleted — turning an intact input into an output
  // with a dangling ref. Ninth instance of the alternate-spelling class, and
  // #320's fail-closed rule applied to the escape form.
  var ESCAPED_KEPT = E.convert(ESCAPED, "openai").schema;
  ok("pruner: a def referenced by an escaped pointer survives",
    !!(ESCAPED_KEPT.$defs && ESCAPED_KEPT.$defs["a/b"]));

  var DEEP = { type: "object", additionalProperties: false, required: ["a"],
    $defs: { T: { type: "object", properties: { x: { type: "integer" } } } },
    properties: { a: { $ref: "#/$defs/T/properties/x" } } };
  var DEEP_OUT = E.convert(DEEP, "openai");
  ok("pruner: a def referenced by a pointer INTO it survives",
    !!(DEEP_OUT.schema.$defs && DEEP_OUT.schema.$defs.T));
  ok("pruner: and that ref is therefore not reported as dangling",
    dangling(DEEP_OUT.ledger).length === 0);

  // GUARD: the fix must not simply stop pruning. A genuinely unreferenced
  // definition is still removed — dead `$defs` count against OpenAI's
  // 5000-property budget, which is why the pruner exists.
  ok("pruner: a genuinely orphaned def is still removed",
    !E.convert({ type: "object", additionalProperties: false, required: ["a"],
      $defs: { Unused: { type: "object", properties: { z: { type: "integer" } } } },
      properties: { a: { type: "string" } } }, "openai").schema.$defs);

  // A pointer that lands on a STRING rather than a schema is dangling in the
  // sense the vendor means ("does not resolve to an object or boolean schema").
  ok("a pointer landing on a non-schema value is reported",
    dangling(E.convert({ type: "object", additionalProperties: false, required: ["a"],
      $defs: { T: { type: "object", properties: { x: { type: "integer" } } } },
      properties: { a: { $ref: "#/$defs/T/type" } } }, "openai").ledger).length >= 1);
})();

// ---------------------------------------------------------------------------
// Cycle #343: three keywords the BACKEND accepts that no CLIENT declares.
//
// GEMINI_ALLOWED was derived from three client artifacts that agreed exactly
// (JS .d.ts, Python types.Schema, Go struct tags), and that agreement was read
// as "this is the proto". Measured against the live v1beta endpoint — which
// validates before auth, so a dummy key still returns a real verdict, and which
// was control-checked (a bogus `type` IS rejected, eleven other stripped
// keywords come back `Cannot find field`) — `oneOf`, `allOf` and `not` are
// accepted at the root and nested. Stripping them deleted a constraint the
// destination would have taken.
(function () {
  var PET = { title: "Pet", oneOf: [
    { type: "object", properties: { meow: { type: "string" } }, required: ["meow"] },
    { type: "object", properties: { bark: { type: "string" } }, required: ["bark"] } ] };

  var G = E.convert(PET, "gemini");
  // The whole point: the union SURVIVES. Before this change the output was
  // `{"title":"Pet"}` — accepted by the backend, constraining nothing.
  ok("gemini: `oneOf` is kept, not deleted",
    Array.isArray(G.schema.oneOf) && G.schema.oneOf.length === 2);
  // Guarded: with the rule reverted `oneOf` is gone entirely, and an unguarded
  // dereference here aborts the whole file and hides every assertion after it
  // (#322). A suite that cannot survive the absence of the thing it tests
  // cannot tell you how much of it depends on that thing.
  ok("gemini: and the branches keep their own properties",
    !!(G.schema.oneOf && G.schema.oneOf[0] && G.schema.oneOf[0].properties &&
       G.schema.oneOf[0].properties.meow));
  ok("gemini: keeping it is ADVISORY, never a gate failure",
    G.ledger.some(function (l) {
      return l.advisory && l.msg.indexOf("Kept `oneOf`") !== -1;
    }));
  // #319: which client you use is a fact only the caller has, so the advisory
  // must state the outcome per client rather than picking one.
  ok("gemini: the advisory names the Python raise",
    has(G.ledger, "raises locally"));
  ok("gemini: and names the Go silent drop",
    has(G.ledger, "DROPS it with no error"));

  ok("gemini: `allOf` is kept too",
    Array.isArray(E.convert({ allOf: [{ type: "object",
      properties: { a: { type: "string" } } }] }, "gemini").schema.allOf));
  ok("gemini: `not` is kept too",
    !!E.convert({ type: "string", not: { type: "string", pattern: "^x" } },
      "gemini").schema.not);

  // A converting client rebuilds the request from its own Schema type, and no
  // client declares these — so there the strip is right, and only the reason
  // changes. The two targets genuinely disagree about the same document.
  var GC = E.convert(PET, "gemini-client");
  ok("gemini-client: still strips `oneOf`", !("oneOf" in GC.schema));
  ok("gemini-client: and no longer claims the PROTO cannot carry it",
    has(GC.ledger, "the v1beta proto DOES have this field"));

  // OVER-BLOCK GUARDS. The eleven keywords the endpoint really does reject
  // must still be stripped — widening the allowlist wholesale would be the
  // false-pass class this project calls worse than no gate.
  ["$schema", "const", "uniqueItems", "exclusiveMinimum", "patternProperties",
   "propertyNames", "contains", "dependentRequired", "multipleOf"].forEach(function (k) {
    var input = { type: "object", properties: { a: { type: "string" } } };
    input[k] = (k === "const" ? "x" : k === "uniqueItems" ? true :
      k === "multipleOf" || k === "exclusiveMinimum" ? 2 : { a: { type: "string" } });
    ok("gemini: still strips `" + k + "` (endpoint: Cannot find field)",
      !(k in E.convert(input, "gemini").schema));
  });

  // The walker had no `not` arm — `not` holds a SINGLE subschema, so the
  // combinator loop never saw it. That was latent while every target stripped
  // or demoted `not` first; keeping it on gemini makes it load-bearing.
  var NOT_MAP = { type: "object", properties: { a: { type: "string" } }, required: ["a"],
    not: { type: "object", properties: { b: { type: "object",
      additionalProperties: { type: "string" } } } } };
  ok("walk descends `not`: an open map inside it is still found",
    E.convert(NOT_MAP, "gemini").ledger.some(function (l) {
      return l.op === "!" && l.msg.indexOf("open map") !== -1;
    }));
  // Control: the same node NOT inside `not` was always found, so the assertion
  // above is about the container and not about the open-map rule.
  ok("control: the same open map outside `not` is found too",
    E.convert({ type: "object", required: ["b"], properties: { b: { type: "object",
      additionalProperties: { type: "string" } } } }, "gemini")
      .ledger.some(function (l) { return l.op === "!"; }));
  ok("walk descends `not`: a boolean subschema inside it is found",
    E.convert({ type: "object", additionalProperties: false, required: ["a"],
      properties: { a: { type: "string" } },
      not: { type: "object", properties: { b: true } } }, "openai")
      .ledger.some(function (l) {
        return l.op === "!" && l.msg.indexOf("boolean subschema") !== -1;
      }));
})();

// --- #344: `format` is carried, and the keyword sweep's genuine negative -----
//
// Fixture is the VERBATIM `model_json_schema()` output of an ordinary
// pydantic 2.13.4 model (EmailStr / AnyUrl / UUID / max_length), per #311 —
// not a shape written by hand to suit the rule.
(function () {
  var PYDANTIC_CONTACT = {
    properties: {
      email:   { format: "email", title: "Email", type: "string" },
      website: { format: "uri", minLength: 1, title: "Website", type: "string" },
      ref:     { format: "uuid", title: "Ref", type: "string" },
      name:    { maxLength: 40, title: "Name", type: "string" }
    },
    required: ["email", "website", "ref", "name"],
    title: "Contact", type: "object"
  };
  var r = E.toGemini(JSON.parse(JSON.stringify(PYDANTIC_CONTACT)));
  var p = r.schema.properties;

  // The defect: three constraints were deleted from a schema the live endpoint
  // ALREADY accepts, on a justification the vendor's own field description
  // contradicts.
  ok("gemini keeps pydantic's `format: email`", p.email.format === "email");
  ok("gemini keeps pydantic's `format: uri`", p.website.format === "uri");
  ok("gemini keeps pydantic's `format: uuid`", p.ref.format === "uuid");
  ok("no `format` is stripped any more", !has(r.ledger, "Removed `format"));

  // Only the UNNAMED ones are flagged, and only as advisories.
  var flagged = r.ledger.filter(function (l) {
    return l.msg.indexOf("Kept `format:") === 0 ||
           l.msg.indexOf("Kept `format:") !== -1;
  });
  ok("`uri` and `uuid` are flagged as undocumented", flagged.length === 2);
  ok("`email` is NOT flagged (the vendor names it)", !has(r.ledger, "Kept `format: email`"));
  ok("every format flag is advisory, so none can fail --check",
    flagged.length > 0 && flagged.every(function (l) { return l.advisory === true; }));

  // Over-block guards. `format: enum` on an integer is the encoding #316 ships
  // for a non-string enum; flagging our OWN output would be a regression.
  ok("integer `format: enum` is not flagged (#316's own encoding)",
    !has(E.toGemini({ type: "object", properties: {
      n: { type: "integer", format: "enum", enum: ["101"] } } }).ledger, "Kept `format:"));
  ok("integer `format: int32` is not flagged",
    !has(E.toGemini({ type: "object", properties: {
      n: { type: "integer", format: "int32" } } }).ledger, "Kept `format:"));
  ok("number `format: double` is not flagged",
    !has(E.toGemini({ type: "object", properties: {
      n: { type: "number", format: "double" } } }).ledger, "Kept `format:"));
  ok("an undocumented format on an integer IS flagged",
    has(E.toGemini({ type: "object", properties: {
      n: { type: "integer", format: "uuid" } } }).ledger, "Kept `format: uuid`"));

  // The permissive path never had this rule and must stay untouched.
  var j = E.toGemini(JSON.parse(JSON.stringify(PYDANTIC_CONTACT)), true);
  ok("gemini-json keeps every format too", j.schema.properties.ref.format === "uuid" &&
    j.schema.properties.email.format === "email");
})();

// --- #344: the keyword sweep, banked as regression pins ----------------------
//
// #343 probed 14 keywords against the live pre-auth endpoint. This cycle swept
// the REST of the JSON Schema vocabulary the same way (#313: diff the whole
// blocklist, don't spot-check it). All 27 never-probed keywords came back
// `Unknown name "X" ... Cannot find field`, and all 22 keys in GEMINI_ALLOWED
// came back accepted — so the key-level allowlist is now verified against the
// SERVICE in both directions, and #343's three combinators were the whole gap.
// A genuine negative is still a result; these pin it.
(function () {
  ["$id", "$defs", "definitions", "$anchor", "$comment", "prefixItems",
   "additionalItems", "additionalProperties", "unevaluatedProperties",
   "exclusiveMaximum", "maxContains", "minContains", "dependencies",
   "dependentSchemas", "then", "else", "deprecated", "readOnly", "writeOnly",
   "examples", "contentEncoding", "contentMediaType", "contentSchema"
  ].forEach(function (kw) {
    var input = { type: "object", properties: { a: { type: "string" } } };
    input[kw] = kw === "prefixItems" ? [{ type: "string" }] : true;
    ok("gemini still strips `" + kw + "` (endpoint: Cannot find field)",
      !(kw in E.toGemini(input).schema));
  });

  // The other direction: nothing in the verified-accepted 22 may be dropped.
  var keep = { type: "object",
    properties: { a: { type: "string", minLength: 1, maxLength: 5, pattern: "^a",
                       description: "d", title: "T", format: "date-time", default: "a" } },
    required: ["a"], minProperties: 1, maxProperties: 3, title: "Root" };
  var kept = E.toGemini(keep).schema;
  ["title", "required", "minProperties", "maxProperties"].forEach(function (k) {
    ok("gemini keeps service-accepted `" + k + "`", k in kept);
  });
  ["minLength", "maxLength", "pattern", "description", "title", "format", "default"].forEach(function (k) {
    ok("gemini keeps service-accepted `" + k + "` on a leaf", k in kept.properties.a);
  });
})();

// --- Anthropic `format` VALUES: the closed-vs-open question, per vendor -------
// #344 established that a vendor list must be checked for CLOSURE before it is
// implemented as an allowlist, and that Gemini's `format` list is OPEN. This
// block pins the opposite answer for Anthropic, measured 2026-08-09 against all
// three SDKs, plus the divergences between them.
(function () {
  function conv(sch, p) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), p) || {};
    if (!r.schema) r.schema = {};
    if (!r.ledger) r.ledger = [];
    return r;
  }
  function str(fmt, extra) {
    var x = { type: "string" };
    if (fmt !== undefined) x.format = fmt;
    if (extra) for (var k in extra) x[k] = extra[k];
    return { type: "object", properties: { x: x }, required: ["x"] };
  }
  // Does the ledger say this node's `format` stops being enforced?
  function demoted(r) { return has(r.ledger, "`format` is NOT enforced"); }
  function silentDrop(r) { return has(r.ledger, "`format` is DELETED without a trace here"); }

  var TARGETS = ["anthropic-json", "anthropic-json-python", "anthropic-go"];
  // The vendor literals, restated locally. Iterating E.ANTHROPIC_STRING_FORMATS_KEPT
  // directly aborts the whole file against an engine that does not export it yet
  // (#322's trap), which hides every assertion below and makes the revert check
  // unreadable. The export is compared against this list in (1) instead.
  var VENDOR_10 = ["date-time", "time", "date", "duration", "email",
                   "hostname", "uri", "ipv4", "ipv6", "uuid"];

  // (1) The exported list IS the three vendor literals, in vendor order.
  ok("anthropic format list is exported for diffing",
    Array.isArray(E.ANTHROPIC_STRING_FORMATS_KEPT) &&
    E.ANTHROPIC_STRING_FORMATS_KEPT.join(",") === VENDOR_10.join(","));

  // (2) Every one of the 10 survives on ALL THREE transform paths. This is the
  //     over-block guard: being stricter than the vendor is this project's most
  //     repeated bug, and a `format` we wrongly flag is a false alarm on an
  //     ordinary pydantic model.
  var allKept = true;
  VENDOR_10.forEach(function (f) {
    TARGETS.forEach(function (t) { if (demoted(conv(str(f), t))) allKept = false; });
  });
  ok("all 10 kept `format` values draw no demotion on any anthropic path", allKept);

  // (3) Real pydantic output (2.13.4) emits exactly two values OUTSIDE that list.
  //     Verbatim generator input per #311 — `Path` -> "path", `Base64Bytes` ->
  //     "base64" — and both are demoted to prose on all three paths. Measured
  //     against the SDKs directly: JS/Python write {format: "path"} into
  //     `description`, Go writes {format: path}.
  var realOutside = true;
  ["path", "base64"].forEach(function (f) {
    TARGETS.forEach(function (t) { if (!demoted(conv(str(f), t))) realOutside = false; });
  });
  ok("pydantic's `path` and `base64` are demoted on all three anthropic paths", realOutside);

  // (4) THE GO/JS DIVERGENCE, measured not ported. JS keys `format` on
  //     `node.type === "string"`, so a format on a NON-string node is demoted.
  //     Go consults `supportedSchemaKeys` first and only its `case "string"`
  //     branch demotes, so the same node keeps its format. Verified against
  //     both SDKs on v1.62.0 / 0.116.0.
  var intFmt = { type: "object", properties: { x: { type: "integer", format: "int64" } }, required: ["x"] };
  var arrFmt = { type: "object", properties: { x: { type: "array", items: { type: "string" }, format: "email" } }, required: ["x"] };
  var typeless = { type: "object", properties: { x: { anyOf: [{ type: "string" }], format: "email" } }, required: ["x"] };
  ok("JS demotes `format` on a non-string node (integer)", demoted(conv(intFmt, "anthropic-json")));
  ok("Go KEEPS `format` on a non-string node (integer)", !demoted(conv(intFmt, "anthropic-go")));
  ok("JS demotes `format` on an array node", demoted(conv(arrFmt, "anthropic-json")));
  ok("Go KEEPS `format` on an array node", !demoted(conv(arrFmt, "anthropic-go")));
  ok("JS demotes `format` on a typeless anyOf node", demoted(conv(typeless, "anthropic-json")));
  ok("Go KEEPS `format` on a typeless anyOf node", !demoted(conv(typeless, "anthropic-go")));

  // (5) An unrecognised value on a STRING node is demoted by all three — this is
  //     the control that keeps (4) about the node's TYPE and not about the value.
  ok("all three demote an unlisted value on a string node ('Email')",
    demoted(conv(str("Email"), "anthropic-json")) &&
    demoted(conv(str("Email"), "anthropic-json-python")) &&
    demoted(conv(str("Email"), "anthropic-go")));

  // (6) THE FIX. Go guards on `s.Format != ""` (the VALUE) where JS/Python guard
  //     on the key being present, and `invopop` declares Format as a bare string
  //     with omitempty — so an empty/null format is serialised away with NOTHING
  //     written to `description`. Measured: JS/Python emit {format: ""} /
  //     {format: null} as prose, Go emits no entry at all. Reporting that as a
  //     demotion would be #334's error (a silent drop sold as a visible one).
  [["", "empty"], [null, "null"]].forEach(function (pair) {
    var f = pair[0], label = pair[1];
    var go = conv(str(f), "anthropic-go");
    ok("Go reports a " + label + " `format` as a silent DELETION", silentDrop(go));
    ok("Go does not claim a " + label + " `format` reaches `description`", !demoted(go));
    ok("JS still reports a " + label + " `format` as demoted-to-prose",
      demoted(conv(str(f), "anthropic-json")) && !silentDrop(conv(str(f), "anthropic-json")));
  });

  // (7) Over-block guard for (6): a NON-empty unlisted format on Go must still be
  //     the ordinary demotion, not the new deletion message.
  var goPath = conv(str("path"), "anthropic-go");
  ok("Go keeps the ordinary demotion wording for a non-empty unlisted format",
    demoted(goPath) && !silentDrop(goPath));

  // (8) `pattern` is the key-level divergence (#332) and must stay put: Go keeps
  //     it, the other two demote it. Pins that (4)-(7) did not disturb it.
  var pat = { type: "object", properties: { x: { type: "string", pattern: "^a$" } }, required: ["x"] };
  ok("Go keeps `pattern` while JS/Python demote it",
    !has(conv(pat, "anthropic-go").ledger, "`pattern` is NOT enforced") &&
    has(conv(pat, "anthropic-json").ledger, "`pattern` is NOT enforced"));

  // (9) The tools path applies no transform at all, so nothing above is a
  //     finding there — no `format` advisory on `--to anthropic` for any value.
  var toolsClean = true;
  ["email", "path", "base64", ""].forEach(function (f) {
    if (demoted(conv(str(f), "anthropic"))) toolsClean = false;
  });
  ok("`--to anthropic` (tools, verbatim) reports no `format` demotion at all", toolsClean);

  // (10) None of this may fail a gate: Anthropic accepts the document either way,
  //      so every entry is advisory (#317).
  var advisoryOnly = TARGETS.every(function (t) {
    return conv(str("path"), t).ledger.every(function (l) { return l.advisory === true || l.op === "="; });
  });
  ok("every anthropic `format` finding is advisory, never a gate failure", advisoryOnly);
})();

// #345's corollary said: when a rule is shared across implementations, check
// whether the guard tests the KEY or the VALUE. This block is the systematic
// version of that question turned on our OWN engine (#330's precedent). The
// tuple guard read `!tuple.length` -- the array's VALUE -- where every
// destination tests its SHAPE, so a ZERO-length array in `items` fell through
// as "nothing to do". Measured 2026-08-09; `{"type":"array","items":[]}` is the
// verbatim zod 4.4.3 rendering of `z.tuple([])` with `target: "draft-7"`.
(function () {
  function conv(sch, p) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), p) || {};
    if (!r.schema) r.schema = {};
    if (!r.ledger) r.ledger = [];
    return r;
  }
  function arr(extra) {
    var b = { type: "array" };
    Object.keys(extra || {}).forEach(function (k) { b[k] = extra[k]; });
    return { type: "object", properties: { b: b }, required: ["b"], additionalProperties: false };
  }
  function propB(r) {
    var pr = r.schema && r.schema.properties;
    return (pr && pr.b) || {};
  }

  // (1) The whole point: an empty array in `items` is the tuple FORM and must
  //     not survive into the output of any target that rejects that form.
  //     Vendor verdicts on the raw document, all measured this cycle:
  //       openai@7.4.0 toStrictJsonSchema .......... THROW (tuple-form `items`)
  //       @anthropic-ai/sdk@0.116.0 outputFormat ... THROW
  //       anthropic==0.121.0 transform_schema ...... RAISE TypeError
  //       anthropic-sdk-go@v1.62.0 ................. schema: null (whole doc)
  //       google-genai==2.17.0 types.Schema ........ REJECT
  ["openai", "anthropic-json", "anthropic-json-python", "anthropic-go", "gemini", "gemini-client"]
    .forEach(function (t) {
      ok("`items: []` does not survive `--to " + t + "`",
        propB(conv(arr({ items: [] }), t)).items === undefined);
    });

  // (2) ... and the removal is REPORTED, not silent (#329/#340: a repair that
  //     deletes must be visible in the ledger).
  ok("removing the empty tuple is reported in the ledger",
    has(conv(arr({ items: [] }), "openai").ledger, "empty draft-07 tuple"));

  // (3) The #330 class specifically: for narrow Gemini the OLD code exited 1 for
  //     an unrelated `additionalProperties` edit while leaving `items: []` in the
  //     output the user was told to commit. The fix has to fix it.
  ok("narrow gemini's OUTPUT is finally free of the array-form `items`",
    propB(conv(arr({ items: [] }), "gemini")).items === undefined);

  // (4) Losslessness has one exception, and it is the #329 question ("what does
  //     the node have LEFT?"): draft-07 `additionalItems` applies from the first
  //     unlisted index, which with an empty list is EVERY element -- so it is the
  //     real element schema and must MOVE, not be dropped alongside `items`.
  var tail = conv(arr({ items: [], additionalItems: { type: "string" } }), "anthropic-json");
  ok("`items: [] + additionalItems: S` becomes `items: S`",
    propB(tail).items && propB(tail).items.type === "string" &&
    propB(tail).additionalItems === undefined);

  // (5) A length constraint written beside the empty tuple is not ours to touch.
  ok("`maxItems` beside an empty tuple survives",
    propB(conv(arr({ items: [], maxItems: 0 }), "anthropic-json")).maxItems === 0);

  // --- over-block guards: being merely stricter than the vendor is this
  // --- project's most repeated bug, so each of these pins a case that must NOT
  // --- change. They hold both ways and are not counted as new coverage.

  // (6) `prefixItems: []` is ACCEPTED by all three Anthropic SDKs (they demote it
  //     to prose), so it must be left exactly where it is on that path.
  ok("`prefixItems: []` is untouched on anthropic-json",
    Array.isArray(propB(conv(arr({ prefixItems: [] }), "anthropic-json")).prefixItems));

  // (7) The tools path applies no transform at all and `betaTool` accepts
  //     `items: []` VERBATIM (measured), so `--to anthropic` must stay silent.
  var tools = conv(arr({ items: [] }), "anthropic");
  ok("`--to anthropic` (tools, verbatim) leaves `items: []` alone",
    Array.isArray(propB(tools).items) &&
    !has(tools.ledger, "empty draft-07 tuple"));

  // (8) `gemini-json` accepts `prefixItems`, so its own rewrite -- a DIFFERENT
  //     code path, using the correct shape guard already -- must be undisturbed.
  var gj = conv(arr({ items: [] }), "gemini-json");
  ok("gemini-json still rewrites the empty tuple to `prefixItems`",
    Array.isArray(propB(gj).prefixItems) && propB(gj).items === undefined);

  // (9) Regression pin: a NON-empty homogeneous tuple still collapses.
  var homo = conv(arr({ items: [{ type: "string" }, { type: "string" }] }), "openai");
  ok("a non-empty homogeneous tuple still collapses to `items` + min/maxItems",
    propB(homo).items && propB(homo).items.type === "string" &&
    propB(homo).minItems === 2 && propB(homo).maxItems === 2);

  // (10) Regression pin: a heterogeneous tuple is still a blocker, and the
  //      keyword stays visible so the reader can see what to remodel (#318).
  var het = conv(arr({ items: [{ type: "string" }, { type: "integer" }] }), "openai");
  ok("a heterogeneous tuple is still a human-fix blocker",
    het.ledger.some(function (l) { return l.op === "!"; }));
})();

// --- Cycle #347: the empty instance of a collection keyword inverts it -------
//
// For a collection keyword the EMPTY instance is usually not "less constraint"
// but the OPPOSITE one: an empty `enum` allows nothing, an empty `anyOf` offers
// no branch, and `not` of a match-anything schema excludes everything. Each is a
// node no value can satisfy. Measured producers, verbatim:
//   pydantic 2.13.4 `class Empty(Enum): pass` -> {"enum": [], "title": "Empty"}
//   zod 4.4.3 z.enum([])  -> {"type":"string","enum":[]}
//   zod 4.4.3 z.union([]) -> {"anyOf":[]}
//   zod 4.4.3 z.never()   -> {"not":{}}
(function () {
  // Guarded locally so a reverted engine.js REPORTS instead of aborting the file.
  function conv(p, sch) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), p) || {};
    if (!r.schema) r.schema = {};
    if (!r.ledger) r.ledger = [];
    return r;
  }
  function doc(p) {
    return { type: "object", properties: { a: { type: "string" }, p: p },
             required: ["a", "p"] };
  }
  function pnode(r) {
    return (r.schema && r.schema.properties && r.schema.properties.p) || {};
  }
  function unsat(r) {
    return (r.ledger || []).filter(function (l) {
      return typeof l.msg === "string" && l.msg.indexOf("No value can satisfy") !== -1;
    });
  }
  function blockers(r) {
    return (r.ledger || []).filter(function (l) { return l.op === "!" && !l.advisory; });
  }

  var CARRIED = ["openai-nonstrict", "openai-realtime", "anthropic", "anthropic-json",
    "anthropic-json-python", "anthropic-go", "gemini", "gemini-json", "gemini-client"];

  // (1) The four measured generator outputs are reported on every target that
  //     CARRIES them, and always as an ADVISORY -- the destination accepts the
  //     document, so failing the gate here would be #317's mistake.
  var FORMS = [
    ["zod z.enum([])", { type: "string", "enum": [] }],
    ["pydantic empty Enum", { "enum": [], title: "Empty" }],
    ["zod z.union([])", { anyOf: [] }],
    ["zod z.never()", { not: {} }]
  ];
  FORMS.forEach(function (f) {
    var missing = CARRIED.filter(function (t) {
      var hits = unsat(conv(t, doc(f[1])));
      return hits.length !== 1 || hits[0].advisory !== true;
    });
    ok("`" + f[0] + "` is an advisory on every carrying target", missing.length === 0);
  });

  // (2) `--to openai` STRIPS `not`, and on a match-anything `not` that strip is
  //     not a widening but an INVERSION: matches-nothing becomes matches-
  //     anything. It must block, and the keyword must stay visible (#318).
  var never = conv("openai", doc({ not: {} }));
  ok("`not: {}` blocks on openai instead of being stripped",
    blockers(never).length > 0 && has(never.ledger, "it would INVERT it"));
  ok("the blocked `not: {}` is left visible in the output",
    pnode(never).not !== undefined);

  // (3) The regression that names the bug: the old code emitted `{}` here --
  //     a node matching ANY value where the input matched NONE.
  ok("`not: {}` does not come out as a match-anything `{}`",
    JSON.stringify(pnode(never)) !== "{}");

  // (4) The two spellings of the excluded schema must agree. `{}` and `true` are
  //     the same schema, and they used to get different severities: `not: true`
  //     was caught by the boolean walker, `not: {}` was silently inverted.
  var neverBool = conv("openai", doc({ not: true }));
  ok("`not: true` and `not: {}` get the same verdict on openai",
    (blockers(neverBool).length > 0) === (blockers(never).length > 0));

  // --- over-block guards. Being merely stricter than the vendor is this
  //     project's most repeated bug, so each of these must stay quiet. -------

  // (5) An empty `allOf` is vacuously TRUE -- it matches everything, the exact
  //     opposite of an empty `anyOf`. Flagging it would show the rule was
  //     keyed on emptiness rather than on meaning.
  ok("`allOf: []` is NOT called unsatisfiable (it matches everything)",
    unsat(conv("openai", doc({ type: "string", allOf: [] }))).length === 0);

  // (6) Empty constraints that are merely empty, not impossible.
  ok("`required: []` / `properties: {}` are not called unsatisfiable",
    unsat(conv("openai", doc({ type: "object", properties: {}, required: [] }))).length === 0);
  ok("`prefixItems: []` is not called unsatisfiable (#346 pin)",
    unsat(conv("openai", doc({ type: "array", prefixItems: [] }))).length === 0);

  // (7) A bare `{}` matches everything and the vendor accepts it verbatim
  //     (#329), so it must not be swept up by the `not` rule's helper.
  ok("a bare `{}` node is not called unsatisfiable",
    unsat(conv("openai", doc({}))).length === 0);

  // (8) Non-empty collections are untouched.
  ok("a non-empty `enum` is not called unsatisfiable",
    unsat(conv("openai", doc({ type: "string", "enum": ["a", "b"] }))).length === 0);
  ok("a non-empty `anyOf` is not called unsatisfiable",
    unsat(conv("openai", doc({ anyOf: [{ type: "string" }, { type: "integer" }] }))).length === 0);

  // (9) `not` with a REAL constraining subschema still excludes only some
  //     values, so removing it is the ordinary documented widening, not a
  //     blocker. This is the line between "narrower" and "impossible".
  var realNot = conv("openai", doc({ type: "string", not: { "const": "x" } }));
  ok("`not` with a real subschema is still an ordinary strip, not a blocker",
    unsat(realNot).length === 0 && pnode(realNot).not === undefined);

  // (10) Placement pins. Both of these converters return EARLY on one of their
  //      paths, so a walk added after the branch would silently cover only the
  //      other one -- and the tools path is exactly where nothing else would
  //      ever mention a dead field, because no transform runs there.
  ok("the advisory survives anthropic's no-transform tools-path early return",
    unsat(conv("anthropic", doc({ anyOf: [] }))).length === 1);
  ok("the advisory survives gemini's responseJsonSchema early return",
    unsat(conv("gemini-json", doc({ anyOf: [] }))).length === 1);

  // (11) An advisory must never be the thing that fails a build.
  ok("the unsatisfiable advisory never registers as a gate failure",
    blockers(conv("gemini-json", doc({ "enum": [] }))).length === 0);
})();

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
