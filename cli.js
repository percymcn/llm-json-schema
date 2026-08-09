#!/usr/bin/env node
/*
 * llm-json-schema CLI — make a JSON Schema valid for OpenAI / Anthropic / Gemini.
 *
 * Dependency-free. Wraps the same engine the web tool uses, so the rules and the
 * doc citations are identical in a terminal, in CI, and in the browser.
 *
 *   llm-schema --to openai schema.json          # print the fixed schema
 *   cat schema.json | llm-schema --to gemini    # stdin works too
 *   llm-schema --to openai --check schema.json  # CI gate: exit 1 if not compliant
 *
 * Exit codes: 0 = ok/compliant · 1 = --check found changes · 2 = usage or bad JSON
 *             3 = converted, but a blocker needs a human fix
 */

"use strict";

var fs = require("fs");
var E = require("./engine.js");

var PROVIDERS = ["openai", "openai-nonstrict", "anthropic", "anthropic-json",
  "anthropic-json-python", "gemini", "gemini-json", "openai-realtime"];

var USAGE = [
  "llm-schema — make a JSON Schema valid for OpenAI / Anthropic / Gemini",
  "",
  "Usage:",
  "  llm-schema --to <provider> [file] [options]",
  "",
  "Providers — several vendors accept more than one dialect, and which one you are",
  "on is decided by the request you send, not by your schema, so pick by condition:",
  "",
  "  openai             Structured Outputs, strict: true      (subset of JSON Schema)",
  "  openai-nonstrict   strict absent or false                (full JSON Schema, unenforced)",
  "  openai-realtime    Realtime function tools               (no strict field exists)",
  "  anthropic          tools[].input_schema                  (sent verbatim)",
  "  anthropic-json     json_schema output, TypeScript SDK    (rebuilt, unknowns -> prose)",
  "  anthropic-json-python  json_schema output, Python SDK    (same, but keeps enum + $defs)",
  "  gemini             responseSchema                        (narrow Schema proto)",
  "  gemini-json        responseJsonSchema                    (full JSON Schema)",
  "",
  "If you never set `strict`, you are on openai-nonstrict — it is optional and off by",
  "default, and some clients omit it for you (Instructor does, on every OpenAI path).",
  "",
  "The two anthropic-json targets are split by SDK LANGUAGE, not by version: Python",
  "`anthropic` and `@anthropic-ai/sdk` ship the same version string (0.116.0) and",
  "disagree on two things — Python keeps `enum` (JS demotes it to description prose)",
  "and Python keeps `$defs` past a root `$ref` (JS drops it, losing the whole schema).",
  "",
  "Options:",
  "  --to <provider>   Target provider (required)",
  "  --check           Don't emit a schema; exit 1 if it isn't already compliant",
  "  --json            Emit {ok, schema, ledger, inferred} as JSON on stdout",
  "  --mode <m>        schema | example | auto   (default: auto)",
  "  --quiet           Suppress the explanation ledger on stderr",
  "  -h, --help        Show this help",
  "",
  "Reads stdin when no file is given. The fixed schema goes to stdout; the",
  "ledger explaining every change goes to stderr, so redirection stays clean:",
  "",
  "  llm-schema --to openai schema.json > fixed.json",
  ""
].join("\n");

function fail(msg, code) {
  process.stderr.write("llm-schema: " + msg + "\n");
  process.exit(code === undefined ? 2 : code);
}

function parseArgs(argv) {
  var opts = { provider: null, file: null, check: false, json: false, mode: "auto", quiet: false, help: false };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--check") opts.check = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--to") opts.provider = argv[++i];
    else if (a.indexOf("--to=") === 0) opts.provider = a.slice(5);
    else if (a === "--mode") opts.mode = argv[++i];
    else if (a.indexOf("--mode=") === 0) opts.mode = a.slice(7);
    else if (a.charAt(0) === "-" && a !== "-") return { error: "Unknown option: " + a };
    else if (opts.file === null) opts.file = a;
    else return { error: "Unexpected extra argument: " + a };
  }
  return opts;
}

function readInput(file, cb) {
  if (file && file !== "-") {
    fs.readFile(file, "utf8", function (err, data) {
      if (err) return fail("Cannot read " + file + ": " + err.message);
      cb(data);
    });
    return;
  }
  if (process.stdin.isTTY) return fail("No input. Pass a file or pipe JSON on stdin.\n\n" + USAGE);
  var chunks = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", function (d) { chunks += d; });
  process.stdin.on("end", function () { cb(chunks); });
}

// Human-readable ledger. Ops come from the engine: ! blocker, x removed,
// + added, ~ changed, = already fine.
var LABEL = { "!": "needs a human fix", "x": "removed", "+": "added", "~": "changed", "=": "ok" };

function renderLedger(ledger) {
  return ledger.map(function (l) {
    // An advisory never fails the gate, so it must not be labelled like something
    // that does — "needs a human fix" on a passing build sends people hunting.
    var label = l.advisory ? "optional" : LABEL[l.op];
    return "  " + l.op + " " + l.path + " — " + l.msg + " [" + label + "]";
  }).join("\n");
}

// Which OTHER targets already accept this schema unchanged?
//
// Picking the wrong target is the entire failure mode of a multi-dialect tool:
// every vendor here has two or more dialects, and which one you are on is decided
// by the request your CLIENT builds, not by anything visible in the schema. A
// pydantic-ai user, measured, lands on `openai-nonstrict` + `anthropic` +
// `gemini-json` — three non-default targets — and never sees the request fields
// those names refer to. Without this, `--check --to openai` answers such a user
// with a red build and four edits for a schema their stack sends untouched.
//
// This is computed from the schema on every run rather than documented, because a
// table of "framework X -> target Y" is a claim that rots with each release, and
// stale doc claims have shipped as bugs in this repo twice (#312, #318).
function alsoValidFor(raw, provider, mode) {
  var ok = [];
  for (var i = 0; i < PROVIDERS.length; i++) {
    var p = PROVIDERS[i];
    if (p === provider) continue;
    var r;
    try { r = E.convert(raw, p, { mode: mode }); } catch (e) { continue; }
    if (!r || !r.ok) continue;
    var needed = r.ledger.filter(function (l) { return l.op !== "=" && !l.advisory; });
    if (needed.length === 0) ok.push(p);
  }
  return ok;
}

function main(argv) {
  var opts = parseArgs(argv);
  if (opts.error) return fail(opts.error);
  if (opts.help) { process.stdout.write(USAGE); return 0; }
  if (!opts.provider) return fail("Missing --to <provider>. Expected one of: " + PROVIDERS.join(", ") + "\n\n" + USAGE);
  if (PROVIDERS.indexOf(opts.provider) === -1) return fail("Unknown provider '" + opts.provider + "'. Expected one of: " + PROVIDERS.join(", "));
  if (["auto", "schema", "example"].indexOf(opts.mode) === -1) return fail("Unknown --mode '" + opts.mode + "'. Expected auto, schema, or example.");

  readInput(opts.file, function (raw) {
    var res = E.convert(raw, opts.provider, { mode: opts.mode === "auto" ? undefined : opts.mode });
    if (!res.ok) return fail(res.error);

    var changes = res.ledger.filter(function (l) { return l.op !== "="; });
    // An advisory entry must never fail the gate, whatever its op. A `!` that is
    // also `advisory` is a contradiction, and letting one through is how a note
    // ("this isn't grammar-enforced") turns into a red CI build on a valid schema.
    var blockers = res.ledger.filter(function (l) { return l.op === "!" && !l.advisory; });
    // Advisory "=" entries record something the caller needs to KNOW but that
    // requires no edit — e.g. a keyword Gemini's `responseJsonSchema` path
    // silently ignores rather than rejects. They are not `changes`, so without
    // this they would be swallowed by the "No changes needed" branch and the
    // user would never learn their constraint is unenforced.
    var notes = res.ledger.filter(function (l) { return l.op === "=" && l.advisory; });
    // Advisory entries are optional improvements — the schema is already
    // accepted without them, so they must never turn a CI gate red.
    var required = changes.filter(function (l) { return !l.advisory; });

    // Only worth computing when the answer is "no" — a passing gate has no
    // wrong-target problem to diagnose.
    var alsoOk = required.length
      ? alsoValidFor(raw, opts.provider, opts.mode === "auto" ? undefined : opts.mode)
      : [];

    if (opts.json) {
      process.stdout.write(JSON.stringify({
        ok: blockers.length === 0,
        provider: opts.provider,
        compliant: required.length === 0,
        alsoValidFor: alsoOk,
        inferred: res.inferred,
        schema: res.schema,
        ledger: res.ledger,
        docUrl: res.docUrl
      }, null, 2) + "\n");
    } else if (!opts.check) {
      process.stdout.write(JSON.stringify(res.schema, null, 2) + "\n");
    }

    if (!opts.quiet && !opts.json) {
      if (res.inferred) {
        process.stderr.write("note: input looked like an example object, not a schema — inferred a schema from it.\n");
      }
      if (changes.length === 0) {
        process.stderr.write("Already valid for " + opts.provider + ". No changes needed.\n");
      } else if (opts.check && required.length === 0) {
        // Valid as-is; everything we found is an optional suggestion.
        process.stderr.write("Valid for " + opts.provider + ". " + changes.length +
          " optional suggestion" + (changes.length === 1 ? "" : "s") + ":\n");
        process.stderr.write(renderLedger(changes) + "\n");
      } else {
        process.stderr.write((opts.check ? "Not compliant with " : "Fixed for ") + opts.provider +
          " (" + changes.length + " change" + (changes.length === 1 ? "" : "s") + "):\n");
        process.stderr.write(renderLedger(changes) + "\n");
      }
      if (notes.length) {
        process.stderr.write("\n" + notes.length + " note" + (notes.length === 1 ? "" : "s") +
          " (no edit needed, but read them):\n");
        process.stderr.write(renderLedger(notes) + "\n");
      }
      if (blockers.length) {
        process.stderr.write("\n" + blockers.length + " item" + (blockers.length === 1 ? "" : "s") +
          " above cannot be fixed automatically — see " + res.docUrl + "\n");
      }
      if (alsoOk.length) {
        process.stderr.write("\nThis schema is already valid as-is for: " + alsoOk.join(", ") +
          "\nIf that is the dialect your client actually sends, you are on the wrong" +
          "\ntarget and no edit is needed — run --help to see what selects each one.\n");
      }
    }

    // Blockers outrank fixable diffs. `changes` (and therefore `required`)
    // includes `!` entries, so checking `--check` first made exit 3 —
    // documented at the top of this file as "a blocker needs a human fix" —
    // UNREACHABLE under `--check`: every blocker came back as 1, the same code
    // as a schema the tool can fix for you. That is the distinction a CI gate
    // most needs, because a script that reruns without `--check` and commits
    // the output resolves a 1 and can never resolve a 3.
    if (blockers.length) process.exit(3);
    if (opts.check && required.length) process.exit(1);
    process.exit(0);
  });
  return 0;
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { parseArgs: parseArgs, renderLedger: renderLedger, USAGE: USAGE };
