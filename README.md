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
| `--to <provider>` | `openai` \| `openai-realtime` \| `anthropic` \| `anthropic-json` \| `gemini` \| `gemini-json` (required) |
| `--check` | Emit no schema; exit `1` if it isn't already compliant |
| `--json` | Emit `{ok, compliant, schema, ledger, docUrl}` for scripting |
| `--mode <m>` | `auto` (default) \| `schema` \| `example` |
| `--quiet` | Suppress the ledger |

**Exit codes:** `0` ok/compliant · `1` `--check` found changes · `2` usage or bad JSON · `3` converted, but a blocker needs a human fix.

## Why
Each provider accepts a different schema dialect, so a schema that works with one gets rejected by the next:
- **OpenAI Structured Outputs (strict):** `additionalProperties: false` on every object; every property in `required` (optionals become nullable); root must be an object, not `anyOf`. Its keyword set is an **allowlist** — *"if you turn on Structured Outputs … and call the API with an unsupported JSON Schema, you will receive an error."* The error is raised for keywords whose validation semantics strict mode cannot compile (`uniqueItems`, `patternProperties`, `propertyNames`, `min`/`maxProperties`, `contains`, `not`, `if`/`then`/`else`, `dependentRequired`, `prefixItems`, …). Annotations and soft constraints — `description`, `title`, `default`, `examples`, `minLength`/`maxLength`, `pattern`, `format`, `minimum`/`maximum`, `multipleOf`, `$schema`, `$id` — are **accepted and passed through untouched**, so this tool leaves them alone.

  Three rules here are *conditional*, and a flat "is this keyword allowed?" list gets all three wrong:
  - **`oneOf`** is rewritten to `anyOf` **only when the branches are provably mutually exclusive**. `oneOf` means exactly one branch matches and `anyOf` means at least one, so rewriting an overlapping union silently widens it. `openai@7.4.0`'s `helpers/standard-schema.js` proves exclusivity first and otherwise throws: *"OpenAI strict schemas do not support `oneOf`; use `anyOf` or add a discriminator with distinct literal values."* We follow that rule and flag the unprovable case instead of guessing. (Note the vendor's own two helper families disagree: the five `helpers/zod.js` builders run `toStrictJsonSchema()` alone, which passes a non-exclusive `oneOf` straight through to the API.)
  - **`allOf`** is **not** flatly unsupported. A single-member `allOf` is flattened (annotations kept) and an `allOf` of *open* object schemas is merged; only closed-object members (*"cannot be merged without changing Draft 7 validation"*) and multi-member non-object `allOf` throw. `{"allOf": [{"$ref": …}], "description": …}` — the standard Pydantic output for a referenced model with a field description — is therefore perfectly valid, and stripping it would delete the whole subschema.
  - **`$id`** is legal at the **root** and fatal **anywhere else** (*"Nested $id … establishes a separate JSON Schema resource scope"*). Likewise `"type": "array"` is legal but fatal without `items`.
- **Anthropic also has TWO paths, but the switch is *which request field you use*, not a key in the schema** (verified against `@anthropic-ai/sdk@0.116.0`). Because nothing in the schema tells you which one you are on, each is its own target:
  - **`--to anthropic` → `tools[].input_schema`** — no client-side transform at all. Your JSON Schema is attached verbatim; the only check is that the root is `type: "object"`. Tuples, `maxLength`, `format`, a draft-07 `definitions` bag and a non-exclusive `oneOf` all survive untouched, so this target reports them as fine rather than "fixing" them. `strict: true` goes on the **tool**, not the schema — the SDK documents it as *"guarantees schema validation on tool names and inputs"*; without it the schema is guidance the model can violate.
  - **`--to anthropic-json` → `output_format: { type: "json_schema" }`** — `lib/transform-json-schema.js` rebuilds the schema from a small allowlist, and **anything it doesn't recognise is `JSON.stringify`'d into that node's `description`**.

  Picking the wrong one is not cosmetic. `instructor`'s default Anthropic mode is `ANTHROPIC_TOOLS`, so an ordinary Pydantic model with a `tuple[int, int, int, int]` field goes on the wire **byte-identical** — gating it against the `output_format` rules is a CI failure on a payload Anthropic accepts exactly as written.

  That third policy is the one to internalise. OpenAI **errors** on an unsupported keyword; Gemini's `responseJsonSchema` **ignores** it; Anthropic **demotes it to prose**:

  ```js
  {type: "string", enum: ["low","high"]}
  // -> {"type":"string","description":"{enum: [\"low\",\"high\"]}"}
  ```

  The enum still reaches the model — as a sentence. It is no longer enforced, and nothing errors or warns. Same for `minLength`, `maxLength`, `pattern`, `maxItems`, `minItems` (unless it is exactly 0 or 1), and any `format` outside `date-time, time, date, duration, email, hostname, uri, ipv4, ipv6, uuid`.

  Two more that bite real generator output:
  - A **root `$ref`** is fatal: the transformer returns early on `$ref`, so `zod-to-json-schema`'s `{$ref, definitions}` becomes literally `{"$ref":"#/definitions/X"}` — dangling pointer, whole schema gone, no error. `$ref` siblings are dropped outright too (not even demoted).
  - **Tuples** fail two different ways: array-form `items` (and `prefixItems` beside `items: false`) **throws** `JSON schema must have a type defined if anyOf/oneOf/allOf are not used` — a message that never mentions tuples — while a bare `prefixItems`, which is exactly what zod v4's `z.toJSONSchema(z.tuple([...]))` emits, is quietly demoted, leaving an array with **no item schema and no length at all**.

  Unlike OpenAI, Anthropic does **not** require every key in `required` — the transformer passes your list through as given, so this tool does not force it.

  On `--to anthropic-json` this tool keeps every demoted keyword (it is still enforced on the tools path) and reports it as an advisory note, so `--check` stays green on a schema that is legal but only partly enforced. On `--to anthropic` those notes do not appear at all, because nothing is demoted — the two targets deliberately disagree about the same file.
- **Gemini has TWO schema paths, and which one you land on is a property of YOUR CLIENT, not of your schema.** The two request fields are **`responseJsonSchema`** (full JSON Schema) and **`responseSchema`** (the narrow OpenAPI-style `Schema` proto). Only one client picks for you:

  | client | routes to `responseJsonSchema`? |
  |---|---|
  | `@google/genai` (JS) | yes — `maybeMoveToResponseJsonSchema()` moves it when there is a **top-level `$schema`** |
  | `google-genai` (Python) | no — no `$schema` handling exists; you set `response_json_schema=` yourself |
  | `@google/generative-ai` (legacy JS, used by `@langchain/google-genai`) | **no — the field does not exist in that package at all** |

  So a top-level `$schema` is *not* a routing switch in general, and this tool will not read it as one. Pick the path with `--to gemini` (narrow proto) or `--to gemini-json` (`responseJsonSchema`). Getting this wrong is not a style question: LangChain emits a top-level `$schema` *and* lands on the narrow path, and the live `v1beta` endpoint answers with `HTTP 400 — Unknown name "$schema" … Cannot find field` / `Unknown name "prefixItems" … Cannot find field`.

  The two accepted subsets are **complementary — neither is a superset**:

  | | `responseSchema` (proto) | `responseJsonSchema` |
  |---|---|---|
  | `pattern`, `minLength`, `maxLength`, `min/maxProperties`, `default`, `example`, `nullable` | ✅ | ❌ |
  | `$ref`, `$defs`, `$anchor`, `$id`, `prefixItems`, `additionalProperties`, `oneOf` | ❌ | ✅ |
  | `type`, `format`, `title`, `description`, `enum`, `items`, `min/maxItems`, `minimum`, `maximum`, `anyOf`, `properties`, `required`, `propertyOrdering` | ✅ | ✅ |

  So the tool converts for whichever path you name, and tells you when a keyword would only survive on the other one.

  The two paths also differ in how they treat an unsupported keyword, which is why the tool treats them differently. OpenAI's doc says outright that an unsupported schema means "you will receive an error", so unsupported keywords are **removed**. Gemini's `response_json_schema` says the full JSON Schema **may be sent** and merely that not all features are supported — so on that path unsupported keywords are **kept and flagged as unenforced**, because deleting a constraint the request tolerates costs you something and buys nothing. On the narrow proto path they are removed, and that one is machine-checkable rather than a judgement call: the Python SDK's `types.Schema` is declared `extra="forbid"`, so `Schema.model_validate()` raises on any keyword outside the proto. That makes it a vendor-owned oracle you can run with no API key — the same role `toStrictJsonSchema()` plays for OpenAI — and this tool's narrow-path output is round-tripped through it.

  On the JSON-Schema path the tool also enforces two rules stated only on that SDK field: a `$ref` sub-schema may carry no non-`$` siblings, and cyclic references are only allowed inside **non-required** properties.

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
- Gemini — https://ai.google.dev/gemini-api/docs/structured-output plus the vendor SDKs, verified 2026-08-09: `@google/genai@2.16.0` (the `Schema` type, `processJsonSchema()`, `maybeMoveToResponseJsonSchema()`) by capturing the request body the SDK actually builds, and `google-genai@2.17.0` (Python), whose `response_json_schema` field documents the accepted property list for the JSON-Schema path verbatim

Where a vendor ships a client SDK, the SDK outranks the doc: docs describe the *supported* subset, the SDK encodes the *accepted* one, and they differ.

## Distribution
Organic search (targets error-message long-tails first, e.g. *"additionalProperties is required to be false"*, *"gemini responseSchema $ref not supported"*) plus direct `npx github:` install. An npm registry release would add the registry's own discovery surface; that's pending.

## License
MIT.
