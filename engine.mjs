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
export const toOutlines = api.toOutlines;
export const DOCS = api.DOCS;
export const GEMINI_ALLOWED_KEYS = api.GEMINI_ALLOWED_KEYS;
export const AI_SDK_GOOGLE_FORWARDED_KEYS = api.AI_SDK_GOOGLE_FORWARDED_KEYS;
export const GEMINI_CLIENT_CARRIED_KEYS = api.GEMINI_CLIENT_CARRIED_KEYS;
export const GEMINI_CLIENT_MEMBERS = api.GEMINI_CLIENT_MEMBERS;
export const ANTHROPIC_STRING_FORMATS_KEPT = api.ANTHROPIC_STRING_FORMATS_KEPT;
export const ANTHROPIC_GO_SUPPORTED_KEYS = api.ANTHROPIC_GO_SUPPORTED_KEYS;
export const GO_INVOPOP_MODELLED_KEYS = api.GO_INVOPOP_MODELLED_KEYS;
export const OPENAI_ANNOTATION_KEYWORDS_LIST = api.OPENAI_ANNOTATION_KEYWORDS_LIST;
export const OPENAI_STRICT_SURFACES = api.OPENAI_STRICT_SURFACES;
export const ANTHROPIC_TRANSFORM_SURFACES = api.ANTHROPIC_TRANSFORM_SURFACES;
export const OUTLINES_DROPPED_KEYS = api.OUTLINES_DROPPED_KEYS;
export const OUTLINES_REJECTED_KEYS = api.OUTLINES_REJECTED_KEYS;
export const OUTLINES_ENFORCED_KEYS = api.OUTLINES_ENFORCED_KEYS;

export default api;
export const REF_INLINE_MAX_NODES = api.REF_INLINE_MAX_NODES;
export const SCHEMA_MAX_DEPTH = api.SCHEMA_MAX_DEPTH;
