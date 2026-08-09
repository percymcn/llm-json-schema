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

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
