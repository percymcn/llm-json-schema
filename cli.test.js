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
  // #367: was keyed on the literal "NOT enforced on the `output_format`". That
  // premise was falsified — the transform is per-call-site, not per-field — so
  // the assertion is re-keyed on the property it was really testing.
  ok("anthropic-json explains the demote-to-prose loss",
    /is NOT enforced/.test(json.stderr) &&
    /appended to this node's .description./.test(json.stderr), json.stderr);

  var out = run(["--to", "anthropic"], INSTRUCTOR_ANTHROPIC);
  ok("--to anthropic emits the schema unchanged",
    out.status === 0 &&
    JSON.stringify(JSON.parse(out.stdout)) === JSON.stringify(JSON.parse(INSTRUCTOR_ANTHROPIC)),
    out.stderr);

  var bad = run(["--to", "anthropic-jsonn", "--check"], INSTRUCTOR_ANTHROPIC);
  ok("an unknown provider still lists anthropic-json as valid",
    bad.status === 2 && /anthropic-json/.test(bad.stderr), bad.stderr);
})();

// --- #322: the CI gate an Instructor user actually runs ----------------------
//
// Verbatim wire payload from instructor==1.15.4 Mode.TOOLS (the default), which
// omits `strict`. Before this cycle the only target giving the correct verdict was
// named `openai-realtime` — a surface these users are not on and would never type.
var INSTRUCTOR_OPENAI = JSON.stringify({
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
});

(function () {
  var loose = run(["--to", "openai-nonstrict", "--check"], INSTRUCTOR_OPENAI);
  ok("--check --to openai-nonstrict exits 0 on Instructor's default payload",
    loose.status === 0, "status=" + loose.status + " " + loose.stderr);

  var strict = run(["--to", "openai", "--check"], INSTRUCTOR_OPENAI);
  ok("--check --to openai still exits 1 on the same payload (correct for strict)",
    strict.status === 1, "status=" + strict.status);

  ok("the strict failure tells the reader about openai-nonstrict",
    /--to openai-nonstrict/.test(strict.stderr), strict.stderr);

  var out = run(["--to", "openai-nonstrict"], INSTRUCTOR_OPENAI);
  var emitted = null;
  try { emitted = JSON.stringify(JSON.parse(out.stdout)); } catch (e) { emitted = null; }
  ok("--to openai-nonstrict emits the schema unchanged",
    emitted === JSON.stringify(JSON.parse(INSTRUCTOR_OPENAI)), "stdout=" + out.stdout.slice(0, 80));

  var help = run(["--help"]);
  ok("--help lists openai-nonstrict", /openai-nonstrict/.test(help.stdout));
  ok("--help explains which condition selects each OpenAI target",
    /strict absent or false/.test(help.stdout), help.stdout);

  var bad = run(["--to", "openai-nonstrictt", "--check"], INSTRUCTOR_OPENAI);
  ok("an unknown provider lists openai-nonstrict as valid",
    bad.status === 2 && /openai-nonstrict/.test(bad.stderr), bad.stderr);

  var rt = run(["--to", "openai-realtime", "--check"], INSTRUCTOR_OPENAI);
  ok("openai-realtime keeps working for anyone who already scripted it",
    rt.status === 0, "status=" + rt.status);
})();

/* --- pydantic-ai 2.27.0, verbatim captured wire payloads ---------------------
 * Captured by monkeypatching httpx.Client.send/AsyncClient.send with dummy keys
 * (no egress) from ONE ordinary Pydantic model. The point of pinning all three:
 * the same model yields three different schemas and needs three DIFFERENT
 * targets, none of them the one whose name matches the vendor.
 */
var PA_OPENAI = "{\"properties\": {\"title\": {\"description\": \"Short title\", \"maxLength\": 120, \"type\": \"string\"}, \"priority\": {\"$ref\": \"#/$defs/Priority\"}, \"bbox\": {\"description\": \"x1,y1,x2,y2\", \"maxItems\": 4, \"minItems\": 4, \"prefixItems\": [{\"type\": \"integer\"}, {\"type\": \"integer\"}, {\"type\": \"integer\"}, {\"type\": \"integer\"}], \"type\": \"array\"}, \"assignee\": {\"default\": null, \"anyOf\": [{\"type\": \"string\"}, {\"type\": \"null\"}]}, \"tags\": {\"items\": {\"type\": \"string\"}, \"type\": \"array\"}, \"meta\": {\"$ref\": \"#/$defs/Meta\"}}, \"required\": [\"title\", \"priority\", \"bbox\", \"meta\"], \"type\": \"object\", \"additionalProperties\": false, \"$defs\": {\"Meta\": {\"description\": \"Nested metadata.\", \"properties\": {\"level\": {\"maxLength\": 8, \"minLength\": 2, \"pattern\": \"^[a-z]+$\", \"type\": \"string\"}, \"score\": {\"maximum\": 100, \"minimum\": 0, \"type\": \"integer\"}}, \"required\": [\"level\", \"score\"], \"type\": \"object\", \"additionalProperties\": false}, \"Priority\": {\"enum\": [\"low\", \"high\"], \"type\": \"string\"}}}";
var PA_ANTHROPIC = "{\"properties\": {\"title\": {\"description\": \"Short title\", \"maxLength\": 120, \"type\": \"string\"}, \"priority\": {\"$ref\": \"#/$defs/Priority\"}, \"bbox\": {\"description\": \"x1,y1,x2,y2\", \"maxItems\": 4, \"minItems\": 4, \"prefixItems\": [{\"type\": \"integer\"}, {\"type\": \"integer\"}, {\"type\": \"integer\"}, {\"type\": \"integer\"}], \"type\": \"array\"}, \"assignee\": {\"default\": null, \"anyOf\": [{\"type\": \"string\"}, {\"type\": \"null\"}]}, \"tags\": {\"items\": {\"type\": \"string\"}, \"type\": \"array\"}, \"meta\": {\"$ref\": \"#/$defs/Meta\"}}, \"required\": [\"title\", \"priority\", \"bbox\", \"meta\"], \"type\": \"object\", \"$defs\": {\"Meta\": {\"description\": \"Nested metadata.\", \"properties\": {\"level\": {\"maxLength\": 8, \"minLength\": 2, \"pattern\": \"^[a-z]+$\", \"type\": \"string\"}, \"score\": {\"maximum\": 100, \"minimum\": 0, \"type\": \"integer\"}}, \"required\": [\"level\", \"score\"], \"type\": \"object\"}, \"Priority\": {\"enum\": [\"low\", \"high\"], \"type\": \"string\"}}}";
var PA_GEMINI = "{\"properties\": {\"title\": {\"description\": \"Short title\", \"maxLength\": 120, \"type\": \"string\"}, \"priority\": {\"$ref\": \"#/$defs/Priority\"}, \"bbox\": {\"description\": \"x1,y1,x2,y2\", \"maxItems\": 4, \"minItems\": 4, \"prefixItems\": [{\"type\": \"integer\"}, {\"type\": \"integer\"}, {\"type\": \"integer\"}, {\"type\": \"integer\"}], \"type\": \"array\"}, \"assignee\": {\"default\": null, \"anyOf\": [{\"type\": \"string\"}, {\"type\": \"null\"}]}, \"tags\": {\"items\": {\"type\": \"string\"}, \"type\": \"array\"}, \"meta\": {\"$ref\": \"#/$defs/Meta\"}}, \"required\": [\"title\", \"priority\", \"bbox\", \"meta\"], \"type\": \"object\", \"$defs\": {\"Meta\": {\"description\": \"Nested metadata.\", \"properties\": {\"level\": {\"maxLength\": 8, \"minLength\": 2, \"pattern\": \"^[a-z]+$\", \"type\": \"string\"}, \"score\": {\"maximum\": 100, \"minimum\": 0, \"type\": \"integer\"}}, \"required\": [\"level\", \"score\"], \"type\": \"object\"}, \"Priority\": {\"enum\": [\"low\", \"high\"], \"type\": \"string\"}}}";
// pydantic-ai sets strict:true on this one; openai's own toStrictJsonSchema()
// throws on it ("unsupported keyword `prefixItems`"), so it is a guaranteed 400.
var PA_TUPLE_STRICT_TRUE = "{\"properties\": {\"title\": {\"type\": \"string\"}, \"bbox\": {\"maxItems\": 4, \"minItems\": 4, \"prefixItems\": [{\"type\": \"integer\"}, {\"type\": \"integer\"}, {\"type\": \"integer\"}, {\"type\": \"integer\"}], \"type\": \"array\"}}, \"required\": [\"title\", \"bbox\"], \"type\": \"object\", \"additionalProperties\": false}";

(function () {
  var o = run(["--to", "openai", "--check"], PA_OPENAI);
  ok("pydantic-ai openai payload is not strict-compliant", o.status === 1, "status=" + o.status);
  ok("...and the failure names the target that DOES accept it",
    /already valid as-is for:.*openai-nonstrict/.test(o.stderr), o.stderr);

  var on = run(["--to", "openai-nonstrict", "--check"], PA_OPENAI);
  ok("pydantic-ai openai payload is valid non-strict (it sends strict:false)", on.status === 0, "status=" + on.status);

  var an = run(["--to", "anthropic", "--check"], PA_ANTHROPIC);
  ok("pydantic-ai anthropic payload is valid for the tools path", an.status === 0, "status=" + an.status);
  var aj = run(["--to", "anthropic-json", "--check"], PA_ANTHROPIC);
  ok("...and the same bytes are NOT valid for output_format", aj.status === 1, "status=" + aj.status);

  var gj = run(["--to", "gemini-json", "--check"], PA_GEMINI);
  ok("pydantic-ai gemini payload is valid for parametersJsonSchema", gj.status === 0, "status=" + gj.status);
  var gn = run(["--to", "gemini", "--check"], PA_GEMINI);
  ok("...and NOT for the narrow Schema proto", gn.status === 1, "status=" + gn.status);
  ok("the narrow-path failure points at gemini-json",
    /already valid as-is for:.*gemini-json/.test(gn.stderr), gn.stderr);

  var tu = run(["--to", "openai", "--check"], PA_TUPLE_STRICT_TRUE);
  ok("we reject the tuple schema pydantic-ai marks strict:true (a real 400)",
    tu.status === 1, "status=" + tu.status);

  var quiet = run(["--to", "openai", "--check"], JSON.stringify({
    type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false
  }));
  ok("a passing gate prints no wrong-target diagnosis",
    quiet.status === 0 && !/already valid as-is for/.test(quiet.stderr), quiet.stderr);

  var j = run(["--to", "openai", "--json"], PA_OPENAI);
  var parsed = null; try { parsed = JSON.parse(j.stdout); } catch (e) {}
  ok("--json exposes alsoValidFor for CI consumers",
    parsed && parsed.alsoValidFor && parsed.alsoValidFor.indexOf("openai-nonstrict") !== -1,
    j.stdout.slice(0, 120));
})();

// --- LangChain Python (#324): the anthropic-json split, end to end -------------
(function () {
  // Verbatim: pydantic 2.13.4 RootModel-shaped root, the shape LangChain Python
  // hands to anthropic's transformer unchanged.
  var LC_ROOT_REF = JSON.stringify({
    "$ref": "#/$defs/Ticket",
    "$defs": {
      "Ticket": {
        "type": "object", "title": "Ticket",
        "properties": { "kind": { "type": "string", "enum": ["bug", "feature"] } },
        "required": ["kind"]
      }
    }
  });

  var js = run(["--to", "anthropic-json", "--check"], LC_ROOT_REF);
  var py = run(["--to", "anthropic-json-python", "--check"], LC_ROOT_REF);
  ok("anthropic-json fails on a root $ref (TypeScript SDK drops $defs)",
    js.status === 1, "status=" + js.status);
  ok("anthropic-json-python passes the same bytes",
    py.status === 0, "status=" + py.status);

  var jsOut = run(["--to", "anthropic-json"], LC_ROOT_REF);
  var pyOut = run(["--to", "anthropic-json-python"], LC_ROOT_REF);
  ok("the two targets emit different schemas for one file",
    jsOut.stdout !== pyOut.stdout);
  // Parse defensively: an unknown provider writes nothing to stdout, and a
  // throwing test aborts the file instead of reporting (#322).
  function parseOr(s, fallback) { try { return JSON.parse(s); } catch (e) { return fallback; } }
  ok("the Python target's output is byte-identical to its input",
    JSON.stringify(parseOr(pyOut.stdout, null)) === JSON.stringify(JSON.parse(LC_ROOT_REF)));

  ok("the failing TypeScript target names the Python one",
    /anthropic-json-python/.test(js.stderr), js.stderr.slice(0, 200));

  var help = run(["--help"], "");
  ok("--help lists anthropic-json-python", /anthropic-json-python/.test(help.stdout));
  ok("--help says what selects it (SDK language, not version)",
    /same version string/.test(help.stdout) || /SDK LANGUAGE/.test(help.stdout), help.stdout.slice(0, 400));

  var bad = run(["--to", "anthropic-json-pythonn", "--check"], LC_ROOT_REF);
  ok("a typo'd provider is still rejected", bad.status === 2, "status=" + bad.status);
})();

// Cycle #326. The defect was an EXIT CODE: `--check --to gemini` returned 0 for
// a schema `google-genai` (Python) refuses to build, so a CI gate went green on
// a request that cannot be sent. Pinned here as well as in the engine, because
// the exit code is what CI actually reads.
(function () {
  var NULLABLE = JSON.stringify({
    type: "object",
    properties: { note: { type: ["string", "null"] } },
    required: ["note"]
  });

  var narrow = run(["--to", "gemini", "--check"], NULLABLE);
  ok("a union `type` fails --check on the narrow gemini path",
    narrow.status === 1, "status=" + narrow.status);
  ok("...and the diagnosis names the single-valued proto enum",
    /single-valued enum|REFUSES TO BUILD/.test(narrow.stderr), narrow.stderr.slice(0, 300));

  var permissive = run(["--to", "gemini-json", "--check"], NULLABLE);
  ok("the same schema passes on gemini-json (a union type is legal there)",
    permissive.status === 0, "status=" + permissive.status);

  var converted = run(["--to", "gemini"], NULLABLE);
  var out = JSON.parse(converted.stdout);
  ok("the converted narrow-path output carries nullable, not an array type",
    out.properties.note.type === "string" && out.properties.note.nullable === true,
    converted.stdout);
  var twice = run(["--to", "gemini", "--check"], converted.stdout);
  ok("the converted output then passes its own gate", twice.status === 0, "status=" + twice.status);
})();

// --- Anthropic: a union `type` is a dispatch miss, and WE create the input --
//
// Cycle #327. The fixture is not hand-written: it is byte-for-byte what our own
// `--to openai` emits for a schema with an optional object property (the
// forced-required rewrite from #311). So the multi-provider user who converts
// for OpenAI and then targets Anthropic hits exactly this. Measured against
// `@anthropic-ai/sdk@0.116.0` (guts the subtree into prose, silently) and
// `anthropic==0.121.0` (raises `AssertionError`, no request built).
(function () {
  var WITH_OPTIONAL_OBJECT = JSON.stringify({
    type: "object",
    properties: {
      o: { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false },
      s: { type: "string" }
    },
    required: ["s"],
    additionalProperties: false
  });

  var oai = run(["--to", "openai"], WITH_OPTIONAL_OBJECT);
  var oaiOut = JSON.parse(oai.stdout);
  ok("our own --to openai output contains a union `type` with a live subtree",
    Array.isArray(oaiOut.properties.o.type) && !!oaiOut.properties.o.properties,
    oai.stdout);

  var jsChk = run(["--to", "anthropic-json", "--check"], oai.stdout);
  ok("that output fails --check on anthropic-json", jsChk.status === 1, "status=" + jsChk.status);
  ok("...and the diagnosis says the subtree stops being schema",
    /never recurses|stringified into this node/.test(jsChk.stderr), jsChk.stderr.slice(0, 300));

  var pyChk = run(["--to", "anthropic-json-python", "--check"], oai.stdout);
  ok("the same output fails --check on anthropic-json-python",
    pyChk.status === 1, "status=" + pyChk.status);
  ok("...and cites the Python assert rather than a demotion",
    /assert_never|unreachable/.test(pyChk.stderr), pyChk.stderr.slice(0, 300));

  var toolsChk = run(["--to", "anthropic", "--check"], oai.stdout);
  ok("but it PASSES on the tools path, which applies no transform",
    toolsChk.status === 0, "status=" + toolsChk.status);

  var fixed = run(["--to", "anthropic-json"], oai.stdout);
  var f = JSON.parse(fixed.stdout).properties.o;
  ok("the fix turns the union into anyOf and keeps the subtree",
    Array.isArray(f.anyOf) && !!f.anyOf[0].properties && f.anyOf[0].properties.a.type === "string",
    fixed.stdout);
  var twice = run(["--to", "anthropic-json", "--check"], fixed.stdout);
  ok("the converted output then passes its own gate", twice.status === 0, "status=" + twice.status);
})();

// --- an open map is a blocker at the CLI, not a silent "fixed" -------------
// Verbatim `to_strict_json_schema()` output from openai==2.53.0 for a Pydantic
// model with `meta: Dict[str, str]`. Before this was a blocker the CLI printed
// a one-line fix and exited 1; applying that fix produced a schema the API
// accepts and the model can never populate.
(function () {
  var DICT = JSON.stringify({
    properties: {
      name: { title: "Name", type: "string" },
      meta: { additionalProperties: { type: "string" }, title: "Meta", type: "object" }
    },
    required: ["name", "meta"], title: "M1", type: "object", additionalProperties: false
  });

  var chk = run(["--to", "openai", "--check"], DICT);
  // 3, not 1: an open map cannot be repaired by rerunning the converter, and
  // exit 3 is the code that says so. This assertion read `=== 1` when the
  // blocker shipped, because `--check` was tested before blockers and masked
  // them; the intent ("fails the gate") was always the point, and 3 fails it
  // while also telling a CI script that committing our output will not help.
  ok("an open map fails --check instead of reporting a one-line fix",
    chk.status === 3, "status=" + chk.status);
  ok("...and the diagnosis says the field could never be populated",
    /could never be populated/.test(chk.stderr), chk.stderr.slice(0, 300));
  ok("...and it is marked as needing a human fix, not an auto-fix",
    /needs a human fix/.test(chk.stderr), chk.stderr.slice(0, 300));

  var conv = run(["--to", "openai"], DICT);
  ok("converting exits 3 — a blocker survived the conversion",
    conv.status === 3, "status=" + conv.status);
  ok("the element type is left visible instead of being deleted",
    JSON.parse(conv.stdout).properties.meta.additionalProperties.type === "string", conv.stdout);

  var tools = run(["--to", "anthropic", "--check"], DICT);
  ok("the same file passes on anthropic tools, which sends it verbatim",
    tools.status === 0, "status=" + tools.status);

  var gemJson = run(["--to", "gemini-json", "--check"], DICT);
  ok("...and on gemini-json, whose accepted list includes additionalProperties",
    gemJson.status === 0, "status=" + gemJson.status);
})();

// ---------------------------------------------------------------------------
// #330: exit 3 must outrank exit 1 under --check.
//
// `changes` includes `!` entries, so testing `--check` first made exit 3 --
// documented at the top of cli.js as "a blocker needs a human fix" --
// unreachable in check mode: every blocker returned 1, the same code as a
// schema the converter can fix for you. A CI script that resolves a 1 by
// rerunning without --check and committing the output can never resolve a 3.
(function () {
  var UNDECLARED = JSON.stringify({
    type: "object",
    properties: { f: { type: "object", properties: { a: { type: "string" } }, required: ["a", "ghost"] } },
    required: ["f"], additionalProperties: false
  });

  var chk = run(["--to", "openai", "--check"], UNDECLARED);
  ok("--check exits 3 on an undeclared `required` key, not 1",
    chk.status === 3, "status=" + chk.status);
  ok("...and says which key and why no automatic fix exists",
    /`ghost`/.test(chk.stderr) && /does not declare/.test(chk.stderr),
    chk.stderr.slice(0, 300));

  var conv = run(["--to", "openai"], UNDECLARED);
  ok("converting also exits 3 rather than emitting a weakened schema",
    conv.status === 3, "status=" + conv.status);
  ok("...and the output still carries the undeclared key, left visible",
    /ghost/.test(conv.stdout), conv.stdout.slice(0, 200));

  // A fixable diff must still be 1, or the reordering has flattened the
  // distinction in the other direction.
  var fixable = JSON.stringify({
    type: "object",
    properties: { a: { type: "string" }, b: { type: "integer" } },
    required: ["a"]
  });
  ok("an ordinary fixable schema still exits 1 under --check",
    run(["--to", "openai", "--check"], fixable).status === 1);
  ok("...and a fully valid one still exits 0",
    run(["--to", "openai", "--check"], run(["--to", "openai"], fixable).stdout).status === 0);
})();

// --- `anthropic-go` is a real target and disagrees with the other two -------
(function () {
  var UNION = JSON.stringify({
    type: "object", properties: { a: { type: ["string", "null"] } }, required: ["a"]
  });
  ok("--to anthropic-go is accepted as a provider",
    run(["--to", "anthropic-go", "--check"], UNION).status !== 2);
  // The whole point of the split: the same file, two verdicts. Go loses the
  // entire document to that union; the TypeScript SDK loses nothing (#327).
  ok("the same union file exits 1 for anthropic-go and 0 for anthropic-json",
    run(["--to", "anthropic-go", "--check"], UNION).status === 1 &&
    run(["--to", "anthropic-json", "--check"], UNION).status === 0);
  ok("...and converting it produces something anthropic-go then accepts",
    run(["--to", "anthropic-go", "--check"],
      run(["--to", "anthropic-go"], UNION).stdout).status === 0);

  // A typeless node is a blocker, and a blocker must be 3, not 1 (#330).
  var TYPELESS = JSON.stringify({
    type: "object",
    properties: { n: { properties: { a: { type: "string" } }, required: ["a"] } },
    required: ["n"]
  });
  var t = run(["--to", "anthropic-go", "--check"], TYPELESS);
  ok("a typeless node exits 3 on anthropic-go", t.status === 3, "status=" + t.status);
  ok("...and the diagnosis names the `true` replacement",
    /literal JSON `true`/.test(t.stderr), t.stderr.slice(0, 200));

  // Not stricter than the vendor: enum/const/pattern all survive in Go, so a
  // schema using them must pass cleanly.
  var KEPT = JSON.stringify({
    type: "object",
    properties: { p: { type: "string", enum: ["a", "b"], pattern: "^a" } },
    required: ["p"]
  });
  var k = run(["--to", "anthropic-go", "--check"], KEPT);
  ok("enum + pattern pass anthropic-go untouched", k.status === 0, "status=" + k.status);
  ok("...while anthropic-json still reports them unenforced",
    /NOT enforced/.test(run(["--to", "anthropic-json", "--check"], KEPT).stderr));

  ok("--help lists anthropic-go with the condition that selects it",
    /anthropic-go/.test(run(["--help"], "").stdout) &&
    /anthropic-sdk-go/.test(run(["--help"], "").stdout));
})();

// ---------------------------------------------------------------------------
// Boolean subschemas (Cycle #333) — exit codes and target divergence.
(function () {
  // Verbatim output of openai-go@v3.50.0's README `GenerateSchema[T]()` recipe
  // for `struct { Name string; Data any }`.
  var GO_ANY = '{"$schema": "https://json-schema.org/draft/2020-12/schema", "additionalProperties": false, "properties": {"data": true, "name": {"type": "string"}}, "required": ["name", "data"], "type": "object"}';

  var o = run(["--to", "openai", "--check"], GO_ANY);
  ok("a boolean subschema exits 3 on openai", o.status === 3, "status=" + o.status);
  ok("...and the diagnosis says it matches any value",
    /matches ANY value/.test(o.stderr), o.stderr.slice(0, 200));
  ok("...and names a remedy rather than only refusing",
    /serialized JSON/.test(o.stderr));

  // The same bytes are legal on the surfaces where they are legal — a blocker
  // that fired everywhere would just be a false CI failure somewhere else.
  ok("the same file exits 0 on openai-nonstrict",
    run(["--to", "openai-nonstrict", "--check"], GO_ANY).status === 0);
  ok("the same file exits 0 on anthropic (tools, verbatim)",
    run(["--to", "anthropic", "--check"], GO_ANY).status === 0);
  ok("the same file exits 0 on anthropic-go (measured verbatim, both surfaces)",
    run(["--to", "anthropic-go", "--check"], GO_ANY).status === 0);
  ok("the same file exits 3 on anthropic-json (TS transformer throws)",
    run(["--to", "anthropic-json", "--check"], GO_ANY).status === 3);
  ok("the same file exits 0 on gemini-json",
    run(["--to", "gemini-json", "--check"], GO_ANY).status === 0);

  // A blocker must outrank a fixable change (#330) — this schema also needs an
  // `additionalProperties` edit on some targets, and 3 must still win.
  ok("exit 3 outranks the fixable changes in the same file",
    run(["--to", "openai", "--check"], GO_ANY).status === 3);
})();

// --- Cycle #334: the Go-client note is advisory and must not fail a gate ----
// A schema that is fully valid for the narrow `responseSchema` path but carries
// an explicit `default: null` (every Pydantic `Optional[x] = None` field) picks
// up a Go-only note. An advisory that failed `--check` would be a false CI
// failure for JS and Python callers, which is the exact bug #317 fixed.
(function () {
  var NULL_DEFAULT = JSON.stringify({
    type: "object",
    properties: { note: { type: "string", "default": null }, id: { type: "string" } },
    required: ["id"],
    propertyOrdering: ["note", "id"]
  });
  var o = run(["--to", "gemini", "--check"], NULL_DEFAULT);
  ok("a `default: null` schema still passes --check for gemini", o.status === 0);
  ok("...and the Go-only loss is reported anyway", /omitempty/.test(o.stderr));
  ok("`default: null` is not deleted from the output",
    JSON.parse(run(["--to", "gemini"], NULL_DEFAULT).stdout).properties.note.default === null);
  ok("the note does not appear on gemini-json",
    !/omitempty/.test(run(["--to", "gemini-json", "--check"], NULL_DEFAULT).stderr));
})();

// #336 — `gemini-client` is a real, selectable target and the CLI says what
// selects it. Picking the wrong one of the three Gemini targets is silent, so
// the condition has to be visible at the point the reader chooses (#322).
(function () {
  var UNION = JSON.stringify({ type: "object", properties: { v: { type: ["string", "null"] } }, required: ["v"] });
  var LOOSE = JSON.stringify({ type: "object", properties: { a: { type: "array" } }, required: ["a"] });

  ok("gemini-client is an accepted provider", run(["--to", "gemini-client"], UNION).status !== 2);
  ok("--help lists gemini-client beside its condition",
    /gemini-client[\s\S]{0,160}converts it for you/.test(run(["--help"], "").stdout));

  // The same file, two targets, two different documents — the point of the split.
  // Parse defensively: with the converter absent the CLI writes nothing to
  // stdout, and a bare JSON.parse would abort the whole file instead of
  // reporting a failure (#322).
  function propOf(args) {
    try { return (JSON.parse(run(args, UNION).stdout).properties || {}).v || {}; }
    catch (e) { return {}; }
  }
  var narrow = propOf(["--to", "gemini"]);
  var client = propOf(["--to", "gemini-client"]);
  ok("the same file yields different output for gemini vs gemini-client",
    narrow.nullable === true && client.nullable === undefined && Array.isArray(client.type));

  // Advisories must never fail a gate (#317). Isolate the note: UNION itself
  // legitimately needs the rewrite, so it exits 1 on its own merits. A schema
  // that ALREADY carries `nullable` needs no edit, so only the advisory is left
  // and --check has to stay green.
  var ALREADY = JSON.stringify({ type: "object", properties: { v: { type: "string", nullable: true } },
    required: ["v"], propertyOrdering: ["v"] });
  ok("the nullable-exclusivity note does not fail --check",
    run(["--to", "gemini", "--check"], ALREADY).status === 0);
  ok("...and it is printed", /silently stop being nullable/.test(run(["--to", "gemini", "--check"], ALREADY).stderr));
  ok("a schema needing the union rewrite still fails --check on its own merits",
    run(["--to", "gemini", "--check"], UNION).status === 1);
  ok("an itemless array does not fail --check", run(["--to", "gemini", "--check"], LOOSE).status === 0);
  ok("...and it is printed", /declares no element type/.test(run(["--to", "gemini", "--check"], LOOSE).stderr));
  ok("the itemless-array note is absent on gemini-json",
    !/declares no element type/.test(run(["--to", "gemini-json", "--check"], LOOSE).stderr));
})();

// Cycle #337 — the false CI failure this fixes, at the exit-code level.
// `{"anyOf":[{"type":"string"},{"type":"null"}]}` is verbatim `pydantic
// 2.13.4` output for `Optional[str] = None` and is ACCEPTED by the live v1beta
// proto as written. --check used to exit 1 on it and propose an edit.
(function () {
  var PYDANTIC_OPTIONAL = JSON.stringify({
    type: "object", title: "OptionalStr",
    properties: {
      title: { type: "string", title: "Title" },
      note: { anyOf: [{ type: "string" }, { type: "null" }], default: null, title: "Note" }
    },
    required: ["title"]
  });
  ["gemini", "gemini-client"].forEach(function (t) {
    var r = run(["--to", t, "--check"], PYDANTIC_OPTIONAL);
    ok("pydantic `Optional[str]` passes --check --to " + t, r.status === 0);
    ok("...and no null rewrite is proposed on " + t, !/Rewrote `type: "null"`/.test(r.stderr));
  });
  // The standalone form is a genuinely different input and must still be fixed.
  var STANDALONE_NULL = JSON.stringify({ type: "object", properties: { n: { type: "null" } }, required: ["n"] });
  ok("a standalone null-only type still needs a change",
    run(["--to", "gemini", "--check"], STANDALONE_NULL).status === 1);
})();

// --- #341: llama-index RootModel tool params reach the CLI as a rootless schema
(function () {
  // Verbatim `ToolMetadata.get_parameters_dict()` output for a RootModel tool,
  // plus the top-level additionalProperties llama-index-llms-openai adds.
  var LI_ROOT_REF = JSON.stringify({
    "$defs": { "Inner": { "properties": { "x": { "title": "X", "type": "integer" } },
                          "required": ["x"], "title": "Inner", "type": "object" } },
    "additionalProperties": false
  });

  var o = run(["--to", "openai", "--check"], LI_ROOT_REF);
  ok("li rootless: --to openai exits 3, not 0", o.status === 3, "status=" + o.status);
  ok("li rootless: it is NOT reported as an inferred example",
    o.stderr.indexOf("inferred a schema from it") === -1, o.stderr);
  ok("li rootless: the diagnosis names the dropped pointer",
    o.stderr.indexOf("the pointer") !== -1, o.stderr);

  var a = run(["--to", "anthropic", "--check"], LI_ROOT_REF);
  ok("li rootless: --to anthropic exits 3, not 0", a.status === 3, "status=" + a.status);

  // Gemini's proto has no root-must-be-object rule (measured on
  // google-genai==2.17.0), so this must NOT become a blocker there.
  var g = run(["--to", "gemini-json", "--check"], LI_ROOT_REF);
  ok("li rootless: --to gemini-json is not blocked", g.status !== 3, "status=" + g.status);

  // A typeless root that DOES declare properties is a fixable 1, not a 3 --
  // the whole point of separating the two arms.
  var tp = run(["--to", "openai", "--check"],
    JSON.stringify({ properties: { a: { type: "string" } }, required: ["a"] }));
  ok("typeless root WITH properties is fixable (1), not a blocker (3)",
    tp.status === 1, "status=" + tp.status);
  var fixed = JSON.parse(run(["--to", "openai"],
    JSON.stringify({ properties: { a: { type: "string" } }, required: ["a"] })).stdout);
  ok("and the fix supplies type: object", fixed.type === "object", JSON.stringify(fixed));

  // The example-inference feature still works, and still says so.
  var ex = run(["--to", "openai"], JSON.stringify({ items: [{ sku: "a" }], total: 12.5 }));
  ok("an invoice example is still treated as an example",
    ex.stderr.indexOf("inferred a schema from it") !== -1, ex.stderr);
})();



// Cycle #343: the three proto-only keywords are an ADVISORY on --to gemini.
// An advisory that failed CI would be #317s exact mistake: the destination
// accepts this document, so the gate must pass.
(function () {
  var PET = JSON.stringify({ title: "Pet", oneOf: [
    { type: "object", properties: { meow: { type: "string" } }, required: ["meow"] },
    { type: "object", properties: { bark: { type: "string" } }, required: ["bark"] } ] });

  var chk = run(["--to", "gemini", "--check"], PET);
  ok("gemini --check passes a oneOf schema (advisory, not a failure)",
    chk.status === 0, "status=" + chk.status);
  var conv = JSON.parse(run(["--to", "gemini"], PET).stdout);
  ok("and the union survives conversion",
    Array.isArray(conv.oneOf) && conv.oneOf.length === 2, JSON.stringify(conv));
  ok("the advisory reaches stderr and names the per-client outcome",
    run(["--to", "gemini"], PET).stderr.indexOf("depends on YOUR client") !== -1);

  // #365: this used to assert the two targets disagree about this file, with
  // `gemini-client` stripping the union. That strip was the defect — measured
  // 2026-08-10, `@ai-sdk/google` 4.0.39 forwards `oneOf` verbatim — so the
  // targets now AGREE here, and the disagreement they genuinely have is about
  // the union `type` spelling, pinned separately below.
  var ccRun = run(["--to", "gemini-client"], PET);
  var cc = JSON.parse(ccRun.stdout);
  ok("gemini-client KEEPS the union too", Array.isArray(cc.oneOf) && cc.oneOf.length === 2,
    JSON.stringify(cc));
  ok("gemini-client --check still passes (advisory, never a gate failure)",
    ccRun.status === 0, "status=" + ccRun.status);
  ok("and the advisory names both clients by name",
    ccRun.stderr.indexOf("@ai-sdk/google") !== -1 &&
    ccRun.stderr.indexOf("google-adk") !== -1);

  // The real, measured disagreement between the two targets, on one file: the
  // narrow path rewrites a nullable union to the proto spelling, the converting
  // path must leave it alone because BOTH measured clients drop a hand-written
  // `nullable` (#336/#365) and do the rewrite themselves.
  var NULLABLE = JSON.stringify({ type: "object",
    properties: { a: { type: ["string", "null"] } }, required: ["a"] });
  var narrow = JSON.parse(run(["--to", "gemini"], NULLABLE).stdout);
  var client = JSON.parse(run(["--to", "gemini-client"], NULLABLE).stdout);
  ok("gemini rewrites the nullable union to the proto spelling",
    narrow.properties.a.nullable === true, JSON.stringify(narrow));
  ok("gemini-client leaves the union spelling alone",
    Array.isArray(client.properties.a.type), JSON.stringify(client));

  // Guard: a keyword the endpoint really rejects must still fail the gate.
  var bad = run(["--to", "gemini", "--check"],
    JSON.stringify({ type: "object", properties: { a: { type: "string" } },
      patternProperties: { "^a": { type: "string" } } }));
  ok("a genuinely rejected keyword still fails --check",
    bad.status !== 0, "status=" + bad.status);
})();

// --- #344: an ordinary pydantic model must not fail the Gemini gate ----------
//
// Verbatim `model_json_schema()` output for EmailStr / AnyUrl / UUID. The live
// v1beta endpoint ACCEPTS this document as written, and we were exiting 1 and
// proposing to delete all three formats.
(function () {
  var CONTACT = JSON.stringify({
    properties: {
      email:   { format: "email", title: "Email", type: "string" },
      website: { format: "uri", minLength: 1, title: "Website", type: "string" },
      ref:     { format: "uuid", title: "Ref", type: "string" },
      name:    { maxLength: 40, title: "Name", type: "string" }
    },
    required: ["email", "website", "ref", "name"],
    title: "Contact", type: "object"
  });

  var c = run(["--to", "gemini", "--check"], CONTACT);
  ok("pydantic formats do not fail the gemini gate", c.status === 0,
    "exit " + c.status);

  var g = run(["--to", "gemini"], CONTACT);
  var out = JSON.parse(g.stdout);
  ok("all three formats survive conversion",
    out.properties.email.format === "email" &&
    out.properties.website.format === "uri" &&
    out.properties.ref.format === "uuid");
  ok("the ledger no longer claims to remove a format",
    g.stderr.indexOf("Removed `format") === -1);
  ok("the undocumented ones are surfaced as notes",
    g.stderr.indexOf("Kept `format: uuid`") !== -1);

  // A genuinely rejected keyword must still fail, so the gate is not simply
  // more permissive across the board.
  var bad = run(["--to", "gemini", "--check"],
    JSON.stringify({ type: "object", properties: { a: { type: "string" } },
                     patternProperties: { "^x": { type: "string" } } }));
  ok("a service-rejected keyword still fails the gemini gate", bad.status !== 0);
})();

// The empty-tuple false pass, at the gate level. `{"type":"array","items":[]}`
// is verbatim zod 4.4.3 output for `z.tuple([])` with `target: "draft-7"`.
(function () {
  var EMPTY_TUPLE = JSON.stringify({
    type: "object",
    properties: { b: { type: "array", items: [] } },
    required: ["b"],
    additionalProperties: false
  });

  // Was exit 0 on all four of these while every one of the four vendors
  // rejects or destroys the document.
  ["openai", "anthropic-json", "anthropic-json-python", "anthropic-go"].forEach(function (t) {
    ok("`--check --to " + t + "` no longer passes an empty draft-07 tuple",
      run(["--to", t, "--check"], EMPTY_TUPLE).status !== 0);
  });

  // OpenAI cannot be repaired -- there is no element type to invent (#336) --
  // so it is a blocker, and exit 3 is the code that says "committing our
  // output will not help" (#330).
  ok("openai reports it as a blocker, not a fixable change",
    run(["--to", "openai", "--check"], EMPTY_TUPLE).status === 3);

  // Over-block guard: the tools path sends the schema verbatim and `betaTool`
  // accepts it, so this gate must still pass.
  ok("`--check --to anthropic` (tools) still passes it",
    run(["--to", "anthropic", "--check"], EMPTY_TUPLE).status === 0);

  // The compounding half: `alsoValidFor` was affirmatively recommending four
  // targets that reject the document.
  var advice = run(["--to", "gemini"], EMPTY_TUPLE);
  ok("`alsoValidFor` no longer recommends targets that reject it",
    advice.stderr.indexOf("anthropic-json") === -1 &&
    advice.stderr.indexOf("already valid as-is for") !== -1);

  // And the repair actually reaches the output the user is told to commit.
  var fixed = run(["--to", "anthropic-json"], EMPTY_TUPLE);
  ok("the converted output carries no array-form `items`",
    fixed.status === 0 && JSON.parse(fixed.stdout).properties.b.items === undefined);
})();

// --- Cycle #347: a node no value can satisfy, at the CLI boundary -----------
(function () {
  // `additionalProperties: false` is part of the FIXTURE, not incidental: without
  // it openai proposes adding it and the run exits 1 for a reason that has
  // nothing to do with this rule, which would make the assertions below
  // non-discriminating.
  function doc(p) {
    return JSON.stringify({ type: "object",
      properties: { a: { type: "string" }, p: p }, required: ["a", "p"],
      additionalProperties: false });
  }
  var ZOD_NEVER = doc({ not: {} });      // zod 4.4.3 z.never()
  var ZOD_ENUM0 = doc({ type: "string", "enum": [] }); // zod 4.4.3 z.enum([])
  var ZOD_UNION0 = doc({ anyOf: [] });   // zod 4.4.3 z.union([])
  var CONTROL = doc({ type: "string", "enum": ["a", "b"] });

  // Stripping a match-anything `not` inverts the node, so it is a blocker (3),
  // not a fixable edit (1) whose output the user is told to commit.
  var never = run(["--to", "openai", "--check"], ZOD_NEVER);
  ok("`z.never()` exits 3 on openai, not 1", never.status === 3);
  ok("the CLI explains the inversion rather than reporting a routine strip",
    never.stderr.indexOf("INVERT") !== -1);

  // The old behaviour, pinned as a regression: the emitted node must not be the
  // match-anything `{}`.
  var out = run(["--to", "openai"], ZOD_NEVER);
  ok("`--to openai` does not emit a match-anything `{}` for `z.never()`",
    JSON.stringify(JSON.parse(out.stdout).properties.p) !== "{}");

  // The three spellings of "this node accepts anything / nothing" agree.
  ok("a bare boolean `true` node is still a blocker (#333 pin)",
    run(["--to", "openai", "--check"], doc(true)).status === 3);

  // Carried shapes: advisory only. An advisory must never fail a build.
  ok("`z.enum([])` passes the gate on openai and says the field is dead",
    (function () { var r = run(["--to", "openai", "--check"], ZOD_ENUM0);
      return r.status === 0 && r.stderr.indexOf("No value can satisfy") !== -1; })());
  ok("`z.union([])` passes the gate on anthropic and still reports it",
    (function () { var r = run(["--to", "anthropic", "--check"], ZOD_UNION0);
      return r.status === 0 && r.stderr.indexOf("No value can satisfy") !== -1; })());

  // Over-block guard at the CLI: an ordinary schema stays silent and clean.
  var ctl = run(["--to", "openai", "--check"], CONTROL);
  ok("an ordinary enum is untouched and unreported",
    ctl.status === 0 && ctl.stderr.indexOf("No value can satisfy") === -1);
})();

// A pattern-constrained dict key, end to end. This is the VERBATIM
// `model_json_schema()` output of pydantic 2.13.4 for
//   class Doc(BaseModel):
//       tags: Dict[Annotated[str, StringConstraints(pattern=r'^S_')], str]
// -- note there is no `additionalProperties` key anywhere in it, which is
// exactly why nothing in this engine used to see a map.
(function () {
  var PYD = JSON.stringify({
    type: "object", title: "Doc",
    properties: { tags: { patternProperties: { "^S_": { type: "string" } }, title: "Tags", type: "object" } },
    required: ["tags"], additionalProperties: false
  });

  var chk = run(["--to", "openai", "--check"], PYD);
  ok("a pydantic pattern-map is a blocker, not a silently emptied field",
    chk.status === 3);
  ok("...and the blocker names the consequence rather than just the keyword",
    /only legal value is `\{\}`/.test(chk.stderr));

  // The whole defect was that the OUTPUT was accepted while being dead, so the
  // output is the thing to assert on: the value schema must survive, and the
  // object must not come back closed.
  var out = run(["--to", "openai"], PYD);
  var tags = JSON.parse(out.stdout).properties.tags;
  ok("the value schema survives conversion instead of being deleted",
    JSON.stringify(tags.patternProperties) === JSON.stringify({ "^S_": { type: "string" } }));
  ok("the dead `{type: object, additionalProperties: false}` is never emitted",
    tags.additionalProperties === undefined);

  // Same file, a target that genuinely accepts it: the two must disagree, or
  // the blocker is just noise.
  ok("the same file passes cleanly on a target that carries the keyword",
    run(["--to", "anthropic", "--check"], PYD).status === 0);

  // Over-block guard at the CLI: an ordinary closed object must stay silent.
  ok("an ordinary closed object is not swept up by the new rule",
    run(["--to", "openai", "--check"], JSON.stringify({
      type: "object", properties: { a: { type: "string" } },
      required: ["a"], additionalProperties: false
    })).status === 0);
})();

// --- #352: a gate that passed a document it had just emptied ----------------
//
// The severities are the finding, so they are asserted through the binary
// rather than only in the engine. Before this, `--to gemini` answered exit 0
// ("Already valid for gemini. No changes needed.") on a file it handed back as
// `{}`, and exit 1 ("commit my output") on the rest — where the change on offer
// was the deletion of every constraint in the document.
(function () {
  var BAG = JSON.stringify({ definitions: { I: { type: "object" } } });
  var PATTERN = JSON.stringify({ patternProperties: { "^a": { type: "string" } } });

  var bag = run(["--to", "gemini", "--check"], BAG);
  ok("#352 a document emptied to `{}` no longer passes the gate",
    bag.status === 3, "exit " + bag.status);
  ok("#352 the blocker reaches the installed binary's output",
    (bag.stdout + bag.stderr).indexOf("constrains nothing") !== -1);
  ok("#352 the pointerless bag is told to restore its `$ref`",
    (bag.stdout + bag.stderr).indexOf("$ref` INTO the bag") !== -1);

  // The same file, two targets, opposite answers: the narrow proto has no field
  // for `patternProperties` so the document empties, while `responseJsonSchema`
  // takes it verbatim. That disagreement is the proof the remedy is real — it
  // points at a target that genuinely accepts the file.
  ok("#352 the narrow proto blocks what the JSON-Schema path carries",
    run(["--to", "gemini", "--check"], PATTERN).status === 3 &&
    run(["--to", "gemini-json", "--check"], PATTERN).status === 0);

  // Over-block guard through the binary: the rule keys on a whole-document
  // outcome, so an ordinary schema must be completely untouched by it.
  var fine = run(["--to", "gemini", "--check"], JSON.stringify({
    type: "object", properties: { a: { type: "string" } }, required: ["a"]
  }));
  ok("#352 an ordinary schema still passes gemini cleanly",
    fine.status === 0 && (fine.stdout + fine.stderr).indexOf("constrains nothing") === -1);
})();

// #353 — the verdict change end-to-end. `--check` was answering "Already valid
// for anthropic. No changes needed." (exit 0) for the DEFAULT output of both
// dominant generators, on a document `betaTool()` throws on.
(function () {
  // Verbatim `zodToJsonSchema(z.object({...}), "Ticket")` on zod-to-json-schema.
  var ZOD_V3 = JSON.stringify({
    $ref: "#/definitions/Ticket",
    definitions: {
      Ticket: {
        type: "object",
        properties: { title: { type: "string" }, n: { type: "number" } },
        required: ["title", "n"]
      }
    }
  });
  // Verbatim `RootModel[Union[A, B]].model_json_schema()` on pydantic 2.13.4.
  var PY_UNION = JSON.stringify({
    $defs: {
      A: { type: "object", properties: { kind: { const: "a" } }, required: ["kind"] },
      B: { type: "object", properties: { kind: { const: "b" } }, required: ["kind"] }
    },
    anyOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
    title: "P"
  });

  ok("#353 zod-to-json-schema's default output no longer passes anthropic silently",
    run(["--to", "anthropic", "--check"], ZOD_V3).status === 1);
  ok("#353 a pydantic union root no longer passes anthropic silently",
    run(["--to", "anthropic", "--check"], PY_UNION).status === 1);

  // The converted output must then be clean: a gate that says "commit my output"
  // and still fails on the second run is the #330 defect.
  var fixed = run(["--to", "anthropic"], ZOD_V3);
  ok("#353 the converted zod output rechecks clean",
    fixed.status === 0 &&
    run(["--to", "anthropic", "--check"], fixed.stdout).status === 0);
  ok("#353 the converted root carries `type: object`",
    JSON.parse(fixed.stdout).type === "object");

  // A union that cannot be repaired without narrowing is a blocker (exit 3), not
  // an edit — the one distinction a CI script acts on (#330).
  ok("#353 a union root with a non-object branch exits 3",
    run(["--to", "anthropic", "--check"], JSON.stringify({
      anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "string" }]
    })).status === 3);

  // Over-block guard through the binary.
  ok("#353 an ordinary object schema still passes anthropic untouched",
    run(["--to", "anthropic", "--check"], JSON.stringify({
      type: "object", properties: { a: { type: "string" } }, required: ["a"]
    })).status === 0);
})();

// --- #355: malformed containers through the binary ---------------------------
// Exit 3, not 1: committing our output cannot help, because we could not read
// the document in the first place (#330 -- a 1 is fixed by rerunning without
// --check, a 3 never is).
(function () {
  var BODY = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
  function withKw(kw, v) { var s = JSON.parse(JSON.stringify(BODY)); s[kw] = v; return s; }

  ok("#355 `$defs: true` exits 3 (was 0 — the #354 hole)",
    run(["--to", "anthropic-json-python", "--check"], JSON.stringify(withKw("$defs", true))).status === 3);
  ok("#355 `$defs: true` exits 3 on openai too",
    run(["--to", "openai", "--check"], JSON.stringify(withKw("$defs", true))).status === 3);
  ok("#355 `properties` holding a boolean exits 3",
    run(["--to", "anthropic-go", "--check"], JSON.stringify({ type: "object", properties: true })).status === 3);
  ok("#355 a non-schema `properties` MEMBER exits 3",
    run(["--to", "openai", "--check"], JSON.stringify({ type: "object", properties: { a: "string" } })).status === 3);

  // The diagnosis has to reach the binary's output, not just the ledger.
  (function () {
    var r = run(["--to", "openai", "--check"], JSON.stringify(withKw("$defs", true)));
    var text = (r.stdout || "") + (r.stderr || "");
    ok("#355 the message names the keyword and what it must hold",
      /`\$defs` must be an object mapping names to schemas/.test(text));
    ok("#355 the message says the subtree was skipped",
      /SKIPPED/.test(text));
    ok("#355 the message carries the measured Go total-loss consequence",
      /schema: null/.test(text) && /anthropic-sdk-go/.test(text));
  })();

  // Over-block guards through the binary: empty containers are legal and stay so.
  ok("#355 guard: `anyOf: []` still passes (#347)",
    run(["--to", "openai", "--check"], JSON.stringify({
      type: "object", properties: { p: { anyOf: [] } }, required: ["p"], additionalProperties: false
    })).status !== 3);
  ok("#355 guard: an ordinary schema still exits 0",
    run(["--to", "openai", "--check"], JSON.stringify(BODY)).status === 0);
})();

// --- #356 typed catchall reaches the CLI, and never fails the gate ---------
(function () {
  var CATCHALL = JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", properties: { a: { type: "string" } }, required: ["a"],
    additionalProperties: {
      type: "object", properties: { z: { type: "string", minLength: 3 } },
      required: ["z"], additionalProperties: false
    }
  });
  var PLAIN = JSON.stringify({
    type: "object", properties: { a: { type: "string" } }, required: ["a"],
    additionalProperties: false
  });
  var MARK = "declares `properties` AND an `additionalProperties`";

  var r = run(["--to", "anthropic-json", "--check"], CATCHALL);
  ok("#356 CLI surfaces the catchall loss on anthropic-json",
    (r.stdout + r.stderr).indexOf(MARK) !== -1);
  ok("#356 CLI: advisory only -- --check still exits 0", r.status === 0);
  ok("#356 CLI: anthropic-go surfaces it too",
    (function () { var g = run(["--to", "anthropic-go", "--check"], CATCHALL);
      return (g.stdout + g.stderr).indexOf(MARK) !== -1 && g.status === 0; })());
  ok("#356 CLI guard: the tools path stays quiet",
    (function () { var t = run(["--to", "anthropic", "--check"], CATCHALL);
      return (t.stdout + t.stderr).indexOf(MARK) === -1 && t.status === 0; })());
  ok("#356 CLI guard: an ordinary closed object stays quiet",
    (function () { var p = run(["--to", "anthropic-json", "--check"], PLAIN);
      return (p.stdout + p.stderr).indexOf(MARK) === -1 && p.status === 0; })());
})();

// ---------------------------------------------------------------------------
// #367 — the demote-to-prose condition must reach the installed binary, must
// differ per SDK, must NOT appear on Go or the tools path, and must never fail
// the gate (the request is accepted either way — #317).
// ---------------------------------------------------------------------------
(function () {
  var SCH = JSON.stringify({
    type: "object",
    properties: { code: { type: "string", pattern: "^[A-Z]{3}$", minLength: 3 } },
    required: ["code"]
  });
  var js = run(["--to", "anthropic-json", "--check"], SCH);
  var py = run(["--to", "anthropic-json-python", "--check"], SCH);
  var go = run(["--to", "anthropic-go", "--check"], SCH);
  var tools = run(["--to", "anthropic", "--check"], SCH);

  ok("#367 CLI: the JS target prints the call-site condition",
    /conditional on how you hand the schema over/.test(js.stderr), js.stderr);
  ok("#367 CLI: the JS target names the helper-only call sites",
    /four call sites and all four are HELPERS/.test(js.stderr), js.stderr);
  ok("#367 CLI: the python target names output_config and the deprecation",
    /output_config/.test(py.stderr) && /DeprecationWarning/.test(py.stderr), py.stderr);
  ok("#367 CLI: the two SDKs print DIFFERENT conditions",
    /is_dict\(output_format\)/.test(py.stderr) &&
    !/is_dict\(output_format\)/.test(js.stderr), py.stderr);
  // Discriminator: Go has no non-transforming form, so it must not be told the
  // demotion is conditional.
  ok("#367 CLI: Go is NOT told the demotion is conditional",
    !/conditional on how you hand the schema over/.test(go.stderr), go.stderr);
  ok("#367 CLI: the tools path is not told either",
    !/conditional on how you hand the schema over/.test(tools.stderr), tools.stderr);
  // Advisory only — the schema is legal on every one of these targets.
  ok("#367 CLI: the condition never fails the gate",
    js.status === 0 && py.status === 0 && go.status === 0 && tools.status === 0,
    "statuses: " + [js.status, py.status, go.status, tools.status].join(","));
})();


// --- #363: exit codes for shapes the walk MANUFACTURED --------------------
// A blocker is exit 3 and a fixable schema is exit 1, and the distinction is the
// whole point for a CI caller (#330): a 1 is resolved by committing our output, a
// 3 never is. These pairs are the same logical schema one `allOf` wrapper apart.
(function () {
  var WRAPPED = JSON.stringify({
    type: "object", properties: { c: { minLength: 3, allOf: [{ $ref: "#/$defs/S" }] } },
    required: ["c"], additionalProperties: false, $defs: { S: { type: "string" } }
  });
  var DIRECT = JSON.stringify({
    type: "object", properties: { c: { minLength: 3, $ref: "#/$defs/S" } },
    required: ["c"], additionalProperties: false, $defs: { S: { type: "string" } }
  });
  var SCALAR_ROOT = JSON.stringify({ allOf: [{ type: "string", minLength: 3 }] });
  var HOISTED_ROOT = JSON.stringify({
    allOf: [{ $ref: "#/$defs/S" }],
    $defs: { S: { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false } }
  });

  var w = run(["--to", "openai", "--check"], WRAPPED);
  ok("#363 CLI: a `$ref` hoisted next to a constraint is a BLOCKER (exit 3)", w.status === 3);
  ok("#363 CLI: ...and the remedy reaches the binary",
    /WITHOUT the `allOf` wrapper/.test(w.stdout + w.stderr));

  var d = run(["--to", "openai", "--check"], DIRECT);
  ok("#363 CLI: the at-entry twin is merely FIXABLE (exit 1), not a blocker", d.status === 1);

  var sr = run(["--to", "openai", "--check"], SCALAR_ROOT);
  ok("#363 CLI: a manufactured non-object root is a BLOCKER (exit 3)", sr.status === 3);
  ok("#363 CLI: ...and says the caller did not write that root",
    /did not write/.test(sr.stdout + sr.stderr));

  // The over-block that used to fire here: the vendor ACCEPTS this, so it must
  // not be a blocker.
  var hr = run(["--to", "openai", "--check"], HOISTED_ROOT);
  ok("#363 CLI: a bare `$ref` hoisted to the root is NOT a blocker", hr.status !== 3);
})();


// --- #366 the per-surface diagnosis reaches the installed binary -------------
(function () {
  var loose = run(["--to", "openai-nonstrict", "--check"], INSTRUCTOR_OPENAI);
  ok("#366 CLI: the AUTO surfaces reach the reader",
    /responses namespace tools/.test(loose.stderr), loose.stderr.slice(0, 300));
  ok("#366 CLI: ...with the vendor's own fallback wording",
    /falls back to non-strict validation otherwise/.test(loose.stderr));
  ok("#366 CLI: ...and the silent downgrade is named",
    /SILENT/.test(loose.stderr));
  // #317's property: the schema is legal on every one of these surfaces, so the
  // whole diagnosis must stay advisory.
  ok("#366 CLI: the new diagnosis never fails the gate",
    loose.status === 0, "status=" + loose.status);

  // The discriminator, end to end on the SAME file: Realtime has no `strict`
  // field, so it keeps the categorical claim and must NOT be told about a
  // negotiation that cannot happen there.
  var rt = run(["--to", "openai-realtime", "--check"], INSTRUCTOR_OPENAI);
  ok("#366 CLI: realtime is not told about the AUTO surfaces",
    !/NOT non-strict everywhere/.test(rt.stderr), rt.stderr.slice(0, 300));
  ok("#366 CLI: realtime still exits 0", rt.status === 0, "status=" + rt.status);
})();


// ---------------------------------------------------------------------------
// #367 — the demote-to-prose condition must reach the installed binary, must
// differ per SDK, must NOT appear on Go or the tools path, and must never fail
// the gate (the request is accepted either way — #317).
// ---------------------------------------------------------------------------
(function () {
  var SCH = JSON.stringify({
    type: "object",
    properties: { code: { type: "string", pattern: "^[A-Z]{3}$", minLength: 3 } },
    required: ["code"]
  });
  var js = run(["--to", "anthropic-json", "--check"], SCH);
  var py = run(["--to", "anthropic-json-python", "--check"], SCH);
  var go = run(["--to", "anthropic-go", "--check"], SCH);
  var tools = run(["--to", "anthropic", "--check"], SCH);

  ok("#367 CLI: the JS target prints the call-site condition",
    /conditional on how you hand the schema over/.test(js.stderr), js.stderr);
  ok("#367 CLI: the JS target names the helper-only call sites",
    /four call sites and all four are HELPERS/.test(js.stderr), js.stderr);
  ok("#367 CLI: the python target names output_config and the deprecation",
    /output_config/.test(py.stderr) && /DeprecationWarning/.test(py.stderr), py.stderr);
  ok("#367 CLI: the two SDKs print DIFFERENT conditions",
    /is_dict\(output_format\)/.test(py.stderr) &&
    !/is_dict\(output_format\)/.test(js.stderr), py.stderr);
  // Discriminator: Go has no non-transforming form, so it must not be told the
  // demotion is conditional.
  ok("#367 CLI: Go is NOT told the demotion is conditional",
    !/conditional on how you hand the schema over/.test(go.stderr), go.stderr);
  ok("#367 CLI: the tools path is not told either",
    !/conditional on how you hand the schema over/.test(tools.stderr), tools.stderr);
  // Advisory only — the schema is legal on every one of these targets.
  ok("#367 CLI: the condition never fails the gate",
    js.status === 0 && py.status === 0 && go.status === 0 && tools.status === 0,
    "statuses: " + [js.status, py.status, go.status, tools.status].join(","));
})();


// #368 — the fork must reach the binary, because the exit code does NOT move.
// This document is legal for three of the five measured clients and a hard 400
// for one, and we cannot know which the caller is on, so exit 0 is the honest
// answer and the NOTE is the entire deliverable for the langchain user.
(function () {
  var OPTIONAL = JSON.stringify({
    type: "object",
    properties: { p: { type: ["string", "null"] } },
    required: ["p"]
  });
  var gc = run(["--to", "gemini-client", "--check"], OPTIONAL);
  var gn = run(["--to", "gemini", "--check"], OPTIONAL);

  ok("#368 CLI: the fork reaches the binary on gemini-client",
    /@langchain\/google-genai/.test(gc.stderr) && /THE CHECK/.test(gc.stderr), gc.stderr);
  ok("#368 CLI: it gives the proto's own rejection reason",
    /Proto field is not repeating/.test(gc.stderr), gc.stderr);
  ok("#368 CLI: it points at the target that emits the other spelling",
    /--to gemini\b/.test(gc.stderr), gc.stderr);
  // Discriminator: `--to gemini` IS the escape hatch, so it must not print the
  // fork — otherwise the advice loops back on itself. Without this pair the
  // note could be firing blanket and every assertion above would still pass.
  ok("#368 CLI: `--to gemini` does NOT print the fork",
    !/THE CHECK/.test(gn.stderr), gn.stderr);
  // `--check` writes only the ledger, so compare the CONVERTED documents.
  var gcOut = run(["--to", "gemini-client"], OPTIONAL);
  var gnOut = run(["--to", "gemini"], OPTIONAL);
  ok("#368 CLI: the two targets emit genuinely different documents",
    /"nullable"/.test(gnOut.stdout) && !/"nullable"/.test(gcOut.stdout) &&
    /"null"/.test(gcOut.stdout),
    gcOut.stdout + " || " + gnOut.stdout);
  ok("#368 CLI: the fork never fails the gate",
    gc.status === 0, "status " + gc.status);
})();


// --- #374: the gate must ANSWER on an adversarial `$ref` fan-out ------------
// Pre-fix this exact invocation died with `FATAL ERROR: JavaScript heap out of
// memory` and exit 134 -- an exit code the CLI does not document, i.e. a CI gate
// that crashes rather than returning a verdict. Exit codes are the actual
// contract for a gate, so they are asserted here and not only in-process.
function fanout(depth) {
  var defs = { d0: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } };
  for (var i = 1; i <= depth; i++) {
    defs["d" + i] = { type: "object", required: ["x", "y"], properties: {
      x: { $ref: "#/$defs/d" + (i - 1) }, y: { $ref: "#/$defs/d" + (i - 1) } } };
  }
  return JSON.stringify({ type: "object", required: ["root"],
    properties: { root: { $ref: "#/$defs/d" + depth } }, $defs: defs });
}

(function () {
  var deep = fanout(14);
  var g = run(["--to", "gemini", "--check", "-"], deep);
  ok("#374 CLI: adversarial `$ref` fan-out exits 3, not 134", g.status === 3,
     "status=" + g.status);
  ok("#374 CLI: the blocker reaches the installed binary",
     (g.stderr + g.stdout).indexOf("exceeds 100,000 nodes") !== -1);

  // Same bytes, other target: the two genuinely disagree, which is what makes
  // the blocker's remedy real rather than a suggestion.
  var j = run(["--to", "gemini-json", "--check", "-"], deep);
  ok("#374 CLI: the same file passes on `--to gemini-json` (the named remedy)",
     j.status === 0, "status=" + j.status);
})();

(function () {
  // Over-block guard: the seven targets that never inline were always safe and
  // must stay untouched by the bound.
  var deep = fanout(14);
  ["openai", "anthropic", "anthropic-go"].forEach(function (t) {
    var r = run(["--to", t, "--check", "-"], deep);
    ok("#374 CLI: `--to " + t + "` is unaffected by the expansion bound",
       r.status !== 3 && (r.stderr + r.stdout).indexOf("exceeds 100,000 nodes") === -1,
       "status=" + r.status);
  });
})();

/* #379 — the CLI contract: an unescaped `/` in a definition name must not
   change the exit code. Real `zod-to-json-schema@3.24.5` output; the two
   documents describe the same schema. */
(function () {
  function zodOut(name) {
    return JSON.stringify({
      "$ref": "#/definitions/" + name,
      "definitions": {
        [name]: { "type": "object",
          "properties": {
            "inner": { "type": "object", "properties": { "one": { "type": "string", "minLength": 3 } },
                       "required": ["one"], "additionalProperties": false },
            "echo": { "$ref": "#/definitions/" + name + "/properties/inner/properties/one" } },
          "required": ["inner", "echo"], "additionalProperties": false } },
      "$schema": "http://json-schema.org/draft-07/schema#"
    });
  }
  ["openai", "gemini", "anthropic-json"].forEach(function (t) {
    var a = run(["--to", t, "--check", "-"], zodOut("S"));
    var b = run(["--to", t, "--check", "-"], zodOut("v1/User"));
    ok("#379 CLI: `--to " + t + "` gives the same exit code whatever the definition is named",
       a.status === b.status, "plain=" + a.status + " slash=" + b.status);
  });
  // The definition must still be in the output the user is told to commit, and
  // the pointer to it must still resolve — before the fix the bag was deleted
  // and the dangling result re-checked as 0.
  var fixed = run(["--to", "anthropic-json", "-"], zodOut("v1/User"));
  var doc = {};
  try { doc = JSON.parse(fixed.stdout); } catch (e) {}
  ok("#379 CLI: the slash-named definition reaches the emitted document",
     !!(doc && doc.$defs && doc.$defs["v1/User"]));
  var recheck = run(["--to", "anthropic-json", "--check", "-"], fixed.stdout || "{}");
  ok("#379 CLI: our own output re-checks clean and is not a dangling document",
     recheck.status === 0);
  // `__proto__` is not a definition: the CLI must not claim to have inlined it.
  var proto = run(["--to", "openai", "--check", "-"],
    JSON.stringify({ "$ref": "#/$defs/__proto__", "$defs": { T: { type: "object" } } }));
  ok("#379 CLI: a `$ref` at an inherited name is not reported as inlined",
     (proto.stdout + proto.stderr).indexOf("Inlined the root `$ref`") === -1);
})();


// #380 — the exit-code contract. A property named `toString` used to make the
// gate invent a collision and exit 3 ("needs a human fix") on a schema the
// vendor merges and ACCEPTS; and the narrow Gemini strip leaked such a key onto
// a proto that rejects unknown fields, at exit 1 ("commit my output").
(function () {
  var fs = require("fs"), os = require("os"), pth = require("path");
  var tmp = fs.mkdtempSync(pth.join(os.tmpdir(), "cli380-"));
  function w(name, obj) { var f = pth.join(tmp, name); fs.writeFileSync(f, JSON.stringify(obj)); return f; }
  var allOfCase = function (p) {
    var mp = {}; mp[p] = { type: "integer" };
    return { type: "object", additionalProperties: false, required: ["outer"], properties: { outer: {
      type: "object", required: ["own"], properties: { own: { type: "string" } },
      allOf: [{ type: "object", required: [p], properties: mp }] } } };
  };
  // THE DISCRIMINATOR: identical schemas, only the property NAME differs.
  var plain = run(["--to", "openai", "--check", w("p.json", allOfCase("zzz"))]);
  var proto = run(["--to", "openai", "--check", w("q.json", allOfCase("toString"))]);
  ok("#380 CLI: an ordinary property name exits 1 (mergeable)", plain.status === 1);
  ok("#380 CLI: a property named `toString` exits 1 too, not a false blocker", proto.status === 1);
  ok("#380 CLI: no invented clash is reported",
     (proto.stdout + proto.stderr).indexOf("both declare a property") === -1);
  // A GENUINE duplicate must still block -- guards against "never clash".
  var dup = { type: "object", additionalProperties: false, required: ["outer"], properties: { outer: {
    type: "object", required: ["dup"], properties: { dup: { type: "string" } },
    allOf: [{ type: "object", required: ["dup"], properties: { dup: { type: "integer" } } }] } } };
  ok("#380 CLI: a genuine clash still exits 3",
     run(["--to", "openai", "--check", w("d.json", dup)]).status === 3);
  // Gemini narrow proto: the leaked key is a measured hard 400.
  var unk = { type: "object", additionalProperties: false, required: ["a"],
              properties: { a: { type: "string" } }, toString: { bogus: true } };
  var gem = run(["--to", "gemini", w("g.json", unk)]);
  ok("#380 CLI: unknown keyword `toString` is stripped from the gemini payload",
     gem.stdout.indexOf("toString") === -1);
})();

// ---------------------------------------------------------------------------
// #382 -- the CLI half of the same rule.
//
// The CLI validates `--to` against an ARRAY (`PROVIDERS.indexOf`), which has no
// prototype hole, so it was already correct while the engine's object lookup
// was not: two implementations of one rule disagreeing about one input (#372).
// The engine is now the one that must not drift, but pinning the CLI matters
// too -- if someone "simplifies" it into a lookup on the same registry object,
// this is the test that fails.
(function () {
  var SIMPLE = JSON.stringify({
    type: "object", properties: { a: { type: "string" } },
    required: ["a"], additionalProperties: false
  });
  ["toString", "constructor", "__proto__", "valueOf", "frobnicate"].forEach(function (name) {
    var r = run(["--to", name, "--check", "-"], SIMPLE);
    ok("#382 CLI: --to " + name + " is rejected cleanly (exit 2, no stack trace)",
       r.status === 2 &&
       r.stderr.indexOf("Unknown provider") !== -1 &&
       r.stderr.indexOf("TypeError") === -1,
       "status=" + r.status + " stderr=" + String(r.stderr).slice(0, 120));
  });

  // Over-block guard for the CLI too: a real provider must still pass.
  var good = run(["--to", "openai", "--check", "-"], SIMPLE);
  ok("#382 CLI: a real provider is unaffected", good.status === 0,
     "status=" + good.status);
})();

// --- #384 outlines target, end to end through the CLI ----------------------
(function () {
  var ALT = JSON.stringify({
    type: "object",
    properties: {
      verb: { type: "string", pattern: "^GET|POST$" },
      n: { type: "integer", minimum: 10, maximum: 100 }
    },
    required: ["verb", "n"], additionalProperties: false
  });

  var r = run(["--to", "outlines", "--check", "-"], ALT);
  ok("#384 CLI: the alternation repair reaches the installed entry point",
     r.status === 1 && r.stderr.indexOf("ONLY MALFORMED JSON") !== -1,
     "status=" + r.status);

  var out = run(["--to", "outlines", "-"], ALT);
  ok("#384 CLI: the emitted pattern is the non-capturing form",
     out.status === 0 && out.stdout.indexOf("(?:GET|POST)") !== -1);

  // THE PAIR THAT MATTERS: the same file, two targets, opposite verdicts. Eight
  // vendors accept this document; on outlines it compiles to a guide that emits
  // only malformed JSON. If these ever agree, one of the two targets is wrong.
  var oai = run(["--to", "openai", "--check", "-"], ALT);
  ok("#384 CLI: openai and outlines genuinely disagree about the same file",
     oai.status === 0 && r.status === 1,
     "openai=" + oai.status + " outlines=" + r.status);

  // An advisory must never fail the gate (#317's property), even though the
  // constraint it names is silently unenforced.
  var BOUNDS = JSON.stringify({
    type: "object", properties: { n: { type: "integer", minimum: 10 } },
    required: ["n"], additionalProperties: false
  });
  var b = run(["--to", "outlines", "--check", "-"], BOUNDS);
  ok("#384 CLI: an unenforced-keyword note does not fail the gate",
     b.status === 0 && b.stderr.indexOf("does NOT enforce") !== -1,
     "status=" + b.status);

  // Idempotence: re-checking our own output must be clean.
  var again = run(["--to", "outlines", "--check", "-"], out.stdout);
  ok("#384 CLI: converted output rechecks clean", again.status === 0,
     "status=" + again.status);

  ok("#384 CLI: outlines is listed as a provider in --help",
     run(["--help"], "").stdout.indexOf("outlines") !== -1);
})();

// ---- #385 xgrammar: the second consumer target, end to end ----------------
(function () {
  // VERBATIM zod 4.4.3 `z.record(z.string(), z.object({n: z.number()}))`.
  var ZOD_RECORD = JSON.stringify({
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    type: "object", propertyNames: { type: "string" },
    additionalProperties: {
      type: "object", properties: { n: { type: "number" } },
      required: ["n"], additionalProperties: false
    }
  });

  var r = run(["--to", "xgrammar", "-"], ZOD_RECORD);
  ok("#385 CLI: the zod record converts", r.status === 0 || r.status === 1,
     "status=" + r.status);
  var outSchema = {};
  try { outSchema = JSON.parse(r.stdout); } catch (e) { outSchema = {}; }
  ok("#385 CLI: propertyNames is gone from the emitted document",
     !Object.prototype.hasOwnProperty.call(outSchema, "propertyNames"));
  ok("#385 CLI: and the nested value model survives",
     !!(outSchema.additionalProperties &&
        outSchema.additionalProperties.properties &&
        outSchema.additionalProperties.properties.n));
  ok("#385 CLI: the reason reaches the installed surface",
     r.stderr.indexOf("asserted nothing") !== -1);

  // The two consumer targets must genuinely disagree about one document —
  // otherwise the second target buys nothing.
  var BOUNDED = JSON.stringify({
    type: "object", properties: { n: { type: "integer", minimum: 10 } },
    required: ["n"], additionalProperties: false
  });
  var o = run(["--to", "outlines", "--check", "-"], BOUNDED);
  var x = run(["--to", "xgrammar", "--check", "-"], BOUNDED);
  ok("#385 CLI: outlines reports `minimum` unenforced and xgrammar does not",
     o.stderr.indexOf("does NOT enforce") !== -1 &&
     x.stderr.indexOf("does NOT enforce") === -1);

  // Advisories must never fail the gate (#317).
  ok("#385 CLI: the whole-string advisory does not fail the gate",
     run(["--to", "xgrammar", "--check", "-"],
         JSON.stringify({ type: "object",
           properties: { a: { type: "string", pattern: "^S_" } },
           required: ["a"], additionalProperties: false })).status === 0);

  // Idempotence.
  ok("#385 CLI: converted output rechecks clean",
     run(["--to", "xgrammar", "--check", "-"], r.stdout).status === 0);

  ok("#385 CLI: xgrammar is listed as a provider in --help",
     run(["--help"], "").stdout.indexOf("xgrammar") !== -1);
})();

// --- Cycle #386: lm-format-enforcer target reachable from the CLI -----------
(function () {
  var PYD = JSON.stringify({
    "$defs": {
      "Cat": { "properties": { "kind": { "const": "cat", "type": "string" },
                               "meow": { "type": "integer" } },
               "required": ["kind", "meow"], "type": "object" },
      "Dog": { "properties": { "kind": { "const": "dog", "type": "string" },
                               "bark": { "type": "integer" } },
               "required": ["kind", "bark"], "type": "object" }
    },
    "properties": { "pet": { "oneOf": [{ "$ref": "#/$defs/Cat" }, { "$ref": "#/$defs/Dog" }] } },
    "required": ["pet"], "type": "object"
  });

  var r = run(["--to", "lmformatenforcer"], PYD);
  ok("cli: `--to lmformatenforcer` is a valid target", r.status === 0 || r.status === 1);
  ok("cli: it rewrites the union to `anyOf`",
    r.stdout.indexOf('"anyOf"') !== -1 && r.stdout.indexOf('"oneOf"') === -1);
  ok("cli: it explains what goes wrong without the rewrite",
    r.stderr.indexOf("without dispatching per member") !== -1);

  // The three decoder targets must genuinely disagree about the same file.
  var x = run(["--to", "xgrammar"], PYD);
  ok("cli: xgrammar leaves the same union alone",
    x.stdout.indexOf('"oneOf"') !== -1);

  // A non-exclusive union is a blocker: exit 3, not a silent widening.
  var blocked = run(["--check", "--to", "lmformatenforcer"],
    JSON.stringify({ oneOf: [{ type: "integer" }, { type: "integer", minimum: 5 }] }));
  ok("cli: a non-exclusive `oneOf` exits 3 (blocker)", blocked.status === 3);

  // An advisory alone must never fail the gate (#317).
  var adv = run(["--check", "--to", "lmformatenforcer"],
    JSON.stringify({ type: "integer", minimum: 10 }));
  ok("cli: an unenforced-keyword advisory alone exits 0", adv.status === 0);

  // Idempotence: rechecking our own output is clean.
  var out = run(["--to", "lmformatenforcer"], PYD).stdout;
  ok("cli: converted output rechecks clean",
    run(["--check", "--to", "lmformatenforcer"], out).status === 0);

  ok("cli: the target is listed in --help beside its condition",
    run(["--help"], "").stdout.indexOf("lmformatenforcer") !== -1);
})();


// ---- #387: the union `type` spelling, end to end through the CLI ----------
(function () {
  var UNION = JSON.stringify({ type: "object", additionalProperties: false,
    required: ["a"], properties: { a: { type: ["object", "null"],
      properties: { n: { type: "integer" } }, required: ["n"] } } });

  var o = run(["--check", "--to", "outlines"], UNION);
  var x = run(["--check", "--to", "xgrammar"], UNION);
  var l = run(["--check", "--to", "lmformatenforcer"], UNION);
  ok("cli #387: `--to outlines` flags the union `type`", o.status === 1);
  ok("cli #387: `--to lmformatenforcer` flags it too", l.status === 1);
  // THE DISCRIMINATOR: the third decoder handles the spelling correctly, so it
  // must stay silent. Without this the rule could be firing blanket.
  ok("cli #387: `--to xgrammar` stays SILENT on the same file", x.status === 0);

  var oOut = run(["--to", "outlines"], UNION).stdout;
  var xOut = run(["--to", "xgrammar"], UNION).stdout;
  ok("cli #387: the two targets emit genuinely different documents",
    oOut !== xOut);
  ok("cli #387: the repaired output carries a null branch",
    oOut.indexOf('"null"') !== -1 && oOut.indexOf('"anyOf"') !== -1);
  ok("cli #387: the repaired output keeps the value type",
    oOut.indexOf('"integer"') !== -1);
  ok("cli #387: converted output rechecks clean (idempotent)",
    run(["--check", "--to", "outlines"], oOut).status === 0);

  // The explanation must reach the user, and must say the third decoder needs
  // no such rewrite — otherwise a reader generalises it to "decoders".
  var msg = run(["--check", "--to", "outlines"], UNION).stderr +
            run(["--check", "--to", "outlines"], UNION).stdout;
  ok("cli #387: the diagnosis names the dropped member",
    msg.indexOf("DROPS every non-") !== -1);
  ok("cli #387: the diagnosis says xgrammar needs no rewrite",
    msg.indexOf("xgrammar") !== -1);

  // A bare union is correct on both engines and must not be touched.
  var BARE = JSON.stringify({ type: "object", additionalProperties: false,
    required: ["a"], properties: { a: { type: ["string", "null"] } } });
  ok("cli #387: a BARE union exits 0 on outlines", 
    run(["--check", "--to", "outlines"], BARE).status === 0);
})();



// --- #388: a constraining `$ref` sibling is silently unenforced by every
//     constrained decoder, so the gate must stop passing it -----------------
(function () {
  var REF_SIB = JSON.stringify({
    $defs: { S: { type: "string" } },
    type: "object", additionalProperties: false, required: ["s"],
    properties: { s: { $ref: "#/$defs/S", minLength: 3 } }
  });
  // Annotation-only: nothing is lost on a decoder, so the gate must stay quiet.
  var ANNOT = JSON.stringify({
    $defs: { S: { type: "string" } },
    type: "object", additionalProperties: false, required: ["s"],
    properties: { s: { $ref: "#/$defs/S", description: "d" } }
  });

  ["outlines", "xgrammar", "lmformatenforcer"].forEach(function (p) {
    var r = run(["--check", "--to", p], REF_SIB);
    ok("cli #388: " + p + " no longer passes a constraining `$ref` sibling",
      r.status === 1);
    ok("cli #388: " + p + " leaves an annotation-only `$ref` sibling at exit 0",
      run(["--check", "--to", p], ANNOT).status === 0);
    // The emitted document must be the form the engine actually enforces.
    var out = JSON.parse(run(["--to", p], REF_SIB).stdout);
    ok("cli #388: " + p + " emits the merged form (`type` kept, `$ref` gone)",
      out.properties.s.type === "string" &&
      out.properties.s.minLength === 3 &&
      out.properties.s.$ref === undefined);
  });

  var msg = run(["--check", "--to", "xgrammar"], REF_SIB).stderr || "";
  ok("cli #388: the diagnosis names the measured behaviour",
    msg.indexOf("IGNORES the sibling") !== -1);
})();


// --- #389: RFC 6901 through the CLI -----------------------------------------
(function () {
  var SLASH = JSON.stringify({
    type: "object", properties: { b: { $ref: "#/$defs/v1~1U" } }, required: ["b"],
    additionalProperties: false, $defs: { "v1/U": { type: "string", minLength: 3 } }
  });
  var TILDE = JSON.stringify({
    type: "object", properties: { b: { $ref: "#/$defs/a~0b" } }, required: ["b"],
    additionalProperties: false, $defs: { "a~b": { type: "string", minLength: 3 } }
  });
  var PROP = JSON.stringify({
    type: "object", properties: { b: { $ref: "#/$defs/T/properties/a~1x" } },
    required: ["b"], additionalProperties: false,
    $defs: { T: { type: "object", properties: { "a/x": { type: "string" } },
                  required: ["a/x"], additionalProperties: false } }
  });

  ["xgrammar", "outlines", "lmformatenforcer"].forEach(function (p) {
    // Was exit 0 before #389 -- a false pass on a document all three engines
    // refuse to compile.
    ok("cli #389: " + p + " --check FAILS on a `/` definition name",
      run(["--check", "--to", p], SLASH).status === 1);
    // A silent edit would exit 0 here while still rewriting the pointer.
    ok("cli #389: " + p + " --check FAILS on the spec-correct `~0` spelling",
      run(["--check", "--to", p], TILDE).status === 1);
    ok("cli #389: " + p + " blocks a `/` in a PROPERTY name",
      run(["--check", "--to", p], PROP).status === 3);

    var out = JSON.parse(run(["--to", p], SLASH).stdout);
    ok("cli #389: " + p + " emits a grammar-safe definition name",
      Object.keys(out.$defs)[0] === "v1_U" &&
      out.properties.b.$ref === "#/$defs/v1_U");
    ok("cli #389: " + p + " converted output rechecks clean",
      run(["--check", "--to", p], JSON.stringify(out)).status === 0);
  });

  // The two families genuinely disagree about the same file.
  ok("cli #389: openai accepts the `/` name unchanged (escaping is correct there)",
    run(["--check", "--to", "openai"], SLASH).status === 0);
  ok("cli #389: openai does not block the `/` PROPERTY name",
    run(["--check", "--to", "openai"], PROP).status === 0);

  var m = run(["--check", "--to", "xgrammar"], SLASH).stderr || "";
  ok("cli #389: the diagnosis names the measured mechanism",
    m.indexOf("no RFC 6901 unescaping") !== -1);
})();


// --- #392: the root ref-sibling merge must not manufacture a dangling pointer
// The exit code is the whole interface a CI gate has. Before the fix the three
// decoder targets exited 3 on this document -- a BLOCKER naming a dangling
// reference we had just created ourselves, telling the reader to restore a
// definition that was in their file all along -- while the RAW input compiles
// on xgrammar 0.2.5, outlines-core 0.2.14 and lm-format-enforcer 0.11.3 and our
// output compiled on none of them.
(function () {
  var doc = JSON.stringify({
    "$ref": "#/$defs/T",
    properties: { a: { "$ref": "#/$defs/U" } },
    required: ["a"],
    $defs: {
      T: { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
      U: { type: "string", minLength: 3 }
    }
  });
  ["outlines", "xgrammar", "lmformatenforcer"].forEach(function (p) {
    var r = run(["--to", p, "--check", "-"], doc);
    ok("#392 cli " + p + ": no longer a blocker (was exit 3)", r.status === 1,
      "exit=" + r.status);
    var out = run(["--to", p, "-"], doc);
    var s;
    try { s = JSON.parse(out.stdout); } catch (e) { s = null; }
    ok("#392 cli " + p + ": the emitted document still carries its bag",
      !!(s && s.$defs && s.$defs.U && s.properties && s.properties.a &&
         s.properties.a.$ref === "#/$defs/U"));
    // Idempotent: re-checking our own output must be clean, which is the
    // contract exit 1 promises ("commit this and it will pass").
    var again = run(["--to", p, "--check", "-"], out.stdout);
    ok("#392 cli " + p + ": converted output re-checks clean", again.status === 0,
      "exit=" + again.status);
  });
})();

// #393 -- the two halves of the CLI must agree about one file. Before the fix,
// `--check` printed "Already valid ... No changes needed." and exited 0 while
// `--to` on the SAME file emitted a structurally different document, because the
// `allOf: [{ $ref }]` lift reported nothing and (for a recursive member) nothing
// downstream fired either.
(function () {
  var DOC = JSON.stringify({
    type: "object", properties: { a: { type: "string" } },
    required: ["a"], allOf: [{ $ref: "#" }]
  });
  ["outlines", "xgrammar", "lmformatenforcer"].forEach(function (p) {
    var chk = run(["--to", p, "--check", "-"], DOC);
    var out = run(["--to", p, "-"], DOC);
    var changed = JSON.stringify(JSON.parse(out.stdout)) !== JSON.stringify(JSON.parse(DOC));

    ok("#393 cli " + p + ": --to really does rewrite this document", changed);
    // The defect: these two must not contradict each other.
    ok("#393 cli " + p + ": --check reports the rewrite instead of exiting 0",
      chk.status === 1, "exit=" + chk.status);
    ok("#393 cli " + p + ": --check does not claim \"No changes needed\"",
      chk.stderr.indexOf("No changes needed") === -1);
    ok("#393 cli " + p + ": the rewrite is named in the reader's own vocabulary",
      chk.stderr.indexOf("allOf") !== -1 && chk.stderr.indexOf("$ref") !== -1);
    // Idempotent: converting our own output introduces nothing further.
    var again = run(["--to", p, "--check", "-"], out.stdout);
    ok("#393 cli " + p + ": converted output re-checks clean", again.status === 0,
      "exit=" + again.status);
  });

  // Over-block guard: pydantic v1's annotations-only wrapper is left alone, so
  // the gate must stay quiet about it rather than reporting a rewrite.
  var V1 = JSON.stringify({
    type: "object", required: ["inner"],
    properties: { inner: { title: "Inner", description: "d", allOf: [{ $ref: "#/definitions/Inner" }] } },
    definitions: { Inner: { type: "object", properties: { b: { type: "string" } }, required: ["b"] } }
  });
  ok("#393 cli xgrammar: annotations-only `allOf` draws no lift line",
    run(["--to", "xgrammar", "--check", "-"], V1).stderr.indexOf("Rewrote `allOf") === -1);
})();


// --- #394: `--check` no longer claims "No changes needed" about a file we edit
//
// The defect end-to-end: `--check --to openai` printed "Already valid for
// openai. No changes needed." and exited 0, while `--to openai` on the SAME
// FILE emitted a document with the whole `$defs.Unused` definition deleted.
// The two halves of the CLI contradicted each other about one file (#393's
// shape, one rule over). Asserted at the CLI surface because the false sentence
// IS the CLI's output -- the engine-level entry alone would not have caught it.
(function () {
  var ORPHAN = JSON.stringify({
    type: "object", additionalProperties: false, required: ["a"],
    properties: { a: { type: "string" } },
    $defs: { Unused: { type: "object", properties: { z: { type: "integer" } } } }
  });

  ["openai", "anthropic-json", "anthropic-go"].forEach(function (t) {
    var c = run(["--to", t, "--check"], ORPHAN);
    var err = String(c.stderr || "");
    ok("#394 cli " + t + ": stops claiming \"No changes needed\" about a file it rewrites",
      err.indexOf("No changes needed") === -1, err.slice(0, 160));
    ok("#394 cli " + t + ": names the definition it removed",
      err.indexOf("unreferenced definition") !== -1 && err.indexOf("`Unused`") !== -1,
      err.slice(0, 160));
    // The advisory must be labelled "optional", never "needs a human fix" --
    // #317's rule: a passing build must not send people hunting for nothing.
    ok("#394 cli " + t + ": the line is labelled optional",
      err.indexOf("[optional]") !== -1, err.slice(0, 160));
    // And it must NOT newly fail a gate that legitimately passed.
    ok("#394 cli " + t + ": --check still exits 0 (the schema was always compliant)",
      c.status === 0, "status=" + c.status);
  });

  // THE DISCRIMINATOR (#365): a decoder target skips the pruner, so it keeps
  // the definition AND still says "No changes needed" -- the same file, two
  // targets, genuinely different answers. Without this the rule could be
  // firing everywhere and every assertion above would still pass.
  var d = run(["--to", "outlines", "--check"], ORPHAN);
  ok("#394 cli outlines: still reports no changes, because it never prunes",
    String(d.stderr || "").indexOf("No changes needed") !== -1 && d.status === 0);
  var kept = run(["--to", "outlines"], ORPHAN);
  ok("#394 cli outlines: and the definition survives conversion",
    String(kept.stdout || "").indexOf("Unused") !== -1);

  // An ordinary schema is untouched and silent.
  var plain = run(["--to", "openai", "--check"],
    JSON.stringify({ type: "object", additionalProperties: false, required: ["a"],
                     properties: { a: { type: "string" } } }));
  ok("#394 cli a schema with no `$defs` still reports no changes",
    String(plain.stderr || "").indexOf("No changes needed") !== -1 && plain.status === 0);
})();

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
