# LLM JSON Schema

Turn a JSON Schema (or a JSON example) into a **provider-correct** LLM structured-output schema for **OpenAI**, **Anthropic**, and **Gemini** — and explain/fix schemas a provider rejected.

Available three ways, all running the same dependency-free engine:

| | |
|---|---|
| **CLI / CI gate** | `npx github:percymcn/llm-json-schema --to openai schema.json` |
| **Library** | `import { toOpenAI } from "llm-json-schema"` — ESM, CJS, and TypeScript types |
| **Web (no install)** | https://percymcn.github.io/llm-json-schema/ |

> Status: **v0.1**. Unit-tested: 687 engine + 197 CLI + 34 ESM/library assertions = **918** (`npm test`). Provider rules are verified against each vendor's own SDK, not its docs — the docs list the *supported* subset, the SDK encodes the *accepted* one, and they differ.
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
| `--to <provider>` | `openai` \| `openai-nonstrict` \| `openai-realtime` \| `anthropic` \| `anthropic-json` \| `anthropic-json-python` \| `anthropic-go` \| `gemini` \| `gemini-json` \| `gemini-client` (required) |
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
  - **`allOf`** is **not** flatly unsupported. An `allOf` of *open* object schemas is merged — the union of their `properties` and of their `required` — and **a single member is not a special case: it takes the same merge.** Measured on `openai@7.4.0`, `{"properties":{"kind":…},"required":["kind"],"allOf":[{"properties":{"a":…},"required":["a"]}]}` comes back carrying **both** `kind` and `a`. (This tool used to read "flatten a single member" as "keep the wrapper's annotations and let the parent win", which silently *deleted* the member's `properties` and `required` whenever the parent had its own — see the note below.) Only closed-object members (*"cannot be merged without changing Draft 7 validation"*), a property name declared on both sides with **different** schemas, and multi-member non-object `allOf` throw; a name declared on both sides with an **identical** schema merges fine. `{"allOf": [{"$ref": …}], "description": …}` — the standard Pydantic output for a referenced model with a field description — is therefore perfectly valid, and stripping it would delete the whole subschema.
  - **`$id`** is legal at the **root** and fatal **anywhere else** (*"Nested $id … establishes a separate JSON Schema resource scope"*). Likewise `"type": "array"` is legal but fatal without `items`.

  **All of that is conditional on `strict: true`, which is optional and off by default** — so `--to openai` is the right target only if you actually set it. In `openai@7.4.0` the flag is optional at four declaration sites (`FunctionDefinition`, `ResponseFormatJSONSchema.JSONSchema`, and both Responses equivalents), each documented *"Only a subset of JSON Schema is supported when `strict` is `true`."*
  - **`--to openai-nonstrict`** — `strict` absent or false. The subset does not apply: your schema is sent as plain JSON Schema, so nothing is stripped, nothing is forced into `required`, and tuples survive. In exchange the model is **not** grammar-constrained, so every constraint is guidance it can violate — validate the response yourself.
  - **`--to openai-realtime`** — the same dialect, for the surface where it is not a choice: `RealtimeFunctionTool` has no `strict` field at all.

  **Some clients decide this for you.** [Instructor](https://github.com/567-labs/instructor) omits `strict` on *every* OpenAI path — `Mode.TOOLS` (the default), `Mode.JSON_SCHEMA`, and `Mode.TOOLS_STRICT`, which is deprecated and collapses to `Mode.TOOLS`, so asking for strict silently gets you non-strict. Measured on `instructor==1.15.4`: no `strict` key in any of the three payloads. Gating those against the strict rules fails CI on a schema the API accepts as written.
- **Anthropic also has TWO paths, but the switch is *which request field you use*, not a key in the schema** (verified against `@anthropic-ai/sdk@0.116.0`). Because nothing in the schema tells you which one you are on, each is its own target:
  - **`--to anthropic` → `tools[].input_schema`** — no client-side transform at all. Your JSON Schema is attached verbatim; the only check is that the root is `type: "object"`. Tuples, `maxLength`, `format`, a draft-07 `definitions` bag and a non-exclusive `oneOf` all survive untouched, so this target reports them as fine rather than "fixing" them. `strict: true` goes on the **tool**, not the schema — the SDK documents it as *"guarantees schema validation on tool names and inputs"*; without it the schema is guidance the model can violate.
  - **`--to anthropic-json` → the structured-output path** (`output_format` / `output_config`: `{ type: "json_schema" }`) — `lib/transform-json-schema.js` rebuilds the schema from a small allowlist, and **anything it doesn't recognise is `JSON.stringify`'d into that node's `description`**.
  - **`--to anthropic-json-python`** — the same path, as implemented by the **Python** `anthropic` SDK, which is not the same program. This split is by **SDK language, not version**: `anthropic==0.116.0` and `@anthropic-ai/sdk@0.116.0` carry the same version string and disagree, so it is not a skew you can upgrade past.

  - **`--to anthropic-go`** — `github.com/anthropics/anthropic-sdk-go`, and it is a **third** implementation, not an alias of either. Pick it for **any** use of that SDK, tools included: Go is the one language where `tools[].input_schema` is *not* verbatim, because `BetaToolInputSchema` calls the same `transformSchemaMap` as `BetaJSONSchemaOutputFormat` (`schemautil.go`). Measured identical output from both helpers on all 19 shapes probed, on `v1.62.0`.

  **Anthropic ships three SDKs with three different supported-key sets, at the same vendor.** Measured 2026-08-09 by calling each SDK's own transform:

  | keyword | Python `anthropic` | `@anthropic-ai/sdk` | `anthropic-sdk-go` |
  |---|---|---|---|
  | `enum` | preserved | demoted to prose | **preserved** |
  | `const` | demoted | demoted | **preserved** |
  | `pattern` | demoted | demoted | **preserved** |
  | array-valued `type` | raises `AssertionError` | subtree stringified into `description` | **whole document dropped** |
  | draft-07 tuple `items: [A,B]` | — | throws | **whole document dropped** |
  | draft-07 `definitions` bag | lost | stringified into root `description` | **deleted before the transform runs** |
  | open map (`additionalProperties`, no `properties`) | rebuilt as unsatisfiable | rebuilt as unsatisfiable | **preserved and recursed** |
  | typeless node | throws | throws | **replaced by the literal `true`** |

  Two of those Go rows are not "unsupported", they are total loss, and they share a cause worth knowing: `transformSchemaMap` round-trips your map through `invopop/jsonschema.Schema` and `return nil`s on **any** unmarshal error, swallowing it. That struct types `Type` as a `string` and `Items` as a `*Schema`, so an array in either field — anywhere in the document, including inside `$defs` — silently discards everything. Both helpers then hand the API a null schema with nothing raised client-side.

  A third Go-only distinction: "unsupported" hides **two** severities. A keyword `invopop` *models* but Anthropic does not list (`minLength`, `uniqueItems`, `default`, `not`, `contains`, …) is demoted to `description` prose. A keyword `invopop` does not model at all (`unevaluatedProperties`, `additionalItems`, `discriminator`, `x-*`, `definitions`) is dropped by `Schema.UnmarshalJSON` — a plain alias unmarshal with no catch-all — **before** Anthropic's transform runs, so it cannot be appended to any description and vanishes without a trace.

  And one outright bug, reported upstream: `formatExtraValue` walks pointers with `reflect` but then formats the **original** value, and `invopop` declares the length keywords as `*uint64`. So `minLength`/`maxLength`/`maxItems`/`min`-`maxProperties`/`min`-`maxContains` do not merely stop being enforced — the model is told `{maxLength: 0x162d307bcc80}`. (`minItems` escapes it: the array branch dereferences explicitly.)

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
  - **An EMPTY tuple is still a tuple.** `{"type": "array", "items": []}` is the verbatim
  zod 4.4.3 rendering of `z.tuple([])` with `target: "draft-7"`, and it is rejected by every
  destination that rejects the tuple form — `toStrictJsonSchema` throws, `@anthropic-ai/sdk`
  throws, `anthropic` (Python) raises `TypeError: 'list' object is not a mapping` so the request
  is never built, `anthropic-sdk-go` returns `schema: null` for the **whole document**, and
  `types.Schema` rejects it. With zero positional schemas it constrains no element, so it is
  removed losslessly and the node means what `{"type": "array"}` already meant. (The one
  exception is a sibling `additionalItems`, which with an empty list applies to *every* element
  and is therefore the real element schema — it is moved into `items` rather than dropped.)
  Note the generator has already lost the "exactly zero elements" part by this point; if that is
  what you meant, add `maxItems: 0`.
  - **Tuples** fail two different ways: array-form `items` (and `prefixItems` beside `items: false`) **throws** `JSON schema must have a type defined if anyOf/oneOf/allOf are not used` — a message that never mentions tuples — while a bare `prefixItems`, which is exactly what zod v4's `z.toJSONSchema(z.tuple([...]))` emits, is quietly demoted, leaving an array with **no item schema and no length at all**.

  Unlike OpenAI, Anthropic does **not** require every key in `required` — the transformer passes your list through as given, so this tool does not force it.

  On `--to anthropic-json` this tool keeps every demoted keyword (it is still enforced on the tools path) and reports it as an advisory note, so `--check` stays green on a schema that is legal but only partly enforced. On `--to anthropic` those notes do not appear at all, because nothing is demoted — the two targets deliberately disagree about the same file.
- **Gemini has TWO schema paths, and which one you land on is a property of YOUR CLIENT, not of your schema.** The two request fields are **`responseJsonSchema`** (full JSON Schema) and **`responseSchema`** (the narrow OpenAPI-style `Schema` proto). Only one client picks for you:

  | client | routes to `responseJsonSchema`? |
  |---|---|
  | `@google/genai` (JS) | yes — `maybeMoveToResponseJsonSchema()` moves it when there is a **top-level `$schema`** |
  | `google-genai` (Python) | no — no `$schema` handling exists; you set `response_json_schema=` yourself |
  | `@google/generative-ai` (legacy JS, used by `@langchain/google-genai`) | **no — the field does not exist in that package at all** |
  | `google.golang.org/genai` (Go) | no — `InternalTJsonSchema` is the identity function and there is no routing code anywhere in the package |

  So a top-level `$schema` is *not* a routing switch in general, and this tool will not read it as one. Pick the path with `--to gemini` (narrow proto) or `--to gemini-json` (`responseJsonSchema`). Getting this wrong is not a style question: LangChain emits a top-level `$schema` *and* lands on the narrow path, and the live `v1beta` endpoint answers with `HTTP 400 — Unknown name "$schema" … Cannot find field` / `Unknown name "prefixItems" … Cannot find field`.

  **The narrow path has three clients and three different behaviours for the same unsupported keyword** (measured 2026-08-09 on one verbatim `pydantic==2.13.4` schema — a nested model, a `tuple`, an `Optional[str] = None`):

  | client | what happens to `$ref` / `$defs` / `prefixItems` / `additionalProperties` | what you see |
  |---|---|---|
  | `@google/genai` (JS) | forwarded verbatim | `HTTP 400 — Unknown name "$defs" … Cannot find field` |
  | `google-genai` (Python) | `types.Schema` is `extra="forbid"` | a local exception; the request is never built |
  | `google.golang.org/genai` (Go) | `Schema` is a plain struct with no `UnmarshalJSON`, so `encoding/json` **drops every key the struct has no field for** | **nothing.** `err == nil`, `HTTP 200`, and the schema you sent no longer describes your data |

  On that one schema Go silently deleted **16 key-paths** — including the whole `Addr` model, which became `{}` (the model may return literally anything there) — and the tuple's four element types, leaving a bare `array`. Go is the only client of any vendor probed by this project where an unsupported keyword produces **no signal at all**: it removes the evidence before the request is built, so the backend cannot object either. That is what `--check --to gemini` is for; in Go it is the only thing in the stack that will tell you.

  Two corollaries worth knowing. An unmarshal *error* does not mean nothing was written — Go's decoder keeps going, so `enum: [1, 2]` on an integer field returns an error **and** leaves `Enum = ["", ""]`, and a draft-07 tuple leaves `items: {}` (array of anything). And `Schema.Default` is `any` with `omitempty`, so an explicit `default: null` — which Pydantic emits for every `Optional[x] = None` field — is dropped even though the proto accepts it; that is the only key of *this tool's own output* a Go caller loses, and `--to gemini` says so as an advisory.

- **Three keywords the backend accepts that no client declares — `oneOf`, `allOf`, `not`.**

  The narrow-path allowlist was built from three *client* artifacts — the JS `.d.ts`, the Python `types.Schema`, and the Go struct's json tags — which agreed exactly on 22 keys. That agreement was read as "this is the proto". It is not. Measured 2026-08-09 against the live `v1beta` `generateContent` endpoint, which validates the payload **before** auth and so returns a real verdict with a dummy key: eleven keywords this tool strips come back `Unknown name "…" at 'generation_config.response_schema': Cannot find field` (`$ref`, `$schema`, `const`, `uniqueItems`, `exclusiveMinimum`, `patternProperties`, `propertyNames`, `if`, `contains`, `dependentRequired`, `multipleOf`), and a bogus `type` control is rejected too — so the oracle is live and discriminating. `oneOf`, `allOf` and `not` are **not** rejected, at the root or nested. The proto has those fields.

  So the previous behaviour deleted a constraint the destination would have accepted, and for a discriminated union the node is often *nothing but* the union — `{"title":"Pet","oneOf":[…]}` came out as `{"title":"Pet"}`, which the backend then accepts happily while constraining nothing. `--to gemini` now **keeps** all three and says what happens next, because that depends on your client and not on your schema: `@google/genai` (JS) forwards them verbatim and the call goes through; `google-genai` (Python) raises locally, since `types.Schema` is `extra="forbid"`; the Go client has no such field, so `encoding/json` **drops it with `err == nil`** — `{"oneOf":[…]}` unmarshals to `{}`. It is an advisory, never a gate failure: the destination accepts the document, so failing CI on it would be wrong. `--to gemini-client` still strips them, because a converting client rebuilds the request from its own `Schema` type and no client declares them — the two targets genuinely disagree about the same file.

  The general lesson is a bound on this project's own rule that a vendor SDK outranks a vendor doc. It still does — but an SDK is a statement about **what that client can carry**, never about what the service accepts, and a static type is the strongest form of that statement *and still only that statement*. When several independent clients agree, that is evidence they were generated from one shared subset, not evidence the subset is the whole API. Ask the service.

  The two accepted subsets are **complementary — neither is a superset**:

  | | `responseSchema` (proto) | `responseJsonSchema` |
  |---|---|---|
  | `pattern`, `minLength`, `maxLength`, `min/maxProperties`, `default`, `example`, `nullable` | ✅ | ❌ |
  | `$ref`, `$defs`, `$anchor`, `$id`, `prefixItems`, `additionalProperties`, `oneOf` | ❌ | ✅ |
  | `type`, `format`, `title`, `description`, `enum`, `items`, `min/maxItems`, `minimum`, `maximum`, `anyOf`, `properties`, `required`, `propertyOrdering` | ✅ | ✅ |

  So the tool converts for whichever path you name, and tells you when a keyword would only survive on the other one.

  The two paths also differ in how they treat an unsupported keyword, which is why the tool treats them differently. OpenAI's doc says outright that an unsupported schema means "you will receive an error", so unsupported keywords are **removed**. Gemini's `response_json_schema` says the full JSON Schema **may be sent** and merely that not all features are supported — so on that path unsupported keywords are **kept and flagged as unenforced**, because deleting a constraint the request tolerates costs you something and buys nothing. On the narrow proto path they are removed, and that one is machine-checkable rather than a judgement call: the Python SDK's `types.Schema` is declared `extra="forbid"`, so `Schema.model_validate()` raises on any keyword outside the proto. That makes it a vendor-owned oracle you can run with no API key — the same role `toStrictJsonSchema()` plays for OpenAI — and this tool's narrow-path output is round-tripped through it.

  On the JSON-Schema path the tool also enforces two rules stated only on that SDK field: a `$ref` sub-schema may carry no non-`$` siblings, and cyclic references are only allowed inside **non-required** properties.

  **The narrow path's keyword list is now verified against the service itself, in both directions.** The `v1beta` endpoint validates the request payload *before* authenticating, so a dummy key still returns a real verdict; `{"type":"frobnicate"}` comes back rejected, which is the control that shows the oracle is live and discriminating. Swept 2026-08-09 across the whole JSON Schema vocabulary rather than the keywords we happened to be arguing about: **all 22 keys the tool keeps are accepted**, and **38 it strips come back `Unknown name "X" … Cannot find field`** — `$id`, `$defs`, `definitions`, `$anchor`, `$comment`, `$ref`, `$schema`, `prefixItems`, `additionalProperties`, `additionalItems`, `unevaluatedProperties`, `patternProperties`, `propertyNames`, `const`, `uniqueItems`, `multipleOf`, `exclusiveMinimum`, `exclusiveMaximum`, `if`/`then`/`else`, `contains`, `maxContains`/`minContains`, `dependencies`, `dependentSchemas`, `dependentRequired`, `deprecated`, `readOnly`, `writeOnly`, `examples`, `contentEncoding`, `contentMediaType`, `contentSchema` and the rest. The only keywords the proto carries that no client type declares are the three combinators `oneOf`, `allOf` and `not`.

  **`format` is the exception, and it is carried rather than stripped.** The oracle cannot rule on it: `format` is a plain proto *string* field, so every value validates — including `frobnicate`, run as a control. That kills the justification the strip used to rest on ("an unsupported `format` is a hard 400"). The vendor's own `Schema.format` field description then settles it the other way: *"For `NUMBER` type, format can be `float` or `double`. For `INTEGER` type, format can be `int32` or `int64`. For `STRING` type, format can be `email`, `byte`, `date`, `date-time`, `password`, and other formats to further refine the data type."* Three of those were being deleted, and the list is explicitly **open**, so a closed allowlist is the wrong shape for it. An ordinary Pydantic model using `EmailStr`, `AnyUrl` and `UUID` lost all three formats and failed `--check`, on a document the endpoint accepts as written. Formats outside the named set are now kept and reported as an advisory — never a gate failure — saying they reach the backend but that only the named values are documented, so treat the rest as a hint rather than an enforced constraint.

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

And `additionalProperties` is not the only spelling of that trap, because it is
not the only keyword that describes keys nobody declared. `patternProperties`,
`propertyNames` and `unevaluatedProperties` describe them too, strict mode
supports none of them, and stripping one while closing the object composes two
individually correct edits into a dead field. This is reachable from an
ordinary model: pydantic 2.13.4 renders
`Dict[Annotated[str, StringConstraints(pattern=r'^S_')], str]` as
`{"type": "object", "patternProperties": {"^S_": {"type": "string"}}}` — with
no `additionalProperties` key at all, so nothing looks like a map. Those are
blockers on `--to openai` for the same reason and with the same remedy, and the
keyword is left visible so the value schema you have to remodel is still in
front of you. Where the node *also* declares real `properties` the field
survives, so it is an advisory instead, saying which keys stopped being
accepted. Deliberately not flagged: an empty `patternProperties` (it describes
no keys), `unevaluatedProperties: false` (already closed), and a bare
`{"type": "object"}` — `openai@7.4.0` closes that one itself, so flagging it
would be noise. Only OpenAI both strips these keywords *and* forces the object
closed, so only OpenAI can compose the two; the narrow Gemini proto strips them
and leaves the object open, which is a widening, and every other target carries
them verbatim.

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

Once a layer has already made that edit, the value type is gone and no tool can
recover it — so this tool reports the leftover node as an **advisory**, never a
gate failure. Every provider accepts it, so nothing else will warn you.

The advisory used to require the `properties` key to be *absent*, on the
reasoning that a generator writing `properties: {}` must have meant a genuinely
empty object. **crewai 1.15.14 disproves that.** Its
`force_additional_properties_false`
(`crewai/utilities/pydantic_schema_utils.py`) overwrites the value schema with
`false` **and then adds `properties: {}` and `required: []`**, so on its tool
path a `Dict[str, str]` field and a genuinely empty `BaseModel` come out
byte-identical:

```json
{ "type": "object", "additionalProperties": false, "properties": {}, "required": [] }
```

A repair that deletes is bad; a repair that deletes *and manufactures the
evidence that would have exonerated it* leaves nothing to infer from. So the
rule stopped trying to name the cause and now states the part that is certain
and identical in both cases — **this node's only legal value is `{}`, so the
field is dead** — and says explicitly that it cannot tell you which happened.
Where the `properties` key really is absent, no generator produces that shape
for a declared empty object, and the advisory still names the cause outright.

### Boolean subschemas — what Go emits for `any`

JSON Schema defines a schema as *"an object **or a boolean**"*: `true` matches
any value, `false` matches none. It is easy to forget the second form exists,
and easy to write a walker that only knows the first.

It is also what you get by default in Go. `openai-go`'s README shows a
`GenerateSchema[T]()` helper built on `invopop/jsonschema`, and that reflector
emits a literal `true` for `any`, `interface{}`, `json.RawMessage`, and the
element type of `[]any` — the four idiomatic ways of saying "arbitrary JSON":

```json
{ "type": "object",
  "properties": { "name": { "type": "string" }, "data": true },
  "required": ["name", "data"], "additionalProperties": false }
```

Measured, one client at a time:

| target | boolean subschema | source |
|---|---|---|
| `openai` | **rejected** — `Expected object schema but got boolean` (8/8 positions) | `openai@7.4.0` `toStrictJsonSchema()` |
| `openai-nonstrict`, `openai-realtime` | legal — no subset restriction without `strict` | — |
| `anthropic` (tools) | kept verbatim — no transform runs | `betaTool`, `@anthropic-ai/sdk@0.116.0` |
| `anthropic-json` (TS `output_format`) | **rejected** — *"JSON schema must have a type defined…"* | `transformJSONSchema` |
| `anthropic-go` | kept verbatim on **both** surfaces | `anthropic-sdk-go@v1.62.0` |
| `gemini` (narrow `responseSchema`) | **rejected** — `types.Schema` is `extra="forbid"` | `google-genai==2.17.0` |
| `gemini-json` (`responseJsonSchema`) | legal — ordinary JSON Schema | — |

So this is the fourth thing Anthropic's three SDKs disagree about, and the Go
one is again the permissive side. `--to anthropic-json-python` is deliberately
left alone: that client was not probed for this shape, so nothing is claimed.

Where it is rejected, this tool **blocks** rather than repairing. There is no
repair — a dialect that constrains decoding has no way to express "anything
goes" — so guessing a type would silently narrow your schema. The blocker names
the two honest remodellings: declare the shape you actually expect, or, if the
value really is arbitrary, type it `{"type": "string"}` and have the model emit
serialized JSON you parse yourself. The boolean is left in your output so you
can see where it is.

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
- `engine.test.js` / `cli.test.js` / `esm.test.mjs` — 918 assertions total. Run: `npm test`. The fixtures are the actual schemas from real reported failures and verbatim `zod-to-json-schema` / `z.toJSONSchema()` output, so a regression means the tool stopped fixing a bug people genuinely hit. Every provider is asserted **idempotent** — a `--check` gate that flagged its own output would be unusable in CI.
- `index.html` + `app.js` — static UI, GitHub Pages host. SEO scaffold: title/meta/canonical, JSON-LD `SoftwareApplication`, `sitemap.xml`, `robots.txt`, `.nojekyll`.

## Sources (verified 2026-07-30; OpenAI keyword set re-verified 2026-08-08)
- OpenAI — https://developers.openai.com/api/docs/guides/structured-outputs
- Anthropic — https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview
- Gemini — https://ai.google.dev/gemini-api/docs/structured-output plus the vendor SDKs, verified 2026-08-09: `@google/genai@2.16.0` (the `Schema` type, `processJsonSchema()`, `maybeMoveToResponseJsonSchema()`) by capturing the request body the SDK actually builds, and `google-genai@2.17.0` (Python), whose `response_json_schema` field documents the accepted property list for the JSON-Schema path verbatim, and `google.golang.org/genai@v1.67.0` (Go), whose `Schema` struct is a static type and therefore the strongest of the three artifacts — its 22 json tags match this tool's narrow allowlist exactly

Where a vendor ships a client SDK, the SDK outranks the doc: docs describe the *supported* subset, the SDK encodes the *accepted* one, and they differ.

## Distribution
Organic search (targets error-message long-tails first, e.g. *"additionalProperties is required to be false"*, *"gemini responseSchema $ref not supported"*) plus direct `npx github:` install. An npm registry release would add the registry's own discovery surface; that's pending.


## Gemini has three targets, and two of them are mutually exclusive

`--to gemini` and `--to gemini-json` split by **which request field** you use.
`--to gemini-client` splits by something else entirely: **who performs the
JSON-Schema-to-`Schema` conversion.** If you hand JSON Schema to a library that
converts it for you — `google-adk` is the case measured here — the proto's
*constraints* still apply, because that library cannot send what the proto has
no field for, but its *spellings* are the JSON Schema ones.

Nullability is where that stops being cosmetic. Measured against the live
`v1beta` endpoint and `google-adk==2.6.3` (control-checked with
`{"type":"frobnicate"}`, which is rejected, so the oracle discriminates):

| document | assigned to `responseSchema` | through google-adk 2.6.3 |
|---|---|---|
| `{"type":"STRING","nullable":true}` | **accepted** | `nullable` **dropped** — field stops being nullable |
| `{"type":["string","null"]}` | **rejected** — `Unknown name "type"` | converted to `nullable` correctly |

**Scope, checked rather than assumed.** google-adk 2.6.3 defaults
`JSON_SCHEMA_FOR_FUNC_DECL` to `True`, so its *tool declarations* are now sent
as `parameters_json_schema` and skip `_to_gemini_schema` entirely. Everything
measured here is of that function, which is still shipped and still reached with
the flag disabled. So this target is justified by the structural fact — `nullable`
is not a JSON Schema keyword, so **any** layer that reads JSON Schema drops it —
with ADK as the measured instance, not by a claim that every ADK user hits this
today.

There is no document that satisfies both. `nullable` is not a field of ADK's
`_ExtendedJSONSchema` — which *does* extend `JSONSchema` with
`property_ordering`, so this is not a blanket refusal of proto fields — and the
backend's `type` is a single-valued enum. Every earlier split in this tool had
an intersection form; this one does not, which is why it is a target you pick
rather than a rule that could be widened.

Two other measured consequences of that layer, both reported as advisories
because the proto accepts the input and an advisory that failed CI would be a
false gate failure:

- **An array with no element type.** `responseSchema` accepts it and leaves the
  elements unconstrained. ADK runs `schema.setdefault("items", {"type":
  "string"})`, so a `tuple[int, int, int, int]` arrives as four **strings**, the
  backend accepts it, and nothing anywhere errors.
- **A multi-member union.** `["string","integer"]` reaches the model as
  `STRING`; the integer branch is discarded with no error. `anyOf` survives that
  conversion intact, so `--to gemini-client` rewrites to `anyOf` — losslessly,
  with any `null` member kept *inside* the `anyOf` rather than on a sibling
  `nullable` that would be dropped.

The same file through all three, verified end-to-end:

| input | nullability | element type | union members | direct to `responseSchema` |
|---|---|---|---|---|
| raw | kept | **string (invented)** | **1 of 2** | rejected |
| `--to gemini` | **lost** | integer | both | **accepted** |
| `--to gemini-client` | kept | integer | both | rejected *(by design)* |


## A root with no `type` is rejected, and one framework produces it by accident

OpenAI strict mode tests the **root** with a literal `type === "object"`
comparison — not the properties-presence test its *nested* object rules use.
Measured on `openai@7.4.0`'s `toStrictJsonSchema()`, every typeless root throws
`Root schema must have type: 'object' but got type: undefined`, **including**
`{"properties": {...}, "required": [...]}`, which is an object in every sense but
the declared one. Anthropic agrees on both of its paths: `betaTool()` and
`betaJSONSchemaOutputFormat()` (`@anthropic-ai/sdk@0.116.0`) each throw
`JSON schema ... must be an object, but got undefined`. Gemini does **not** —
`google-genai==2.17.0`'s `types.Schema` accepts a typeless root and even a bare
`{}` — so this is a blocker on OpenAI and Anthropic and deliberately nothing on
the three Gemini targets.

The two cases are treated differently, because what matters is what the root has
*left* once the missing `type` is supplied:

| root | verdict |
|---|---|
| declares `properties` | **fixed** — `type: "object"` added; lossless |
| declares nothing | **blocked** — adding `type: "object"` is *also* accepted, and leaves an object whose only legal value is `{}` |

A rootless root is not hypothetical. `llama-index-core==0.14.23`'s
`ToolMetadata.get_parameters_dict()` filters a Pydantic schema down to exactly
five top-level keys — `type`, `properties`, `required`, `definitions`, `$defs` —
so for a `RootModel` tool it **keeps the definition bag and drops the pointer
into it**:

```python
class Inner(BaseModel):
    x: int
class RootRef(RootModel[Inner]):
    pass
# pydantic  -> {"$ref": "#/$defs/Inner", "$defs": {...}, "title": "RootRef"}
# llama-index -> {"$defs": {...}}          # the $ref is gone
```

Measured end to end: the *raw* Pydantic schema is `ACCEPT`ed by
`toStrictJsonSchema()` (it inlines the root `$ref`), and the schema llama-index
actually sends `THROW`s. The same filter drops a root `anyOf` (so
`RootModel[Union[A, B]]` loses the whole union), a root `items` (so
`RootModel[List[int]]` becomes `{"type": "array"}` with no element type), and any
top-level `additionalProperties: false` you set with `ConfigDict(extra="forbid")`.

### The classifier that hid it

`llm-json-schema` accepts either a schema or an example JSON object and infers a
schema from the latter. That decision used to be an eight-key test — `type`,
`properties`, `$schema`, `$ref`, `anyOf`, `oneOf`, `allOf`, `enum`. JSON Schema
has roughly forty root-legal keywords, so `{"$defs": {...}}` matched none of
them, was classified as **data**, and came back as a schema describing the
document's own syntax — which `toStrictJsonSchema()` accepts verbatim, because it
is a perfectly valid schema. It is just about the wrong thing. Nineteen of
nineteen root-keyword-only schemas were misclassified.

The rule is now: every root key must be a JSON Schema keyword, **each keyword's
value must have the shape that keyword requires**, and at least one must be an
applicator or validator rather than an annotation. That keeps ordinary data out —
`{"items": [...], "total": 12.5}` has a non-keyword key, `{"items": [1, 2, 3]}`
holds numbers where subschemas belong — and leaves the two genuinely ambiguous
cases (`{"title": ..., "description": ...}` alone, and `{}`) classified as data,
unchanged. The CLI still prints `note: input looked like an example object` when
it infers, and `--mode schema` still forces the other reading.


## An empty collection usually means the opposite, not "less"

For a collection keyword the empty instance is generally not a weaker version of
the non-empty one — it is the **inverse**. A non-empty `enum` narrows the legal
values; an empty one leaves none. A non-empty `anyOf` offers branches; an empty
one offers nothing to match. `not` of a schema that matches everything excludes
everything. Each of those nodes has an **empty set of legal values**, so the
field can never be populated — and every provider accepts the schema as written,
so nothing downstream tells you.

These are not hand-written curiosities. Measured verbatim:

| Source | Output |
|---|---|
| `pydantic==2.13.4`, `class Empty(Enum): pass` | `{"enum": [], "title": "Empty"}` |
| `zod@4.4.3`, `z.enum([])` | `{"type": "string", "enum": []}` |
| `zod@4.4.3`, `z.union([])` | `{"anyOf": []}` |
| `zod@4.4.3`, `z.never()` | `{"not": {}}` |

The usual real cause is an upstream list that filtered down to nothing
(`z.enum(ALLOWED_ROLES)` where `ALLOWED_ROLES` came back empty), not intent. The
tool reports every one of these as an **advisory** — never a gate failure, since
the destination accepts the document.

One case is worse than advisory. `not` is on OpenAI's strip list, and stripping
it is normally a widening we accept: dropping `not: {const: "x"}` re-admits one
value. But when the excluded schema matches everything, removing the keyword
leaves `{}` — **"every value is legal", from a node that meant "no value is
legal."** That is an inversion, not a repair, and it used to be reported as a
routine one-line strip whose output then rechecked clean. `--to openai` now
blocks it (exit 3) and leaves the keyword visible.

Note also what is deliberately *not* flagged: an empty `allOf` is vacuously
**true**, so it matches everything — the exact opposite of an empty `anyOf` —
and `required: []`, `properties: {}` and `prefixItems: []` are merely empty
constraints, not impossible ones.

### Why "the vendor accepted it" was not enough

The value proposition throughout this README is *raw rejected → ours accepted*.
For this bug that metric pointed the wrong way, which is worth stating plainly:

| Schema | `toStrictJsonSchema()` (openai@7.4.0) |
|---|---|
| raw `z.never()` → `{"not": {}}` | **THROW** |
| **old** output `{}` | **ACCEPT** |
| **new** output `{"not": {}}` (blocked, exit 3) | THROW |

The broken behaviour scored as a win and the correct one does not. Acceptance
bought by changing what the schema *means* is not a repair, so for this shape the
honest answer is a blocker: strict mode cannot express an impossible field, and
pretending otherwise hands back a schema that accepts anything.


## The special case was the broken one

`allOf` is handled in two branches: one for a single member, one for N. The
N-member branch merges — the union of every member's `properties` and
`required` — and has always been right. The single-member branch copied the
member's keys with `if (!(k in node))`: **parent wins**.

For annotations that is correct; `title` and `description` on the wrapper are
the wrapper's. For anything carrying constraints it is a deletion. Given

```json
{"type":"object","properties":{"kind":{"type":"string"}},"required":["kind"],
 "allOf":[{"properties":{"a":{"type":"string"}},"required":["a"]}]}
```

the parent already has `properties`, so the member's `properties` and
`required` were dropped and the ledger reported `~ Flattened a single-member
allOf … Nothing is lost.` What was actually lost was the whole point of the
node. The accept set did not merely shrink, it **inverted**: `{"kind":"k","a":"x"}`
was legal and became illegal, `{"kind":"k"}` was illegal (the `allOf` required
`a`) and became legal.

The severity is not that this bought bad acceptance — it is that it bought
*nothing*. `toStrictJsonSchema()` **accepts this input as written** and returns
`{"properties":{"kind":…,"a":…},"required":["kind","a"],"additionalProperties":false}`,
merging `a` in. So the tool took a schema the destination already accepted and
silently deleted a constraint from it. There was no 400 to avoid.

The fix is to stop treating one member as a special case. Measured verdicts,
each pinned as a test:

| shape | vendor | this tool |
|---|---|---|
| member declares `properties`, parent has its own | merges both | merges both |
| same property name, **identical** subschema | accepts | merges, no blocker |
| same property name, **different** subschema | throws | blocker |
| member is a bare `$ref`, parent has only annotations | accepts, `$ref` beside metadata | unchanged |
| member is annotation-only | keeps the annotation | keeps the annotation |

That fourth row is the guard that matters most in practice: it is the standard
`pydantic==1.10.22` output for a referenced model with a field description —
`{"title":…,"description":…,"allOf":[{"$ref":"#/definitions/Inner"}]}` — which
has nothing to merge and must come out untouched. Note that current Pydantic
(2.13.4) emits `$ref` with a sibling `description` instead and never produces
this shape at all, and neither zod 3 + `zod-to-json-schema` nor zod 4's native
`z.toJSONSchema()` emit a single-member `allOf`. So the deleting shape is a
hand-authored / OpenAPI-composition idiom rather than something the common
generators hand you — which is most likely why it survived this long.


## License
MIT.
