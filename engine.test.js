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
  ok("gemini drops unsupported string format `email`", !("format" in r.schema.properties.email));
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

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
