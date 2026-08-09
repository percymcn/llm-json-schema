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

// --- Anthropic: the two paths, pinned to @anthropic-ai/sdk@0.116.0 ----------
// Every assertion below was measured by running the input through the vendor's
// own `lib/transform-json-schema.js`, not read off a doc page.

// A root `$ref` + `definitions` (verbatim zod-to-json-schema output) is the
// worst input on the output_format path: the transformer returns early on
// `$ref`, so the SDK reduces it to exactly {"$ref":"#/definitions/Ticket"} —
// dangling pointer, whole schema gone, and nothing throws.
(function () {
  var r = E.toAnthropic({
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
  var r = E.toAnthropic({
    type: "object",
    properties: { lvl: { enum: ["low", "high"] }, n: { enum: [1, 2] } }
  });
  ok("anthropic infers string type for a bare enum", r.schema.properties.lvl.type === "string");
  ok("anthropic infers integer type for a numeric enum", r.schema.properties.n.type === "integer");
  ok("anthropic explains the throw it prevents", has(r.ledger, "must have a type defined"));
})();

// A typeless node with nothing to infer from is a genuine blocker.
(function () {
  var r = E.toAnthropic({ type: "object", properties: { x: { description: "mystery" } } });
  ok("anthropic reports an un-inferable typeless node as a blocker",
    r.ledger.some(function (l) { return l.op === "!"; }));
})();

// Demotion, the finding this whole path exists for: `enum` on a typed node is
// NOT stripped and NOT enforced — the SDK appends it to `description`.
(function () {
  var r = E.toAnthropic({
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
  var r = E.toAnthropic({
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
  var r = E.toAnthropic({
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
  var r = E.toAnthropic({
    type: "object",
    properties: { v: { oneOf: [{ type: "string" }, { type: "number" }] } }
  });
  ok("anthropic rewrites oneOf to anyOf like the SDK does",
    Array.isArray(r.schema.properties.v.anyOf) && r.schema.properties.v.oneOf === undefined);
})();

// Both tuple spellings reach the transformer with no `type` and throw.
(function () {
  var homo = E.toAnthropic({
    type: "object",
    properties: { bbox: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }] } }
  });
  ok("anthropic collapses a homogeneous tuple losslessly",
    homo.schema.properties.bbox.items.type === "number" &&
    homo.schema.properties.bbox.minItems === 2 && homo.schema.properties.bbox.maxItems === 2);

  var hetero = E.toAnthropic({
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

// --- Gemini inlines $refs rather than emitting an empty schema --------------
(function () {
  // ZOD_V3 is verbatim zod-to-json-schema output, so it HAS a top-level
  // `$schema`. @google/genai's maybeMoveToResponseJsonSchema() therefore moves
  // it to `responseJsonSchema` and sends it verbatim — subsetting it here would
  // delete the very key that buys the permissive path.
  var keep = E.toGemini(ZOD_V3);
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
  });
  ok("gemini drops non-$ siblings of a $ref on the $schema path",
    !("description" in sib.schema.properties.u) && sib.schema.properties.u.$ref === "#/$defs/U");

  // Cycles are allowed, but only inside NON-required properties.
  var cyc = E.toGemini({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { root: { $ref: "#/$defs/Node" } },
    required: ["root"],
    $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } }
  });
  ok("gemini flags a required cyclic property", cyc.ledger.some(function (l) {
    return l.op === "!" && l.msg.indexOf("cyclic") !== -1;
  }));
  var cycOk = E.toGemini({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { root: { $ref: "#/$defs/Node" } },
    $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } }
  });
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
  var z4 = E.toGemini(JSON.parse(JSON.stringify(ZOD_V4)));
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
  var j = E.toGemini(jsonPath);
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
  });
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

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
