/*
 * ESM entry point for llm-json-schema.
 *
 * engine.js is a UMD/CommonJS file so the same bytes run in the browser via a
 * <script> tag. Node's CJS named-export detection cannot see through its
 * conditional `module.exports = api` assignment, so `import { convert } from
 * "llm-json-schema"` throws SyntaxError in a "type": "module" package. Since
 * the people who actually hit provider schema errors are on ESM + TypeScript
 * (Vercel AI SDK, LangChain, Mastra), that made the library form unusable for
 * exactly the audience it was built for. This wrapper re-exports the named
 * bindings explicitly.
 */

import api from "./engine.js";

export const convert = api.convert;
export const inferSchema = api.inferSchema;
export const looksLikeSchema = api.looksLikeSchema;
export const toOpenAI = api.toOpenAI;
export const toAnthropic = api.toAnthropic;
export const toGemini = api.toGemini;
export const DOCS = api.DOCS;
export const GEMINI_ALLOWED_KEYS = api.GEMINI_ALLOWED_KEYS;
export const ANTHROPIC_STRING_FORMATS_KEPT = api.ANTHROPIC_STRING_FORMATS_KEPT;

export default api;
