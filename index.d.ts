/**
 * Type definitions for llm-json-schema.
 *
 * Make a JSON Schema valid for OpenAI strict structured outputs, Anthropic
 * tool use, or Gemini responseSchema.
 */

export type Provider =
  | "openai"
  | "openai-nonstrict"
  | "anthropic"
  | "anthropic-json"
  | "anthropic-json-python"
  | "anthropic-go"
  | "gemini"
  | "gemini-json"
  | "gemini-client"
  | "openai-realtime";

/** A JSON Schema object. Deliberately loose — we transform arbitrary schemas. */
export type JSONSchema = Record<string, any>;

/**
 * One recorded change (or refusal to change), in the order it was applied.
 *
 * `op` is the marker the CLI and web UI print:
 *   `+` added   `~` rewrote   `x` removed   `=` no change needed   `!` cannot fix
 */
export interface LedgerEntry {
  op: "+" | "~" | "x" | "=" | "!";
  /** JSON path of the affected node, or `"root"`. */
  path: string;
  /** Human-readable explanation of what changed and why. */
  msg: string;
  /** Provider doc URL the rule was derived from. */
  ruleUrl: string;
  /**
   * `true` for an OPTIONAL improvement — the provider already accepts the
   * schema without it. `--check` ignores these, so they never fail a CI gate.
   */
  advisory?: boolean;
}

export interface ConvertSuccess {
  ok: true;
  /** The provider-valid schema. The input is never mutated. */
  schema: JSONSchema;
  ledger: LedgerEntry[];
  /** True when the input was a sample JSON value and a schema was inferred from it. */
  inferred: boolean;
  docUrl: string;
}

export interface ConvertFailure {
  ok: false;
  error: string;
}

export type ConvertResult = ConvertSuccess | ConvertFailure;

export interface ConvertOptions {
  /**
   * `"schema"` forces the input to be read as a JSON Schema, `"example"` forces
   * it to be read as a sample value to infer from. Omit to auto-detect.
   */
  mode?: "schema" | "example";
}

/**
 * Convert a schema for the given provider.
 *
 * Accepts either a JSON string or an already-parsed object — pass the object
 * that `zodToJsonSchema()` or Pydantic's `.model_json_schema()` produced
 * directly, no `JSON.stringify` needed.
 */
export function convert(
  input: string | JSONSchema,
  provider: Provider,
  opts?: ConvertOptions
): ConvertResult;

export interface TransformResult {
  schema: JSONSchema;
  ledger: LedgerEntry[];
}

/** Transform a schema for OpenAI strict structured outputs. */
export function toOpenAI(schema: JSONSchema): TransformResult;
/**
 * Transform a schema for Anthropic.
 *
 * Anthropic has two dialects and the switch is which request field you use, not
 * anything in the schema — so the path is a parameter, never inferred.
 *
 * @param outputFormatPath `false`/omitted targets `tools[].input_schema`, where
 * Anthropic applies no transform and the schema is sent verbatim. `true` targets
 * `output_format: {type: "json_schema"}`, which rebuilds the schema and demotes
 * unrecognised keywords to `description` prose.
 */
export function toAnthropic(schema: JSONSchema, outputFormatPath?: boolean): TransformResult;
/**
 * Transform a schema for Gemini.
 *
 * @param jsonPath `false`/omitted targets the narrow `responseSchema` proto;
 * `true` targets the permissive `responseJsonSchema` field.
 */
export function toGemini(schema: JSONSchema, jsonPath?: boolean): TransformResult;

/** Infer a JSON Schema from a sample JSON value. */
export function inferSchema(value: unknown): JSONSchema;

/** Heuristic: does this object look like a JSON Schema rather than a sample value? */
export function looksLikeSchema(obj: unknown): boolean;

/** Provider documentation URLs the rules are derived from. */
export const DOCS: Record<Provider, string>;

/**
 * The keyword subset Gemini's narrow `responseSchema` proto can carry.
 * Confirmed against three independent vendor artifacts: the JS `Schema`
 * interface, the Python `types.Schema` model, and the Go `Schema` struct's
 * json tags — all 22 keys, identical.
 */
export const GEMINI_ALLOWED_KEYS: string[];

/**
 * Keys `@ai-sdk/google`'s `convertJSONSchemaToOpenAPISchema` destructures, i.e.
 * everything that can reach Gemini's narrow `responseSchema` path through that
 * client. Snapshot of @ai-sdk/google 4.0.39 — re-measure after a version bump.
 */
export const AI_SDK_GOOGLE_FORWARDED_KEYS: string[];

/**
 * The `format` VALUES Anthropic's transformer keeps on a string node.
 * Confirmed against three independent vendor artifacts, each a literal in
 * code: the JS `SUPPORTED_STRING_FORMATS`, the Python `SupportedStringFormats`
 * and the Go `supportedStringFormats` — all 10, identical. Unlike Gemini's
 * `format` list, which the vendor documents as open, this one is closed.
 */
export const ANTHROPIC_STRING_FORMATS_KEPT: string[];

/**
 * The keys `anthropic-sdk-go` keeps verbatim — its `supportedSchemaKeys`
 * (schemautil.go), transcribed and diffed against the vendor in both
 * directions. Anything outside this set is at best demoted to `description`
 * prose; see {@link GO_INVOPOP_MODELLED_KEYS} for which of the two it is.
 */
export const ANTHROPIC_GO_SUPPORTED_KEYS: string[];

/**
 * The keys `invopop/jsonschema`'s `Schema` struct gives a field. A keyword
 * outside this set never survives the round-trip inside `transformSchemaMap`
 * at all: `Schema.UnmarshalJSON` is a plain alias unmarshal, so unknown keys
 * are discarded before Anthropic's transform runs and never reach the
 * extras-to-description path. Two severities hide behind one "unsupported" —
 * modelled keys become prose, unmodelled keys vanish without a trace.
 */
export const GO_INVOPOP_MODELLED_KEYS: string[];

/**
 * The seven keywords openai@7.4.0 treats as pure annotations
 * (`JSON_SCHEMA_ANNOTATION_KEYWORDS` in its lib/transform.js). They are
 * load-bearing twice in the vendor: they gate whether a single-member `allOf`
 * may be flattened, and whether a `$ref`'s siblings are tolerated. Note
 * `deprecated` is NOT one of them while `readOnly`/`writeOnly` are.
 */
export const OPENAI_ANNOTATION_KEYWORDS_LIST: string[];

declare const api: {
  convert: typeof convert;
  inferSchema: typeof inferSchema;
  looksLikeSchema: typeof looksLikeSchema;
  toOpenAI: typeof toOpenAI;
  toAnthropic: typeof toAnthropic;
  toGemini: typeof toGemini;
  DOCS: typeof DOCS;
  GEMINI_ALLOWED_KEYS: typeof GEMINI_ALLOWED_KEYS;
  AI_SDK_GOOGLE_FORWARDED_KEYS: typeof AI_SDK_GOOGLE_FORWARDED_KEYS;
  ANTHROPIC_STRING_FORMATS_KEPT: typeof ANTHROPIC_STRING_FORMATS_KEPT;
  ANTHROPIC_GO_SUPPORTED_KEYS: typeof ANTHROPIC_GO_SUPPORTED_KEYS;
  GO_INVOPOP_MODELLED_KEYS: typeof GO_INVOPOP_MODELLED_KEYS;
  OPENAI_ANNOTATION_KEYWORDS_LIST: typeof OPENAI_ANNOTATION_KEYWORDS_LIST;
};

export default api;
