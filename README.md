# LLM JSON Schema

Turn a JSON Schema (or a JSON example) into a **provider-correct** LLM structured-output schema for **OpenAI**, **Anthropic**, and **Gemini** — and explain/fix schemas a provider rejected.

Available three ways, all running the same dependency-free engine:

| | |
|---|---|
| **CLI / CI gate** | `npx github:percymcn/llm-json-schema --to openai schema.json` |
| **Library** | `import { toOpenAI } from "llm-json-schema"` — ESM, CJS, and TypeScript types |
| **Web (no install)** | https://percymcn.github.io/llm-json-schema/ |

> Status: **v0.1**. Unit-tested: 317 engine + 123 CLI + 31 ESM/library assertions = **471** (`npm test`). Provider rules are verified against each vendor's own SDK, not its docs — the docs list the *supported* subset, the SDK encodes the *accepted* one, and they differ.
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

**If you write Python, nothing else checks this for you.** OpenAI's two SDKs do not
agree about what they will send:

| | `openai@7.4.0` (JS/TS) | `openai==2.53.0` (Python) |
|---|---|---|
| Builds the schema | `toStrictJsonSchema()` | `_ensure_strict_json_schema()` |
| Adds `additionalProperties: false`, widens `required` | yes | yes |
| **Rejects a schema strict mode can't represent** | **yes — throws locally** | **no — sends it** |
| Sets `strict: true` | yes | yes, hardcoded at all three builders |

Measured over a 33-shape battery, the Python transformer accepts **17 shapes the
JavaScript one throws on** — `uniqueItems`, `prefixItems`, tuple-form `items`,
`not`, `if`/`then`, `patternProperties`, `dependentRequired`, nested `$id`, an
array with no `items`, and more. It doesn't repair them; it passes them through
verbatim and stamps `strict: true` on the request. The failure still happens, just
later and further away — as a runtime 400 instead of a build-time exception.

That is not a corner case. Seven ordinary Pydantic models, run through the Python
SDK's own public path, produced **three payloads the JavaScript SDK refuses to
send** — a `Tuple[int, int, int, int]`, a `List[int]` with `uniqueItems`, and a
model combining a tuple with a literal union. All three are caught by
`--check --to openai`, and all three are accepted by the vendor's validator after
`--to openai`. Those exact payloads are pinned as regression fixtures in
`engine.test.js`, so this claim is a test, not a sentence.

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
| `--to <provider>` | `openai` \| `openai-nonstrict` \| `openai-realtime` \| `anthropic` \| `anthropic-json` \| `anthropic-json-python` \| `gemini` \| `gemini-json` (required) |
| `--check` | Emit no schema; exit `1` if it isn't already compliant |
| `--json` | Emit `{ok, compliant, schema, ledger, docUrl}` for scripting |
| `--mode <m>` | `auto` (default) \| `schema` \| `example` |
| `--quiet` | Suppress the ledger |

**Exit codes:** `0` ok/compliant · `1` `--check` found changes · `2` usage or bad JSON · `3` a blocker needs a human fix.

`3` outranks `1`, and the difference is the one a CI gate cares about: **`1` means
rerunning without `--check` and committing the output fixes it; `3` means no
output of this tool will, because the schema has to be remodelled by hand.** A
`required` key that `properties` never declares, an open map (`additionalProperties`
with no `properties`), and a heterogeneous tuple are all `3` — each is a shape where
the "obvious" repair silently deletes something you wrote.

## Why
Each provider accepts a different schema dialect, so a schema that works with one gets rejected by the next:
- **OpenAI Structured Outputs (strict):** `additionalProperties: false` on every object; every property in `required` (optionals become nullable); root must be an object, not `anyOf`. Its keyword set is an **allowlist** — *"if you turn on Structured Outputs … and call the API with an unsupported JSON Schema, you will receive an error."* The error is raised for keywords whose validation semantics strict mode cannot compile (`uniqueItems`, `patternProperties`, `propertyNames`, `min`/`maxProperties`, `contains`, `not`, `if`/`then`/`else`, `dependentRequired`, `prefixItems`, …). Annotations and soft constraints — `description`, `title`, `default`, `examples`, `minLength`/`maxLength`, `pattern`, `format`, `minimum`/`maximum`, `multipleOf`, `$schema`, `$id` — are **accepted and passed through untouched**, so this tool leaves them alone.

  Three rules here are *conditional*, and a flat "is this keyword allowed?" list gets all three wrong:
  - **`oneOf`** is rewritten to `anyOf` **only when the branches are provably mutually exclusive**. `oneOf` means exactly one branch matches and `anyOf` means at least one, so rewriting an overlapping union silently widens it. `openai@7.4.0`'s `helpers/standard-schema.js` proves exclusivity first and otherwise throws: *"OpenAI strict schemas do not support `oneOf`; use `anyOf` or add a discriminator with distinct literal values."* We follow that rule and flag the unprovable case instead of guessing. (Note the vendor's own two helper families disagree: the five `helpers/zod.js` builders run `toStrictJsonSchema()` alone, which passes a non-exclusive `oneOf` straight through to the API.)
  - **`allOf`** is **not** flatly unsupported. A single-member `allOf` is flattened (annotations kept) and an `allOf` of *open* object schemas is merged; only closed-object members (*"cannot be merged without changing Draft 7 validation"*) and multi-member non-object `allOf` throw. `{"allOf": [{"$ref": …}], "description": …}` — the standard Pydantic output for a referenced model with a field description — is therefore perfectly valid, and stripping it would delete the whole subschema.
  - **`$id`** is legal at the **root** and fatal **anywhere else** (*"Nested $id … establishes a separate JSON Schema resource scope"*). Likewise `"type": "array"` is legal but fatal without `items`.

  **All of that is conditional on `strict: true`, which is optional and off by default** — so `--to openai` is the right target only if you actually set it. In `openai@7.4.0` the flag is optional at four declaration sites (`FunctionDefinition`, `ResponseFormatJSONSchema.JSONSchema`, and both Responses equivalents), each documented *"Only a subset of JSON Schema is supported when `strict` is `true`."*
  - **`--to openai-nonstrict`** — `strict` absent or false. The subset does not apply: your schema is sent as plain JSON Schema, so nothing is stripped, nothing is forced into `required`, and tuples survive. In exchange the model is **not** grammar-constrained, so every constraint is guidance it can violate — validate the response yourself.
  - **`--to openai-realtime`** — the same dialect, for the surface where it is not a choice: `RealtimeFunctionTool` has no `strict` field at all.

  **Some clients decide this for you.** [Instructor](https://github.com/567-labs/instructor) omits `strict` on *every* OpenAI path — `Mode.TOOLS` (the default), `Mode.JSON_SCHEMA`, and `Mode.TOOLS_STRICT`, which is deprecated and collapses to `Mode.TOOLS`, so asking for strict silently gets you non-strict. Measured on `instructor==1.15.4`: no `strict` key in any of the three payloads. Gating those against the strict rules fails CI on a schema the API accepts as written.
- **Anthropic also has TWO paths, but the switch is *which request field you use*, not a key in the schema** (verified against `@anthropic-ai/sdk@0.116.0`). Because nothing in the schema tells you which one you are on, each is its own target:
  - **`--to anthropic` → `tools[].input_schema`** — no client-side transform at all. Your JSON Schema is attached verbatim; the only check is that the root is `type: "object"`. Tuples, `maxLength`, `format`, a draft-07 `definitions` bag and a non-exclusive `oneOf` all survive untouched, so this target reports them as fine rather than "fixing" them. `strict: true` goes on the **tool**, not the schema — the SDK documents it as *"guarantees schema validation on tool names and inputs"*; without it the schema is guidance the model can violate.
  - **`--to anthropic-json` → the structured-output path** (`output_format` / `output_config`: `{ type: "json_schema" }`) — `lib/transform-json-schema.js` rebuilds the schema from a small allowlist, and **anything it doesn't recognise is `JSON.stringify`'d into that node's `description`**.
  - **`--to anthropic-json-python`** — the same path, as implemented by the **Python** `anthropic` SDK, which is not the same program. This split is by **SDK language, not version**: `anthropic==0.116.0` and `@anthropic-ai/sdk@0.116.0` carry the same version string and disagree, so it is not a skew you can upgrade past.

  **The two Anthropic SDKs disagree about three things** (measured on `anthropic` 0.110.0 / 0.116.0 / 0.121.0 against `@anthropic-ai/sdk@0.116.0`; the first two over a 43-shape battery where they otherwise agree on 41, the third over a separate 16-shape union-`type` battery):

  | | Python `anthropic` | `@anthropic-ai/sdk` |
  |---|---|---|
  | `enum` | **preserved** — actually enforced | demoted into `description` prose |
  | root `{$ref, $defs}` | **accepted**, `$defs` kept, pointer resolves | **rejected**: `JSON schema must be an object, but got undefined` |
  | array-valued `type` (e.g. `["string","null"]`) | **raises** `AssertionError: Expected code to be unreachable` — no request is built, even for a one-element list | accepted, but the per-type branch is **skipped** and any `properties`/`items` are stringified into `description` |

  That last row is the worst failure on this path, and the two SDKs fail in **opposite** directions. The TypeScript transformer dispatches on `type === "object"` — strict equality against a *string* — so an array-valued `type` matches no branch:

  ```js
  // in:  {type: ["object","null"], properties: {a: {type: "string"}}, required: ["a"]}
  // out: {type: ["object","null"],
  //       description: '{properties: {"a":{"type":"string"}}, required: ["a"]}'}
  ```

  The whole subtree stops being schema, the transformer never recurses into it, and nothing errors or warns. Python raises instead, on *any* list. `anyOf` is the one form both handle — the TypeScript transformer maps itself over the variants (so the subtree survives and is processed properly) and the Python one passes it through verbatim — so that is what this tool rewrites to. It is lossless: `properties` never applied to `null` in the first place.

  Worth knowing if you use this tool for more than one provider: **`--to openai` output contains exactly this shape.** Strict mode has no optional fields, so an optional object property becomes `{type: ["object","null"], properties: …}` — valid for OpenAI, and the input that guts the Anthropic structured-output path. `--to anthropic` (tools) accepts it as-is, because that path applies no transform at all.

  The Python transformer pops `$defs` *before* its `$ref` early-return, with a source comment naming that exact case, and `messages.py` calls it with no root-type guard. The TypeScript failure is **loud, not silent** — both public helpers (`jsonSchemaOutputFormat`, `betaJSONSchemaOutputFormat`) throw, because a `$ref` root has no `type`. Only the internal `transformJSONSchema`, called directly, loses `$defs` quietly. Note the draft-07 spelling `{$ref, definitions}` is lost by **both**, so the `definitions` → `$defs` rename this tool performs is unconditional.

  Picking the wrong one is not cosmetic. `instructor`'s default Anthropic mode is `ANTHROPIC_TOOLS`, so an ordinary Pydantic model with a `tuple[int, int, int, int]` field goes on the wire **byte-identical** — gating it against the `output_format` rules is a CI failure on a payload Anthropic accepts exactly as written.

  That third policy is the one to internalise. OpenAI **errors** on an unsupported keyword; Gemini's `responseJsonSchema` **ignores** it; Anthropic **demotes it to prose**:

  ```js
  {type: "integer", minimum: 0, maximum: 100}
  // -> {"type":"integer","description":"{minimum: 0, maximum: 100}"}
  ```

  The bounds still reach the model — as a sentence. They are no longer enforced, and nothing errors or warns. Same for `minLength`, `maxLength`, `pattern`, `maxItems`, `minItems` (unless it is exactly 0 or 1), `const`, `default` and any `format` outside `date-time, time, date, duration, email, hostname, uri, ipv4, ipv6, uuid`. (`enum` is demoted **only by the TypeScript SDK** — see the table above.)

  Two more that bite real generator output:
  - A **root `$ref`** is fatal on the TypeScript SDK — it throws at the public helper (see above), and the internal `transformJSONSchema` instead returns early on `$ref`, so `zod-to-json-schema`'s `{$ref, definitions}` becomes literally `{"$ref":"#/definitions/X"}` — dangling pointer, whole schema gone, no error. `$ref` siblings are dropped outright too (not even demoted) — **that part is true of both SDKs**.
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

  **Google's two SDKs also disagree — and here it is Python that validates and JavaScript that does not.** That is the opposite of the OpenAI split above, so you cannot predict which side is strict from the language. Measured 2026-08-09 over a 40-shape battery run through both clients (`@google/genai@2.16.0`, `google-genai@2.17.0`), capturing the request body each one actually builds:

  | | `@google/genai` (JS) | `google-genai` (Python) |
  |---|---|---|
  | shapes it refuses to build | **0 of 40** | **18 of 40** |
  | `prefixItems`, `uniqueItems`, `exclusiveMinimum`, `oneOf`, `allOf`, `not`, `patternProperties`, `propertyNames`, nested `$id`, `examples`, `$comment`, integer `enum`, `const` | forwarded **verbatim** into the proto | raises `extra_forbidden` |
  | `type: ["string","null"]` | rewritten to `{type:"STRING", nullable:true}` | raises — `Schema.type` is a single-valued enum |
  | `items: [A, B]` (draft-07 tuple) | silently becomes `items: {"0":A, "1":B}` | raises |
  | `additionalProperties: false` | silently dropped | preserved |
  | `$ref` / `$defs` | left in place, unresolved | inlined |
  | `type: "null"` alone | **throws** | accepted, becomes `{nullable:true}` |
  | wire casing | `minLength`, `anyOf`, `propertyOrdering` | `min_length`, `any_of`, `property_ordering` |

  `processJsonSchema()` in the JS client is a type-caser, not a validator: it upper-cases `type` and forwards everything else. So the JS client hands you a **runtime 400** where the Python client raises **before the request exists** — and the schema that a Python user cannot even build is one a JS user ships to production.

  This is why `--to gemini` rewrites a union `type`. `zod-to-json-schema` emits `type: ["string","null"]` for `.nullable()`, and this tool's own `--to openai` output creates it. Every one of the 12 union shapes tested fails in **one** of the two SDKs — in both directions, since bare `type:"null"` fails in the opposite one — and the converted output was verified to build in **both**. The rewrite is the one the JS SDK itself performs, with two deliberate departures where that SDK is wrong: a null-only type becomes `{nullable:true}` rather than an empty `anyOf`, and repeated members are collapsed. On `--to gemini-json` a union `type` is left alone, because it is ordinary JSON Schema there.

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

A third trap has no fix at all, only a decision, and it is the one most likely
to reach production silently: the **open map**. `Dict[str, str]` (Pydantic),
`Record<string, string>` / `z.record()` (Zod) and OpenAPI free-form objects all
render as `{"type": "object", "additionalProperties": {…}}` with **no**
`properties`. OpenAI strict mode requires `additionalProperties: false` on
every object — and on a node with no `properties`, setting `false` does not
close the object, it *empties* it: the only legal instance becomes `{}`, so the
field can never be populated and nothing in the request says so. This tool
refuses to make that edit. It reports the node as a blocker, leaves the element
type visible, and names the remedy (an array of `{key, value}` objects, or
declaring the keys you actually expect). The narrow Gemini `responseSchema`
proto loses it the same way — it has no `additionalProperties` field at all —
so that target blocks it too and points at `--to gemini-json`, which accepts it.
Anthropic's `output_format` transformer performs the destruction itself,
rebuilding the node as `{"type":"object","properties":{},"additionalProperties":false}`
with no error, so that target warns; `tools[].input_schema` sends it verbatim
and needs nothing.

Worth knowing where the open map comes from, because two of OpenAI's own
implementations disagree about it. `openai==2.53.0`'s
`_ensure_strict_json_schema` only inserts `additionalProperties: false` when
`type == "object"` *and the key is absent* (`lib/_pydantic.py:50`), so a
`Dict[str, str]` field, a `Dict[str, Any]` field and a model with
`ConfigDict(extra="allow")` all keep their open `additionalProperties` — and the
SDK then stamps `strict: True` anyway. `openai@7.4.0`'s `toStrictJsonSchema()`
**throws** on all three, and OpenAI's own `openai-agents==0.19.4` raises a
`UserError` (`strict_schema.py:118-129`, which also handles a union-valued
`type` and a typeless node with `properties`, both of which the base SDK
misses). The three payloads in this repo's tests are the verbatim output of the
Python SDK, so they are a regression pin on that disagreement.

This tool applies each provider's rules for you and shows a **change ledger** — every transform, with the exact official-doc rule it enforces cited inline.

### Picking the right target
Every vendor here accepts more than one dialect, and which one you are on is
decided by the request your *client* builds — not by anything visible in your
schema. So the commonest way to get a wrong answer from this tool is to run it
against the wrong target.

Measured example (pydantic-ai 2.27.0, captured off the wire): one ordinary
Pydantic model produces three different schemas and needs three targets, and not
one of them is the one whose name matches the vendor.

| Provider | Request field pydantic-ai uses | Target |
|---|---|---|
| OpenAI | Responses API, `strict: false` | `openai-nonstrict` |
| Anthropic | `tools[].input_schema` | `anthropic` |
| Gemini | `parametersJsonSchema` | `gemini-json` |

You don't have to know this up front. When `--check` fails, the tool tells you
which targets *do* accept the schema unchanged:

```
Not compliant with openai (3 changes):
  ~ root.assignee — `assignee` added to required …

This schema is already valid as-is for: openai-nonstrict, anthropic, gemini-json
If that is the dialect your client actually sends, you are on the wrong
target and no edit is needed — run --help to see what selects each one.
```

`--json` exposes the same list as `alsoValidFor`. It is computed from your schema
on every run rather than read from a table, so it cannot go stale when a
framework changes which field it posts to.

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
