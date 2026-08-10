# LLM JSON Schema

Turn a JSON Schema (or a JSON example) into a **provider-correct** LLM structured-output schema for **OpenAI**, **Anthropic**, and **Gemini** — and explain/fix schemas a provider rejected.

Available three ways, all running the same dependency-free engine:

| | |
|---|---|
| **CLI / CI gate** | `npx github:percymcn/llm-json-schema --to openai schema.json` |
| **Library** | `import { toOpenAI } from "llm-json-schema"` — ESM, CJS, and TypeScript types |
| **Web (no install)** | https://percymcn.github.io/llm-json-schema/ |

> Status: **v0.1**. Unit-tested: 1152 engine + 258 CLI + 42 ESM/library assertions = **1452** (`npm test`). Provider rules are verified against each vendor's own SDK, not its docs — the docs list the *supported* subset, the SDK encodes the *accepted* one, and they differ.
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


### A `$ref` beside constraining siblings is an intersection

`{ "properties": {"a": …}, "required": ["a"], "$ref": "#/$defs/Base" }` does not
mean "Base, decorated". In draft 2020-12 the referent **and** the siblings both
apply, so it means "declares an `a` **and** satisfies Base" — the same
intersection `allOf` spells differently. We implemented it as an *overwrite*,
so the referent's `properties` and `required` were silently discarded.

Measured on one nested shape whose raw accept set requires both `a` and `b`,
across all ten targets: three forwarded it untouched and were right; six emitted
a schema where `b` was no longer typed or required; `gemini-json` dropped the
node's own `a` instead. Three different wrong answers, none of them either
dialect's reading, all at zero blockers. All ten now preserve the accept set
exactly, and a required name that a closed side forbids is a **blocker** —
there is no repair, so the remodelling is named instead.

The same blindness made the `allOf` spelling fail the gate: a `$ref` *member*
declares no `properties` of its own, so the mergeability test could not look
through it and blocked. `{properties: {...}, allOf: [{$ref: Base}]}` and
`{allOf: [{$ref: Base}, {...}]}` — the standard "extend a base schema" idiom —
are **accepted** by `toStrictJsonSchema()` with the merged property set, and we
failed CI on them. `$ref` members are now resolved before the merge, but only
where the node itself constrains: a bare `{allOf: [{$ref}]}` and the Pydantic v1
`{description, allOf: [{$ref}]}` still come out as a `$ref` beside annotations,
which is the form the vendor accepts.

**…and the root is the same node.** The fix above landed at nested positions and
left the root running the old referent-wins carry-over — a gap recorded at the
time and measured now. On the identical shape at the root, whose raw accept set
again requires both `a` and `b`, **four of ten targets** (`openai`, `anthropic`,
`anthropic-json`, `anthropic-go`) dropped the node's own `a` and stopped
requiring it, silently, at zero blockers — while the same schema one level down
was already correct. **The two positions disagreed with each other about one
logical schema**, which is the tell that a position, not a dialect, was the
variable. All ten now emit the raw accept set at both positions.

Annotation-only siblings deliberately keep the old path: precedence is correct
for annotations, and `{$ref, $defs, title}` — what Pydantic's `RootModel` emits
(measured, 2.13.4) — is the commonest root shape there is, so it stays
byte-identical. The reachable population for the constraining form is
hand-authored and OpenAPI-composition schemas; the reason to fix it anyway is
that the failure is a silent accept-set change in a CI gate.

Reachability, stated at its true strength: neither pydantic 2.13.4, pydantic
1.10.22, zod 3 + `zod-to-json-schema@3.24.5` nor zod 4 emits a constraining
`$ref` sibling — pydantic renders a described reference as `{$ref, description}`
(annotations only) and zod inlines. So the population is the same hand-authored
/ OpenAPI-composition one where closing a schema and composing it are both
ordinary. The reason to fix it anyway is that the failure is a silent
accept-set change in a CI gate.

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
### A remedy is only as true as the client that has to carry it

`--to gemini-json` tells you which keywords that path does not enforce, and
offers a remedy: switch to the narrow `responseSchema` path, which *does*
enforce `pattern`, `minLength`, `maxLength`, `min`/`maxProperties`, `default`
and `example`.

That sentence is about **Gemini**. Whether it is about **you** depends on your
client, and for the dominant JS route it is false. `@ai-sdk/google` does not
forward your schema on the narrow path — it rebuilds the request with
`convertJSONSchemaToOpenAPISchema`, which destructures a fixed twelve-keyword
list (`type`, `description`, `required`, `properties`, `items`, `allOf`,
`anyOf`, `oneOf`, `format`, `const`, `minLength`, `enum`) and silently drops
everything else. Measured against the real wire payload on 4.0.39, of the seven
keywords that remedy names **exactly one — `minLength` — arrives**. The switch
also costs `minimum`, `maximum`, `minItems` and `maxItems`, which the
`responseJsonSchema` path *does* enforce, so on that client it is strictly
worse.

So the tool states the remedy and then names the fork, per keyword, rather than
guessing which client you are on. A REST-direct caller, or Python
`response_json_schema=`, is unaffected and the remedy holds as written.
`AI_SDK_GOOGLE_FORWARDED_KEYS` is exported so the table can be re-diffed after a
version bump; the suite is dependency-free and cannot run `@ai-sdk/google`, so
it pins a **measured snapshot**, and re-measuring is a manual step.

- **OpenAI Structured Outputs (strict):** `additionalProperties: false` on every object; every property in `required` (optionals become nullable); root must be an object, not `anyOf`. Its keyword set is an **allowlist** — *"if you turn on Structured Outputs … and call the API with an unsupported JSON Schema, you will receive an error."* The error is raised for keywords whose validation semantics strict mode cannot compile (`uniqueItems`, `patternProperties`, `propertyNames`, `min`/`maxProperties`, `contains`, `not`, `if`/`then`/`else`, `dependentRequired`, `prefixItems`, …). Annotations and soft constraints — `description`, `title`, `default`, `examples`, `minLength`/`maxLength`, `pattern`, `format`, `minimum`/`maximum`, `multipleOf`, `$schema`, `$id` — are **accepted and passed through untouched**, so this tool leaves them alone.

  Three rules here are *conditional*, and a flat "is this keyword allowed?" list gets all three wrong:
  - **`oneOf`** is rewritten to `anyOf` **only when the branches are provably mutually exclusive**. `oneOf` means exactly one branch matches and `anyOf` means at least one, so rewriting an overlapping union silently widens it. `openai@7.4.0`'s `helpers/standard-schema.js` proves exclusivity first and otherwise throws: *"OpenAI strict schemas do not support `oneOf`; use `anyOf` or add a discriminator with distinct literal values."* We follow that rule and flag the unprovable case instead of guessing. (Note the vendor's own two helper families disagree: the five `helpers/zod.js` builders run `toStrictJsonSchema()` alone, which passes a non-exclusive `oneOf` straight through to the API.)
  - **`allOf`** is **not** flatly unsupported. An `allOf` of *open* object schemas is merged — the union of their `properties` and of their `required` — and **a single member is not a special case: it takes the same merge.** Measured on `openai@7.4.0`, `{"properties":{"kind":…},"required":["kind"],"allOf":[{"properties":{"a":…},"required":["a"]}]}` comes back carrying **both** `kind` and `a`. (This tool used to read "flatten a single member" as "keep the wrapper's annotations and let the parent win", which silently *deleted* the member's `properties` and `required` whenever the parent had its own — see the note below.) Only closed-object members (*"cannot be merged without changing Draft 7 validation"*), a property name declared on both sides with **different** schemas, and multi-member non-object `allOf` throw; a name declared on both sides with an **identical** schema merges fine. `{"allOf": [{"$ref": …}], "description": …}` — the standard Pydantic output for a referenced model with a field description — is therefore perfectly valid, and stripping it would delete the whole subschema.
  - **`$id`** is legal at the **root** and fatal **anywhere else** (*"Nested $id … establishes a separate JSON Schema resource scope"*). Likewise `"type": "array"` is legal but fatal without `items`.

  **All of that is conditional on `strict: true`, which is optional and off by default** — so `--to openai` is the right target only if you actually set it.

  **But "`strict` is not set" does not mean the same thing on every surface.** Enumerating *every* `strict` declaration in `openai@7.4.0`'s `resources/**` with its enclosing interface and doc comment gives **eight sites in three groups**, and they disagree about what omitting the flag does:

  | What omitting `strict` means | Sites | Interfaces |
  |---|---|---|
  | **Nothing is enforced.** Doc only ever describes the true branch: *"If set to true, the model will follow the exact schema."* | 4 | `FunctionDefinition`, `ResponseFormatJSONSchema.JSONSchema`, `ResponseFormatTextJSONSchemaConfig`, `BetaResponseFormatTextJSONSchemaConfig` |
  | **The service auto-negotiates.** Doc, verbatim: *"If omitted, Responses attempts to use strict validation when the schema is compatible, and falls back to non-strict validation otherwise."* | 2 | `NamespaceTool.Function` (**stable**), `BetaNamespaceTool.Function` |
  | **There is no omitted state** — the field is required (`strict:`, not `strict?:`), so a caller there passed `false` or `null` on purpose. | 2 | `FunctionTool`, `BetaFunctionTool` |

  Realtime is a fourth case and has no `strict` field anywhere — that is what `--to openai-realtime` selects.

  The consequence worth knowing: **on namespace tools the fallback is silent.** If your schema is not strict-compatible you do not get an error, you get an unenforced schema. Exported as `OPENAI_STRICT_SURFACES` so the grouping is one command to re-diff rather than a re-derivation.

  - **`--to openai-nonstrict`** — `strict` absent or false. The subset does not apply: your schema is sent as plain JSON Schema, so nothing is stripped, nothing is forced into `required`, and tuples survive. On the four "nothing is enforced" surfaces the model is **not** grammar-constrained, so every constraint is guidance it can violate — validate the response yourself. On namespace tools it may well be enforced; run `--to openai` to find out whether your schema is strict-valid as written. **The tool deliberately does not predict which branch you land on** — measured across 528 captured schemas, our own ledger ops are not a sound proxy for the vendor's compatibility test (a rewrite covers both a lossless `definitions`→`$defs` rename and a real `optional`→`required`+nullable repair), and the service's exact notion of "compatible" is not observable without an API key.
  - **`--to openai-realtime`** — the same dialect, for the surface where it is not a choice: `RealtimeFunctionTool` has no `strict` field at all.

  **Some clients decide this for you.** [Instructor](https://github.com/567-labs/instructor) omits `strict` on *every* OpenAI path — `Mode.TOOLS` (the default), `Mode.JSON_SCHEMA`, and `Mode.TOOLS_STRICT`, which is deprecated and collapses to `Mode.TOOLS`, so asking for strict silently gets you non-strict. Measured on `instructor==1.15.4`: no `strict` key in any of the three payloads. Gating those against the strict rules fails CI on a schema the API accepts as written.
- **Anthropic also has TWO paths, and nothing in the schema tells you which one you are on** (verified against `@anthropic-ai/sdk@0.116.0`). Because of that, each is its own target. *A caveat this README got wrong until Cycle #367: the switch is **not** simply "which request field you use" — reaching the structured-output field does not by itself mean the transform runs. See [When the Anthropic transform actually runs](#when-the-anthropic-transform-actually-runs).*
  - **`--to anthropic` → `tools[].input_schema`** — no client-side transform at all. Your JSON Schema is attached verbatim; the only check is that the root is `type: "object"`. Tuples, `maxLength`, `format`, a draft-07 `definitions` bag and a non-exclusive `oneOf` all survive untouched, so this target reports them as fine rather than "fixing" them. `strict: true` goes on the **tool**, not the schema — the SDK documents it as *"guarantees schema validation on tool names and inputs"*; without it the schema is guidance the model can violate.
  - **`--to anthropic-json` → the structured-output path** (`output_format` / `output_config`: `{ type: "json_schema" }`) — `lib/transform-json-schema.js` rebuilds the schema from a small allowlist, and **anything it doesn't recognise is `JSON.stringify`'d into that node's `description`** — *when it runs*; see below.
  - **`--to anthropic-json-python`** — the same path, as implemented by the **Python** `anthropic` SDK, which is not the same program. This split is by **SDK language, not version**: `anthropic==0.116.0` and `@anthropic-ai/sdk@0.116.0` carry the same version string and disagree, so it is not a skew you can upgrade past.

  - **`--to anthropic-go`** — `github.com/anthropics/anthropic-sdk-go`, and it is a **third** implementation, not an alias of either. Pick it for **any** use of that SDK, tools included: Go is the one language where `tools[].input_schema` is *not* verbatim, because `BetaToolInputSchema` calls the same `transformSchemaMap` as `BetaJSONSchemaOutputFormat` (`schemautil.go`). Measured identical output from both helpers on all 19 shapes probed, on `v1.62.0`.


### When the Anthropic transform actually runs

`--to anthropic-json` is named for a **condition** — "you are on the structured-output
path rather than the tools path". Reaching that path does **not** by itself mean the
demote-to-prose rewrite happens. Measured 2026-08-10 on `@anthropic-ai/sdk@0.116.0`
and `anthropic==0.121.0`:

| how you hand the schema over | transform runs? |
|---|---|
| TS `jsonSchemaOutputFormat(schema)` / `betaJSONSchemaOutputFormat(schema)` | **yes** |
| TS the same two with `{ transform: false }` | no |
| TS `zodOutputFormat(z)` / `betaZodOutputFormat(z)` (no opt-out) | **yes** |
| TS inline `{ type: "json_schema", schema }`, no helper | no |
| PY `output_format=<pydantic type>` (deprecated parameter) | **yes** |
| PY `output_format=<dict>` (deprecated parameter) | no |
| PY `output_config={"format": <dict>}` (**recommended** parameter) | no |

In TypeScript, `transformJSONSchema` has exactly **four call sites and every one is a
helper** — it is never called from the request path, so an inline object (type-legal
under `--strict`, verified with `tsc`) is sent verbatim. In Python the transform *is*
in the request path (`parse`/`stream`/`count_tokens`) but sits behind
`if is_dict(output_format):`, which casts a plain dict through untouched; only a
pydantic **type** is transformed.

The sharp part: `output_format` is `@deprecated` in favour of `output_config.format`
in both SDKs, and `output_config.format` **never** transforms — it takes a dict on
every method and rejects a model outright. So following the SDK's own
`DeprecationWarning` moves a Python caller off the only demoting form.

The tool cannot see your call site, so it does not guess: it reports the demotion
**with the condition attached** and tells you which list to check yourself. Both
branches are advisory and never fail `--check` — the request is accepted either way.
`--to anthropic-go` deliberately keeps the categorical claim, because [both of Go's
helpers run the transform](#anthropic-ships-three-sdks) and it has no verbatim form.

Two honest limits. "Verbatim" is a claim about the **client** — whether the service
then enforces the keyword is not observable without an API key ([a client is not the
service](#a-client-is-not-the-service)). And the table is a measured snapshot of two
versions; it is exported as `ANTHROPIC_TRANSFORM_SURFACES` so it can be re-diffed
rather than re-derived, but re-measuring after a version bump is manual.


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
  | typed catchall (`properties` **and** `additionalProperties`) | value schema deleted, forced `false` | value schema deleted, forced `false` | value schema deleted, forced `false` |
  | typeless node | throws | throws | **replaced by the literal `true`** |
  | map-by-`patternProperties` / `propertyNames` (no `properties`) | emptied to `{}` | emptied to `{}` | emptied to `{}` |
  | open map whose **value schema** is typeless | map emptied (value never read) | map emptied (value never read) | **map kept, value schema replaced by `true`** |

  Those last-but-two rows are worth reading together, because the same condition decides both and it points opposite ways. Go's `transformSchema` has an explicit dictionary clause, which is why a plain open map survives there when the other two SDKs destroy it — but that clause only fires when the node has **no** `properties`. Add one declared property, as `z.object({...}).catchall(...)` does, and Go joins the other two: the value schema is thrown away and `additionalProperties` is forced to `false`. So the map is 2-1 and the catchall is 3-0, decided by "does this node declare properties?" — the same question our own open-map rule asks, answered the other way round.

  **The last row is where "preserved and recursed" turns out to be two claims, and only the first one is always true.** Go's dictionary clause really does keep the map — and then it recurses into the value schema, which runs that value through the same bail every other node goes through: no `type`, and nothing (`anyOf`/`allOf`/`enum`/`const`) to stand in for one, and `transformSchema` overwrites the node with the zero `jsonschema.Schema`, which invopop marshals as the literal JSON `true`. So the map survives with its value type deleted, and you get `additionalProperties: true` — every key legal, every value legal. Measured 2026-08-10 on `anthropic-sdk-go@v1.62.0`, on both the `output_format` and the tools surface (Go has no verbatim path).

  This is reachable from the dominant JS generator without trying: `z.record(z.string(), z.never())` on zod@4.4.3 emits `additionalProperties: {"not":{}}`, a map that admits **no** value at all, and Go returns a map that admits every value — a complete inversion. The reason it survived is that the vendor's output for the destroyed case is **byte-identical** to its output for a genuinely unconstrained map (`z.record(z.string(), z.unknown())` emits `additionalProperties: {}`, and `{}` and `true` are the same schema), so nothing downstream can tell a correct rendering from a destroyed one. `--to anthropic-go` reports it as an advisory (never a gate failure — the vendor does the destroying and the request returns 200); the value schema is left in our output rather than stripped, so the remedy is actionable. The TypeScript and Python `output_format` transformers are unaffected because they empty the map itself and never look at the value schema at all, and `--to anthropic` keeps it verbatim.

  **And that recursion does not stop at the value schema — which is the part the sentence above used to be quietly wrong about.** "Recurses into the value schema" was offered as the reassurance, and it is also the mechanism: `transformSchema` keeps descending from there, into that value's `properties`, its `items`, its `anyOf` branches and any further maps below, applying the same bail at every node. So a *well-typed* map value does not protect what is underneath it. `z.record(z.string(), z.object({ x: z.never() }))` — zod inlines the value model directly under `additionalProperties` — comes back as `{"additionalProperties":{"type":"object","properties":{"x":true},...}}`: the map is fine, the value object is fine, and `x`, which admitted no value, now admits every value. Measured three levels deep and through a second map edge.

  Nothing in this tool used to look there, because `walk()` — the shared walker every rule runs on — has no `additionalProperties` arm at all. The rule above read exactly one level through that edge and then printed a reassurance about the rest. Rather than widen the shared walker (which would fire ten targets' rules in a position only Go reads, and owes a re-probe of each), `--to anthropic-go` now mirrors `transformSchema`'s own recursion clause for clause: `anyOf`/`allOf` unconditionally and before the bail; nothing below a node that itself zeroes out; `properties` values when the object declares any, and `additionalProperties` **only** when it does not; object-form `items` for arrays; and nothing at all below a union-typed node, since Go's `Type` is a string and a union takes the whole document to `null` anyway. A node the SDK will overwrite is a **blocker**, matching what the identical node already gets in a position the walker reaches — the two positions used to disagree about the same defect. Pydantic is not affected: `Dict[str, Model]` routes the value model out to `$defs`, which `walk()` already reaches, so the existing rule owns it and reports it exactly once.

  Worth noting that the Go SDK already knows about this hazard in one position: `transformSchema` prunes any `anyOf` variant that zeroes out, with a comment reading *"a zero `jsonschema.Schema` marshals as the literal JSON `true`, which would otherwise leak into the variant list as a match-everything."* The guard is correct and it is applied to exactly one container.

  That shape is the quieter of the two, which is why it is worth flagging at all: an emptied open map at least *looks* broken afterwards, whereas here the declared properties come through untouched and only the extra keys change — they stop being accepted, and whatever they were required to look like is gone. Nothing raises. `--to anthropic-json`, `--to anthropic-json-python` and `--to anthropic-go` all report it as an advisory (never a gate failure — the request returns 200), and `tools[].input_schema` (`--to anthropic`) keeps it verbatim.

  **The last row is the same emptying reached through a keyword that never looked like a map.** `additionalProperties` is only one of four ways JSON Schema says "this object admits a key"; `patternProperties` and `propertyNames` are two more, and Go's dictionary clause keys on the first, so it rescues nothing here — measured 2026-08-10, this row is **3-0**. What makes it worth its own rule rather than folding into the generic demote-to-prose note is the direction of the change. Demotion normally *widens*: the keyword stops being enforced and the field keeps working, which is exactly what happens when the node also declares `properties`. When one of these keywords is the node's **only** way of admitting a key, demoting it and then forcing `properties: {}` + `additionalProperties: false` leaves an object whose only legal value is `{}` — the field can never be populated. Two individually reasonable steps, one inversion, and the prose framing hides it: "the model is told about it but nothing validates it" is true of the keyword and false of the field.

  This is reachable from an ordinary generator, and only through one of the spellings: `pydantic` 2.13.4 renders `Dict[Annotated[str, StringConstraints(pattern=r'^S_')], str]` as `{"type": "object", "patternProperties": {…}}` with **no** `additionalProperties` key at all. `zod` 4.4.3's `z.record()` emits `propertyNames` *and* `additionalProperties`, so it is an open map and the row above already covers it — `propertyNames` alone is a hand-authored / OpenAPI shape, not something either dominant generator produces. One Go-only wrinkle: `unevaluatedProperties` is dropped there with no prose at all, because invopop's `Schema` models `patternProperties` and `propertyNames` but has no field for it, so `encoding/json` discards it before Anthropic's transform can demote it.

  Two of those Go rows are not "unsupported", they are total loss, and they share a cause worth knowing: `transformSchemaMap` round-trips your map through `invopop/jsonschema.Schema` and `return nil`s on **any** unmarshal error, swallowing it. That struct types `Type` as a `string` and `Items` as a `*Schema`, so an array in either field — anywhere in the document, including inside `$defs` — silently discards everything. Both helpers then hand the API a null schema with nothing raised client-side.

  A third Go-only distinction: "unsupported" hides **two** severities. A keyword `invopop` *models* but Anthropic does not list (`minLength`, `uniqueItems`, `default`, `not`, `contains`, …) is demoted to `description` prose. A keyword `invopop` does not model at all (`unevaluatedProperties`, `additionalItems`, `discriminator`, `x-*`, `definitions`) is dropped by `Schema.UnmarshalJSON` — a plain alias unmarshal with no catch-all — **before** Anthropic's transform runs, so it cannot be appended to any description and vanishes without a trace.

  Both tables behind that three-way split are exported (`ANTHROPIC_GO_SUPPORTED_KEYS`, `GO_INVOPOP_MODELLED_KEYS`) and diffed against the vendor **in both directions** in the test suite, against a fate — kept / demoted / dropped — measured by running all 53 keywords through `BetaJSONSchemaOutputFormat` on `anthropic-sdk-go@v1.62.0`. The forward direction is the cheap half; the complement is the one that catches a key we invented. Honest limit: the suite is dependency-free and cannot run Go, so this pins the tables against a **measured snapshot**, and re-measuring after a vendor bump is a manual step.

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

  So the previous behaviour deleted a constraint the destination would have accepted, and for a discriminated union the node is often *nothing but* the union — `{"title":"Pet","oneOf":[…]}` came out as `{"title":"Pet"}`, which the backend then accepts happily while constraining nothing. `--to gemini` now **keeps** all three and says what happens next, because that depends on your client and not on your schema: `@google/genai` (JS) forwards them verbatim and the call goes through; `google-genai` (Python) raises locally, since `types.Schema` is `extra="forbid"`; the Go client has no such field, so `encoding/json` **drops it with `err == nil`** — `{"oneOf":[…]}` unmarshals to `{}`. It is an advisory, never a gate failure: the destination accepts the document, so failing CI on it would be wrong. `--to gemini-client` **also keeps them** — it used to strip them on the premise that "a converting client rebuilds the request from its own `Schema` type and no client declares them", which is false for `@ai-sdk/google` (it declares no `Schema` type at all and forwards `oneOf`/`allOf` explicitly); see the Gemini-targets section below.

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
| `anthropic-json-python` (Py `output_format`) | **rejected** — `TypeError: 'bool' object is not a mapping` | `transform_schema`, `anthropic==0.121.0` |
| `anthropic-go` | kept verbatim on **both** surfaces | `anthropic-sdk-go@v1.62.0` |
| `gemini` (narrow `responseSchema`) | **rejected** — `types.Schema` is `extra="forbid"` | `google-genai==2.17.0` |
| `gemini-json` (`responseJsonSchema`) | legal — ordinary JSON Schema | — |

So this is the fourth thing Anthropic's three SDKs disagree about — 2-1 rather
than a three-way split, with Go the permissive side. The Python row was measured
later than the rest, and until it was, this tool gave the *same bytes* opposite
verdicts on `--to anthropic-json` and `--to anthropic-json-python`.

The Python client does not descend two keywords, and they are treated
differently on purpose:

- **`not`** — demoted to `description` prose wholesale, so a boolean anywhere
  beneath it is accepted. Not blocked. (`--to anthropic-json` still blocks it,
  so the same file legitimately gives 3 on TypeScript and 0 on Python.)
- **`prefixItems`** — also demoted, so the *input* is safe. It is blocked
  anyway, because the question is what **our output** contains: the
  homogeneous-tuple collapse rewrites `prefixItems: [true]` into `items: true`,
  moving the boolean into a slot the vendor does reject. Same keyword class,
  opposite answers, decided by whether this tool moves the node.

That gap is now closed, and closing it turned out to be a different rule — see
below.

## A container holding the wrong kind of thing, and the silence it caused

A boolean standing in for the `$defs` **bag itself** (`{"$defs": true}`) used to
exit 0. It is not a boolean subschema at all: `$defs` is not a schema position,
its value must be an *object of schemas*, so `true` there is a malformed
keyword — a different defect with a different remedy.

The cause is general. Every descent guard in this engine is a **type test** —
`if (isPlainObject(node[bag]))`, `if (Array.isArray(node[kw]))` — so a keyword
holding the wrong type reads exactly like a keyword that **isn't there**: the
subtree is skipped in silence, and the tool then answers *"Already valid. No
changes needed."* That is an affirmative claim derived from having looked at
nothing. It is the same asymmetry as a keep-rule reading *"I could not find a
reference to this"* as *"nothing references this"*, now on the descent side.

The shape table needed to catch it already existed — it was written to decide
*"is this pasted JSON a schema or an example?"*, was consulted only at the
**root**, and was skipped entirely by a fast path whenever `type` or
`properties` was present. It had never been asked the question it is shaped to
answer one level down.

Measured against the vendor clients on 2026-08-09, they disagree and **two of
them do not complain**:

| client | `{"$defs": true}` and friends |
|---|---|
| `anthropic-sdk-go` v1.62.0 | **whole document** comes back `schema: null`, request built anyway (15 of 17 probed shapes) |
| `anthropic` 0.121.0 (Python) | `transform_schema` **raises**, request never built (5 shapes) |
| `@anthropic-ai/sdk` 0.116.0 | `betaJSONSchemaOutputFormat` **throws** (3); `betaTool` forwards **all** verbatim |
| `openai` 7.4.0 | `toStrictJsonSchema` **accepts** `$defs: true` and `properties: true` |

So this **blocks on every target**, and the justification is deliberately not
vendor tolerance — it is a statement about *our own* analysis being uninformed.
Being accepted is not being honoured: a constrained decoder cannot use a
`properties` that is a boolean. No repair is possible (nothing can recover what
`properties: true` was meant to say), so the blocker names the fix instead.

Two things it deliberately does **not** do, both forced by running the rule over
the tool's own captured corpus before trusting it:

- **Empty is not malformed.** `items: []`, `anyOf: []`, `allOf: []`,
  `properties: {}`, `patternProperties: {}` are the right *kind* of thing and
  are legal. Keying the rule on the stricter "is this a non-empty map/array of
  valid schemas?" predicate blocked **24 real captured inputs** and would have
  deleted four cycles of measured behaviour.
- **Only subschema-bearing positions.** `exclusiveMaximum: true` is malformed
  too, but nothing is skipped and no verdict is uninformed. `required: "a"`,
  `enum: {}`, `type: 5` and `format: null` are measured and deliberately left
  out of this rule for the same reason.

Over-block risk is measured, not asserted: across 3,770 (input, target) pairs
from the tool's own corpus, **0** real generator or framework payloads are
flagged, and **0** clean inputs are turned into malformed output by any of the
ten converters.

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
- `engine.test.js` / `cli.test.js` / `esm.test.mjs` — 1452 assertions total. Run: `npm test`. The fixtures are the actual schemas from real reported failures and verbatim `zod-to-json-schema` / `z.toJSONSchema()` output, so a regression means the tool stopped fixing a bug people genuinely hit. Every provider is asserted **idempotent** — a `--check` gate that flagged its own output would be unusable in CI. When you pass an *example* rather than a schema, the suite also asserts the **round trip**: the inferred schema must accept the very document it was inferred from, across 27 shapes and every JSON-Schema-dialect target. A conversion may narrow below your example only if it says so in the ledger — strict mode does exactly that, because it has no optional fields. (`--to gemini` is excluded from that check on purpose: its output is a Gemini `Schema` proto message, not JSON Schema.)
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
converts it for you, the proto's *constraints* still apply, because that library
cannot send what the proto has no field for, but its *spellings* are the JSON
Schema ones.

**"Converting client" is a class, and its members disagree.** That is worth
saying out loud, because for several releases this target was named for the
class and encoded exactly one member of it — `google-adk`. Measured 2026-08-10,
each keyword on a node of the right shape and beside a `description` control
that must survive, `@ai-sdk/google` read from the real wire payload via an
intercepting `fetch` rather than from its source:

| keyword | `google-adk` 2.6.3 | `agno` 2.8.7 | `litellm` 1.96.0 | `@ai-sdk/google` 4.0.39 | `@langchain/google-genai` 2.2.0 |
|---|---|---|---|---|---|
| `oneOf` | dropped — node emptied | dropped — emptied | dropped — emptied | **forwarded** | **forwarded** |
| `allOf` | dropped — node emptied | dropped — emptied | dropped — emptied | **forwarded** | **forwarded** |
| `not` | dropped | dropped | dropped | dropped | **forwarded** |
| `{"type":["string","null"]}` | → `{STRING, nullable}` | → `{STRING, nullable}` | → `anyOf:[string,null]` | → `{anyOf:[string], nullable}` | **forwarded verbatim** |
| `{"type":["string","integer"]}` | → `STRING`, **integer lost** | → `STRING`, **integer lost** | → `anyOf`, both kept | → `anyOf`, both kept | **forwarded verbatim** |
| hand-written `nullable: true` | **dropped** | **dropped** | kept | **dropped** | kept |

The combinator rows settle the keep decision against five members rather than
two: every client that drops `oneOf`/`allOf`/`not` drops it *itself*, so keeping
it costs those callers nothing (our output is byte-identical to stripping for
them) and buys the forwarders an entire union.

**The nullability rows have no intersection form at all.** Three clients rewrite
`type:["X","null"]` into `nullable` themselves *and* drop a hand-written
`nullable`, so they need the union spelling. `@langchain/google-genai` performs
no rewrite — it strips only `$schema` and `additionalProperties` and assigns the
rest straight to `responseSchema` (`chat_models.js:676`), where the proto
rejects a list-valued `type` outright. `litellm` takes either. No single
document satisfies all five.

This target keeps the **union** spelling, and the reason is the shape of the
harm rather than a head count: for a forwarding client the union produces a
**loud 400** the caller can act on, while emitting `nullable` would make three
clients drop the null constraint **silently**. So the output does not change and
the *diagnosis* forks — the note names `@langchain/google-genai`, gives the
proto's own rejection text, and states the check to run against your own call
site: **if your client hands your document to `responseSchema` without
rebuilding it, you want `--to gemini`,** whose output carries `nullable`
instead. It stays advisory, never a gate failure: which client is calling is a
fact only you have, and blocking would be a false CI failure for four of five.

That reframe is the useful part. A *forwarding* client is not a converting
client — it is transparent, so its document has to satisfy the narrow proto
directly, which is what `--to gemini` has always produced. The class this target
really models is **rewriting** clients; the name is what invited a forwarding
one in, and the single rule that assumes a rewrite is exactly the rule that
broke.

`GEMINI_CLIENT_MEMBERS` is exported so the whole table above is re-diffable
after a version bump.

The `oneOf`/`allOf` rows are where the members disagree, and this target used to
**delete** those keywords for everyone. The asymmetry is what makes that wrong
rather than merely debatable: for `google-adk` the strip bought *nothing* — its
output is byte-identical whether we strip the keyword or hand it over intact,
because it drops the keyword itself — while for `@ai-sdk/google` it destroyed a
union that client forwards and the live `v1beta` proto accepts. A `--check` on
an ordinary discriminated union therefore **failed CI (exit 1)** and offered, as
the fix, an edit that reduced the property to `{"description": "..."}`. It now
exits 0, keeps all three keywords, and reports the fate per client — neither
client *errors* on them, they ignore them, and ignore-means-keep-and-flag is the
same error policy this tool applies everywhere else.

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
| a `$ref` into a local definition | **fixed** — the definition is inlined into the root. Both container spellings resolve: `#/$defs/X` and draft-07 `#/definitions/X` |
| `anyOf`/`oneOf`/`allOf` where **every** branch is `type: "object"` | **fixed** — `type: "object"` added. Lossless: an instance satisfying any branch was already an object, so the accept set is unchanged and the union survives. Measured — `{type: "object", anyOf: [...]}` is accepted by both helpers |
| a combinator with any branch that admits a non-object | **blocked** — adding the type is *also* accepted, and silently deletes that branch. Wrap the union in an object instead |
| declares nothing | **blocked** — adding `type: "object"` is *also* accepted, and leaves an object whose only legal value is `{}` |

The last three rows are why this check is keyed on the **outcome** (does the root
end up with `type: "object"`?) rather than on a list of keywords. The earlier
version asked `!type && !$ref && !anyOf && !oneOf && !allOf` — it named every
keyword that *could* have supplied a type and then excused all of them, so a root
that was nothing but `anyOf` still had no `type`, both helpers still threw, and
`--check --to anthropic` answered **"Already valid. No changes needed."**

That was not an exotic shape. It is the **default output of both dominant
generators**: `zodToJsonSchema(schema, "Ticket")` emits
`{"$ref": "#/definitions/Ticket", "definitions": {…}}`, and Pydantic's
`RootModel[Union[A, B]]` emits `{"$defs": {…}, "anyOf": [{"$ref"}, {"$ref"}]}` —
neither with a root `type`. The `$ref` case slipped through for a second reason
worth stating on its own: the root-`$ref` inliner matched only `#/$defs/`, and
the `definitions` → `$defs` rename runs **only on the `output_format` path**. On
the tools path that rename is correctly absent — `betaTool()` forwards a nested
`definitions` bag verbatim, so renaming it would be an edit the destination never
asked for — which left exactly one spelling of one pointer unresolvable.

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

### …and inference itself only read element 0

Once the classifier was right, the inference it hands off to was still reading
`value[0]` and stopping. That reads like a shortcut and is a **narrowing**: the
other elements of the example are, by construction, examples of legal data, so
the inferred schema forbade the very document it was inferred from.

Measured against `ajv` 2020 — the invariant is simply *an inferred schema must
validate the example it was inferred from*:

| example | old `items` | verdict on its own input |
|---|---|---|
| `[1, "a"]` | `{"type":"integer"}` | ❌ `data/vals/1 must be integer` |
| `[1, 2.5]` | `{"type":"integer"}` | ❌ the float is illegal |
| `[null, "x"]` | `{"type":"null"}` | ❌ — and the array can now hold *only* nulls |
| `[{"a":1}, {"a":1,"b":2}]` | first object | ✅ inferred… ❌ after `additionalProperties: false` |

Every one of these was silent: exit 0, no ledger line, and **`toStrictJsonSchema()`
accepts all of them** — a schema that rejects your data is still a valid schema.

Inference now joins across every element: sibling types union (`["integer","string"]`),
`integer` beside a float widens to `number` (`integer` ⊂ `number`), sibling objects
union their `properties` and **intersect** their `required` (a key missing from one
element is demonstrably optional), and a structured element beside a scalar becomes
`anyOf` so neither shape is lost. All six joined forms are `ACCEPT-verbatim` at
`toStrictJsonSchema()` (openai@7.4.0).

Two deliberate non-changes. An **empty** array still gets no `items` and stays a
blocker: no element was seen, so there is no element type, and inventing one is
the failure mode this project has documented elsewhere — a wrong `items` is
accepted everywhere and silently redescribes the data, which is worse than the
error. And the last row above stays ❌ after `--to openai` on purpose: strict mode
has no optional fields, so `b` is forced required-and-nullable, which the ledger
says in as many words.


## A union has two spellings, and the node it sits on decides whether the rewrite is safe

`oneOf` is not representable in OpenAI strict mode, so this tool rewrites it to `anyOf`
whenever the branches are provably exclusive. That rewrite is right in general and wrong
in two places, and both were found by asking a question the test suite had never asked:
**is our own output a fixed point of the vendor's transform?** Being *accepted* is not the
same as being *unchanged*, and a gate that says "commit my output" owes you both.

Measured against `openai@7.4.0`:

| shape | before | after |
|---|---|---|
| root `anyOf` union | blocker (exit 3) | unchanged |
| root `oneOf` union | **exit 1, and the vendor rejected our output** | blocker (exit 3) |
| `{type: "object", …, oneOf: […]}` | **rewritten to `anyOf`, which the vendor then rejected** | `oneOf` kept; advisory, exit 0 |
| `{type: "object", …, anyOf: […]}` | **exit 1, and the vendor rejected our output** | blocker (exit 3) |
| `{type: "object", anyOf: [obj, obj]}` (bare wrapper) | closed, which broke it | redundant `type` dropped, accepted |

Two things make this worth knowing beyond this tool:

**The root check was keyed on one spelling.** It read `if (s.anyOf)` and ran *before* the
walk that turns `oneOf` into `anyOf` — so a root `oneOf` slipped past the check and the walk
then manufactured exactly the root the check exists to catch. In `pydantic` 2.13.4 the two
spellings are one keyword apart: `RootModel[Union[A, B]]` emits a root `anyOf`, and the same
union with `Field(discriminator="kind")` emits a root `oneOf`. Adding a discriminator — the
more precise form, and the one the docs recommend — was what broke the gate.

**OpenAI's two helper families contradict each other.** `toStrictJsonSchema()`, which the five
`helpers/zod` builders use, accepts `{type: "object", …, oneOf: […]}` byte-identical. The
`helpers/standard-schema` builders run `normalizeStructuredOutputSchema()` first, which performs
this very `oneOf` → `anyOf` rewrite, and then their own `toStrictJsonSchema()` throws
*"Object anyOf schema … cannot be represented"*. No single document satisfies both, so the tool
keeps the `oneOf` (valid on the zod path) and says which path it is not valid on, rather than
picking one and calling it fixed.

The vendor's refusal has an escape hatch, mirrored here clause for clause: a bare
`{"type": "object"}` wrapper with no object keywords of its own, whose branches are all
object-only, is accepted — the vendor deletes the redundant `type`. That hatch is easy to close
by accident, because "set `additionalProperties: false` on every object" adds an object keyword.
Two individually correct edits, one rejection. This tool drops the redundant `type` instead,
which is the same edit the vendor makes.

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


## …and the merge it was fixed to use was a union, where the vendor intersects

Fixing the single-member branch to merge left a second, larger question nobody
asked: **is the union the right merge at all?**

An `allOf` is an *intersection*, and a branch that declares
`additionalProperties: false` **forbids every property it does not itself
declare**. So the merged property set is not the union of the branches — it is
that union *restricted to every closed branch's own declarations*. OpenAI's
transformer computes exactly this and says so in a comment
(`lib/transform.js`, "A closed branch forbids every property it does not
declare"), then **refuses the merge outright** when a *required* property falls
outside the intersection, because no object could then satisfy the schema.

We took the plain union, and never looked at any branch's
`additionalProperties` at all: the N-member guard checks the **members'**, and
the single-member path short-circuits past it entirely. Measured on
`openai@7.4.0` across the 16-cell node × member grid at a **nested** position
(root rules contaminate the verdict), with accept sets computed by
`ajv/dist/2020`:

- **Eight** shapes whose raw accept set is **empty** — no object can ever
  satisfy them — came out **satisfiable**, at **zero blockers**, while the
  ledger claimed *"OpenAI's own transformer performs the same merge"*, which
  the same run measures as false: the vendor throws on every one.
- **One** shape the vendor **accepts and preserves exactly** (a closed node
  beside a member declaring a new *optional* property) came out with a
  **different accept set**, because we admitted a property the schema forbade.

Acceptance bought by changing what the schema means is not a repair. So:

| the intersection | what happens now |
|---|---|
| a **required** property falls outside it | **blocker** — no edit preserves the meaning, so the remodelling is named instead of invented |
| an **optional** property falls outside it | **dropped, and reported** — no object could have carried it, so removing it is lossless; keeping it would *widen* the schema. The vendor discards the same names. |
| no branch is closed | **nothing changes** — the plain union is correct, and this rule is a no-op |

That last row is what makes the change safe: the rule cannot fire unless some
branch is closed, so every previously-passing shape is byte-identical. Verified
across the corpus — 544 captured inputs × 10 targets = **5,440 pairs, 0
changed** — with a control proving the differential can detect a change at all.
After the fix our verdict matches the vendor on **14 of 14** cells where the
vendor rules on the merge, and every non-blocked closed-branch case preserves
the accept set **exactly**.

Reachability, stated honestly: `pydantic` 2.13.4 emits `additionalProperties:
false` for `extra="forbid"` but never emits `allOf` — inheritance is flattened
and a described `$ref` field stays a plain `$ref` — and neither zod 3 nor zod 4
emits a single-member `allOf`. So this is the same hand-authored /
OpenAPI-composition population as the section above, where closing a schema and
composing it are both ordinary. That is weaker than "everyone hits this", and
the reason to fix it anyway is that the failure is a **false pass in a CI
gate**: a schema no object can satisfy, silently rewritten into one that looks
fine and that the vendor then accepts.


## When the conversion deletes everything

Each keyword rule in this tool decides one keyword's fate, and each is
individually defensible. Gemini's narrow `responseSchema` proto has no field for
`if`, `contains`, `propertyNames`, `patternProperties`, `dependentRequired` or
`unevaluatedProperties`, so they come out. A library that converts JSON Schema
for you rebuilds the request from its own `Schema` type, which has no `oneOf`, so
that comes out too.

The outcome no per-keyword rule can see is the node consisting of **nothing but**
the keyword being removed. Then the removal is not a widening, it is a deletion —
and at the document root it deletes the whole schema. `{"patternProperties":
{"^a": {"type": "string"}}}` used to convert to `{}` and exit 1, meaning "commit
my output". `{"definitions": {"I": {...}}}` — the shape you get when something
upstream dropped the root `$ref` and left only the bag — converted to `{}` and
exited **0**, printing *"Already valid for gemini. No changes needed."*

Fourteen shapes in this project's own fixture corpus did this. All of them are
now a blocker (exit 3), keyed on the **outcome** rather than on a keyword list,
because a keyword-keyed version of this rule already shipped once and missed
every route but the one it was written for.

The severity is worth stating precisely, because it is not a 400.
`types.Schema` (`google-genai` 2.17.0) **accepts** `{}`, measured. The request
succeeds; the model is simply free to return any JSON at all. A tool that scores
itself on *raw rejected → ours accepted* records that as a win, which is why the
check had to be about what is left in the document rather than about what the
vendor tolerates.

Two cases, two remedies, and they are not interchangeable:

- **Keywords this dialect cannot express.** 13 of the 14 shapes survive `--to
  gemini-json` intact — `responseJsonSchema` takes full JSON Schema — so the
  blocker names it. Same file, two targets, opposite verdicts.
- **A definition bag nothing points into.** No target can rescue this one: it
  constrains nothing everywhere, because what went missing is the `$ref` *into*
  the bag. Naming an escape hatch here would be a false promise, so the blocker
  says to restore the pointer instead.


### A single-member `allOf` can invent the root

`allOf` with one member is *flattened*: the member's keywords are copied up into
the node, which is what OpenAI's own transformer does. The consequence is easy to
miss — the flatten can put a `type`, an `anyOf` or a `$ref` somewhere the
converter had **already finished checking**:

```json
{"allOf": [{"type": "string", "minLength": 3}]}
```

You did not write a scalar root; the flatten produced one, after the root checks
had passed. OpenAI rejects it (`Root schema must have type: 'object'`), so this
is a blocker naming the remodelling rather than a repair — there is no root form
of a union, and turning a scalar root into an object means inventing a wrapper
property whose name would be a guess.

The nested version is the one worth internalising, because the same schema one
wrapper apart gets opposite treatment:

| input | result |
|---|---|
| `{"minLength": 3, "$ref": "#/$defs/S"}` | **repaired** — the definition is inlined, output accepted |
| `{"minLength": 3, "allOf": [{"$ref": "#/$defs/S"}]}` | **blocker** — the `$ref` was hoisted next to the constraint after the inliner ran |

Both are rejected by OpenAI as written; only the first has a lossless repair at
the point we look. If you hit the second, drop the `allOf` wrapper and we inline
it for you.

Two shapes deliberately stay quiet, because the vendor accepts them: a `$ref`
beside pure **annotations** (`$comment`, `default`, `description`, `examples`,
`readOnly`, `title`, `writeOnly` — the exact set openai@7.4.0 enumerates, and
note `deprecated` is *not* in it), which is the standard Pydantic v1 output for a
described nested field; and a `$defs`/`definitions` bag beside a `$ref`, which is
not a constraining sibling at all.


## `"any"` is not a type, and one generator writes it everywhere

`type` has exactly seven legal values — `string`, `number`, `integer`, `boolean`,
`object`, `array`, `null`. `smolagents` builds tool schemas straight from Python
type hints, and `_function_type_hints_utils.get_json_schema()` renders **every
`Any` annotation** as `{"type": "any"}` — measured 2026-08-10 for a bare `Any`,
`List[Any]`, `Dict[str, Any]` and `Optional[Any]`, in four different positions.

`ajv` (2020-12) refuses to compile that schema, so no validator can honour the
node. The destinations split, and the split is the reason this is a blocker:

| destination | `{"type": "any"}` |
|---|---|
| Gemini narrow `responseSchema` | **rejected** — `type` is a proto enum; live v1beta answers `Invalid value at … .type`, exactly as it answers for a `"frobnicate"` control, while `"string"` reaches auth |
| Gemini `responseJsonSchema` | accepted (payload validation) |
| `openai` 7.4.0 `toStrictJsonSchema` | forwarded **verbatim** |
| `@anthropic-ai/sdk` 0.116.0 `betaTool` | forwarded **verbatim** |

Before this rule the tool exited **0** on `--to openai`, `anthropic`,
`anthropic-json`, `anthropic-go` and `gemini-json`, and affirmatively listed all
of them under *"already valid as-is for"*. On `--to gemini` it exited 1 for two
unrelated reasons and never mentioned the illegal value — so the emitted output
still carried it and was still rejected by the live endpoint with the same
error. A gate whose fix does not fix it is worse than no gate.

**There is no repair, and in particular the fix is not "delete `type`".** `any`
means the match-anything schema, and a typeless / match-anything node is itself
refused further down this pipeline, because a constrained decoder cannot express
anything-goes. Declare the shape you expect, or type the field
`{"type": "string"}` and have the model emit serialized JSON you parse yourself.

An empty `type: []` is deliberately **not** this rule: that is a list-valued
`type` with zero members, which the live endpoint rejects with a proto *shape*
error rather than the enum-value error, so it belongs to the union-`type`
handling instead. It is pinned by a scope test.

## License
MIT.
