/* Dependency-free end-to-end tests for the CLI. Run: node cli.test.js
 *
 * The fixtures below are the actual schemas from real reported failures, so a
 * regression here means the tool stops fixing a bug people genuinely hit:
 *   - cairijun/codecompanion-agentskills.nvim#10  (root property missing from `required`)
 *   - gatteo/linkedinpreview.com#66               (nested array-item property missing from `required`)
 */
var spawnSync = require("child_process").spawnSync;
var path = require("path");

var CLI = path.join(__dirname, "cli.js");
var pass = 0, fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail ? "\n        " + detail : "")); }
}

function run(args, stdin) {
  return spawnSync(process.execPath, [CLI].concat(args), {
    input: stdin === undefined ? "" : stdin,
    encoding: "utf8"
  });
}

// Real fixture: OpenAI rejects this with
// "'required' is required to be supplied and to be an array including every key in properties. Missing 'args'."
var NVIM_SCHEMA = JSON.stringify({
  type: "object",
  properties: { args: { type: "object" } }
});

// Real fixture: nested item schema, "Missing 'body'" in context ('properties','slides','items').
var CAROUSEL_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    slides: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" } },
        required: ["title"]
      }
    }
  },
  required: ["slides"]
});

// --- the core fix: every property lands in `required` ------------------------
(function () {
  var r = run(["--to", "openai"], NVIM_SCHEMA);
  var out = JSON.parse(r.stdout);
  ok("exits 0 on a fixable schema", r.status === 0, "status=" + r.status);
  ok("adds the missing key to `required`", out.required.indexOf("args") !== -1, r.stdout);
  ok("sets additionalProperties:false", out.additionalProperties === false);
  ok("ledger goes to stderr, not stdout", r.stderr.indexOf("required") !== -1 && r.stdout.indexOf("—") === -1);
})();

(function () {
  var r = run(["--to", "openai"], CAROUSEL_SCHEMA);
  var out = JSON.parse(r.stdout);
  var item = out.properties.slides.items;
  ok("fixes nested array-item schemas too", item.required.indexOf("body") !== -1, r.stdout);
  ok("sets additionalProperties:false on nested objects", item.additionalProperties === false);
})();

// --- --check is the CI gate --------------------------------------------------
(function () {
  var r = run(["--to", "openai", "--check"], NVIM_SCHEMA);
  ok("--check exits 1 on a non-compliant schema", r.status === 1, "status=" + r.status);
  ok("--check prints no schema on stdout", r.stdout.trim() === "", JSON.stringify(r.stdout));
  ok("--check explains why on stderr", r.stderr.indexOf("Not compliant") !== -1, r.stderr);
})();

(function () {
  // Feed the already-fixed output back in: it must now pass the gate.
  var fixed = run(["--to", "openai"], NVIM_SCHEMA).stdout;
  var r = run(["--to", "openai", "--check"], fixed);
  ok("--check exits 0 once the schema is compliant (idempotent)", r.status === 0, r.stderr);
  ok("--check says so on stderr", r.stderr.indexOf("Already valid") !== -1, r.stderr);
})();

// --- $ref handling for Gemini (no $ref support => inline it) -----------------
(function () {
  // A plain, non-recursive $ref is NOT a human problem — it can be inlined.
  var r = run(["--to", "gemini"], JSON.stringify({
    type: "object",
    $defs: { A: { type: "string" } },
    properties: { a: { $ref: "#/$defs/A" } }
  }));
  ok("inlines a non-recursive $ref instead of blocking", r.status === 0, "status=" + r.status + " " + r.stderr);
  var out = JSON.parse(r.stdout);
  ok("the referenced definition is inlined at the use site", out.properties.a.type === "string", r.stdout);
  ok("the $defs block is gone", out.$defs === undefined, r.stdout);
})();

// --- blockers that genuinely need a human ------------------------------------
(function () {
  // A self-referencing definition cannot be expressed in Gemini's subset at all.
  var r = run(["--to", "gemini"], JSON.stringify({
    type: "object",
    $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } },
    properties: { root: { $ref: "#/$defs/Node" } }
  }));
  ok("exits 3 when a recursive $ref needs a human fix", r.status === 3, "status=" + r.status);
  ok("names the recursive definition on stderr", r.stderr.indexOf("Node") !== -1, r.stderr);
})();

// --- machine-readable mode ---------------------------------------------------
(function () {
  var r = run(["--to", "anthropic", "--json"], NVIM_SCHEMA);
  var out = JSON.parse(r.stdout);
  ok("--json emits a parseable envelope", out.provider === "anthropic" && !!out.schema);
  ok("--json carries the doc citation", /^https?:\/\//.test(out.docUrl), out.docUrl);

  // The point of the tool: the same schema is rejected by OpenAI strict mode but
  // accepted as-is by Anthropic. --json must report that divergence honestly.
  var oa = JSON.parse(run(["--to", "openai", "--json"], NVIM_SCHEMA).stdout);
  ok("--json reports compliance per provider", out.compliant === true && oa.compliant === false,
    "anthropic=" + out.compliant + " openai=" + oa.compliant);
})();

// --- input handling ----------------------------------------------------------
(function () {
  var r = run(["--to", "openai"], "{not json");
  ok("exits 2 on invalid JSON", r.status === 2, "status=" + r.status);
  ok("says the input isn't valid JSON", r.stderr.indexOf("valid JSON") !== -1, r.stderr);
})();

(function () {
  var r = run(["--to", "openai", path.join(__dirname, "package.json")]);
  ok("reads a schema from a file argument", r.status === 0 || r.status === 3, "status=" + r.status);
})();

(function () {
  var r = run(["--to", "openai", "/nope/missing.json"]);
  ok("exits 2 on an unreadable file", r.status === 2, "status=" + r.status);
})();

// --- usage errors ------------------------------------------------------------
(function () {
  ok("exits 2 without --to", run([], NVIM_SCHEMA).status === 2);
  ok("exits 2 on an unknown provider", run(["--to", "grok"], NVIM_SCHEMA).status === 2);
  ok("exits 2 on an unknown option", run(["--to", "openai", "--wat"], NVIM_SCHEMA).status === 2);
  ok("exits 2 on an unknown --mode", run(["--to", "openai", "--mode", "wat"], NVIM_SCHEMA).status === 2);
  var h = run(["--help"]);
  ok("--help exits 0 and prints usage", h.status === 0 && h.stdout.indexOf("Usage:") !== -1);
  ok("--to=openai equals form works", run(["--to=openai"], NVIM_SCHEMA).status === 0);
})();

// --- example-object mode -----------------------------------------------------
(function () {
  var r = run(["--to", "openai"], JSON.stringify({ name: "ada", age: 36 }));
  ok("infers a schema from an example object", r.status === 0 && JSON.parse(r.stdout).properties.name.type === "string", r.stdout);
  ok("tells the user it inferred", r.stderr.indexOf("inferred") !== -1, r.stderr);
  var s = run(["--to", "openai", "--mode", "schema"], JSON.stringify({ name: "ada", age: 36 }));
  ok("--mode schema skips inference", s.stderr.indexOf("inferred") === -1, s.stderr);
})();

// --- quiet -------------------------------------------------------------------
(function () {
  var r = run(["--to", "openai", "--quiet"], NVIM_SCHEMA);
  ok("--quiet suppresses the ledger", r.stderr.trim() === "", JSON.stringify(r.stderr));
  ok("--quiet still emits the schema", JSON.parse(r.stdout).required.indexOf("args") !== -1);
})();

// --- regression: --check must not false-fail on OpenAI's OWN payload ---------
// This exact shape is what openai@7.4.0 `zodResponseFormat()` puts on the wire
// (its `toStrictJsonSchema()` deliberately retains $schema/$id/annotations).
// The gate used to exit 1 here, i.e. it red-flagged CI for a schema that works.
(function () {
  var SDK_PAYLOAD = JSON.stringify({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      title: { type: "string", description: "the title", minLength: 1 },
      notes: { anyOf: [{ type: "string" }, { type: "null" }] }
    },
    required: ["title", "notes"],
    additionalProperties: false
  });
  var r = run(["--to", "openai", "--check"], SDK_PAYLOAD);
  ok("--check passes on OpenAI's own SDK payload", r.status === 0, r.stderr);

  // ...but still catches a genuinely unsupported keyword.
  var bad = run(["--to", "openai", "--check"], JSON.stringify({
    type: "object",
    properties: { tags: { type: "array", items: { type: "string" }, uniqueItems: true } },
    required: ["tags"],
    additionalProperties: false
  }));
  ok("--check still fails on uniqueItems (SDK throws on it)", bad.status === 1, bad.stderr);
})();

// --- Gemini: --check must not go red on schemas the API accepts -------------
// Verified 2026-08-09 against @google/genai@2.16.0 by capturing the wire payload.
(function () {
  // Verbatim pydantic model_json_schema() output. Every keyword here is a field
  // of the SDK's `Schema` type, so it is accepted as-is; the only thing we have
  // to say about it is an OPTIONAL `propertyOrdering` suggestion.
  var PYD = JSON.stringify({
    properties: {
      name: { description: "full name", maxLength: 20, minLength: 3, title: "Name", type: "string" },
      code: { pattern: "^[A-Z]{3}$", title: "Code", type: "string" }
    },
    required: ["name", "code"], title: "S", type: "object"
  });
  var r = run(["--to", "gemini", "--check"], PYD);
  ok("--check passes on valid pydantic output (propertyOrdering is advisory)", r.status === 0, r.stderr);
  ok("--check still reports the optional suggestion", /optional suggestion/.test(r.stderr), r.stderr);

  // zod-to-json-schema output. The top-level `$schema` is what @google/genai
  // (JS) reads to route to `responseJsonSchema` — but only that client, so the
  // permissive dialect must be ASKED for (`--to gemini-json`), never inferred.
  var ZOD = JSON.stringify({
    $schema: "http://json-schema.org/draft-07/schema#",
    $ref: "#/definitions/S",
    definitions: { S: { type: "object", properties: { name: { type: "string", minLength: 3 } }, required: ["name"] } }
  });
  // Raw zod output does NOT pass: `definitions` is the draft-07 spelling and
  // the accepted list only has `$defs`, so it needs the rename + repoint.
  var z = run(["--to", "gemini-json", "--check"], ZOD);
  ok("--check fails on raw zod output for gemini-json (definitions -> $defs)", z.status === 1, z.stderr);
  ok("gemini-json keeps the $schema routing key", !/Removed .\$schema/.test(z.stderr), z.stderr);

  // ...and the converted output then passes, i.e. the fix is complete.
  var fixed = run(["--to", "gemini"], ZOD);
  var again = run(["--to", "gemini", "--check"], fixed.stdout);
  ok("--check passes on our own gemini output (idempotent)", again.status === 0, again.stderr);

  // ...but a real violation still fails: prefixItems has no home in the proto.
  var bad = run(["--to", "gemini", "--check"], JSON.stringify({
    type: "object",
    properties: { pair: { type: "array", prefixItems: [{ type: "string" }] } },
    propertyOrdering: ["pair"]
  }));
  ok("--check still fails on gemini prefixItems", bad.status === 1, bad.stderr);
})();

// --- Gemini responseJsonSchema path: notes must be VISIBLE ------------------
// A keyword that path ignores needs no edit, so it is an advisory "=" entry and
// therefore not a `change`. Without explicit rendering it fell into the
// "No changes needed" branch and the user was never told their `pattern` is
// unenforced — a silent information loss on the one path where the tool's whole
// value is the warning.
(function () {
  var zodV4 = JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { slug: { type: "string", pattern: "^[a-z-]+$", minLength: 3 } },
    required: ["slug"]
  });
  var r = run(["--to", "gemini-json"], zodV4);
  ok("gemini-json path exits 0 (nothing is rejected)", r.status === 0, r.stderr);
  ok("gemini-json path emits a visible notes section",
    /notes? \(no edit needed/.test(r.stderr), r.stderr);
  ok("the note names the unenforced keyword", /pattern/.test(r.stderr), r.stderr);
  ok("the note explains the routing switch", /responseJsonSchema/.test(r.stderr), r.stderr);
  ok("stdout is still the schema, constraints intact",
    JSON.parse(r.stdout).properties.slug.pattern === "^[a-z-]+$", r.stdout);

  var c = run(["--to", "gemini-json", "--check"], zodV4);
  ok("--check stays green on an ignored-keyword schema", c.status === 0, c.stderr);

  // ...and the SAME schema on the narrow path must NOT silently claim the
  // permissive dialect just because it carries `$schema` (#319).
  var narrow = run(["--to", "gemini"], zodV4);
  ok("--to gemini strips $schema instead of reading it as a route",
    JSON.parse(narrow.stdout).$schema === undefined, narrow.stdout);
  ok("--to gemini says which client the routing key belongs to",
    /gemini-json/.test(narrow.stderr), narrow.stderr);
})();

// --- the gemini tuple false pass -------------------------------------------
// `--check --to gemini` printed "Valid for gemini." and exited 0 for a schema
// `types.Schema` (extra="forbid") rejects with
//   properties.bbox.items: Input should be a valid dictionary or object
// A false pass in a CI gate is worse than no gate, because it is trusted. This
// is the exact payload the Vercel AI SDK sends for `z.tuple([...])`.
(function () {
  var aiSdkTuple = JSON.stringify({
    type: "object",
    properties: {
      bbox: { type: "array", items: [{ type: "number" }, { type: "number" }, { type: "number" }, { type: "number" }] }
    },
    required: ["bbox"]
  });

  var c = run(["--to", "gemini", "--check"], aiSdkTuple);
  ok("--check --to gemini FAILS on an array-form tuple", c.status === 1, c.stderr);
  ok("the failure names the tuple, not something incidental",
    /tuple/i.test(c.stderr), c.stderr);

  var r = run(["--to", "gemini"], aiSdkTuple);
  ok("--to gemini collapses the tuple", r.status === 0, r.stderr);
  var bbox = JSON.parse(r.stdout).properties.bbox;
  ok("emitted gemini schema has no array in `items`", !Array.isArray(bbox.items), r.stdout);
  ok("emitted gemini schema keeps the fixed length",
    bbox.minItems === 4 && bbox.maxItems === 4, r.stdout);

  // A heterogeneous tuple cannot be represented at all -> blocker, exit 3.
  var het = JSON.stringify({
    type: "object",
    properties: { pair: { type: "array", items: [{ type: "string" }, { type: "number" }] } },
    required: ["pair"]
  });
  ok("--to gemini exits 3 on an unrepresentable tuple",
    run(["--to", "gemini"], het).status === 3, "");
})();


// --- #319: the routing switch belongs to a CLIENT, not to Gemini -------------
// Verbatim wire payload captured from @langchain/openai@1.5.6 /
// @langchain/google-genai@2.2.0 (zod@4.4.3) via an intercepting fetch. That
// package depends on the LEGACY @google/generative-ai@0.24.1, which contains
// zero occurrences of `responseJsonSchema` — so its top-level `$schema` routes
// NOTHING and the payload lands on the narrow proto. Reading `$schema` as "the
// permissive path" made `--check --to gemini` exit 0 on this exact schema.
// The live v1beta endpoint rejects it with HTTP 400:
//   Unknown name "$schema" ... Cannot find field.
//   Unknown name "prefixItems" at '...properties[5].value': Cannot find field.
// Converted output reaches auth instead ("API key not valid"), i.e. accepted.
(function () {
  var LANGCHAIN = JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      title: { type: "string", minLength: 3, maxLength: 80, description: "Short summary", title: "ticket" },
      priority: { type: "string", enum: ["low", "medium", "high"], title: "ticket" },
      assignee: { type: "string", title: "ticket" },
      bbox: {
        type: "array", title: "ticket",
        prefixItems: [{ type: "number" }, { type: "number" }, { type: "number" }, { type: "number" }]
      }
    },
    required: ["title", "priority", "bbox"],
    additionalProperties: false,
    title: "ticket"
  });

  var g = run(["--to", "gemini", "--check"], LANGCHAIN);
  ok("#319 --check --to gemini FAILS on the real LangChain payload", g.status === 1, g.stderr);

  var fixed = run(["--to", "gemini"], LANGCHAIN);
  var out = JSON.parse(fixed.stdout);
  ok("#319 narrow path drops $schema (live API: Unknown name \"$schema\")",
    out.$schema === undefined, fixed.stdout);
  ok("#319 narrow path leaves no prefixItems (live API rejects it)",
    JSON.stringify(out).indexOf("prefixItems") === -1, fixed.stdout);
  ok("#319 the fixed-length tuple survives as items+min/maxItems",
    out.properties.bbox.items.type === "number" &&
    out.properties.bbox.minItems === 4 && out.properties.bbox.maxItems === 4,
    JSON.stringify(out.properties.bbox));
  ok("#319 converting again changes nothing (idempotent)",
    run(["--to", "gemini"], fixed.stdout).stdout === fixed.stdout);

  // The same bytes on the path the caller can only pick themselves.
  var j = run(["--to", "gemini-json", "--check"], LANGCHAIN);
  ok("#319 --to gemini-json accepts it (that dialect really does take prefixItems)",
    j.status === 0, j.stderr);
  ok("#319 the two Gemini targets disagree on the same file",
    g.status !== j.status);

  // And OpenAI strict rejects it too: `assignee` is absent from `required`.
  var o = run(["--to", "openai", "--check"], LANGCHAIN);
  ok("#319 --check --to openai FAILS on the real LangChain payload", o.status === 1, o.stderr);
})();


// --- #321 Instructor: the same file must pass one Anthropic target and fail
// the other. Captured verbatim from instructor==1.15.4 (Mode.ANTHROPIC_TOOLS,
// the default) via an httpx intercept on an ordinary Pydantic model.
var INSTRUCTOR_ANTHROPIC = JSON.stringify({
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
});

(function () {
  var tools = run(["--to", "anthropic", "--check"], INSTRUCTOR_ANTHROPIC);
  ok("--check --to anthropic exits 0 on the real Instructor payload (tools path is verbatim)",
    tools.status === 0, tools.stderr);
  ok("the tools path does not propose a tuple collapse",
    !/prefixItems/.test(tools.stderr) || /verbatim|byte-identical/.test(tools.stderr), tools.stderr);

  var json = run(["--to", "anthropic-json", "--check"], INSTRUCTOR_ANTHROPIC);
  ok("--check --to anthropic-json exits 1 on the same payload", json.status === 1, json.stderr);
  ok("anthropic-json explains the demote-to-prose loss",
    /NOT enforced on the .output_format/.test(json.stderr), json.stderr);

  var out = run(["--to", "anthropic"], INSTRUCTOR_ANTHROPIC);
  ok("--to anthropic emits the schema unchanged",
    out.status === 0 &&
    JSON.stringify(JSON.parse(out.stdout)) === JSON.stringify(JSON.parse(INSTRUCTOR_ANTHROPIC)),
    out.stderr);

  var bad = run(["--to", "anthropic-jsonn", "--check"], INSTRUCTOR_ANTHROPIC);
  ok("an unknown provider still lists anthropic-json as valid",
    bad.status === 2 && /anthropic-json/.test(bad.stderr), bad.stderr);
})();

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
