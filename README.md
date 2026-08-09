# LLM JSON Schema

Turn a JSON Schema (or a JSON example) into a **provider-correct** LLM structured-output schema for **OpenAI**, **Anthropic**, and **Gemini** — and explain/fix schemas a provider rejected.

Available three ways, all running the same dependency-free engine:

| | |
|---|---|
| **CLI / CI gate** | `npx github:percymcn/llm-json-schema --to openai schema.json` |
| **Library** | `require("llm-json-schema").toOpenAI(schema)` |
| **Web (no install)** | https://percymcn.github.io/llm-json-schema/ |

> Status: **v0.1 — CLI + library added** (Cycle #309). Unit-tested: 21 engine assertions + 31 CLI assertions (`npm test`). Provider rules verified against official docs on 2026-07-30.
>
> Not yet on the npm registry — install straight from GitHub as shown below. The `llm-json-schema` name is unclaimed and the package is publish-ready (`npm pack` verified); the registry release is pending.

## Quick start

```bash
# Fix a schema for OpenAI strict mode
npx github:percymcn/llm-json-schema --to openai schema.json > fixed.json

# Pipe it
cat schema.json | npx github:percymcn/llm-json-schema --to gemini

# Fail CI if a schema isn't valid for the provider you ship against
npx github:percymcn/llm-json-schema --to openai --check schema.json
```

The fixed schema goes to **stdout**; the explanation ledger goes to **stderr**, so redirection stays clean.

### Why a CLI

The developers who hit these errors mostly don't have a schema to paste into a
browser — it's generated at runtime by Zod or Pydantic inside an AI SDK. A CLI
runs where the schema actually is: in your repo, in your test suite, in CI.

```
$ echo '{"type":"object","properties":{"args":{"type":"object"}}}' | llm-schema --to openai
{
  "type": "object",
  "properties": { "args": { "type": ["object", "null"] } },
  "additionalProperties": false,
  "required": ["args"]
}
Fixed for openai (2 changes):
  + root — Set `additionalProperties: false` — required on every object. [added]
  ~ root.args — `args` added to required (all fields must be required); made nullable to preserve optionality. [changed]
```

Note the second line: OpenAI strict mode has **no optional fields**, so the fix
is `nullable`, not "make it mandatory". Getting that wrong silently changes your
API contract — which is why the ledger cites the rule for every change.

### Options

| Flag | Meaning |
|---|---|
| `--to <provider>` | `openai` \| `anthropic` \| `gemini` (required) |
| `--check` | Emit no schema; exit `1` if it isn't already compliant |
| `--json` | Emit `{ok, compliant, schema, ledger, docUrl}` for scripting |
| `--mode <m>` | `auto` (default) \| `schema` \| `example` |
| `--quiet` | Suppress the ledger |

**Exit codes:** `0` ok/compliant · `1` `--check` found changes · `2` usage or bad JSON · `3` converted, but a blocker needs a human fix.

## Why
Each provider accepts a different schema dialect, so a schema that works with one gets rejected by the next:
- **OpenAI Structured Outputs (strict):** `additionalProperties: false` on every object; every property in `required` (optionals become nullable); root must be an object, not `anyOf`; `allOf`/`not`/`if`/`then`/`else` unsupported.
- **Anthropic tool `input_schema`:** standard JSON Schema, object root, light constraints; `strict: true` goes on the tool, not the schema.
- **Gemini `responseSchema`:** a JSON-Schema subset — needs `propertyOrdering`, drops `$ref`/`pattern`/`minLength`/`maxLength`, and limits string `format` to `date-time`/`date`/`time`.

This tool applies each provider's rules for you and shows a **change ledger** — every transform, with the exact official-doc rule it enforces cited inline.

## Features
- Accepts a **JSON Schema** or a **JSON example** (auto-detected → schema inferred).
- Pick a target provider → get the corrected schema.
- **Change ledger:** every add / change / removal / violation, each citing the provider doc rule.
- **Validate & fix** mode: see what a provider would reject and the fixed version.
- Zero dependencies, zero network calls. Nothing you feed it ever leaves your machine.

## Library use

```js
const { toOpenAI, toAnthropic, toGemini, convert } = require("llm-json-schema");

const { schema, ledger } = toOpenAI(mySchema);
// ledger: [{ op: "+" | "~" | "x" | "!" | "=", path, msg, ruleUrl }]
```

`op` is `+` added · `~` changed · `x` removed · `!` needs a human fix · `=` already valid.

## How it's built
- `engine.js` — dependency-free transform + lint logic (the product's value). Every rule cites its source doc URL.
- `cli.js` — the `llm-schema` binary; a thin wrapper so CI and the browser enforce identical rules.
- `engine.test.js` / `cli.test.js` — 52 assertions total. Run: `npm test`. The CLI fixtures are the actual schemas from real reported failures, so a regression means the tool stopped fixing a bug people genuinely hit.
- `index.html` + `app.js` — static UI, GitHub Pages host. SEO scaffold: title/meta/canonical, JSON-LD `SoftwareApplication`, `sitemap.xml`, `robots.txt`, `.nojekyll`.

## Sources (verified 2026-07-30)
- OpenAI — https://developers.openai.com/api/docs/guides/structured-outputs
- Anthropic — https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview
- Gemini — https://ai.google.dev/gemini-api/docs/structured-output

## Distribution
Organic search (targets error-message long-tails first, e.g. *"additionalProperties is required to be false"*, *"gemini responseSchema $ref not supported"*) plus direct `npx github:` install. An npm registry release would add the registry's own discovery surface; that's pending.

## License
MIT.
