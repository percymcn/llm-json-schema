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

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
