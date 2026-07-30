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

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
