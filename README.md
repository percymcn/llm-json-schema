# LLM JSON Schema

Free, 100% client-side web tool: turn a JSON Schema (or a JSON example) into a **provider-correct** LLM structured-output schema for **OpenAI**, **Anthropic**, and **Gemini** — and explain/fix schemas a provider rejected.

**Live:** https://percymcn.github.io/llm-json-schema/

> Status: **v0 — built & shipping** (Cycle #96). Engine is unit-tested (`node engine.test.js`). Provider rules verified against official docs on 2026-07-30.

## Why
Each provider accepts a different schema dialect, so a schema that works with one gets rejected by the next:
- **OpenAI Structured Outputs (strict):** `additionalProperties: false` on every object; every property in `required` (optionals become nullable); root must be an object, not `anyOf`; `allOf`/`not`/`if`/`then`/`else` unsupported.
- **Anthropic tool `input_schema`:** standard JSON Schema, object root, light constraints; `strict: true` goes on the tool, not the schema.
- **Gemini `responseSchema`:** a JSON-Schema subset — needs `propertyOrdering`, drops `$ref`/`pattern`/`minLength`/`maxLength`, and limits string `format` to `date-time`/`date`/`time`.

This tool applies each provider's rules for you and shows a **change ledger** — every transform, with the exact official-doc rule it enforces cited inline.

## Features (v0)
- Paste a **JSON Schema** or a **JSON example** (auto-detected → schema inferred).
- Pick a target provider → get the corrected schema + copy button.
- **Change ledger:** every add / change / removal / violation, each linking the provider doc rule.
- **Validate & fix** mode: see what a provider would reject and the fixed version.
- 100% client-side. No backend, no account, no data leaves the browser.

## How it's built
- `engine.js` — dependency-free transform + lint logic (the product's value). Every rule cites its source doc URL.
- `engine.test.js` — 21 assertions covering each provider's rules. Run: `node engine.test.js`.
- `index.html` + `app.js` — static UI, GitHub Pages host. SEO scaffold: title/meta/canonical, JSON-LD `SoftwareApplication`, `sitemap.xml`, `robots.txt`, `.nojekyll`.

## Sources (verified 2026-07-30)
- OpenAI — https://developers.openai.com/api/docs/guides/structured-outputs
- Anthropic — https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview
- Gemini — https://ai.google.dev/gemini-api/docs/structured-output

## Distribution
Organic Google search only (loop-owned, un-gated). Targets error-message long-tails first (e.g. *"additionalProperties is required to be false"*, *"gemini responseSchema $ref not supported"*); the head term comes later with domain age.

## License
MIT.
