# LLM JSON Schema

Turn a JSON Schema (or a JSON example) into a **provider-correct** LLM structured-output schema for **OpenAI**, **Anthropic**, and **Gemini** — and explain/fix schemas a provider rejected.

Available three ways, all running the same dependency-free engine:

| | |
|---|---|
| **CLI / CI gate** | `npx github:percymcn/llm-json-schema --to openai schema.json` |
| **Library** | `import { toOpenAI } from "llm-json-schema"` — ESM, CJS, and TypeScript types |
| **Web (no install)** | https://percymcn.github.io/llm-json-schema/ |

> Status: **v0.1 — ESM + TypeScript types added** (Cycle #310). Unit-tested: 21 engine + 31 CLI + 31 ESM/library assertions = 83 (`npm test`). Provider rules verified against official docs on 2026-07-30.
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
- **OpenAI Structured Outputs (strict):** `additionalProperties: false` on every object; every property in `required` (optionals become nullable); root must be an object, not `anyOf`. Its keyword set is an **allowlist** — *"if you turn on Structured Outputs … and call the API with an unsupported JSON Schema, you will receive an error."* The error is raised for keywords whose validation semantics strict mode cannot compile (`uniqueItems`, `patternProperties`, `contains`, `allOf`, `not`, `if`/`then`/`else`, …). Annotations and soft constraints — `description`, `title`, `default`, `examples`, `minLength`/`maxLength`, `$schema`, `$id` — are **accepted and passed through untouched**, so this tool leaves them alone.
- **Anthropic tool `input_schema`:** standard JSON Schema, object root, light constraints; `strict: true` goes on the tool, not the schema.
- **Gemini `responseSchema`:** a JSON-Schema subset — needs `propertyOrdering`, has no `$ref` at all (so definitions get inlined), drops `pattern`/`minLength`/`maxLength`, and limits string `format` to `date-time`/`date`/`time`.

### What generators actually emit
`zod-to-json-schema` wraps your schema as `{ "$ref": "#/definitions/X", "definitions": { … } }`.
That root has no `type` and no `properties`, so a naive converter no-ops on it and
reports "already valid" for a schema OpenAI will reject. This tool renames
`definitions` → `$defs`, inlines the root `$ref`, and then applies the object
rules to the real schema body. zod v4's `z.toJSONSchema()` and Pydantic's
`model_json_schema()` emit a normal object root, and the real fix they need is
the `required`/optional rule rather than keyword stripping.

Pydantic has a sharper trap. OpenAI supports `$ref`, but rejects a `$ref` that
carries **sibling keywords** — `$ref cannot have keywords {'description'}`.
Pydantic emits exactly that for any field whose type is a nested model or `Enum`
*and* which has a `Field(description=...)`. A plain `str` field with a
description does not, so the failure looks maddeningly input-dependent: it
appears and disappears depending on which of your fields happen to be nested
types. This tool inlines those refs and keeps the sibling.

This tool applies each provider's rules for you and shows a **change ledger** — every transform, with the exact official-doc rule it enforces cited inline.

## Features
- Accepts a **JSON Schema** or a **JSON example** (auto-detected → schema inferred).
- Pick a target provider → get the corrected schema.
- **Change ledger:** every add / change / removal / violation, each citing the provider doc rule.
- **Validate & fix** mode: see what a provider would reject and the fixed version.
- Zero dependencies, zero network calls. Nothing you feed it ever leaves your machine.

## Library use

Ships ESM, CommonJS, and TypeScript types from one package.

```js
// ESM / TypeScript
import { toOpenAI, convert } from "llm-json-schema";

// CommonJS
const { toOpenAI, convert } = require("llm-json-schema");

const { schema, ledger } = toOpenAI(mySchema);
// ledger: [{ op: "+" | "~" | "x" | "!" | "=", path, msg, ruleUrl }]
```

`op` is `+` added · `~` changed · `x` removed · `!` needs a human fix · `=` already valid.

### With Zod (Vercel AI SDK, LangChain, Mastra…)

If you got `Invalid schema … 'required' is required to be supplied and to be an
array including every key in properties`, the cause is usually that
`.optional()` in Zod emits a schema OpenAI strict mode does not allow — strict
mode has **no optional fields**. Feed the generated schema straight in; no
`JSON.stringify` needed:

```ts
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { convert } from "llm-json-schema";

const Result = z.object({
  title: z.string().min(1),               // -> minLength, which OpenAI accepts as-is
  priority: z.enum(["low", "high"]).default("low"),  // -> default, also accepted as-is
  notes: z.string().optional(),           // -> absent from `required`, which OpenAI rejects
});

const { schema, ledger } = convert(zodToJsonSchema(Result), "openai");
// - root `$ref` into `definitions` is inlined, so the object rules actually apply
// - `minLength`, `default` and `$schema` are left untouched — OpenAI accepts them
// - `notes` -> type: ["string", "null"] and added to `required`
// - `priority` is forced required, so `null` is added to its `enum` too —
//   otherwise the nullable type and the enum contradict each other
// every one of those is a ledger line citing the rule it enforces.
```

Your input object is never mutated, so you can convert the same schema for more
than one provider.

With **Pydantic**, `Model.model_json_schema()` gives you the same object — pipe
it through the CLI (`--to openai --check`) in your test suite.

## How it's built
- `engine.js` — dependency-free transform + lint logic (the product's value). Every rule cites its source doc URL. UMD, so the same bytes run in the browser.
- `engine.mjs` — ESM entry point. Node cannot statically detect named exports through the UMD wrapper, so these are re-exported explicitly; without it, `import { convert }` throws in any `"type": "module"` project.
- `index.d.ts` — TypeScript definitions (`Provider` is a union, so a wrong provider name is a compile error).
- `cli.js` — the `llm-schema` binary; a thin wrapper so CI and the browser enforce identical rules.
- `engine.test.js` / `cli.test.js` / `esm.test.mjs` — 120 assertions total. Run: `npm test`. The fixtures are the actual schemas from real reported failures and verbatim `zod-to-json-schema` / `z.toJSONSchema()` output, so a regression means the tool stopped fixing a bug people genuinely hit. Every provider is asserted **idempotent** — a `--check` gate that flagged its own output would be unusable in CI.
- `index.html` + `app.js` — static UI, GitHub Pages host. SEO scaffold: title/meta/canonical, JSON-LD `SoftwareApplication`, `sitemap.xml`, `robots.txt`, `.nojekyll`.

## Sources (verified 2026-07-30; OpenAI keyword set re-verified 2026-08-08)
- OpenAI — https://developers.openai.com/api/docs/guides/structured-outputs
- Anthropic — https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview
- Gemini — https://ai.google.dev/gemini-api/docs/structured-output

## Distribution
Organic search (targets error-message long-tails first, e.g. *"additionalProperties is required to be false"*, *"gemini responseSchema $ref not supported"*) plus direct `npx github:` install. An npm registry release would add the registry's own discovery surface; that's pending.

## License
MIT.
