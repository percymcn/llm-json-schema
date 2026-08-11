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
  // #367: these two were keyed on the literal prose "NOT enforced on the
  // `output_format`", which #367 corrected — the demotion is a property of how
  // the schema is handed over, not of the request field. The property under test
  // (this path reports the demotion, the tools path does not) is orthogonal to
  // the wording, so it is re-keyed on the stable half AND strengthened to
  // require the new condition clause.
  ok("anthropic-json still reports maxLength as demoted to prose",
    has(json.ledger, "is NOT enforced") && has(json.ledger, "appended to this node's `description`"));
  ok("anthropic-json says the demotion is conditional on the call site",
    has(json.ledger, "conditional on how you hand the schema over"));
  ok("anthropic tools path does NOT emit the demote-to-prose notes",
    !has(tools.ledger, "appended to this node's `description`") &&
    !has(tools.ledger, "conditional on how you hand the schema over"));
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
  // #354: #333 recorded this client as unprobed rather than guessing. Measured
  // on anthropic==0.121.0 it RAISES `TypeError: 'bool' object is not a mapping`,
  // so it sides with TypeScript and this assertion is the reverse of the one it
  // replaces. The old test asserted the gap, not a behaviour.
  ok("anthropic-json-python blocks a boolean subschema (Python transform raises)",
    blockers(E.convert(propBool(true), "anthropic-json-python")).length === 1);
  ok("anthropic-json-python names the Python transform, not the TS one",
    has(E.convert(propBool(true), "anthropic-json-python").ledger,
      "'bool' object is not a mapping"));
  // The two clients disagree, so the message must not blame the vendor at large.
  ok("anthropic-json-python says which client this is about",
    has(E.convert(propBool(true), "anthropic-json-python").ledger,
      "the Go SDK keeps the same bytes verbatim"));

  // --- over-block guards: positions the Python transform never descends -----
  // It demotes `not` to `description` prose wholesale, so every boolean below
  // it is accepted verbatim. Measured at three depths.
  ok("anthropic-json-python does NOT block a boolean under `not`",
    blockers(E.convert({
      type: "object", additionalProperties: false, required: ["a"],
      properties: { a: { type: "string" } },
      not: { type: "object", properties: { b: true } }
    }, "anthropic-json-python")).length === 0);
  ok("anthropic-json-python does NOT block a boolean under a nested `not`",
    blockers(E.convert({
      type: "object", additionalProperties: false, required: ["a"],
      properties: { a: { type: "string", not: { type: "array", items: true } } }
    }, "anthropic-json-python")).length === 0);
  // ...but the TypeScript path still does, so the exclusion is scoped to Python.
  ok("anthropic-json still blocks a boolean under `not`",
    blockers(E.convert({
      type: "object", additionalProperties: false, required: ["a"],
      properties: { a: { type: "string" } },
      not: { type: "object", properties: { b: true } }
    }, "anthropic-json")).length === 1);

  // A tuple is the case where the position in OUR OUTPUT is the one that counts:
  // the vendor accepts a boolean under `prefixItems` (demoted to prose), but our
  // own homogeneous-tuple collapse rewrites it into `items`, which it rejects.
  ok("anthropic-json-python blocks a boolean our tuple collapse moves into `items`",
    blockers(E.convert({
      type: "object", additionalProperties: false, required: ["a"],
      properties: { a: { type: "array", prefixItems: [true] } }
    }, "anthropic-json-python")).length === 1);
  // Control: the same shape with a real element type is not blocked at all.
  ok("anthropic-json-python leaves an ordinary tuple alone",
    blockers(E.convert({
      type: "object", additionalProperties: false, required: ["a"],
      properties: { a: { type: "array", prefixItems: [{ type: "integer" }] } }
    }, "anthropic-json-python")).length === 0);
  // Control: an ordinary schema with no boolean anywhere is untouched.
  ok("anthropic-json-python does not fire on a schema with no boolean",
    blockers(E.convert({
      type: "object", additionalProperties: false, required: ["a"],
      properties: { a: { type: "string" } }
    }, "anthropic-json-python")).length === 0);

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

  // #365. These two assertions used to read "still strips `oneOf`" on the
  // premise, stated in this comment, that "no client declares these — so there
  // the strip is right." MEASURED FALSE: `@ai-sdk/google` 4.0.39 declares no
  // `Schema` type at all and forwards `oneOf`/`allOf` verbatim, recursing into
  // the branches, and the live v1beta proto accepts them (#343). The strip was
  // a no-op for the client it was written for (google-adk drops the keyword
  // itself, so its output is byte-identical either way) and a deletion for the
  // client it was not. The tests were pinning the defect, so they are corrected
  // rather than deleted.
  var GC = E.convert(PET, "gemini-client");
  ok("gemini-client: KEEPS `oneOf` — @ai-sdk/google forwards it", !!GC.schema.oneOf);
  ok("gemini-client: and the branches survive with their own properties",
    !!(GC.schema.oneOf && GC.schema.oneOf[0] && GC.schema.oneOf[0].properties));
  ok("gemini-client: names the client that carries it",
    has(GC.ledger, "@ai-sdk/google"));
  ok("gemini-client: and names the client that drops it",
    has(GC.ledger, "google-adk"));
  // Advisory, never a gate failure: neither measured client ERRORS on it, they
  // ignore it, so failing CI here would be #317's mistake.
  ok("gemini-client: keeping it is ADVISORY, never a gate failure",
    GC.ledger.some(function (l) {
      return l.advisory && l.msg.indexOf("Kept `oneOf`") !== -1;
    }));
  // The over-block guard in the other direction: `not` must NOT get the same
  // treatment as `oneOf`/`allOf`. Without this the rule could be firing blanket
  // and every assertion above would still pass.
  //
  // #368 CORRECTED THE FACT THIS PINS, not its intent. It used to assert the
  // literal prose "BOTH measured converting clients drop it" — true of the two
  // members #365 measured, and FALSE once a fifth (`@langchain/google-genai`
  // 2.2.0) turned out to forward `not`. Re-keyed on the stable half (it is kept;
  // the droppers are named; it does NOT get the `anyOf` remedy, which is the
  // real discriminator between the two branches, since there is no `anyOf` form
  // of a negation) and STRENGTHENED to require the forwarder be named too.
  var GCnot = E.convert({ type: "string", not: { type: "string", pattern: "^x" } },
    "gemini-client");
  ok("gemini-client: `not` is kept too (no measured client errors on it)",
    !!GCnot.schema.not);
  ok("gemini-client: ...and the clients that drop `not` are named",
    has(GCnot.ledger, "google-adk") && has(GCnot.ledger, "all drop it"));
  ok("gemini-client: ...and the one client that FORWARDS `not` is named too",
    has(GCnot.ledger, "@langchain/google-genai"));
  ok("gemini-client: ...but `not` is NOT offered the `anyOf` remedy",
    !has(GCnot.ledger, "remodel it as `anyOf`"));
  // #329's question asked about the layer downstream: if the keyword was the
  // node's only constraint, the client that drops it leaves a property
  // asserting nothing. That clause must fire here and NOT on a node that has
  // something else to stand on.
  ok("gemini-client: names the emptying when the union is the only constraint",
    has(GC.ledger, "asserting nothing about the data"));
  var GCrich = E.convert({
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
    allOf: [{ type: "object", properties: { b: { type: "string" } } }]
  }, "gemini-client");
  ok("gemini-client: ...and does NOT claim emptying when the node has more",
    !has(GCrich.ledger, "asserting nothing about the data"));

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

// ---------------------------------------------------------------------------
// A map has four spellings, and closing an object deletes three of them.
//
// `additionalProperties` is not the only keyword that describes keys nobody
// declared. `patternProperties`, `propertyNames` and `unevaluatedProperties`
// describe them too, and OpenAI strict mode supports none of the four. Strip
// one of the last three and then set `additionalProperties: false` -- both
// individually correct -- and the object's only legal value becomes `{}`.
//
// Reachability is not hypothetical. Measured verbatim on pydantic 2.13.4:
//   Dict[Annotated[str, StringConstraints(pattern=r'^S_')], str]
//     -> {"type": "object", "patternProperties": {"^S_": {"type": "string"}}}
// with NO `additionalProperties` key, which is the exact shape that was silent.
(function () {
  function conv(p, node) {
    return E.convert({
      type: "object", properties: { m: JSON.parse(JSON.stringify(node)) },
      required: ["m"], additionalProperties: false
    }, p);
  }
  function led(r) { return (r && Array.isArray(r.ledger)) ? r.ledger : []; }
  function blocks(r) {
    return led(r).filter(function (e) { return e.op === "!" && !e.advisory; });
  }
  function advis(r) { return led(r).filter(function (e) { return e.advisory; }); }
  function m(r) {
    var s = r && r.schema;
    return (s && s.properties && s.properties.m) || {};
  }
  var PP = { "^S_": { type: "string" } };

  // (1) The four dead-field shapes. Each is an object whose ONLY way of holding
  //     data is a keyword strict mode cannot represent.
  var bare = conv("openai", { type: "object", patternProperties: PP });
  ok("bare `patternProperties` (the pydantic shape) is a blocker",
    blocks(bare).length === 1);
  ok("a closed pattern-map is a blocker",
    blocks(conv("openai", { type: "object", patternProperties: PP, additionalProperties: false })).length === 1);
  ok("`propertyNames` with nothing else is a blocker",
    blocks(conv("openai", { type: "object", propertyNames: { pattern: "^[a-z]+$" } })).length === 1);
  ok("`unevaluatedProperties` with a schema is a blocker",
    blocks(conv("openai", { type: "object", unevaluatedProperties: { type: "string" } })).length === 1);

  // (2) The keyword stays VISIBLE and the object is NOT closed. Deleting the
  //     keyword and closing the object IS the defect, so a fix that reported it
  //     and then did it anyway would be worthless -- and the value schema is
  //     what makes the remedy actionable.
  ok("a blocked map keyword is left in the output, not stripped",
    JSON.stringify(m(bare).patternProperties) === JSON.stringify(PP));
  ok("a blocked map object is not closed behind the reader's back",
    m(bare).additionalProperties === undefined);

  // (3) The advisory arm. The node has declared `properties`, so the field
  //     still works and blocking would be over-strict -- but the pattern keys
  //     stop being accepted, which is a NARROWING, not the widening a strip
  //     normally is.
  var withProps = conv("openai", {
    type: "object", properties: { a: { type: "string" } }, required: ["a"],
    patternProperties: PP, additionalProperties: false
  });
  ok("a pattern-map that also declares properties is not blocked",
    blocks(withProps).length === 0);
  ok("...but the keys it can no longer accept are reported",
    advis(withProps).some(function (e) { return /no longer accepted/.test(e.msg); }));
  // PLACEMENT PIN: this input ALREADY carries `additionalProperties: false`, so
  // it never enters the branch that writes the `false`. Keying the advisory to
  // that write reported the loss only when we happened to be the one writing
  // it -- and `{patternProperties, additionalProperties: false}` is the
  // commonest spelling of a closed pattern-map there is.
  ok("the narrowing is reported even when we did not write the `false` ourselves",
    advis(withProps).some(function (e) { return /no longer accepted/.test(e.msg); }) &&
    m(withProps).additionalProperties === false);
  ok("the narrowing advisory never registers as a gate failure",
    blocks(withProps).length === 0 && advis(withProps).length > 0);

  // (4) Over-block guards. Being stricter than the vendor is this project's
  //     most repeated bug, and each of these is a discriminator proving the
  //     rule is keyed on what the keyword SAYS about the keys, not on its
  //     presence.
  //     Measured on openai@7.4.0: a bare {"type":"object"} is ACCEPT-repaired
  //     -- the vendor closes it exactly the way we do -- so flagging it would
  //     be noise.
  var plain = conv("openai", { type: "object" });
  ok("a bare `{type: object}` is still closed and not blocked",
    blocks(plain).length === 0 && m(plain).additionalProperties === false);
  ok("an EMPTY `patternProperties` describes no keys, so it is not a blocker",
    blocks(conv("openai", { type: "object", patternProperties: {} })).length === 0);
  ok("`unevaluatedProperties: false` already says closed, so it is not a blocker",
    blocks(conv("openai", { type: "object", unevaluatedProperties: false })).length === 0);
  ok("a property literally NAMED `patternProperties` is not a false positive",
    blocks(conv("openai", {
      type: "object", properties: { patternProperties: { type: "string" } },
      required: ["patternProperties"], additionalProperties: false
    })).length === 0);
  // An open map is already reported by its own rule; this must not become two.
  ok("an open map is still reported exactly once, not twice",
    blocks(conv("openai", {
      type: "object", propertyNames: { pattern: "^a" }, additionalProperties: { type: "string" }
    })).length === 1);

  // (5) Per-provider, MEASURED not ported. Only OpenAI both strips these
  //     keywords AND forces the object closed, so only OpenAI can compose the
  //     two into a dead field. Anthropic and the JSON-Schema Gemini path carry
  //     `patternProperties` verbatim; the narrow Gemini proto strips it but has
  //     no `additionalProperties` field at all, so the object stays OPEN --
  //     that is a widening, which is the acceptable direction.
  ["anthropic", "anthropic-json", "gemini-json", "openai-nonstrict"].forEach(function (p) {
    var r = conv(p, { type: "object", patternProperties: PP });
    ok(p + " keeps `patternProperties` verbatim and does not block",
      blocks(r).length === 0 && JSON.stringify(m(r).patternProperties) === JSON.stringify(PP));
  });
  var gem = conv("gemini", { type: "object", patternProperties: PP });
  ok("narrow gemini strips the keyword but leaves the object open, so no blocker",
    blocks(gem).length === 0 && m(gem).patternProperties === undefined &&
    m(gem).additionalProperties === undefined);
})();

// ---------------------------------------------------------------------------
// #349 — a single-member `allOf` is not a special case.
//
// The flatten copied a member key only `if (!(k in node))`, i.e. PARENT WINS.
// For annotations that is right; for `properties`/`required` it is a DELETION,
// and the ledger said "Nothing is lost." Measured on openai@7.4.0, the vendor
// applies the SAME merge it applies to N members:
//   {properties:{kind},required:["kind"],allOf:[{properties:{a},required:["a"]}]}
//   -> {properties:{kind,a},required:["kind","a"],additionalProperties:false}
// So the old output INVERTED the node: `{kind:"k",a:"x"}` was legal and became
// illegal, `{kind:"k"}` was illegal and became legal — on a schema the vendor
// had ACCEPTED as written, so there was no acceptance bought by the loss.
(function () {
  // Root-level conversion: these rules are about the node that carries the
  // `allOf`, so wrapping it in a property would move the test off the target.
  function conv(p, sch) { return E.convert(JSON.parse(JSON.stringify(sch)), p); }
  function led(r) { return (r && Array.isArray(r.ledger)) ? r.ledger : []; }
  function blocks(r) {
    return led(r).filter(function (e) { return e.op === "!" && !e.advisory; });
  }
  function m(r) { return (r && r.schema) || {}; }

  var withProps = {
    type: "object", properties: { kind: { type: "string" } }, required: ["kind"],
    allOf: [{ properties: { a: { type: "string" } }, required: ["a"] }]
  };
  var r = conv("openai", withProps);
  var out = m(r);
  ok("#349 single-member allOf MERGES the member's properties, not drops them",
    out.properties && out.properties.a && out.properties.a.type === "string" &&
    out.properties.kind && out.allOf === undefined);
  ok("#349 single-member allOf unions `required`",
    out.required.indexOf("kind") !== -1 && out.required.indexOf("a") !== -1);
  ok("#349 the merged shape is not blocked (the vendor accepts this input)",
    blocks(r).length === 0);
  ok("#349 the ledger no longer claims nothing is lost",
    JSON.stringify(r.ledger || []).indexOf("Nothing is lost") === -1);

  // The vendor THROWS when both sides declare the same name with DIFFERENT
  // schemas ("cannot be merged without changing Draft 7 validation") and
  // ACCEPTS when they are identical — so the test is conflict, not duplication.
  var clash = {
    type: "object", properties: { a: { type: "string" } }, required: ["a"],
    allOf: [{ properties: { a: { type: "number" } }, required: ["a"] }]
  };
  ok("#349 a conflicting property name is a blocker, matching the vendor",
    blocks(conv("openai", clash)).length === 1);

  // OVER-BLOCK GUARDS. Being stricter than the vendor is this project's most
  // repeated bug (#312/#314/#317/#322/#329/#337/#343/#344/#348).
  var dup = {
    type: "object", properties: { a: { type: "string" } }, required: ["a"],
    allOf: [{ properties: { a: { type: "string" } }, required: ["a"] }]
  };
  var dupOut = conv("openai", dup);
  ok("#349 GUARD an IDENTICAL duplicate is merged, not blocked (vendor accepts)",
    blocks(dupOut).length === 0 && m(dupOut).properties.a.type === "string");

  // The standard pydantic==1.10.22 output for a referenced model with a field
  // description. Verbatim, per [[test-against-real-generator-input]]. The
  // member is a bare `$ref` with nothing to merge, so it must be untouched.
  var pydv1 = {
    title: "M", type: "object",
    properties: {
      kind: { title: "Kind", type: "string" },
      inner: { title: "Inner", description: "the nested one", allOf: [{ $ref: "#/definitions/Inner" }] }
    },
    required: ["kind", "inner"],
    definitions: {
      Inner: { title: "Inner", type: "object", properties: { a: { title: "A", type: "string" } }, required: ["a"] }
    }
  };
  var pv = conv("openai", pydv1);
  ok("#349 GUARD the pydantic v1 $ref-in-allOf shape still flattens to a $ref",
    blocks(pv).length === 0 && m(pv).properties.inner.$ref === "#/$defs/Inner" &&
    m(pv).properties.inner.description === "the nested one" &&
    m(pv).properties.inner.allOf === undefined);

  var annOnly = {
    type: "object", properties: { a: { type: "string" } }, required: ["a"],
    allOf: [{ description: "note" }]
  };
  var ao = conv("openai", annOnly);
  ok("#349 GUARD an annotation-only member still contributes its description",
    blocks(ao).length === 0 && m(ao).description === "note" &&
    m(ao).properties.a && m(ao).allOf === undefined);

  var twoMember = {
    type: "object",
    allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] },
            { type: "object", properties: { b: { type: "number" } }, required: ["b"] }]
  };
  var tm = conv("openai", twoMember);
  ok("#349 GUARD the two-member merge is undisturbed",
    blocks(tm).length === 0 && m(tm).properties.a && m(tm).properties.b &&
    m(tm).required.length === 2);

  // A member with no `properties` and a parent with none either: the old
  // parent-wins copy was accidentally correct here, which is exactly why the
  // deletion stayed invisible on the simple case.
  var noParentProps = { type: "object", allOf: [{ properties: { a: { type: "string" } }, required: ["a"] }] };
  ok("#349 GUARD member props still land when the parent declares none",
    m(conv("openai", noParentProps)).properties.a !== undefined);
})();

// --- #350: inference reads EVERY element, not just element 0 ----------------
// Reading `value[0]` alone is not a shortcut, it is a narrowing: the remaining
// elements are examples of legal data, so the inferred schema rejected the very
// document it was inferred from. Verified against ajv 2020 in the cycle record;
// these assertions pin the resulting shapes.
(function () {
  function inf(example) {
    var r = E.convert(example, "openai-nonstrict");
    return r && r.schema ? r.schema : {};
  }
  function items(example, key) {
    var p = at(inf(example), "properties." + key);
    return p && p.items;
  }
  function typeList(s) {
    if (!s || s.type === undefined) return [];
    return Array.isArray(s.type) ? s.type.slice().sort() : [s.type];
  }

  var mixed = typeList(items({ vals: [1, "a"] }, "vals"));
  ok("#350 a heterogeneous array keeps every element type",
    mixed.length === 2 && mixed[0] === "integer" && mixed[1] === "string");

  ok("#350 an int beside a float widens to `number`, not `integer`",
    typeList(items({ vals: [1, 2.5] }, "vals")).join(",") === "number");

  var withNull = typeList(items({ vals: [null, "x"] }, "vals"));
  ok("#350 a leading null does not make the array null-only",
    withNull.length === 2 && withNull.indexOf("null") !== -1 && withNull.indexOf("string") !== -1);

  var rows = items({ rows: [{ a: 1 }, { a: 1, b: 2 } ] }, "rows");
  ok("#350 sibling objects union their properties",
    rows && rows.properties && rows.properties.a !== undefined && rows.properties.b !== undefined);
  ok("#350 a key missing from one sibling is not required",
    rows && rows.required.length === 1 && rows.required[0] === "a");

  var mix = items({ things: [{ a: 1 }, "x"] }, "things");
  ok("#350 a structured element beside a scalar becomes anyOf, losing neither",
    mix && Array.isArray(mix.anyOf) && mix.anyOf.length === 2 &&
    mix.anyOf.some(function (m) { return m.type === "object"; }) &&
    mix.anyOf.some(function (m) { return m.type === "string"; }));

  var nullObj = items({ things: [null, { a: 1 }] }, "things");
  ok("#350 null beside an object keeps the object shape",
    nullObj && Array.isArray(nullObj.anyOf) &&
    nullObj.anyOf.some(function (m) { return m.type === "object" && m.properties.a; }));

  // A missing `items` means "that element was an empty array", i.e. no
  // information — not "any element is allowed" — so the informative side wins.
  var nested = items({ outer: [[], [1]] }, "outer");
  ok("#350 an empty sibling array does not erase the known element type",
    nested && nested.type === "array" && nested.items && nested.items.type === "integer");

  ok("#350 repeated element types are not duplicated in the union",
    typeList(items({ vals: [1, "a", 1, "a"] }, "vals")).join(",") === "integer,string");

  // --- guards: the join must not fire where there was nothing to join --------
  ok("#350 GUARD a homogeneous array is unchanged",
    typeList(items({ vals: [1, 2, 3] }, "vals")).join(",") === "integer");

  ok("#350 GUARD identical sibling objects stay one object with required intact",
    (function () {
      var s = items({ rows: [{ a: 1 }, { a: 2 }] }, "rows");
      return s && s.type === "object" && s.required.length === 1 && s.required[0] === "a";
    })());

  // Nothing is invented for an empty array (#336): no element was seen, so no
  // element type is guessed. It stays a blocker the human resolves.
  var emptyR = E.convert({ tags: [] }, "openai");
  ok("#350 GUARD an empty array still gets no invented `items`",
    at(emptyR.schema, "properties.tags.items") === undefined);
  ok("#350 GUARD an empty array is still a blocker",
    (emptyR.ledger || []).filter(function (l) { return l.op === "!" && !l.advisory; }).length === 1);
  ok("#350 the array-without-items blocker names the empty-example cause",
    has(emptyR.ledger, "array in that example was empty"));
})();

// --- #351: the round-trip invariant, executed rather than described ---------
// #350 established the rule -- an inferred schema must validate the example it
// was inferred from -- and verified it against ajv 2020 IN THE CYCLE RECORD.
// The assertions it left behind pin the resulting SHAPES ("items is a union of
// integer and string"), which is a proxy for the property, not the property. A
// future change can satisfy every shape assertion and still break the round
// trip, so the invariant is asserted directly here.
//
// The validator below covers EXACTLY the output language of inferSchema (type /
// properties / required / items / anyOf, plus additionalProperties:false, which
// conversion adds) and nothing else. It is deliberately not a JSON Schema
// implementation: the repo ships `dependencies: {}` and that is a product
// property. It was cross-verified against ajv 2020 over 341 (schema, instance)
// pairs with 0 disagreements, 285 of them genuine REJECTIONS -- the self-check
// below keeps it from silently decaying into a permissive stub that says yes to
// everything and proves nothing.
(function () {
  function isType(t, v) {
    if (t === "null") return v === null;
    if (t === "string") return typeof v === "string";
    if (t === "boolean") return typeof v === "boolean";
    if (t === "integer") return typeof v === "number" && Math.floor(v) === v && isFinite(v);
    if (t === "number") return typeof v === "number";
    if (t === "array") return Array.isArray(v);
    if (t === "object") return v !== null && typeof v === "object" && !Array.isArray(v);
    return true;
  }
  function accepts(schema, value) {
    if (!schema || typeof schema !== "object") return true;
    if (Array.isArray(schema.anyOf)) {
      for (var i = 0; i < schema.anyOf.length; i++) if (accepts(schema.anyOf[i], value)) return true;
      return false;
    }
    if (schema.type !== undefined) {
      var types = Array.isArray(schema.type) ? schema.type : [schema.type];
      var okType = false;
      for (var j = 0; j < types.length; j++) if (isType(types[j], value)) { okType = true; break; }
      if (!okType) return false;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      var req = schema.required || [];
      for (var r = 0; r < req.length; r++) {
        if (!Object.prototype.hasOwnProperty.call(value, req[r])) return false;
      }
      var props = schema.properties || {};
      for (var k in props) {
        if (Object.prototype.hasOwnProperty.call(value, k) && !accepts(props[k], value[k])) return false;
      }
      if (schema.additionalProperties === false) {
        for (var vk in value) if (!Object.prototype.hasOwnProperty.call(props, vk)) return false;
      }
    }
    if (schema.items !== undefined && Array.isArray(value)) {
      for (var a = 0; a < value.length; a++) if (!accepts(schema.items, value[a])) return false;
    }
    return true;
  }

  // Anti-vacuity self-check. Without this the whole block could pass against a
  // validator that returns true unconditionally.
  ok("#351 the round-trip validator rejects a wrong scalar type",
    accepts({ type: "integer" }, "x") === false);
  ok("#351 the round-trip validator rejects a missing required key",
    accepts({ type: "object", properties: { a: { type: "integer" } }, required: ["a"] }, {}) === false);
  ok("#351 the round-trip validator rejects a bad array element",
    accepts({ type: "array", items: { type: "integer" } }, [1, "x"]) === false);
  ok("#351 the round-trip validator rejects an undeclared key when closed",
    accepts({ type: "object", properties: {}, additionalProperties: false }, { a: 1 }) === false);
  ok("#351 the round-trip validator rejects a value matching no anyOf branch",
    accepts({ anyOf: [{ type: "string" }, { type: "integer" }] }, true) === false);
  ok("#351 the round-trip validator still accepts a legal instance",
    accepts({ type: "object", properties: { a: { type: "integer" } }, required: ["a"] }, { a: 1 }) === true);

  // The battery is deliberately wider than #350's six shapes: ragged nested
  // arrays, disjoint objects, empty-then-populated containers, three-way scalar
  // unions and deep mixed nesting are all shapes inference had never been run
  // against. 16 of these fail against the pre-#350 engine.
  var BATTERY = [
    { name: "flat object", doc: { id: 1, name: "a", ok: true } },
    { name: "homogeneous array", doc: { xs: [1, 2, 3] } },
    { name: "nested object", doc: { a: { b: { c: "x" } } } },
    { name: "mixed scalar array", doc: { xs: [1, "a"] } },
    { name: "int beside float", doc: { xs: [1, 2.5] } },
    { name: "float beside int", doc: { xs: [2.5, 1] } },
    { name: "null beside string", doc: { xs: [null, "x"] } },
    { name: "ragged nested arrays", doc: { xs: [[1], [2, "a"]] } },
    { name: "empty then populated array", doc: { xs: [[], [1, 2]] } },
    { name: "empty then populated object", doc: { xs: [{}, { a: 1 }] } },
    { name: "disjoint objects", doc: { xs: [{ a: 1 }, { b: 2 }] } },
    { name: "object beside scalar", doc: { xs: [{ a: 1 }, "x"] } },
    { name: "object, scalar, wider object", doc: { xs: [{ a: 1 }, "x", { a: 1, b: 2 }] } },
    { name: "null beside object", doc: { xs: [null, { a: 1 }] } },
    { name: "array beside object", doc: { xs: [[1], { a: 1 }] } },
    { name: "bool beside int", doc: { xs: [true, 1] } },
    { name: "array property varies in width", doc: { xs: [{ tags: [] }, { tags: ["x"] }] } },
    { name: "nested property type varies", doc: { xs: [{ v: 1 }, { v: "a" }] } },
    { name: "nested property int/float", doc: { xs: [{ v: 1 }, { v: 2.5 }] } },
    { name: "nested property null/string", doc: { xs: [{ v: null }, { v: "a" }] } },
    { name: "deep mixed nesting", doc: { a: { b: { c: [1, "x", null] } } } },
    { name: "three-way scalar union", doc: { xs: [1, "a", true] } },
    { name: "nested objects differing", doc: { xs: [{ o: { a: 1 } }, { o: { a: 1, b: 2 } }] } },
    { name: "array of nulls", doc: { xs: [null, null] } },
    { name: "null-valued property", doc: { a: null, b: "x" } },
    { name: "top-level array", doc: [{ a: 1 }, { a: 1, b: 2 }] },
    { name: "top-level mixed array", doc: [1, "a"] }
  ];

  var infFails = [];
  for (var i = 0; i < BATTERY.length; i++) {
    if (!accepts(E.inferSchema(BATTERY[i].doc), BATTERY[i].doc)) infFails.push(BATTERY[i].name);
  }
  ok("#351 every inferred schema accepts the example it came from (" + BATTERY.length + " shapes)",
    infFails.length === 0, infFails.join("; "));

  // Conversion must not quietly destroy the invariant either. Scoped by DIALECT,
  // and the scoping is the non-obvious part: `gemini` alone is excluded because
  // its output is a Gemini `Schema` PROTO MESSAGE, not JSON Schema (#319's
  // split), so it legitimately spells a null-typed node `{"nullable": true}`.
  // Running a JSON Schema validator over it is a category error -- one that this
  // cycle made before catching it. `gemini-client` keeps JSON Schema spellings
  // (#336) and so IS in scope.
  var JSON_DIALECT = ["openai", "openai-nonstrict", "openai-realtime", "anthropic",
    "anthropic-json", "anthropic-json-python", "anthropic-go", "gemini-json", "gemini-client"];
  // The assertion is a DISJUNCTION rather than a skip-list: a conversion may
  // narrow below the example only if it SAYS SO. Strict mode legitimately
  // narrows here (it has no optional fields, so a key absent from one element
  // becomes required-and-nullable) and states it verbatim. Keying on the ledger
  // entry that actually fired, rather than on a hand-maintained list of fixture
  // names, is what keeps this honest -- the name list I wrote first silently
  // missed a case, which is #340's lesson about keying on the op and not prose.
  var convFails = [], narrowed = 0;
  for (var t = 0; t < JSON_DIALECT.length; t++) {
    for (var b = 0; b < BATTERY.length; b++) {
      var r = E.convert(BATTERY[b].doc, JSON_DIALECT[t], { mode: "example" });
      if (!r || !r.ok || !r.schema) continue;
      if (accepts(r.schema, BATTERY[b].doc)) continue;
      if (has(r.ledger, "added to required")) { narrowed++; continue; }
      convFails.push(JSON_DIALECT[t] + "/" + BATTERY[b].name);
    }
  }
  ok("#351 a conversion narrows below its own example only when it says so",
    convFails.length === 0, convFails.slice(0, 6).join("; "));
  // Without this the disjunction could pass vacuously by never narrowing at all.
  ok("#351 GUARD the strict-mode narrowing branch is actually exercised",
    narrowed > 0);

  // GUARD: `gemini` is excluded for a REASON, not because it is broken. Its
  // output must still be the proto spelling -- if this ever starts looking like
  // JSON Schema, the exclusion above is what needs revisiting.
  var gem = E.convert({ a: null, b: "x" }, "gemini", { mode: "example" });
  ok("#351 GUARD `gemini` emits the proto spelling, which is why it is excluded",
    at(gem.schema, "properties.a.nullable") === true && at(gem.schema, "properties.a.type") === undefined);

  // GUARD for the #336/#337 interaction, which was correct but UNPINNED. A
  // converting client rebuilds the request from its own Schema type and drops
  // `nullable` outright -- it is not a JSON Schema keyword -- so emitting the
  // proto spelling here would delete the null constraint with no error anywhere.
  var gc = E.convert({ a: null, b: "x" }, "gemini-client", { mode: "example" });
  ok("#351 `gemini-client` keeps `type: \"null\"` rather than the droppable `nullable`",
    at(gc.schema, "properties.a.type") === "null" && at(gc.schema, "properties.a.nullable") === undefined);

  // The documented strict-mode narrowing must stay REPORTED, never silent.
  var opt = E.convert({ xs: [{ a: 1 }, { a: 1, b: 2 }] }, "openai", { mode: "example" });
  ok("#351 strict mode's optional-key narrowing is stated, not silent",
    has(opt.ledger, "added to required"));
})();

// --- #352: the outcome no keyword rule can see — an emptied document --------
//
// Found by a sweep, not by reading code: every schema this suite feeds to a
// converter was captured (362 distinct inputs) and run through all 10 targets,
// then checked against properties the project states but had never executed.
// 14 inputs came back constraining NOTHING — 22 of those rows at exit 1
// ("commit my output") and 2 at exit 0 ("Already valid — no changes needed").
//
// Each keyword rule involved is individually right: the narrow proto has no
// field for `if`, `contains`, `propertyNames`, `patternProperties`,
// `dependentRequired` or `unevaluatedProperties`, and a converting client
// cannot carry `oneOf`. What none of them can see is the node consisting of
// NOTHING BUT the keyword being removed — #329's tell, asked about the DOCUMENT
// ROOT for the first time. #347 caught one route (a match-anything `not`) and
// keyed its fix on the KEYWORD, which is why the other routes survived.
//
// Honest severity: `types.Schema` (google-genai 2.17.0) ACCEPTS `{}` — measured
// — so this is not a rejection. The request succeeds and the model is simply
// free to return anything, which is #347's corollary again: a metric that only
// measures acceptance scores the broken behaviour as a win.
(function () {
  function note(l) {
    return l.filter(function (e) {
      return e.msg.indexOf("Nothing is left in this document") !== -1;
    });
  }
  function blocked(r) {
    return r.ledger.some(function (e) { return e.op === "!" && !e.advisory; });
  }
  // Guarded on purpose: with the rule reverted there is no entry to read, and a
  // bare `[0].msg` aborts the whole file, which hides every assertion after it
  // and makes the revert check unreadable (#322).
  function noteText(l) { return (note(l)[0] || { msg: "" }).msg; }

  // Each of these is an ordinary shape a generator or a hand-written schema
  // produces, and each one used to come back as a document constraining nothing.
  [
    ["patternProperties", { patternProperties: { "^a": { type: "string" } } }],
    ["if/then", { "if": { type: "string" }, then: { minLength: 1 } }],
    ["contains", { contains: { type: "integer" } }],
    ["propertyNames", { propertyNames: { pattern: "^a" } }],
    ["dependentRequired", { dependentRequired: { a: ["b"] } }],
    ["unevaluatedProperties", { unevaluatedProperties: false }]
  ].forEach(function (row) {
    var r = E.toGemini(row[1]);
    ok("#352 gemini reports the emptied document for " + row[0],
      note(r.ledger).length === 1 && blocked(r));
  });

  // The discriminator that proves the rule is keyed on the OUTCOME and not on a
  // keyword list: ONE input, two targets, opposite verdicts.
  //
  // #365 re-cut this. It used to run `gemini` vs `gemini-client` on a `oneOf`
  // union, because `gemini-client` STRIPPED `oneOf` and so emptied the file.
  // That strip was the defect #365 fixed — `@ai-sdk/google` forwards `oneOf`
  // verbatim — so after the fix the union is emptied on NO target and the pair
  // no longer discriminates anything. The property being proved is orthogonal
  // to which pair demonstrates it, so it moves to `gemini` vs `gemini-json`,
  // which is the pair #352's own remedy names (it measured that 13 of its 14
  // emptied shapes survive `--to gemini-json`). Verified 2026-08-10 on three
  // separate shapes; `patternProperties` is the one below.
  var pet = {
    title: "Pet",
    oneOf: [
      { type: "object", properties: { meow: { type: "string" } }, required: ["meow"] },
      { type: "object", properties: { bark: { type: "string" } }, required: ["bark"] }
    ]
  };
  ok("#352 a union kept by the narrow proto is not reported as emptied",
    note(E.toGemini(pet).ledger).length === 0);
  // #365's fix, pinned where it would regress: the converting-client target
  // must not empty this file either.
  ok("#365 ...nor when a converting client is the target",
    note(E.toGemini(pet, false, true).ledger).length === 0 &&
    !!E.toGemini(pet, false, true).schema.oneOf);
  var patterned = { title: "M", patternProperties: { "^a": { type: "string" } } };
  ok("#352 a shape the narrow proto cannot carry IS reported as emptied",
    note(E.convert(patterned, "gemini").ledger).length === 1);
  ok("#352 ...and the SAME file is not emptied on the JSON-Schema path",
    note(E.convert(patterned, "gemini-json").ledger).length === 0);

  // Exit 0 was the worst of the two: the orphan-`$defs` pruner removes a bag
  // nothing points into WITHOUT a ledger entry, so a document consisting only of
  // that bag reached the "no changes needed" fallback with an empty ledger and
  // was told every keyword in it is a field of the SDK's `Schema` type — about a
  // document whose keywords had just been deleted.
  var bagOnly = { definitions: { I: { type: "object" } } };
  var bagRes = E.toGemini(bagOnly);
  ok("#352 a definition bag nothing points into no longer passes as valid",
    note(bagRes.ledger).length === 1 && blocked(bagRes));
  ok("#352 the emptied note replaces the false 'no changes needed' line",
    !has(bagRes.ledger, "Every keyword here is a field of the SDK's `Schema` type"));

  // Two cases, two remedies, and conflating them would be a false promise: a
  // document whose only content is a pointerless bag constrains nothing on EVERY
  // target, so naming an escape hatch there would send the reader somewhere that
  // cannot help. Measured: 13 of the 14 emptying shapes survive `--to
  // gemini-json`; this one is the fourteenth.
  ok("#352 the pointerless-bag case names the missing $ref, not another target",
    noteText(bagRes.ledger).indexOf("`$ref` INTO the bag") !== -1 &&
    noteText(bagRes.ledger).indexOf("--to gemini-json") === -1);
  ok("#352 the strippable-keyword case names the target that was measured to work",
    noteText(E.toGemini({ contains: { type: "integer" } }).ledger)
      .indexOf("`--to gemini-json`") !== -1);
  ok("#352 that same bag is reported on the JSON-Schema path too",
    note(E.toGemini(bagOnly, true).ledger).length === 1);

  // --- over-block guards ---------------------------------------------------
  // Being merely stricter than the vendor is this project's most repeated bug
  // (#312/#314/#317/#322/#329/#337/#343/#344/#348), and this rule fires on a
  // whole-document outcome, so it has the widest possible blast radius.
  ok("#352 an ordinary schema draws no emptied note on any target",
    ["openai", "openai-nonstrict", "openai-realtime", "anthropic", "anthropic-json",
      "anthropic-json-python", "anthropic-go", "gemini", "gemini-json", "gemini-client"]
      .every(function (p) {
        return note(E.convert({
          type: "object", properties: { a: { type: "string" } },
          required: ["a"], additionalProperties: false
        }, p).ledger).length === 0;
      }));
  // `gemini-json` carries every one of these keywords, so the same file that
  // blocks on the narrow proto must stay clean there — otherwise the remedy the
  // narrow path recommends would point at a target that also refuses it.
  ok("#352 gemini-json carries the keywords that empty the narrow proto",
    [{ patternProperties: { "^a": { type: "string" } } },
      { contains: { type: "integer" } },
      { propertyNames: { pattern: "^a" } }]
      .every(function (s) { return note(E.toGemini(s, true).ledger).length === 0; }));
  // An input that already constrained nothing has lost nothing. The rule is
  // about what the CONVERSION did, not about how weak the input was.
  ok("#352 an input that was already unconstrained is not reported",
    note(E.toGemini({}).ledger).length === 0 &&
    note(E.toGemini({ title: "x", description: "d" }).ledger).length === 0);
  // A PROPERTY emptying to `{}` is a different, already-reported thing: the
  // document still constrains plenty. Keying the check on the root is what keeps
  // these apart, and #343's advisory already covers the node level.
  ok("#352 a property emptied inside a schema is not a document-level report",
    note(E.toGemini({
      type: "object",
      properties: { v: { const: "a" } },
      required: ["v"]
    }).ledger).length === 0);
  // Exactly one entry, however many keywords were removed on the way.
  ok("#352 the note is emitted once, not once per removal",
    note(E.toGemini({
      patternProperties: { "^a": { type: "string" } },
      propertyNames: { pattern: "^a" },
      contains: { type: "integer" }
    }).ledger).length === 1);
})();

// #353 — Anthropic's root contract, keyed on the OUTCOME.
//
// Measured on @anthropic-ai/sdk@0.116.0 across a shape battery: the ONLY root
// rule either helper has is a literal `type: "object"`. `{type:"object", anyOf:
// [...]}` is accepted; a nested `definitions` bag is forwarded verbatim. The
// previous check named the keywords that could supply a type and then excused
// every one of them, so four typeless roots went out at exit 0.
(function () {
  var OBJ = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  function o(x) { return JSON.parse(JSON.stringify(x)); }
  // Key on the ledger OP, never on the prose (#340: a check keyed on wording
  // breaks when the wording changes, and matches the wrong entry when it does not).
  function blocked(l) {
    return !!l && l.some(function (e) { return e.op === "!" && !e.advisory; });
  }
  function rootType(s) { return s && s.type; }

  // --- REPAIRS. Each is verified by the root gaining `type: "object"` while the
  // structure that carried the meaning survives. ---

  // The DEFAULT output of zod-to-json-schema. `normalizeDefs` runs only on the
  // output_format path, so on the tools path this spelling reached the root-$ref
  // inliner unrenamed, matched its `#/$defs/`-only regex, and was left alone.
  var zodV3 = { $ref: "#/definitions/T", definitions: { T: OBJ } };
  ok("#353 zod-to-json-schema's default root $ref is inlined on the tools path",
    rootType(E.toAnthropic(o(zodV3), false).schema) === "object" &&
    !blocked(E.toAnthropic(o(zodV3), false).ledger));
  // The spelling that always worked must keep working: this is the pin that
  // says the fix widened the resolver rather than moved it.
  ok("#353 the `$defs` spelling of a root $ref still inlines",
    rootType(E.toAnthropic(o({ $ref: "#/$defs/T", $defs: { T: OBJ } }), false).schema) === "object");

  // Pydantic's `RootModel[Union[A, B]]` verbatim: `{$defs, anyOf:[{$ref},{$ref}], title}`,
  // no root `type`. Lossless because every branch is already an object.
  var pyUnion = {
    title: "P",
    $defs: { A: OBJ, B: { type: "object", properties: { b: { type: "string" } } } },
    anyOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }]
  };
  ok("#353 an all-object union root gains `type: object` and keeps its branches",
    (function () {
      var r = E.toAnthropic(o(pyUnion), false);
      return rootType(r.schema) === "object" &&
        Array.isArray(r.schema.anyOf) && r.schema.anyOf.length === 2 &&
        !blocked(r.ledger);
    })());
  ok("#353 an all-object `oneOf` root is repaired the same way",
    rootType(E.toAnthropic(o({ oneOf: [OBJ, { type: "object" }] }), false).schema) === "object");

  // --- GUARDS. Being stricter than the vendor is this project's most repeated
  // bug, and adding a type where it narrows is #348's inversion. Both directions. ---

  // A branch that admits a non-object cannot be repaired: `type: "object"` would
  // be ACCEPTED by the vendor and would silently delete that branch.
  ok("#353 a union root with a non-object branch is blocked, not repaired",
    (function () {
      var r = E.toAnthropic(o({ anyOf: [OBJ, { type: "string" }] }), false);
      return blocked(r.ledger) && rootType(r.schema) !== "object" &&
        r.schema.anyOf.length === 2;   // and the branch is left visible (#318)
    })());
  // Fail closed (#320): a branch we cannot resolve is not assumed to be an object.
  ok("#353 a union root with an unresolvable $ref branch fails closed",
    blocked(E.toAnthropic(o({ anyOf: [OBJ, { $ref: "#/$defs/Nope" }] }), false).ledger));
  // A root with no type and nothing to read one from is still the #341 blocker,
  // not a silently-added `type: "object"` that would leave a dead input.
  ok("#353 a definition bag with no pointer into it is still blocked",
    blocked(E.toAnthropic(o({ definitions: { T: OBJ } }), false).ledger));

  // OVER-STRICTNESS GUARDS: the tools path applies no transform, and `betaTool()`
  // forwards a nested `definitions` bag verbatim (measured), so renaming it would
  // be an edit the destination never asked for.
  ok("#353 a nested `definitions` bag under a typed root is left alone",
    (function () {
      var r = E.toAnthropic(o({
        type: "object",
        properties: { a: { $ref: "#/definitions/T" } },
        definitions: { T: { type: "string" } }
      }), false);
      return !blocked(r.ledger) && isDefBag(r.schema) &&
        r.schema.properties.a.$ref === "#/definitions/T";
      function isDefBag(s) { return s.definitions && !s.$defs; }
    })());
  // Not "draws no root entry" — the tools path always carries one informational
  // `=` note about applying no transform. The property that matters is that the
  // document is handed back untouched.
  ok("#353 an ordinary object root is passed through byte-identical",
    (function () {
      var r = E.toAnthropic(o(OBJ), false);
      return !blocked(r.ledger) &&
        JSON.stringify(r.schema) === JSON.stringify(OBJ) &&
        r.ledger.every(function (e) { return e.op === "=" || e.advisory; });
    })());
  // The Python SDK deliberately KEEPS a root `$ref` (it pops `$defs` before its
  // early return), so the outcome-keyed check must not read that as a defect.
  ok("#353 the Python path's deliberate root `$ref` is not blocked",
    !blocked(E.toAnthropic(o({ $ref: "#/$defs/T", $defs: { T: OBJ } }), true, "python").ledger));
})();

// --- #355: a container keyword holding the wrong KIND of thing ---------------
// Every descent guard in walk() and findBooleanSubschemas() is a type test, so a
// malformed container reads exactly like an absent one: the subtree is skipped
// in silence and the engine then answers "Already valid. No changes needed."
// #354 recorded `{"$defs": true}` as a known exit-0 hole and left it; this is
// that hole, and the rest of the class it belongs to.
//
// Vendor consequences MEASURED 2026-08-09 (they disagree, and two do not
// complain): anthropic-sdk-go v1.62.0 returns `schema: null` for the WHOLE
// document on 15 of 17 probed shapes and builds the request anyway; anthropic
// 0.121.0 `transform_schema` RAISES on 5; @anthropic-ai/sdk 0.116.0
// `betaJSONSchemaOutputFormat` throws on 3 while `betaTool` forwards all of
// them verbatim; openai 7.4.0 `toStrictJsonSchema` ACCEPTS `$defs: true` and
// `properties: true`. The blocker is universal anyway because it is a statement
// about OUR analysis being uninformed, not about vendor tolerance.
(function () {
  var TARGETS = Object.keys(E.DOCS);
  function malformed(l) {
    return (l || []).some(function (e) {
      return e.op === "!" && !e.advisory && /is not valid JSON Schema/.test(e.msg);
    });
  }
  function hits(sch, provider) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), provider || "openai");
    return r && r.ok !== false && malformed(r.ledger);
  }
  function hitsEvery(sch) { return TARGETS.every(function (t) { return hits(sch, t); }); }
  function hitsNone(sch) { return TARGETS.every(function (t) { return !hits(sch, t); }); }
  var BODY = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
  function withKw(kw, v) { var s = JSON.parse(JSON.stringify(BODY)); s[kw] = v; return s; }

  // --- the recorded #354 gap, on every target --------------------------------
  ok("#355 `$defs: true` is caught on ALL ten targets (the #354 hole)", hitsEvery(withKw("$defs", true)));
  ok("#355 `definitions: true` is caught", hitsEvery(withKw("definitions", true)));
  ok("#355 `dependentSchemas: true` is caught", hitsEvery(withKw("dependentSchemas", true)));

  // --- the rest of the class -------------------------------------------------
  ok("#355 `properties` holding a boolean is caught", hitsEvery({ type: "object", properties: true }));
  ok("#355 `properties` holding an array is caught", hitsEvery({ type: "object", properties: [{ a: 1 }] }));
  ok("#355 `properties` holding a string is caught", hitsEvery({ type: "object", properties: "a" }));
  ok("#355 `anyOf` holding an object (not an array) is caught", hitsEvery({ anyOf: { type: "string" } }));
  ok("#355 `prefixItems` holding a boolean is caught", hitsEvery(withKw("prefixItems", true)));

  // A MEMBER that is not a schema is the same defect one level down: walk()
  // drops it on the same isPlainObject guard, in silence.
  ok("#355 a `properties` MEMBER that is not a schema is caught",
    hitsEvery({ type: "object", properties: { a: "string" } }));
  ok("#355 an `anyOf` MEMBER that is not a schema is caught",
    hitsEvery({ anyOf: [{ type: "string" }, "nope"] }));

  // It has to descend, or it is only a root check.
  ok("#355 a malformed container NESTED in a property is caught",
    hitsEvery({ type: "object", properties: { o: { type: "object", $defs: true } }, required: ["o"] }));
  ok("#355 a malformed container inside `$defs` is caught",
    hitsEvery({ type: "object", properties: { a: { $ref: "#/$defs/T" } }, $defs: { T: { type: "object", properties: true } } }));

  // --- OVER-BLOCK GUARDS: these hold both ways, and are the reason the rule is
  // keyed on KIND rather than on the table's isSubschemaMap/isSubschemaArray.
  // The stricter predicate blocked 24 real captured corpus inputs.
  ok("#355 guard: `items: []` is empty, not malformed (#346)",
    hitsNone({ type: "object", properties: { b: { type: "array", items: [] } }, required: ["b"] }));
  ok("#355 guard: `anyOf: []` is empty, not malformed (#347)",
    hitsNone({ type: "object", properties: { p: { anyOf: [] } }, required: ["p"] }));
  ok("#355 guard: `allOf: []` is vacuously true, not malformed (#347)",
    hitsNone({ type: "object", properties: { p: { type: "string", allOf: [] } }, required: ["p"] }));
  ok("#355 guard: `properties: {}` is an empty object, not malformed",
    hitsNone({ type: "object", properties: {}, additionalProperties: false }));
  ok("#355 guard: `patternProperties: {}` is not malformed",
    hitsNone({ type: "object", properties: { m: { type: "object", patternProperties: {} } }, required: ["m"] }));
  ok("#355 guard: draft-07 tuple form (`items` as an ARRAY of schemas) is legal",
    hitsNone({ type: "object", properties: { b: { type: "array", items: [{ type: "integer" }, { type: "string" }] } }, required: ["b"] }));
  ok("#355 guard: a boolean subschema in a legal position is not malformed (#333)",
    hitsNone({ type: "object", properties: { d: true }, required: ["d"] }));
  ok("#355 guard: `additionalProperties` takes a boolean BY DESIGN",
    hitsNone(BODY) && hitsNone({ type: "object", additionalProperties: true }) &&
    hitsNone({ type: "object", additionalProperties: { type: "string" } }));
  // #334's control: a property literally NAMED after a container keyword is in a
  // DATA position, not a schema position, and must never be a false positive.
  ok("#355 guard: a property NAMED `$defs`/`anyOf` is not a false positive",
    hitsNone({ type: "object", properties: { $defs: { type: "boolean" }, anyOf: { type: "string" } }, required: ["$defs", "anyOf"] }));
  ok("#355 guard: an ordinary schema is untouched on every target", hitsNone(BODY));

  // --- SCOPE PINS: measured malformed, deliberately NOT shipped. These are the
  // degenerate typed-field rows #354 declined (no generator emits them) and they
  // skip no subtree, so our verdict is not uninformed. Pinned so a later widening
  // is a deliberate decision rather than an accident.
  ok("#355 scope: `required: \"a\"` is out of scope for this rule", hitsNone(withKw("required", "a")));
  ok("#355 scope: `exclusiveMaximum: true` is out of scope (#354 declined it)",
    hitsNone(withKw("exclusiveMaximum", true)));
  ok("#355 scope: `format: null` on a leaf is out of scope (#345)",
    hitsNone({ type: "object", properties: { x: { type: "string", format: null } }, required: ["x"] }));

  // An inferred schema is well formed by construction, so the check is skipped
  // for example input rather than reporting on a document we built ourselves.
  ok("#355 an input treated as an EXAMPLE is not reported as malformed",
    !malformed((E.convert({ items: [1, 2, 3], total: 12.5 }, "openai") || {}).ledger));

  // The blocker is a real blocker, not an advisory (#317: advisories must never
  // fail a gate, and this one must).
  ok("#355 the entry is a non-advisory blocker", (function () {
    var e = (E.convert(withKw("$defs", true), "openai").ledger || []).filter(function (x) {
      return /is not valid JSON Schema/.test(x.msg);
    })[0];
    return e && e.op === "!" && !e.advisory;
  })());
  // It must be FIRST: every other ledger line was computed from a document we
  // could not fully read.
  ok("#355 the blocker is the first ledger entry", (function () {
    var l = E.convert(withKw("$defs", true), "openai").ledger || [];
    return l.length && /is not valid JSON Schema/.test(l[0].msg);
  })());
  // Parity, behaviourally rather than by exporting the tables: EVERY container
  // keyword must produce a real description. A keyword added to CONTAINER_SHAPE
  // without a SHAPE_WANTS line would fall back to "a different kind of value",
  // which tells the reader nothing (#334 -- make the agreement a test).
  ok("#355 every container keyword has a real description", (function () {
    var kws = ["$defs", "definitions", "properties", "patternProperties", "dependentSchemas",
      "anyOf", "oneOf", "allOf", "prefixItems", "not", "if", "then", "else", "contains",
      "propertyNames", "additionalProperties", "unevaluatedProperties", "unevaluatedItems",
      "additionalItems", "items"];
    return kws.every(function (kw) {
      var e = (E.convert(withKw(kw, "not-a-schema"), "openai").ledger || [])[0];
      return e && /is not valid JSON Schema/.test(e.msg) && !/a different kind of value/.test(e.msg);
    });
  })());

  // The message has to name the keyword AND what it should have held.
  ok("#355 the message names the keyword and the required kind", (function () {
    var m = (E.convert({ type: "object", properties: true }, "openai").ledger || [])[0];
    return m && /`properties` must be an object mapping property names to schemas/.test(m.msg) &&
      /the boolean `true`/.test(m.msg);
  })());
})();

// --- #356 a typed catchall beside declared `properties` -------------------
//
// VERBATIM output of `z.object({a: z.string()}).catchall(...)` on zod@4.4.3
// (#311 -- test against what the generator really emits). All three Anthropic
// `output_format` SDKs delete the value schema and force `additionalProperties:
// false`, measured 2026-08-09 on @anthropic-ai/sdk@0.116.0, anthropic==0.121.0
// and anthropic-sdk-go@v1.62.0.
(function () {
  var CATCHALL_OBJ = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", properties: { a: { type: "string" } }, required: ["a"],
    additionalProperties: {
      type: "object", properties: { z: { type: "string", minLength: 3 } },
      required: ["z"], additionalProperties: false
    }
  };
  var CATCHALL_STR = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", properties: { a: { type: "string" } }, required: ["a"],
    additionalProperties: { type: "string" }
  };
  var PLAIN = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", properties: { a: { type: "string" } }, required: ["a"],
    additionalProperties: false
  };
  var OPEN_MAP = { type: "object", additionalProperties: { type: "string" } };
  var MARK = "declares `properties` AND an `additionalProperties`";
  var conv = function (s, t) { return E.convert(JSON.parse(JSON.stringify(s)), t).ledger; };

  ok("#356 anthropic-json reports a deleted catchall value schema",
    has(conv(CATCHALL_OBJ, "anthropic-json"), MARK));
  ok("#356 anthropic-json-python reports it too (measured, not ported)",
    has(conv(CATCHALL_OBJ, "anthropic-json-python"), MARK));
  ok("#356 anthropic-go reports it -- its dictionary clause needs NO properties",
    has(conv(CATCHALL_OBJ, "anthropic-go"), MARK));
  ok("#356 a scalar catchall is reported the same way",
    has(conv(CATCHALL_STR, "anthropic-json"), MARK));
  ok("#356 the message names BOTH losses: closed AND value schema gone",
    (function () {
      var l = conv(CATCHALL_OBJ, "anthropic-json").filter(function (e) {
        return e.msg.indexOf(MARK) !== -1;
      })[0];
      if (!l) return false;
      var m = l.msg.replace(/\s+/g, " ");
      return /stop being accepted/.test(m) && /look like is gone/.test(m);
    })());
  ok("#356 it is ADVISORY -- never a gate failure (#317)",
    (function () {
      var l = conv(CATCHALL_OBJ, "anthropic-json").filter(function (e) {
        return e.msg.indexOf(MARK) !== -1;
      })[0];
      return !!l && l.advisory === true && l.op === "=";
    })());

  // --- over-block guards: all four correctly hold both ways -----------------
  ok("#356 guard: the tools path is verbatim, so nothing is reported there",
    !has(conv(CATCHALL_OBJ, "anthropic"), MARK));
  ok("#356 guard: an ordinary closed object is NOT flagged",
    !has(conv(PLAIN, "anthropic-json"), MARK));
  ok("#356 guard: a pure open map keeps the #329 rule, not this one",
    !has(conv(OPEN_MAP, "anthropic-json"), MARK) &&
    has(conv(OPEN_MAP, "anthropic-json"), "This is an open map"));
  ok("#356 guard: the two rules are mutually exclusive -- never both on one node",
    (function () {
      var l = conv(CATCHALL_OBJ, "anthropic-json");
      return !has(l, "This is an open map");
    })());
  ok("#356 guard: the catchall value schema still survives our own output",
    (function () {
      var r = E.convert(JSON.parse(JSON.stringify(CATCHALL_OBJ)), "anthropic-json");
      var ap = r.schema && r.schema.additionalProperties;
      return !!ap && ap.properties && ap.properties.z && ap.properties.z.minLength === 3;
    })());
})();

// --- #357: the other three map spellings are EMPTIED on the Anthropic
// output_format path, not merely unenforced --------------------------------
//
// Measured 2026-08-10 on @anthropic-ai/sdk@0.116.0, anthropic==0.121.0 and
// anthropic-sdk-go@v1.62.0, with a discriminating control in each run: a node
// whose only key-admitting keyword is `patternProperties`/`propertyNames`/
// `unevaluatedProperties` comes back as
// {"type":"object","properties":{},"additionalProperties":false} from ALL
// THREE. The generic demote-to-prose note said the keyword was "not enforced",
// which is true of the keyword and false of the field.
(function () {
  // Guarded like every other block here: a missing converter must REPORT, not
  // abort the file and hide the assertions after it (#322).
  function conv(sch, p) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), p) || {};
    return r.ledger || [];
  }
  var MARK = "only thing admitting a key";
  var DEAD = "never populate this field";

  // Verbatim pydantic 2.13.4 output for
  // Dict[Annotated[str, StringConstraints(pattern=r'^S_')], str] — the one
  // shape of this class demonstrated from a dominant generator (#311/#346).
  var PP_ONLY = { type: "object", patternProperties: { "^S_": { type: "string" } }, title: "M" };
  var PN_ONLY = { type: "object", propertyNames: { pattern: "^S_" } };
  var UP_ONLY = { type: "object", unevaluatedProperties: { type: "string" } };
  // Has declared properties: the field SURVIVES, so the ordinary demotion note
  // is the correct one and this rule must stay out of it (#356's split).
  var PP_PROPS = {
    type: "object", properties: { a: { type: "string" } }, required: ["a"],
    patternProperties: { "^S_": { type: "string" } }
  };
  // Verbatim zod@4.4.3 `z.record(z.string(), z.string())` — emits BOTH
  // `propertyNames` and `additionalProperties`, so it is an open map and #329's
  // arm owns it. This is the reason the new rule excludes open maps.
  var ZOD_RECORD = {
    type: "object", propertyNames: { type: "string" },
    additionalProperties: { type: "string" }
  };
  var PLAIN = {
    type: "object", properties: { a: { type: "string" } }, required: ["a"],
    additionalProperties: false
  };

  ["anthropic-json", "anthropic-json-python", "anthropic-go"].forEach(function (t) {
    ok("#357 " + t + ": a patternProperties-only node is reported as EMPTIED",
      has(conv(PP_ONLY, t), MARK) && has(conv(PP_ONLY, t), DEAD));
    ok("#357 " + t + ": a propertyNames-only node is reported as EMPTIED",
      has(conv(PN_ONLY, t), MARK));
    // Over-block guard, both ways: the field survives here, so this rule must
    // not fire — the generic demotion note is the right one.
    ok("#357 " + t + " guard: declared `properties` keeps the field, so no emptying claim",
      !has(conv(PP_PROPS, t), MARK));
    ok("#357 " + t + " guard: an ordinary closed object is untouched",
      !has(conv(PLAIN, t), MARK));
    // Reported ONCE. zod's record is an open map; #329's arm owns it.
    ok("#357 " + t + " guard: a zod `z.record()` stays with the open-map rule, not this one",
      !has(conv(ZOD_RECORD, t), MARK) &&
      has(conv(ZOD_RECORD, t), "This is an open map"));
    // #347's empty-collection discipline: `patternProperties: {}` describes no
    // keys, so closing the object loses nothing.
    ok("#357 " + t + " guard: an EMPTY patternProperties is not evidence of a map",
      !has(conv({ type: "object", patternProperties: {} }, t), MARK));
  });

  // The tools path (TypeScript/Python) applies no transform at all, measured
  // byte-identical, so claiming a loss there would be the stricter-than-the-
  // vendor bug. This is the assertion that proves the rule is scoped to the
  // paths that actually destroy the node.
  ok("#357 guard: `--to anthropic` (verbatim tools path) makes no emptying claim",
    !has(conv(PP_ONLY, "anthropic"), MARK));

  // Go loses `unevaluatedProperties` with no prose at all: invopop@v0.14.0's
  // `Schema` models `patternProperties` and `propertyNames` and has no field
  // for this one, so encoding/json drops it before the transform runs (#332).
  ok("#357 go: unevaluatedProperties is dropped with no prose, and says so",
    has(conv(UP_ONLY, "anthropic-go"), "not even demoted to prose"));
  ok("#357 guard: the TypeScript path does NOT claim the silent-drop mechanism",
    has(conv(UP_ONLY, "anthropic-json"), MARK) &&
    !has(conv(UP_ONLY, "anthropic-json"), "not even demoted to prose"));

  // We do not strip the keyword: the value schema stays in the file, which is
  // what makes the remedy actionable (#318 — leave the shape visible).
  ok("#357: the value schema survives our own output rather than being deleted",
    (function () {
      var r = E.convert(JSON.parse(JSON.stringify(PP_ONLY)), "anthropic-json") || {};
      var pp = r.schema && r.schema.patternProperties;
      return !!pp && !!pp["^S_"] && pp["^S_"].type === "string";
    })());

  // A converter's job is to move nodes, so the position that counts is the one
  // in our OUTPUT (#354) — the walk must reach a nested map.
  ok("#357: a nested map-only node is reached by the walk",
    has(conv({
      type: "object", additionalProperties: false, required: ["m"],
      properties: { m: PP_ONLY }
    }, "anthropic-json"), MARK));
})();

// --- #358: Go keeps the map and destroys the value schema ---------------
// `transformSchema`'s dictionary clause preserves `additionalProperties` and
// recurses into the value schema (#332 -- the one SDK that gets open maps
// right). That recursion runs the value through the SAME bail as every other
// node: no `type` and nothing to stand in for one -> the zero
// `jsonschema.Schema`, which invopop marshals as the literal `true`. So the map
// survives with its value type replaced by match-anything.
//
// All rows measured 2026-08-10 against anthropic-sdk-go@v1.62.0 through
// `BetaJSONSchemaOutputFormat` AND `BetaToolInputSchema` (identical output --
// Go has no verbatim path), with a typed control in the same run.
(function () {
  function conv(sch, p) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), p);
    return r && r.ledger;
  }
  var MARK = "DESTROYS the value schema";

  // VERBATIM `z.record(z.string(), z.never())` on zod@4.4.3 (#311). A map that
  // admits NO value; Go returns `additionalProperties: true`, which admits
  // every value. The strongest inversion in the family.
  var ZOD_NEVER = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", propertyNames: { type: "string" },
    additionalProperties: { not: {} }
  };
  ok("#358: zod's `z.record(z.never())` map is reported on anthropic-go",
    has(conv(ZOD_NEVER, "anthropic-go"), MARK));

  // The walk reaches a nested map -- the position that counts is the one in our
  // own output (#354), and `properties` is where a real model puts a dictionary.
  ok("#358: a nested open map with a typeless value is reached",
    has(conv({
      type: "object", required: ["m"],
      properties: { m: { type: "object", additionalProperties: { not: {} } } }
    }, "anthropic-go"), MARK));

  // A typeless object schema WITH declared properties is the shape that loses
  // the most: measured, the whole model comes back as `true`.
  ok("#358: a typeless value schema carrying `properties` is reported",
    has(conv({
      type: "object",
      additionalProperties: { properties: { a: { type: "string" } }, required: ["a"] }
    }, "anthropic-go"), MARK));

  // Length checks, not presence checks -- the Go guard uses `len()`, so an
  // empty `enum`/`anyOf` reaches the bail. Both measured as `true`.
  ok("#358: an empty `enum` value schema reaches the Go bail",
    has(conv({ type: "object", additionalProperties: { enum: [] } }, "anthropic-go"), MARK));
  ok("#358: an empty `anyOf` value schema reaches the Go bail",
    has(conv({ type: "object", additionalProperties: { anyOf: [] } }, "anthropic-go"), MARK));

  // --- over-block guards: every one of these is PRESERVED by the SDK -------
  // Being stricter than the vendor is this project's most repeated bug
  // (#312/#314/#317/#322/#329/#337/#343/#344/#348). Each row measured intact.
  [["a declared `type`", { type: "string" }],
   ["a non-empty `enum`", { enum: ["a", "b"] }],
   ["a `const`", { const: "x" }],
   ["a non-empty `allOf`", { allOf: [{ type: "string" }] }],
   ["a non-empty `anyOf`", { anyOf: [{ type: "string" }] }],
   ["a `$ref` (the SDK bails on it before the guard)", { $ref: "#/$defs/T" }]
  ].forEach(function (row) {
    ok("#358 guard: a value schema with " + row[0] + " is NOT reported",
      !has(conv({
        type: "object", additionalProperties: row[1],
        $defs: { T: { type: "string" } }
      }, "anthropic-go"), MARK));
  });

  // `{}` and `true` are THE SAME SCHEMA, so Go's `true` is a faithful rendering
  // and there is nothing to report. This is the discriminator that keeps the
  // rule about meaning rather than about emptiness (#347).
  ok("#358 guard: an already-unconstrained `{}` value schema stays quiet",
    !has(conv({ type: "object", additionalProperties: {} }, "anthropic-go"), MARK));
  ok("#358 guard: `additionalProperties: true` stays quiet",
    !has(conv({ type: "object", additionalProperties: true }, "anthropic-go"), MARK));

  // Per-target scope, measured not ported (rule 0-bis). The TypeScript and
  // Python `output_format` transformers rebuild the node as
  // `{"type":"object","properties":{},"additionalProperties":false}` for EVERY
  // value schema, typed or not -- they never look at the value at all, so this
  // loss is Go-only and #329's advisory already owns those two paths. The tools
  // path returns the schema byte-identical.
  ["anthropic", "anthropic-json", "anthropic-json-python", "openai",
   "openai-nonstrict", "gemini", "gemini-json"].forEach(function (t) {
    ok("#358 scope: " + t + " does not claim the Go-only value loss",
      !has(conv(ZOD_NEVER, t), MARK));
  });

  // The typed control must still get the reassuring note -- and must NOT get
  // the destruction note. This pair is what makes the two branches meaningful.
  // #359 widened this claim: the note now says the whole SUBTREE is intact,
  // which is a stronger statement than the original "leaves it intact" and is
  // only made when it is true. Asserted as a pair with its negative below.
  ok("#358: a typed value schema still gets the preservation note",
    has(conv({ type: "object", additionalProperties: { type: "string" } }, "anthropic-go"),
      "leaves the subtree intact"));

  // We never strip: the value schema stays in our output, which is what makes
  // the remedy actionable (#318 -- leave the shape visible).
  ok("#358: the value schema survives our own output",
    (function () {
      var r = E.convert(JSON.parse(JSON.stringify(ZOD_NEVER)), "anthropic-go") || {};
      var ap = r.schema && r.schema.additionalProperties;
      return !!ap && typeof ap === "object" && ap.not !== undefined;
    })());
})();

// ---------------------------------------------------------------------------
// #359 -- the vendor's recursion does not stop where our rule stopped.
//
// #358 mirrored Go's guard for the value schema sitting IN `additionalProperties`
// and, in the clean case, printed "recurses into the value schema ... leaves it
// intact". That recursion keeps going. walk() never enters `additionalProperties`
// at all, so every rule is blind below that edge -- and the one rule that read
// through it read exactly one level and then affirmatively reassured about the
// rest. Measured on anthropic-sdk-go@v1.62.0.
// ---------------------------------------------------------------------------
(function () {
  var MARK = "will REPLACE IT with the literal JSON `true`";
  var CALM = "leaves the subtree intact";
  function conv(s, t) { return E.convert(JSON.parse(JSON.stringify(s)), t) || {}; }
  function has(r, sub) {
    return (r.ledger || []).some(function (l) { return String(l.msg || "").indexOf(sub) !== -1; });
  }
  function blockers(r) {
    return (r.ledger || []).filter(function (l) { return l.op === "!" && !l.advisory; }).length;
  }

  // VERBATIM zod@4.4.3 output for `z.record(z.string(), z.object({ x: z.never() }))`
  // (#311 -- generate the input with the tool the audience uses). The value
  // model is INLINED under `additionalProperties`, which is what puts it in a
  // position nothing reached.
  var ZOD_REC_NEVER = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    type: "object", propertyNames: { type: "string" },
    additionalProperties: {
      type: "object", properties: { x: { not: {} } },
      required: ["x"], additionalProperties: false
    }
  };
  // `z.record(z.string(), z.record(z.string(), z.never()))` -- two map edges.
  var ZOD_REC_REC = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    type: "object", propertyNames: { type: "string" },
    additionalProperties: {
      type: "object", propertyNames: { type: "string" },
      additionalProperties: { not: {} }
    }
  };

  // Measured: the SDK returns `{"additionalProperties":{...,"properties":{"x":true},...}}`
  // -- a property that admitted NO value now admits every value.
  ok("#359: a typeless node below a map edge is reported",
    has(conv(ZOD_REC_NEVER, "anthropic-go"), MARK));
  ok("#359: it is a blocker, matching the same defect in a walked position",
    blockers(conv(ZOD_REC_NEVER, "anthropic-go")) === 1);
  ok("#359: the destroyed node's own path is named, not just the map's",
    (conv(ZOD_REC_NEVER, "anthropic-go").ledger || []).some(function (l) {
      return l.op === "!" && l.path === "root{}.x";
    }));
  ok("#359: a second map edge is followed too",
    has(conv(ZOD_REC_REC, "anthropic-go"), MARK));
  ok("#359: depth is not capped at one level below the map",
    has(conv({
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { inner: { type: "object", properties: { deep: { not: {} } }, required: ["deep"] } },
        required: ["inner"]
      }
    }, "anthropic-go"), MARK));
  ok("#359: an array item below a map edge is reached",
    has(conv({ type: "object", additionalProperties: { type: "array", items: { description: "no type" } } },
      "anthropic-go"), MARK));

  // THE FALSE REASSURANCE. #358's note named the mechanism of the harm
  // ("recurses into the value schema") as the comfort. It must not be printed
  // when that recursion destroys something. This pair is the whole fix.
  ok("#359: the reassuring note is NOT printed when the subtree is destroyed",
    !has(conv(ZOD_REC_NEVER, "anthropic-go"), CALM));
  ok("#359: the reassuring note IS printed when the subtree really is clean",
    has(conv({
      type: "object",
      additionalProperties: { type: "object", properties: { x: { type: "string" } }, required: ["x"] }
    }, "anthropic-go"), CALM));

  // --- mirror fidelity: five clauses read off schemautil.go -----------------
  // Each is a place the vendor STOPS. Reporting past any of them would be the
  // stricter-than-the-vendor bug this project has shipped repeatedly.
  //
  // Clause 3: with declared `properties`, the object branch overwrites
  // `additionalProperties` with `false` and never visits the value -- so the
  // #356 typed-catchall shape must NOT be descended.
  ok("#359 mirror: a typed catchall's value subtree is not descended (clause 3)",
    !has(conv({
      type: "object", properties: { a: { type: "string" } }, required: ["a"],
      additionalProperties: { type: "object", properties: { x: { not: {} } }, required: ["x"] }
    }, "anthropic-go"), MARK));
  // Clause 4: `Items` is a `*Schema`; the draft-07 array form fails to
  // unmarshal and takes the whole document to null -- #332's rule owns that.
  ok("#359 mirror: array-form `items` below a map is not descended (clause 4)",
    !has(conv({ type: "object", additionalProperties: { type: "array", items: [{ not: {} }] } },
      "anthropic-go"), MARK));
  // Clause 5: the switch is on a STRING type, so a union-typed node reaches no
  // branch and nothing below it is visited.
  ok("#359 mirror: a union-typed node below a map is not descended (clause 5)",
    !has(conv({ type: "object", additionalProperties: { type: ["object", "null"], properties: { x: { not: {} } } } },
      "anthropic-go"), MARK));
  // Clause 1: anyOf/allOf recurse unconditionally, before the type switch.
  ok("#359 mirror: an `anyOf` branch below a map IS descended (clause 1)",
    has(conv({
      type: "object",
      additionalProperties: { anyOf: [{ type: "string" }, { type: "object", properties: { x: { not: {} } }, required: ["x"] }] }
    }, "anthropic-go"), MARK));
  // Clause 2: the vendor bails on a zeroing node, so nothing below one is
  // reached -- and #358 already reports the value schema itself, so reporting
  // its children too would double-count a subtree the SDK never looks at.
  ok("#359 mirror: nothing below a node that itself zeroes out is reported (clause 2)",
    (conv({ type: "object", additionalProperties: { description: "typeless", properties: { x: { not: {} } } } },
      "anthropic-go").ledger || []).filter(function (l) {
        return String(l.msg || "").indexOf(MARK) !== -1;
      }).length === 0);

  // --- over-block guards ----------------------------------------------------
  // `{}` and `true` are the same schema, so Go's `true` is faithful (#347/#358).
  ok("#359 guard: an unconstrained `{}` below a map stays quiet",
    !has(conv({ type: "object", additionalProperties: { type: "object", properties: { x: {} }, required: ["x"] } },
      "anthropic-go"), MARK));
  ok("#359 guard: a fully typed map subtree stays quiet",
    !has(conv({
      type: "object",
      additionalProperties: { type: "object", properties: { x: { type: "string" } }, required: ["x"] }
    }, "anthropic-go"), MARK));
  ok("#359 guard: an ordinary closed object is untouched",
    !has(conv({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, "anthropic-go"), MARK));

  // Pydantic is NOT affected and must not be double-reported: `Dict[str, Model]`
  // routes the value model out to `$defs`, a position walk() already reaches,
  // so the existing typeless blocker owns it. Verbatim pydantic 2.13.4 output
  // for `Dict[str, Inner]` where `Inner.x: Any`.
  var PYD = {
    "$defs": { Inner: { properties: { x: { title: "X" } }, required: ["x"], title: "Inner", type: "object" } },
    properties: { m: { additionalProperties: { $ref: "#/$defs/Inner" }, title: "M", type: "object" } },
    required: ["m"], title: "M1", type: "object"
  };
  ok("#359: the pydantic route is covered by the existing rule, not this one",
    !has(conv(PYD, "anthropic-go"), MARK));
  ok("#359: and it is still reported exactly once, by that rule",
    blockers(conv(PYD, "anthropic-go")) === 1);

  // --- per-target scope, measured not ported (rule 0-bis) -------------------
  // Only Go preserves the map AND recurses into the value. Measured 2026-08-10:
  // the TypeScript and Python `output_format` transformers both return
  // `{"type":"object","properties":{},"additionalProperties":false}` for the
  // destroying shape AND for a typed control -- identical, so they never read
  // the value and there is nothing below to lose. `betaTool` returns both
  // byte-identical. `openai` blocks the open map outright (#329).
  ["anthropic", "anthropic-json", "anthropic-json-python", "openai",
   "openai-nonstrict", "openai-realtime", "gemini", "gemini-json", "gemini-client"].forEach(function (t) {
    ok("#359 scope: " + t + " does not claim the Go-only deep loss",
      !has(conv(ZOD_REC_NEVER, t), MARK));
  });

  // We never strip: the subtree stays in our output so the remedy is
  // actionable (#318), and a second pass says the same thing (idempotent).
  ok("#359: the destroyed node survives our own output",
    (function () {
      var r = conv(ZOD_REC_NEVER, "anthropic-go");
      var ap = r.schema && r.schema.additionalProperties;
      return !!ap && ap.properties && ap.properties.x && ap.properties.x.not !== undefined;
    })());
})();

// --- #360: the OpenAI keyword layer, diffed WHOLE and in BOTH directions ----
// #313's rule is "diff the vendor's WHOLE blocklist, don't spot-check it". That
// had never been executed as a TEST -- the vendor's set lived in a comment
// (#312), which is #351's "verified in prose is not verified" one target over.
//
// Measured 2026-08-10 against openai@7.4.0 `lib/transform.js`, reading the
// three recursion tables and the unsupported set out of the SDK rather than
// guessing. Result was a CLEAN NEGATIVE in both directions, banked here as a
// test (#347's precedent) so a vendor bump or an allowlist edit is detectable:
//
//   forward  28/28 verdict agreement, and all 28 of our converted outputs
//            round-trip ACCEPTED by toStrictJsonSchema (the exit-1 promise --
//            "commit my output" -- actually holds; #330 found it broken once).
//   reverse  of the whole JSON Schema vocabulary, exactly three keywords are
//            PRESERVED by the vendor while absent from our allowlist. Two are
//            owned by dedicated rules and MUST NOT become strips; one is inert.
(function () {
  function conv(s, t) { return E.convert(s, t); }
  function nested(k, v) {
    var n = { type: "object", properties: { a: { type: "string" } },
              required: ["a"], additionalProperties: false };
    n[k] = v;
    return { type: "object", properties: { f: n }, required: ["f"],
             additionalProperties: false };
  }

  // Transcribed from openai@7.4.0's JSON_SCHEMA_UNSUPPORTED_SCHEMA_KEYWORDS,
  // plus `additionalItems` -- which the SDK DESCENDS into and does NOT list,
  // yet still throws on. We agree on it for a different reason than the table
  // gives, so it is pinned separately from the table's own membership.
  var VENDOR_THROWS = {
    "$anchor": "a", "$dynamicAnchor": "a", "$dynamicRef": "#a",
    "$recursiveAnchor": true, "$recursiveRef": "#",
    "allOf": [{ type: "string" }], "contains": { type: "string" },
    "contentEncoding": "base64", "contentMediaType": "text/plain",
    "contentSchema": { type: "string" }, "dependentRequired": { x: ["y"] },
    "dependentSchemas": { x: { type: "object" } }, "dependencies": { x: ["y"] },
    "else": { type: "string" }, "if": { type: "string" },
    "maxContains": 2, "maxProperties": 3, "minContains": 1, "minProperties": 1,
    "not": { type: "string" }, "patternProperties": { "^a": { type: "string" } },
    "prefixItems": [{ type: "string" }], "propertyNames": { type: "string" },
    "then": { type: "string" }, "unevaluatedItems": { type: "string" },
    "unevaluatedProperties": false, "uniqueItems": true,
    "additionalItems": { type: "string" }
  };

  // No silent pass. The assertion is on the LEDGER rather than on the output,
  // because a blocker deliberately LEAVES the keyword visible (#318) while a
  // strip removes it -- keying on absence would pass vacuously for blockers.
  //
  // Sensitivity measured, not assumed (#340): allowlisting all 28 at once makes
  // 24 of these fail. The other four -- `allOf`, `patternProperties`,
  // `prefixItems`, `propertyNames` -- still pass, because a DEDICATED rule
  // reports them independently of the allowlist (#318's conditional allOf,
  // #348's four spellings of a map, #346's tuple). That is two independent
  // guards on one node rather than a vacuous assertion (#359's second
  // corollary: when two rules can reach a node, say which owns it) -- but it
  // does mean these four are pinned by the OTHER rule's tests, not by this one.
  Object.keys(VENDOR_THROWS).forEach(function (k) {
    ok("#360 openai: `" + k + "` is reported, never passed through silently",
      has(conv(nested(k, VENDOR_THROWS[k]), "openai").ledger, k));
  });

  // --- the reverse direction, which is the one that bites --------------------
  // Our OPENAI_SUPPORTED is an ALLOWLIST, so agreeing with the vendor's
  // blocklist is nearly free; the failure mode that actually shipped (#312, ten
  // keywords) is over-stripping something the vendor KEEPS. These two are
  // absent from the allowlist and so LOOK strippable, and are not: each is
  // owned by a dedicated rule that must survive.
  ok("#360 openai: `definitions` is renamed to `$defs`, not stripped (#311)",
    (function () {
      var r = conv({ type: "object", properties: { f: { $ref: "#/definitions/D" } },
        required: ["f"], additionalProperties: false,
        definitions: { D: { type: "object", properties: { a: { type: "string" } },
          required: ["a"] } } }, "openai");
      var d = r.schema && r.schema.$defs;
      return !!(d && d.D && d.D.properties && d.D.properties.a);
    })());

  // #362: this used `nested()`, which hangs the keyword off an OBJECT-shaped
  // node -- the one position where the rewrite is NOT safe, because
  // `{type: "object", ..., anyOf: [...]}` is what openai@7.4.0 throws on. The
  // property #360 meant to pin is strip-vs-rewrite (a strip would silently widen
  // the union), and that is orthogonal to position, so the fixture moves to a
  // bare union node where the rewrite genuinely happens and the vendor accepts
  // the result. The object-shaped position is pinned separately below.
  ok("#360 openai: `oneOf` is rewritten to `anyOf`, not stripped (#318)",
    (function () {
      var r = conv({ type: "object", required: ["f"], additionalProperties: false,
        properties: { f: { oneOf: [{ type: "string" }, { type: "number" }] } } }, "openai");
      var f = r.schema && r.schema.properties && r.schema.properties.f;
      return !!(f && Array.isArray(f.anyOf) && f.anyOf.length === 2 && f.oneOf === undefined);
    })());

  // The ONE measured divergence, recorded as deliberate rather than left to
  // look like an oversight: the vendor PRESERVES `$vocabulary` and we strip it.
  // Not fixed, and the reason is reachability (#346's filter): `$vocabulary` is
  // legal only on a meta-schema, and no generator this project has probed
  // emits one. If that ever changes, this assertion is where to start.
  ok("#360 openai: `$vocabulary` is stripped -- known, deliberate divergence",
    has(conv(nested("$vocabulary", { "https://x": true }), "openai").ledger, "$vocabulary"));
})();

// ---------------------------------------------------------------------------
// #361 — the two Go tables, diffed against the vendor and against MEASURED
// vendor behaviour. Both were transcribed by hand (#332, #358) and neither
// appeared anywhere in this suite, which is #351's tell: a rule derived from a
// vendor artifact that the suite never names is documentation. #360 executed
// that for OpenAI's blocklist; this is the same thing for the target it left.
//
// What makes this diff load-bearing rather than free (#360's corollary): the
// two tables are read TOGETHER to produce a THREE-valued fate, so neither can
// mask the other's error. Wrong in the first table and we promise enforcement
// that is not there; wrong in the second and we call a silent deletion a
// demotion, which is the severity a reader actually acts on.
(function () {
  // Vendor literal 1, transcribed verbatim from `supportedSchemaKeys`
  // (anthropic-sdk-go@v1.62.0, schemautil.go:303). Restated locally rather
  // than iterated off the export, so a missing export fails one assertion
  // instead of aborting the file (#322's trap, hit in #345).
  var VENDOR_GO_SUPPORTED = [
    "$ref", "$defs", "type", "anyOf", "oneOf", "allOf", "description", "title",
    "enum", "const", "properties", "additionalProperties", "required",
    "items", "minItems", "format", "pattern"
  ];

  // Vendor literal 2: every `json:"..."` tag on invopop/jsonschema@v0.14.0's
  // `Schema` struct (schema.go:16-76). `Extras` is tagged `json:"-"` and is
  // deliberately NOT a member — that is the whole mechanism, verified this
  // cycle: `UnmarshalJSON` is a plain alias unmarshal (reflect.go:1094), so
  // Extras is never populated on the way IN and an unmodelled key is gone
  // before Anthropic's transform can demote it.
  var VENDOR_INVOPOP_MODELLED = [
    "$schema", "$id", "$anchor", "$ref", "$dynamicRef", "$defs", "$comment",
    "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "dependentSchemas",
    "prefixItems", "items", "contains", "properties", "patternProperties",
    "additionalProperties", "propertyNames", "type", "enum", "const",
    "multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum",
    "maxLength", "minLength", "pattern", "maxItems", "minItems", "uniqueItems",
    "maxContains", "minContains", "maxProperties", "minProperties", "required",
    "dependentRequired", "format", "contentEncoding", "contentMediaType",
    "contentSchema", "title", "description", "default", "deprecated",
    "readOnly", "writeOnly", "examples"
  ];

  function diff(a, b) {
    var seen = {}, out = [], i;
    for (i = 0; i < b.length; i++) seen[b[i]] = 1;
    for (i = 0; i < a.length; i++) if (!seen[a[i]]) out.push(a[i]);
    return out;
  }
  function arr(v) { return Array.isArray(v) ? v : []; }

  var ours1 = arr(E.ANTHROPIC_GO_SUPPORTED_KEYS);
  var ours2 = arr(E.GO_INVOPOP_MODELLED_KEYS);

  ok("#361 go: our supported-key table is exported as an array",
    Array.isArray(E.ANTHROPIC_GO_SUPPORTED_KEYS) && ours1.length === 17);
  ok("#361 go: our invopop-modelled table is exported as an array",
    Array.isArray(E.GO_INVOPOP_MODELLED_KEYS) && ours2.length === 53);

  // Both directions. The FORWARD direction (vendor -> ours) is the cheap half;
  // the COMPLEMENT (ours -> vendor) is the one that catches a key we invented.
  ok("#361 go: no supported key the vendor lists is missing from our table",
    diff(VENDOR_GO_SUPPORTED, ours1).length === 0);
  ok("#361 go: no key in our table is absent from the vendor's list",
    diff(ours1, VENDOR_GO_SUPPORTED).length === 0);
  ok("#361 go: no invopop field is missing from our modelled table",
    diff(VENDOR_INVOPOP_MODELLED, ours2).length === 0);
  ok("#361 go: no key in our modelled table is absent from invopop's struct",
    diff(ours2, VENDOR_INVOPOP_MODELLED).length === 0);

  // `Extras` is tagged `json:"-"`. If it ever became a modelled member the
  // DROPPED class would collapse into DEMOTED, so pin its absence explicitly.
  ok("#361 go: `Extras` is not a modelled key (it is tagged json:\"-\")",
    ours2.indexOf("Extras") === -1 && ours2.indexOf("extras") === -1);

  // The fate each keyword ACTUALLY met, measured 2026-08-10 by running every
  // row through `anthropic.BetaJSONSchemaOutputFormat` on anthropic-sdk-go
  // @v1.62.0 and reading the output: present verbatim = kept, named in the
  // node's `description` = demoted, gone with no trace = dropped. Two controls
  // are in the table and they discriminate: `description` must be kept and
  // `x-vendor-ext` must be dropped. (My first harness built the param struct
  // instead of calling the helper, and EVERY row including both controls came
  // back "kept" — the control is what caught it.)
  var MEASURED = {
    description: "kept", title: "kept", enum: "kept", const: "kept",
    pattern: "kept", format: "kept", minItems: "kept", required: "kept",

    not: "demoted", if: "demoted", then: "demoted", else: "demoted",
    dependentSchemas: "demoted", prefixItems: "demoted", contains: "demoted",
    patternProperties: "demoted", propertyNames: "demoted",
    multipleOf: "demoted", maximum: "demoted", exclusiveMaximum: "demoted",
    minimum: "demoted", exclusiveMinimum: "demoted", maxLength: "demoted",
    minLength: "demoted", maxItems: "demoted", uniqueItems: "demoted",
    maxContains: "demoted", minContains: "demoted", maxProperties: "demoted",
    minProperties: "demoted", dependentRequired: "demoted",
    contentEncoding: "demoted", contentMediaType: "demoted",
    contentSchema: "demoted", default: "demoted", deprecated: "demoted",
    readOnly: "demoted", writeOnly: "demoted", examples: "demoted",
    $comment: "demoted", $anchor: "demoted", $id: "demoted",
    $schema: "demoted", $dynamicRef: "demoted",

    "x-vendor-ext": "dropped", unevaluatedProperties: "dropped",
    unevaluatedItems: "dropped", additionalItems: "dropped",
    dependencies: "dropped", $vocabulary: "dropped",
    $dynamicAnchor: "dropped", definitions: "dropped",
    discriminator: "dropped"
  };

  function fateFromTables(k) {
    if (ours1.indexOf(k) !== -1) return "kept";
    if (ours2.indexOf(k) !== -1) return "demoted";
    return "dropped";
  }

  var mismatched = [], kinds = {}, n = 0;
  for (var k in MEASURED) {
    if (!Object.prototype.hasOwnProperty.call(MEASURED, k)) continue;
    n++;
    kinds[MEASURED[k]] = 1;
    if (fateFromTables(k) !== MEASURED[k]) mismatched.push(k);
  }

  // Guard against a vacuous pass (#340): the oracle must be non-trivial and
  // must exercise all three branches, or "0 mismatches" proves nothing.
  ok("#361 go: the measured oracle is non-trivial and covers all three fates",
    n === 53 && kinds.kept && kinds.demoted && kinds.dropped);
  ok("#361 go: our two tables predict the vendor's fate for all 53 keywords",
    mismatched.length === 0);

  // Scope, stated rather than implied: 9 of the 17 supported keys ($ref, $defs,
  // type, anyOf, oneOf, allOf, properties, additionalProperties, items) are
  // structural and are not probed as a leaf-node keyword here; they are
  // exercised by the conversion tests above. This table covers the other 8 plus
  // every unsupported keyword.
  ok("#361 go: the fate table omits exactly the 9 structural supported keys",
    diff(VENDOR_GO_SUPPORTED, Object.keys(MEASURED)).length === 9);

  // The two VALUE-level rules in `anthropicGoRecognises`, which a keyword-level
  // table cannot test. My own battery used `minItems: 1` -- the one value the
  // rule special-cases -- so it passed either way (#323's pattern, in my own
  // probe). These rows discriminate. Vendor: schemautil.go's array branch
  // demotes minItems unless *s.MinItems is 0 or 1, and its string branch
  // demotes `format` only when the node's type is "string".
  function conv361(sch) { return E.convert(JSON.stringify(sch), "anthropic-go"); }
  function arrWith(min) {
    return { type: "object", required: ["f"], additionalProperties: false,
             properties: { f: { type: "array", items: { type: "string" }, minItems: min } } };
  }
  function fmt(t, f) {
    return { type: "object", required: ["f"], additionalProperties: false,
             properties: { f: { type: t, format: f } } };
  }
  ok("#361 go: minItems 0 is kept (vendor keeps it) -- no advisory",
    !has(conv361(arrWith(0)).ledger, "minItems"));
  ok("#361 go: minItems 1 is kept (vendor keeps it) -- no advisory",
    !has(conv361(arrWith(1)).ledger, "minItems"));
  ok("#361 go: minItems 2 is demoted (vendor demotes it) -- advisory",
    has(conv361(arrWith(2)).ledger, "minItems"));
  ok("#361 go: minItems 3 is demoted (vendor demotes it) -- advisory",
    has(conv361(arrWith(3)).ledger, "minItems"));
  ok("#361 go: a supported format on a string node is kept -- no advisory",
    !has(conv361(fmt("string", "email")).ledger, "format"));
  ok("#361 go: an unsupported format on a string node is demoted -- advisory",
    has(conv361(fmt("string", "frobnicate")).ledger, "format"));
  ok("#361 go: an unsupported format on a NON-string node is kept -- no advisory",
    !has(conv361(fmt("integer", "frobnicate")).ledger, "format"));

  // `oneOf` is IN supportedSchemaKeys, so the fate table says "kept" -- and the
  // vendor still does not leave it alone. `transformSchema` copies oneOf into
  // anyOf only when anyOf is empty, then clears oneOf UNCONDITIONALLY. So the
  // keyword survives as a rewrite in one case and is deleted outright in the
  // other, and both were measured this cycle. This is why the fate table is a
  // claim about the KEY and not about the constraint.
  var A = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
  var B = { type: "object", properties: { b: { type: "integer" } }, required: ["b"], additionalProperties: false };
  var C = { type: "object", properties: { c: { type: "boolean" } }, required: ["c"], additionalProperties: false };
  ok("#361 go: a lone `oneOf` is reported as the rewrite the vendor performs",
    has(conv361({ oneOf: [A, B] }).ledger, "oneOf"));
  ok("#361 go: `anyOf` + `oneOf` siblings are reported as a silent discard",
    has(conv361({ anyOf: [A, B], oneOf: [C] }).ledger, "DISCARDS"));
})();

// ---------------------------------------------------------------------------
// #362 -- a union keyword's SPELLING and its node's SHAPE both decide whether
// the `oneOf` -> `anyOf` rewrite is safe, and neither was being read.
//
// Found by a property nobody had run: is OUR OUTPUT a FIXED POINT of the vendor
// transform? Over the captured corpus (494 inputs) two `--to openai` rows came
// back with the vendor REJECTING what we hand the user while `--check` exited 1
// ("commit my output") -- the #330 class. Both are pinned here.
// ---------------------------------------------------------------------------
(function () {
  var engine = require("./engine.js");
  function conv(sch, p) { return engine.convert(JSON.parse(JSON.stringify(sch)), p); }
  function blockers(r) {
    return (r.ledger || []).filter(function (l) { return l.op === "!" && !l.advisory; });
  }
  function blocked(sch, p) { var r = conv(sch, p); return !r.ok || blockers(r).length > 0; }
  var OBJ = function (k, t) {
    return { type: "object", properties: (function () { var o = {}; o[k] = { type: t }; return o; })(),
             required: [k], additionalProperties: false };
  };
  var wrap = function (n) {
    return { type: "object", properties: { f: n }, required: ["f"], additionalProperties: false };
  };

  // --- (1) THE ROOT UNION, BOTH SPELLINGS -------------------------------
  // The blocker read `if (s.anyOf)` and runs BEFORE the walk, where `oneOf`
  // becomes `anyOf` -- so the walk manufactured the very root this rule exists
  // to catch. Measured on openai@7.4.0: both spellings throw, by different
  // messages, so there is no root form of a union.
  ok("#362 openai: a root `anyOf` union is still a blocker",
    blocked({ anyOf: [OBJ("a", "string"), OBJ("b", "integer")] }, "openai"));
  ok("#362 openai: a root `oneOf` union is a blocker TOO (was exit 1, vendor rejected our output)",
    blocked({ oneOf: [OBJ("a", "string"), OBJ("b", "integer")] }, "openai"));
  ok("#362 openai: the root-union blocker names the spelling the caller wrote",
    has(conv({ oneOf: [OBJ("a", "string"), OBJ("b", "integer")] }, "openai").ledger, "cannot use `oneOf`"));

  // Reachability, verbatim from pydantic 2.13.4 (#311's rule -- real generator
  // output, not a hand-written fixture). These two models differ by exactly
  // `Field(discriminator="kind")`, which is the RECOMMENDED, more precise form,
  // and it was the one that broke: plain -> root `anyOf` (blocked, correct),
  // discriminated -> root `oneOf` (exit 1, output rejected by the vendor).
  var PYD_DEFS = {
    Cat: { type: "object", title: "Cat", required: ["kind", "meows"],
      properties: { kind: { const: "cat", type: "string", title: "Kind" },
                    meows: { type: "integer", title: "Meows" } } },
    Dog: { type: "object", title: "Dog", required: ["kind", "barks"],
      properties: { kind: { const: "dog", type: "string", title: "Dog" },
                    barks: { type: "integer", title: "Barks" } } }
  };
  ok("#362 openai: pydantic `RootModel[Union[A,B]]` (root anyOf) blocks",
    blocked({ $defs: PYD_DEFS, title: "PlainRoot",
      anyOf: [{ $ref: "#/$defs/Cat" }, { $ref: "#/$defs/Dog" }] }, "openai"));
  ok("#362 openai: the same union with `Field(discriminator=...)` (root oneOf) blocks",
    blocked({ $defs: PYD_DEFS, title: "PetRoot",
      discriminator: { propertyName: "kind", mapping: { cat: "#/$defs/Cat", dog: "#/$defs/Dog" } },
      oneOf: [{ $ref: "#/$defs/Cat" }, { $ref: "#/$defs/Dog" }] }, "openai"));

  // --- (2) COMBINATOR BESIDE OBJECT SHAPE -------------------------------
  // `{type: "object", ..., anyOf: [...]}` is refused by openai@7.4.0. The raw
  // `oneOf` form is ACCEPTED VERBATIM, so rewriting it took a schema the vendor
  // accepts and produced one it rejects -- worse than a fix that does not fix.
  var objOneOf = wrap(mix(OBJ("a", "string"), { oneOf: [{ type: "string" }, { type: "number" }] }));
  var objAnyOf = wrap(mix(OBJ("a", "string"), { anyOf: [{ type: "string" }, { type: "number" }] }));
  function mix(a, b) {
    var o = JSON.parse(JSON.stringify(a));
    Object.keys(b).forEach(function (k) { o[k] = b[k]; });
    return o;
  }
  ok("#362 openai: `oneOf` on an object-shaped node is NOT rewritten (the rewrite is what breaks it)",
    (function () {
      var f = conv(objOneOf, "openai").schema.properties.f;
      return Array.isArray(f.oneOf) && f.anyOf === undefined;
    })());
  ok("#362 openai: ...and it is advisory, so it cannot fail a gate the vendor would pass",
    !blocked(objOneOf, "openai"));
  ok("#362 openai: ...and the note names the helper family that DOES throw",
    has(conv(objOneOf, "openai").ledger, "standard-schema"));
  ok("#362 openai: an object-shaped node already carrying `anyOf` is a blocker",
    blocked(objAnyOf, "openai"));

  // --- OVER-BLOCK GUARDS ------------------------------------------------
  // Being stricter than the vendor is this project's most repeated bug, and the
  // first draft of this rule over-blocked 26 corpus schemas the vendor accepts
  // -- it reported "throws" for nodes with NO union at all. This is the control
  // that catches that, and it has to sit in the position under test: my first
  // control's nested property was a scalar, so it passed while the rule was
  // firing on every ordinary nested object.
  ok("#362 openai GUARD: an ordinary NESTED object schema is not blocked",
    !blocked(wrap(OBJ("a", "string")), "openai"));
  ok("#362 openai GUARD: a bare union at a property is still rewritten to `anyOf`",
    (function () {
      var f = conv(wrap({ oneOf: [{ type: "string" }, { type: "number" }] }), "openai").schema.properties.f;
      return Array.isArray(f.anyOf) && f.oneOf === undefined;
    })());
  // The vendor's own escape hatch, mirrored clause for clause: a bare
  // `{type: "object"}` wrapper with no object keywords of its own and none but
  // object-only branches is ACCEPTED (the vendor deletes the redundant `type`).
  // Blanket-blocking object+anyOf would have been over-strict here.
  ok("#362 openai GUARD: the vendor's wrapper escape hatch is not blocked",
    !blocked(wrap({ type: "object", anyOf: [OBJ("a", "string"), OBJ("b", "integer")] }), "openai"));
  // ...and not blocking it is not enough: our own `additionalProperties: false`
  // rule would CLOSE the hatch, because that is an object keyword. Two correct
  // edits composing into a rejection (#348). We drop the redundant `type` the
  // way the vendor does, so the node stays acceptable.
  ok("#362 openai: the wrapper's redundant `type` is dropped, so the hatch survives our own close",
    (function () {
      var f = conv(wrap({ type: "object", anyOf: [OBJ("a", "string"), OBJ("b", "integer")] }),
        "openai").schema.properties.f;
      return f.type === undefined && Array.isArray(f.anyOf) && f.anyOf.length === 2 &&
        f.additionalProperties === undefined;
    })());
  ok("#362 openai GUARD: ...but adding an object keyword to that wrapper IS blocked",
    blocked(wrap({ type: "object", additionalProperties: false,
      anyOf: [OBJ("a", "string"), OBJ("b", "integer")] }), "openai"));
  ok("#362 openai GUARD: ...and so is a wrapper with a non-object branch",
    blocked(wrap({ type: "object", anyOf: [OBJ("a", "string"), { type: "string" }] }), "openai"));

  // --- PER-TARGET SCOPE, MEASURED NOT PORTED (rule 0-bis) ---------------
  // All three break rows were `--to openai` only. Anthropic ACCEPTS every one of
  // these shapes -- raw and converted, on both the tools and output_format paths
  // -- so firing there would be the over-strictness class again.
  ["anthropic", "anthropic-json", "anthropic-json-python", "anthropic-go"].forEach(function (t) {
    ok("#362 " + t + ": an object-shaped node with `anyOf` is NOT blocked (vendor accepts it)",
      !blocked(objAnyOf, t));
    ok("#362 " + t + ": a root `oneOf` union is NOT blocked by openai's root rule",
      !blocked({ oneOf: [OBJ("a", "string"), OBJ("b", "integer")] }, t));
  });
})();

// --- #363: a rule that reads a keyword cannot see one a LATER rewrite invents ---
//
// The single-member `allOf` flatten copies the member's keys UP into the node.
// Both root blockers and `resolveRefSiblings`/`inlineRootRef` run BEFORE the walk
// that does it, so the converter manufactured, after its own checks had passed,
// exactly the shapes those checks exist to catch. Seven routes measured against
// openai@7.4.0's toStrictJsonSchema(): five where our output was REJECTED with
// zero blockers reported (#330's invariant break), one nested `$ref`-beside-a-
// constraint, and one OVER-block where the vendor accepts and we refused.
// Fixed on the OUTPUT rather than by adding spellings to the entry side (#342,
// #352): keyed on the outcome, so a rewrite added later cannot slip past it.
(function () {
  function conv(schema) { return E.toOpenAI(JSON.parse(JSON.stringify(schema))); }
  function blk(r) {
    return (r.ledger || []).filter(function (l) { return l.op === "!" && !l.advisory; });
  }
  function blkAt(r, path) {
    return blk(r).filter(function (l) { return l.path === path; });
  }
  // Never dereference [0].msg directly: with engine.js reverted there is no
  // blocker, and a raw [0].msg aborts the whole FILE instead of reporting these
  // as failures (#322's trap, hit here in my own tests).
  function msgAt(r, path) {
    var hits = blkAt(r, path);
    return hits.length ? hits[0].msg : "";
  }
  var OBJ = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
  var OBJ2 = { type: "object", properties: { b: { type: "string" } }, required: ["b"], additionalProperties: false };

  // ---- the five manufactured ROOTS -------------------------------------------
  // Each is a root the CALLER never wrote: the flatten hoisted the member's
  // `type`/`anyOf` up. The vendor rejects all five (its own transformer performs
  // the same flatten, which is why the raw input is rejected too).
  var scalarRoot = conv({ allOf: [{ type: "string", minLength: 3 }] });
  ok("#363 a flattened scalar member makes the ROOT non-object, and that is blocked",
    blkAt(scalarRoot, "root").length === 1);
  ok("#363 ...and the message says the caller did not write that root",
    /did not write/.test(msgAt(scalarRoot, "root")));
  ok("#363 ...and names the flatten as the source",
    /single-member `allOf`/.test(msgAt(scalarRoot, "root")));

  ok("#363 a flattened array member makes the ROOT non-object, and that is blocked",
    blkAt(conv({ allOf: [{ type: "array", items: { type: "string" } }] }), "root").length === 1);

  // `anyOf` and `oneOf` both land here, and the `oneOf` route is two rewrites
  // deep: the flatten lifts `oneOf` to the root, then the walk's oneOf->anyOf
  // rewrite turns it into the very `anyOf` root #362's blocker exists to catch.
  ok("#363 a flattened `anyOf` member makes the ROOT a bare union, and that is blocked",
    blkAt(conv({ allOf: [{ anyOf: [OBJ, OBJ2] }] }), "root").length === 1);
  ok("#363 a flattened `oneOf` member is rewritten to a root `anyOf`, and that is blocked",
    blkAt(conv({ allOf: [{ oneOf: [OBJ, OBJ2] }] }), "root").length === 1);
  ok("#363 ...and the union case says `anyOf`, not a type",
    /bare `anyOf` union/.test(msgAt(conv({ allOf: [{ anyOf: [OBJ, OBJ2] }] }), "root")));

  // An object-shaped node whose member is a scalar: the flatten leaves BOTH
  // `properties` and `type:"string"` on one node. The vendor throws.
  ok("#363 a scalar member flattened onto an object-shaped node is blocked",
    blkAt(conv({ properties: { a: { type: "string" } }, allOf: [{ type: "string" }] }), "root").length === 1);

  // ---- the nested `$ref` route, and its at-entry twin -------------------------
  // The sharpest row: the SAME schema one `allOf` wrapper apart. Written directly
  // the `$ref` is inlined and the result is accepted; wrapped, the flatten hoists
  // it AFTER the inliner has run and the constraint shipped broken.
  var wrapped = conv({
    type: "object", properties: { c: { minLength: 3, allOf: [{ $ref: "#/$defs/S" }] } },
    required: ["c"], additionalProperties: false, $defs: { S: { type: "string" } }
  });
  ok("#363 a `$ref` hoisted next to a constraint is blocked",
    blkAt(wrapped, "root.c").length === 1);
  ok("#363 ...naming the offending sibling",
    /`minLength`/.test(msgAt(wrapped, "root.c")));
  ok("#363 ...and pointing at the shape we DO repair",
    /WITHOUT the `allOf` wrapper/.test(msgAt(wrapped, "root.c")));

  var direct = conv({
    type: "object", properties: { c: { minLength: 3, $ref: "#/$defs/S" } },
    required: ["c"], additionalProperties: false, $defs: { S: { type: "string" } }
  });
  ok("#363 GUARD the at-entry twin is still REPAIRED, not blocked",
    blk(direct).length === 0 &&
    direct.schema.properties.c.type === "string" &&
    direct.schema.properties.c.minLength === 3 &&
    direct.schema.properties.c.$ref === undefined);

  // ---- the OVER-block, which is the same ordering bug pointing the other way --
  // The flatten hoists a bare `$ref` to the root, where `inlineRootRef` has
  // already been and gone; we then called it "nothing left to inline" and blocked
  // a schema the vendor ACCEPTS (it resolves the root chain). Re-running the root
  // inliner at the exit is what fixes it.
  var hoisted = conv({
    allOf: [{ $ref: "#/$defs/S" }],
    $defs: { S: { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false } }
  });
  ok("#363 a bare `$ref` hoisted to the root is INLINED, not blocked",
    blk(hoisted).length === 0 && hoisted.schema.type === "object" &&
    hoisted.schema.properties && hoisted.schema.properties.a !== undefined);

  // ---- over-block guards: shapes the vendor accepts must stay quiet -----------
  // The pydantic v1 described-field shape is the one that matters most: its
  // siblings are ANNOTATIONS, the vendor tolerates a `$ref` beside them, and an
  // earlier draft of this fix inlined it -- expanding the document against
  // OpenAI's 5000-property budget for no benefit. An existing #349 test caught
  // that, and the test was right.
  var pyd1 = conv({
    title: "R", type: "object",
    properties: { c: { description: "d", allOf: [{ $ref: "#/definitions/Color" }] } },
    required: ["c"], definitions: { Color: { enum: ["red", "blue"], type: "string" } }
  });
  ok("#363 GUARD the pydantic v1 annotation+allOf+$ref shape is not blocked",
    blk(pyd1).length === 0);
  ok("#363 GUARD ...and it stays a `$ref`, not an inlined copy",
    pyd1.schema.properties.c.$ref === "#/$defs/Color" &&
    pyd1.schema.properties.c.description === "d");

  ok("#363 GUARD an ordinary closed object is untouched and unblocked",
    blk(conv(OBJ)).length === 0);
  ok("#363 GUARD a root `$ref` written at entry is still inlined, not blocked",
    blk(conv({ $ref: "#/$defs/S", $defs: { S: JSON.parse(JSON.stringify(OBJ)) } })).length === 0);
  ok("#363 GUARD a single-member object `allOf` still merges cleanly",
    blk(conv({ allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }] })).length === 0);

  // ---- the root blockers must not DOUBLE-report -------------------------------
  // Two rules can now reach the root (entry-side, which knows what the caller
  // wrote, and exit-side, which knows what we produced). The boundary between
  // them is part of the design (#359), so a caller-written bad root gets exactly
  // one blocker, from the rule that can attribute it.
  ok("#363 a caller-written scalar root is reported ONCE",
    blkAt(conv({ type: "string" }), "root").length === 1);
  ok("#363 a caller-written `anyOf` root is reported ONCE",
    blkAt(conv({ anyOf: [OBJ, OBJ2] }), "root").length === 1);
  ok("#363 ...and that one still names the spelling the caller wrote (#362)",
    /`oneOf`/.test(msgAt(conv({ oneOf: [OBJ, OBJ2] }), "root")));

  // ---- the vendor's annotation set, pinned -----------------------------------
  // Transcribed from `JSON_SCHEMA_ANNOTATION_KEYWORDS` (openai@7.4.0). The suite
  // is dependency-free and cannot run the vendor, so this pins a MEASURED
  // SNAPSHOT and re-measuring after a version bump is a manual step (#361).
  // `deprecated` is deliberately absent and `readOnly`/`writeOnly` deliberately
  // present -- both measured, both the opposite of what the names suggest.
  // guarded so a reverted engine.js REPORTS these as failures rather than
  // aborting the whole file on a TypeError (#322's trap).
  var ann = E.OPENAI_ANNOTATION_KEYWORDS_LIST || [];
  ok("#363 the annotation set has exactly 7 members", ann.length === 7);
  ["$comment", "default", "description", "examples", "readOnly", "title", "writeOnly"]
    .forEach(function (k) {
      ok("#363 annotation set contains `" + k + "`", ann.indexOf(k) !== -1);
    });
  ok("#363 annotation set does NOT contain `deprecated` (vendor throws on it)",
    ann.indexOf("deprecated") === -1);

  // A `$defs`/`definitions` bag is not a constraining sibling -- the vendor says
  // so in its own comment, and treating it as one turned its happiest case into a
  // blocker in an earlier draft of this very fix.
  ok("#363 a `$defs` bag beside a `$ref` is not treated as a constraint",
    blk(conv({ type: "object", properties: { c: { $ref: "#/$defs/S" } }, required: ["c"], additionalProperties: false, $defs: { S: { type: "string" } } })).length === 0);
})();


// --- #364: the gemini-json remedy is a claim about GEMINI, not about the client
// The note tells the reader to switch to the narrow `responseSchema` path to get
// a keyword enforced. That is true of Gemini and false of the dominant JS client:
// @ai-sdk/google rebuilds the narrow request from a fixed 12-keyword destructure,
// so 6 of the 7 keywords the remedy names never reach Gemini at all.
// Fates measured against the real wire payload on @ai-sdk/google 4.0.39.
(function () {
  function conv(node) {
    return E.convert({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object", properties: { f: JSON.parse(JSON.stringify(node)) },
      required: ["f"]
    }, "gemini-json");
  }
  function led(r) { return (r && Array.isArray(r.ledger)) ? r.ledger : []; }
  var FORK = "NOT ABOUT WHAT YOUR CLIENT SENDS";
  var SURVIVES = "That switch does survive a converting client";

  // The six that are DROPPED by the converter must carry the warning...
  [["pattern", { type: "string", pattern: "^x" }],
   ["maxLength", { type: "string", maxLength: 9 }],
   ["minProperties", { type: "object", properties: { a: { type: "string" } }, minProperties: 1 }],
   ["maxProperties", { type: "object", properties: { a: { type: "string" } }, maxProperties: 2 }],
   ["default", { type: "string", default: "d" }],
   ["example", { type: "string", example: "e" }]].forEach(function (row) {
    var l = led(conv(row[1]));
    ok("#364 `" + row[0] + "` remedy names the converting-client fork", has(l, FORK));
    ok("#364 `" + row[0] + "` fork is not the survives-wording", !has(l, SURVIVES));
  });

  // ...and `minLength` must carry the OPPOSITE wording. This is the whole
  // discriminator: without it the rule could be firing blanket and every
  // assertion above would still pass (#323's pass-either-way pattern).
  var ml = led(conv({ type: "string", minLength: 3 }));
  ok("#364 `minLength` says the switch DOES survive the client", has(ml, SURVIVES));
  ok("#364 `minLength` does NOT carry the drop warning", !has(ml, FORK));

  // Over-block guard: a keyword the narrow path does not enforce either has no
  // path-switch to qualify, so the clause must stay silent rather than attach
  // itself to every unsupported keyword.
  var uq = led(conv({ type: "array", items: { type: "string" }, uniqueItems: true }));
  ok("#364 `uniqueItems` note is present at all", has(uq, "Kept `uniqueItems`"));
  ok("#364 `uniqueItems` does not get the converting-client clause",
    !has(uq, FORK) && !has(uq, SURVIVES));

  // #317: this is an advisory about a schema the path ACCEPTS. It must never
  // fail the gate, however alarming the wording is.
  var pat = conv({ type: "string", pattern: "^x" });
  ok("#364 the fork never turns into a gate failure",
    pat.ok === true && led(pat).filter(function (e) { return e.op === "!" && !e.advisory; }).length === 0);

  // The root summary makes the same promise and needs the same qualification.
  ok("#364 the `$schema` root note qualifies its own path-switch claim",
    has(led(conv({ type: "string", pattern: "^x" })), "if you get there through"));

  // The vendor table itself, pinned. 12 keys, and the two that decide every
  // row above must be on the correct sides.
  // Guarded: an engine without this export must make these REPORT, not crash.
  // An unguarded `.length` here aborts the whole file and hides every assertion
  // after it, which is exactly what makes a revert-check unreadable (#322).
  var FWD = Array.isArray(E.AI_SDK_GOOGLE_FORWARDED_KEYS) ? E.AI_SDK_GOOGLE_FORWARDED_KEYS : null;
  ok("#364 AI_SDK_GOOGLE_FORWARDED_KEYS has the 12 destructured keys",
    !!FWD && FWD.length === 12);
  ok("#364 the table forwards `minLength` and not `pattern`",
    !!FWD && FWD.indexOf("minLength") !== -1 && FWD.indexOf("pattern") === -1);
  ok("#364 the table drops every other length/range keyword",
    !!FWD && ["maxLength", "minimum", "maximum", "minItems", "maxItems", "minProperties",
     "maxProperties", "default", "example"].every(function (k) {
      return FWD.indexOf(k) === -1;
    }));
})();


// --- #366 `strict` unset does not mean the same thing on every surface -------
// `openai-nonstrict` is named for a CONDITION, and #322 read that condition's
// meaning off some of the surfaces that share it. The output is byte-identical
// on all of them (the schema is legal either way), so what is under test here is
// the DIAGNOSIS, which is this target's entire deliverable.
(function () {
  var SCH = {
    type: "object", additionalProperties: false,
    properties: { a: { type: "string" } }, required: ["a"]
  };
  var loose = E.convert(SCH, "openai-nonstrict");
  var rt = E.convert(SCH, "openai-realtime");

  // The claim that used to be unconditional is now scoped to the surfaces where
  // it is true, and says which those are.
  ok("#366 the not-enforced claim is scoped to named surfaces",
    has(loose.ledger, "chat.completions tools[].function") &&
    has(loose.ledger, "not grammar-constrained"));

  // The group that made the old wording false. Quote, not paraphrase.
  ok("#366 the AUTO surfaces are named",
    has(loose.ledger, "responses namespace tools"));
  ok("#366 ...with the vendor's own wording",
    has(loose.ledger, "falls back to non-strict validation otherwise"));
  ok("#366 ...and the fallback is called out as SILENT",
    has(loose.ledger, "SILENT"));
  ok("#366 `strict` unset is not treated as non-strict everywhere",
    has(loose.ledger, "NOT non-strict everywhere"));

  // The two REQUIRED sites: there is no omitted state to be in.
  ok("#366 the required-field surfaces are named",
    has(loose.ledger, "responses tools[] function") &&
    has(loose.ledger, "the field is required"));

  // Deliberately does NOT predict the branch — measured, our ledger ops are not
  // a sound proxy for the vendor's compatibility test. Pin that it points at the
  // check instead of guessing, so a later cycle does not quietly add a guess.
  ok("#366 the branch is not predicted, the check is named",
    has(loose.ledger, "run `--to openai`") &&
    has(loose.ledger, "not something this tool can see from the schema"));

  // THE DISCRIMINATOR. Realtime has no `strict` field at all, so there is no
  // omitted-vs-set distinction and the categorical claim is correct there.
  // Without this pair the new rule could be firing blanket and every assertion
  // above would still pass (#364's pattern).
  ok("#366 Realtime keeps the categorical claim",
    has(rt.ledger, "Without `strict`, the model is not grammar-constrained"));
  ok("#366 Realtime does NOT get the AUTO clause",
    !has(rt.ledger, "NOT non-strict everywhere") &&
    !has(rt.ledger, "falls back to non-strict validation otherwise"));
  ok("#366 ...and is not told about a required-field surface",
    !has(rt.ledger, "the field is required"));

  // #317's property: advisory, never a gate failure. The schema is accepted on
  // every one of these surfaces, so failing CI here would be the exact mistake.
  ok("#366 none of the new entries fails the gate",
    loose.ledger.filter(function (l) { return l.op === "!" && !l.advisory; }).length === 0);

  // The remedy no longer tells a namespace-tool caller to make an edit that may
  // be unnecessary; it says what setting the flag actually buys them.
  ok("#366 the remedy is qualified for namespace tools",
    has(loose.ledger, "that edit may be unnecessary") &&
    has(loose.ledger, "silent fallback into a loud rejection"));

  // The table itself, so the grouping is re-diffable rather than re-derived.
  var T = E.OPENAI_STRICT_SURFACES;
  ok("#366 the surface table has all eight measured sites",
    Array.isArray(T) && T.length === 8);
  var by = function (k) {
    return (T || []).filter(function (s) { return s.unset === k; }).length;
  };
  ok("#366 the table splits 4 off / 2 auto / 2 required",
    by("off") === 4 && by("auto") === 2 && by("required") === 2);
  ok("#366 every entry cites a file and a line",
    Array.isArray(T) && T.length > 0 && T.every(function (s) {
      return typeof s.file === "string" && s.file.length > 0 &&
             typeof s.line === "number" && s.line > 0;
    }));
  // The AUTO rows are the finding; pin WHICH interfaces they are, since a table
  // that merely has two auto rows would pass the count check above.
  ok("#366 the AUTO rows are the namespace-tool interfaces",
    Array.isArray(T) && ["NamespaceTool.Function", "BetaNamespaceTool.Function"]
      .every(function (p) {
        return T.some(function (s) { return s.path === p && s.unset === "auto"; });
      }));
  // ...and that a STABLE surface is among them. "It is only beta" would make the
  // whole finding much weaker, so assert it is not.
  ok("#366 at least one AUTO surface is not beta",
    Array.isArray(T) && T.some(function (s) {
      return s.unset === "auto" && s.file.indexOf("beta") === -1;
    }));

  // Over-block guard: the pass-through contract is untouched by all of this.
  ok("#366 the schema still passes through byte-identical",
    JSON.stringify(loose.schema) === JSON.stringify(SCH) &&
    JSON.stringify(rt.schema) === JSON.stringify(SCH));
})();


// ---------------------------------------------------------------------------
// #367 — `anthropic-json` is named for a CONDITION ("the structured-output
// path") and that condition does NOT decide whether Anthropic's demote-to-prose
// transform runs. Measured 2026-08-10: TS calls it from HELPERS ONLY (four call
// sites, two accepting `{transform:false}`), and Python guards it behind
// `if is_dict(output_format)` while the RECOMMENDED `output_config.format`
// parameter never transforms at all.
// ---------------------------------------------------------------------------
(function () {
  function led(r, sub) {
    return (r.ledger || []).some(function (l) { return String(l.msg || "").indexOf(sub) !== -1; });
  }
  var SCH = {
    type: "object",
    properties: { code: { type: "string", pattern: "^[A-Z]{3}$", minLength: 3 } },
    required: ["code"]
  };
  var cp = function () { return JSON.parse(JSON.stringify(SCH)); };

  // Guarded: with engine.js reverted this export does not exist, and an
  // unguarded `.some()` on undefined aborts the whole file, hiding every
  // assertion after it (#322's trap). A missing table must REPORT as failures.
  var T = Array.isArray(E.ANTHROPIC_TRANSFORM_SURFACES) ? E.ANTHROPIC_TRANSFORM_SURFACES : [];
  ok("#367 ANTHROPIC_TRANSFORM_SURFACES is exported",
    Array.isArray(E.ANTHROPIC_TRANSFORM_SURFACES) && T.length === 10);
  // Guard against a vacuous table: BOTH verdicts must be present, or an
  // all-true/all-false list would satisfy every assertion below (#340).
  ok("#367 the table carries both verdicts",
    T.some(function (r) { return r.transforms; }) &&
    T.some(function (r) { return !r.transforms; }));
  ok("#367 both languages are represented",
    T.some(function (r) { return r.lang === "ts"; }) &&
    T.some(function (r) { return r.lang === "py"; }));
  // The finding in one row: the parameter the SDK's own DeprecationWarning
  // points at does NOT transform.
  ok("#367 the recommended python parameter does not transform",
    T.some(function (r) {
      return r.lang === "py" && r.form.indexOf("output_config") !== -1 && r.transforms === false;
    }));
  ok("#367 exactly one python form transforms, and it is the deprecated one",
    T.filter(function (r) { return r.lang === "py" && r.transforms; }).length === 1 &&
    T.filter(function (r) { return r.lang === "py" && r.transforms; })[0].form.indexOf("deprecated") !== -1);
  ok("#367 the TS opt-out rows are the two json-schema helpers",
    T.filter(function (r) { return r.lang === "ts" && !r.transforms; }).length === 3);
  ok("#367 every row names a concrete call form", T.every(function (r) {
    return typeof r.form === "string" && r.form.length > 8 && typeof r.transforms === "boolean";
  }));

  var js = E.toAnthropic(cp(), true, "js");
  var py = E.toAnthropic(cp(), true, "python");
  var go = E.toAnthropic(cp(), true, "go");
  var tools = E.toAnthropic(cp(), false);

  ok("#367 the JS target says the demotion is conditional",
    led(js, "conditional on how you hand the schema over"));
  ok("#367 the JS target names the helper-only call sites and the opt-out",
    led(js, "four call sites and all four are HELPERS") && led(js, "{ transform: false }"));
  ok("#367 the JS target names the inline no-helper escape",
    led(js, "inline `{ type: \"json_schema\", schema }`"));
  ok("#367 the python target says the demotion is conditional",
    led(py, "conditional on how you hand the schema over"));
  ok("#367 the python target names the is_dict guard and output_config",
    led(py, "if is_dict(output_format)") && led(py, "output_config"));
  ok("#367 the python target names the deprecation direction",
    led(py, "DeprecationWarning"));
  // The two SDKs must give DIFFERENT explanations — a single generalised
  // sentence would satisfy every assertion above.
  ok("#367 the two SDKs' conditions genuinely differ",
    !led(js, "if is_dict(output_format)") && !led(py, "four call sites and all four are HELPERS"));
  // THE DISCRIMINATOR (#366's Realtime pair): Go has no non-transforming form,
  // so it must KEEP the categorical claim. Without this row the rule could be
  // firing blanket and everything above would still pass.
  // (`pattern` is in Go's `supportedSchemaKeys`, so the demoted keyword here is
  // `minLength`, reported via #361's formatExtraValue path — the categorical
  // wording is "enforced by the Go SDK", not the structured-output phrasing.)
  ok("#367 Go keeps the categorical claim and gets NO condition clause",
    !led(go, "conditional on how you hand the schema over") &&
    led(go, "enforced by the Go SDK"));
  ok("#367 the tools path gets no condition clause either",
    !led(tools, "conditional on how you hand the schema over"));

  // Advisory only, on every target: the request is accepted either way, so a
  // gate failure here would be #317's exact mistake.
  [js, py, go].forEach(function (r) {
    ok("#367 the condition never becomes a gate failure",
      (r.ledger || []).every(function (l) {
        return l.msg.indexOf("conditional on how you hand") === -1 || l.advisory === true;
      }));
  });
  // The document is untouched on this path, so the ledger IS the deliverable.
  ok("#367 the schema still passes through with the keywords kept",
    js.schema.properties.code.pattern === "^[A-Z]{3}$" &&
    js.schema.properties.code.minLength === 3);
})();


// ---------------------------------------------------------------------------
// #368 — a forwarding client is not a converting one.
//
// `--to gemini-client` is named for a CLASS. #365 measured two members and said
// so in the shipped table. Measuring the three members #365/#366 recorded by
// name found a SECOND axis on which the class has NO intersection form: three
// clients rewrite `type:["X","null"]` into `nullable` themselves (and drop a
// hand-written `nullable`), one takes either, and one FORWARDS the union
// verbatim into `responseSchema`, where the proto rejects it outright.
// ---------------------------------------------------------------------------
(function () {
  // A guarded read, so a missing export reports rather than aborting the file
  // (#322's trap — an unguarded property access kills every assertion after it).
  var MEMBERS = (E && Array.isArray(E.GEMINI_CLIENT_MEMBERS)) ? E.GEMINI_CLIENT_MEMBERS : [];
  var byForm = function (f) {
    return MEMBERS.filter(function (m) { return m.nullForm === f; })
      .map(function (m) { return m.client; });
  };

  ok("#368 the member table is exported and has all five measured clients",
    MEMBERS.length === 5);
  // The table is the deliverable here, so pin the split rather than the count:
  // get `rewrites` wrong and we tell three clients to emit a spelling that
  // silently deletes their null constraint; get `forwards` wrong and we certify
  // a document that hard-400s.
  ok("#368 three members REWRITE the nullability spelling themselves",
    byForm("rewrites").length === 3 &&
    byForm("rewrites").indexOf("google-adk") !== -1 &&
    byForm("rewrites").indexOf("agno") !== -1 &&
    byForm("rewrites").indexOf("@ai-sdk/google") !== -1);
  ok("#368 exactly one member FORWARDS, and it is the langchain one",
    byForm("forwards").length === 1 && byForm("forwards")[0] === "@langchain/google-genai");
  ok("#368 exactly one member carries EITHER spelling",
    byForm("either").length === 1 && byForm("either")[0] === "litellm");
  // No intersection form (#336). If some future edit makes one spelling work
  // for everybody, this fails and the fork below should be reconsidered.
  ok("#368 no nullability spelling works for every measured member",
    byForm("rewrites").length > 0 && byForm("forwards").length > 0);
  // Derived, not asserted (#361): `not` joined the carried set when a member
  // that forwards it was measured.
  ok("#368 the carried table is derived from the members and now includes `not`",
    E.GEMINI_CLIENT_CARRIED_KEYS.indexOf("not") !== -1 &&
    E.GEMINI_CLIENT_CARRIED_KEYS.indexOf("oneOf") !== -1 &&
    E.GEMINI_CLIENT_CARRIED_KEYS.indexOf("allOf") !== -1);

  // The defect: this exact document exits 0 today and hard-400s for a
  // forwarding client. The output does not change (three members need it) but
  // the diagnosis must fork.
  var opt = E.convert({
    type: "object",
    properties: { p: { type: ["string", "null"] } },
    required: ["p"]
  }, "gemini-client");

  ok("#368 the union spelling is still KEPT — three members need it",
    Array.isArray(opt.schema.properties.p.type) &&
    opt.schema.properties.p.type.indexOf("null") !== -1 &&
    opt.schema.properties.p.nullable === undefined);
  ok("#368 the note no longer claims the converting client always rewrites",
    !has(opt.ledger, "the converting client performs the `nullable` rewrite itself"));
  ok("#368 the note names the client that does NOT rewrite",
    has(opt.ledger, "@langchain/google-genai"));
  ok("#368 the note says that client's request is REJECTED, with the proto reason",
    has(opt.ledger, "Proto field is not repeating"));
  ok("#368 the note NAMES THE CHECK rather than guessing the caller's client",
    has(opt.ledger, "THE CHECK") && has(opt.ledger, "without rebuilding it"));
  ok("#368 the note points at the target whose output IS the other spelling",
    has(opt.ledger, "--to gemini"));
  ok("#368 the note still explains why emitting `nullable` here would be silent",
    has(opt.ledger, "stop being nullable"));
  // Advisory, never a gate failure (#317): which client is calling is a fact
  // only the caller has (#319), and blocking would be a false CI failure for
  // four of the five measured members.
  ok("#368 the fork never becomes a gate failure",
    opt.ledger.every(function (l) {
      return l.msg.indexOf("THE CHECK") === -1 || l.advisory === true;
    }));

  // Over-block guards, held both ways.
  var multi = E.convert({
    type: "object",
    properties: { p: { type: ["string", "integer"] } },
    required: ["p"]
  }, "gemini-client");
  // 2+ real members are rewritten to `anyOf`, which the live proto accepts, so
  // a forwarding client is fine there and must NOT get the fork.
  ok("#368 a multi-member union is unaffected — it becomes `anyOf`, which is accepted",
    !!multi.schema.properties.p.anyOf && !has(multi.ledger, "THE CHECK"));
  var plain = E.convert({
    type: "object",
    properties: { p: { type: "string" } },
    required: ["p"]
  }, "gemini-client");
  ok("#368 an ordinary non-nullable property draws no fork",
    !has(plain.ledger, "THE CHECK"));
  // The other Gemini targets are about a different destination and must stay
  // quiet — `--to gemini` is the ESCAPE HATCH, so if it grew this note the
  // advice would be circular.
  var narrow = E.convert({
    type: "object",
    properties: { p: { type: ["string", "null"] } },
    required: ["p"]
  }, "gemini");
  ok("#368 `--to gemini` emits the OTHER spelling and does not fork",
    narrow.schema.properties.p.nullable === true &&
    narrow.schema.properties.p.type === "string" &&
    !has(narrow.ledger, "THE CHECK"));

  // The combinator counts were stale, not wrong in kind: the keep decision is
  // confirmed against five members. `oneOf` keeps the `anyOf` remedy; `not`
  // must not get it, which is the discriminator proving the branch is real.
  var one = E.convert({
    type: "object",
    properties: { p: { oneOf: [{ type: "string" }, { type: "integer" }] } }
  }, "gemini-client");
  ok("#368 the `oneOf` note names a forwarder and a dropper from the five",
    has(one.ledger, "@ai-sdk/google") && has(one.ledger, "google-adk"));
  ok("#368 ...and no longer says the class has two members",
    !has(one.ledger, "two members of an open class"));
})();


// ---------------------------------------------------------------------------
// #369. A one-element `type` list, and a null-only one, carry NO nullability —
// so #368's keep-the-union trade-off does not apply to them. #365's
// discriminator ("what does the rule buy the member it was written for?")
// returns NOTHING here, so leaving the list is a pure cost to the forwarding
// client, paid for nothing.
//
// Guarded reads throughout: with `engine.js` reverted these shapes come back
// unrewritten, and an unguarded `.type` deref would abort the whole file and
// hide every assertion after it (#322).
(function () {
  function gc(sch) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), "gemini-client");
    return r || {};
  }
  function pType(r) {
    var s = r && r.schema, p = s && s.properties && s.properties.p;
    return p ? JSON.stringify(p.type) : "(unreached)";
  }
  var P = function (t) {
    return { type: "object", properties: { p: { type: t } } };
  };

  // The three rewrites.
  ok("#369 a one-element `type` list collapses to the scalar",
    pType(gc(P(["string"]))) === '"string"');
  ok("#369 a null-only `type` list collapses to `\"null\"`",
    pType(gc(P(["null"]))) === '"null"');
  ok("#369 a duplicate null-only list collapses too (zod 3 `z.null().nullable()`)",
    pType(gc(P(["null", "null"]))) === '"null"');

  // THE DISCRIMINATOR. #368 deliberately KEEPS `["X","null"]` as a union,
  // because there the union buys three rewriting clients their nullability.
  // Without this pair the new rule could be firing blanket and every assertion
  // above would still pass (#364/#366's pattern).
  ok("#369 ...but `[\"X\",\"null\"]` is still KEPT as a union — the trade-off stands",
    pType(gc(P(["string", "null"]))) === '["string","null"]');
  ok("#369 ...and that case still prints #368's per-client CHECK",
    has(gc(P(["string", "null"])).ledger, "THE CHECK"));

  // Over-block guards: these hold both ways and are stated rather than counted
  // as new coverage.
  ok("#369 a SCALAR `\"null\"` is left alone — the proto accepts it verbatim",
    pType(gc(P("null"))) === '"null"');
  ok("#369 a genuine multi-member union is still rewritten to `anyOf`, not collapsed",
    (function () {
      var s = gc(P(["string", "integer"])).schema,
        p = s && s.properties && s.properties.p;
      return !!(p && p.anyOf && p.anyOf.length === 2 && p.type === undefined);
    })());

  // The message has to carry the proto's own rejection text, because that is
  // what makes the diagnosis checkable against the destination (#343).
  ok("#369 the note quotes the proto's actual rejection",
    has(gc(P(["string"])).ledger, "Proto field is not repeating"));
  ok("#369 the note says the union case is different, so the two rules do not blur",
    has(gc(P(["string"])).ledger, "no nullability here to trade away"));

  // Scope pin: `--to gemini` emits the proto spelling and must be untouched by
  // a rule written for the client target (#351's dialect split).
  ok("#369 `--to gemini` is unaffected — null-only still becomes `nullable`",
    (function () {
      var r = E.convert(P(["null"]), "gemini"),
        p = r && r.schema && r.schema.properties && r.schema.properties.p;
      return !!(p && p.nullable === true && p.type === undefined);
    })());

  // Idempotence: the collapsed output must be a fixed point (#352).
  ok("#369 the rewrite is idempotent",
    pType(gc(gc(P(["string"])).schema || {})) === '"string"');
})();


// ---------------------------------------------------------------------------
// #370 — an `allOf` is an INTERSECTION, and a closed branch shrinks it.
//
// A branch declaring `additionalProperties: false` FORBIDS every property it
// does not itself declare, so the merged property set is the union RESTRICTED
// to every closed branch's declarations. We took the plain union and never
// looked at any branch's `additionalProperties` — the N-member guard checks the
// MEMBERS' and the single-member path short-circuits past it (#349's shape: the
// N=1 special case skipping a condition the general path enforces).
//
// Measured on openai@7.4.0 over the 16-cell node x member grid at a NESTED
// position (root rules contaminate — #363), with accept sets from ajv 2020-12:
// EIGHT shapes whose raw accept set is EMPTY came out SATISFIABLE at zero
// blockers, and one the vendor ACCEPTS and preserves EXACTLY came out with a
// different accept set. 14/14 agreement with the vendor after the fix.
(function () {
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function P(props, req, closed) {
    var o = { type: "object", properties: props };
    if (req) o.required = req;
    if (closed) o.additionalProperties = false;
    return o;
  }
  function S() { return { type: "string" }; }
  // NESTED so the typeless/non-object ROOT rules cannot contaminate the verdict.
  function nest(inner) {
    return { type: "object", properties: { n: inner }, required: ["n"] };
  }
  function conv(inner) {
    try { return E.convert(clone(nest(inner)), "openai"); } catch (e) { return null; }
  }
  function blk(r) {
    if (!r || !Array.isArray(r.ledger)) return -1;
    return r.ledger.filter(function (l) { return l.op === "!" && !l.advisory; }).length;
  }
  // Guarded: with engine.js reverted these reads must REPORT, not abort the
  // file (#322's trap).
  function props(r) {
    var n = r && r.schema && r.schema.properties && r.schema.properties.n;
    if (!n || !n.properties) return "(none)";
    return Object.keys(n.properties).sort().join(",");
  }
  function led(r) { return (r && Array.isArray(r.ledger)) ? r.ledger : []; }

  // --- The unsatisfiable family: a REQUIRED property outside the intersection.
  // Raw accept set is EMPTY (no object can satisfy it) and the vendor throws
  // "Object allOf ... cannot be merged without changing Draft 7 validation".
  // We used to merge these into a satisfiable schema at ZERO blockers.
  var closedNodeReqMember = P({ a: S() }, ["a"], true);
  closedNodeReqMember.allOf = [P({ b: S() }, ["b"], false)];
  ok("#370 closed node + member requiring an excluded property is a BLOCKER",
    blk(conv(closedNodeReqMember)) === 1);
  ok("#370 the blocker says no object can satisfy it, and names the culprit",
    has(led(conv(closedNodeReqMember)), "cannot be satisfied by any object") &&
    has(led(conv(closedNodeReqMember)), "`b`"));
  ok("#370 the blocker explains that merging would ADMIT a forbidden property",
    has(led(conv(closedNodeReqMember)), "would silently ADMIT"));

  var openNodeClosedMember = P({ a: S() }, ["a"], false);
  openNodeClosedMember.allOf = [P({ b: S() }, ["b"], true)];
  ok("#370 the mirror (closed MEMBER, open node) blocks too",
    blk(conv(openNodeClosedMember)) === 1);

  // The N-member path had the same hole: `mergeable` checks the MEMBERS'
  // `additionalProperties` and never the NODE's.
  var closedNodeTwoMembers = P({ a: S() }, ["a"], true);
  closedNodeTwoMembers.allOf = [P({ b: S() }, ["b"], false), P({ c: S() }, ["c"], false)];
  ok("#370 N-member path: closed node + open required members blocks",
    blk(conv(closedNodeTwoMembers)) === 1);

  // --- The silent-widening family: an OPTIONAL property outside the
  // intersection. The vendor ACCEPTS these and DISCARDS the excluded name; we
  // admitted it, which widened what the schema accepts.
  var closedNodeOptMember = P({ a: S() }, ["a"], true);
  closedNodeOptMember.allOf = [P({ b: S() }, null, false)];
  ok("#370 an excluded OPTIONAL property is dropped, not admitted",
    props(conv(closedNodeOptMember)) === "a");
  ok("#370 dropping an excluded property is REPORTED, never silent",
    has(led(conv(closedNodeOptMember)), "Dropped `b`"));
  ok("#370 the drop note explains it would have WIDENED the schema",
    has(led(conv(closedNodeOptMember)), "WIDEN what this schema"));
  ok("#370 an excluded optional property is not a gate failure",
    blk(conv(closedNodeOptMember)) === 0);

  // The node's OWN property is dropped when a closed MEMBER forbids it —
  // the rule is about the intersection, not about who declared the name.
  var openNodeClosedMemberOpt = P({ a: S() }, null, false);
  openNodeClosedMemberOpt.allOf = [P({ b: S() }, ["b"], true)];
  ok("#370 a closed MEMBER drops the NODE's own excluded property",
    props(conv(openNodeClosedMemberOpt)) === "b");

  // Two closed branches with disjoint declarations intersect to nothing.
  var bothClosedDisjoint = P({ a: S() }, null, true);
  bothClosedDisjoint.allOf = [P({ b: S() }, null, true)];
  // The intersection of two disjoint closed branches admits only `{}`. That is
  // what the vendor emits for the same input, byte-identical, so matching it is
  // correct rather than a #329 "repair that deletes" — the raw schema already
  // accepted nothing else. (This assertion originally read "(none)"; the code
  // was right and the TEST was wrong — an empty `properties` object is not a
  // missing one.)
  ok("#370 two disjoint closed branches leave an empty object (vendor agrees)",
    props(conv(bothClosedDisjoint)) === "" &&
    (function () {
      var n = conv(bothClosedDisjoint);
      n = n && n.schema && n.schema.properties && n.schema.properties.n;
      return !!(n && n.properties && n.additionalProperties === false);
    })());

  // --- OVER-BLOCK GUARDS. Being stricter than the vendor is this project's
  // most repeated bug (#312/#314/#317/#322/#329/#337/#343/#344/#348/#365).
  // These hold BOTH ways and are stated rather than counted as new coverage.
  var openBoth = P({ a: S() }, ["a"], false);
  openBoth.allOf = [P({ b: S() }, ["b"], false)];
  ok("#370 over-block guard: no closed branch -> plain union, unchanged",
    props(conv(openBoth)) === "a,b" && blk(conv(openBoth)) === 0);
  ok("#370 over-block guard: an all-open merge reports no drop",
    !has(led(conv(openBoth)), "Dropped"));

  // A closed branch that DOES declare the required name is perfectly fine.
  var closedNodeAllowed = P({ a: S() }, ["a"], true);
  closedNodeAllowed.allOf = [P({ a: S() }, ["a"], false)];
  ok("#370 over-block guard: a closed branch declaring the name still merges",
    props(conv(closedNodeAllowed)) === "a" && blk(conv(closedNodeAllowed)) === 0);

  // A closed branch with NO properties forbids everything, but if nothing is
  // required the intersection is the empty object — legal, not a blocker.
  var closedNoProps = P({}, null, true);
  closedNoProps.allOf = [P({ b: S() }, null, false)];
  ok("#370 over-block guard: closed-with-no-properties + optional is not blocked",
    blk(conv(closedNoProps)) === 0);

  // THE DISCRIMINATOR. Without this pair the rule could be firing on any
  // `allOf` at all and every assertion above would still pass: the SAME two
  // branches differ only in whether one is closed, and must reach opposite
  // verdicts (#364/#366's pattern).
  ok("#370 DISCRIMINATOR: identical branches, closed vs open, disagree",
    (function () {
      var closed = P({ a: S() }, ["a"], true);
      closed.allOf = [P({ b: S() }, ["b"], false)];
      var open = P({ a: S() }, ["a"], false);
      open.allOf = [P({ b: S() }, ["b"], false)];
      return blk(conv(closed)) === 1 && blk(conv(open)) === 0 &&
        props(conv(open)) === "a,b";
    })());

  // Scope pin: this is an OpenAI strict-mode rule. Anthropic's tools path
  // applies no transform at all (#315/#321), so it must stay silent there.
  ok("#370 scope pin: `--to anthropic` does not inherit the closed-branch rule",
    (function () {
      var r;
      try { r = E.convert(clone(nest(closedNodeReqMember)), "anthropic"); }
      catch (e) { return false; }
      return blk(r) === 0 && !has(led(r), "cannot be satisfied by any object");
    })());
})();


// --- #371: a `$ref` beside constraining siblings is an INTERSECTION ---------
// Same operation `allOf` spells differently (#370). We implemented it as an
// OVERWRITE, so the referent's `properties`/`required` were discarded — a
// silent accept-set change at zero blockers, on NINE of ten targets, in three
// different directions. Nothing in 1085 assertions had ever pinned what this
// shape merges to, which is why it survived.
(function () {
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function led(r) { return (r && r.ledger) || []; }
  function blk(r) {
    return led(r).filter(function (l) { return l.op === "!" && !l.advisory; }).length;
  }
  function pnode(r) {
    var s = r && r.schema;
    return (s && s.properties && s.properties.p) || null;
  }
  function pprops(r) {
    var n = pnode(r);
    return n && n.properties ? Object.keys(n.properties).sort().join(",") : "(none)";
  }
  function preq(r) {
    var n = pnode(r);
    return n && Array.isArray(n.required) ? n.required.slice().sort().join(",") : "(none)";
  }
  function doc(inner, T) {
    return { type: "object", properties: { p: clone(inner) }, required: ["p"],
             additionalProperties: false, $defs: { T: clone(T) } };
  }
  function conv(inner, T, target) {
    try { return E.convert(doc(inner, T), target); } catch (e) { return { ok: false, ledger: [] }; }
  }

  var T_OPEN   = { type: "object", properties: { b: { type: "string" } }, required: ["b"] };
  var T_CLOSED = { type: "object", properties: { b: { type: "string" } }, required: ["b"],
                   additionalProperties: false };
  var T_SCALAR = { type: "string", minLength: 2 };

  var SIBLING   = { properties: { a: { type: "string" } }, required: ["a"], $ref: "#/$defs/T" };
  var ALLOFWRAP = { type: "object", properties: { a: { type: "string" } }, required: ["a"],
                    allOf: [{ $ref: "#/$defs/T" }] };
  var ALLOFTWO  = { allOf: [{ $ref: "#/$defs/T" },
                            { type: "object", properties: { a: { type: "string" } }, required: ["a"] }] };

  // The referent's `b` used to vanish. Verified against openai@7.4.0: the
  // vendor's own merged output carries BOTH names with a union `required`.
  var oa = conv(SIBLING, T_OPEN, "openai");
  ok("#371 a constraining `$ref` sibling MERGES rather than overwrites",
    pprops(oa) === "a,b" && preq(oa) === "a,b" && blk(oa) === 0);
  ok("#371 the merge is reported as a merge, not a bare inline",
    has(led(oa), "this is a MERGE, not an overwrite"));

  // The finding is that the ten targets DISAGREED about one document. Every
  // target that rewrites this shape must now reach the same property set.
  var REWRITERS = ["openai", "anthropic-json", "anthropic-json-python", "anthropic-go",
                   "gemini", "gemini-json", "gemini-client"];
  ok("#371 every rewriting target agrees on the merged property set",
    REWRITERS.every(function (t) {
      var r = conv(SIBLING, T_OPEN, t);
      return blk(r) === 0 && pprops(r) === "a,b" && preq(r) === "a,b";
    }));
  // The three that pass the document through untouched were already correct —
  // 2020-12 intersects, so leaving it alone preserves the meaning. Pinning them
  // is what stops a later cycle "fixing" a target that has nothing to fix.
  ok("#371 scope pin: the verbatim targets still forward the `$ref` untouched",
    ["anthropic", "openai-nonstrict", "openai-realtime"].every(function (t) {
      var n = pnode(conv(SIBLING, T_OPEN, t));
      return n && n.$ref === "#/$defs/T";
    }));

  // DISCRIMINATOR. Two inputs identical but for whether the REFERENT is closed.
  // Without this pair the rule could be firing on any `$ref` sibling at all and
  // every other assertion here would still pass (#364/#366's pattern).
  var closedR = conv(SIBLING, T_CLOSED, "openai");
  ok("#371 DISCRIMINATOR: identical shapes, open vs closed referent, disagree",
    blk(oa) === 0 && blk(closedR) === 1);
  ok("#371 a closed referent makes the node unsatisfiable -> blocker, no merge",
    has(led(closedR), "cannot both be satisfied"));
  // Exactly ONE blocker: the generic `$ref`-sibling rule reaches the same node
  // and its remedy ("write the `$ref` WITHOUT the `allOf` wrapper") is wrong for
  // a caller who never wrote a wrapper (#359).
  ok("#371 the same node is not reported twice",
    blk(closedR) === 1 && !has(led(closedR), "sits beside"));

  // A property declared on both sides with different shapes: the true meaning
  // is the intersection of the two, which strict mode cannot express.
  var clashR = conv({ properties: { b: { type: "integer" } }, required: ["b"], $ref: "#/$defs/T" },
                    T_OPEN, "openai");
  ok("#371 a clashing property is a blocker, not a silent pick",
    blk(clashR) === 1 && has(led(clashR), "both declare a property"));
  // ...and an IDENTICAL re-declaration is not a clash. The test is conflict,
  // not duplication (#349).
  var dupR = conv({ properties: { b: { type: "string" } }, required: ["b"], $ref: "#/$defs/T" },
                  T_OPEN, "openai");
  ok("#371 over-block guard: an identical re-declaration is not a clash",
    blk(dupR) === 0 && pprops(dupR) === "b");

  // --- the `allOf` spelling of the same intersection ------------------------
  // openai@7.4.0 ACCEPTS this and preserves the accept set exactly; we failed
  // the gate on it, which is the over-strictness class this project has shipped
  // ~10 times.
  var w = conv(ALLOFWRAP, T_OPEN, "openai");
  ok("#371 `allOf:[{$ref}]` beside own properties merges instead of blocking",
    blk(w) === 0 && pprops(w) === "a,b" && preq(w) === "a,b");
  ok("#371 the resolution of a `$ref` member is reported",
    has(led(w), "Resolved 1 `$ref` member"));
  var two = conv(ALLOFTWO, T_OPEN, "openai");
  ok("#371 `allOf:[{$ref},{object}]` merges instead of blocking",
    blk(two) === 0 && pprops(two) === "a,b" && preq(two) === "a,b");
  ok("#371 a closed referent still blocks in the `allOf` spelling",
    blk(conv(ALLOFWRAP, T_CLOSED, "openai")) === 1);

  // Over-block guards. Each of these is a shape the vendor ACCEPTS as written,
  // and resolving the `$ref` would expand the document for no benefit or route
  // an unsatisfiable node through a merge that reports success.
  ok("#371 over-block guard: a bare `{allOf:[{$ref}]}` is left as a `$ref`",
    (function () {
      var n = pnode(conv({ allOf: [{ $ref: "#/$defs/T" }] }, T_OPEN, "openai"));
      return n && (n.$ref === "#/$defs/T" || (n.allOf && n.allOf[0].$ref === "#/$defs/T"));
    })());
  ok("#371 over-block guard: the Pydantic v1 shape keeps its `$ref`",
    (function () {
      var n = pnode(conv({ title: "Inner", description: "d", allOf: [{ $ref: "#/$defs/T" }] },
                         T_OPEN, "openai"));
      return n && (n.$ref === "#/$defs/T" || (n.allOf && n.allOf[0].$ref === "#/$defs/T"));
    })());
  ok("#371 over-block guard: a `$ref` to a NON-object member is not resolved",
    (function () {
      var r = conv(ALLOFWRAP, T_SCALAR, "openai");
      return !has(led(r), "Resolved 1 `$ref` member");
    })());
  ok("#371 over-block guard: a dangling `$ref` member is not resolved",
    (function () {
      var r = conv({ type: "object", properties: { a: { type: "string" } }, required: ["a"],
                     allOf: [{ $ref: "#/$defs/NOPE" }] }, T_OPEN, "openai");
      return !has(led(r), "Resolved 1 `$ref` member");
    })());
  ok("#371 over-block guard: an ordinary schema is untouched by all of this",
    (function () {
      var r = E.convert({ type: "object", properties: { a: { type: "string" } },
                          required: ["a"], additionalProperties: false }, "openai");
      return blk(r) === 0 && !has(led(r), "MERGE, not an overwrite") &&
             !has(led(r), "Resolved 1 `$ref` member");
    })());

  // `gemini-json` keeps `$ref`/`$defs` deliberately, and the vendor forbids a
  // `$ref` carrying non-`$` siblings — so the choice there is inline-one-node
  // or delete the constraints. It used to always delete (reported, but a loss
  // where a lossless repair exists); annotations still take the delete path,
  // because that is the path whose whole value is keeping `$ref` and recursion.
  ok("#371 gemini-json inlines a CONSTRAINING sibling instead of deleting it",
    (function () {
      var r = conv(SIBLING, T_OPEN, "gemini-json");
      return pprops(r) === "a,b" && has(led(r), "Inlined this `$ref` and merged it");
    })());
  ok("#371 gemini-json still DELETES an annotation-only sibling per the vendor rule",
    (function () {
      var r = conv({ description: "d", $ref: "#/$defs/T" }, T_OPEN, "gemini-json");
      var n = pnode(r);
      return n && n.$ref === "#/$defs/T" && has(led(r), "Removed `description` alongside `$ref`");
    })());
})();



// --- #372: a root `$ref` is a member of the intersection too -------------
// #371 fixed the NESTED position and banked the root as a known, measured gap:
// `inlineRootRef` carried siblings with `if (!(k in out)) out[k] = s[k]`, i.e.
// REFERENT-WINS. Precedence is only ever correct for annotations; for anything
// that constrains, "the referent wins" means "the node's own declarations are
// deleted". Measured at the root on a shape whose raw accept set is `0001` (an
// object must carry BOTH `a` and `b`), FOUR of ten targets emitted `0010`/`0011`
// — the node's own `a` gone and no longer required — at ZERO blockers, while the
// SAME shape one level down was already correct. The two positions disagreed
// with each other about one logical schema, which is the tell.
(function () {
  // Guarded reads: a converter that throws or returns no ledger must REPORT as a
  // failure rather than abort the file and hide every assertion after it (#322).
  function led(r) { return (r && Array.isArray(r.ledger)) ? r.ledger : []; }
  function props(r) {
    var s = r && r.schema;
    return (s && s.properties && typeof s.properties === "object") ? Object.keys(s.properties) : [];
  }
  function req(r) { return (r && r.schema && Array.isArray(r.schema.required)) ? r.schema.required : []; }
  function blk(r) {
    return led(r).filter(function (l) { return l.op === "!" && !l.advisory; });
  }
  function hasAll(list, names) {
    return names.every(function (n) { return list.indexOf(n) !== -1; });
  }
  function T(extra) {
    var t = { type: "object", properties: { b: { type: "string" } }, required: ["b"] };
    Object.keys(extra || {}).forEach(function (k) { t[k] = extra[k]; });
    return t;
  }
  function root(sib, tExtra) {
    var s = { $ref: "#/$defs/T" };
    Object.keys(sib).forEach(function (k) { s[k] = sib[k]; });
    s.$defs = { T: T(tExtra) };
    return s;
  }
  function conv(s, target) {
    try { return E.convert(JSON.parse(JSON.stringify(s)), target); } catch (e) { return null; }
  }

  var CONSTRAINING = { properties: { a: { type: "string" } }, required: ["a"] };

  // (1) the four targets that DELETED the node's own declarations now keep both
  ["openai", "anthropic", "anthropic-json", "anthropic-go"].forEach(function (t) {
    var r = conv(root(CONSTRAINING), null);
    r = conv(root(CONSTRAINING), t);
    ok("#372 " + t + ": a constraining sibling at the ROOT is merged, not overwritten",
      hasAll(props(r), ["a", "b"]) && hasAll(req(r), ["a", "b"]) && blk(r).length === 0);
  });

  // (2) the merge is NAMED in the ledger — a reader must be able to see that two
  // sides were combined rather than one silently winning (#318)
  ok("#372 the root merge is reported as an intersection",
    has(led(conv(root(CONSTRAINING), "openai")),
      "which is an INTERSECTION rather than a decoration"));

  // (3) THE DISCRIMINATOR: the same logical schema at the ROOT and one level
  // down must now AGREE. Without this pin the rule could be firing on any root
  // `$ref` at all, or on any `$ref` sibling anywhere, and every other assertion
  // here would still pass (#364/#366).
  ok("#372 DISCRIMINATOR: root and nested now agree about one logical schema",
    (function () {
      var atRoot = conv(root(CONSTRAINING), "openai");
      var nested = conv({
        type: "object",
        properties: { p: { $ref: "#/$defs/T", properties: { a: { type: "string" } }, required: ["a"] } },
        required: ["p"],
        $defs: { T: T() }
      }, "openai");
      var n = nested && nested.schema && nested.schema.properties && nested.schema.properties.p;
      var nProps = (n && n.properties) ? Object.keys(n.properties) : [];
      return hasAll(props(atRoot), ["a", "b"]) && hasAll(nProps, ["a", "b"]);
    })());

  // (4) #370's closed-branch restriction applies at the root: a required name
  // outside the intersection has NO repair, so it is named rather than merged
  ok("#372 root: a required name outside a closed referent is a BLOCKER",
    (function () {
      var r = conv(root(CONSTRAINING, { additionalProperties: false }), "openai");
      return blk(r).length === 1 && has(led(r), "cannot both be satisfied");
    })());

  // (5) two sides declaring the same property with DIFFERENT shapes: picking
  // either silently changes what is accepted (#347), so it is a blocker
  ok("#372 root: the same property with different shapes is a BLOCKER",
    (function () {
      var r = conv(root({ properties: { b: { type: "integer" } }, required: ["b"] }), "openai");
      return blk(r).length === 1 && has(led(r), "with different shapes");
    })());

  // (6) an IDENTICAL restatement is a duplication, not a conflict (#349)
  ok("#372 root: an identical restatement of the same property still merges",
    (function () {
      var r = conv(root({ properties: { b: { type: "string" } }, required: ["b"] }), "openai");
      return blk(r).length === 0 && props(r).indexOf("b") !== -1;
    })());

  // (7) an excluded OPTIONAL name is lossless (no object could have carried it)
  // and is dropped WITH a report rather than silently (#318)
  ok("#372 root: an excluded optional name is dropped and reported",
    (function () {
      var r = conv(root({ properties: { a: { type: "string" } } }, { additionalProperties: false }), "openai");
      return blk(r).length === 0 && props(r).indexOf("a") === -1 && has(led(r), "Dropped `a`");
    })());

  // (8) NOT reported twice. `inlineRootRef` runs again after the walk (#363) and
  // `resolveRefSiblings` visits the root as well, so three separate passes can
  // reach this one node. The suppression is keyed on OBJECT IDENTITY and has to
  // be re-keyed onto the rebuilt object, because the walk rebuilds every node.
  ["openai", "anthropic-json"].forEach(function (t) {
    ok("#372 " + t + ": a blocked root is reported exactly ONCE",
      (function () {
        var r = conv(root(CONSTRAINING, { additionalProperties: false }), t);
        var msgs = blk(r).map(function (l) { return l.path + "|" + l.msg.slice(0, 40); });
        return msgs.length === 1 && msgs.length === msgs.filter(function (m, i) {
          return msgs.indexOf(m) === i;
        }).length;
      })());
  });

  // --- over-block guards: these hold BOTH ways and are stated as guards -----

  // (9) ANNOTATION-only siblings keep the legacy path byte-for-byte. Precedence
  // is correct for annotations, and `{$ref, $defs, title}` is exactly what
  // pydantic's `RootModel` emits (measured, 2.13.4) — the commonest root shape
  // there is. It must not acquire an intersection note.
  ok("#372 root: an annotation-only sibling is NOT treated as an intersection",
    (function () {
      var r = conv(root({ description: "d", title: "W" }), "openai");
      return blk(r).length === 0 && props(r).length === 1 && props(r)[0] === "b" &&
        !has(led(r), "which is an INTERSECTION rather than a decoration");
    })());

  // (10) the vendor's root variant additionally tolerates `$schema`/`$id`
  ok("#372 root: `$schema`/`$id` beside a `$ref` are tolerated, not constraints",
    (function () {
      var r = conv(root({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: "x" }), "openai");
      return blk(r).length === 0 && !has(led(r), "which is an INTERSECTION rather than a decoration");
    })());

  // (11) a bare root `$ref` is the canonical generator shape and is untouched
  ok("#372 root: a bare `$ref` still inlines with no intersection note",
    (function () {
      var r = conv(root({}), "openai");
      return blk(r).length === 0 && props(r).indexOf("b") !== -1;
    })());

  // (12) the definition bag is NOT a constraining sibling, and definitions the
  // merged root still points at must survive the orphan pruner (#342)
  ok("#372 root: a definition still referenced from the merged root survives",
    (function () {
      var r = conv({
        $ref: "#/$defs/T",
        properties: { a: { $ref: "#/$defs/U" } },
        required: ["a"],
        $defs: { T: T(), U: { type: "string" } }
      }, "openai");
      var d = r && r.schema && r.schema.$defs;
      return blk(r).length === 0 && d && d.U && !d.T;
    })());

  // (13) the draft-07 spelling of the bag reaches the same merge (#311/#320)
  ok("#372 root: the `definitions` spelling merges identically",
    (function () {
      var r = conv({
        $ref: "#/definitions/T",
        properties: { a: { type: "string" } },
        required: ["a"],
        definitions: { T: T() }
      }, "openai");
      return blk(r).length === 0 && hasAll(props(r), ["a", "b"]);
    })());

  // (14) ORDERING PINS. Changing the root inliner owes a re-probe of the two
  // checks that run around it (#362's root-union blocker and #341's typeless
  // root), and of the second inliner pass #363 added after the walk.
  ok("#372 ordering: #362's root union blocker still fires",
    (function () {
      var r = conv({ oneOf: [{ type: "object", properties: { a: {} } }, { type: "string" }] }, "openai");
      return blk(r).length === 1 && has(led(r), "Root schema cannot use `oneOf`");
    })());

  ok("#372 ordering: #341's typeless root is still REPAIRED, not blocked",
    (function () {
      var r = conv({ properties: { a: { type: "string" } }, required: ["a"] }, "openai");
      return blk(r).length === 0 && r.schema.type === "object";
    })());

  ok("#372 ordering: #363's post-walk root inline still runs",
    (function () {
      var r = conv({ allOf: [{ $ref: "#/$defs/T" }], $defs: { T: T() } }, "openai");
      return blk(r).length === 0 && props(r).indexOf("b") !== -1;
    })());

  // (15) the two targets that forward the document verbatim must keep doing so —
  // there is nothing to merge when nothing is rewritten, and a merge there would
  // be this project's over-strictness class (#312/#314/#317/#322/#337)
  ["openai-nonstrict", "openai-realtime"].forEach(function (t) {
    ok("#372 " + t + ": still forwards the root `$ref` untouched",
      (function () {
        var r = conv(root(CONSTRAINING), t);
        return blk(r).length === 0 && r.schema && r.schema.$ref === "#/$defs/T";
      })());
  });
})();


// --- #373: an illegal `type` VALUE -------------------------------------------
// `type` is not a container, so #355's shape check could not see it -- and it is
// the ONE keyword every downstream dialect DISPATCHES on. The engine already
// owned the table of legal values (JSON_SCHEMA_TYPES) and consulted it in
// exactly one place, inside schemaTypes(), where an illegal value made it return
// null = "type unknown". It failed OPEN, so no rule ever said the value was
// illegal (#320's asymmetry; #355's "a table used in one place is not a rule").
//
// MEASURED 2026-08-10. Legality: `ajv` 2020-12 REFUSES TO COMPILE `{type:"any"}`
// (17/18 agreement between this predicate and ajv over a shape battery; the one
// disagreement is `type: []`, deliberately out of scope below). Consequence:
// Gemini's narrow responseSchema types `type` as a proto enum, and the live
// v1beta endpoint rejects `"any"` exactly as it rejects the `"frobnicate"`
// control while `"string"` reaches auth -- and it rejected OUR OWN CONVERTED
// OUTPUT identically, which is #330's invariant break. openai 7.4.0
// toStrictJsonSchema and @anthropic-ai/sdk 0.116.0 betaTool both forward it
// VERBATIM, so acceptance is not correctness (#347).
//
// Reachability is a real generator, not a hand-written fixture (#311): the
// verbatim payloads below are smolagents own generator output; see the note below.
(function () {
  var TARGETS = Object.keys(E.DOCS);
  // Keyed on the ledger OP plus a phrase unique to THIS rule -- the generic
  // #355 message shares "is not valid JSON Schema", so matching that alone
  // could not tell the two rules apart (#340: the discriminator must discriminate).
  function badType(l) {
    return (l || []).some(function (e) {
      return e.op === "!" && !e.advisory && /seven type values/.test(e.msg);
    });
  }
  function hits(sch, provider) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), provider || "openai");
    return !!(r && r.ok !== false && badType(r.ledger));
  }
  function hitsEvery(sch) { return TARGETS.every(function (t) { return hits(sch, t); }); }
  function hitsNone(sch) { return TARGETS.every(function (t) { return !hits(sch, t); }); }

  // --- every position the traversal reaches ----------------------------------
  ok("#373 `type: \"any\"` at the root is caught on all ten targets",
    hitsEvery({ type: "any" }));
  ok("#373 caught inside `properties`",
    hitsEvery({ type: "object", properties: { m: { type: "any" } } }));
  ok("#373 caught inside `items`",
    hitsEvery({ type: "array", items: { type: "any" } }));
  ok("#373 caught inside `additionalProperties`",
    hitsEvery({ type: "object", additionalProperties: { type: "any" } }));
  ok("#373 caught inside an `anyOf` branch",
    hitsEvery({ anyOf: [{ type: "string" }, { type: "any" }] }));
  ok("#373 caught inside `$defs`",
    hitsEvery({ type: "object", properties: { a: { $ref: "#/$defs/T" } }, $defs: { T: { type: "any" } } }));
  ok("#373 caught as ONE MEMBER of a union `type` (the other member is legal)",
    hitsEvery({ type: ["string", "any"] }));
  ok("#373 a non-STRING member is the same predicate (`type: 5`)",
    hitsEvery({ type: "object", properties: { m: { type: 5 } } }));
  ok("#373 case matters: `\"String\"` is not `\"string\"`",
    hitsEvery({ type: "object", properties: { m: { type: "String" } } }));

  // --- OVER-BLOCK GUARDS. Being stricter than the destination is the bug this
  // project has shipped ~10 times, and 0 of 578 captured corpus inputs are
  // flagged by this rule (control: the four smolagents rows below ARE).
  ok("#373 guard: a legal scalar type is untouched",
    hitsNone({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }));
  ok("#373 guard: a legal union type is untouched",
    hitsNone({ type: "object", properties: { a: { type: ["string", "null"] } }, required: ["a"] }));
  ok("#373 guard: a property literally NAMED `type` is not a false positive",
    hitsNone({ type: "object", properties: { type: { type: "string" } }, required: ["type"] }));
  ok("#373 guard: `type` inside an `enum` VALUE is data, not a schema position",
    hitsNone({ type: "object", properties: { a: { enum: [{ type: "any" }] } }, required: ["a"] }));
  ok("#373 guard: `type` inside a `const` VALUE is data",
    hitsNone({ type: "object", properties: { a: { "const": { type: "any" } } }, required: ["a"] }));
  ok("#373 guard: `type` inside a `default` VALUE is data",
    hitsNone({ type: "object", properties: { a: { type: "object", "default": { type: "any" } } }, required: ["a"] }));

  // --- SCOPE PIN. `type: []` is ajv-illegal too and is deliberately NOT this
  // rule: it is the empty-collection class (#347), it is a LIST-valued `type`
  // and so already Gemini's repeating-field error (#368/#369), and no probed
  // generator emits it. Measured on the live v1beta endpoint 2026-08-10: it is
  // rejected, but with `Unknown name "type"` (a proto SHAPE error), not the
  // `Invalid value at ... .type` enum error `"any"` gets. Different cause,
  // different message, different owner. Pinned so a later widening is a
  // decision rather than an accident (#355's own corollary).
  ok("#373 scope: an EMPTY `type: []` is out of scope for this rule",
    hitsNone({ type: "object", properties: { m: { type: [] } }, required: ["m"] }));

  // An inferred schema is well formed by construction (#355's precedent).
  ok("#373 an input treated as an EXAMPLE is not reported",
    !badType((E.convert({ items: [1, 2, 3], total: 12.5 }, "openai") || {}).ledger));

  // --- REACHABILITY: verbatim smolagents 1.26.0 output (#311 -- test against
  // the real generator, not a fixture we wrote). `_function_type_hints_utils`
  // renders EVERY `Any` this way, so all four rows below are genuine generator
  // output and all four are legitimate inputs to this tool.
  //
  // STATED AT ITS TRUE STRENGTH, because a first draft of this overstated it
  // and the measurement caught it (#369): on the TOOL-CALLING path smolagents
  // sanitizes some of them itself. `models.get_tool_json_schema` rewrites
  // `type: "any"` to `"string"` -- but only at the TOP LEVEL of `tool.inputs`,
  // so measured end to end a bare `Any` and `Optional[Any]` are CLEANED and
  // only `List[Any]` and `Dict[str, Any]` reach the wire illegal, nested under
  // `items` / `additionalProperties`. A depth-1 guard on a recursive document
  // (#358/#359). The other two rows still matter here: they are what the
  // generator hands anyone calling it directly, which is the input we take.
  var SMOL = {
    "bare Any": { type: "object", properties: { v: { type: "any", description: "a value" } }, required: ["v"] },
    "List[Any]": { type: "object", properties: { v: { type: "array", items: { type: "any" }, description: "values" } }, required: ["v"] },
    "Dict[str, Any]": { type: "object", properties: { v: { type: "object", additionalProperties: { type: "any" }, description: "mapping" } }, required: ["v"] },
    "Optional[Any]": { type: "object", properties: { v: { type: "any", nullable: true, description: "maybe" } } }
  };
  Object.keys(SMOL).forEach(function (k) {
    ok("#373 smolagents `" + k + "` is caught on all ten targets", hitsEvery(SMOL[k]));
  });
  // The control that makes those four mean something: the SAME generator's
  // output for a function with no `Any` must stay clean.
  ok("#373 control: smolagents output with no `Any` is NOT flagged",
    hitsNone({ type: "object", properties: { a: { type: "string", description: "a string" }, b: { type: "integer", description: "an int" } }, required: ["a", "b"] }));

  // The blocker is a real blocker, never an advisory (#317: an advisory must
  // never fail the gate, and this one must).
  ok("#373 the entry is a blocker, not an advisory", (function () {
    var l = (E.convert({ type: "any" }, "openai") || {}).ledger || [];
    var e = l.filter(function (x) { return /seven type values/.test(x.msg); })[0];
    return !!e && e.op === "!" && !e.advisory;
  })());
  // It must be the FIRST line: every other entry was computed from a document
  // we could not fully read (#355's unshift).
  ok("#373 the blocker is the first ledger line", (function () {
    var l = (E.convert({ type: "object", properties: { m: { type: "any" } } }, "openai") || {}).ledger || [];
    return l.length > 0 && /seven type values/.test(l[0].msg);
  })());
  // The remedy must NOT be "delete `type`" -- a typeless/match-anything node is
  // itself refused further down this pipeline (#315/#333), so advising it would
  // send the reader into a second blocker.
  ok("#373 the remedy does not tell the reader to delete `type`", (function () {
    var l = (E.convert({ type: "any" }, "openai") || {}).ledger || [];
    var e = l.filter(function (x) { return /seven type values/.test(x.msg); })[0];
    return !!e && /NOT TO DELETE/.test(e.msg) && /serialized JSON/.test(e.msg);
  })());
})();


// --- #374: `$ref` expansion is bounded (DoS on untrusted schemas) ----------
// A `$ref` DAG that merely SHARES definitions -- `d[i]` referenced from two
// properties of `d[i+1]` -- expands to 2^depth when inlined. Before this was
// bounded, a 3.1 KB input killed the process with `FATAL ERROR: JavaScript heap
// out of memory` (exit 134) on `--to gemini`, i.e. a CI gate that returns no
// verdict at all. Reachable population is untrusted/hand-authored schemas, which
// is exactly what an MCP host forwards; `openai-agents` 0.19.4 ships the same
// bound for the same stated reason.
function fanoutSchema(depth, cyclic) {
  var defs = cyclic
    ? { d0: { type: "object", properties: { loop: { $ref: "#/$defs/d" + depth } }, required: ["loop"] } }
    : { d0: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } };
  for (var i = 1; i <= depth; i++) {
    defs["d" + i] = { type: "object", required: ["x", "y"], properties: {
      x: { $ref: "#/$defs/d" + (i - 1) }, y: { $ref: "#/$defs/d" + (i - 1) } } };
  }
  return { type: "object", required: ["root"],
    properties: { root: { $ref: "#/$defs/d" + depth } }, $defs: defs };
}

(function () {
  // Depth 14 is deliberately modest: it is over the budget, and it is also small
  // enough that the PRE-FIX code terminates (~3s) rather than hanging, so a
  // reverted run REPORTS these failures instead of wedging the suite (#322).
  var deep = fanoutSchema(14, false);
  var g = E.toGemini(JSON.parse(JSON.stringify(deep)), false);
  ok("#374 narrow gemini bounds `$ref` expansion instead of exhausting the heap",
     has(g.ledger, "exceeds 100,000 nodes"));
  ok("#374 the expansion blocker is a blocker, not an advisory",
     (g.ledger || []).some(function (l) {
       return l.op === "!" && l.msg.indexOf("exceeds 100,000 nodes") !== -1 && !l.advisory;
     }));
  // No repair is invented (#329) and the remedy is the one measured to work.
  ok("#374 the expansion blocker names `--to gemini-json` as the remedy",
     has(g.ledger, "--to gemini-json"));
  // The property that actually matters, and the one I got wrong on the first
  // pass: no PARTIALLY expanded document may escape. `$defs` is still stripped
  // downstream (measured from a consumer install; the pre-existing recursive-
  // `$ref` blocker does the same), so the assertion is on size, not visibility.
  ok("#374 the expansion blocker emits no partially-expanded document",
     g.schema && JSON.stringify(g.schema).length < 5000);

  // THE DISCRIMINATOR: the same input on the permissive path. `responseJsonSchema`
  // accepts `$ref`/`$defs` as written, so nothing is expanded and nothing is
  // bounded. Without this pair the rule could be firing on any `$ref` at all and
  // every other assertion here would still pass (#364/#366).
  var j = E.toGemini(JSON.parse(JSON.stringify(deep)), true);
  ok("#374 gemini-json does NOT bound: it never inlines, so there is nothing to bound",
     !has(j.ledger, "exceeds 100,000 nodes"));
  ok("#374 gemini-json emits no blocker for a shared acyclic `$ref` DAG",
     !(j.ledger || []).some(function (l) { return l.op === "!"; }));
})();

(function () {
  // The cycle scan walked PATHS, not nodes, so it was 2^depth on the same shape
  // even though it can only report something when a cycle exists. This is the
  // memo + short-circuit discriminator: a generous wall-clock bound that the
  // pre-fix code cannot meet (measured ~10s at this depth) and the fixed code
  // clears by two orders of magnitude (~40ms).
  var t0 = Date.now();
  var j = E.toGemini(fanoutSchema(18, false), true);
  var ms = Date.now() - t0;
  ok("#374 gemini-json handles a depth-18 shared `$ref` DAG in well under 2s (was exponential)",
     ms < 2000 && !!j.schema);
})();

(function () {
  // Over-block guard, holding both ways: an ORDINARY schema that reuses one
  // definition twice is the commonest `$ref` DAG there is (two address fields of
  // the same model). It must be completely untouched by any of this.
  var ordinary = { type: "object", required: ["billing", "shipping"], properties: {
      billing: { $ref: "#/$defs/Address" }, shipping: { $ref: "#/$defs/Address" } },
    $defs: { Address: { type: "object", required: ["city"], properties: { city: { type: "string" } } } } };
  var g = E.toGemini(JSON.parse(JSON.stringify(ordinary)), false);
  ok("#374 an ordinary shared-definition schema is not bounded or blocked",
     !has(g.ledger, "exceeds 100,000 nodes") &&
     !has(g.ledger, "would take exponential time"));
  ok("#374 an ordinary shared-definition schema still inlines normally",
     has(g.ledger, "Inlined"));
})();

(function () {
  // The cycle rule still WORKS -- the short-circuit must not have disabled it.
  // This is the assertion that stops the optimisation from becoming a false pass.
  var cyc = { type: "object", required: ["node"], properties: { node: { $ref: "#/$defs/N" } },
    $defs: { N: { type: "object", required: ["child"], properties: { child: { $ref: "#/$defs/N" } } } } };
  var j = E.toGemini(JSON.parse(JSON.stringify(cyc)), true);
  ok("#374 a cyclic `required` property is still reported after the acyclic short-circuit",
     has(j.ledger, "its type is cyclic"));
})();

(function () {
  // Cyclic AND heavily shared: enumerating every offending path is exponential,
  // so the scan stops -- and a SHORT list would be a false pass, so the
  // truncation itself is reported as a blocker (fail closed).
  // Depth 10, chosen so a REVERTED run still terminates and REPORTS rather than
  // wedging the suite (#322). Pre-fix has neither the memo nor the acyclic
  // short-circuit, so cost here is 2^depth twice over; depth 14 did not come
  // back inside 400s when I actually tried it, which is why this is 10.
  var t0 = Date.now();
  var j = E.toGemini(fanoutSchema(10, true), true);
  var ms = Date.now() - t0;
  ok("#374 a cyclic + heavily-shared schema terminates instead of running forever",
     ms < 3000);
  ok("#374 truncated cycle enumeration fails CLOSED with its own blocker",
     has(j.ledger, "may be incomplete"));
})();

(function () {
  ok("#374 the expansion bound is exported so it can be diffed against the corpus",
     E.REF_INLINE_MAX_NODES === 100000);
})();


// --- #376: a gate owes a VERDICT, not a stack trace ------------------------
// Every pass in engine.js recurses once per level, so past ~1,900 JSON levels
// V8 raised `RangeError: Maximum call stack size exceeded`. That crash exited
// 1 with ZERO bytes on stdout -- and 1 is the code this CLI documents as "not
// compliant, here are your changes" (#330), so a dead gate was indistinguishable
// from a normal verdict.
(function () {
  // Built TEXTUALLY: JSON.stringify cannot serialise a document this deep
  // either, which is itself part of why no repair is offered.
  function deepText(levels) {
    return '{"type":"object","properties":{"a":'.repeat(levels) +
           '{"type":"string"}' + '},"required":["a"]}'.repeat(levels);
  }
  var TARGETS = ["openai", "openai-nonstrict", "openai-realtime", "anthropic",
                 "anthropic-json", "anthropic-json-python", "anthropic-go",
                 "gemini", "gemini-json", "gemini-client"];

  // THE DISCRIMINATOR for this whole block: 2,000 schema levels is an input that
  // CRASHED every one of these targets before the bound. Asserting only that a
  // deep document is blocked would pass against an engine that blocks it and
  // then dies; the load-bearing property is that a verdict comes back at all.
  var crashed = [], notBlocked = [];
  TARGETS.forEach(function (t) {
    var r;
    try {
      r = E.convert(deepText(2000), t);
    } catch (e) {
      crashed.push(t);
      return;
    }
    if (!has(r.ledger, "nests more than")) notBlocked.push(t);
  });
  ok("#376 a 2,000-level document returns a verdict rather than crashing, on all 10 targets",
     crashed.length === 0);
  ok("#376 ...and that verdict is a blocker on all 10, not a silent pass",
     notBlocked.length === 0);

  // 20,000 levels must cost no more than 501 -- the probe early-exits at the cap
  // instead of measuring the whole document.
  var wild;
  try { wild = E.convert(deepText(20000), "openai"); } catch (e) { wild = null; }
  ok("#376 a 20,000-level document is bounded too (the depth probe early-exits)",
     !!wild && has(wild.ledger, "nests more than"));

  // OVER-BLOCK GUARDS. The corpus maximum is 9 JSON levels; these must not fire.
  var shallow = E.convert(deepText(100), "openai");
  ok("#376 over-block guard: 100 schema levels (200 JSON) is NOT depth-blocked",
     !has(shallow.ledger, "nests more than"));
  var ordinary = E.convert({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, "openai");
  ok("#376 over-block guard: an ordinary schema is untouched by the bound",
     !has(ordinary.ledger, "nests more than"));

  // Boundary pin, both ways, so the rule cannot silently drift into over-blocking.
  // deepText(n) is 2 JSON levels per schema level (the node plus its `properties`
  // bag), so it steps in twos and 500 itself is not representable -- these
  // BRACKET the bound at 499 and 501 rather than claiming to sit on it.
  ok("#376 boundary: 499 JSON levels is allowed",
     !has(E.convert(deepText(249), "openai").ledger, "nests more than"));
  ok("#376 boundary: 501 JSON levels is blocked",
     has(E.convert(deepText(250), "openai").ledger, "nests more than"));

  // The four converters are EXPORTED, so a library caller reaches `clone` --
  // the first recursive thing in the file -- without passing through convert().
  // #374 was bitten by exactly this asymmetry.
  var directCrashed = [];
  [["toOpenAI", function (s) { return E.toOpenAI(s); }],
   ["toAnthropic", function (s) { return E.toAnthropic(s, true); }],
   ["toGemini", function (s) { return E.toGemini(s, false); }]].forEach(function (pair) {
    try {
      var r = pair[1](JSON.parse(deepText(2000)));
      if (!has(r.ledger, "nests more than")) directCrashed.push(pair[0] + ":unblocked");
    } catch (e) { directCrashed.push(pair[0] + ":crash"); }
  });
  ok("#376 direct converter calls are guarded too, not just convert()",
     directCrashed.length === 0);

  // The EXAMPLE path recurses through inferSchema before any schema exists, so
  // the guard has to read the raw parsed input rather than the inferred schema.
  function chain(n) { return '{"a":'.repeat(n) + "1" + "}".repeat(n); }
  var ex;
  try { ex = E.convert(chain(2000), "openai"); } catch (e) { ex = null; }
  ok("#376 a deep EXAMPLE object is bounded before inferSchema recurses",
     !!ex && has(ex.ledger, "nests more than"));

  // BOTH guards are load-bearing, and this is the pair that proves it: an
  // example INFLATES -- inferSchema turns each `{a: ...}` level into
  // `{type, properties:{a: ...}, required}`, i.e. ~2 JSON levels per input
  // level. So a 400-level example is UNDER the bound as input and ~800 levels
  // as a schema. Guarding only the caller's input would let that straight
  // through to the walkers; it is the converter-entry guard that catches it.
  // A tool that MANUFACTURES depth cannot bound only what it was handed.
  var inflated = E.convert(chain(400), "openai");
  ok("#376 an example UNDER the bound that infers OVER it is still caught",
     has(inflated.ledger, "nests more than"));
  ok("#376 ...while a shallow example still infers normally (no over-block)",
     !has(E.convert(chain(100), "openai").ledger, "nests more than"));

  // Pin the justification, not just the behaviour. This is the sentence that
  // stops a later cycle re-framing the bound as us being stricter than the
  // destination: the vendors' own transformers die on the same shapes.
  var msg = E.convert(deepText(2000), "openai").ledger[0].msg;
  ok("#376 the blocker states the measured vendor fact (they crash too)",
     msg.indexOf("openai@7.4.0") !== -1 && msg.indexOf("RangeError") !== -1);
  ok("#376 the bound is exported so it can be diffed against the corpus",
     E.SCHEMA_MAX_DEPTH === 500);
})();

// --- #376: openai-agents MCP payloads (owed by #375) -----------------------
// Verbatim third-party shapes from openai-agents-python's MCP path, which
// forwards CALLER-SUPPLIED tool schemas through `ensure_strict_json_schema`.
// #375 measured that its fallback stamps `strict: true` on 15 of these; these
// pin that we catch what it misses.
(function () {
  function conv(sch) { return E.convert(JSON.parse(JSON.stringify(sch)), "openai"); }
  function blockers(r) {
    return (r.ledger || []).filter(function (l) { return l.op === "!" && !l.advisory; });
  }

  // THE DISCRIMINATOR (#375 named it explicitly): openai-agents' `strict_schema.py:221`
  // does `json_schema.update({**resolved, **json_schema})` -- PARENT-WINS -- so the
  // referent's `b` is DELETED and the object then CLOSED, making a property the
  // schema REQUIRED into one it FORBIDS. Draft 2020-12 applies the referent AND
  // the siblings, so the correct merge keeps both. Without this pair every other
  // assertion in this block still passes.
  var refSib = conv({
    "$defs": { "T": { type: "object", properties: { b: { type: "string" } }, required: ["b"] } },
    type: "object",
    properties: { node: { properties: { a: { type: "string" } }, required: ["a"], "$ref": "#/$defs/T" } }
  });
  var node = refSib.schema && refSib.schema.properties && refSib.schema.properties.node;
  var props = node && node.properties ? Object.keys(node.properties).sort() : [];
  ok("#376 openai-agents `$ref`-sibling: we KEEP both `a` and `b` (they keep only `a`)",
     props.length === 2 && props[0] === "a" && props[1] === "b");
  ok("#376 ...and both survive into `required` rather than one being forbidden",
     !!node && (node.required || []).indexOf("a") !== -1 && (node.required || []).indexOf("b") !== -1);

  // A 2-member `allOf` -- one of the 15 shapes their fallback passes through as
  // strict-valid. We merge it rather than shipping it.
  var allOf2 = conv({
    type: "object", properties: { id: { type: "string" } },
    allOf: [{ type: "object", properties: { a: { type: "string" } } },
            { type: "object", properties: { b: { type: "string" } } }]
  });
  ok("#376 openai-agents 2-member `allOf` is merged, not forwarded",
     has(allOf2.ledger, "Merged an `allOf`") && blockers(allOf2).length === 0);

  // The OpenAPI `allOf:[{$ref},{$ref}]` idiom -- the shape #371 established must
  // be resolved through the pointers before mergeability is decided.
  var allOfRefs = conv({
    "$defs": { Base: { type: "object", properties: { id: { type: "string" } } },
               Extra: { type: "object", properties: { note: { type: "string" } } } },
    type: "object", properties: { item: { allOf: [{ "$ref": "#/$defs/Base" }, { "$ref": "#/$defs/Extra" }] } }
  });
  var item = allOfRefs.schema && allOfRefs.schema.properties && allOfRefs.schema.properties.item;
  var itemProps = item && item.properties ? Object.keys(item.properties).sort() : [];
  ok("#376 openai-agents OpenAPI `allOf:[{$ref},{$ref}]` resolves through both pointers",
     itemProps.length === 2 && itemProps[0] === "id" && itemProps[1] === "note");

  // A genuinely MCP-ONLY shape: `mcp/util.py:536-538` inserts `properties: {}`
  // because "MCP spec doesn't require the inputSchema to have `properties`, but
  // OpenAI spec does". Our answer must match the vendor's own repair, which #330
  // measured as exactly `{"type":"object","additionalProperties":false}` -- so
  // this is an over-block guard, not a defect to report.
  var noProps = conv({ type: "object" });
  ok("#376 openai-agents MCP `{\"type\":\"object\"}` with no `properties` is not a blocker",
     blockers(noProps).length === 0 &&
     noProps.schema.type === "object" && noProps.schema.additionalProperties === false);
})();


// ---- #377: a pointer INTO the definition being inlined at the root ---------
//
// `inlineRootRef` decided which definitions to KEEP with a literal
// `JSON.stringify(doc).indexOf('"#/$defs/T"')`. That only ever recognises the
// PLAIN spelling, so a pointer INTO the definition it had just inlined
// (`#/$defs/T/properties/name` -- no closing quote after `T`) read as "nothing
// references T", and T was DELETED while the pointer to it stayed in the
// output. #342 fixed exactly this in the orphan PRUNER and the root copy of the
// same rule was left behind; #372's lesson is that one rule in two functions
// drifts, so both now share `localDefRefs`.
(function () {
  // Guarded reads FIRST (#322): with engine.js reverted these must still let the
  // file REPORT rather than abort, or the revert number is meaningless.
  function conv(sch, p) {
    try { return E.convert(JSON.parse(JSON.stringify(sch)), p) || {}; } catch (e) { return { threw: e }; }
  }
  function blk(r) {
    return (r && r.ledger ? r.ledger : []).filter(function (l) { return l.op === "!" && !l.advisory; });
  }
  function bagOf(r) {
    var s = r && r.schema;
    if (!s || typeof s !== "object") return null;
    if (s.$defs && typeof s.$defs === "object") return s.$defs;
    if (s.definitions && typeof s.definitions === "object") return s.definitions;
    return null;
  }
  // Does every local `$ref` in the emitted document still resolve inside it?
  // This is the property that matters -- "bag present" is a proxy, "the pointer
  // lands on something" is the thing.
  function danglingRefs(r) {
    var s = r && r.schema, out = [];
    if (!s || typeof s !== "object") return out;
    (function scan(v) {
      if (Array.isArray(v)) { v.forEach(scan); return; }
      if (!v || typeof v !== "object") return;
      if (typeof v.$ref === "string" && v.$ref.charAt(0) === "#" && v.$ref !== "#") {
        var toks = v.$ref.replace(/^#\//, "").split("/").map(function (t) {
          return decodeURIComponent(t).replace(/~1/g, "/").replace(/~0/g, "~");
        });
        var cur = s;
        for (var i = 0; i < toks.length; i++) {
          if (cur == null || typeof cur !== "object") { cur = undefined; break; }
          cur = cur[toks[i]];
        }
        if (cur === undefined) out.push(v.$ref);
      }
      Object.keys(v).forEach(function (k) { scan(v[k]); });
    })(s);
    return out;
  }

  var AFFECTED = ["openai", "anthropic", "anthropic-json", "anthropic-go"];

  // VERBATIM `zodToJsonSchema(S, "S")` output, zod 3 + zod-to-json-schema@3.24.5,
  // captured 2026-08-10 (#311: test against what the generator really emits).
  // The root `$ref` + a reused sub-schema (`Inner.shape.one`) is the DEFAULT
  // shape of the documented call form, not an exotic hand-written one.
  var ZOD3 = {
    "$ref": "#/definitions/S",
    "definitions": {
      "S": {
        "type": "object",
        "properties": {
          "inner": {
            "type": "object",
            "properties": { "one": { "type": "string" }, "two": { "type": "number" } },
            "required": ["one", "two"],
            "additionalProperties": false
          },
          "echo": { "$ref": "#/definitions/S/properties/inner/properties/one" }
        },
        "required": ["inner", "echo"],
        "additionalProperties": false
      }
    },
    "$schema": "http://json-schema.org/draft-07/schema#"
  };

  AFFECTED.forEach(function (t) {
    var r = conv(ZOD3, t);
    ok("#377 zod3 root `$ref` + pointer into that def keeps its bag (" + t + ")",
       bagOf(r) !== null);
    ok("#377 zod3 root `$ref` + pointer into that def emits no dangling `$ref` (" + t + ")",
       danglingRefs(r).length === 0);
  });

  // The three targets that were SILENT about it: zero blockers AND a dangling
  // pointer is the false-pass class -- a broken document handed back as "no
  // changes needed" (#311: a false pass in a CI gate is worse than no gate).
  ["anthropic", "anthropic-json", "anthropic-go"].forEach(function (t) {
    var r = conv(ZOD3, t);
    ok("#377 `" + t + "` must not report success while emitting a dangling `$ref`",
       !(blk(r).length === 0 && danglingRefs(r).length > 0));
  });

  // On `openai` the old code produced a BLOCKER whose text was false of the
  // input: the reference resolved until we deleted what it resolved to.
  var oai = conv(ZOD3, "openai");
  ok("#377 zod3 pointer-into is not blocked as \"dangling\" on openai",
     blk(oai).length === 0);

  // THE DISCRIMINATOR (#364/#366). Two inputs differing ONLY in whether the
  // reuse points INTO the definition being inlined or at a SIBLING definition.
  // Both must survive. Without this pair the rule could be firing on any root
  // `$ref` at all and every other assertion here would still pass.
  var INTO = { $ref: "#/$defs/T", $defs: { T: { type: "object",
    properties: { name: { type: "string" }, alias: { $ref: "#/$defs/T/properties/name" } },
    required: ["name", "alias"], additionalProperties: false } } };
  var SIBLING = { $ref: "#/$defs/T", $defs: {
    T: { type: "object", properties: { name: { type: "string" }, alias: { $ref: "#/$defs/N" } },
         required: ["name", "alias"], additionalProperties: false },
    N: { type: "string" } } };
  var rInto = conv(INTO, "openai"), rSib = conv(SIBLING, "openai");
  ok("#377 DISCRIMINATOR: pointer INTO the inlined def resolves in the output",
     danglingRefs(rInto).length === 0 && blk(rInto).length === 0);
  ok("#377 DISCRIMINATOR: pointer at a SIBLING def still resolves too",
     danglingRefs(rSib).length === 0 && blk(rSib).length === 0);

  // ---- over-block guards: these hold BOTH ways and are not new coverage -----

  // Ordinary self-recursion uses the plain spelling, which the literal match
  // already handled. It must keep working.
  var REC = { $ref: "#/$defs/Node", $defs: { Node: { type: "object",
    properties: { v: { type: "string" }, next: { $ref: "#/$defs/Node" } },
    required: ["v", "next"], additionalProperties: false } } };
  var rRec = conv(REC, "openai");
  ok("#377 ordinary recursive root `$ref` still keeps its definition",
     bagOf(rRec) !== null && danglingRefs(rRec).length === 0);

  // The pruner was rewritten onto the shared helper, so prove it still PRUNES.
  // If `localDefRefs` were wrong in the permissive direction this would fail,
  // and dead `$defs` count against OpenAI's 5000-property budget.
  var ORPHAN = { type: "object", properties: { a: { type: "string" } },
    required: ["a"], additionalProperties: false,
    $defs: { Unused: { type: "string" } } };
  var rOrph = conv(ORPHAN, "openai");
  var orphBag = bagOf(rOrph);
  ok("#377 a genuinely unreferenced definition is still pruned",
     orphBag === null || !Object.prototype.hasOwnProperty.call(orphBag, "Unused"));

  // Fail closed (#320): a local pointer that cannot be attributed to a `$defs`
  // entry must stop the pruning, not be guessed to be unrelated.
  var UNATTRIB = { type: "object", properties: { a: { $ref: "#/properties/b" }, b: { type: "string" } },
    required: ["a", "b"], additionalProperties: false,
    $defs: { Keep: { type: "string" } } };
  var rUn = conv(UNATTRIB, "openai");
  var unBag = bagOf(rUn);
  ok("#377 an unattributable local pointer stops pruning (fails closed)",
     unBag !== null && Object.prototype.hasOwnProperty.call(unBag, "Keep"));

  // A plain object has no bag and no pointers -- nothing here may touch it.
  var PLAIN = { type: "object", properties: { a: { type: "string" } },
    required: ["a"], additionalProperties: false };
  var rPlain = conv(PLAIN, "openai");
  ok("#377 a plain object is unaffected",
     blk(rPlain).length === 0 && bagOf(rPlain) === null &&
     rPlain.schema && rPlain.schema.properties && rPlain.schema.properties.a &&
     rPlain.schema.properties.a.type === "string");
})();


// ---------------------------------------------------------------------------
// #378 — a pointer is a token sequence EVERYWHERE, and decoding one can throw.
//
// #377 unified the two sites that decide which definitions are still
// referenced. Three more functions carried the same shape and were missed:
// the Gemini inliner and the two walks of the Gemini cycle scan each used
// `/^#\/(?:\$defs|definitions)\/(.+)$/` and consumed the capture RAW. Plus the
// decode #377 added throws on a malformed escape.
// ---------------------------------------------------------------------------
(function () {
  function conv(sch, p) {
    try { return E.convert(JSON.parse(JSON.stringify(sch)), p); }
    catch (e) { return { threw: String(e && e.message), ledger: [], schema: null }; }
  }
  function blk(r) {
    return (r && Array.isArray(r.ledger) ? r.ledger : [])
      .filter(function (e) { return e && e.op === "!" && !e.advisory; });
  }
  function txt(r) {
    return (r && Array.isArray(r.ledger) ? r.ledger : [])
      .map(function (e) { return (e && e.msg) || ""; }).join(" ~~ ");
  }
  function node(r, path) {
    var cur = r && r.schema;
    var parts = path.split(".");
    for (var i = 0; i < parts.length; i++) {
      if (!cur || typeof cur !== "object") return null;
      cur = cur[parts[i]];
    }
    return cur && typeof cur === "object" ? cur : null;
  }

  // The VERBATIM shape zod 3 + zod-to-json-schema@3.24.5 emits for a reused
  // sub-schema: the documented call form gives a root `$ref`, and reusing any
  // sub-schema gives a pointer INTO that same definition (#377 measured this).
  var ZOD3 = {
    "$ref": "#/definitions/S",
    definitions: {
      S: {
        type: "object",
        properties: {
          inner: {
            type: "object",
            properties: { one: { type: "string", minLength: 3 }, two: { type: "number" } },
            required: ["one", "two"], additionalProperties: false
          },
          echo: { "$ref": "#/definitions/S/properties/inner/properties/one" }
        },
        required: ["inner", "echo"], additionalProperties: false
      }
    }
  };

  // --- 1. the over-block, and the constraint it was destroying -------------
  ["gemini", "gemini-client"].forEach(function (t) {
    var r = conv(ZOD3, t);
    ok("#378 " + t + ": a pointer INTO a definition is inlined, not blocked",
       blk(r).length === 0);
    var echo = node(r, "properties.echo");
    ok("#378 " + t + ": the referenced constraint survives inlining",
       !!echo && echo.type === "string" && echo.minLength === 3);
    ok("#378 " + t + ": no `$ref` is left in the output",
       !!echo && echo.$ref === undefined);
  });

  // The blocker text was FALSE OF THE INPUT — it said the reference "points
  // into this document but there is nothing at that location" when the target
  // was right there and we had dropped the bag ourselves. Same error #377
  // corrected one function over.
  ok("#378 no dangling-reference claim is made about a resolvable pointer",
     txt(conv(ZOD3, "gemini")).indexOf("there is nothing at that location") === -1);

  // --- 2. escaped names: the other spelling the raw capture missed ---------
  var ESCAPED = {
    type: "object", required: ["p", "q"],
    "$defs": { "a/b": { type: "string", minLength: 2 }, "with space": { type: "integer" } },
    properties: { p: { "$ref": "#/$defs/a~1b" }, q: { "$ref": "#/$defs/with%20space" } }
  };
  var rEsc = conv(ESCAPED, "gemini");
  ok("#378 an RFC 6901 escaped name resolves (`~1` is `/`)",
     blk(rEsc).length === 0 && !!node(rEsc, "properties.p") &&
     node(rEsc, "properties.p").type === "string");
  ok("#378 a URI-escaped name resolves (`%20` is a space)",
     !!node(rEsc, "properties.q") && node(rEsc, "properties.q").type === "integer");

  // --- 3. THE DISCRIMINATOR ------------------------------------------------
  // A PAIR describing the same cycle, differing only in how one edge is
  // spelled. Without it the rule could be firing on any recursive schema at
  // all and every other assertion here would still pass (#364/#366).
  var CYC_DIRECT = {
    "$defs": {
      T: { type: "object", properties: { x: { "$ref": "#/$defs/U" } }, required: ["x"] },
      U: { type: "object", properties: { y: { "$ref": "#/$defs/T" } }, required: ["y"] }
    },
    type: "object", properties: { u: { "$ref": "#/$defs/U" } }, required: ["u"]
  };
  var CYC_PTR = {
    "$defs": {
      T: { type: "object", properties: { x: { "$ref": "#/$defs/U" } }, required: ["x"] },
      U: { type: "object", properties: { y: { "$ref": "#/$defs/T/properties/x" } }, required: ["y"] }
    },
    type: "object", properties: { u: { "$ref": "#/$defs/U" } }, required: ["u"]
  };
  // The direct half passes BOTH ways — which is exactly what makes the pair
  // discriminate rather than merely assert.
  ok("#378 control: a cycle spelled with whole-definition refs is still caught",
     blk(conv(CYC_DIRECT, "gemini-json")).length > 0);
  ok("#378 the SAME cycle with one edge as a pointer INTO a definition is caught too",
     blk(conv(CYC_PTR, "gemini-json")).length > 0);

  // --- 4. the crash: a gate owes a verdict, not a stack trace (#376) -------
  // `decodeURIComponent` throws on a malformed escape. Shipped in #377's own
  // helper, this exited **1** with a `URIError` stack trace and no schema —
  // exit 1 being the code this CLI documents as "commit the output" (#330).
  var MAL = {
    "$defs": { T: { type: "string" } },
    type: "object", properties: { p: { "$ref": "#/$defs/%zz" } }, required: ["p"]
  };
  ["openai", "anthropic", "anthropic-json", "anthropic-go", "gemini",
   "gemini-json", "gemini-client", "openai-nonstrict"].forEach(function (t) {
    ok("#378 " + t + ": a malformed percent-escape returns a verdict, not a throw",
       conv(MAL, t).threw === undefined);
  });
  // …and it still fails CLOSED: `%zz` names no definition, so the pointer is
  // genuinely dangling and the strict target says so rather than inventing one.
  ok("#378 a genuinely unresolvable pointer is still a blocker",
     blk(conv(MAL, "openai")).length > 0);

  // --- 5. over-block guards: these must hold BOTH ways ---------------------
  var PLAIN = { type: "object", properties: { a: { type: "string" } },
                required: ["a"], additionalProperties: false };
  ok("#378 guard: an ordinary object is untouched on every target",
     ["openai", "anthropic", "gemini", "gemini-json"].every(function (t) {
       var r = conv(PLAIN, t);
       return blk(r).length === 0 && !!node(r, "properties.a");
     }));
  var ORPHAN = {
    type: "object", properties: { a: { type: "string" } }, required: ["a"],
    "$defs": { Unused: { type: "number" } }, additionalProperties: false
  };
  ok("#378 guard: a genuinely orphaned definition is still pruned",
     (function () { var r = conv(ORPHAN, "openai");
       return !!r.schema && r.schema.$defs === undefined; })());
  ok("#378 guard: a pointer outside a definition bag is not inlined",
     blk(conv({ type: "object", required: ["p"],
                properties: { p: { "$ref": "#/properties/p" } } }, "gemini")).length > 0);
  ok("#378 guard: an absolute-URI $ref is not treated as local",
     blk(conv({ type: "object", required: ["p"], "$defs": { T: { type: "string" } },
                properties: { p: { "$ref": "http://x/#/$defs/T" } } }, "gemini")).length > 0);
  // A pointer into a definition must NOT be read as recursion just because it
  // shares a first token with the definition being inlined — that is why the
  // cycle identity is the whole pointer and not the name.
  ok("#378 guard: a self-contained pointer into the definition being inlined is not recursion",
     blk(conv({ "$ref": "#/$defs/T",
                "$defs": { T: { type: "object", required: ["name", "alias"],
                  properties: { name: { type: "string" },
                                alias: { "$ref": "#/$defs/T/properties/name" } } } } },
              "gemini")).length === 0);
})();

/* ------------------------------------------------------------------ #379
   A definition NAME may contain "/" — zod-to-json-schema passes the caller's
   name through unescaped — so a `$ref` tail is ambiguous between "one name
   with slashes" and "a pointer into a definition", and BOTH spellings come out
   of ONE `zodToJsonSchema(S, "v1/User")` call. Five readers each picked one
   reading. Resolution must be document-driven: longest literal key, then walk.
   Every read is routed through guarded helpers first, because a reverted
   engine must REPORT these as failures rather than abort the file (#322). */
(function () {
  function conv(sch, p) { return E.convert(JSON.parse(JSON.stringify(sch)), p); }
  function led(r) { return (r && Array.isArray(r.ledger)) ? r.ledger : []; }
  function blk(r) { return led(r).filter(function (l) { return l.op === "!" && !l.advisory; }); }
  function sch(r) { return (r && r.schema && typeof r.schema === "object") ? r.schema : {}; }
  function txt(r) { return led(r).map(function (l) { return String(l.msg); }).join(" | "); }
  function at(o, path) {
    var cur = o;
    for (var i = 0; i < path.length; i++) {
      if (!cur || typeof cur !== "object") return undefined;
      if (!Object.prototype.hasOwnProperty.call(cur, path[i])) return undefined;
      cur = cur[path[i]];
    }
    return cur;
  }

  // VERBATIM `zod-to-json-schema@3.24.5` output for
  //   const Inner = z.object({ one: z.string().min(3) });
  //   zodToJsonSchema(z.object({ inner: Inner, echo: Inner.shape.one }), NAME)
  // measured 2026-08-10 on zod 3. Note the definition key and the two `$ref`s:
  // the name is reproduced EXACTLY as passed, slash and all.
  function zodOut(name) {
    return {
      "$ref": "#/definitions/" + name,
      "definitions": {
        [name]: {
          "type": "object",
          "properties": {
            "inner": { "type": "object",
              "properties": { "one": { "type": "string", "minLength": 3 } },
              "required": ["one"], "additionalProperties": false },
            "echo": { "$ref": "#/definitions/" + name + "/properties/inner/properties/one" }
          },
          "required": ["inner", "echo"], "additionalProperties": false
        }
      },
      "$schema": "http://json-schema.org/draft-07/schema#"
    };
  }

  // THE DISCRIMINATOR. The two documents describe the SAME schema and differ
  // only in whether the definition name contains a "/". Before the fix the
  // slash form was exit 3 on `openai`/`gemini` (a FALSE dangling blocker) while
  // the plain form was exit 1. A test on the plain name alone passes either way.
  ["openai", "anthropic-json", "anthropic-go", "gemini"].forEach(function (t) {
    var plain = conv(zodOut("S"), t), slash = conv(zodOut("v1/User"), t);
    ok("#379 " + t + ": a definition name containing `/` does not change the verdict",
       blk(plain).length === blk(slash).length);
  });
  // RECOGNISING THE NAME IS NOT ENOUGH — THE POINTER MUST RESOLVE FOR SOMEBODY
  // ELSE. `toStrictJsonSchema()` (openai@7.4.0) is a strict RFC 6901 reader and
  // THROWS on `#/$defs/v1/User`; measured, it ACCEPTS `#/$defs/v1~1User`, and
  // the definition KEY may stay as it is. So the repair is an escape, and
  // without it we would emit a document the vendor still rejects while telling
  // the user to commit it (#330).
  (function () {
    var out = sch(conv(zodOut("v1/User"), "openai"));
    var echo = at(out, ["$defs", "v1/User", "properties", "echo", "$ref"]) ||
               at(out, ["properties", "echo", "$ref"]);
    ok("#379 a pointer through a slash-containing name is ESCAPED, not left broken",
       typeof echo === "string" && echo.indexOf("~1") !== -1);
    ok("#379 ...and the definition KEY is left exactly as the generator wrote it",
       !!at(out, ["$defs", "v1/User"]));
    ok("#379 guard: a name needing no escape is not rewritten",
       String(at(sch(conv(zodOut("S"), "openai")), ["$defs", "S", "properties", "echo", "$ref"]) ||
              at(sch(conv(zodOut("S"), "openai")), ["properties", "echo", "$ref"]) || "")
         .indexOf("~1") === -1);
  })();
  ok("#379 a slash-named definition is not reported as dangling",
     txt(conv(zodOut("v1/User"), "openai")).indexOf("nothing at that location") === -1);
  ok("#379 control: the same reader still reports a GENUINELY dangling pointer",
     txt(conv({ type: "object", additionalProperties: false, required: ["a"],
                properties: { a: { "$ref": "#/$defs/Gone" } } }, "openai"))
       .indexOf("nothing at that location") !== -1);

  // The pruner attributed the surviving pointer to a definition called "v1"
  // (the first token), so the definition actually called "v1/User" looked
  // unreferenced and was DELETED — leaving the pointer to it in the output, at
  // exit 1, and re-checking that output returned 0. #320's inversion.
  (function () {
    var out = sch(conv(zodOut("v1/User"), "anthropic-json"));
    ok("#379 the slash-named definition SURVIVES conversion",
       !!at(out, ["$defs", "v1/User"]));
    ok("#379 the surviving pointer still RESOLVES in our own output",
       at(out, ["$defs", "v1/User", "properties", "inner", "properties", "one", "type"]) === "string");
  })();

  // A pointer INTO a definition, at the ROOT. `rootRefTarget` carried the
  // greedy regex and used the capture raw as a key, so it read this as a
  // definition literally named "T/properties/one", found none, and left the
  // root uninlined — then blamed the caller with "nothing left to inline",
  // which is false of a document whose pointer resolves.
  (function () {
    var doc = { "$ref": "#/$defs/T/properties/one",
      "$defs": { T: { type: "object", additionalProperties: false, required: ["one"],
        properties: { one: { type: "object", additionalProperties: false,
          required: ["x"], properties: { x: { type: "string" } } } } } } };
    var r = conv(doc, "openai");
    ok("#379 a ROOT pointer into a definition is inlined", sch(r).type === "object");
    ok("#379 ...and its content arrives", at(sch(r), ["properties", "x", "type"]) === "string");
    ok("#379 ...and the false 'nothing left to inline' blocker is gone",
       txt(r).indexOf("nothing left to inline") === -1);
  })();

  // Escaped and percent-encoded names at the root, both ordinary RFC 6901.
  ["a~1b", "with%20space"].forEach(function (spelling) {
    var name = spelling === "a~1b" ? "a/b" : "with space";
    var doc = { "$ref": "#/$defs/" + spelling,
      "$defs": {} };
    doc.$defs[name] = { type: "object", additionalProperties: false,
      required: ["x"], properties: { x: { type: "string" } } };
    ok("#379 root `$ref` `" + spelling + "` resolves to the definition it names",
       sch(conv(doc, "openai")).type === "object");
  });

  // `__proto__` is not a definition. A plain `bag[name]` lookup answers with
  // `Object.prototype` — an object, so it passes every shape test — and the
  // root inliner replaced the whole document with it, reporting "Inlined the
  // root `$ref`" and emitting `{}`. The NESTED position, which already used
  // `hasOwnProperty`, said "there is nothing at that location" about the SAME
  // pointer: two positions, one reference, opposite verdicts (#372's tell).
  (function () {
    var doc = { "$ref": "#/$defs/__proto__",
      "$defs": { T: { type: "object", properties: { x: { type: "string" } } } } };
    var r = conv(doc, "openai");
    ok("#379 a `$ref` at an inherited name is NOT reported as inlined",
       txt(r).indexOf("Inlined the root `$ref`") === -1);
    ok("#379 ...it is reported as dangling, as the nested position always did",
       txt(r).indexOf("nothing at that location") !== -1);
    ok("#379 ...and the document is not replaced by `Object.prototype`",
       !!at(sch(r), ["$defs", "T"]));
    var nested = conv({ type: "object", additionalProperties: false, required: ["p"],
      properties: { p: { "$ref": "#/$defs/__proto__" } },
      "$defs": { T: { type: "object" } } }, "openai");
    ok("#379 the ROOT and NESTED positions now agree about the same pointer",
       (txt(r).indexOf("nothing at that location") !== -1) ===
       (txt(nested).indexOf("nothing at that location") !== -1));
  })();

  // An `allOf` member pointing INTO a definition: #371's merge resolves a bare
  // `$ref` member before deciding mergeability, and could not read this one, so
  // the flatten lifted a raw `$ref` up beside `type`/`properties` and blocked —
  // offering a remedy ("write the `$ref` without the `allOf` wrapper and we
  // will inline it") that used the SAME unreadable function.
  (function () {
    var doc = { type: "object", required: ["a"], properties: { a: { type: "string" } },
      "allOf": [{ "$ref": "#/$defs/B/properties/inner" }],
      "$defs": { B: { type: "object", properties: { inner: { type: "object",
        required: ["b"], properties: { b: { type: "string" } } } } } } };
    ok("#379 an `allOf` member pointing into a definition is resolved",
       txt(conv(doc, "openai")).indexOf("Resolved 1 `$ref` member") !== -1);
  })();

  // OVER-BLOCK GUARDS — these hold both before and after, and are stated as
  // guards rather than counted as new coverage.
  ok("#379 guard: a whole-definition root `$ref` still inlines",
     sch(conv({ "$ref": "#/$defs/T", "$defs": { T: { type: "object",
       additionalProperties: false, required: ["x"],
       properties: { x: { type: "string" } } } } }, "openai")).type === "object");
  ok("#379 guard: an ordinary closed object is untouched on openai",
     blk(conv({ type: "object", additionalProperties: false, required: ["a"],
                properties: { a: { type: "string" } } }, "openai")).length === 0);
  ok("#379 guard: a pointer at a name that exists nowhere still fails closed",
     conv({ "$ref": "#/$defs/Nope", "$defs": { T: { type: "object" } } }, "openai").schema.$ref
       === "#/$defs/Nope");
})();


// ---------------------------------------------------------------------------
// #380 — a property name is an arbitrary string, and `k in obj` walks the
// prototype chain. Every "does this already declare k?" test answered YES for
// `toString`/`constructor`/`valueOf`, so the tool invented collisions that the
// document does not contain and blocked on them, and the narrow Gemini strip
// treated such a key as an allowlist member and leaked it onto the wire.
// Reachability measured on pydantic==2.13.4: a field named `toString` or
// `constructor` is emitted verbatim. Helpers are re-declared and GUARDED so a
// reverted engine REPORTS rather than aborting the file (#322).
(function () {
  function conv(sch, p) {
    try { return E.convert(JSON.parse(JSON.stringify(sch)), p); } catch (e) { return { ledger: [], schema: {} }; }
  }
  function led(r) { return (r && Array.isArray(r.ledger)) ? r.ledger : []; }
  function blk(r) { return led(r).filter(function (l) { return l.op === "!" && !l.advisory; }); }
  function sch(r) { return (r && r.schema && typeof r.schema === "object") ? r.schema : {}; }
  function propsOf(o) { return (o && isObj(o.properties)) ? Object.keys(o.properties) : []; }
  function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
  function outer(r) {
    var s = sch(r);
    return (isObj(s.properties) && isObj(s.properties.outer)) ? s.properties.outer : {};
  }
  var allOfCase = function (p) {
    return { type: "object", additionalProperties: false, required: ["outer"], properties: { outer: {
      type: "object", required: ["own"], properties: { own: { type: "string" } },
      allOf: [{ type: "object", required: [p], properties: (function () { var o = {}; o[p] = { type: "integer" }; return o; })() }] } } };
  };
  var refCase = function (p) {
    var props = {}; props[p] = { type: "string" };
    return { type: "object", additionalProperties: false, required: ["outer"], properties: { outer: {
      type: "object", required: [p], properties: props, "$ref": "#/$defs/Base" } },
      "$defs": { Base: { type: "object", required: ["b"], properties: { b: { type: "integer" } } } } };
  };

  // THE DISCRIMINATOR: the `zzz` row passes both before and after, which is
  // exactly what makes the prototype-named rows discriminate rather than assert.
  ["zzz", "toString", "constructor", "valueOf", "hasOwnProperty"].forEach(function (p) {
    var r = conv(allOfCase(p), "openai");
    ok("#380 allOf: a member property named `" + p + "` merges, not a false clash",
       blk(r).length === 0 && propsOf(outer(r)).indexOf(p) !== -1 &&
       propsOf(outer(r)).indexOf("own") !== -1);
    var r2 = conv(refCase(p), "openai");
    ok("#380 $ref: a node property named `" + p + "` merges with the referent",
       blk(r2).length === 0 && propsOf(outer(r2)).indexOf(p) !== -1 &&
       propsOf(outer(r2)).indexOf("b") !== -1);
  });

  // OVER-BLOCK GUARDS — a GENUINE duplicate with different shapes must still
  // block on both paths. Without these the fix could be "never clash at all".
  var gAll = { type: "object", additionalProperties: false, required: ["outer"], properties: { outer: {
    type: "object", required: ["dup"], properties: { dup: { type: "string" } },
    allOf: [{ type: "object", required: ["dup"], properties: { dup: { type: "integer" } } }] } } };
  ok("#380 guard: a genuine allOf clash still blocks", blk(conv(gAll, "openai")).length > 0);
  var gRef = { type: "object", additionalProperties: false, required: ["outer"], properties: { outer: {
    type: "object", required: ["dup"], properties: { dup: { type: "string" } }, "$ref": "#/$defs/Base" } },
    "$defs": { Base: { type: "object", required: ["dup"], properties: { dup: { type: "integer" } } } } };
  ok("#380 guard: a genuine $ref clash still blocks", blk(conv(gRef, "openai")).length > 0);

  // The narrow Gemini path is a proto with a closed field set, so a leaked key
  // is a hard 400 -- measured live, and handed back at exit 1 ("commit this").
  var unknownKw = function (k) {
    var o = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } };
    o[k] = { bogus: true }; return o;
  };
  ["frobnicate", "toString", "constructor", "valueOf"].forEach(function (k) {
    var out = sch(conv(unknownKw(k), "gemini"));
    ok("#380 gemini: unknown keyword `" + k + "` is stripped from the proto payload",
       Object.keys(out).indexOf(k) === -1);
  });

  // The `definitions` -> `$defs` rename used the same `in` test, so a
  // definition named `toString` was never copied and its pointers dangled.
  var ren = { type: "object", required: ["a"], properties: { a: { "$ref": "#/definitions/toString" } },
    definitions: { toString: { type: "string", minLength: 3 } } };
  var renOut = sch(conv(ren, "openai"));
  ok("#380 rename: a definition named `toString` survives definitions -> $defs",
     JSON.stringify(renOut).indexOf("minLength") !== -1);

  // Control: an ordinary schema must be untouched by all of the above.
  var plain = conv({ type: "object", additionalProperties: false, required: ["a"],
                     properties: { a: { type: "string" } } }, "openai");
  ok("#380 control: an ordinary closed object is still clean", blk(plain).length === 0);
})();

// ---------------------------------------------------------------------------
// #381: a property may be called `__proto__`, and WRITING one deletes it.
//
// #380 fixed the READ half (`k in obj`, `TABLE[k]`) and left the WRITE half.
// `o[k] = v` creates an own property for every JSON key except `__proto__`,
// which is an inherited ACCESSOR: the assignment invokes its setter, sets the
// object's prototype, and creates no property at all. `resolveRefSiblings`
// rebuilds every node with `out[k] = visit(node[k])`, so ANY document carrying
// a `$ref` lost a property (or a definition) named `__proto__` outright while
// `required` went on naming it -- six of ten targets, five at ZERO blockers.
//
// Fixtures are built from JSON TEXT on purpose: a JS object literal with a
// `__proto__:` key is ALSO the prototype-setter syntax, so a hand-written
// fixture loses the property before the engine ever sees it.
(function () {
  function led(r) { return (r && Array.isArray(r.ledger)) ? r.ledger : []; }
  function blk(r) { return led(r).filter(function (l) { return l.op === "!" && !l.advisory; }); }
  function sch(r) { return (r && r.schema && typeof r.schema === "object") ? r.schema : {}; }
  function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
  function propsOf(r) { var s = sch(r); return isObj(s.properties) ? Object.keys(s.properties) : []; }
  function convText(txt, p) { return E.convert(JSON.parse(txt), p); }
  var ALL = ["openai", "openai-nonstrict", "openai-realtime", "anthropic", "anthropic-json",
             "anthropic-json-python", "anthropic-go", "gemini", "gemini-json", "gemini-client"];

  // A `$ref` with a sibling is what makes the node rebuild run. Without one the
  // bug does not fire at all, which is why 1268 assertions never caught it.
  var REF_DOC = '{"type":"object","properties":{"own":{"type":"string"},' +
    '"__proto__":{"type":"string","minLength":3},' +
    '"r":{"$ref":"#/$defs/T","description":"d"}},' +
    '"required":["own","__proto__","r"],"additionalProperties":false,' +
    '"$defs":{"T":{"type":"object","properties":{"z":{"type":"string"}},' +
    '"required":["z"],"additionalProperties":false}}}';

  // THE DISCRIMINATOR: the same document with the property renamed. Without this
  // pair the assertions below could pass on a build that simply never rebuilds.
  var CTL_DOC = REF_DOC.replace(/__proto__/g, "zzz");

  ALL.forEach(function (t) {
    var got = propsOf(convText(REF_DOC, t));
    var want = propsOf(convText(CTL_DOC, t));
    ok("#381 " + t + ": a `__proto__` property survives the node rebuild",
       got.indexOf("__proto__") !== -1);
    ok("#381 " + t + ": it survives exactly as the ordinary-name control does",
       got.length === want.length);
  });

  // The deletion also MANUFACTURED a blocker: `required` still named the
  // property we had just removed, so #330's required-mismatch rule fired on
  // openai and blamed the caller for a mismatch we created.
  ok("#381 openai: no manufactured required-mismatch blocker",
     blk(convText(REF_DOC, "openai")).length === 0);

  // The write half's failure set is EXACTLY `__proto__`: every other
  // Object.prototype member is a DATA property and assigns fine. Pinned so a
  // later cycle does not widen `setOwn` on a guess.
  ["toString", "constructor", "valueOf", "hasOwnProperty"].forEach(function (n) {
    var doc = REF_DOC.replace(/__proto__/g, n);
    ok("#381 a property named `" + n + "` was never affected (data property)",
       propsOf(convText(doc, "openai")).indexOf(n) !== -1);
  });

  // The `$defs` bag is the same defect one container over: the bag came back
  // EMPTY while the `$ref` to it stayed in the output -- a dangling pointer at
  // zero blockers (#320's inversion, #342's dangling ref).
  var DEF_DOC = '{"type":"object","properties":{"a":{"$ref":"#/$defs/__proto__"}},' +
    '"required":["a"],"additionalProperties":false,' +
    '"$defs":{"__proto__":{"type":"string","minLength":3}}}';
  ["anthropic-json", "anthropic-go", "gemini-json", "openai-nonstrict"].forEach(function (t) {
    var s = sch(convText(DEF_DOC, t));
    var bag = isObj(s.$defs) ? s.$defs : (isObj(s.definitions) ? s.definitions : null);
    ok("#381 " + t + ": a definition named `__proto__` is not pruned as unreferenced",
       !!bag && Object.prototype.hasOwnProperty.call(bag, "__proto__"));
  });

  // OVER-BLOCK GUARDS -- these hold both ways and are stated as guards, not as
  // new coverage. A genuinely dangling pointer must STILL be caught: the fix
  // must not turn the pruner into something that keeps everything.
  var DANGLING = '{"type":"object","properties":{"a":{"$ref":"#/$defs/__proto__"}},' +
    '"required":["a"],"additionalProperties":false,"$defs":{"other":{"type":"string"}}}';
  ok("#381 guard: a genuinely unresolvable `#/$defs/__proto__` still blocks",
     blk(convText(DANGLING, "openai")).length > 0);

  var ORPHAN = '{"type":"object","properties":{"a":{"type":"string"}},' +
    '"required":["a"],"additionalProperties":false,' +
    '"$defs":{"__proto__":{"type":"string"}}}';
  var orphanOut = sch(convText(ORPHAN, "openai"));
  ok("#381 guard: a genuinely orphaned `__proto__` definition is still pruned",
     !orphanOut.$defs || !Object.prototype.hasOwnProperty.call(orphanOut.$defs, "__proto__"));

  var PLAIN = '{"type":"object","properties":{"a":{"type":"string"}},' +
    '"required":["a"],"additionalProperties":false}';
  ok("#381 guard: an ordinary closed object is still clean",
     blk(convText(PLAIN, "openai")).length === 0);

  // Idempotence: the second pass must be byte-identical, so the property is not
  // merely surviving one hop.
  var once = sch(convText(REF_DOC, "openai"));
  var twice = sch(E.convert(JSON.parse(JSON.stringify(once)), "openai"));
  ok("#381 conversion carrying a `__proto__` property is idempotent",
     JSON.stringify(once) === JSON.stringify(twice));
})();

// ---------------------------------------------------------------------------
// #382 -- a PROVIDER NAME is a caller-supplied string too.
//
// #380 fixed every membership read whose key comes from the caller's DOCUMENT,
// #381 the matching writes. Neither asked about the third source of untrusted
// strings: the ARGUMENT on the public API boundary. `CONVERTERS[provider]` is a
// plain lookup, so eight prototype names resolved to inherited functions, the
// `if (!conv)` guard passed, and `convert()` threw a TypeError in five distinct
// ways instead of returning the `{ok:false, error:"Unknown provider: ..."}` it
// documents.
//
// The assertions below deliberately require BOTH halves: the documented shape
// (ok === false AND the exact message prefix) and, separately, that every real
// provider still converts -- without that second half the "fix" could simply be
// "reject everything", which would pass every assertion above it.
(function () {
  var PROTO_NAMES = ["toString", "constructor", "valueOf", "hasOwnProperty",
                     "__proto__", "isPrototypeOf", "propertyIsEnumerable",
                     "toLocaleString"];
  var DOC = { type: "object", properties: { a: { type: "string" } },
              required: ["a"], additionalProperties: false };

  function tryConvert(provider) {
    // Guarded: the whole point is that the pre-fix engine THROWS here, and a
    // throw that escapes aborts the rest of this file -- #322's trap, which has
    // now bitten five cycles. Catching it turns "crashes" into a reported
    // failure so a reverted run still prints a number.
    try {
      var r = E.convert(JSON.parse(JSON.stringify(DOC)), provider);
      return { threw: false, r: r };
    } catch (e) {
      return { threw: true, message: String(e && e.message) };
    }
  }

  PROTO_NAMES.forEach(function (name) {
    var got = tryConvert(name);
    ok("#382 provider `" + name + "` returns the documented error, does not throw",
       !got.threw && got.r && got.r.ok === false &&
       got.r.error.indexOf("Unknown provider: " + name) === 0,
       got.threw ? "threw: " + got.message : JSON.stringify(got.r && got.r.error));
  });

  // The control, and it is what makes the eight rows above a statement about
  // the prototype chain rather than about unknown names in general: an ordinary
  // unknown name took the correct path even before the fix.
  var ctrl = tryConvert("frobnicate");
  ok("#382 CONTROL: an ordinary unknown provider still returns the same error",
     !ctrl.threw && ctrl.r.ok === false &&
     ctrl.r.error.indexOf("Unknown provider: frobnicate") === 0);

  // Non-string arguments reach the same lookup and must not throw either.
  [null, undefined, 123].forEach(function (v) {
    var got = tryConvert(v);
    ok("#382 provider `" + String(v) + "` returns an error rather than throwing",
       !got.threw && got.r && got.r.ok === false &&
       got.r.error.indexOf("Unknown provider:") === 0,
       got.threw ? "threw: " + got.message : "");
  });

  // OVER-BLOCK GUARD. Without this the fix could be "reject every provider".
  var REAL = ["openai", "openai-nonstrict", "openai-realtime", "anthropic",
              "anthropic-json", "anthropic-json-python", "anthropic-go",
              "gemini", "gemini-json", "gemini-client"];
  var allOk = true, firstBad = "";
  REAL.forEach(function (p) {
    var got = tryConvert(p);
    if (got.threw || !got.r || got.r.ok !== true) {
      allOk = false;
      if (!firstBad) firstBad = p + " -> " + (got.threw ? got.message : JSON.stringify(got.r && got.r.error));
    }
  });
  ok("#382 all ten real providers still convert (fix is not 'reject everything')",
     allOk, firstBad);

  // The five `DOCS[provider]` reads inside convert() sit BEHIND the gate, so a
  // provider that gets past it is an own key of the registry. Pinned because a
  // later cycle moving the gate would silently re-open all five.
  ok("#382 every registry key that converts also has an own DOCS entry",
     REAL.every(function (p) {
       return Object.prototype.hasOwnProperty.call(E.DOCS, p);
     }));
})();

// --- dspy 3.3.0 structured outputs (#383) -----------------------------------
//
// Verbatim `_get_structured_outputs_response_format(...).model_json_schema()`
// output, captured by running the REAL function (dspy 3.3.0 / pydantic 2.13.4),
// not hand-written. dspy is the fifth framework measured to produce an emptied
// map and the first whose guard against it is DUPLICATED — `_has_open_ended_mapping`
// at the call site and a "final guard" inside the builder, both testing
// `get_origin(annotation) is dict` on top-level output fields, so both miss the
// same two things: a dict nested inside a model (silently emptied, and OpenAI
// ACCEPTS that verbatim) and a dict under `Optional[...]` (`get_origin` is
// `Union`, the open map survives, and OpenAI THROWS).
//
// Vendor verdicts below are from `toStrictJsonSchema()` (openai@7.4.0) run on
// these exact bytes, with a plain model as the control that must be accepted.
(function () {
  var DSPY_NESTED_DICT = {"$defs":{"Inner":{"properties":{"label":{"title":"Label","type":"string"},"meta":{"additionalProperties":false,"title":"Meta","type":"object","properties":{},"required":[]}},"required":["label","meta"],"title":"Inner","type":"object","additionalProperties":false}},"additionalProperties":false,"properties":{"answer":{"$ref":"#/$defs/Inner"}},"required":["answer"],"title":"DSPyProgramOutputs","type":"object"};
  var DSPY_OPT_DICT = {"additionalProperties":false,"properties":{"answer":{"anyOf":[{"additionalProperties":{"type":"string"},"type":"object"},{"type":"null"}],"title":"Answer"}},"required":["answer"],"title":"DSPyProgramOutputs","type":"object"};
  var DSPY_TUPLE = {"additionalProperties":false,"properties":{"answer":{"maxItems":4,"minItems":4,"prefixItems":[{"type":"integer"},{"type":"integer"},{"type":"integer"},{"type":"integer"}],"title":"Answer","type":"array"}},"required":["answer"],"title":"DSPyProgramOutputs","type":"object"};
  var DSPY_LIST_OF_DICT = {"additionalProperties":false,"properties":{"answer":{"items":{"additionalProperties":false,"type":"object","properties":{},"required":[]},"title":"Answer","type":"array"}},"required":["answer"],"title":"DSPyProgramOutputs","type":"object"};
  var DSPY_TUPLE_NESTED = {"$defs":{"TupInner":{"properties":{"box":{"maxItems":2,"minItems":2,"prefixItems":[{"type":"integer"},{"type":"integer"}],"title":"Box","type":"array"}},"required":["box"],"title":"TupInner","type":"object","additionalProperties":false}},"additionalProperties":false,"properties":{"answer":{"$ref":"#/$defs/TupInner"}},"required":["answer"],"title":"DSPyProgramOutputs","type":"object"};
  var DSPY_SET = {"$defs":{"SetInner":{"properties":{"tags":{"items":{"type":"string"},"title":"Tags","type":"array","uniqueItems":true}},"required":["tags"],"title":"SetInner","type":"object","additionalProperties":false}},"additionalProperties":false,"properties":{"answer":{"$ref":"#/$defs/SetInner"}},"required":["answer"],"title":"DSPyProgramOutputs","type":"object"};
  // The CONTROL, and it is what makes the rows above mean anything: the same
  // shape with a plain `str` where the dict was. dspy's rewrite runs over it
  // identically, the vendor accepts it verbatim, and we must stay silent.
  var DSPY_PLAIN = {"$defs":{"Inner":{"properties":{"label":{"title":"Label","type":"string"},"meta":{"title":"Meta","type":"string"}},"required":["label","meta"],"title":"Inner","type":"object","additionalProperties":false}},"additionalProperties":false,"properties":{"answer":{"$ref":"#/$defs/Inner"}},"required":["answer"],"title":"DSPyProgramOutputs","type":"object"};

  function conv(doc) {
    var r = E.convert(JSON.parse(JSON.stringify(doc)), "openai");
    return (r && r.ledger) ? r : { ok: false, ledger: [], schema: {} };
  }
  function blockers(r) {
    return r.ledger.filter(function (l) { return l.op === "!" && !l.advisory; });
  }
  function emptied(r) {
    return r.ledger.filter(function (l) {
      return l.advisory && l.msg.indexOf("its only legal value is `{}`") !== -1;
    });
  }

  var nested = conv(DSPY_NESTED_DICT);
  ok("#383 dspy nested dict: no blocker (the vendor accepts these bytes verbatim)",
    blockers(nested).length === 0);
  ok("#383 dspy nested dict: the emptied map is reported, at its own path",
    emptied(nested).length === 1 &&
    emptied(nested)[0].path.indexOf("meta") !== -1);
  ok("#383 dspy nested dict: the advisory names dspy and its two-guard cause",
    has(nested.ledger, "dspy 3.3.0's `enforce_required`") &&
    has(nested.ledger, "get_origin(annotation) is dict"));
  ok("#383 dspy nested dict: the advisory gives the measured dspy-specific escape",
    has(nested.ledger, "make the dict a TOP-LEVEL output field"));

  // THE DISCRIMINATOR. Identical document except one property's type. Without
  // it the rule could be firing on any `$defs` model at all and every other
  // assertion here would still pass.
  var plain = conv(DSPY_PLAIN);
  ok("#383 CONTROL dspy plain model: no emptied-map advisory",
    emptied(plain).length === 0);
  ok("#383 CONTROL dspy plain model: no blockers either",
    blockers(plain).length === 0);

  // `Optional[dict[str, str]]` — `get_origin` is `Union`, so BOTH dspy guards
  // miss it and the open map reaches the wire. The vendor throws at
  // `properties/answer/anyOf/0`; we must find it in the same position, which is
  // also the pin that our walk descends `anyOf` members.
  var optDict = conv(DSPY_OPT_DICT);
  ok("#383 dspy Optional[dict] : open map blocked inside the anyOf member",
    blockers(optDict).length === 1 &&
    blockers(optDict)[0].path.indexOf("anyOf[0]") !== -1);
  ok("#383 dspy Optional[dict] : blocker names the open map",
    has(optDict.ledger, "This is an open map"));

  // `tuple` and `set` are NOT open mappings, so no open-mapping preflight can
  // see them; they survive dspy's rewrite and the vendor rejects both. Ours are
  // repairs rather than blockers, and the tuple one is lossless.
  var tup = conv(DSPY_TUPLE);
  ok("#383 dspy tuple: collapsed losslessly, no blocker",
    blockers(tup).length === 0 &&
    at(tup, "schema.properties.answer.prefixItems") === undefined &&
    at(tup, "schema.properties.answer.items.type") === "integer" &&
    at(tup, "schema.properties.answer.minItems") === 4 &&
    at(tup, "schema.properties.answer.maxItems") === 4);

  var tupNested = conv(DSPY_TUPLE_NESTED);
  ok("#383 dspy tuple nested in $defs: collapsed there too",
    at(tupNested, "schema.$defs.TupInner.properties.box.prefixItems") === undefined &&
    at(tupNested, "schema.$defs.TupInner.properties.box.minItems") === 2);

  var set = conv(DSPY_SET);
  ok("#383 dspy set: uniqueItems removed and named",
    at(set, "schema.$defs.SetInner.properties.tags.uniqueItems") === undefined &&
    has(set.ledger, "uniqueItems"));

  var listOfDict = conv(DSPY_LIST_OF_DICT);
  ok("#383 dspy list[dict]: the emptied map under `items` is reported too",
    emptied(listOfDict).length === 1);
})();

// --- #384 outlines-core: a CONSUMER target (enforcement, not acceptance) ----
//
// Every fixture below is the VERBATIM shape measured against outlines-core
// 0.2.14 on 2026-08-10 by building the regex and asking whether a violating
// instance still matches. The suite is dependency-free and cannot run Rust, so
// these pin a MEASURED SNAPSHOT rather than re-deriving it.
(function () {
  function conv(sch, p) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), p || "outlines") || {};
    if (!r.schema) r.schema = {};
    if (!r.ledger) r.ledger = [];
    return r;
  }
  function pat(sch) {
    var r = conv(sch);
    return (r.schema && r.schema.properties && r.schema.properties.v &&
            r.schema.properties.v.pattern);
  }
  function strOf(p) {
    return { type: "object", properties: { v: { type: "string", pattern: p } },
             required: ["v"], additionalProperties: false };
  }
  // A converter that does not exist returns no schema, so every nested read here
  // goes through a guard. Without it the reverted run ABORTS on the first
  // assertion and hides how many of the rest actually depend on the change
  // (#322's trap — the sixth cycle it has bitten).
  function propOf(r, k) {
    return (r && r.schema && r.schema.properties && r.schema.properties[k]) || {};
  }
  function blockers(r) {
    return r.ledger.filter(function (l) { return l.op === "!" && !l.advisory; });
  }
  function advisories(r) {
    return r.ledger.filter(function (l) { return l.advisory; });
  }

  // 1. THE FATAL CASE. `cat|dog` compiles to `("cat|dog")`, which parses as
  //    `"cat` OR `dog"` — so the guide accepts ONLY malformed JSON. Repaired
  //    losslessly with a non-capturing group; verified against outlines-core
  //    that the repaired form accepts 2/2 valid documents where raw accepts 0/2.
  ok("#384 outlines: top-level alternation is wrapped in (?:...)",
    pat(strOf("cat|dog")) === "(?:cat|dog)");

  // The reachability point, and the one that makes this worth a target: the
  // ANCHORED spelling is hit exactly as hard, because outlines strips `^`/`$`
  // as a pair FIRST and that is what creates the bare alternation.
  ok("#384 outlines: the anchored spelling ^GET|POST$ is hit identically",
    pat(strOf("^GET|POST$")) === "(?:GET|POST)");

  // THE DISCRIMINATOR. Without this the rule could be firing on any `|` at all
  // and every other assertion here would still pass.
  ok("#384 outlines: an ALREADY-grouped alternation is left alone",
    pat(strOf("(cat|dog)")) === "(cat|dog)");
  ok("#384 outlines: `|` inside a character class is not top-level",
    pat(strOf("[a|b]+")) === "[a|b]+");
  ok("#384 outlines: an escaped \\| is not an alternation",
    pat(strOf("a\\|b")) === "a\\|b");
  ok("#384 outlines: a pattern with no alternation is untouched",
    pat(strOf("^[a-z]+$")) === "^[a-z]+$");

  // 2. HALF-ANCHORED. A real failure but a LOUD one (`Index` raises), and which
  //    anchor was meant is not derivable — so it is named, not guessed (#329).
  var half = conv(strOf("^S_"));
  ok("#384 outlines: a leading-only anchor is a blocker",
    blockers(half).length === 1 && has(half.ledger, "anchored at one end only"));
  var halfTrail = conv(strOf("S_$"));
  ok("#384 outlines: a trailing-only anchor is a blocker too",
    blockers(halfTrail).length === 1);
  // Over-block guards: both anchors, or neither, are correct and must be quiet.
  ok("#384 outlines: ^S_$ (both anchors) is NOT a blocker",
    blockers(conv(strOf("^S_$"))).length === 0);
  ok("#384 outlines: an unanchored pattern is NOT a blocker",
    blockers(conv(strOf("S_"))).length === 0);

  // 3. SILENTLY DROPPED. Kept in the document (outlines ignores rather than
  //    errors, so stripping would destroy a constraint that still holds
  //    everywhere else — #314's error-policy rule) and reported as advisory.
  var bounds = conv({
    type: "object",
    properties: { n: { type: "integer", minimum: 10, maximum: 100 } },
    required: ["n"], additionalProperties: false
  });
  ok("#384 outlines: numeric bounds are KEPT, never stripped",
    propOf(bounds, "n").minimum === 10 && propOf(bounds, "n").maximum === 100);
  ok("#384 outlines: numeric bounds are reported as unenforced",
    advisories(bounds).length === 2 && has(bounds.ledger, "does NOT enforce"));
  ok("#384 outlines: an unenforced keyword never fails the gate",
    blockers(bounds).length === 0);

  // 4. THE CONTROL THAT STOPS THIS BEING READ AS "decoders ignore bounds".
  //    `minItems`/`maxItems` and `minProperties` ARE enforced — measured — so a
  //    schema carrying only those must be completely silent. Without this pair
  //    the advisory could be firing on every bound and the rule would look right.
  var enforced = conv({
    type: "object",
    properties: { xs: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 3 } },
    required: ["xs"], additionalProperties: false
  });
  ok("#384 outlines: ENFORCED bounds draw no advisory (the asymmetry control)",
    advisories(enforced).length === 0 && blockers(enforced).length === 0);

  // 4b. THE CORRECTION. `minProperties` looked enforced against a FREE-FORM
  //     object, whose regex rejects `{}` for an unrelated reason — green for the
  //     wrong reason (#362). Measured properly it accepts a ONE-property object.
  //     Pinned with the discriminating instance so it cannot be "restored".
  var minProps = conv({
    type: "object",
    properties: { m: { type: "object", minProperties: 2 } },
    required: ["m"], additionalProperties: false
  });
  ok("#384 outlines: minProperties is DROPPED, not enforced (corrects my own fixture)",
    advisories(minProps).length === 1 && has(minProps.ledger, "minProperties"));

  // 5. REFUSED OUTRIGHT — loud, so safer than the silent set.
  ["allOf", "not", "patternProperties"].forEach(function (k) {
    var sch = { type: "object", properties: { v: {} }, required: ["v"], additionalProperties: false };
    sch.properties.v[k] = k === "allOf" ? [{ type: "string" }] :
      (k === "not" ? { type: "string" } : { "^S_": { type: "string" } });
    ok("#384 outlines: `" + k + "` is a blocker (build_regex raises)",
      blockers(conv(sch)).length >= 1);
  });

  // 6. SCOPE PIN. The alternation rewrite is an outlines fact — no other target
  //    may touch the pattern, or a later cycle will "generalise" it and start
  //    editing schemas for vendors that handle alternation correctly.
  ["openai", "anthropic", "gemini-json"].forEach(function (t) {
    var r = conv(strOf("cat|dog"), t);
    ok("#384 outlines: --to " + t + " leaves the pattern untouched",
      propOf(r, "v").pattern === "cat|dog");
  });

  // 7. The exported tables, so the snapshot is re-diffable rather than trusted.
  var DROPPED = E.OUTLINES_DROPPED_KEYS || [];
  var REJECTED = E.OUTLINES_REJECTED_KEYS || [];
  var ENFORCED = E.OUTLINES_ENFORCED_KEYS || [];
  ok("#384 outlines: dropped table is the 11 measured keywords",
    DROPPED.length === 11 && DROPPED.indexOf("minProperties") !== -1 &&
    DROPPED.indexOf("minimum") !== -1 &&
    DROPPED.indexOf("multipleOf") !== -1 &&
    DROPPED.indexOf("dependentRequired") !== -1);
  ok("#384 outlines: rejected table is the 3 that raise",
    REJECTED.length === 3 && REJECTED.indexOf("patternProperties") !== -1);
  // The three groups must be disjoint — an overlap would mean the same keyword
  // is claimed both enforced and dropped, and the ledger would contradict itself.
  ok("#384 outlines: the three measured groups are disjoint",
    ENFORCED.length > 0 && ENFORCED.every(function (k) {
      return DROPPED.indexOf(k) === -1 && REJECTED.indexOf(k) === -1;
    }));
})();

// ---------------------------------------------------------------------------
// #385 xgrammar: the SECOND consumer target.
//
// Measured 2026-08-10 against xgrammar 0.2.4 with
// Grammar.from_json_schema + testing._is_grammar_accept_string, asking per
// keyword whether a VIOLATING instance is still accepted AND whether a VALID
// one still is. Fixtures below are VERBATIM zod 4.4.3 output (#311).
// ---------------------------------------------------------------------------
(function () {
  function conv(sch, p) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), p) || {};
    if (!r.schema) r.schema = {};
    if (!r.ledger) r.ledger = [];
    return r;
  }
  function msgs(r) { return r.ledger.map(function (l) { return String(l.msg || ""); }).join(" || "); }
  function opsOf(r) { return r.ledger.map(function (l) { return l.op; }).join(""); }

  // VERBATIM zod 4.4.3 `z.record(z.string(), z.string())`.
  var zodRecord = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    type: "object", propertyNames: { type: "string" },
    additionalProperties: { type: "string" }
  };
  // VERBATIM zod 4.4.3 `z.record(z.string().regex(/^[a-z]+$/), z.string())`.
  var zodPatRecord = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    type: "object", propertyNames: { type: "string", pattern: "^[a-z]+$" },
    additionalProperties: { type: "string" }
  };

  // 1. THE HEADLINE. A vacuous `propertyNames` is dropped, and the value schema
  //    it was silently destroying survives. Measured: before, the compiled
  //    grammar accepts {"a":123} and {"a":null}; after, both are rejected.
  var r1 = conv(zodRecord, "xgrammar");
  ok("#385 xgrammar: vacuous propertyNames is dropped",
    !Object.prototype.hasOwnProperty.call(r1.schema, "propertyNames"));
  ok("#385 xgrammar: the value schema it was destroying survives",
    r1.schema.additionalProperties && r1.schema.additionalProperties.type === "string");
  ok("#385 xgrammar: the drop is reported as a fix, not silently",
    opsOf(r1).indexOf("~") !== -1 && has(r1.ledger, "asserted nothing"));

  // 2. A CONSTRAINING propertyNames has a lossless patternProperties form, and
  //    that spelling enforces BOTH key and value. Measured: before, a map of
  //    {"n": number} accepts {"ab":"plain"}; after it is rejected.
  var r2 = conv(zodPatRecord, "xgrammar");
  ok("#385 xgrammar: patterned propertyNames is rewritten to patternProperties",
    !Object.prototype.hasOwnProperty.call(r2.schema, "propertyNames") &&
    !!(r2.schema.patternProperties && r2.schema.patternProperties["^[a-z]+$"]));
  ok("#385 xgrammar: the rewrite carries the value schema across",
    !!(r2.schema.patternProperties &&
       r2.schema.patternProperties["^[a-z]+$"] &&
       r2.schema.patternProperties["^[a-z]+$"].type === "string"));
  ok("#385 xgrammar: the rewrite closes the object so the key pattern binds",
    r2.schema.additionalProperties === false);

  // 3. A key constraint with no patternProperties form is NAMED, not guessed
  //    at (#329) — there is no lossless rewrite of `minLength` on a key.
  var r3 = conv({ type: "object", propertyNames: { minLength: 3 },
                  additionalProperties: { type: "string" } }, "xgrammar");
  ok("#385 xgrammar: a non-pattern key constraint is a blocker",
    opsOf(r3).indexOf("!") !== -1 && has(r3.ledger, "no lossless rewrite"));

  // 4. The alternation bug, confirmed in a second engine. Raw accepts NOTHING
  //    (outlines instead accepts only malformed JSON) — same repair fixes both.
  var alt = { type: "object", properties: { a: { type: "string", pattern: "cat|dog" } },
              required: ["a"], additionalProperties: false };
  var r4 = conv(alt, "xgrammar");
  ok("#385 xgrammar: a top-level alternation is wrapped in a non-capturing group",
    ((r4.schema.properties || {}).a || {}).pattern === "(?:cat|dog)");
  ok("#385 xgrammar: and the reason names the accepts-nothing failure",
    has(r4.ledger, "accepts NO value at all"));

  // 5. Whole-string matching is an ADVISORY, never a gate failure: the result
  //    is narrower than the schema, so nothing invalid is generated.
  var r5 = conv({ type: "object", properties: { a: { type: "string", pattern: "^S_" } },
                  required: ["a"], additionalProperties: false }, "xgrammar");
  ok("#385 xgrammar: a non-anchored pattern draws the whole-string advisory",
    has(r5.ledger, "WHOLE string"));
  ok("#385 xgrammar: that advisory never fails the gate",
    r5.ledger.filter(function (l) { return has([l], "WHOLE string"); })
             .every(function (l) { return l.advisory === true; }));

  // 6. `allOf` is conditional on MEMBER COUNT, which a flat keyword list cannot
  //    express (#318). One member is enforced; two are not.
  var r6a = conv({ allOf: [{ type: "string" }, { minLength: 3 }] }, "xgrammar");
  var r6b = conv({ allOf: [{ type: "string", minLength: 3 }] }, "xgrammar");
  ok("#385 xgrammar: a 2-member allOf is reported as unenforced",
    has(r6a.ledger, "still ongoing"));
  ok("#385 xgrammar: a 1-member allOf is NOT reported (it is enforced)",
    !has(r6b.ledger, "still ongoing"));

  // 7. The silent set is KEPT, never stripped (#314's error-policy rule).
  var r7 = conv({ type: "array", items: { type: "integer" }, uniqueItems: true }, "xgrammar");
  ok("#385 xgrammar: uniqueItems is kept, not stripped",
    r7.schema.uniqueItems === true);
  ok("#385 xgrammar: and is reported as unenforced",
    has(r7.ledger, "does NOT enforce"));

  // ---- guards that must hold BOTH ways (over-blocking protection) ----------

  // 8. Declared `properties` are undamaged by propertyNames (measured), so the
  //    rule must not fire on an ordinary object.
  var g1 = conv({ type: "object", properties: { a: { type: "string" } },
                  required: ["a"], additionalProperties: false }, "xgrammar");
  ok("#385 xgrammar [guard]: an ordinary closed object draws no propertyNames entry",
    !has(g1.ledger, "propertyNames"));

  // 9. propertyNames with NO additionalProperties has nothing to destroy —
  //    measured correct — so it must be left alone.
  var g2 = conv({ type: "object", propertyNames: { type: "string" } }, "xgrammar");
  ok("#385 xgrammar [guard]: propertyNames with no value schema is untouched",
    !!g2.schema.propertyNames);

  // 10. A fully anchored pattern is compiled correctly and must draw nothing.
  var g3 = conv({ type: "object", properties: { a: { type: "string", pattern: "^[a-z]+$" } },
                  required: ["a"], additionalProperties: false }, "xgrammar");
  ok("#385 xgrammar [guard]: a fully anchored pattern draws no advisory",
    !has(g3.ledger, "WHOLE string"));

  // 11. An already-grouped alternation works in xgrammar (measured) and must
  //     not be re-wrapped, or the rule is firing on any `|` at all.
  var g4 = conv({ type: "object", properties: { a: { type: "string", pattern: "(cat|dog)" } },
                  required: ["a"], additionalProperties: false }, "xgrammar");
  ok("#385 xgrammar [guard]: an already-grouped alternation is left alone",
    ((g4.schema.properties || {}).a || {}).pattern === "(cat|dog)");

  // 12. SCOPE PINS. This is a decoder fact. No vendor-API target may rewrite a
  //     caller's map, or a later cycle will "generalise" it onto destinations
  //     that handle propertyNames correctly.
  ["openai", "anthropic", "gemini-json", "outlines"].forEach(function (t) {
    var r = conv(zodRecord, t);
    ok("#385 xgrammar [scope]: --to " + t + " does not rewrite propertyNames",
      !(r.schema.patternProperties));
  });

  // 13. THE DISCRIMINATOR. Without this the whole target could be an alias of
  //     `--to outlines` and every assertion above would still pass. The two
  //     decoders' enforcement sets are measured, and they genuinely disagree:
  //     xgrammar enforces every numeric bound outlines drops.
  var XD = E.XGRAMMAR_DROPPED_KEYS || [];
  var XE = E.XGRAMMAR_ENFORCED_KEYS || [];
  var OD = E.OUTLINES_DROPPED_KEYS || [];
  ok("#385 xgrammar: the dropped table is the 4 measured keywords",
    XD.length === 4 && XD.indexOf("uniqueItems") !== -1 && XD.indexOf("not") !== -1);
  ok("#385 xgrammar: it ENFORCES bounds that outlines silently drops",
    XE.indexOf("minimum") !== -1 && XE.indexOf("multipleOf") !== -1 &&
    XE.indexOf("minProperties") !== -1 &&
    OD.indexOf("minimum") !== -1 && OD.indexOf("multipleOf") !== -1);
  ok("#385 xgrammar: its two groups are disjoint",
    XE.length > 0 && XE.every(function (k) { return XD.indexOf(k) === -1; }));
  // ...and the two decoders must produce genuinely DIFFERENT diagnoses for one
  // document, which is the proof that a second target was warranted at all.
  var bounded = { type: "object", properties: { a: { type: "integer", minimum: 5 } },
                  required: ["a"], additionalProperties: false };
  ok("#385 xgrammar: outlines and xgrammar disagree about the same schema",
    has(conv(bounded, "outlines").ledger, "does NOT enforce") &&
    !has(conv(bounded, "xgrammar").ledger, "does NOT enforce"));
})();

// --- Cycle #386: lm-format-enforcer, the THIRD constrained decoder -----------
// Measured 2026-08-11 against lm-format-enforcer 0.11.3 via JsonSchemaParser fed
// one character at a time. Every row asserts BOTH halves (valid accepted AND
// violating rejected), per #384's correction.
(function () {
  function conv(sch, p) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), p) || {};
    if (!r.schema) r.schema = {};
    if (!r.ledger) r.ledger = [];
    return r;
  }
  function ops(r, op) {
    return r.ledger.filter(function (l) { return l.op === op; }).length;
  }
  var T = "lmformatenforcer";

  // VERBATIM pydantic 2.13.4 output for Field(discriminator="kind") (#311).
  var PYD = {
    "$defs": {
      "Cat": { "properties": { "kind": { "const": "cat", "title": "Kind", "type": "string" },
                               "meow": { "title": "Meow", "type": "integer" } },
               "required": ["kind", "meow"], "title": "Cat", "type": "object" },
      "Dog": { "properties": { "kind": { "const": "dog", "title": "Kind", "type": "string" },
                               "bark": { "title": "Bark", "type": "integer" } },
               "required": ["kind", "bark"], "title": "Dog", "type": "object" }
    },
    "properties": { "pet": {
      "discriminator": { "mapping": { "cat": "#/$defs/Cat", "dog": "#/$defs/Dog" },
                         "propertyName": "kind" },
      "oneOf": [{ "$ref": "#/$defs/Cat" }, { "$ref": "#/$defs/Dog" }], "title": "Pet" } },
    "required": ["pet"], "title": "Pet", "type": "object"
  };

  var r = conv(PYD, T);
  ok("lmfe: pydantic discriminated union has its `oneOf` rewritten to `anyOf`",
    JSON.stringify(r.schema).indexOf('"oneOf"') === -1 &&
    JSON.stringify(r.schema).indexOf('"anyOf"') !== -1);
  ok("lmfe: the rewrite is reported, and names the mechanism rather than the keyword",
    has(r.ledger, "Rewrote `oneOf` to `anyOf`") &&
    has(r.ledger, "without dispatching per member"));

  // SCOPING, measured: a union of INLINE OBJECT members is handled correctly by
  // this engine (it is the shape their own issue #138 was filed about and it
  // still works), so firing there would be an edit that buys nothing (#365).
  var inlineUnion = { oneOf: [
    { type: "object", properties: { kind: { const: "cat" }, meow: { type: "integer" } },
      required: ["kind", "meow"] },
    { type: "object", properties: { kind: { const: "dog" }, bark: { type: "integer" } },
      required: ["kind", "dog"] } ] };
  ok("lmfe: an INLINE-object union is left alone (it already works there)",
    JSON.stringify(conv(inlineUnion, T).schema).indexOf('"oneOf"') !== -1);
  ok("lmfe: ...while the SAME union written with `$ref` members IS repaired",
    JSON.stringify(conv({ $defs: { C: inlineUnion.oneOf[0], D: inlineUnion.oneOf[1] },
      oneOf: [{ $ref: "#/$defs/C" }, { $ref: "#/$defs/D" }] }, T).schema)
      .indexOf('"anyOf"') !== -1);
  ok("lmfe: the discriminator itself survives the rewrite",
    JSON.stringify(r.schema).indexOf("propertyName") !== -1);

  // A union whose branches are NOT provably exclusive has no lossless repair:
  // `anyOf` is at-least-one, so rewriting would widen it (#318's rule).
  var overlap = conv({ oneOf: [{ type: "integer" }, { type: "integer", minimum: 5 }] }, T);
  ok("lmfe: a non-exclusive `oneOf` is a blocker, not a silent widening",
    ops(overlap, "!") >= 1 && has(overlap.ledger, "exactly-one"));
  ok("lmfe: the non-exclusive blocker leaves `oneOf` visible to the reader (#318)",
    JSON.stringify(overlap.schema).indexOf('"oneOf"') !== -1);

  // A scalar union IS provably exclusive (disjoint types) and is repaired.
  var scalar = conv({ oneOf: [{ type: "integer" }, { type: "string" }] }, T);
  ok("lmfe: a disjoint scalar union is repaired rather than blocked",
    ops(scalar, "~") >= 1 && ops(scalar, "!") === 0);

  // The parser constructor RAISES on a keyed schema with no kind. Measured to
  // fire at the root and on allOf members ONLY.
  ok("lmfe: an untyped root is a blocker (JsonSchemaParser raises)",
    ops(conv({ minimum: 10 }, T), "!") >= 1);
  ok("lmfe: an untyped `allOf` member is a blocker",
    has(conv({ allOf: [{ type: "integer" }, { minimum: 10 }] }, T).ledger, "allOf[1]"));

  // CORRECTED #390. These two were #386 over-block guards asserting that a bare
  // `{}` and a nested typeless node are fine on this engine. Both premises are
  // FALSE and both came from the same contaminated measurement: `JsonSchemaParser`
  // is LAZY (#389), so a schema that dies at the property position constructs
  // cleanly. Forced by feeding an instance character by character, BOTH raise
  // `Unsupported type None`. Re-cut onto the measured behaviour rather than
  // deleted, with the reason recorded here so a later cycle changes it deliberately.
  ok("lmfe: a bare {} NESTED is blocked — it raises like any typeless node (#390)",
    ops(conv({ type: "object", properties: { a: {} }, required: ["a"] }, T), "!") >= 1);
  ok("lmfe: the same untyped shape NESTED under `properties` IS blocked (#390)",
    ops(conv({ type: "object", properties: { a: { minimum: 3 } }, required: ["a"] }, T), "!") >= 1);
  // ...and the discriminator that keeps it about CONTENT rather than presence:
  // a non-empty `enum` builds and constrains, an EMPTY one raises (#346).
  ok("lmfe: a non-empty `enum` is NOT blocked",
    ops(conv({ type: "object", properties: { a: { "enum": [1] } }, required: ["a"] }, T), "!") === 0);
  ok("lmfe: an ordinary typed object draws no blocker",
    ops(conv({ type: "object", properties: { a: { type: "integer" } }, required: ["a"] }, T), "!") === 0);

  // THE FALSIFICATION OF #385'S CLASS CLAIM, made executable. Both other
  // decoders splice a pattern between the JSON quote characters, so a top-level
  // alternation binds across them; this engine parses the pattern separately and
  // handles it correctly. Measured: `cat|dog` accepts "cat" AND "dog" AND still
  // rejects "ZZZ9".
  var alt = { type: "string", pattern: "cat|dog" };
  ok("lmfe: a top-level alternation in `pattern` is NOT rewritten here",
    !has(conv(alt, T).ledger, "non-capturing group"));
  ok("lmfe: ...while BOTH other decoders still rewrite it (the discriminator)",
    has(conv(alt, "outlines").ledger, "non-capturing group") &&
    has(conv(alt, "xgrammar").ledger, "non-capturing group"));

  // xgrammar's headline does not reproduce here either.
  var mapNode = { type: "object", propertyNames: {}, additionalProperties: { type: "integer" } };
  ok("lmfe: `propertyNames` does not destroy the sibling value schema here",
    JSON.stringify(conv(mapNode, T).schema).indexOf('"additionalProperties":{"type":"integer"}') !== -1);

  // The silent set, with a POSITIVE CONTROL: without it the advisory could be
  // firing on every keyword and every other assertion would still pass.
  ok("lmfe: `minimum` is flagged unenforced",
    has(conv({ type: "integer", minimum: 10 }, T).ledger, "does NOT enforce it"));
  ok("lmfe: `minLength` is NOT flagged — it is genuinely enforced here",
    !has(conv({ type: "string", minLength: 3 }, T).ledger, "does NOT enforce it"));
  ok("lmfe: ...and xgrammar is the other way round on the numeric bound",
    !has(conv({ type: "integer", minimum: 10 }, "xgrammar").ledger, "does NOT enforce it"));

  // #365's discriminator: the three consumer targets must produce genuinely
  // DIFFERENT diagnoses for one document, or this target is an alias.
  var three = { type: "object", required: ["v", "s"], properties: {
    v: { oneOf: [{ type: "integer" }, { type: "string" }] },
    s: { type: "string", pattern: "cat|dog" } } };
  var a = JSON.stringify(conv(three, "outlines").schema);
  var b = JSON.stringify(conv(three, "xgrammar").schema);
  var c = JSON.stringify(conv(three, T).schema);
  ok("lmfe: the three decoder targets emit genuinely different documents",
    c !== a && c !== b);

  // SCOPE PINS: no other target may acquire this rewrite.
  ["openai", "anthropic", "gemini-json", "outlines", "xgrammar"].forEach(function (p) {
    ok("lmfe: `--to " + p + "` never emits the lm-format-enforcer `oneOf` note",
      !has(conv(PYD, p).ledger, "lm-format-enforcer compiles `oneOf`"));
  });

  // Advisories must never fail the gate (#317's property).
  ok("lmfe: the unenforced-keyword note is advisory",
    conv({ type: "integer", minimum: 10 }, T).ledger.filter(function (l) {
      return l.op === "=" && l.advisory; }).length >= 1);

  ok("lmfe: the measured tables are exported for re-diffing (#361)",
    Array.isArray(E.LMFE_IGNORED_KEYS) && E.LMFE_IGNORED_KEYS.length >= 10 &&
    Array.isArray(E.LMFE_ENFORCED_KEYS) && E.LMFE_ENFORCED_KEYS.indexOf("pattern") !== -1 &&
    E.LMFE_IGNORED_KEYS.indexOf("minimum") !== -1);
})();


// ---- #387: a union `type` is a SECOND SPELLING of a union -----------------
//
// Measured 2026-08-10 against all three decoders, `anyOf` as the control in
// every run. outlines DROPS the non-object members (a narrowing: an optional
// field can never be null); lm-format-enforcer DISCARDS every validation
// sibling (a widening: the object stops being constrained); xgrammar is
// CORRECT and is therefore deliberately not rewritten.
(function () {
  function conv(sch, p) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), p) || {};
    if (!r.schema) r.schema = {};
    if (!r.ledger) r.ledger = [];
    return r;
  }
  function propOf(r, k) {
    return (r.schema && r.schema.properties && r.schema.properties[k]) || {};
  }
  function wrap(node) {
    return { type: "object", properties: { a: node }, required: ["a"],
             additionalProperties: false };
  }
  function branchTypes(n) {
    return Array.isArray(n.anyOf)
      ? n.anyOf.map(function (b) { return b && b.type; }).join(",")
      : null;
  }

  var OBJ_UNION = wrap({ type: ["object", "null"],
                         properties: { n: { type: "integer" } }, required: ["n"] });
  var STR_UNION = wrap({ type: ["string", "null"], minLength: 3 });
  var ARR_UNION = wrap({ type: ["array", "null"], items: { type: "integer" } });
  var BARE_OBJ  = wrap({ type: ["object", "null"] });
  var BARE_STR  = wrap({ type: ["string", "null"] });

  // --- outlines: the measured defect, and ONLY it --------------------------
  var oa = propOf(conv(OBJ_UNION, "outlines"), "a");
  ok("#387 outlines: `[object,null]` + properties is rewritten to `anyOf`",
    branchTypes(oa) === "object,null");
  ok("#387 outlines: the dropped null member comes back as a branch",
    Array.isArray(oa.anyOf) && oa.anyOf.some(function (b) { return b.type === "null"; }));
  ok("#387 outlines: the object branch keeps `properties` AND `required`",
    Array.isArray(oa.anyOf) && oa.anyOf[0] && oa.anyOf[0].properties &&
    oa.anyOf[0].properties.n && oa.anyOf[0].properties.n.type === "integer" &&
    JSON.stringify(oa.anyOf[0].required) === '["n"]');
  ok("#387 outlines: the null branch carries no distributed keywords",
    Array.isArray(oa.anyOf) && oa.anyOf[1] &&
    Object.keys(oa.anyOf[1]).join(",") === "type");

  // OVER-BLOCK GUARDS, each one a shape outlines was MEASURED to handle
  // correctly. Without these the rule could be firing on any union at all.
  ok("#387 outlines: a BARE `[object,null]` is left alone",
    JSON.stringify(propOf(conv(BARE_OBJ, "outlines"), "a").type) === '["object","null"]');
  ok("#387 outlines: `[string,null]` + minLength is left alone (measured correct there)",
    JSON.stringify(propOf(conv(STR_UNION, "outlines"), "a").type) === '["string","null"]');
  ok("#387 outlines: `[array,null]` + items is left alone (measured correct there)",
    JSON.stringify(propOf(conv(ARR_UNION, "outlines"), "a").type) === '["array","null"]');
  ok("#387 outlines: `required` alone does not trigger it (the `properties` KEY does)",
    JSON.stringify(propOf(conv(wrap({ type: ["object", "null"], required: ["n"] }),
      "outlines"), "a").type) === '["object","null"]');
  // Key presence, not size (#346): an EMPTY `properties` drops the member too.
  ok("#387 outlines: an EMPTY `properties: {}` still triggers it",
    branchTypes(propOf(conv(wrap({ type: ["object", "null"], properties: {} }),
      "outlines"), "a")) === "object,null");

  // --- lm-format-enforcer: a WIDER trigger, and that difference is the point
  ok("#387 lmfe: `[object,null]` + properties is rewritten",
    branchTypes(propOf(conv(OBJ_UNION, "lmformatenforcer"), "a")) === "object,null");
  ok("#387 lmfe: `[string,null]` + minLength is rewritten — WIDER than outlines",
    branchTypes(propOf(conv(STR_UNION, "lmformatenforcer"), "a")) === "string,null");
  ok("#387 lmfe: `[array,null]` + items is rewritten",
    branchTypes(propOf(conv(ARR_UNION, "lmformatenforcer"), "a")) === "array,null");
  ok("#387 lmfe: the string branch keeps its minLength",
    (propOf(conv(STR_UNION, "lmformatenforcer"), "a").anyOf || [{}])[0].minLength === 3);
  ok("#387 lmfe: a BARE union is left alone (measured correct there)",
    JSON.stringify(propOf(conv(BARE_STR, "lmformatenforcer"), "a").type) === '["string","null"]');

  // --- THE DISCRIMINATOR (#365): xgrammar handles the union spelling
  //     correctly, so it must NOT be rewritten. Without this the rule could be
  //     firing blanket and every assertion above would still pass.
  ["outlines", "lmformatenforcer"].forEach(function (p) {
    ok("#387 xgrammar vs " + p + ": only " + p + " rewrites the union",
      branchTypes(propOf(conv(OBJ_UNION, p), "a")) === "object,null");
  });
  ok("#387 xgrammar: the union `type` is left EXACTLY as written",
    JSON.stringify(propOf(conv(OBJ_UNION, "xgrammar"), "a").type) === '["object","null"]');
  ok("#387 xgrammar: `[string,null]` + minLength is left alone too",
    JSON.stringify(propOf(conv(STR_UNION, "xgrammar"), "a").type) === '["string","null"]');

  // One file, three decoders, three genuinely different documents.
  var dOut = JSON.stringify(conv(STR_UNION, "outlines").schema);
  var dXg  = JSON.stringify(conv(STR_UNION, "xgrammar").schema);
  var dLm  = JSON.stringify(conv(STR_UNION, "lmformatenforcer").schema);
  ok("#387 one file, three decoders, and the three outputs are NOT aliases",
    dOut === dXg && dLm !== dOut);

  // --- annotations stay OUTSIDE the anyOf (measured fine on both engines) ---
  var ann = propOf(conv(wrap({ type: ["object", "null"], description: "a note",
    properties: { n: { type: "integer" } } }), "outlines"), "a");
  ok("#387 the node keeps its annotation beside `anyOf`",
    ann.description === "a note" && Array.isArray(ann.anyOf));
  ok("#387 the annotation is NOT distributed into the branches",
    Array.isArray(ann.anyOf) && ann.anyOf.every(function (b) {
      return b.description === undefined; }));

  // --- branches must not share a sub-schema reference ----------------------
  var multi = propOf(conv(wrap({ type: ["string", "array"], minLength: 3,
    items: { type: "integer" } }), "lmformatenforcer"), "a");
  ok("#387 a multi-member union distributes to every non-null branch",
    Array.isArray(multi.anyOf) && multi.anyOf.length === 2 &&
    multi.anyOf[0].minLength === 3 && multi.anyOf[1].minLength === 3);
  ok("#387 the branches do not share a sub-schema reference (cloned)",
    Array.isArray(multi.anyOf) && multi.anyOf[0].items !== multi.anyOf[1].items);

  // --- a combinator beside the union is left ALONE, on purpose -------------
  //     Measured: all three decoders ignore the `type` AND its siblings when a
  //     combinator is present — and a SCALAR `type` behaves identically, so
  //     this is a different defect with a different population. Blocking only
  //     the array-valued half would be incoherent. Pinned so a later cycle
  //     changes it deliberately rather than by accident.
  var comb = conv(wrap({ type: ["string", "null"], minLength: 3,
    anyOf: [{ type: "string" }] }), "lmformatenforcer");
  ok("#387 a union `type` beside a combinator is NOT rewritten",
    JSON.stringify(propOf(comb, "a").type) === '["string","null"]');
  ok("#387 ...and draws no blocker (the scalar case is identical and silent)",
    comb.ledger.filter(function (l) { return l.op === "!" && !l.advisory; }).length === 0);

  // --- REACHABILITY PIN: our OWN `--to openai` manufactures the broken shape
  var optObj = { type: "object", additionalProperties: false,
    properties: { a: { type: "object", properties: { n: { type: "integer" } },
      required: ["n"] }, b: { type: "string" } }, required: ["b"] };
  ok("#387 REACHABILITY: `--to openai` emits `[\"object\",\"null\"]` + properties",
    JSON.stringify(propOf(conv(optObj, "openai"), "a").type) === '["object","null"]' &&
    propOf(conv(optObj, "openai"), "a").properties !== undefined);

  // --- SCOPE PINS: no other target may acquire this rewrite ----------------
  ["openai", "anthropic", "anthropic-json", "gemini-json", "openai-nonstrict"]
    .forEach(function (p) {
      ok("#387 `--to " + p + "` does not acquire the decoder union rewrite",
        !has(conv(OBJ_UNION, p).ledger, "is a fact about these two decoders"));
    });

  // --- idempotent: converting our own output changes nothing ---------------
  ["outlines", "lmformatenforcer"].forEach(function (p) {
    var once = conv(OBJ_UNION, p).schema;
    var twice = conv(once, p).schema;
    ok("#387 " + p + ": the rewrite is idempotent",
      JSON.stringify(once) === JSON.stringify(twice));
  });
})();



// ===========================================================================
// #388 — a `$ref` sibling is a constraint the decoder never sees
//
// #371 established that a `$ref` beside constraining siblings is an
// INTERSECTION (draft 2020-12 applies the referent AND the siblings) and wired
// `intersectRef()` to the three JSON-Schema-dialect targets. The three DECODER
// targets were added AFTER it (#384/#385/#386) and never got the merge, so the
// sibling was handed to the decoder as written.
//
// MEASURED, all three engines, with a control that discriminates:
//   xgrammar 0.2.4 / outlines-core 0.2.14 / lm-format-enforcer 0.11.3
//   {$ref: S, minLength: 3}      -> ALL THREE accept "a"   (constraint GONE)
//   {type: string, minLength: 3} -> ALL THREE reject "a"   (constraint HELD)
// The control is what proves the `$ref` is the cause rather than the keyword.
// Round trip from the installed binary: 15 rows FIXED, 0 REGRESSED across
// 5 shapes x 3 engines, every legal instance still generatable.
// ===========================================================================
(function () {
  function conv(sch, p) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), p);
    return r && r.ledger ? r : { schema: {}, ledger: [] };
  }
  function propOf(r, name) {
    var s = r && r.schema;
    if (!s || !s.properties || !s.properties[name]) return {};
    return s.properties[name];
  }
  var DEC = ["outlines", "xgrammar", "lmformatenforcer"];

  function doc(node, bag) {
    var d = {};
    d[bag || "$defs"] = { S: { type: "string" } };
    d.type = "object";
    d.properties = { s: node };
    d.required = ["s"];
    d.additionalProperties = false;
    return d;
  }

  // --- THE DISCRIMINATOR ---------------------------------------------------
  // The merge must happen on the decoder targets AND the result must be the
  // form the engines actually enforce: `type` present, `$ref` gone, constraint
  // kept. Without this the rule could be doing anything at all.
  DEC.forEach(function (p) {
    var s = propOf(conv(doc({ $ref: "#/$defs/S", minLength: 3 }), p), "s");
    ok("#388 " + p + ": merges a constraining `$ref` sibling into the node",
      s.type === "string" && s.minLength === 3 && s.$ref === undefined);
  });

  // Alternate spelling of the BAG. `definitions` is `zod-to-json-schema`'s
  // default, and all three decoders resolve `#/definitions/X` correctly — so
  // the merge must fire AND the bag must NOT be renamed (renaming would be an
  // edit that buys nothing).
  DEC.forEach(function (p) {
    var r = conv(doc({ $ref: "#/definitions/S", minLength: 3 }, "definitions"), p);
    var s = propOf(r, "s");
    ok("#388 " + p + ": merges under the `definitions` spelling too",
      s.type === "string" && s.minLength === 3 && s.$ref === undefined);
    ok("#388 " + p + ": does NOT rename the `definitions` bag",
      r.schema.definitions !== undefined && r.schema.$defs === undefined);
  });

  // Alternate spelling of the WRAPPER: `allOf:[{$ref}]` is the same meaning
  // (the OpenAPI "extend this base" idiom) and is broken IDENTICALLY in all
  // three engines. Shipping one spelling and not the other is the failure this
  // project keeps recording.
  DEC.forEach(function (p) {
    var s = propOf(conv(doc({ allOf: [{ $ref: "#/$defs/S" }], minLength: 3 }), p), "s");
    ok("#388 " + p + ": merges the `allOf:[{$ref}]` spelling of the same shape",
      s.type === "string" && s.minLength === 3 && s.allOf === undefined);
  });

  // --- OVER-BLOCK GUARDS: these hold BOTH ways and are load-bearing --------
  // A pure ANNOTATION beside a `$ref` loses nothing on a decoder (annotations
  // never constrain anywhere), so merging would expand the document and delete
  // the bag for no benefit — the over-edit #363 caught and reverted on the
  // OpenAI path.
  DEC.forEach(function (p) {
    var s = propOf(conv(doc({ $ref: "#/$defs/S", description: "d" }), p), "s");
    ok("#388 " + p + ": leaves an ANNOTATION-only `$ref` sibling alone",
      s.$ref === "#/$defs/S" && s.description === "d" && s.type === undefined);
  });
  DEC.forEach(function (p) {
    var s = propOf(conv(doc({ title: "T", description: "d", allOf: [{ $ref: "#/$defs/S" }] }), p), "s");
    ok("#388 " + p + ": leaves pydantic v1's annotation-only `allOf` wrapper alone",
      Array.isArray(s.allOf) && s.$ref === undefined);
  });

  // The canonical root `zod-to-json-schema` emits. The sibling filter names
  // BOTH bags for exactly this reason: counting `definitions` as a constraining
  // sibling would merge the whole definition map into the referent.
  DEC.forEach(function (p) {
    var zodRoot = {
      $ref: "#/definitions/T",
      definitions: { T: { type: "object", properties: { t: { type: "string" } }, required: ["t"], additionalProperties: false } },
      $schema: "http://json-schema.org/draft-07/schema#"
    };
    var out = conv(zodRoot, p).schema;
    ok("#388 " + p + ": leaves zod's canonical `{$ref, definitions, $schema}` root untouched",
      out.$ref === "#/definitions/T" && out.definitions !== undefined);
  });

  // THE DANGLING-POINTER GUARD, and it is not hypothetical: wiring the merge in
  // also brought its orphan `$defs` pruner along, and the decoder path does not
  // run `normalizeRefSpelling`, so `localDefRefs` read #320's `/$defs/P`
  // spelling as "not a local reference" and DELETED the definition it points
  // at. The bag must survive (#320/#342 fail-closed).
  DEC.forEach(function (p) {
    var unnormalised = {
      $ref: "/$defs/P",
      $defs: { P: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } }
    };
    var out = conv(unnormalised, p).schema;
    ok("#388 " + p + ": keeps a `$defs` bag an unnormalised `/$defs/` ref points at",
      out.$defs !== undefined && out.$defs.P !== undefined);
  });

  // --- SCOPE: the decoder targets now AGREE with the target that already
  //     merged. Without this the three could be merging to some other shape.
  (function () {
    var d = doc({ $ref: "#/$defs/S", minLength: 3 });
    var oa = propOf(conv(d, "openai"), "s");
    DEC.forEach(function (p) {
      var s = propOf(conv(d, p), "s");
      ok("#388 " + p + ": merged shape agrees with `--to openai` (#371's merge)",
        s.type === oa.type && s.minLength === oa.minLength);
    });
  })();

  // A genuinely UNSATISFIABLE intersection stays a blocker. Deliberate: the
  // decoder does not throw, but no instance can satisfy both sides, so there is
  // no valid document being rejected — #370's reasoning, which does not depend
  // on the vendor.
  DEC.forEach(function (p) {
    var unsat = {
      $defs: { T: { type: "object", properties: { b: { type: "string" } }, required: ["b"], additionalProperties: false } },
      type: "object",
      properties: { p: { $ref: "#/$defs/T", properties: { a: { type: "string" } }, required: ["a"] } },
      required: ["p"], additionalProperties: false
    };
    ok("#388 " + p + ": an unsatisfiable `$ref` intersection is still blocked",
      blockers(conv(unsat, p)).length > 0);
  });

  // --- idempotent ----------------------------------------------------------
  DEC.forEach(function (p) {
    var once = conv(doc({ $ref: "#/$defs/S", minLength: 3 }), p).schema;
    var twice = conv(once, p).schema;
    ok("#388 " + p + ": the merge is idempotent",
      JSON.stringify(once) === JSON.stringify(twice));
  });
})();


// --- #389: the three decoders do not implement RFC 6901 ----------------------
//
// MEASURED on xgrammar 0.2.4 / outlines-core 0.2.14 / lm-format-enforcer 0.11.3.
// Each splits a pointer on "/" then looks up every token LITERALLY, proven by
// their own error text (`Cannot find field v1~1Step`, `Invalid reference path:
// v1~1Step`, `KeyError: 'v1~1Step'`). Consequences point OPPOSITE ways: a "~"
// name works RAW (so de-escape), a "/" name works in NO spelling (so rename).
(function () {
  function conv(sch, p) {
    var r = E.convert(sch, p);
    return r && r.ledger ? r : { schema: {}, ledger: [] };
  }
  function refsOf(s) {
    var out = [];
    (function v(x) {
      if (Array.isArray(x)) return x.forEach(v);
      if (!x || typeof x !== "object") return;
      if (typeof x.$ref === "string") out.push(x.$ref);
      Object.keys(x).forEach(function (k) { v(x[k]); });
    })(s);
    return out;
  }
  function defKeys(s, bag) { return Object.keys((s && s[bag]) || {}); }
  function blockers(r) { return r.ledger.filter(function (l) { return l.op === "!"; }); }

  var DEC = ["xgrammar", "outlines", "lmformatenforcer"];
  var JSD = ["openai", "anthropic-json", "gemini-json"];

  function slashDoc(ref) {
    return { type: "object", properties: { b: { $ref: ref } }, required: ["b"],
             additionalProperties: false,
             $defs: { "v1/U": { type: "string", minLength: 3 } } };
  }
  function tildeDoc(ref) {
    return { type: "object", properties: { b: { $ref: ref } }, required: ["b"],
             additionalProperties: false,
             $defs: { "a~b": { type: "string", minLength: 3 } } };
  }

  DEC.forEach(function (p) {
    // A "/" name: BOTH spellings are unreachable, so both must be renamed.
    ["#/$defs/v1~1U", "#/$defs/v1/U"].forEach(function (ref) {
      var r = conv(slashDoc(ref), p);
      ok("#389 " + p + ": renames a `/` definition (" + ref + ")",
        defKeys(r.schema, "$defs").indexOf("v1_U") !== -1 &&
        defKeys(r.schema, "$defs").indexOf("v1/U") === -1);
      ok("#389 " + p + ": repoints to the renamed definition (" + ref + ")",
        refsOf(r.schema).indexOf("#/$defs/v1_U") !== -1);
      ok("#389 " + p + ": the rename is REPORTED, never silent (" + ref + ")",
        has(r.ledger, "Renamed"));
    });

    // A "~" name: the RAW spelling already works, so the spec form is
    // de-escaped and the raw form is left completely alone.
    var esc = conv(tildeDoc("#/$defs/a~0b"), p);
    ok("#389 " + p + ": de-escapes `~0` to the raw spelling",
      refsOf(esc.schema).indexOf("#/$defs/a~b") !== -1);
    ok("#389 " + p + ": the de-escape is REPORTED (a silent edit exits 0)",
      has(esc.ledger, "Un-escaped"));
    ok("#389 " + p + ": a `~` definition is NOT renamed (raw already resolves)",
      defKeys(esc.schema, "$defs").indexOf("a~b") !== -1);

    var raw = conv(tildeDoc("#/$defs/a~b"), p);
    ok("#389 " + p + ": an already-raw `~` pointer is left alone",
      refsOf(raw.schema).indexOf("#/$defs/a~b") !== -1 && raw.ledger.filter(
        function (l) { return String(l.msg || "").indexOf("Un-escaped") !== -1; }).length === 0);

    // The tail of a pointer-INTO must survive the rename.
    var into = conv({
      type: "object", properties: { b: { $ref: "#/$defs/v1~1U/properties/a" } },
      required: ["b"], additionalProperties: false,
      $defs: { "v1/U": { type: "object", properties: { a: { type: "string" } },
                         required: ["a"], additionalProperties: false } }
    }, p);
    ok("#389 " + p + ": a pointer-into keeps its tail across the rename",
      refsOf(into.schema).indexOf("#/$defs/v1_U/properties/a") !== -1);

    // Collision: the obvious rename target is already taken, so it must NOT be
    // merged into the existing definition.
    var coll = conv({
      type: "object", properties: { b: { $ref: "#/$defs/v1~1U" } }, required: ["b"],
      additionalProperties: false,
      $defs: { "v1/U": { type: "string", minLength: 3 }, "v1_U": { type: "integer" } }
    }, p);
    ok("#389 " + p + ": a rename collision does not merge two definitions",
      defKeys(coll.schema, "$defs").length === 2 &&
      defKeys(coll.schema, "$defs").indexOf("v1_U") !== -1 &&
      coll.schema.$defs.v1_U.type === "integer");

    // A PROPERTY name with "/" is NOT renameable -- it is the data contract.
    var prop = conv({
      type: "object", properties: { b: { $ref: "#/$defs/T/properties/a~1x" } },
      required: ["b"], additionalProperties: false,
      $defs: { T: { type: "object", properties: { "a/x": { type: "string" } },
                    required: ["a/x"], additionalProperties: false } }
    }, p);
    ok("#389 " + p + ": a `/` in a PROPERTY name is a blocker, not a rename",
      blockers(prop).length > 0 && has(prop.ledger, "data contract"));

    // `definitions` is handled too and is deliberately NOT renamed to `$defs`.
    var defsBag = conv({
      type: "object", properties: { b: { $ref: "#/definitions/v1~1U" } }, required: ["b"],
      additionalProperties: false, definitions: { "v1/U": { type: "string" } }
    }, p);
    ok("#389 " + p + ": the `definitions` bag is repaired and not renamed",
      defKeys(defsBag.schema, "definitions").indexOf("v1_U") !== -1 &&
      refsOf(defsBag.schema).indexOf("#/definitions/v1_U") !== -1);

    // OVER-BLOCK GUARDS -- an ordinary document must be untouched.
    var plain = conv({
      type: "object", properties: { b: { $ref: "#/$defs/S" } }, required: ["b"],
      additionalProperties: false, $defs: { S: { type: "string" } }
    }, p);
    ok("#389 " + p + ": an ordinary definition name is untouched",
      defKeys(plain.schema, "$defs").indexOf("S") !== -1 &&
      !has(plain.ledger, "Renamed") && !has(plain.ledger, "Un-escaped"));

    var idem = conv(conv(slashDoc("#/$defs/v1~1U"), p).schema, p);
    ok("#389 " + p + ": the repair is idempotent",
      !has(idem.ledger, "Renamed"));
  });

  // THE DISCRIMINATOR: the two target families disagree about the SAME file, in
  // opposite directions. Without this the rule could be firing blanket and every
  // assertion above would still pass (#365).
  JSD.forEach(function (p) {
    var r = conv(slashDoc("#/$defs/v1~1U"), p);
    ok("#389 " + p + ": a JSON-Schema target does NOT rename the definition",
      !has(r.ledger, "Renamed"));
    var t = conv(tildeDoc("#/$defs/a~0b"), p);
    ok("#389 " + p + ": a JSON-Schema target does NOT de-escape",
      !has(t.ledger, "Un-escaped"));
  });
  // ...and the property-name case is a blocker ONLY on the decoders: OpenAI
  // reads `~1` correctly, so blocking there would be blanket strictness.
  (function () {
    var prop = {
      type: "object", properties: { b: { $ref: "#/$defs/T/properties/a~1x" } },
      required: ["b"], additionalProperties: false,
      $defs: { T: { type: "object", properties: { "a/x": { type: "string" } },
                    required: ["a/x"], additionalProperties: false } }
    };
    ok("#389 openai: a `/` PROPERTY name is NOT blocked (it reads `~1`)",
      conv(prop, "openai").ledger.filter(function (l) { return l.op === "!"; }).length === 0);
  })();
})();


// --- #390: the two repairs the three decoder targets never inherited ---------
//
// Found by running the MECHANICAL check #388 prescribed — for each shared
// repair, list the converters that call it and diff that against the target
// list. Two came back short on all three decoders: noteUnsatisfiable (#347) and
// findBooleanSubschemas (#333).
//
// MEASURED 2026-08-11 on xgrammar 0.2.4 / outlines-core 0.2.14 /
// lm-format-enforcer 0.11.3, with a `{"type":"string"}` control accepting 1 of 6
// probe instances in every run. The severity forks because the engines do three
// different things, so this is per-engine rather than a port (#365).
(function () {
  function conv(sch, p) {
    var r = E.convert(sch, p);
    return r && r.ledger ? r : { schema: {}, ledger: [] };
  }
  function blockers(r) { return r.ledger.filter(function (l) { return l.op === "!" && !l.advisory; }); }
  function advisories(r) { return r.ledger.filter(function (l) { return l.op === "!" && l.advisory; }); }
  function P(v) {
    return { type: "object", properties: { f: v }, required: ["f"], additionalProperties: false };
  }

  // xgrammar: three forms are a COMPILE ERROR and three INVERT into
  // "any value". Both are blockers; the reasons differ and both are in the text.
  [["enum", { "enum": [] }], ["anyOf", { anyOf: [] }], ["oneOf", { oneOf: [] }],
   ["type", { type: [] }], ["not{}", { not: {} }], ["not-true", { not: true }]
  ].forEach(function (pair) {
    ok("#390 xgrammar: `" + pair[0] + "` unsatisfiable is a blocker",
      blockers(conv(P(pair[1]), "xgrammar")).length >= 1);
  });
  // THE DISCRIMINATOR. `true` is the one row where an engine is CORRECT — a
  // boolean `true` means any value and xgrammar generates any value — so the
  // rule must be silent there. Without this the rule could be firing blanket and
  // every assertion above would still pass.
  ok("#390 xgrammar: a boolean `true` subschema draws NO blocker (it is correct there)",
    blockers(conv(P(true), "xgrammar")).length === 0);
  ok("#390 xgrammar: a boolean `false` subschema IS a blocker (refuses to compile)",
    blockers(conv(P(false), "xgrammar")).length >= 1);

  // outlines: the four collection forms COMPILE, so they stay advisory — the
  // engine handles them correctly and the field is simply dead. Being stricter
  // than the engine is the bug this project has shipped repeatedly.
  [["enum", { "enum": [] }], ["anyOf", { anyOf: [] }], ["oneOf", { oneOf: [] }],
   ["type", { type: [] }]].forEach(function (pair) {
    var r = conv(P(pair[1]), "outlines");
    ok("#390 outlines: `" + pair[0] + "` is ADVISORY, not a gate failure",
      advisories(r).length >= 1 && blockers(r).length === 0);
  });
  // ...and `not` must NOT be reported twice: #384 already blocks the keyword on
  // this target, so the unsatisfiable table deliberately omits it.
  ok("#390 outlines: a match-anything `not` is reported exactly once",
    blockers(conv(P({ not: {} }), "outlines")).length === 1);
  ["true", "false"].forEach(function (b) {
    ok("#390 outlines: a boolean `" + b + "` subschema is a blocker",
      blockers(conv(P(b === "true"), "outlines")).length >= 1);
  });

  // lm-format-enforcer: every typeless form is owned by the widened
  // `Unsupported type None` blocker, so the unsat table carries only `type: []`
  // — the one form this engine gets right — and it stays advisory.
  var lt = conv(P({ type: [] }), "lmformatenforcer");
  ok("#390 lmfe: `type: []` is ADVISORY (the engine rejects it correctly)",
    advisories(lt).length >= 1 && blockers(lt).length === 0);
  [["enum", { "enum": [] }], ["anyOf", { anyOf: [] }], ["not{}", { not: {} }]].forEach(function (pair) {
    ok("#390 lmfe: `" + pair[0] + "` is a blocker, reported ONCE",
      blockers(conv(P(pair[1]), "lmformatenforcer")).length === 1);
  });
  ["true", "false"].forEach(function (b) {
    ok("#390 lmfe: a boolean `" + b + "` subschema is a blocker (dies mid-generation)",
      blockers(conv(P(b === "true"), "lmformatenforcer")).length >= 1);
  });

  // OVER-BLOCK GUARDS. These hold both ways and are stated as guards rather than
  // counted as coverage — but they are load-bearing: an ordinary schema must be
  // untouched on all three, and the four JSON-Schema-dialect targets must keep
  // #347's ADVISORY severity, so a later cycle cannot "unify" the two into one
  // blanket rule and silently start failing CI on documents providers accept.
  ["xgrammar", "outlines", "lmformatenforcer"].forEach(function (p) {
    var r = conv({ type: "object", properties: { f: { type: "string" } },
                   required: ["f"], additionalProperties: false }, p);
    ok("#390 " + p + ": an ordinary schema draws no unsatisfiable finding",
      r.ledger.filter(function (l) { return l.op === "!"; }).length === 0);
  });
  [["anthropic", { "enum": [] }], ["gemini-json", { "enum": [] }],
   ["openai-nonstrict", { "enum": [] }], ["openai", { type: [] }]].forEach(function (pair) {
    var r = conv(P(pair[1]), pair[0]);
    ok("#390 " + pair[0] + ": #347's severity is unchanged (advisory, never a gate failure)",
      advisories(r).length >= 1 && blockers(r).length === 0);
  });
  // The two targets genuinely DISAGREE about one file — the proof the fork is
  // real and not a blanket rule wearing three coats.
  ok("#390 one `enum: []` file: xgrammar blocks it and outlines does not",
    blockers(conv(P({ "enum": [] }), "xgrammar")).length >= 1 &&
    blockers(conv(P({ "enum": [] }), "outlines")).length === 0);
})();

// ---------------------------------------------------------------------------
// #391  A REF SPELLING THE DECODERS NEVER NORMALISED
//
// #320 shipped normalizeRefSpelling() for LiteLLM's `/$defs/X` (it passes
// `ref_template="/$defs/{model}"` to Pydantic -- re-verified on litellm 1.96.0).
// It was wired to the three JSON-Schema-dialect targets and never inherited by
// the three decoders added in #384/#385/#386: a repair is a property of a CODE
// PATH, and the newest paths carry the fewest (#388/#390).
//
// Measured 2026-08-11 on xgrammar 0.2.4 / outlines-core 0.2.14 /
// lm-format-enforcer 0.11.3, one shape per row, with an inline no-`$ref` control
// ENFORCED on all three so each engine is known to discriminate:
//
//   #/$defs/P  resolvable (CONTROL) : ENFORCED     ENFORCED     ENFORCED
//   /$defs/P   resolvable (LiteLLM) : UNCONSTRAINED ENFORCED    ENFORCED
//   /$defs/P + minLength sibling    : sibling lost on ALL THREE
//   #/$defs/Missing dangling        : RuntimeError ValueError   KeyError
//   /$defs/Missing dangling         : UNCONSTRAINED ValueError  KeyError
//
// Two defects, one family. (a) xgrammar compiles `/$defs/P` to
// `root_prop_0 ::= ((ref))` where `ref ::= basic_number | basic_string | ...`
// -- read off the emitted grammar (#385's method), not inferred -- so the
// constraint is gone with only a stderr warning. (b) On ALL THREE the
// unnormalised spelling is invisible to the document-driven pointer reader, so
// #388's `$ref`-sibling merge never fires and a `minLength: 5` beside such a ref
// is silently unenforced. Both exited 0.
(function () {
  function conv(sch, p) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), p) || {};
    if (!r.schema) r.schema = {};
    if (!r.ledger) r.ledger = [];
    return r;
  }
  function blockers(r) {
    return (r.ledger || []).filter(function (l) {
      return l.op === "!" && !l.advisory;
    });
  }
  function pnode(r) {
    return (r.schema && r.schema.properties && r.schema.properties.p) || {};
  }
  function refDoc(ref, sibling) {
    var p = { $ref: ref };
    if (sibling) p.minLength = 5;
    return { type: "object", properties: { p: p }, required: ["p"],
             $defs: { P: { type: "string", "enum": ["low", "high"] } } };
  }
  var DECODERS = ["xgrammar", "outlines", "lmformatenforcer"];

  // -- the repair itself -----------------------------------------------------
  DECODERS.forEach(function (p) {
    var r = conv(refDoc("/$defs/P"), p);
    ok("#391 " + p + ": LiteLLM's `/$defs/` spelling is rewritten to `#/$defs/`",
      pnode(r).$ref === "#/$defs/P");
    ok("#391 " + p + ": the rewrite says why this spelling is not a style nit",
      has(r.ledger, "root_prop_0 ::= ((ref))"));
  });

  // The repair the unnormalised spelling was DEFEATING: #388's sibling merge
  // reads pointers with the same document-driven reader, which requires the `#`.
  // Measured, a 2-char string passes `minLength: 5` on all three when unmerged.
  DECODERS.forEach(function (p) {
    var n = pnode(conv(refDoc("/$defs/P", true), p));
    ok("#391 " + p + ": a constraining sibling beside a `/$defs/` ref now merges",
      n.minLength === 5 && n.type === "string" && !n.$ref);
  });

  // -- the dangling half, and it is a severity correction --------------------
  // The advisory used to justify itself with "nothing will error", and its own
  // comment said the decoders "were not probed for this shape". Probing it: all
  // three refuse to build a guide at all.
  DECODERS.forEach(function (p) {
    var r = conv({ type: "object", properties: { p: { $ref: "#/$defs/Missing" } },
                   required: ["p"], $defs: { P: { type: "string" } } }, p);
    ok("#391 " + p + ": a dangling `#/$defs/` ref is a BLOCKER, not an advisory",
      blockers(r).length >= 1);
    ok("#391 " + p + ": it does not claim \"nothing will error\"",
      !has(r.ledger, "nothing will error"));
    ok("#391 " + p + ": it names the measured refusal",
      has(r.ledger, "cannot be built") && has(r.ledger, "Invalid reference path"));
  });
  DECODERS.forEach(function (p) {
    var r = conv({ type: "object", properties: { p: { $ref: "/$defs/Missing" } },
                   required: ["p"], $defs: { P: { type: "string" } } }, p);
    ok("#391 " + p + ": an unresolvable `/$defs/` ref blocks",
      blockers(r).length >= 1);
    // The JSON-Schema-dialect wording is about a reference "arriving dangling"
    // at a provider. A decoder has no wire: it either refuses to compile or
    // compiles a match-anything guide. Same keyword, different reason (#390).
    ok("#391 " + p + ": with the decoder reason, not the provider one",
      has(r.ledger, "match-anything fallback") &&
      !has(r.ledger, "No provider fetches external schema references"));
  });

  // -- over-block guards and scope pins: these hold BOTH ways -----------------
  // Stated rather than counted as coverage, and load-bearing.
  //
  // THE #365 DISCRIMINATOR: an already-correct pointer must draw NO rewrite.
  // Without this the rule could be rewriting every `$ref` it sees and every
  // assertion above would still pass.
  DECODERS.forEach(function (p) {
    var r = conv(refDoc("#/$defs/P"), p);
    ok("#391 " + p + ": an already-correct `#/$defs/` ref is NOT rewritten",
      !has(r.ledger, "Rewrote") && pnode(r).$ref === "#/$defs/P");
    ok("#391 " + p + ": and draws no blocker",
      blockers(r).length === 0);
  });
  DECODERS.forEach(function (p) {
    var r = conv({ type: "object", properties: { f: { type: "string" } },
                   required: ["f"] }, p);
    ok("#391 " + p + ": an ordinary ref-free schema is untouched",
      blockers(r).length === 0 && !has(r.ledger, "Rewrote"));
  });
  // Anthropic must STAY an advisory: measured on @anthropic-ai/sdk 0.116.0, both
  // helpers accept a dangling ref and forward it verbatim. Without this pin the
  // "fix" could simply be "block everywhere", which is the over-strictness class
  // this project has shipped repeatedly.
  ["anthropic", "anthropic-json"].forEach(function (p) {
    var r = conv({ type: "object", properties: { p: { $ref: "#/$defs/Missing" } },
                   required: ["p"], $defs: { P: { type: "string" } } }, p);
    ok("#391 " + p + ": a dangling ref stays an ADVISORY (the vendor forwards it)",
      blockers(r).length === 0);
  });
  // openai keeps its own reason rather than acquiring the decoder one.
  (function () {
    var r = conv({ type: "object", properties: { p: { $ref: "#/$defs/Missing" } },
                   required: ["p"], $defs: { P: { type: "string" } } }, "openai");
    ok("#391 openai: still blocks, and still cites toStrictJsonSchema",
      blockers(r).length >= 1 && has(r.ledger, "toStrictJsonSchema") &&
      !has(r.ledger, "match-anything fallback"));
  })();
  // The five JSON-Schema-dialect targets already normalised this spelling; the
  // decoder wiring must not have changed what they do with it.
  ["openai", "anthropic"].forEach(function (p) {
    var r = conv(refDoc("/$defs/P"), p);
    ok("#391 " + p + ": unchanged — still rewrites with its own reason",
      pnode(r).$ref === "#/$defs/P" && !has(r.ledger, "root_prop_0 ::= ((ref))"));
  });
  // gemini is the one target where the ref does NOT survive: the narrow
  // `responseSchema` proto has no `$ref` field, so refs are inlined (#314/#319).
  // Keying this on "the ref is still `#/$defs/P`" would have been asserting a
  // shape I guessed rather than the property that matters — which is that the
  // LiteLLM spelling is still recognised as LOCAL, so the definition is inlined
  // rather than reported as pointing outside the document.
  (function () {
    var r = conv(refDoc("/$defs/P"), "gemini");
    var n = pnode(r);
    ok("#391 gemini: unchanged — the ref resolves and is inlined, not reported external",
      n.type === "string" && Array.isArray(n["enum"]) && !n.$ref &&
      !has(r.ledger, "points outside this document") &&
      !has(r.ledger, "root_prop_0 ::= ((ref))"));
  })();
})();

// --- #392: the root ref-sibling merge must carry the definition bag ---------
// `resolveRefSiblings` excludes the bag from `siblings` (correct -- it is not a
// constraining sibling), then returns the merged node. At a NESTED position the
// bag lives at the root and is untouched; AT THE ROOT the excluded key IS the
// bag, so the merge replaced the root and the bag went with it while pointers
// into it survived. Measured on xgrammar 0.2.5 / outlines-core 0.2.14 /
// lm-format-enforcer 0.11.3: the raw input COMPILES on all three, our output
// compiled on NONE. `inlineRootRef` already carries the bag, and the three
// decoder converters never called it (#391's inheritance rule, third payout).
(function () {
  var DECODERS = ["outlines", "xgrammar", "lmformatenforcer"];
  function conv(sch, p) {
    var r = E.convert(sch, p);
    return (r && r.ok) ? r : { schema: {}, ledger: [] };
  }
  // root `$ref` + CONSTRAINING siblings + a pointer into the bag from a sibling
  function rootMerge(bag) {
    var d = { "$ref": "#/" + bag + "/T", properties: { a: { "$ref": "#/" + bag + "/U" } }, required: ["a"] };
    d[bag] = {
      T: { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
      U: { type: "string", minLength: 3 }
    };
    return d;
  }

  DECODERS.forEach(function (p) {
    var s = conv(rootMerge("$defs"), p).schema;
    ok("#392 " + p + ": the root merge keeps the `$defs` bag",
      s && isObj(s.$defs) && isObj(s.$defs.U));
    // The whole point: the pointer that survived the merge must still resolve.
    ok("#392 " + p + ": the surviving pointer still resolves into the kept bag",
      s && s.properties && s.properties.a && s.properties.a.$ref === "#/$defs/U" &&
      s.$defs && s.$defs.U && s.$defs.U.minLength === 3);
    // ...and the merge itself is still an INTERSECTION (#371): both sides' props.
    ok("#392 " + p + ": the merge still keeps BOTH sides' declarations",
      s && s.properties && s.properties.b && s.properties.a &&
      Array.isArray(s.required) &&
      s.required.indexOf("b") !== -1 && s.required.indexOf("a") !== -1);
    // The decoder targets deliberately do NOT rename the bag (#388), so the
    // draft-07 spelling -- `zod-to-json-schema`'s default -- must survive under
    // its own name. Naming only `$defs` in the fix would miss half the input.
    var sd = conv(rootMerge("definitions"), p).schema;
    ok("#392 " + p + ": the `definitions` spelling of the bag survives too",
      sd && isObj(sd.definitions) && isObj(sd.definitions.U) &&
      sd.properties && sd.properties.a && sd.properties.a.$ref === "#/definitions/U");
  });

  // --- over-block guards and scope pins: these hold BOTH ways ---------------
  // NESTED merge: the bag was never a sibling there, so it was always kept.
  // Without this the fix could be "carry the bag on every merge" and every
  // assertion above would still pass.
  DECODERS.forEach(function (p) {
    var nested = conv({
      type: "object",
      properties: { x: { "$ref": "#/$defs/T", minLength: 2 }, a: { "$ref": "#/$defs/U" } },
      required: ["x", "a"],
      $defs: { T: { type: "string" }, U: { type: "string", minLength: 3 } }
    }, p).schema;
    ok("#392 " + p + ": a NESTED ref-sibling merge is unaffected",
      nested && isObj(nested.$defs) && isObj(nested.$defs.U));
  });

  // A root `$ref` whose only sibling is an ANNOTATION draws no merge at all --
  // measured, this is exactly what pydantic 2.13.4 emits for `RootModel[T]`
  // (`{$defs, $ref, title}`), i.e. the commonest root shape there is, so the
  // rule must not fire on it.
  DECODERS.forEach(function (p) {
    var ann = conv({
      "$ref": "#/$defs/T", title: "Wrap",
      $defs: { T: { type: "object", properties: { b: { type: "string" } }, required: ["b"] } }
    }, p).schema;
    ok("#392 " + p + ": an annotation-only root sibling is left exactly as written",
      ann && ann.$ref === "#/$defs/T" && ann.title === "Wrap" && isObj(ann.$defs) &&
      !ann.properties);
  });

  // A bare root `$ref` (no siblings at all) is untouched: all three decoders
  // resolve `#/$defs/T` correctly, so inlining it would be an edit that buys
  // nothing (#314's error-policy rule).
  DECODERS.forEach(function (p) {
    var bare = conv({
      "$ref": "#/$defs/T",
      $defs: { T: { type: "object", properties: { a: { "$ref": "#/$defs/U" } }, required: ["a"] },
               U: { type: "string", minLength: 3 } }
    }, p).schema;
    ok("#392 " + p + ": a bare root `$ref` is passed through untouched",
      bare && bare.$ref === "#/$defs/T" && isObj(bare.$defs) && isObj(bare.$defs.U));
  });

  // THE DISCRIMINATOR (#365): the JSON-Schema-dialect targets must be UNCHANGED.
  // `inlineRootRef` owns the root there and runs immediately BEFORE
  // `resolveRefSiblings`, so by the time this code sees the root there is no
  // `$ref` left and the new branch cannot fire. Without this pin the fix could
  // be firing on every target and every assertion above would still pass.
  ["openai", "anthropic-json"].forEach(function (p) {
    var s = conv(rootMerge("$defs"), p).schema;
    ok("#392 " + p + ": still keeps the bag via the root inliner, not the new branch",
      s && isObj(s.$defs) && isObj(s.$defs.U) &&
      s.properties && s.properties.a && s.properties.a.$ref === "#/$defs/U" &&
      has(conv(rootMerge("$defs"), p).ledger, "Inlined the root `$ref`"));
  });
  // Gemini inlines refs outright and needs no bag -- pinned so a later cycle
  // does not "unify" the two and start emitting a bag it has no field for.
  (function () {
    var s = conv(rootMerge("$defs"), "gemini").schema;
    ok("#392 gemini: still inlines and carries NO bag",
      s && !s.$defs && !s.definitions &&
      s.properties && s.properties.a && s.properties.a.minLength === 3 && !s.properties.a.$ref);
  })();

  // `anthropic-json-python` is the SILENT half, and the one with real generator
  // reachability. That target deliberately KEEPS the root `$ref` (#315/#324), so
  // unlike openai/anthropic-json it still has one when this code runs -- and
  // `onlyConstraining` is false there, so `$schema` is NOT filtered out of
  // `siblings`. `$schema` at the root beside a `$ref` is exactly what
  // `zod-to-json-schema` emits BY DEFAULT, so an ordinary zod schema with a
  // reused sub-schema fired the merge and lost the bag, leaving `echo`'s
  // pointer-into-definition unresolvable at exit 1 with NO blocker. Measured on
  // `anthropic==0.121.0`: `transform_schema` ACCEPTS the dangling form and
  // forwards it verbatim, so nothing anywhere reports it and the constraint is
  // simply gone; with the bag kept, the definition survives (its `minLength`
  // demoted to `description` prose, which is that path's documented behaviour).
  (function () {
    var zod = {
      "$ref": "#/definitions/S",
      definitions: {
        S: {
          type: "object",
          properties: {
            inner: { type: "object", properties: { one: { type: "string", minLength: 3 } },
                     required: ["one"], additionalProperties: false },
            echo: { "$ref": "#/definitions/S/properties/inner/properties/one" }
          },
          required: ["inner", "echo"], additionalProperties: false
        }
      },
      "$schema": "http://json-schema.org/draft-07/schema#"
    };
    var s = conv(zod, "anthropic-json-python").schema;
    ok("#392 anthropic-json-python: zod's default root keeps its bag",
      s && isObj(s.$defs) && isObj(s.$defs.S));
    // The property that matters is RESOLUTION, not presence of a key: walk the
    // pointer the way a consumer would.
    ok("#392 anthropic-json-python: the pointer INTO the definition resolves",
      s && s.properties && s.properties.echo &&
      resolvePtr(s, s.properties.echo.$ref) === true);
  })();

  function resolvePtr(doc, ref) {
    if (typeof ref !== "string" || ref.charAt(0) !== "#") return "n/a";
    var toks = ref.slice(1).split("/").slice(1).map(function (t) {
      try { t = decodeURIComponent(t); } catch (e) { /* #378: %zz throws */ }
      return t.replace(/~1/g, "/").replace(/~0/g, "~");
    });
    var cur = doc;
    for (var i = 0; i < toks.length; i++) {
      if (!cur || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, toks[i])) return false;
      cur = cur[toks[i]];
    }
    return true;
  }

  // Precedence: a referent that declares its own bag wins, so the carry-over
  // cannot clobber a definition set the merge legitimately produced.
  (function () {
    var d = {
      "$ref": "#/$defs/T", properties: { a: { type: "string" } }, required: ["a"],
      $defs: { T: { type: "object", properties: { b: { type: "string" } }, required: ["b"],
                    $defs: { INNER: { type: "integer" } } } }
    };
    var s = conv(d, "xgrammar").schema;
    ok("#392 a referent's own bag is not clobbered by the carry-over",
      s && isObj(s.$defs) && isObj(s.$defs.INNER));
  })();

  // No bag on the input -> none invented.
  (function () {
    var s = conv({ type: "object", properties: { b: { type: "string" } }, required: ["b"] }, "xgrammar").schema;
    ok("#392 an ordinary schema gains no definition bag",
      s && !s.$defs && !s.definitions);
  })();

  function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
})();

// ---------------------------------------------------------------------------
// #393 -- liftBareAllOfRef is an EDIT and has to say so.
//
// It deletes `allOf` and writes a `$ref` the caller never typed. Where the merge
// below fires, the merge's entry covered it; where it does NOT fire the rewrite
// shipped unannounced, and for a recursive member NOTHING downstream fired at
// all -- `--check` said "Already valid ... No changes needed." (exit 0) while
// `--to` on the same file emitted a structurally different document.
// ---------------------------------------------------------------------------
(function () {
  var DEC = ["outlines", "xgrammar", "lmformatenforcer"];
  var LIFT = "Rewrote `allOf: [{ $ref }]`";

  function conv(sch, p) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), p) || {};
    if (!r.schema) r.schema = {};
    if (!r.ledger) r.ledger = [];
    return r;
  }
  function entryAt(r, substr) {
    for (var i = 0; i < r.ledger.length; i++) {
      if (String(r.ledger[i].msg).indexOf(substr) !== -1) return r.ledger[i];
    }
    return null;
  }
  function changes(r) {
    return r.ledger.filter(function (l) { return l.op !== "=" && !l.advisory; });
  }

  // The bug in its purest form: a recursive member means the merge never runs,
  // so before this fix the whole rewrite was invisible.
  var RECURSIVE = { type: "object", properties: { a: { type: "string" } },
                    required: ["a"], allOf: [{ $ref: "#" }] };

  DEC.forEach(function (t) {
    var r = conv(RECURSIVE, t);
    ok("#393 " + t + ": a recursive `allOf: [{$ref}]` lift is REPORTED", !!entryAt(r, LIFT));
    // The whole defect: `--check` computes its verdict from this list.
    ok("#393 " + t + ": that rewrite counts as a change (was 0 -> \"no changes needed\")",
      changes(r).length > 0);
    // ...and the document really did change, so reporting it is the honest answer.
    ok("#393 " + t + ": and the document really was rewritten",
      typeof r.schema.$ref === "string" && !Array.isArray(r.schema.allOf));
  });

  // Merge SUCCEEDS: two entries, not one. A lift and an intersection are
  // different edits with different reasons (#389); collapsing them under-reports.
  (function () {
    var doc = { type: "object", properties: { a: { type: "string" } }, required: ["a"],
                allOf: [{ $ref: "#/$defs/T" }],
                $defs: { T: { type: "object", properties: { b: { type: "string" } }, required: ["b"] } } };
    DEC.forEach(function (t) {
      var r = conv(doc, t);
      ok("#393 " + t + ": lift reported alongside the merge it enables",
        !!entryAt(r, LIFT) && has(r.ledger, "Inlined 1 `$ref`"));
      // The merge must still do its job -- the repair is the point of the lift.
      var p = r.schema.properties || {};
      ok("#393 " + t + ": the merge still keeps BOTH sides' properties",
        !!p.a && !!p.b);
    });
  })();

  // Merge BLOCKED: the lift already happened, so without its entry the blocker
  // opens by describing a `$ref` the reader cannot find in their own file.
  (function () {
    var doc = { type: "object", properties: { a: { type: "string" } }, required: ["a"],
                allOf: [{ $ref: "#/$defs/T" }],
                $defs: { T: { type: "object", properties: { b: { type: "string" } },
                              required: ["b"], additionalProperties: false } } };
    DEC.forEach(function (t) {
      var r = conv(doc, t);
      ok("#393 " + t + ": lift reported even when the merge is blocked",
        !!entryAt(r, LIFT));
      ok("#393 " + t + ": the blocker itself still fires",
        r.ledger.some(function (l) { return l.op === "!" && !l.advisory; }));
    });
  })();

  // The entry names WHERE, and a nested lift must not claim to be at the root.
  (function () {
    var doc = { type: "object", required: ["inner"],
                properties: { inner: { type: "object", properties: { a: { type: "string" } },
                                       required: ["a"], allOf: [{ $ref: "#/$defs/T" }] } },
                $defs: { T: { type: "object", properties: { b: { type: "string" } }, required: ["b"] } } };
    var e = entryAt(conv(doc, "xgrammar"), LIFT);
    ok("#393 a nested lift reports its own path, not `root`",
      !!e && e.path !== "root" && String(e.path).indexOf("inner") !== -1);
  })();

  // ---- over-block guards: these hold BOTH ways, and each is load-bearing ----

  // pydantic v1's `{title, description, allOf:[{$ref}]}` is annotations-only, so
  // the lift must not fire -- rewriting it would be an edit that buys nothing.
  (function () {
    var v1 = { title: "Inner", description: "an inner", allOf: [{ $ref: "#/definitions/Inner" }] };
    var doc = { type: "object", required: ["inner"], properties: { inner: v1 },
                definitions: { Inner: { type: "object", properties: { b: { type: "string" } }, required: ["b"] } } };
    DEC.forEach(function (t) {
      var r = conv(doc, t);
      ok("#393 " + t + ": pydantic v1 annotations-only draws NO lift entry",
        !entryAt(r, LIFT) && Array.isArray((r.schema.properties || {}).inner &&
          r.schema.properties.inner.allOf));
    });
  })();

  // A two-member `allOf` is a real composition; lifting it would change meaning.
  (function () {
    var doc = { type: "object", properties: { a: { type: "string" } }, required: ["a"],
                allOf: [{ $ref: "#/$defs/T" }, { type: "object" }],
                $defs: { T: { type: "object", properties: { b: { type: "string" } }, required: ["b"] } } };
    DEC.forEach(function (t) {
      ok("#393 " + t + ": a two-member `allOf` draws no lift entry",
        !entryAt(conv(doc, t), LIFT));
    });
  })();

  // A node already carrying a `$ref` must not have it overwritten.
  (function () {
    var doc = { $ref: "#/$defs/U", minLength: 3, allOf: [{ $ref: "#/$defs/T" }],
                $defs: { T: { type: "string" }, U: { type: "string" } } };
    var r = conv(doc, "xgrammar");
    ok("#393 a node that already has a `$ref` is not lifted over",
      !entryAt(r, LIFT));
  })();

  // THE DISCRIMINATOR (#365): the JSON-Schema-dialect targets do not run this
  // rewrite at all. Without this pin the rule could be firing on every target
  // and every assertion above would still pass.
  ["openai", "anthropic", "anthropic-json", "gemini", "gemini-json"].forEach(function (t) {
    ok("#393 " + t + " does not acquire the decoder lift entry",
      !entryAt(conv(RECURSIVE, t), LIFT));
  });
})();


// --- #394: the orphan-`$defs` pruner reports what it deletes -----------------
//
// Found by the NESTED form of #393's ledger-side sweep: for every key in the
// input that is absent from the output, is it NAMED anywhere in the ledger --
// asked at every depth rather than only at the root, and discounting keys whose
// ANCESTOR's removal is reported (a `pattern` inside a removed `propertyNames`
// is covered by that removal). 39 rows survived: `--check --to openai` printed
// "Already valid ... No changes needed." and exited 0 while `--to` on the SAME
// FILE emitted a document with a whole `$defs` definition deleted.
//
// The fix is a REPORT, not a behaviour change: the deletion is meaning-
// preserving and the schema was already compliant, so the entry is ADVISORY and
// the exit code stays 0. What was wrong was the sentence.
(function () {
  function conv(sch, p) {
    var r = E.convert(JSON.parse(JSON.stringify(sch)), p);
    return r && r.ledger ? r : { schema: {}, ledger: [] };
  }
  // Key on the OP + advisory + a stable clause, never on the whole prose
  // (#340/#339: keying a check on wording breaks the moment the wording
  // improves, and the phrase must not collide with a neighbouring rule).
  function prune(r) {
    return r.ledger.filter(function (l) {
      return l.op === "x" && l.advisory === true &&
        String(l.msg || "").indexOf("unreferenced definition") !== -1;
    });
  }
  function code(r) {
    if (r.ledger.filter(function (l) { return l.op === "!" && !l.advisory; }).length) return 3;
    if (r.ledger.filter(function (l) { return l.op !== "=" && !l.advisory; }).length) return 1;
    return 0;
  }
  var PRUNES = ["openai", "anthropic-json", "anthropic-json-python", "anthropic-go"];
  var DECODERS = ["outlines", "xgrammar", "lmformatenforcer"];

  var ORPHAN = { type: "object", additionalProperties: false, required: ["a"],
                 properties: { a: { type: "string" } },
                 $defs: { Unused: { type: "object", properties: { z: { type: "integer" } } } } };

  PRUNES.forEach(function (t) {
    var r = conv(ORPHAN, t), p = prune(r);
    ok("#394 " + t + ": an orphaned definition is reported, not deleted in silence",
      p.length === 1 && String(p[0].msg).indexOf("`Unused`") !== -1);
    // The whole point of the shape: it must NOT newly fail a gate that
    // legitimately passed. A required change here would be the over-strictness
    // bug this project has shipped ~10 times.
    ok("#394 " + t + ": that report is advisory, so the gate still passes",
      code(r) === 0);
    ok("#394 " + t + ": the definition really is gone from the output",
      !(r.schema && r.schema.$defs));
  });

  // THE DISCRIMINATOR (#365): the decoder targets skip the pruner entirely
  // (#388 -- it buys a decoder nothing and fails open on an un-normalised ref
  // spelling), so they must KEEP the definition and draw NO entry. Without this
  // pin the rule could be firing on every target and every assertion above
  // would still pass.
  DECODERS.forEach(function (t) {
    var r = conv(ORPHAN, t);
    ok("#394 " + t + ": does not acquire the prune entry",
      prune(r).length === 0);
    ok("#394 " + t + ": and keeps the definition, because it never prunes",
      !!(r.schema && r.schema.$defs && r.schema.$defs.Unused));
  });

  // OVER-BLOCK GUARD 1: a definition referenced ONLY from inside another
  // definition is live. Reporting it would mean the pruner had deleted it,
  // which is the dangling-ref class of #320/#342.
  (function () {
    var doc = { type: "object", additionalProperties: false, required: ["a"],
                properties: { a: { $ref: "#/$defs/A" } },
                $defs: { A: { type: "object", additionalProperties: false, required: ["b"],
                              properties: { b: { $ref: "#/$defs/B" } } },
                         B: { type: "string", minLength: 3 } } };
    PRUNES.forEach(function (t) {
      var r = conv(doc, t);
      ok("#394 " + t + ": a transitively-referenced definition is neither pruned nor reported",
        prune(r).length === 0 && !!(r.schema && r.schema.$defs && r.schema.$defs.B));
    });
  })();

  // OVER-BLOCK GUARD 2: an unresolvable pointer makes the pruner bail out and
  // keep EVERYTHING (#320's fail-closed rule). Nothing was deleted, so nothing
  // may be reported -- otherwise the message would name a deletion that never
  // happened, which is the "false of the input" class of #391/#393.
  (function () {
    var doc = { type: "object", additionalProperties: false, required: ["a"],
                properties: { a: { $ref: "#/$defs/Bee" } },
                $defs: { B: { type: "string" } } };
    var r = conv(doc, "openai");
    ok("#394 an unresolvable pointer keeps every definition and reports no prune",
      prune(r).length === 0 && !!(r.schema && r.schema.$defs && r.schema.$defs.B));
  })();

  // OVER-BLOCK GUARD 3: ordinary documents stay silent.
  (function () {
    var plain = { type: "object", additionalProperties: false, required: ["a"],
                  properties: { a: { type: "string" } } };
    PRUNES.forEach(function (t) {
      ok("#394 " + t + ": a schema with no `$defs` draws no prune entry",
        prune(conv(plain, t)).length === 0);
    });
    var used = { type: "object", additionalProperties: false, required: ["a"],
                 properties: { a: { $ref: "#/$defs/T" } },
                 $defs: { T: { type: "string" } } };
    ok("#394 a definition that IS referenced draws no prune entry",
      prune(conv(used, "openai")).length === 0);
  })();

  // A LEDGER IS A SEQUENCE (#393). An inline is often WHAT MAKES a definition
  // unreferenced, so the prune line must come AFTER it -- reported first, it
  // told the reader "nothing points at `T`" and only then, on the next line,
  // that something had pointed at it and was inlined. That was a real bug in
  // this cycle's own first patch, caught by reading the emitted order.
  (function () {
    var doc = { $ref: "#/$defs/T", properties: { a: { type: "string" } }, required: ["a"],
                $defs: { T: { type: "object", properties: { b: { type: "string" } }, required: ["b"] } } };
    var r = conv(doc, "anthropic-json-python");
    var iInline = -1, iPrune = -1;
    r.ledger.forEach(function (l, i) {
      if (String(l.msg || "").indexOf("that carried sibling keywords") !== -1) iInline = i;
      if (String(l.msg || "").indexOf("unreferenced definition") !== -1) iPrune = i;
    });
    ok("#394 the prune line follows the inline that caused it",
      iInline !== -1 && iPrune !== -1 && iPrune > iInline);
  })();

  // #315: a shared helper must not hardcode one provider's wording. The first
  // draft of this message ended "...still count against OpenAI's 5000-property
  // budget" and fired on the Anthropic path -- caught by the existing
  // "anthropic ledger never cites OpenAI" assertion, one cycle after the
  // codebase recorded that exact lesson.
  (function () {
    var p = prune(conv(ORPHAN, "anthropic-go"));
    ok("#394 the prune message names no other provider",
      p.length === 1 && String(p[0].msg).indexOf("OpenAI") === -1);
  })();
})();


// ---- #395: outlines has a SECOND surface, and it is the one that converts ---
//
// `--to outlines` has modelled `build_regex_from_schema` since #384. But
// `outlines.models.gemini` routes the SAME output_type through
// `JsonSchema.convert_to(..., ["dataclass","typeddict","pydantic"])`, whose
// `schema_type_to_python` dispatches on `enum`/`const`/`type` ONLY -- so a
// `$ref`/`allOf`/`anyOf`/`oneOf` node becomes `typing.Any`, reaches google-genai
// as a property with no `type`, and is ACCEPTED. Measured on outlines 1.3.3 /
// google-genai, live v1beta endpoint, with discriminating controls.
(function () {
  function conv(sch, p) {
    var r = E.convert(sch, p);
    return r && r.ledger ? r : { schema: {}, ledger: [] };
  }
  // Key on the OP + the backend name, never on the surrounding prose (#340).
  function anyNotes(led) {
    if (!led || typeof led.filter !== "function") return [];
    return led.filter(function (l) {
      return String(l.msg || "").indexOf("outlines.models.gemini") !== -1;
    });
  }

  var REF = {
    type: "object", required: ["f"],
    properties: { f: { $ref: "#/$defs/T" } },
    $defs: { T: { type: "object", properties: { k: { type: "string" } }, required: ["k"] } }
  };
  var SCALAR_UNION = {
    type: "object", required: ["f"],
    properties: { f: { anyOf: [{ type: "string" }, { type: "integer" }] } }
  };
  var OBJECT_UNION = {
    type: "object", required: ["f"],
    properties: { f: { anyOf: [
      { type: "object", properties: { k: { type: "string" } }, required: ["k"] },
      { type: "null" }
    ] } }
  };
  var UNION_TYPE = {
    type: "object", required: ["f"],
    properties: { f: { type: ["object", "null"], properties: { k: { type: "string" } }, required: ["k"] } }
  };
  var PLAIN = { type: "object", required: ["f"], properties: { f: { type: "string" } } };

  var refNotes = anyNotes(conv(REF, "outlines").ledger);
  ok("#395 a `$ref` property is reported as `Any` on the converting backend",
    refNotes.length === 1);
  ok("#395 the note names the property, not the root",
    refNotes.length === 1 && refNotes[0].path === "root.f");

  // NEVER a gate failure: on the backend this target models the document is
  // genuinely fine, and failing CI for it is the over-strictness bug this
  // project has shipped repeatedly (#317).
  ok("#395 the note is advisory on every shape it fires for",
    [REF, SCALAR_UNION, OBJECT_UNION, UNION_TYPE].every(function (s) {
      var n = anyNotes(conv(s, "outlines").ledger);
      return n.length >= 1 && n.every(function (l) { return l.advisory === true; });
    }));

  // The remedy is per-shape and MEASURED, not reasoned: an inline object reads
  // correctly on both surfaces, and a bare-scalar union re-spells as a list
  // `type` that both surfaces honour.
  ok("#395 a `$ref` is told to inline (works on both surfaces)",
    has(anyNotes(conv(REF, "outlines").ledger), "Inline the definition"));
  ok("#395 a bare-scalar union is given the lossless list-`type` re-spelling",
    has(anyNotes(conv(SCALAR_UNION, "outlines").ledger), 'type: ["string", "integer"]'));
  // ...and where NO form satisfies both surfaces, say that rather than invent one.
  ok("#395 an object-member union is told no single document satisfies both",
    has(anyNotes(conv(OBJECT_UNION, "outlines").ledger), "no single document satisfies both"));

  // THE HALF THAT IS OURS. #387's rewrite turns a union `type` into `anyOf`,
  // which is right for outlines-core (it narrows a union carrying `properties`)
  // and is precisely the spelling the converting backend cannot read. Measured:
  // raw -> `AnonymousDataclass | None`, ours -> `typing.Any`.
  ok("#395 a union `type` WE rewrote is owned in the message",
    has(anyNotes(conv(UNION_TYPE, "outlines").ledger), "NOTE THIS ONE IS OURS"));
  // The discriminator for that clause: an `anyOf` the CALLER wrote is the same
  // shape and must NOT be blamed on us. Without this the flag could be
  // hardcoded true and every assertion above would still pass.
  ok("#395 an `anyOf` the caller wrote is NOT claimed as ours",
    !has(anyNotes(conv(OBJECT_UNION, "outlines").ledger), "NOTE THIS ONE IS OURS"));

  // ---- over-block guards: the mirror must be faithful in BOTH directions ----
  ok("#395 an ordinary typed property draws nothing",
    anyNotes(conv(PLAIN, "outlines").ledger).length === 0);
  ok("#395 `enum` draws nothing (the converter reads it as a Literal)",
    anyNotes(conv({ type: "object", required: ["f"],
      properties: { f: { enum: ["a", "b"] } } }, "outlines").ledger).length === 0);
  ok("#395 `const` draws nothing (Literal, handled before `type`)",
    anyNotes(conv({ type: "object", required: ["f"],
      properties: { f: { const: 7 } } }, "outlines").ledger).length === 0);
  ok("#395 an INLINE nested object draws nothing -- that is the remedy working",
    anyNotes(conv({ type: "object", required: ["f"], properties: {
      f: { type: "object", properties: { k: { type: "string" } }, required: ["k"] } } },
      "outlines").ledger).length === 0);

  // Mirror fidelity: the converter recurses into `items` for an array and into
  // `properties` for an object, and into NOTHING else -- so a `$ref` under
  // `items` IS reachable and must be reported.
  ok("#395 a `$ref` under array `items` is reported (the converter descends there)",
    anyNotes(conv({ type: "object", required: ["f"], properties: {
      f: { type: "array", items: { $ref: "#/$defs/T" } } },
      $defs: { T: { type: "object", properties: { k: { type: "string" } }, required: ["k"] } } },
      "outlines").ledger).length === 1);
  // ...and it does NOT descend into a union's branches: the parent is already
  // `Any`, so a second note about a branch would describe a node the converter
  // never reaches.
  ok("#395 a union's branches are not descended into (parent is already `Any`)",
    anyNotes(conv({ type: "object", required: ["f"], properties: {
      f: { anyOf: [{ $ref: "#/$defs/T" }, { type: "null" }] } },
      $defs: { T: { type: "object", properties: { k: { type: "string" } }, required: ["k"] } } },
      "outlines").ledger).length === 1);
  // `json_schema_dict_to_pydantic` reads the ROOT's `properties` without ever
  // consulting the root's own `type`, so a typeless root is still walked.
  ok("#395 a typeless root still has its properties walked",
    anyNotes(conv({ properties: { f: { $ref: "#/$defs/T" } }, required: ["f"],
      $defs: { T: { type: "string" } } }, "outlines").ledger).length === 1);

  // THE #365 DISCRIMINATOR, and it is load-bearing: this is a fact about ONE
  // BACKEND OF ONE LIBRARY. xgrammar and lm-format-enforcer are different
  // packages with no such converter, so if they acquired this note the rule
  // would be firing blanket and every assertion above would still pass.
  ok("#395 xgrammar does NOT acquire the note",
    anyNotes(conv(REF, "xgrammar").ledger).length === 0);
  ok("#395 lmformatenforcer does NOT acquire the note",
    anyNotes(conv(REF, "lmformatenforcer").ledger).length === 0);
  ok("#395 the JSON-Schema-dialect targets do NOT acquire the note",
    ["openai", "anthropic", "gemini-json"].every(function (p) {
      return anyNotes(conv(REF, p).ledger).length === 0;
    }));
})();

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
