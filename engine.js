/*
 * llm-json-schema engine — provider-correct JSON Schema transforms + linting.
 *
 * Dependency-free. Runs in the browser and in Node (for tests).
 *
 * Rules are sourced from the provider's CURRENT official docs AND, where the
 * vendor ships one, from the vendor's own client SDK — which encodes the
 * ACCEPTED keyword set, while the docs only describe the SUPPORTED subset.
 * The two differ, and the SDK wins. Each rule carries the URL it came from so
 * the UI can cite it — the provider-divergence logic IS the product's value.
 *
 * Sources:
 *   OpenAI    https://developers.openai.com/api/docs/guides/structured-outputs
 *             + `openai@7.4.0` lib/transform `toStrictJsonSchema()`  [2026-08-08]
 *   Anthropic https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview
 *   Gemini    https://ai.google.dev/gemini-api/docs/structured-output
 *             + `@google/genai@2.16.0` `Schema` type, `processJsonSchema()`,
 *               `maybeMoveToResponseJsonSchema()`                    [2026-08-09]
 */

(function (root) {
  "use strict";

  var DOCS = {
    openai: "https://developers.openai.com/api/docs/guides/structured-outputs",
    anthropic: "https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview",
    "anthropic-json": "https://platform.claude.com/docs/en/docs/build-with-claude/structured-outputs",
    "anthropic-json-python": "https://platform.claude.com/docs/en/docs/build-with-claude/structured-outputs",
    "anthropic-go": "https://platform.claude.com/docs/en/docs/build-with-claude/structured-outputs",
    gemini: "https://ai.google.dev/gemini-api/docs/structured-output",
    "gemini-json": "https://ai.google.dev/gemini-api/docs/structured-output",
    "gemini-client": "https://ai.google.dev/gemini-api/docs/structured-output",
    "openai-nonstrict": "https://platform.openai.com/docs/guides/function-calling",
    "openai-realtime": "https://platform.openai.com/docs/guides/realtime-conversations"
  };

  // ---- small helpers -------------------------------------------------------

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function isPlainObject(v) {
    return v && typeof v === "object" && !Array.isArray(v);
  }

  // A node is an "object schema" if it declares type:object or carries properties.
  function isObjectSchema(node) {
    if (!isPlainObject(node)) return false;
    if (node.type === "object") return true;
    if (node.properties && isPlainObject(node.properties)) return true;
    return false;
  }

  // Recognised through BOTH spellings of `type` — the scalar and the spec's
  // second form, an array of strings. Deliberately keyed on `type` alone and
  // not on `minItems`/`maxItems`: the consequence this guards is a converting
  // client inserting a made-up `items`, and those clients gate on `type` too
  // (google-adk: `type == "array" or (isinstance(type, list) and "array" in
  // type)`), so a typeless node is not an array as far as that layer is
  // concerned and flagging it would be noise.
  function isArraySchema(node) {
    if (!isPlainObject(node)) return false;
    var t = node.type;
    if (t === "array") return true;
    return Array.isArray(t) && t.indexOf("array") !== -1;
  }

  // An OPEN MAP is `{"type":"object", "additionalProperties": <schema|true>}`
  // with no declared `properties` — the standard rendering of `Dict[str, V]`
  // (Pydantic), `Record<string, V>` / `z.record()` (Zod) and OpenAPI free-form
  // objects. All of the node's content lives in `additionalProperties`.
  //
  // This matters because the usual repair is to set `additionalProperties:
  // false`, and on a node with no `properties` that does not close the object —
  // it EMPTIES it. The map becomes a schema whose only legal instance is `{}`,
  // so the field can never be populated, and nothing in the request says so.
  // A rule that deletes the only content a node has must fail closed.
  function isOpenMap(node) {
    if (!isPlainObject(node)) return false;
    if (!("additionalProperties" in node)) return false;
    var ap = node.additionalProperties;
    if (ap === false) return false;                       // already closed on purpose
    if (ap !== true && !isPlainObject(ap)) return false;  // not a schema we understand
    if (isPlainObject(node.properties) && Object.keys(node.properties).length) return false;
    // `type` may be absent or an array (a nullable map) — treat any of those as
    // an object, per the spec's second form of `type`.
    var t = node.type;
    if (t === undefined) return true;
    if (t === "object") return true;
    if (Array.isArray(t) && t.indexOf("object") !== -1) return true;
    return false;
  }

  // A node the Go SDK cannot key on, mirroring `transformSchema`'s own guard
  // (schemautil.go:85, anthropic-sdk-go@v1.62.0):
  //
  //   s.Type == "" && len(s.AnyOf) == 0 && len(s.AllOf) == 0 &&
  //   len(s.Enum) == 0 && s.Const == nil
  //
  // The bail is NOT a pass-through. It assigns the zero `jsonschema.Schema`,
  // and invopop's `MarshalJSON` renders a zero schema as the literal JSON
  // `true` -- a match-anything schema. So a node that constrains something and
  // has no `type` does not merely lose its constraint, it INVERTS into the
  // weakest schema there is. `$ref` is excluded because `transformSchema`
  // returns on it before the guard runs; `oneOf` because it is rewritten to
  // `anyOf` first. Length checks rather than presence checks, because the Go
  // guard uses `len()`: `enum: []` and `anyOf: []` reach the bail.
  //
  // A node with NO keys is excluded on purpose: `{}` and `true` are the same
  // schema, so there is nothing to report. Measured control -- zod 4's
  // `z.record(z.string(), z.unknown())` emits `additionalProperties: {}` and
  // Go's `true` is a faithful rendering of it.
  function goReplacesWithTrue(node) {
    if (!isPlainObject(node)) return false;
    if (!Object.keys(node).length) return false;
    function has(k) { return Array.isArray(node[k]) && node[k].length > 0; }
    return node.type === undefined && node.$ref === undefined &&
      !has("anyOf") && !has("oneOf") && !has("allOf") && !has("enum") &&
      node.const === undefined;
  }

  // #358 mirrored the vendor's guard for the value schema SITTING IN
  // `additionalProperties`. It stopped there, and the note it prints in the
  // clean case says the quiet part out loud: "recurses into the value schema".
  // That recursion does not stop either -- `transformSchema` keeps going down
  // whatever it finds, so a map whose VALUE is a well-typed object can still
  // have a node three levels below it replaced with `true`.
  //
  // walk() never enters `additionalProperties`, so EVERY rule keyed on it is
  // blind below that edge (#356 recorded the walker gap; this is a rule that
  // composes with it). Widening walk() itself would fire these rules below the
  // map for all ten targets, and only Go looks there -- so instead this mirrors
  // `transformSchema`'s OWN recursion, clause for clause. Measured against
  // anthropic-sdk-go@v1.62.0 `schemautil.go`:
  //
  //   1. `anyOf` and `allOf` recurse unconditionally, BEFORE the type switch.
  //   2. The bail (`*s = jsonschema.Schema{}`) runs before the switch, so a
  //      node that zeroes out is never descended into.
  //   3. `case "object"` recurses into `properties` values IF there are any --
  //      and in that branch `additionalProperties` is overwritten with `false`,
  //      so the value schema is NOT visited. Only the `else if` dictionary
  //      clause (no properties) descends into it. Same discriminator as #356,
  //      pointing the same way the vendor points it.
  //   4. `case "array"` recurses into `items`, object form only -- `Items` is a
  //      `*Schema`, so the draft-07 array form fails to unmarshal and takes the
  //      whole document to `null` (#332's rule owns that, not this one).
  //   5. The switch is on a STRING `Type`, so a union-typed node matches no
  //      case and nothing below it is reached (and a union `type` is itself the
  //      #332 total loss).
  //
  // Only nodes reached THROUGH an `additionalProperties` edge are returned:
  // everything else on Go's path is already covered by walk().
  function goTrueNodesUnderMaps(root) {
    var found = [];
    // Three positions, and the distinctions are load-bearing:
    //   near      -- the NEAREST enclosing map, named in the message.
    //   owner     -- the OUTERMOST map, i.e. the one walk() can actually reach.
    //                The open-map note is attached there, so that is the key
    //                the note filters on; a nested map has no note of its own.
    //   immediate -- the value schema sitting directly in a map walk() reaches.
    //                #358's rule already owns exactly that node. A nested map's
    //                immediate value is NOT owned by anyone else, because
    //                walk() never reached the nested map to notice it.
    function descend(node, path, near, owner, immediate) {
      if (!isPlainObject(node)) return;
      ["anyOf", "allOf"].forEach(function (kw) {   // clause 1: before the bail
        if (Array.isArray(node[kw])) {
          node[kw].forEach(function (sub, i) {
            descend(sub, path + "/" + kw + "[" + i + "]", near, owner, false);
          });
        }
      });
      if (goReplacesWithTrue(node)) {              // clause 2: the vendor bails here
        if (near !== null && !immediate) found.push({ path: path, mapPath: near, owner: owner });
        return;
      }
      if (typeof node.type !== "string") return;                 // clause 5
      if (node.type === "object") {                              // clause 3
        if (isPlainObject(node.properties) && Object.keys(node.properties).length) {
          Object.keys(node.properties).forEach(function (k) {
            descend(node.properties[k], path + "." + k, near, owner, false);
          });
        } else if (isPlainObject(node.additionalProperties)) {
          descend(node.additionalProperties, path + "{}", path,
            owner === null ? path : owner, near === null);
        }
      } else if (node.type === "array") {                        // clause 4
        if (isPlainObject(node.items)) descend(node.items, path + "[]", near, owner, false);
      }
    }
    descend(root, "root", null, null, false);
    return found;
  }

  // A TYPED CATCHALL is the shape isOpenMap deliberately excludes one line
  // above: declared `properties` AND an `additionalProperties` that still
  // carries a schema. `z.object({...}).catchall(...)` emits exactly this
  // (measured on zod@4.4.3), as does any OpenAPI object with typed free-form
  // extras. It is NOT an open map -- closing it does not empty the node, the
  // declared properties survive -- which is precisely why #329's rule steps
  // over it, and why nothing else looked either: neither walk() nor
  // findBooleanSubschemas() descends into `additionalProperties` at all, so the
  // value schema is an unexamined subtree on top of being an unreported one.
  //
  // The vendor uses the SAME discriminator we do and it flips the outcome the
  // other way. Measured 2026-08-09 across all three Anthropic SDKs on the
  // `output_format` path -- a pure open map splits 2-1 (Go's `transformSchema`
  // has an explicit dictionary clause and PRESERVES it) while this shape is
  // 3-0 DESTROYED, because that clause requires the node to have no
  // `properties`. So "does this node declare properties?" decides preservation
  // in one direction and deletion in the other.
  function hasTypedCatchall(node) {
    if (!isPlainObject(node)) return false;
    if (!("additionalProperties" in node)) return false;
    var ap = node.additionalProperties;
    if (ap === false) return false;                       // an ordinary closed object
    if (ap !== true && !isPlainObject(ap)) return false;  // not a schema we understand
    // The half isOpenMap refuses: this rule is only about nodes that HAVE
    // declared properties, so the two are mutually exclusive by construction
    // and a node can never be reported by both.
    if (!isPlainObject(node.properties) || !Object.keys(node.properties).length) return false;
    var t = node.type;
    if (t === undefined) return true;
    if (t === "object") return true;
    if (Array.isArray(t) && t.indexOf("object") !== -1) return true;
    return false;
  }

  // An EMPTIED map is the fossil an open map leaves behind after something has
  // already "repaired" it: `additionalProperties: false` and NO `properties` key
  // at all. Its only legal instance is `{}`, so the field can never be
  // populated — but it is perfectly valid, every provider accepts it, and by the
  // time you are looking at it the value type is GONE. Nothing downstream can
  // recover what it used to be, which is why this is worth saying out loud.
  //
  // Measured against @mastra/schema-compat@1.3.5, whose
  // `prepareJsonSchemaForOpenAIStrictMode` produces exactly this from an
  // ordinary `z.record(z.string())`: the vendor then ACCEPTS the result.
  //
  // There are TWO producer classes and the remedy differs, which is why the
  // advisory below splits them. (a) A post-hoc compatibility layer that
  // "repairs" a map which was still open when it left the caller's code —
  // Mastra above, agno's `make_nested_strict`. There an earlier checkpoint
  // exists. (b) The GENERATOR ITSELF, where the open form is never emitted at
  // any point the caller could inspect — semantic-kernel 1.44.1's
  // `KernelJsonSchemaBuilder.build(..., structured_output=True)` builds the
  // value schema for a `Dict[str, str]` and then overwrites it with `false`
  // three lines later in the same function. Telling that caller to "check
  // before the layer runs" names a checkpoint that does not exist.
  //
  // The discriminator is the ABSENCE of the `properties` key, not an empty one.
  // Measured: a deliberate `z.object({})` emits `properties: {}`, so requiring
  // the key to be missing separates a real empty object from an emptied map.
  // Being merely noisier than the vendor is this project's most repeated bug,
  // so this is advisory-only and never fails a gate.
  // Two FORMS of the same dead node, and the difference is how much we are
  // entitled to say about it.
  //
  //   "no-properties"    -- `additionalProperties: false` and NO `properties`
  //                         key at all. No generator emits that for a declared
  //                         empty object (they all write `properties: {}`), so
  //                         this shape is only ever what is LEFT of a map.
  //   "empty-properties" -- `properties: {}` as well. Measured on crewai
  //                         1.15.14: `force_additional_properties_false`
  //                         overwrites the value schema AND then adds
  //                         `properties: {}` + `required: []`, so a
  //                         `Dict[str, str]` comes out BYTE-IDENTICAL to a
  //                         genuinely empty BaseModel. The cause is no longer
  //                         recoverable from the file -- but the CONSEQUENCE is
  //                         identical either way, and that is the part worth
  //                         reporting.
  //
  // #335 keyed only on the first form, on the reasoning that `properties: {}`
  // proves someone meant an empty object. crewai disproves the premise: a
  // repair can DELETE the value type and FABRICATE the marker that would have
  // exonerated it. So the rule stops trying to infer the cause and states what
  // is certain — this node's only legal value is `{}`.
  function emptiedMapForm(node) {
    if (!isPlainObject(node)) return null;
    if (node.additionalProperties !== false) return null;
    var t = node.type;
    var isObj = t === "object" || (Array.isArray(t) && t.indexOf("object") !== -1);
    if (!isObj) return null;
    if (!("properties" in node)) return "no-properties";
    if (isPlainObject(node.properties) && Object.keys(node.properties).length === 0) {
      return "empty-properties";
    }
    return null;
  }

  function isEmptiedMap(node) {
    return emptiedMapForm(node) !== null;
  }

  // `additionalProperties` is NOT the only keyword that says "this object is a
  // map". JSON Schema has four ways to describe keys nobody declared, and
  // isOpenMap above knows exactly one of them:
  //
  //   additionalProperties: <schema|true>   -- the one isOpenMap knows
  //   patternProperties: {"^S_": <schema>}  -- keys matching a regex
  //   propertyNames: <schema>               -- a constraint on the key strings
  //   unevaluatedProperties: <schema|true>  -- whatever the branches did not cover
  //
  // That gap is not theoretical and it is not hand-written. Measured verbatim on
  // pydantic 2.13.4, a pattern-constrained dict key
  //   Dict[Annotated[str, StringConstraints(pattern=r'^S_')], str]
  // renders as {"type": "object", "patternProperties": {"^S_": {"type":
  // "string"}}} with NO `additionalProperties` key at all -- so nothing in this
  // engine saw a map. The OpenAI converter then does two individually correct
  // things: it strips `patternProperties` (the vendor genuinely throws on it)
  // and it sets `additionalProperties: false` (strict mode genuinely requires
  // it). Composed, they leave `{"type": "object", "additionalProperties":
  // false}` -- an object whose only legal value is `{}`. The field can never be
  // populated, the vendor ACCEPTS that output verbatim, and re-checking it
  // exits 0.
  //
  // Note which direction that is. A strip on its own WIDENS: dropping
  // `uniqueItems` merely stops enforcing something. This one NARROWS to the
  // empty object, because the keyword being stripped was the node's only way of
  // admitting a key and the keyword being added forbids everything else. Two
  // correct edits, one inversion.
  //
  // Deliberately NOT counted as evidence of a map, and each of these is a
  // discriminator proving the rule is keyed on what the keyword SAYS about the
  // keys rather than on its presence:
  //   patternProperties: {}        -- describes no keys at all, so closing the
  //                                   object loses nothing (an empty collection
  //                                   is the inverse of a full one, not less of
  //                                   it).
  //   unevaluatedProperties: false -- already says "closed"; closing is a no-op.
  //   a bare {"type": "object"}    -- carries no claim about undeclared keys,
  //                                   and openai@7.4.0's own transformer closes
  //                                   it exactly the same way, so flagging it
  //                                   would be the over-strictness this project
  //                                   has shipped repeatedly.
  function mapKeyEvidence(node) {
    if (!isPlainObject(node)) return [];
    var found = [];
    if (isPlainObject(node.patternProperties) &&
        Object.keys(node.patternProperties).length) found.push("patternProperties");
    if (node.propertyNames === true || isPlainObject(node.propertyNames)) {
      found.push("propertyNames");
    }
    var up = node.unevaluatedProperties;
    if (up === true || isPlainObject(up)) found.push("unevaluatedProperties");
    return found;
  }

  // Does this node still have somewhere to put data once undeclared keys are
  // forbidden? #329's question ("what does the node have LEFT after the
  // repair?") is what separates a blocker from an advisory here.
  function hasUsableProperties(node) {
    return isPlainObject(node) && isPlainObject(node.properties) &&
      Object.keys(node.properties).length > 0;
  }

  // ---- unsatisfiable nodes --------------------------------------------------
  //
  // For a collection keyword the EMPTY instance usually does not mean "less of
  // the constraint" — it means the OPPOSITE of the non-empty one. A non-empty
  // `enum` narrows the legal values; an empty one leaves none. A non-empty
  // `anyOf` offers branches; an empty one offers nothing to match. `not` of a
  // schema that matches everything excludes everything. Each of these nodes has
  // an EMPTY set of legal values, so the field can never be populated.
  //
  // Not hypothetical, and not hand-written. Measured verbatim:
  //   pydantic 2.13.4, `class Empty(Enum): pass`  -> {"enum": [], "title": "Empty"}
  //   zod 4.4.3, z.enum([])                       -> {"type": "string", "enum": []}
  //   zod 4.4.3, z.union([])                      -> {"anyOf": []}
  //   zod 4.4.3, z.never()                        -> {"not": {}}
  // The usual real cause is an upstream list that came back empty
  // (`z.enum(ALLOWED)` where ALLOWED filtered down to nothing), not intent.
  //
  // Note what is deliberately NOT here. An empty `allOf` is vacuously TRUE, so
  // it matches everything, the exact opposite of an empty `anyOf`. `required:
  // []`, `properties: {}` and `prefixItems: []` are merely empty constraints,
  // not impossible ones. Flagging any of those would be the over-strictness
  // this project has shipped repeatedly.
  function matchesAnything(v) {
    // The spec's two spellings of "any value is legal" — the boolean `true` and
    // the empty object. They are the same schema.
    return v === true || (isPlainObject(v) && Object.keys(v).length === 0);
  }

  function unsatisfiableForm(node) {
    if (!isPlainObject(node)) return null;
    if (Array.isArray(node["enum"]) && node["enum"].length === 0) return "enum";
    if (Array.isArray(node.anyOf) && node.anyOf.length === 0) return "anyOf";
    if (Array.isArray(node.oneOf) && node.oneOf.length === 0) return "oneOf";
    if (Array.isArray(node.type) && node.type.length === 0) return "type";
    if ("not" in node && matchesAnything(node["not"])) return "not";
    return null;
  }

  // Per form: what makes it impossible, and the generator measured emitting it.
  // Naming only the relevant producer keeps the message about the reader's
  // schema rather than reciting a catalogue.
  var UNSAT_WHY = {
    "enum": ["`enum: []` lists no allowed value",
      "an empty `Enum` class (pydantic 2.13.4) and `z.enum([])` (zod 4.4.3) both emit this"],
    anyOf: ["`anyOf: []` offers no branch to match",
      "`z.union([])` (zod 4.4.3) emits this"],
    oneOf: ["`oneOf: []` offers no branch to match",
      "an empty union emits this"],
    type: ["`type: []` permits no JSON type",
      "this usually survives a list-valued `type` that was filtered down to nothing"],
    "not": ["`not` of a match-anything schema (`{}` or `true`) excludes every value",
      "`z.never()` (zod 4.4.3) emits this"]
  };

  // Advisory, never a gate failure: the destination accepts the document as
  // written, so failing CI here would be the mistake #317 fixed. What it adds is
  // the one thing nothing downstream will tell you — the field is dead.
  function noteUnsatisfiable(node, path, ledger, doc) {
    var form = unsatisfiableForm(node);
    if (!form) return null;
    ledger.push(entry("!", path,
      "No value can satisfy this node: " + UNSAT_WHY[form][0] + ". The field can never be " +
      "populated, and providers accept the schema as written, so nothing downstream will " +
      "say so. This is almost always a degenerate input rather than intent — " +
      UNSAT_WHY[form][1] + " — so check the list that produced it upstream.",
      doc, true));
    return form;
  }

  // ---- boolean subschemas ---------------------------------------------------
  //
  // JSON Schema defines a schema as "an object OR a boolean": `true` matches any
  // value, `false` matches none. Every walker in this file starts with
  // `if (!isPlainObject(node)) return;`, so a boolean node silently ends that
  // branch — not skipped-and-reported, skipped-and-SILENT. It is the same shape
  // as the container-spelling misses (`definitions` vs `$defs`, array-form
  // `items`, `/$defs/` vs `#/$defs/`, an array-valued `type`), except the
  // alternate spelling here is the spec's second form of a SCHEMA ITSELF.
  //
  // Not exotic. Go's canonical generator emits it for the four idiomatic ways of
  // saying "arbitrary JSON": `any`, `interface{}`, `json.RawMessage` and the
  // element type of `[]any` all reflect to a literal `true`.
  //
  // NOTE which positions count. `additionalProperties`, `unevaluatedProperties`
  // and `additionalItems` take a boolean BY DESIGN — flagging those would fire on
  // every closed object in existence. Only positions that hold a schema proper
  // are checked.
  function findBooleanSubschemas(root) {
    var hits = [];
    function visit(node, path) {
      if (node === true || node === false) { hits.push({ path: path, value: node }); return; }
      if (!isPlainObject(node)) return;
      if (isPlainObject(node.properties)) {
        Object.keys(node.properties).forEach(function (k) {
          visit(node.properties[k], path + "." + k);
        });
      }
      visit(node.items, path + "[]");
      if (Array.isArray(node.items)) {
        node.items.forEach(function (it, i) { visit(it, path + "[" + i + "]"); });
      }
      if (Array.isArray(node.prefixItems)) {
        node.prefixItems.forEach(function (it, i) { visit(it, path + "[" + i + "]"); });
      }
      ["anyOf", "oneOf", "allOf"].forEach(function (kw) {
        if (Array.isArray(node[kw])) {
          node[kw].forEach(function (sub, i) { visit(sub, path + "/" + kw + "[" + i + "]"); });
        }
      });
      // Single-subschema container — see the matching note in walk().
      visit(node.not, path + "/not");
      ["$defs", "definitions"].forEach(function (bag) {
        if (isPlainObject(node[bag])) {
          Object.keys(node[bag]).forEach(function (k) { visit(node[bag][k], bag + "." + k); });
        }
      });
    }
    visit(root, "root");
    return hits;
  }

  // The node is left in place on purpose (#318): the reader has to be able to see
  // the shape in their own file. There is no repair — an unconstrained value has
  // no representation in a constrained-decoding dialect — so this names the
  // remodelling instead of inventing a type.
  function booleanSubschemaMessage(value, vendorNote) {
    return value === true
      ? "This is a boolean subschema (`true`), which matches ANY value. " + vendorNote +
        " There is no repair: a dialect that constrains decoding has no way to say " +
        "\"anything goes\", so a type has to be chosen rather than guessed. Declare the " +
        "shape you actually expect, or — if the value really is arbitrary — type it as " +
        "`{\"type\": \"string\"}` and have the model emit serialized JSON you parse yourself. " +
        "In Go this is what `any`, `interface{}`, `json.RawMessage` and the element type of " +
        "`[]any` reflect to."
      : "This is a boolean subschema (`false`), which matches NO value — nothing can ever " +
        "satisfy it, so the field is unsatisfiable as written. " + vendorNote +
        " Give it a real schema, or remove it (and drop it from `required`).";
  }

  var OPEN_MAP_REMEDY =
    "An open map cannot be expressed here, and closing it would leave an object " +
    "whose only legal value is `{}` — the field could never be populated. Remodel " +
    "it as an array of `{\"key\": ..., \"value\": ...}` objects (both halves stay " +
    "fully typed), or declare the keys you actually expect as fixed `properties`.";

  // Ledger entry: { op: "+"|"~"|"x"|"!", path, msg, ruleUrl, advisory }
  //   +  added        ~  changed        x  removed        !  violation (cannot auto-fix)
  //
  // `advisory: true` marks an OPTIONAL improvement — the schema is already
  // accepted without it. `--check` must not fail CI on these: a gate that goes
  // red on a valid schema is the same false-failure class as a doc-derived
  // allowlist rejecting a payload the vendor accepts.
  function entry(op, path, msg, ruleUrl, advisory) {
    var e = { op: op, path: path || "root", msg: msg, ruleUrl: ruleUrl };
    if (advisory) e.advisory = true;
    return e;
  }

  // ---- did the conversion leave anything behind? ---------------------------
  //
  // Keywords that describe a schema without asserting anything about the
  // instance. A document holding only these accepts every JSON value there is.
  var ANNOTATION_ONLY = {
    title: 1, description: 1, $comment: 1, examples: 1, default: 1,
    deprecated: 1, readOnly: 1, writeOnly: 1, propertyOrdering: 1,
    $schema: 1, $id: 1
  };

  // The two sides ask DIFFERENT questions on purpose, and the asymmetry is the
  // whole point of the rule.
  //
  // Output side — "does what I am handing back constrain anything?" A `$defs`
  // bag nothing points into does NOT count: it asserts nothing about any
  // instance, so a document reduced to one still accepts every JSON value.
  function constrainsSomething(s) {
    if (s === false) return true;               // matches nothing — a constraint
    if (s === true || s === null || typeof s !== "object") return false;
    return Object.keys(s).some(function (k) {
      return !ANNOTATION_ONLY[k] && k !== "$defs" && k !== "definitions";
    });
  }

  // Input side — "did this document have content at all?" Here a definition bag
  // DOES count, and it is the case that made the asymmetry necessary: a bare
  // `{"definitions": {...}}` is the llama-index shape (#341), where the root
  // `$ref` was deleted upstream and only the bag arrived. As a schema it already
  // constrained nothing, so a symmetric rule stays silent — and staying silent
  // is what let `--to gemini` answer exit 0, "Already valid. No changes needed",
  // while handing back `{}`. The author plainly modelled something; saying so
  // beats agreeing with the deletion.
  function hadContent(s) {
    if (!isPlainObject(s)) return constrainsSomething(s);
    return Object.keys(s).some(function (k) { return !ANNOTATION_ONLY[k]; });
  }

  // #352. Every keyword rule in this file decides one keyword's fate, and each
  // of them is individually defensible: the narrow proto has no field for `if`,
  // `contains`, `propertyNames`, `patternProperties`, `dependentRequired` or
  // `unevaluatedProperties`, and some converting clients cannot carry `oneOf`
  // (google-adk drops it; @ai-sdk/google forwards it — #365). The
  // outcome none of them can see is the node consisting of NOTHING BUT the
  // keyword being removed — #329's tell, asked here about the DOCUMENT ROOT for
  // the first time. Measured across the whole test corpus: 14 ordinary inputs
  // came back constraining nothing, 22 of those rows at exit 1 ("commit my
  // output") and 2 at exit 0 ("Already valid — no changes needed").
  //
  // #347 caught one route (a match-anything `not`) and keyed the fix on the
  // KEYWORD, so the other routes survived. This is keyed on the OUTCOME, which
  // is why it needs no list: whatever deletes the last constraint trips it.
  //
  // Honest severity: `types.Schema` (google-genai 2.17.0) ACCEPTS `{}`, so this
  // is not a rejection — the request succeeds and the model is simply free to
  // return any JSON at all. Our headline metric (raw rejected -> ours accepted)
  // scores the broken behaviour as a win, which is #347's corollary again.
  //
  // Blocker rather than a repair: there is nothing to repair. The constraints
  // have no representation in this dialect, so the only honest moves are to
  // remodel or to change target — and the target is named because it was
  // measured, not guessed (all 14 survive `--to gemini-json`).
  function noteEmptiedDocument(input, output, ledger, docUrl, alternative) {
    if (!hadContent(input) || constrainsSomething(output)) return;
    // Which of the two cases this is has to be read from the INPUT, and that is
    // #341's lesson rather than a style choice: the orphan-`$defs` pruner has
    // already deleted the bag by the time this runs — precisely because nothing
    // pointed into it — so asking the OUTPUT whether a bag was there always
    // answers no. The two cases need different remedies, and switching targets
    // cannot help a document whose only content was a bag nothing points at: it
    // constrains nothing everywhere, so naming an escape hatch would be a false
    // promise. The asymmetry between the two predicates is exactly this test.
    var bag = hadContent(input) && !constrainsSomething(input);
    ledger.push(entry("!", "root",
      "Nothing is left in this document that asserts anything about the data, so what " +
      "you would send constrains nothing — the model may return any JSON at all. Any " +
      "removals are listed above with their reasons; this note is about the total. " +
      (bag
        ? "The definition bag that is left describes a type nothing points at, so it " +
          "constrains no instance and no target can rescue it: what went missing is the " +
          "`$ref` INTO the bag, most likely before this document reached us. Restore that " +
          "pointer — a top-level `$ref`, or a property that references the definition."
        : alternative),
      docUrl));
  }

  // ---- schema inference from a JSON example --------------------------------

  // Join the schemas inferred from two sibling array elements. Reading only
  // element 0 (what this used to do) is not a shortcut, it is a NARROWING: the
  // remaining elements are examples of legal data, and a schema that forbids
  // them rejects the very document it was inferred from. Measured on ajv
  // 2020: `[1,"a"]` -> `items:{type:"integer"}` (element 1 illegal),
  // `[1,2.5]` -> integer (2.5 illegal), `[null,"x"]` -> `items:{type:"null"}`
  // (the array can only ever hold nulls), and `[{a:1},{a:1,b:2}]` inferred
  // clean and then INVERTED once `additionalProperties:false` was added — two
  // individually-correct edits composing into a rejection, #348's shape.
  //
  // Nothing here invents a type it did not see (#336): every branch is a
  // union of things actually present in the example.
  function typeOnlyList(s) {
    if (!isPlainObject(s)) return null;
    var k = Object.keys(s);
    if (k.length !== 1 || k[0] !== "type") return null;
    return Array.isArray(s.type) ? s.type.slice() : [s.type];
  }

  function anyOfMembers(s) {
    return isPlainObject(s) && Array.isArray(s.anyOf) ? s.anyOf : [s];
  }

  function joinInferred(a, b) {
    if (canonical(a) === canonical(b)) return a;

    if (isPlainObject(a) && isPlainObject(b) &&
        a.type === "object" && b.type === "object" &&
        isPlainObject(a.properties) && isPlainObject(b.properties)) {
      // Union the keys, intersect `required`: a key absent from one element is
      // demonstrably optional. (Strict mode has no optional fields, so the
      // openai converter will later force it required-and-nullable and say so.)
      var props = {};
      Object.keys(a.properties).forEach(function (k) { props[k] = a.properties[k]; });
      Object.keys(b.properties).forEach(function (k) {
        props[k] = props[k] === undefined
          ? b.properties[k]
          : joinInferred(props[k], b.properties[k]);
      });
      var bReq = b.required || [];
      var req = (a.required || []).filter(function (k) { return bReq.indexOf(k) !== -1; });
      return { type: "object", properties: props, required: req };
    }

    if (isPlainObject(a) && isPlainObject(b) && a.type === "array" && b.type === "array") {
      // A missing `items` here means "this element was an empty array", i.e. no
      // information — not "any element is allowed" — so the known side wins.
      var arr = { type: "array" };
      if (a.items !== undefined && b.items !== undefined) arr.items = joinInferred(a.items, b.items);
      else if (a.items !== undefined) arr.items = a.items;
      else if (b.items !== undefined) arr.items = b.items;
      return arr;
    }

    var at = typeOnlyList(a), bt = typeOnlyList(b);
    if (at && bt) {
      var all = at.slice();
      bt.forEach(function (t) { if (all.indexOf(t) === -1) all.push(t); });
      // `integer` is a subset of `number`, so a list holding both is a list of
      // numbers. Keeping `integer` would forbid the float that was right there.
      if (all.indexOf("number") !== -1) all = all.filter(function (t) { return t !== "integer"; });
      return all.length === 1 ? { type: all[0] } : { type: all };
    }

    // Mixed structured/scalar (`[{"a":1}, "x"]`, `[null, {"a":1}]`): `anyOf` is
    // the only form that keeps BOTH shapes, and every target carries it.
    var members = [];
    anyOfMembers(a).concat(anyOfMembers(b)).forEach(function (m) {
      for (var i = 0; i < members.length; i++) if (canonical(members[i]) === canonical(m)) return;
      members.push(m);
    });
    return members.length === 1 ? members[0] : { anyOf: members };
  }

  function inferSchema(value) {
    if (value === null) return { type: "null" };
    if (Array.isArray(value)) {
      var out = { type: "array" };
      if (value.length) {
        var joined = inferSchema(value[0]);
        for (var i = 1; i < value.length; i++) joined = joinInferred(joined, inferSchema(value[i]));
        out.items = joined;
      }
      return out;
    }
    if (typeof value === "object") {
      var props = {};
      var required = [];
      Object.keys(value).forEach(function (k) {
        props[k] = inferSchema(value[k]);
        required.push(k);
      });
      return { type: "object", properties: props, required: required };
    }
    if (typeof value === "string") return { type: "string" };
    if (typeof value === "number") {
      return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
    }
    if (typeof value === "boolean") return { type: "boolean" };
    return {};
  }

  // ---- schema-vs-example classification ------------------------------------
  // This decides which of two COMPLETELY DIFFERENT operations runs, so getting
  // it wrong is not a wrong answer, it is an answer about a different document.
  //
  // The original test was an eight-key allowlist (`type`, `properties`,
  // `$schema`, `$ref`, `anyOf`, `oneOf`, `allOf`, `enum`). JSON Schema has
  // roughly forty root-legal keywords, so a schema whose root happens to use
  // none of those eight was classified as DATA and fed to `inferSchema()`,
  // which then described the schema's own syntax as if it were a payload. The
  // output is a perfectly valid strict schema — `toStrictJsonSchema()` accepts
  // it verbatim — that asks the model to emit JSON Schema instead of the
  // caller's data. Measured producer (#341): `llama-index-core==0.14.23`'s
  // `ToolMetadata.get_parameters_dict()` keeps only five top-level keys, so a
  // `RootModel` tool schema arrives as `{"$defs": {...}}` — no `type`, no
  // `properties`, no `$ref`, because the filter drops the pointer and keeps the
  // bag. Nineteen of nineteen root-keyword-only schemas were misclassified.
  //
  // Widening to "any key is a keyword" would break the other direction: an
  // ordinary invoice example `{"items": [...], "total": 12.5}` has a key named
  // `items`. So the rule is stricter on both counts —
  //   (a) EVERY root key must be a JSON Schema keyword (a data object almost
  //       always carries at least one key that is not), and
  //   (b) each keyword's VALUE must have the shape that keyword requires
  //       (`{"items": [1,2,3]}` is data: array-form `items` holds subschemas,
  //       not numbers), and
  //   (c) at least one must be an APPLICATOR or VALIDATOR, not merely an
  //       annotation — `{"title": "Dune", "description": "..."}` is a book
  //       record as readily as an annotation-only schema, and that ambiguity is
  //       genuine, so it is deliberately left classified as data (unchanged).

  // Annotations only: legal in a schema, equally legal as data keys.
  var ANNOTATION_KEYWORDS = {
    title: 1, description: 1, "default": 1, examples: 1,
    deprecated: 1, readOnly: 1, writeOnly: 1, $comment: 1
  };

  // Keyword -> predicate on its value. Being wrong about the SHAPE is how a
  // data key sneaks in, so every keyword states what it must hold.
  function isSubschema(v) { return isPlainObject(v) || typeof v === "boolean"; }
  function isSubschemaArray(v) { return Array.isArray(v) && v.length > 0 && v.every(isSubschema); }
  function isSubschemaMap(v) {
    if (!isPlainObject(v)) return false;
    var ks = Object.keys(v);
    return ks.length > 0 && ks.every(function (k) { return isSubschema(v[k]); });
  }
  function isStringArray(v) {
    return Array.isArray(v) && v.every(function (x) { return typeof x === "string"; });
  }
  var isNum = function (v) { return typeof v === "number" && isFinite(v); };
  var isStr = function (v) { return typeof v === "string"; };
  var isBool = function (v) { return typeof v === "boolean"; };
  var anyValue = function () { return true; };

  var SCHEMA_KEYWORD_SHAPE = {
    // applicators taking a single subschema
    items: function (v) { return isSubschema(v) || isSubschemaArray(v); },
    additionalItems: isSubschema, contains: isSubschema, "not": isSubschema,
    "if": isSubschema, then: isSubschema, "else": isSubschema,
    propertyNames: isSubschema, additionalProperties: isSubschema,
    unevaluatedProperties: isSubschema, unevaluatedItems: isSubschema,
    // applicators taking a map of subschemas
    $defs: isSubschemaMap, definitions: isSubschemaMap, properties: isSubschemaMap,
    patternProperties: isSubschemaMap, dependentSchemas: isSubschemaMap,
    // applicators taking an array of subschemas
    anyOf: isSubschemaArray, oneOf: isSubschemaArray, allOf: isSubschemaArray,
    prefixItems: isSubschemaArray,
    // references and identity
    $ref: isStr, $schema: isStr, $id: isStr, $anchor: isStr, $dynamicRef: isStr,
    // validators
    type: function (v) { return isStr(v) || isStringArray(v); },
    "enum": function (v) { return Array.isArray(v); },
    "const": anyValue,
    required: isStringArray,
    dependentRequired: isPlainObject,
    minimum: isNum, maximum: isNum, exclusiveMinimum: isNum, exclusiveMaximum: isNum,
    multipleOf: isNum,
    minLength: isNum, maxLength: isNum, pattern: isStr, format: isStr,
    contentEncoding: isStr, contentMediaType: isStr,
    minItems: isNum, maxItems: isNum, uniqueItems: isBool,
    minContains: isNum, maxContains: isNum,
    minProperties: isNum, maxProperties: isNum,
    nullable: isBool, discriminator: isPlainObject, propertyOrdering: isStringArray
  };

  // Detect whether pasted JSON is a schema or an example.
  function looksLikeSchema(obj) {
    if (!isPlainObject(obj)) return false;
    // Fast path, unchanged: these eight are decisive on their own.
    if ("type" in obj || "properties" in obj || "$schema" in obj || "$ref" in obj ||
        "anyOf" in obj || "oneOf" in obj || "allOf" in obj || "enum" in obj) return true;

    var keys = Object.keys(obj);
    if (!keys.length) return false;           // `{}` is genuinely ambiguous — unchanged.
    var sawSubstantive = false;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (ANNOTATION_KEYWORDS[k]) continue;   // legal, but proves nothing.
      var shape = Object.prototype.hasOwnProperty.call(SCHEMA_KEYWORD_SHAPE, k)
        ? SCHEMA_KEYWORD_SHAPE[k] : null;
      if (!shape || !shape(obj[k])) return false;  // a non-keyword, or a keyword
                                                   // holding data -> it is data.
      sawSubstantive = true;
    }
    return sawSubstantive;
  }

  // What each shape test above actually requires, in words. Kept beside the
  // table on purpose: a keyword added to SCHEMA_KEYWORD_SHAPE without a line
  // here would report "a different kind of value", which is useless, so a test
  // asserts the two stay in step (#334 -- make the agreement a test, not a
  // comment).
  var SHAPE_WANTS = {
    items: "a schema, or an array of schemas (draft-07 tuple form)",
    additionalItems: "a schema or a boolean", contains: "a schema", "not": "a schema",
    "if": "a schema", then: "a schema", "else": "a schema",
    propertyNames: "a schema", additionalProperties: "a schema or a boolean",
    unevaluatedProperties: "a schema or a boolean", unevaluatedItems: "a schema or a boolean",
    $defs: "an object mapping names to schemas", definitions: "an object mapping names to schemas",
    properties: "an object mapping property names to schemas",
    patternProperties: "an object mapping regexes to schemas",
    dependentSchemas: "an object mapping property names to schemas",
    anyOf: "an array of schemas", oneOf: "an array of schemas",
    allOf: "an array of schemas", prefixItems: "an array of schemas",
    $ref: "a string", $schema: "a string", $id: "a string", $anchor: "a string",
    $dynamicRef: "a string",
    type: "a string, or an array of strings",
    "enum": "an array", "const": "any value",
    required: "an array of strings", dependentRequired: "an object",
    minimum: "a number", maximum: "a number", exclusiveMinimum: "a number",
    exclusiveMaximum: "a number", multipleOf: "a number",
    minLength: "a number", maxLength: "a number", pattern: "a string", format: "a string",
    contentEncoding: "a string", contentMediaType: "a string",
    minItems: "a number", maxItems: "a number", uniqueItems: "a boolean",
    minContains: "a number", maxContains: "a number",
    minProperties: "a number", maxProperties: "a number",
    nullable: "a boolean", discriminator: "an object", propertyOrdering: "an array of strings"
  };

  function kindOf(v) {
    return v === null ? "null" : Array.isArray(v) ? "an array"
      : typeof v === "object" ? "an object"
      : typeof v === "string" ? "a string"
      : typeof v === "number" ? "a number"
      : typeof v === "boolean" ? "the boolean `" + v + "`" : typeof v;
  }

  // SCHEMA_KEYWORD_SHAPE answers "does this keyword hold the right KIND of
  // thing?", and until now it was asked in exactly one place: looksLikeSchema,
  // at the ROOT, as a data-or-schema tiebreaker -- and behind a fast path that
  // returns early the moment `type`/`properties`/`$ref`/a combinator is present,
  // so on an ordinary-looking document it never ran at all. One level down it
  // was never asked.
  //
  // That matters because every descent guard in walk() and
  // findBooleanSubschemas() is a TYPE TEST -- `if (isPlainObject(node[bag]))`,
  // `if (Array.isArray(node[kw]))`. A keyword holding the wrong type therefore
  // reads EXACTLY like an absent keyword: the subtree is skipped in silence and
  // the engine then reports "Already valid. No changes needed." -- an
  // affirmative claim derived from having looked at nothing. Same asymmetry as
  // #320 (a keep-rule reading "I could not find a reference" as "nothing
  // references this") and #342 ("this reference points somewhere" as "somewhere
  // exists"), now on the DESCENT side.
  //
  // Only SCHEMA POSITIONS are checked, so a property literally NAMED `$defs` or
  // `anyOf` is not a false positive (#334's control). Unknown keywords
  // (`x-foo`, vendor extensions) have no entry and are left alone.
  // SCOPE, and it is deliberately narrow -- both halves were forced by running
  // the check over the captured corpus before believing it:
  //
  //  1. SUBSCHEMA-BEARING POSITIONS ONLY. The defect is an UNEXAMINED SUBTREE.
  //     `exclusiveMaximum: true` is malformed too, but nothing is skipped and
  //     our verdict is not uninformed -- and those are exactly the degenerate
  //     typed-field rows #354 measured on the Go client and deliberately did
  //     not ship, because no generator emits them. Widening to every keyword
  //     would re-litigate that decision by accident. Measured-and-not-shipped
  //     the same way here: `required: "a"`, `enum: {}`, `type: 5`, `format: null`.
  //
  //  2. KIND, NOT MEMBERSHIP. The test is "is this the right KIND of thing?",
  //     NOT the table's isSubschemaMap/isSubschemaArray -- those additionally
  //     require non-emptiness, and an EMPTY container is legal and deliberately
  //     supported here: `items: []` is #346's zero-length draft-07 tuple,
  //     `anyOf: []`/`allOf: []` are #347's unsatisfiable/vacuous forms,
  //     `properties: {}` and `patternProperties: {}` are ordinary. Using the
  //     stricter predicate blocked 24 real captured inputs and would have
  //     deleted four cycles of measured behaviour. Empty is the INVERSE of
  //     non-empty, not a malformed version of it (#347).
  var CONTAINER_SHAPE = {
    $defs: "map", definitions: "map", properties: "map",
    patternProperties: "map", dependentSchemas: "map",
    anyOf: "arr", oneOf: "arr", allOf: "arr", prefixItems: "arr",
    "not": "sub", "if": "sub", then: "sub", "else": "sub", contains: "sub",
    propertyNames: "sub", additionalProperties: "sub",
    unevaluatedProperties: "sub", unevaluatedItems: "sub", additionalItems: "sub",
    items: "sub-or-arr"
  };
  var isSchemaValue = function (v) { return isPlainObject(v) || v === true || v === false; };

  function findMalformedKeywords(root) {
    var bad = [];
    function note(path, kw, v) {
      bad.push({ path: path, kw: kw, want: SHAPE_WANTS[kw] || "a different kind of value", got: kindOf(v) });
    }
    function visit(node, path) {
      if (!isPlainObject(node)) return;
      Object.keys(node).forEach(function (k) {
        var shape = Object.prototype.hasOwnProperty.call(CONTAINER_SHAPE, k) ? CONTAINER_SHAPE[k] : null;
        if (!shape) return;                    // unknown / non-container keyword: not ours
        var v = node[k];
        if (shape === "map") {
          if (!isPlainObject(v)) return note(path, k, v);
          Object.keys(v).forEach(function (n) {
            var m = v[n];
            // A MEMBER that is not a schema is the same defect one level down:
            // walk() drops it on the same `isPlainObject` guard, in silence.
            if (!isSchemaValue(m)) return note(path + "." + k + "." + n, k, m);
            visit(m, path + "." + k + "." + n);
          });
          return;
        }
        if (shape === "arr" || (shape === "sub-or-arr" && Array.isArray(v))) {
          if (!Array.isArray(v)) return note(path, k, v);
          v.forEach(function (m, i) {
            if (!isSchemaValue(m)) return note(path + "/" + k + "[" + i + "]", k, m);
            visit(m, path + "/" + k + "[" + i + "]");
          });
          return;
        }
        if (!isSchemaValue(v)) return note(path, k, v);
        visit(v, path + "/" + k);
      });
    }
    visit(root, "root");
    return bad;
  }

  // No repair is possible and that is the whole reason this is a blocker: there
  // is no way to know what `properties: true` was meant to say, and #329's rule
  // is that when a repair cannot be invented the remedy gets NAMED instead.
  //
  // Severity is universal across targets, and the justification is deliberately
  // NOT vendor tolerance -- it is a statement about OUR OWN analysis. Measured
  // 2026-08-09, the clients do not agree and two of them accept it:
  //   anthropic-sdk-go v1.62.0  the WHOLE DOCUMENT comes back `schema: null`
  //                             (#332's total-loss shape) and the request is
  //                             built anyway -- 15 of 17 probed shapes.
  //   anthropic 0.121.0 (py)    `transform_schema` RAISES, request never built.
  //   @anthropic-ai/sdk 0.116.0 `betaJSONSchemaOutputFormat` THROWS on some
  //                             shapes; `betaTool` forwards ALL of them verbatim.
  //   openai 7.4.0              `toStrictJsonSchema` ACCEPTS `properties: true`
  //                             and `$defs: true`.
  // "The client forwarded it" is weak evidence here (#354): a decoder cannot be
  // constrained by a `properties` that is a boolean, so acceptance is not
  // correctness (#347).
  function malformedKeywordMessage(hit) {
    return "`" + hit.kw + "` must be " + hit.want + ", but here it is " + hit.got + ". " +
      "This document is not valid JSON Schema, so everything inside that keyword was " +
      "SKIPPED -- every rule that would have looked in there never ran. That is why this " +
      "is a blocker rather than a note: without it this file would come back " +
      "\"already valid\", which would be a claim about a part of your schema that was " +
      "never examined. Measured on the vendor clients 2026-08-09, they disagree and two " +
      "of them do NOT complain: `anthropic-sdk-go` v1.62.0 returns `schema: null` for the " +
      "WHOLE document and builds the request anyway; `anthropic` 0.121.0 (Python) raises " +
      "so the request is never built; `@anthropic-ai/sdk` 0.116.0 throws on the " +
      "`output_format` path but forwards it verbatim on `tools[].input_schema`; and " +
      "`openai` 7.4.0's `toStrictJsonSchema` accepts several of these outright. Being " +
      "accepted is not the same as being honoured -- a constrained decoder cannot use a " +
      "`properties` that is a boolean. There is no repair: fix the keyword to hold " +
      hit.want + ".";
  }

  // ---- OpenAI Structured Outputs (strict) ----------------------------------
  // Rules (all quoted/derived from the OpenAI doc):
  //  - "additionalProperties: false must always be set in objects"
  //  - "All fields ... must be specified as required" (optional => union with null)
  //  - "the root level object of a schema must be an object, and not use anyOf"
  //  - "If you turn on Structured Outputs by supplying strict: true and call the
  //     API with an unsupported JSON Schema, you will receive an error."
  //
  // Because unsupported keywords ERROR rather than being ignored, this is an
  // ALLOWLIST, not a blocklist.
  //
  // SECOND SOURCE (added after the doc alone proved too coarse): OpenAI's own
  // official SDK ships the strict transformer that builds the exact payload it
  // sends — `toStrictJsonSchema()` in openai@7.4.0 (`openai/lib/transform`). It
  // throws on keywords the API cannot represent, and silently PRESERVES the
  // rest. Running every keyword through it yields a sharper rule than the doc's
  // "Supported properties" list, which under-reports what is actually accepted:
  //
  //   PRESERVED  minLength maxLength default examples readOnly writeOnly
  //              deprecated $comment $id $schema title description
  //   THROWS     uniqueItems minProperties maxProperties patternProperties
  //              propertyNames unevaluatedProperties unevaluatedItems
  //              additionalItems contains minContains not allOf
  //              dependentRequired dependencies if then else
  //              prefixItems maxContains contentEncoding contentMediaType
  //              contentSchema $anchor $dynamicRef $recursiveRef
  //
  // `prefixItems` was originally classified as structural-and-supported here
  // WITHOUT being probed. It is in the SDK's unsupported set, and array-form
  // `items` throws separately ("uses tuple-form `items`"). Both are what an
  // ordinary tuple compiles to — Pydantic `Tuple[float, float, float, float]`
  // emits `prefixItems`, zod `z.tuple()` emits either depending on target
  // dialect — so both leaked through and produced a schema the API rejects.
  // See normalizeTuple.
  //
  // The split is coherent: strict mode errors on keywords whose validation
  // semantics its constrained decoder cannot compile, and accepts (ignores)
  // annotations and soft constraints. So we strip only the first class.
  // Stripping the second class was WRONG — it made `--check` fail on schemas
  // OpenAI's own SDK sends verbatim, i.e. on any Zod `.describe()` / `.min()` /
  // `.default()` or Pydantic `Field(description=..., default=...)`, which is
  // most real generator output. Verified against openai@7.4.0.
  // Transcribed from `JSON_SCHEMA_ANNOTATION_KEYWORDS` in openai@7.4.0's
  // lib/transform.js — a `new Set([...])` literal with no "and others" escape, so
  // per #344 this list is genuinely CLOSED and an allowlist is the right shape.
  // It is load-bearing twice over in the vendor: `hasOnlyAnnotationSiblings()`
  // gates whether a single-member `allOf` may be flattened at all, and the same
  // set decides whether a `$ref`'s siblings are tolerated. Exported and diffed
  // against the vendor in both directions (#360: agreeing with a blocklist is
  // nearly free — the load-bearing diff is the complement).
  //
  // Note `deprecated` is NOT here even though it reads like an annotation, and
  // `readOnly`/`writeOnly` ARE — both measured, both surprising, and getting
  // either wrong silently changes which schemas we flatten.
  // #366 — `openai-nonstrict` is named for a CONDITION ("`strict` is not set"),
  // and #322 counted FOUR optional declaration sites and treated them as one
  // class meaning "nothing is enforced". Enumerating EVERY `strict` field in
  // openai@7.4.0's `resources/**.d.ts` with its enclosing interface and doc
  // comment (measured 2026-08-10) gives EIGHT sites in THREE groups, and one of
  // #322's own four disagrees with the other three.
  //
  //   "off"      — omitting the flag means nothing is enforced. The doc says
  //                "If set to true, the model will follow the exact schema",
  //                i.e. it only ever describes the true branch.
  //   "auto"     — omitting the flag does NOT mean non-strict. Doc, verbatim:
  //                "If omitted, Responses attempts to use strict validation when
  //                the schema is compatible, and falls back to non-strict
  //                validation otherwise." Note the fallback is SILENT.
  //   "required" — the field is not optional at all (`strict:` not `strict?:`),
  //                so there is no "omitted" state to be in; a caller here passed
  //                `false` or `null` deliberately.
  //
  // Realtime is a fourth case and is not in this table because it has no
  // `strict` field anywhere (#317); that is what `openai-realtime` selects.
  //
  // Honest limit, stated the way #361 states its tables: the suite is
  // dependency-free and cannot run the SDK, so this pins a MEASURED SNAPSHOT of
  // one version and re-measuring after a bump is a manual step.
  var OPENAI_STRICT_SURFACES = [
    { path: "FunctionDefinition", file: "resources/shared.d.ts", line: 112,
      unset: "off", api: "chat.completions tools[].function" },
    { path: "ResponseFormatJSONSchema.JSONSchema", file: "resources/shared.d.ts", line: 251,
      unset: "off", api: "chat.completions response_format" },
    { path: "ResponseFormatTextJSONSchemaConfig", file: "resources/responses/responses.d.ts", line: 2456,
      unset: "off", api: "responses text.format" },
    { path: "BetaResponseFormatTextJSONSchemaConfig", file: "resources/beta/responses/responses.d.ts", line: 2855,
      unset: "off", api: "beta responses text.format" },
    { path: "NamespaceTool.Function", file: "resources/responses/responses.d.ts", line: 741,
      unset: "auto", api: "responses namespace tools" },
    { path: "BetaNamespaceTool.Function", file: "resources/beta/responses/responses.d.ts", line: 820,
      unset: "auto", api: "beta responses namespace tools" },
    { path: "FunctionTool", file: "resources/responses/responses.d.ts", line: 609,
      unset: "required", api: "responses tools[] function" },
    { path: "BetaFunctionTool", file: "resources/beta/responses/responses.d.ts", line: 688,
      unset: "required", api: "beta responses tools[] function" }
  ];

  function openaiSurfacesWhereUnsetIs(kind) {
    return OPENAI_STRICT_SURFACES.filter(function (s) { return s.unset === kind; });
  }

  var OPENAI_ANNOTATION_KEYWORDS = {
    $comment: 1, "default": 1, description: 1, examples: 1,
    readOnly: 1, title: 1, writeOnly: 1
  };

  // Mirrors the vendor's `hasOnlyAnnotationSiblings()`: a sibling is tolerated if
  // it is an annotation, or an OBJECT-VALUED `$defs`/`definitions` bag
  // ("Definition maps do not add sibling validation constraints"), and at the ROOT
  // the vendor's variant additionally tolerates `$schema`/`$id`. Counting the
  // definition bag as a constraint is the mistake to avoid — `{$ref, $defs}` is
  // the canonical shape every generator emits and the vendor accepts it.
  function toleratedRefSibling(k, atRoot, node) {
    if (OPENAI_ANNOTATION_KEYWORDS[k] === 1) return true;
    if ((k === "$defs" || k === "definitions") && isPlainObject(node[k])) return true;
    if (atRoot && (k === "$schema" || k === "$id")) return true;
    return false;
  }

  var OPENAI_SUPPORTED = {
    // structural
    type: 1, properties: 1, required: 1, additionalProperties: 1,
    // `items` only in its OBJECT form — the draft-07 ARRAY form is a tuple and
    // is rejected ("uses tuple-form `items`"). normalizeTuple owns that case.
    // `prefixItems` is NOT here: it is in the SDK's own unsupported set.
    items: 1, anyOf: 1, enum: 1, "const": 1, $ref: 1, $defs: 1,
    // root metadata — explicitly retained by toStrictJsonSchema as rootMetadata
    $schema: 1, $id: 1,
    // annotations — preserved by the SDK transformer, and they steer the model
    description: 1, title: 1, $comment: 1,
    "default": 1, examples: 1, readOnly: 1, writeOnly: 1, deprecated: 1,
    // string
    pattern: 1, format: 1, minLength: 1, maxLength: 1,
    // number
    multipleOf: 1, maximum: 1, exclusiveMaximum: 1, minimum: 1, exclusiveMinimum: 1,
    // array
    minItems: 1, maxItems: 1
  };

  // Why a given keyword is stripped. Anything not named here gets the generic
  // reason. These are the ones real generators actually emit.
  // Every reason below is a keyword that openai@7.4.0's own `toStrictJsonSchema`
  // THROWS on ("uses unsupported keyword `X` and cannot be represented in strict
  // Structured Outputs"), i.e. the API genuinely cannot accept it.
  var OPENAI_STRIP_REASON = {
    "uniqueItems": "OpenAI's supported array properties are `minItems` and `maxItems` only.",
    "contains": "a conditional array constraint strict mode cannot compile.",
    "minContains": "a conditional array constraint strict mode cannot compile.",
    "additionalItems": "tuple-tail validation is not representable in strict mode; use `items`/`prefixItems`.",
    "unevaluatedItems": "annotation-dependent array validation is not representable in strict mode.",
    "minProperties": "OpenAI's only supported object property is `additionalProperties`.",
    "maxProperties": "OpenAI's only supported object property is `additionalProperties`.",
    "patternProperties": "OpenAI's only supported object property is `additionalProperties`.",
    "propertyNames": "OpenAI's only supported object property is `additionalProperties`.",
    "unevaluatedProperties": "OpenAI's only supported object property is `additionalProperties`.",
    "allOf": "the doc names `allOf` unsupported; express the merged shape as one object instead.",
    "not": "the doc names `not` unsupported.",
    "dependentRequired": "the doc names `dependentRequired` unsupported.",
    "dependentSchemas": "the doc names `dependentSchemas` unsupported.",
    "if": "the doc names `if`/`then`/`else` unsupported.",
    "then": "the doc names `if`/`then`/`else` unsupported.",
    "else": "the doc names `if`/`then`/`else` unsupported."
  };

  // A local pointer is spelled `#/$defs/X`. LiteLLM deliberately emits `/$defs/X`
  // instead — it passes `ref_template="/$defs/{model}"` to Pydantic's
  // `model_json_schema()` (litellm/llms/anthropic/chat/transformation.py), so this
  // is the DEFAULT shape for every Python caller using `response_format=<Model>`.
  //
  // That spelling is not a local pointer. Per RFC 3986 it is a path-absolute
  // URI-reference with no fragment, so it addresses a different document and never
  // resolves against the local `$defs`. LiteLLM's own code agrees: its OTHER
  // Anthropic path calls `unpack_defs()` first, commented "Anthropic doesn't
  // support external schema references (e.g., /$defs/CalendarEvent)".
  //
  // Every rule below matches `#/$defs/...`, so before this normalisation an
  // unrecognised spelling did not merely go unfixed — the orphan-`$defs` pruner
  // found no reference to the definition and DELETED it, leaving a dangling
  // pointer, and `inlineRootRef` no-oped so a root `$ref` sailed through as
  // "already valid". That is the single most destructive Anthropic input there is.
  //
  // Conditional, not unconditional (#318): rewrite only when the target actually
  // exists locally. A `/$defs/X` with no local `X` really is external, and no
  // provider resolves those — that gets named as a blocker instead of quietly
  // rewritten into a pointer at something that was never there.
  function normalizeRefSpelling(s, ledger, docUrl, why) {
    var bags = ["$defs", "definitions"];
    var rewritten = 0, external = [];
    (function visit(v) {
      if (Array.isArray(v)) { v.forEach(visit); return; }
      if (!isPlainObject(v)) return;
      if (typeof v.$ref === "string" && v.$ref.charAt(0) !== "#") {
        var m = /^\/(\$defs|definitions)\/(.+)$/.exec(v.$ref);
        var name = m ? m[2] : null;
        if (m && isPlainObject(s[m[1]]) && isPlainObject(s[m[1]][name])) {
          v.$ref = "#" + v.$ref;
          rewritten++;
        } else if (external.indexOf(v.$ref) === -1) {
          external.push(v.$ref);
        }
      }
      Object.keys(v).forEach(function (k) { visit(v[k]); });
    })(s);

    if (rewritten) {
      ledger.push(entry("~", "root",
        "Rewrote " + rewritten + " `$ref` from `/$defs/...` to `#/$defs/...`. Only the second form is " +
        "a pointer into this document; the first addresses a different document and leaves the " +
        "reference dangling. " + (why || "") + " LiteLLM emits this spelling by default for Python " +
        "callers — it passes `ref_template=\"/$defs/{model}\"` to Pydantic — and its own " +
        "`output_format` path inlines such refs first, commented \"Anthropic doesn't support " +
        "external schema references\". The `tools[].input_schema` path it uses for " +
        "`response_format=<Model>` does not.",
        docUrl || DOCS.openai));
    }
    external.forEach(function (ref) {
      ledger.push(entry("!", "root",
        "`$ref: \"" + ref + "\"` points outside this document and there is no matching local " +
        "definition to resolve it against. No provider fetches external schema references — the " +
        "reference arrives dangling. Inline the definition or add it to `$defs`.",
        docUrl || DOCS.openai));
    });
    return s;
  }

  // A `$ref` that STARTS with `#` is a pointer into this same document, so
  // `normalizeRefSpelling` above skips it — it only ever inspected the refs that
  // do not. That left the other half unchecked: a local pointer whose TARGET is
  // absent. Nothing in the pipeline notices, because every rule that reads a
  // ref asks "where does this point?" and then quietly does nothing when the
  // answer is nowhere. `--check --to openai` exited 0 on it while
  // `toStrictJsonSchema()` throws `Local $ref ... does not resolve`.
  //
  // It is not exotic. It is what a document looks like after something MOVED or
  // DROPPED the definition bag but left the pointers: measured on
  // strands-agents 1.51.0, whose `_flatten_schema`
  // (`strands/tools/structured_output/structured_output_utils.py`) rebuilds the
  // schema from a five-key keep-list — `type`, `properties`, `title`,
  // `description`, `required` — so a `Field(discriminator=...)` union keeps its
  // `oneOf: [{$ref: "#/$defs/Cat"}, ...]` while `$defs` itself, not being on the
  // list, is dropped.
  //
  // Resolution is a real JSON pointer walk, not a string match: `#` alone is the
  // root, `~1` is `/` and `~0` is `~` (RFC 6901), and a numeric token indexes an
  // array. Anything we cannot resolve is REPORTED — the rule fails closed,
  // because "I could not find the target" must never be read as "it is fine"
  // (the inversion that deleted definitions in #320).
  function resolvesLocally(root, ref) {
    if (ref === "#" || ref === "") return true;
    if (ref.charAt(0) !== "#") return false;
    var frag = ref.slice(1);
    if (frag.charAt(0) !== "/") return false; // `#name` — a `$anchor`, not a pointer
    var toks = frag.split("/").slice(1);
    var cur = root;
    for (var i = 0; i < toks.length; i++) {
      var t = decodeURIComponent(toks[i]).replace(/~1/g, "/").replace(/~0/g, "~");
      if (Array.isArray(cur)) {
        if (!/^\d+$/.test(t) || Number(t) >= cur.length) return false;
        cur = cur[Number(t)];
      } else if (isPlainObject(cur)) {
        if (!Object.prototype.hasOwnProperty.call(cur, t)) return false;
        cur = cur[t];
      } else {
        return false;
      }
    }
    // A pointer that lands on a non-schema (a string, a number) is dangling in
    // every sense that matters — the vendor's message says exactly this.
    return isPlainObject(cur) || typeof cur === "boolean";
  }

  function findDanglingLocalRefs(root) {
    var out = [];
    (function visit(v, path) {
      if (Array.isArray(v)) { v.forEach(function (x, i) { visit(x, path + "[" + i + "]"); }); return; }
      if (!isPlainObject(v)) return;
      if (typeof v.$ref === "string" && v.$ref.charAt(0) === "#" && !resolvesLocally(root, v.$ref)) {
        out.push({ ref: v.$ref, path: path });
      }
      Object.keys(v).forEach(function (k) {
        visit(v[k], k === "properties" || k === "$defs" || k === "definitions" ? path : path + "." + k);
      });
    })(root, "root");
    return out;
  }

  // `definitions` is draft-07 (what zod-to-json-schema emits); OpenAI's doc and
  // examples use `$defs`. Rename it and repoint every `$ref` that used it.
  function normalizeDefs(s, ledger, docUrl, why) {
    if (!isPlainObject(s.definitions)) return s;
    if (isPlainObject(s.$defs)) {
      // both present — merge `definitions` in without clobbering `$defs`
      Object.keys(s.definitions).forEach(function (k) {
        if (!(k in s.$defs)) s.$defs[k] = s.definitions[k];
      });
    } else {
      s.$defs = s.definitions;
    }
    delete s.definitions;
    deepRepointRefs(s);
    ledger.push(entry("~", "root",
      why || "Renamed draft-07 `definitions` to `$defs` and repointed every `$ref` — OpenAI's schema dialect uses `$defs`. (zod-to-json-schema emits `definitions`.)",
      docUrl || DOCS.openai));
    return s;
  }

  // Structural (not string-replace) rewrite of #/definitions/X -> #/$defs/X.
  function deepRepointRefs(v) {
    if (Array.isArray(v)) { v.forEach(deepRepointRefs); return; }
    if (!isPlainObject(v)) return;
    if (typeof v.$ref === "string" && v.$ref.indexOf("#/definitions/") === 0) {
      v.$ref = "#/$defs/" + v.$ref.slice("#/definitions/".length);
    }
    Object.keys(v).forEach(function (k) { deepRepointRefs(v[k]); });
  }

  // A root of `{ "$ref": "#/$defs/X", "$defs": {...} }` has no `type`, no
  // `properties` and no `additionalProperties`, so every object rule below
  // silently no-ops on it and the tool reports "already valid" for a schema
  // that is not. Hoist the referenced definition to the root instead.
  // True when the root is a `$ref` whose target is actually present in `$defs`.
  // Used to decide whether inlining is REQUIRED or merely harmless: a pointer
  // with no local target is dead everywhere, so it never qualifies.
  function rootRefResolvesInDefs(s) {
    if (typeof s.$ref !== "string") return false;
    var m = /^#\/\$defs\/(.+)$/.exec(s.$ref);
    if (!m) return false;
    return isPlainObject(s.$defs) && isPlainObject(s.$defs[m[1]]);
  }

  // The container has TWO spellings and so does the pointer into it, and this
  // resolver knew exactly one. On every path where `normalizeDefs` runs first
  // that is invisible, because the rename has already made the spelling `$defs`.
  // The Anthropic TOOLS path does not rename — correctly, since `betaTool()`
  // forwards a nested `definitions` bag verbatim and editing it would be the
  // over-strictness bug this project has shipped repeatedly — so there the
  // draft-07 spelling reached this function untouched, matched nothing, and the
  // root `$ref` was left in place. That is the DEFAULT output of
  // zod-to-json-schema, and `betaTool()` throws on it.
  // Resolve a local pointer against the root document, in BOTH container
  // spellings. Returns null for anything it cannot resolve, so every caller
  // fails closed (#320: a keep-rule that cannot read a reference must not
  // conclude the reference is absent).
  function resolveLocalDef(root, ref) {
    if (typeof ref !== "string") return null;
    var m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
    if (!m) return null;
    var bag = root[m[1]];
    return isPlainObject(bag) && isPlainObject(bag[m[2]]) ? bag[m[2]] : null;
  }

  function rootRefTarget(s) {
    if (typeof s.$ref !== "string") return null;
    var m = /^#\/(\$defs|definitions)\/(.+)$/.exec(s.$ref);
    if (!m) return null;
    var bag = m[1], name = m[2];
    if (!isPlainObject(s[bag]) || !isPlainObject(s[bag][name])) return null;
    return { bag: bag, name: name };
  }

  function inlineRootRef(s, ledger, docUrl, why, blockedOut) {
    var t = rootRefTarget(s);
    if (!t) return s;
    var bag = t.bag, name = t.name;

    var out, merged = null;
    var defs = s[bag];

    // A `$ref` beside CONSTRAINING siblings is an INTERSECTION here too — the
    // root is not a different dialect, only a different position (#371). The
    // referent-wins carry-over below is a PRECEDENCE rule, and precedence is
    // only ever correct for annotations: for anything that constrains, "the
    // referent wins" means "the node's own declarations are deleted". Measured
    // at the root on `{properties:{a}, required:["a"], $ref:T}` whose raw accept
    // set is `0001` (an object must carry BOTH), FOUR of ten targets emitted
    // `0010`/`0011` — the node's own `a` gone, no longer required, at ZERO
    // blockers — while the SAME shape one level down was correct. The two
    // positions disagreed with each other, which is the tell.
    var constraining = Object.keys(s).filter(function (k) {
      return k !== "$ref" && !toleratedRefSibling(k, true, s);
    });

    if (constraining.length) {
      // Already reported by an earlier pass over this same object — compare
      // references, not a structural snapshot: the pipeline mutates this node
      // in between (#371).
      if (Array.isArray(blockedOut) && blockedOut.indexOf(s) !== -1) return s;
      merged = intersectRef(clone(defs[name]), s, constraining, "root", ledger, docUrl);
      if (!merged) {
        // No merge preserves the meaning, so the remodelling is NAMED and the
        // shape is left exactly as written for the reader to see (#318/#329).
        if (Array.isArray(blockedOut)) blockedOut.push(s);
        return s;
      }
      out = merged.schema;
    } else {
      out = clone(defs[name]);
    }

    // carry over any sibling keys the generator left next to `$ref`
    Object.keys(s).forEach(function (k) {
      if (k !== "$ref" && k !== bag && !(k in out)) out[k] = s[k];
    });

    // keep only the definitions something still points at (recursive schemas
    // reference themselves, so `name` may need to stay)
    var remaining = {};
    Object.keys(defs).forEach(function (k) { if (k !== name) remaining[k] = defs[k]; });
    if (JSON.stringify([out, remaining]).indexOf('"#/' + bag + '/' + name + '"') !== -1) {
      remaining[name] = defs[name];
    }
    if (Object.keys(remaining).length) out[bag] = remaining;

    ledger.push(entry("~", "root",
      "Inlined the root `$ref` (`#/" + bag + "/" + name + "`) into the root. " + (why ||
        "OpenAI requires the root to be an object schema, and a bare `$ref` root leaves " +
        "`additionalProperties`/`required` unset on the real object.") +
      (merged
        ? " The root also declared `" + constraining.join("`, `") + "` beside the `$ref`, which is " +
          "an INTERSECTION rather than a decoration — draft 2020-12 applies the referenced schema " +
          "AND these siblings — so both sides' declarations were merged instead of letting the " +
          "referent overwrite them." +
          (merged.dropped.length
            ? " Dropped `" + merged.dropped.join("`, `") + "`: a side declaring " +
              "`additionalProperties: false` already forbade " +
              (merged.dropped.length > 1 ? "those properties" : "that property") + ", so no object " +
              "could have carried " + (merged.dropped.length > 1 ? "them" : "it") + " and nothing is lost."
            : "")
        : ""),
      docUrl || DOCS.openai));
    return out;
  }

  // OpenAI supports `$ref`, but rejects a `$ref` that carries sibling keywords:
  //   Invalid schema ... context=('properties','x'), $ref cannot have keywords {'description'}
  // Pydantic emits exactly that shape for any field whose type is a nested model
  // or Enum AND which has a Field(description=...) — verified against pydantic
  // 2.13.4. A plain `str` field with a description does NOT produce it, which is
  // why the failure looks maddeningly input-dependent.
  // Fix: inline the referenced definition at the use site and let the siblings
  // win. Bare `$ref`s (no siblings) are left alone — those are legal.
  // A `$ref` beside CONSTRAINING siblings is an INTERSECTION, not a decoration
  // on the referent. #370 established that for `allOf`; this is the same
  // operation in its other spelling — draft 2020-12 applies the referent AND the
  // siblings, so `{properties:{a}, required:["a"], $ref:T}` means "an `a` AND
  // whatever T requires". We implemented it as an OVERWRITE (`target[k] =
  // node[k]`), i.e. #349's parent-wins bug living in the function next door: a
  // node that declared `properties` silently DISCARDED the referent's entire
  // `properties` and `required`, at zero blockers.
  //
  // Measured on one nested shape whose raw accept set is `0001` (an object must
  // carry both `a` and `b`), across all ten targets: three pass it through
  // untouched and are correct; SIX emitted `0101` or `0100` — `b` no longer
  // typed, no longer required — and `gemini-json` emitted `0011`, dropping the
  // node's OWN `a` instead. Three different wrong answers, none of them either
  // dialect's reading (draft-07 IGNORES `$ref` siblings, so it means only the
  // referent; 2020-12 intersects, so it means both), and every one of them
  // silent.
  //
  // So merge, and apply #370's closed-branch restriction: a branch declaring
  // `additionalProperties: false` forbids every property it does not itself
  // declare, so the merged property set is the union RESTRICTED to every closed
  // branch's own declarations, and a required name outside that intersection
  // makes the schema unsatisfiable — no repair exists, so name it (#329).
  function intersectRef(target, node, siblings, path, ledger, docUrl) {
    var closedSets = [];
    [target, node].forEach(function (b) {
      if (isPlainObject(b) && b.additionalProperties === false) {
        closedSets.push(Object.keys(isPlainObject(b.properties) ? b.properties : {}));
      }
    });
    var allowed = null;
    if (closedSets.length) {
      allowed = closedSets[0].slice();
      closedSets.slice(1).forEach(function (st) {
        allowed = allowed.filter(function (k) { return st.indexOf(k) !== -1; });
      });
    }
    var isAllowed = function (k) { return allowed === null || allowed.indexOf(k) !== -1; };

    var req = [];
    [target, node].forEach(function (b) {
      (Array.isArray(b && b.required) ? b.required : []).forEach(function (k) {
        if (req.indexOf(k) === -1) req.push(k);
      });
    });
    var excluded = req.filter(function (k) { return !isAllowed(k); });
    if (excluded.length) {
      ledger.push(entry("!", path,
        "This `$ref` and its siblings cannot both be satisfied. A `$ref` beside constraining " +
        "siblings is an INTERSECTION — draft 2020-12 applies the referenced schema AND the " +
        "siblings — and one side declares `additionalProperties: false`, which forbids every " +
        "property it does not itself declare. The properties allowed by both together are [" +
        (allowed && allowed.length ? "`" + allowed.join("`, `") + "`" : "none") + "], while `" +
        excluded.join("`, `") + "` " + (excluded.length > 1 ? "are" : "is") + " required, so no " +
        "object can satisfy this node. We will not merge it for you: taking the union would " +
        "silently ADMIT " + (excluded.length > 1 ? "properties" : "a property") + " the schema " +
        "forbids. Either drop `additionalProperties: false` from the closed side, or declare `" +
        excluded.join("`, `") + "` there too.",
        docUrl || DOCS.openai));
      return null;
    }

    // Same property declared on both sides with DIFFERENT subschemas: the true
    // meaning is the intersection of the two, which strict mode cannot express,
    // and picking either side would silently change what is accepted (#347).
    var tProps = isPlainObject(target.properties) ? target.properties : null;
    var nProps = isPlainObject(node.properties) ? node.properties : null;
    if (tProps && nProps) {
      var clash = null;
      Object.keys(nProps).forEach(function (k) {
        if (clash === null && k in tProps && canonical(tProps[k]) !== canonical(nProps[k])) clash = k;
      });
      if (clash !== null) {
        ledger.push(entry("!", path,
          "This node and the schema its `$ref` points at both declare a property `" + clash +
          "`, with different shapes. A `$ref` beside constraining siblings is an INTERSECTION, so " +
          "the real meaning is \"satisfies BOTH\" — which strict mode cannot express, and picking " +
          "either side would silently change what this schema accepts. Declare `" + clash +
          "` once, with the shape you actually mean.",
          docUrl || DOCS.openai));
        return null;
      }
    }

    var out = clone(target);
    if (nProps) {
      if (!isPlainObject(out.properties)) out.properties = {};
      Object.keys(nProps).forEach(function (k) {
        if (!(k in out.properties)) out.properties[k] = clone(nProps[k]);
      });
    }
    if (req.length) out.required = req.slice();
    siblings.forEach(function (k) {
      if (k === "properties" || k === "required") return;
      out[k] = clone(node[k]);
    });

    // Lossless by construction: every name removed here is one a closed side
    // already forbade, so no instance that was legal before becomes illegal.
    // Reported rather than silent — a property vanishing is exactly the edit a
    // reader must see (#318).
    var dropped = [];
    if (allowed !== null && isPlainObject(out.properties)) {
      Object.keys(out.properties).forEach(function (k) { if (!isAllowed(k)) dropped.push(k); });
      dropped.forEach(function (k) { delete out.properties[k]; });
      if (Array.isArray(out.required)) {
        out.required = out.required.filter(isAllowed);
      }
    }
    return { schema: out, dropped: dropped };
  }

  function resolveRefSiblings(s, ledger, docUrl, whyFixed, whyRecursive, blockedOut) {
    if (!isPlainObject(s.$defs)) return s;
    var defs = s.$defs, fixed = 0, unresolved = [], blocked = 0, droppedNames = [];

    function visit(node, stack, path) {
      if (Array.isArray(node)) {
        return node.map(function (n, i) { return visit(n, stack, path + "[" + i + "]"); });
      }
      if (!isPlainObject(node)) return node;
      var blockedHere = false;

      // `$defs` is the definition bag, not a constraining sibling: `{$ref, $defs}`
      // is the canonical root-ref shape every generator emits, and counting it
      // here would force an inline even where the vendor resolves the pointer
      // correctly. Every other target inlines a root `$ref` earlier anyway, so
      // this only changes the one path that deliberately does not.
      var siblings = Object.keys(node).filter(function (k) {
        return k !== "$ref" && k !== "$defs";
      });
      var m = typeof node.$ref === "string" ? /^#\/\$defs\/(.+)$/.exec(node.$ref) : null;

      // `inlineRootRef` owns the root and may already have blocked this exact
      // object. Compare REFERENCES (#371): re-reporting it here would print the
      // same finding twice, and the two functions build paths differently, so a
      // path-string agreement is not available to key on.
      var alreadyBlocked = Array.isArray(blockedOut) && blockedOut.indexOf(node) !== -1;
      if (m && siblings.length && isPlainObject(defs[m[1]]) && !alreadyBlocked) {
        var name = m[1];
        if (stack.indexOf(name) !== -1) {
          if (unresolved.indexOf(name) === -1) unresolved.push(name);
        } else {
          var target = visit(clone(defs[name]), stack.concat([name]), path);
          var visited = {};
          siblings.forEach(function (k) { visited[k] = visit(node[k], stack, path); });
          var merged = intersectRef(target, visited, siblings, path, ledger, docUrl);
          if (merged) {
            fixed++;
            merged.dropped.forEach(function (k) {
              if (droppedNames.indexOf(k) === -1) droppedNames.push(k);
            });
            return merged.schema;
          }
          // Blocked: leave the shape exactly as written so the reader can see
          // what to remodel (#318). Nothing is silently repaired. Record the
          // node's structural identity so the exit-side `$ref`-sibling blocker
          // does not report the SAME node a second time with a remedy that does
          // not apply here (#359: when two rules can reach one node, the
          // boundary between them is part of the design).
          blocked++;
          blockedHere = true;
        }
      }

      var out = {};
      Object.keys(node).forEach(function (k) { out[k] = visit(node[k], stack, path + "/" + k); });
      // Track the object we hand back BY IDENTITY, not by a snapshot: the rest
      // of the pipeline mutates this node (it gains `additionalProperties`, its
      // `required` is rewritten), so a structural fingerprint taken here would
      // no longer match by the time the exit-side check runs.
      // Chain the identity onto the object we actually hand back. This walk
      // REBUILDS every node, so a reference recorded upstream stops matching the
      // moment we return — and the root inliner runs again after us (#363), on
      // the rebuilt object. Re-keying here is what makes the suppression
      // survive the rebuild; without it the same blocker prints twice.
      if ((blockedHere || alreadyBlocked) && Array.isArray(blockedOut)) blockedOut.push(out);
      return out;
    }

    var result = visit(s, [], "root");
    // once refs are inlined the definitions they pointed at may be orphaned;
    // dead `$defs` still count against OpenAI's 5000-property budget.
    // This decides what to KEEP by looking for references, so per #320 it must
    // fail CLOSED: "I could not find a reference to this" is not "nothing
    // references this." It used to be a raw string match for `"#/$defs/<name>"`,
    // which missed two ordinary spellings of the SAME pointer and deleted a
    // live definition:
    //   * RFC 6901 escapes — a definition named `a/b` is referenced as
    //     `#/$defs/a~1b`, so the literal search never matched it;
    //   * a pointer INTO a definition — `#/$defs/T/properties/x` does not
    //     contain `"#/$defs/T"` (the closing quote is not there).
    // Both left a dangling `$ref` in output that was intact on input. Collect
    // the referenced names STRUCTURALLY instead, and if anything is unparseable,
    // prune nothing — the pruner is only a size optimisation (dead `$defs`
    // count against OpenAI's 5000-property budget), so skipping it is free
    // while a wrong deletion is not.
    if (isPlainObject(result.$defs)) {
      var referenced = {}, bailOut = false;
      (function scan(v) {
        if (bailOut) return;
        if (Array.isArray(v)) { v.forEach(scan); return; }
        if (!isPlainObject(v)) return;
        if (typeof v.$ref === "string") {
          var m = /^#\/\$defs\/([^/]+)/.exec(v.$ref);
          if (m) {
            referenced[decodeURIComponent(m[1]).replace(/~1/g, "/").replace(/~0/g, "~")] = true;
          } else if (v.$ref.charAt(0) === "#" && v.$ref !== "#") {
            // A local pointer we cannot attribute to a `$defs` entry. Rather
            // than guess it is unrelated, stop pruning altogether.
            bailOut = true;
          }
        }
        Object.keys(v).forEach(function (k) { scan(v[k]); });
      })(result);

      if (!bailOut) {
        var kept = {};
        Object.keys(result.$defs).forEach(function (k) {
          if (referenced[k]) kept[k] = result.$defs[k];
        });
        if (Object.keys(kept).length) result.$defs = kept; else delete result.$defs;
      }
    }
    if (fixed) {
      ledger.push(entry("~", "root",
        "Inlined " + fixed + " `$ref` that carried sibling keywords — " + (whyFixed ||
          "OpenAI rejects those with \"$ref cannot have keywords\"." ) +
        " Pydantic emits this for a nested-model or Enum field that also has a `description`. " +
        "Where the siblings constrain (`properties`/`required`), this is a MERGE, not an " +
        "overwrite: a `$ref` beside constraining siblings is an intersection, so the referent's " +
        "declarations are kept alongside the node's own.",
        docUrl || DOCS.openai));
    }
    if (droppedNames.length) {
      ledger.push(entry("~", "root",
        "Dropped `" + droppedNames.join("`, `") + "` while merging a `$ref` with its siblings: one " +
        "side declares `additionalProperties: false` without declaring " +
        (droppedNames.length > 1 ? "them" : "it") + ", so no object could ever have carried " +
        (droppedNames.length > 1 ? "them" : "it") + " and keeping " +
        (droppedNames.length > 1 ? "them" : "it") + " would WIDEN what this schema accepts. If you " +
        "meant " + (droppedNames.length > 1 ? "these" : "this") + " to be usable, declare " +
        (droppedNames.length > 1 ? "them" : "it") + " on the closed side too.",
        docUrl || DOCS.openai));
    }
    unresolved.forEach(function (name) {
      ledger.push(entry("!", "root",
        "`" + name + "` is recursive and its `$ref` carries sibling keywords, which " + (whyRecursive ||
          "OpenAI rejects") + ". Move those keywords into the definition itself — a recursive `$ref` " +
        "cannot be inlined.",
        docUrl || DOCS.openai));
    });
    return result;
  }

  // Key-order-independent structural identity, so two tuple entries that a
  // generator emitted with the same shape compare equal regardless of key order.
  function canonical(v) {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (isPlainObject(v)) {
      return "{" + Object.keys(v).sort().map(function (k) {
        return JSON.stringify(k) + ":" + canonical(v[k]);
      }).join(",") + "}";
    }
    return JSON.stringify(v);
  }

  // ---- oneOf exclusivity (OpenAI strict) -----------------------------------
  //
  // `oneOf` means EXACTLY ONE branch matches; `anyOf` means AT LEAST ONE. So
  // rewriting one to the other is only lossless when the branches cannot both
  // match. Rewriting unconditionally silently WIDENS the schema, which is the
  // same class of harm as silently stripping it.
  //
  // This is not our judgement call — it is openai@7.4.0's. The five builders in
  // `helpers/zod.js` run only `toStrictJsonSchema()`, which passes `oneOf`
  // through untouched. But `helpers/standard-schema.js` (four MORE builders,
  // uncounted until now) runs `normalizeStructuredOutputSchema()` first, and
  // that function rewrites `oneOf` to `anyOf` ONLY when it can prove the
  // branches mutually exclusive. When it cannot, it throws:
  //
  //   "Standard JSON Schema generated a `oneOf` whose branches are not provably
  //    mutually exclusive. OpenAI strict schemas do not support `oneOf`; use
  //    `anyOf` or add a discriminator with distinct literal values."
  //
  // The proof below mirrors the vendor's, deliberately clause for clause. It
  // must not be MORE conservative than theirs: a schema they accept and we
  // block is a false CI failure, which is the bug this project keeps shipping
  // (#312, #314, #317). The test suite pins our verdict against theirs.
  var ANNOTATION_KW = {
    $comment: 1, "default": 1, description: 1, examples: 1,
    readOnly: 1, title: 1, writeOnly: 1
  };
  var JSON_SCHEMA_TYPES = {
    string: 1, number: 1, integer: 1, boolean: 1, object: 1, array: 1, "null": 1
  };

  function isJSONPrimitive(v) {
    return v === null || typeof v === "string" || typeof v === "boolean" ||
      (typeof v === "number" && isFinite(v));
  }

  // `const`, else a fully-primitive `enum`. Anything else: not a literal node.
  function literalValues(node) {
    if (!isPlainObject(node)) return null;
    if ("const" in node && isJSONPrimitive(node["const"])) return [node["const"]];
    var e = node.enum;
    if (Array.isArray(e) && e.length && e.every(isJSONPrimitive)) return e;
    return null;
  }

  function schemaTypes(node) {
    if (!isPlainObject(node)) return null;
    if (node.type === undefined) {
      var lits = literalValues(node);
      if (!lits) return null;
      return lits.map(function (v) { return v === null ? "null" : typeof v; });
    }
    var types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.length) return null;
    if (!types.every(function (t) { return typeof t === "string" && JSON_SCHEMA_TYPES[t]; })) return null;
    return types;
  }

  // `integer` is a subset of `number`, so those two overlap.
  function typesOverlap(a, b) {
    return a === b ||
      (a === "integer" && b === "number") ||
      (a === "number" && b === "integer");
  }

  function disjointLiterals(l, r) {
    var lv = literalValues(l), rv = literalValues(r);
    if (!lv || !rv) return false;
    return lv.every(function (a) {
      return !rv.some(function (b) { return a === b; });
    });
  }

  function objectOnly(node) {
    var t = schemaTypes(node);
    return !!t && t.length === 1 && t[0] === "object";
  }

  // Two closed objects that each require a property the other does not declare
  // can never both validate: the extra key is rejected as an additional
  // property by whichever branch omits it.
  function closedPropertySet(node) {
    if (!objectOnly(node)) return null;
    var props = node.properties, req = node.required;
    if (node.additionalProperties !== false) return null;
    if (!isPlainObject(props) || !Array.isArray(req)) return null;
    if (!req.every(function (p) { return typeof p === "string"; })) return null;
    var declared = Object.keys(props);
    // A required-but-undeclared property makes the branch unsatisfiable; leave
    // that to normal validation rather than treating it as a proof.
    if (req.some(function (p) { return declared.indexOf(p) === -1; })) return null;
    return { declared: declared, required: req };
  }

  function disjointClosedObjects(l, r) {
    var ls = closedPropertySet(l), rs = closedPropertySet(r);
    if (!ls || !rs) return false;
    return ls.required.some(function (p) { return rs.declared.indexOf(p) === -1; }) ||
      rs.required.some(function (p) { return ls.declared.indexOf(p) === -1; });
  }

  // A shared required property whose literal values are disjoint = a
  // discriminated union, the shape the vendor's error message recommends.
  function disjointDiscriminator(l, r, root) {
    if (!objectOnly(l) || !objectOnly(r)) return false;
    var lp = l.properties, rp = r.properties, lr = l.required, rr = r.required;
    if (!isPlainObject(lp) || !isPlainObject(rp)) return false;
    if (!Array.isArray(lr) || !Array.isArray(rr)) return false;
    return lr.some(function (p) {
      if (typeof p !== "string" || rr.indexOf(p) === -1) return false;
      return disjointLiterals(exclResolve(lp[p], root), exclResolve(rp[p], root));
    });
  }

  function hasOnlyRefAndAnnotations(node) {
    return Object.keys(node).every(function (k) {
      return k === "$ref" || k === "$defs" || k === "definitions" || ANNOTATION_KW[k];
    });
  }

  // Follow a local `$ref` only when it carries no sibling CONSTRAINTS — a
  // sibling `minLength` beside a `$ref` changes what the branch accepts, so the
  // target alone would not prove anything. Returns undefined = unprovable.
  function exclResolve(node, root, seen) {
    if (!isPlainObject(node)) return node;
    seen = seen || {};
    if (node.$ref !== undefined) {
      if (typeof node.$ref !== "string" || !hasOnlyRefAndAnnotations(node)) return undefined;
      if (seen[node.$ref]) return undefined;
      var target = derefLocal(root, node.$ref);
      if (target === undefined) return undefined;
      var next = {};
      Object.keys(seen).forEach(function (k) { next[k] = 1; });
      next[node.$ref] = 1;
      return exclResolve(target, root, next);
    }
    return node;
  }

  // "#/$defs/A" style pointers only; anything else is not locally resolvable.
  function derefLocal(root, ref) {
    if (ref.charAt(0) !== "#") return undefined;
    var body = ref.slice(1);
    if (body === "" || body === "/") return root;
    if (body.charAt(0) !== "/") return undefined;
    var parts = body.slice(1).split("/");
    var cur = root;
    for (var i = 0; i < parts.length; i++) {
      var key = decodeURIComponent(parts[i]).replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isPlainObject(cur) && !Array.isArray(cur)) return undefined;
      if (!(key in cur)) return undefined;
      cur = cur[key];
    }
    return cur;
  }

  function mutuallyExclusive(l, r, root) {
    var lt = schemaTypes(l), rt = schemaTypes(r);
    if (lt && rt && lt.every(function (a) {
      return rt.every(function (b) { return !typesOverlap(a, b); });
    })) return true;
    return disjointLiterals(l, r) ||
      disjointDiscriminator(l, r, root) ||
      disjointClosedObjects(l, r);
  }

  // OpenAI strict mode refuses `anyOf` on a node that ALSO has object shape:
  // "Object anyOf schema at `X` cannot be represented in strict Structured
  // Outputs without changing Draft 7 validation." Mirrored from
  // openai@7.4.0 lib/transform.js clause for clause, INCLUDING its escape hatch,
  // because a blanket rule here would be the over-strictness class this project
  // has shipped repeatedly: when the node is a bare `{"type": "object"}` wrapper
  // carrying no object keywords of its own and every branch is object-only, the
  // vendor deletes the redundant `type` and accepts (its own comment: the union
  // already excludes null and every non-object value). Measured both ways —
  // adding `additionalProperties: false`, adding `properties`, or making one
  // branch a scalar each flips it back to a throw.
  var OPENAI_OBJECT_KEYWORDS = ["additionalProperties", "dependencies", "maxProperties",
    "minProperties", "patternProperties", "properties", "propertyNames", "required"];

  function hasOpenAIObjectShape(node) {
    var t = node.type;
    if (t === "object") return true;
    if (Array.isArray(t) && t.indexOf("object") !== -1) return true;
    if (t === undefined) {
      return OPENAI_OBJECT_KEYWORDS.some(function (k) { return k in node; });
    }
    return false;
  }

  // Would giving this node an `anyOf` of `branches` make the vendor throw?
  function openaiObjectUnionThrows(node, branches, root) {
    // No union on this node, nothing for the vendor to refuse. This guard is
    // load-bearing: without it the function reports "throws" for every ordinary
    // object node, and the sweep measured 26 corpus schemas over-blocked that
    // the vendor accepts as written. An empty `anyOf: []` still counts as a
    // union — the vendor tests `Array.isArray`, not length (#347).
    if (!Array.isArray(branches)) return false;
    if (!hasOpenAIObjectShape(node)) return false;
    var t = node.type;
    // The hatch needs `type` to be a redundant object wrapper — exactly "object",
    // or a union of nothing but "object"/"null".
    var redundant = t === "object" ||
      (Array.isArray(t) && t.indexOf("object") !== -1 &&
        t.every(function (x) { return x === "object" || x === "null"; }));
    if (!redundant) return true;
    if (OPENAI_OBJECT_KEYWORDS.some(function (k) { return k in node; })) return true;
    // Every branch must be object-only. Unresolvable branches count as NOT
    // object-only: guessing "safe" here manufactures a vendor rejection, while
    // guessing "unsafe" only costs a note on a schema that would have worked.
    return !branches.every(function (b) {
      var r = isPlainObject(b) && typeof b.$ref === "string" ? resolveLocalDef(root, b.$ref) : b;
      if (!isPlainObject(r)) return false;
      if (r.type === "object") return true;
      return Array.isArray(r.type) && r.type.length && r.type.every(function (x) { return x === "object"; });
    });
  }

  function oneOfProvablyExclusive(branches, root) {
    if (!Array.isArray(branches)) return false;
    // `false` can never validate, so it cannot overlap anything.
    var live = branches.filter(function (b) { return b !== false; });
    for (var i = 0; i < live.length; i++) {
      for (var j = i + 1; j < live.length; j++) {
        var l = exclResolve(live[i], root), r = exclResolve(live[j], root);
        if (l === undefined || r === undefined) return false;
        if (!mutuallyExclusive(l, r, root)) return false;
      }
    }
    return true;
  }

  // OpenAI strict mode has NO tuple form. openai@7.4.0's toStrictJsonSchema
  // throws on `prefixItems` ("uses unsupported keyword `prefixItems`") and on
  // array-form `items` ("uses tuple-form `items`"). A fixed-length tuple whose
  // entries are all the same schema is exactly a fixed-length array, so it
  // converts losslessly to `items` + `minItems`/`maxItems`. A heterogeneous
  // tuple is genuinely not representable: collapsing it would either widen it
  // (union of the entries, losing per-position typing) or drop positions
  // entirely. That is a human fix, so it becomes a blocker rather than a
  // silent rewrite. Returns true when the tuple keyword must be left in place.
  // `why` names the provider-specific reason a tuple cannot survive; both
  // OpenAI strict mode and Anthropic's structured-output transformer lack a
  // tuple form, but they fail differently, so the message must not be shared
  // blindly. (#314's rule: do not port one provider's wording or policy to
  // another without reading what that provider actually does.)
  function normalizeTuple(node, path, ledger, docUrl, whyBlocked, whyCollapsed) {
    var tuple = null, kw = null;
    if (Array.isArray(node.prefixItems)) { tuple = node.prefixItems; kw = "prefixItems"; }
    else if (Array.isArray(node.items)) { tuple = node.items; kw = "items"; }
    if (!tuple) return false;

    // An EMPTY tuple is still the tuple FORM. This guard used to read
    // `!tuple.length` — it tested the array's VALUE where every destination
    // tests its SHAPE ("is `items` an array?"), so a zero-length array fell
    // through as "nothing to do" and the draft-07 spelling survived into the
    // output. Measured 2026-08-09 on `{"type":"array","items":[]}`, which is
    // the VERBATIM zod 4.4.3 rendering of `z.tuple([])` with
    // `target: "draft-7"`: toStrictJsonSchema THROWS ("uses tuple-form
    // `items`"), @anthropic-ai/sdk 0.116.0 THROWS, anthropic 0.121.0 RAISES
    // TypeError("'list' object is not a mapping") so the request is never
    // built, anthropic-sdk-go v1.62.0 returns `schema: null` for the WHOLE
    // document, and google-genai 2.17.0 `types.Schema` REJECTS it. We exited
    // 0 on the first four and, on narrow Gemini, exited 1 for an unrelated
    // edit while leaving `items: []` in the output the user was told to
    // commit.
    //
    // Only the `items` spelling is handled here. `prefixItems: []` is already
    // correct on every target (OpenAI blocks it as an unsupported keyword,
    // narrow Gemini strips it, and all three Anthropic SDKs ACCEPT it —
    // demoting it to prose), so touching it would be the stricter-than-the-
    // vendor bug this project has shipped repeatedly.
    if (!tuple.length) {
      if (kw !== "items") return false;
      // Deleting is lossless: array-form `items` applies schema[i] to element
      // i, so with zero schemas no element is constrained and the node means
      // exactly what `{"type": "array"}` means. The one exception is a
      // sibling `additionalItems`, which in draft-07 applies from the first
      // unlisted index — with an empty list that is EVERY element, so
      // `items: [] + additionalItems: S` is precisely `items: S`. Dropping
      // `items` while leaving `additionalItems` behind would widen the schema,
      // because `additionalItems` is ignored without the array form.
      var tail = node.additionalItems;
      if (isPlainObject(tail)) {
        node.items = clone(tail);
        delete node.additionalItems;
        ledger.push(entry("~", path,
          "Rewrote an empty draft-07 tuple (`items: []`) with its `additionalItems` schema as a " +
          "plain `items`. With no positional schemas, `additionalItems` applies to every element, " +
          "so this is the same constraint in a spelling the destination accepts — and it has to " +
          "move, because `additionalItems` is ignored without the array form.",
          docUrl || DOCS.openai));
      } else {
        delete node.items;
        ledger.push(entry("~", path,
          "Removed an empty draft-07 tuple (`items: []`). It is the tuple FORM, which " +
          (whyBlocked || "OpenAI strict mode cannot represent — it has no tuple form.") +
          " With zero positional schemas it constrains no element, so this node already meant " +
          "exactly `{\"type\": \"array\"}` and nothing is lost. (`z.tuple([])` emits this " +
          "verbatim when the target is draft-07; note the generator has ALREADY lost the " +
          "\"exactly zero elements\" part — if you meant that, add `maxItems: 0`.)",
          docUrl || DOCS.openai));
      }
      return false;
    }

    var head = canonical(tuple[0]);
    var homogeneous = tuple.every(function (t) { return canonical(t) === head; });

    if (!homogeneous) {
      ledger.push(entry("!", path,
        "This is a " + tuple.length + "-element tuple with differently-typed positions (`" + kw + "`). " +
        (whyBlocked ||
          "OpenAI strict mode cannot represent it — it has no tuple form.") +
        " Model it as an object with one named property per position instead; that keeps each " +
        "position's type and is what the model fills in more reliably anyway.",
        docUrl || DOCS.openai));
      return true;
    }

    var n = tuple.length;
    node.items = clone(tuple[0]);
    if (kw === "prefixItems") delete node.prefixItems;
    if (node.minItems === undefined) node.minItems = n;
    if (node.maxItems === undefined) node.maxItems = n;
    ledger.push(entry("~", path,
      "Collapsed a " + n + "-element tuple (`" + kw + "`) into `items` with `minItems`/`maxItems` of " + n +
      ". " + (whyCollapsed ||
        "OpenAI strict mode has no tuple form, but every position here has the same schema, so the " +
        "fixed length survives as a constraint."),
      docUrl || DOCS.openai));
    return false;
  }

  function toOpenAI(schema) {
    var s = clone(schema);
    var ledger = [];

    // Captured BEFORE anything runs: the rootless-root diagnostic below depends
    // on whether a definition bag arrived, and the orphan-`$defs` pruner deletes
    // exactly that bag on its way past (nothing references it, precisely
    // because the pointer is what went missing). Reading it at the end reads it
    // after the evidence has been cleaned up.
    var bagAtEntry = isPlainObject(schema.$defs) ? "$defs"
      : (isPlainObject(schema.definitions) ? "definitions" : null);

    s = normalizeRefSpelling(s, ledger);
    s = normalizeDefs(s, ledger);
    var refIntersectBlocked = [];
    s = inlineRootRef(s, ledger, undefined, undefined, refIntersectBlocked);
    s = resolveRefSiblings(s, ledger, undefined, undefined, undefined, refIntersectBlocked);

    // These two entry-side blockers are kept for their PROVENANCE: they can say
    // "you wrote this", and the union one names the spelling the caller actually
    // used (#362). They cannot be the only root checks, because the walk below
    // MANUFACTURES both of these shapes out of a flattened `allOf` — see the
    // exit-side pass after the walk, which is what finally decides.
    var rootShapeBlocked = false;
    if (s.type && s.type !== "object") {
      rootShapeBlocked = true;
      ledger.push(entry("!", "root",
        "Root must be an object. OpenAI strict mode rejects a non-object root — wrap your schema in an object.",
        DOCS.openai));
    }
    // BOTH spellings, and the `oneOf` half is not hypothetical: this blocker used
    // to read `if (s.anyOf)` and runs BEFORE the walk, where `oneOf` is rewritten
    // to `anyOf` — so a root `oneOf` sailed past the check and the walk then
    // manufactured exactly the `anyOf` root this rule exists to catch. The two
    // are one keyword apart in the real generator: pydantic 2.13.4 emits a root
    // `anyOf` for `RootModel[Union[A, B]]` and a root `oneOf` for the SAME union
    // once you add `Field(discriminator=...)`, so adding a discriminator — the
    // more precise, recommended form — was what turned a correct blocker into a
    // "fix" whose output openai@7.4.0 rejects.
    //
    // Fatal in either spelling, measured: left as `oneOf` the root has no `type`
    // (`Root schema must have type: 'object' but got type: undefined`); rewritten
    // to `anyOf` it hits `Root schema must not use \`anyOf\``. There is no root
    // form of a union, which is why this names a remodelling instead of a repair.
    if (s.anyOf || s.oneOf) {
      rootShapeBlocked = true;
      ledger.push(entry("!", "root",
        "Root schema cannot use `" + (s.anyOf ? "anyOf" : "oneOf") + "`. OpenAI strict mode has no " +
        "union root at all: as `oneOf` the root carries no `type` (`Root schema must have type: " +
        "'object'`), and as `anyOf` it is refused outright (`Root schema must not use \`anyOf\``). " +
        "Move the union under a named property — `{\"type\": \"object\", \"properties\": " +
        "{\"result\": <your union>}, \"required\": [\"result\"], \"additionalProperties\": false}` — " +
        "which keeps every branch intact.",
        DOCS.openai));
    }

    // Measured against openai@7.4.0's toStrictJsonSchema(): a boolean at any of
    // the six sub-schema positions throws `Expected object schema but got
    // boolean`, and a boolean ROOT throws `Root schema must have type: 'object'`.
    // Eight positions, eight throws — so this is a blocker, not over-strictness.
    findBooleanSubschemas(s).forEach(function (h) {
      ledger.push(entry("!", h.path,
        booleanSubschemaMessage(h.value,
          "OpenAI strict mode rejects it: `toStrictJsonSchema()` throws " +
          "`Expected object schema but got boolean`."),
        DOCS.openai));
    });

    walk(s, "root", function (node, path) {
      // `allOf` is NOT flatly unsupported, and treating it that way deleted
      // whole subschemas. Measured against openai@7.4.0's toStrictJsonSchema:
      //   allOf with ONE member                  -> flattened, annotations kept
      //   allOf of OPEN objects (no additionalProperties:false)
      //                                          -> merged (properties+required)
      //   allOf of CLOSED objects                -> throws, "cannot be merged
      //                                             without changing Draft 7 validation"
      //   allOf of non-objects, 2+ members       -> throws, unsupported keyword
      // We had a blanket strip, so `{allOf:[<object>], description:"..."}` —
      // exactly what Pydantic emits for a $ref'd model with a field
      // description — came out as `{"description":"..."}`: the entire shape
      // gone, reported as a successful fix. Silent widening, again.
      var allOfBlocked = false;
      if (Array.isArray(node.allOf) && node.allOf.length) {
        // A `$ref` MEMBER is a branch of the intersection, not an opaque token —
        // and we treated it as opaque, so the mergeability test (which demands
        // `type: "object"` and `properties` on every member) saw a member with
        // neither and BLOCKED. Measured on openai@7.4.0: the standard OpenAPI
        // "extend this base schema" idiom — `{properties:{a},required:["a"],
        // allOf:[{$ref:Base}]}` and `{allOf:[{$ref:Base},{...}]}` — is ACCEPTED
        // by the vendor with the merged property set and its accept set
        // PRESERVED EXACTLY, and we failed the gate on it. That is the
        // over-strictness class this project has now shipped ~10 times.
        //
        // Resolve first, then let the existing intersection merge decide. The
        // guards are what keep every currently-passing shape byte-identical:
        //   * only when the node itself constrains, or there are 2+ members —
        //     so `{allOf:[{$ref}]}` and the Pydantic v1 `{description,
        //     allOf:[{$ref}]}` still come out as a `$ref` beside annotations,
        //     the form the vendor accepts and #349 pinned;
        //   * only for OBJECT referents — a `$ref` to a scalar is a shape the
        //     vendor throws on, and resolving it would route an unsatisfiable
        //     node through a merge that reports success;
        //   * fail closed on anything unresolvable, chained or recursive, so a
        //     dangling pointer still reaches the blocker that owns it (#320).
        var refMemberNeedsMerge =
          isPlainObject(node.properties) || Array.isArray(node.required) || node.allOf.length > 1;
        var refMembersResolved = 0;
        if (refMemberNeedsMerge) {
          node.allOf = node.allOf.map(function (m) {
            if (!isPlainObject(m) || typeof m.$ref !== "string") return m;
            var extra = Object.keys(m).filter(function (k) { return k !== "$ref"; });
            if (!extra.every(function (k) { return OPENAI_ANNOTATION_KEYWORDS[k]; })) return m;
            var tgt = resolveLocalDef(s, m.$ref);
            if (!tgt || typeof tgt.$ref === "string") return m;
            if (!(tgt.type === "object" || isPlainObject(tgt.properties))) return m;
            if (JSON.stringify(tgt).indexOf(m.$ref) !== -1) return m; // recursive
            var res = clone(tgt);
            extra.forEach(function (k) { if (!(k in res)) res[k] = clone(m[k]); });
            refMembersResolved++;
            return res;
          });
        }
        if (refMembersResolved) {
          ledger.push(entry("~", path,
            "Resolved " + refMembersResolved + " `$ref` member" + (refMembersResolved === 1 ? "" : "s") +
            " of this `allOf` into the schema " + (refMembersResolved === 1 ? "it points" : "they point") +
            " at, so the merge below can see what " + (refMembersResolved === 1 ? "it declares" : "they declare") +
            ". This is the standard \"extend a base schema\" shape; OpenAI's transformer merges it " +
            "and we used to fail the gate on it, because a `$ref` member declares no `properties` " +
            "of its own and the mergeability test could not look through it.",
            DOCS.openai));
        }
        var members = node.allOf;

        // An `allOf` is an INTERSECTION, and a branch that declares
        // `additionalProperties: false` FORBIDS every property it does not
        // itself declare. So the merged property set is not the UNION of the
        // branches — it is the union RESTRICTED to every closed branch's own
        // declarations. openai@7.4.0 computes exactly that
        // (transform.js:1496-1505, "A closed branch forbids every property it
        // does not declare") and REFUSES the merge outright when a REQUIRED
        // property falls outside the intersection, because no object can then
        // satisfy the schema.
        //
        // We unioned, and never looked at any branch's `additionalProperties`
        // at all — the N-member guard below checks the MEMBERS' and the
        // single-member path short-circuits past it entirely (#349's shape: the
        // N=1 special case skipping a condition the general path enforces).
        // Measured on openai@7.4.0 over the 16-cell node×member grid at a
        // NESTED position: 8 shapes whose raw accept set is EMPTY (ajv 2020-12,
        // i.e. no instance can ever satisfy them) came out SATISFIABLE, at zero
        // blockers, with the ledger claiming "OpenAI's own transformer performs
        // the same merge" — which the same run measures as false, the vendor
        // throws on every one. And one shape the vendor ACCEPTS and preserves
        // EXACTLY (closed node + an optional member property) came out with a
        // different accept set, because we admitted a property the schema
        // forbade. Acceptance bought by changing what the schema means is not a
        // repair (#347).
        var allOfBranches = [node].concat(members);
        var closedSets = [];
        allOfBranches.forEach(function (b) {
          if (isPlainObject(b) && b.additionalProperties === false) {
            closedSets.push(Object.keys(isPlainObject(b.properties) ? b.properties : {}));
          }
        });
        // `null` means no branch is closed -> nothing is forbidden -> the plain
        // union is correct and this whole rule is a no-op, which is what keeps
        // every currently-passing shape byte-identical.
        var allowedProps = null;
        if (closedSets.length) {
          allowedProps = closedSets[0].slice();
          closedSets.slice(1).forEach(function (st) {
            allowedProps = allowedProps.filter(function (k) { return st.indexOf(k) !== -1; });
          });
        }
        var isAllowed = function (k) {
          return allowedProps === null || allowedProps.indexOf(k) !== -1;
        };
        var allOfRequired = [];
        allOfBranches.forEach(function (b) {
          (Array.isArray(b && b.required) ? b.required : []).forEach(function (k) {
            if (allOfRequired.indexOf(k) === -1) allOfRequired.push(k);
          });
        });
        var excludedRequired = allOfRequired.filter(function (k) { return !isAllowed(k); });

        var mergeable =
          members.length === 1 ||
          members.every(function (m) {
            return isPlainObject(m) && m.type === "object" &&
              isPlainObject(m.properties) && m.additionalProperties !== false;
          });
        if (excludedRequired.length) {
          // No repair exists, so name the remodelling rather than invent one
          // (#329). Merging anyway is what we used to do and it manufactures a
          // schema the author never wrote: every one of these is unsatisfiable
          // as written, and the union silently makes it satisfiable.
          allOfBlocked = true;
          ledger.push(entry("!", path,
            "This `allOf` cannot be satisfied by any object. A branch here declares " +
            "`additionalProperties: false`, which forbids every property that branch does not itself " +
            "declare — so the properties allowed by ALL branches together are [" +
            (allowedProps.length ? "`" + allowedProps.join("`, `") + "`" : "none") + "], while `" +
            excludedRequired.join("`, `") + "` " + (excludedRequired.length > 1 ? "are" : "is") +
            " required. OpenAI's transformer refuses exactly this (\"Object allOf ... cannot be " +
            "merged without changing Draft 7 validation\"). We will not merge it for you: taking the " +
            "union of the branches would silently ADMIT " + (excludedRequired.length > 1 ? "properties" : "a property") +
            " the schema forbids, turning a schema no object can satisfy into one that looks fine. " +
            "Either drop `additionalProperties: false` from the closed branch, or declare `" +
            excludedRequired.join("`, `") + "` there too.",
            DOCS.openai));
        } else if (!mergeable) {
          allOfBlocked = true;
          ledger.push(entry("!", path,
            "`allOf` with " + members.length + " members that OpenAI cannot merge. Its transformer " +
            "merges an `allOf` of OPEN object schemas and flattens a single-member one, but throws on " +
            "anything else — closed objects (`additionalProperties: false`) \"cannot be merged without " +
            "changing Draft 7 validation\", and non-object members are simply unsupported. Express the " +
            "combined shape as one object schema. We will not drop the `allOf` for you: that would " +
            "silently remove every constraint inside it.",
            DOCS.openai));
        } else if (members.length === 1) {
          // A single-member `allOf` is NOT a special case. Measured on
          // openai@7.4.0: the vendor applies the SAME merge it applies to N
          // members — `{properties:{kind},required:["kind"],allOf:[{properties:
          // {a},required:["a"]}]}` comes back carrying BOTH `kind` and `a` with
          // a union `required`. The old code copied a member key only
          // `if (!(k in node))`, i.e. PARENT WINS, so a parent that already had
          // `properties` silently DISCARDED the member's `properties` and
          // `required` — and the ledger line said "Nothing is lost."
          // That reading is right for ANNOTATIONS (title/description belong to
          // the wrapper) and is a deletion for anything that carries
          // constraints. The N-member branch below has always merged correctly;
          // the special case was the broken one.
          var only = isPlainObject(members[0]) ? members[0] : null;
          var onlyProps = only && isPlainObject(only.properties) ? only.properties : null;
          // The vendor throws when the same property name is declared on both
          // sides with DIFFERENT subschemas ("cannot be merged without changing
          // Draft 7 validation"), and accepts when they are identical — so the
          // test is conflict, not duplication. canonical() so key order does
          // not manufacture a conflict.
          var clash = null;
          if (onlyProps && isPlainObject(node.properties)) {
            Object.keys(onlyProps).forEach(function (k) {
              if (clash === null && k in node.properties &&
                  canonical(node.properties[k]) !== canonical(onlyProps[k])) clash = k;
            });
          }
          if (clash !== null) {
            allOfBlocked = true;
            ledger.push(entry("!", path,
              "This node and its single-member `allOf` both declare a property `" + clash + "`, with " +
              "different schemas. OpenAI's transformer refuses exactly this (\"Object allOf ... cannot " +
              "be merged without changing Draft 7 validation\") and so do we: picking either side would " +
              "silently change what the schema accepts. Declare `" + clash + "` once, with the shape " +
              "you actually mean.",
              DOCS.openai));
          } else {
            if (onlyProps) {
              // Merge, do not overwrite. Union of `properties` and of `required`.
              if (!node.properties) node.properties = {};
              Object.keys(onlyProps).forEach(function (k) {
                if (!(k in node.properties)) node.properties[k] = clone(onlyProps[k]);
              });
              var oneReq = Array.isArray(only.required) ? only.required : [];
              var baseReq = Array.isArray(node.required) ? node.required : [];
              oneReq.forEach(function (k) { if (baseReq.indexOf(k) === -1) baseReq.push(k); });
              if (baseReq.length) node.required = baseReq;
              if (node.type === undefined) node.type = "object";
            }
            if (only) {
              // Everything else (annotations, `$ref`, `type`, …) keeps the
              // wrapper-wins rule, which is what makes the standard Pydantic v1
              // shape — `{title, description, allOf:[{$ref}]}` — come out as a
              // `$ref` beside metadata, the form the vendor accepts.
              Object.keys(only).forEach(function (k) {
                if (k === "properties" || k === "required") return;
                if (!(k in node)) node[k] = clone(only[k]);
              });
            }
            delete node.allOf;
            ledger.push(entry("~", path,
              "Flattened a single-member `allOf` into this node, merging its `properties` and " +
              "`required` with this node's rather than letting either side win — OpenAI's own " +
              "transformer performs the same merge. (A `$ref` wrapped in `allOf` beside a " +
              "`description` is the standard Pydantic v1 output for a referenced model with a field " +
              "description; that shape has nothing to merge and is unchanged.)",
              DOCS.openai));
          }
        } else {
          var mergedProps = {}, mergedReq = [];
          members.forEach(function (m) {
            Object.keys(m.properties).forEach(function (k) {
              if (!(k in mergedProps)) mergedProps[k] = clone(m.properties[k]);
            });
            (Array.isArray(m.required) ? m.required : []).forEach(function (k) {
              if (mergedReq.indexOf(k) === -1) mergedReq.push(k);
            });
          });
          Object.keys(mergedProps).forEach(function (k) {
            if (!node.properties) node.properties = {};
            if (!(k in node.properties)) node.properties[k] = mergedProps[k];
          });
          var nodeReq = Array.isArray(node.required) ? node.required : [];
          mergedReq.forEach(function (k) { if (nodeReq.indexOf(k) === -1) nodeReq.push(k); });
          node.required = nodeReq;
          if (node.type === undefined) node.type = "object";
          delete node.allOf;
          ledger.push(entry("~", path,
            "Merged an `allOf` of " + members.length + " open object schemas into one object — the " +
            "union of their properties and of their `required` lists. This is what OpenAI's " +
            "transformer does with the same input.",
            DOCS.openai));
        }

        // The merge above is a union; a closed branch makes the intersection
        // SMALLER than that union. Drop what no object could have carried
        // anyway. This is lossless BY CONSTRUCTION — every name removed here is
        // one some branch already forbade, so no instance that was legal before
        // becomes illegal — and it is what the vendor does with the same input.
        // It is reported rather than done silently, because a property vanishing
        // from the output is exactly the kind of edit a reader must be able to
        // see (#318).
        if (!allOfBlocked && allowedProps !== null && isPlainObject(node.properties)) {
          var dropped = Object.keys(node.properties).filter(function (k) { return !isAllowed(k); });
          if (dropped.length) {
            dropped.forEach(function (k) { delete node.properties[k]; });
            if (Array.isArray(node.required)) {
              node.required = node.required.filter(function (k) { return isAllowed(k); });
            }
            ledger.push(entry("~", path,
              "Dropped `" + dropped.join("`, `") + "` while merging this `allOf`: a branch declares " +
              "`additionalProperties: false` without declaring " + (dropped.length > 1 ? "them" : "it") +
              ", so no object could ever have carried " + (dropped.length > 1 ? "them" : "it") +
              " and keeping " + (dropped.length > 1 ? "them" : "it") + " would WIDEN what this schema " +
              "accepts. OpenAI's transformer discards the same names. If you meant " +
              (dropped.length > 1 ? "these" : "this") + " to be usable, declare " +
              (dropped.length > 1 ? "them" : "it") + " on the closed branch too.",
              DOCS.openai));
          }
        }
      }

      // `anyOf` is the union OpenAI supports; `oneOf` is not representable.
      // Rewriting is only lossless when the branches are provably disjoint —
      // see oneOfProvablyExclusive above for why, and whose rule this is.
      var oneOfBlocked = false;
      if (Array.isArray(node.oneOf)) {
        if (node.anyOf !== undefined) {
          oneOfBlocked = true;
          ledger.push(entry("!", path,
            "This node has both `anyOf` and `oneOf`. OpenAI's own transformer refuses this outright " +
            "(\"Standard JSON Schema generated both `anyOf` and `oneOf`, which cannot be represented " +
            "in an OpenAI strict schema\"). Merge them into a single `anyOf` yourself — we will not " +
            "guess which one you meant, because either guess changes what the schema accepts.",
            DOCS.openai));
        } else if (openaiObjectUnionThrows(node, node.oneOf, s)) {
          // Keep it: the strip below would delete the "exactly one" constraint,
          // and the whole point here is that the vendor's zod helpers accept
          // this node BYTE-IDENTICAL. Without this flag the note said "Kept
          // `oneOf`" while the next rule removed it -- and the vendor then
          // "accepted" our output only because the constraint was gone.
          oneOfBlocked = true;
          // The rewrite is right in general and WRONG here: this node also has
          // object shape, and `{type: "object", ..., anyOf: [...]}` is exactly
          // what the vendor throws on. Measured on openai@7.4.0: the input as
          // written is ACCEPTED VERBATIM by `toStrictJsonSchema()` (the five zod
          // helpers), so rewriting it took a schema OpenAI accepts and produced
          // one it rejects. Leave the `oneOf` alone and say what the other helper
          // family does — advisory, never a gate failure, because the schema IS
          // valid on the path most callers are on.
          ledger.push(entry("!", path,
            "Kept `oneOf` here rather than rewriting it to `anyOf`, and which OpenAI helper you " +
            "call decides whether that is enough. This node declares object shape, and " +
            "`toStrictJsonSchema()` — what the five `helpers/zod` builders use — accepts this node " +
            "BYTE-IDENTICAL, so on `zodResponseFormat`/`zodTextFormat`/`zodFunction` you are fine. " +
            "The `helpers/standard-schema` builders are not: they run " +
            "`normalizeStructuredOutputSchema()` first, which performs this very `oneOf` -> `anyOf` " +
            "rewrite, and then their own `toStrictJsonSchema()` throws \"Object anyOf schema at `" +
            path + "` cannot be represented in strict Structured Outputs\". The vendor's two helper " +
            "families contradict each other on this one shape and no single document satisfies both " +
            "— so if you are on `standardResponseFormat`, move the union to its own property.",
            DOCS.openai, true));
        } else if (oneOfProvablyExclusive(node.oneOf, s)) {
          node.anyOf = node.oneOf;
          delete node.oneOf;
          ledger.push(entry("~", path,
            "Rewrote `oneOf` as `anyOf` — `anyOf` is the only union keyword OpenAI strict mode can " +
            "represent, and these branches are provably mutually exclusive, so \"exactly one\" and " +
            "\"at least one\" mean the same thing here. Nothing is widened.",
            DOCS.openai));
        } else {
          oneOfBlocked = true;
          ledger.push(entry("!", path,
            "`oneOf` here is NOT provably mutually exclusive, so it cannot be rewritten as `anyOf` " +
            "without widening the schema — `oneOf` means exactly one branch matches, `anyOf` means at " +
            "least one. OpenAI strict mode has no `oneOf`, and its own transformer throws on this case " +
            "rather than widening. Fix it the way OpenAI recommends: use `anyOf` if overlap is " +
            "acceptable, or add a discriminator property with distinct literal values to each branch.",
            DOCS.openai));
        }
      }

      // A node that ALREADY carries `anyOf` beside object shape. Unlike the
      // `oneOf` case above there is no helper family that takes it: measured on
      // openai@7.4.0, BOTH `toStrictJsonSchema()` and the standard-schema
      // pipeline throw. So this is a blocker, not a change we can make — we used
      // to report "1 change" and hand back output the vendor rejects, which is
      // the one thing a gate must never do. `oneOf` siblings are owned by the
      // branch above, so this never double-reports (#359).
      if (path !== "root" && node.oneOf === undefined &&
          openaiObjectUnionThrows(node, node.anyOf, s)) {
        ledger.push(entry("!", path,
          "This node declares object shape AND an `anyOf`. OpenAI strict mode refuses that " +
          "combination outright (\"Object anyOf schema at `" + path + "` cannot be represented in " +
          "strict Structured Outputs without changing Draft 7 validation\") and there is no edit " +
          "we can make that keeps the meaning — dropping `type: \"object\"` would let a non-object " +
          "match, and dropping the object keywords would delete constraints you wrote. Move the " +
          "union under its own property, or drop the object keywords from THIS node so it becomes " +
          "a bare `{\"type\": \"object\"}` wrapper — the vendor has an explicit escape hatch for " +
          "that form (no object keywords of its own, every branch object-only) and accepts it.",
          DOCS.openai));
      }

      // The vendor's escape hatch survives only if we do not destroy it, and by
      // default we do: the rule below sets `additionalProperties: false` on every
      // object, which is an object keyword, which is exactly what closes the
      // hatch. Two individually correct edits composing into a vendor rejection
      // (#348). Do here what the vendor does — drop the redundant `type` — which
      // is lossless for the same reason the vendor gives (every branch is
      // object-only, so the union already excludes null and every non-object
      // value) and leaves output the vendor takes BYTE-IDENTICAL.
      if (path !== "root" && node.type !== undefined && Array.isArray(node.anyOf) &&
          hasOpenAIObjectShape(node) && !openaiObjectUnionThrows(node, node.anyOf, s)) {
        delete node.type;
        ledger.push(entry("~", path,
          "Dropped the redundant `type` beside this `anyOf`. Every branch is already object-only, " +
          "so the `type` constrained nothing — and leaving it would force `additionalProperties: " +
          "false` onto this node, which is an object keyword, which is what makes OpenAI refuse an " +
          "object-shaped `anyOf`. This is the same edit openai@7.4.0 makes internally.",
          DOCS.openai));
      }

      // `$id` is retained at the ROOT (it is in the SDK's own rootMetadata set),
      // but a NESTED `$id` opens a separate resource scope and is fatal:
      // "Nested $id at ... cannot be represented in strict Structured Outputs."
      // Deleting it is not safe — refs may resolve against that scope — so this
      // is a human fix, like a heterogeneous tuple.
      if (path !== "root" && node.$id !== undefined) {
        ledger.push(entry("!", path,
          "Nested `$id` — OpenAI's transformer throws here (\"Nested $id at \\\"" + path + "\\\" " +
          "establishes a separate JSON Schema resource scope and cannot be represented in strict " +
          "Structured Outputs\"). Note `$id` is fine on the ROOT; only nested ones are fatal. " +
          "Remove it, and if any `$ref` resolved against it, rewrite that ref as a plain " +
          "`#/$defs/...` pointer.",
          DOCS.openai));
      }

      var tupleBlocked = normalizeTuple(node, path, ledger);

      // An array MUST declare `items`. This is not a keyword the allowlist can
      // express — it is a structural OBLIGATION, so a presence/absence
      // allowlist is blind to it, exactly as it was blind to nested `$id`
      // being fatal while root `$id` is fine. Verified: toStrictJsonSchema
      // throws "declares an array without `items`, which cannot be represented
      // in strict Structured Outputs". We cannot invent the element type, so
      // this is a human fix.
      if (!tupleBlocked && node.items === undefined) {
        var t = schemaTypes(node);
        if (t && t.indexOf("array") !== -1) {
          ledger.push(entry("!", path,
            "This is an array with no `items`. OpenAI strict mode throws on it (\"declares an array " +
            "without `items`\") because a constrained decoder has no element type to emit. Give it an " +
            "`items` schema, or drop the field. If this schema was inferred from an example, the " +
            "array in that example was empty, so there was no element to read a type from — put one " +
            "sample element in it. Supply the type the field REALLY holds rather than a placeholder: " +
            "a wrong `items` is accepted everywhere and silently redescribes the data, which is " +
            "worse than this error.",
            DOCS.openai));
        }
      }

      // `not` is on the strip list, and stripping it is normally a WIDENING we
      // accept: dropping `not: {const: "x"}` re-admits one value. But when the
      // excluded schema matches everything, the node means "no value is legal",
      // and removing the keyword leaves `{}` — "every value is legal". That is
      // not a widening, it is an INVERSION, and it is reported as a routine
      // one-line strip whose output then rechecks clean.
      //
      // The tell that this was wrong: we already BLOCK a user-supplied `true`
      // here, because a constrained decoder cannot express "anything goes" — and
      // `{}` is the same schema. We were refusing that shape as input while
      // manufacturing it as output. And the two spellings of the excluded
      // schema disagreed with each other: `not: true` was caught by the boolean
      // walker and blocked, `not: {}` was silently inverted.
      //
      // No repair exists — strict mode has no encoding for an impossible field —
      // so the keyword stays visible and the remedy is named.
      var notBlocked = false;
      if ("not" in node && matchesAnything(node["not"])) {
        notBlocked = true;
        ledger.push(entry("!", path,
          "`not` here excludes every value, so no value can satisfy this node. Removing `not` " +
          "(strict mode does not support it) would not narrow this node, it would INVERT it — " +
          "from matching nothing to matching anything. Strict mode cannot express an impossible " +
          "field, so drop the field, or give it a real type if the `not` was not intended " +
          "(`z.never()` and an empty union both produce this).",
          DOCS.openai));
      }

      // The other empty-collection forms are CARRIED here (the vendor accepts
      // them verbatim), so they are advisory rather than a gate failure.
      if (!notBlocked) noteUnsatisfiable(node, path, ledger, DOCS.openai);

      // Read the map evidence BEFORE the strip loop runs, because the strip is
      // what destroys it: `patternProperties` is gone by the time the close
      // below happens, and what is left is byte-identical to a bare
      // `{"type": "object"}` that never claimed to be a map at all. A claim
      // about what the caller GAVE us has to be captured at entry.
      var mapEv = mapKeyEvidence(node);
      // Blocked only when closing the object would leave nowhere to put data.
      // An open map is already handled by its own arm below, so it is excluded
      // here rather than reported twice, and a node that is not an object
      // schema never reaches the close at all.
      var mapKilled = mapEv.length > 0 && isObjectSchema(node) &&
        !isOpenMap(node) && !hasUsableProperties(node);

      // strip every keyword outside the supported set (unsupported => API error)
      Object.keys(node).forEach(function (k) {
        if (OPENAI_SUPPORTED[k]) return;
        // A map keyword whose removal would empty the object stays VISIBLE, for
        // the same reason as the blocked `not`/`prefixItems`/`oneOf` above:
        // deleting it hides the very thing the reader has to remodel, and here
        // it would also hide the value schema, which is still right there in
        // the file and is what makes the remedy actionable.
        if (mapKilled && mapEv.indexOf(k) !== -1) return;
        // Leave a blocked `not` visible: deleting it is the inversion above.
        if (k === "not" && notBlocked) return;
        // A blocked tuple stays visible so the reader can see the shape they
        // have to remodel; deleting it would hide the very thing to fix.
        if (k === "prefixItems" && tupleBlocked) return;
        // Same reasoning for a blocked `oneOf`: stripping it would delete the
        // "exactly one" constraint entirely — a silent widening on top of an
        // unreported one — and hide the keyword the reader has to remodel.
        if (k === "oneOf" && oneOfBlocked) return;
        if (k === "allOf" && allOfBlocked) return;
        var why = OPENAI_STRIP_REASON[k] ||
          "not in OpenAI's supported keyword set, and strict mode errors on unsupported keywords.";
        delete node[k];
        ledger.push(entry("x", path, "Removed `" + k + "` — " + why, DOCS.openai));
      });

      if (isObjectSchema(node) || isOpenMap(node)) {
        // additionalProperties: false on every object
        if (isOpenMap(node)) {
          // Do NOT rewrite: setting `false` here deletes the node's only content.
          // Left visible so the reader can see the shape they have to remodel.
          ledger.push(entry("!", path,
            "This is an open map (`additionalProperties` with no `properties`). OpenAI " +
            "strict mode requires `additionalProperties: false` on every object. " +
            OPEN_MAP_REMEDY,
            DOCS.openai));
        } else if (mapKilled) {
          // Same consequence as the open map above — a field that can never be
          // populated — reached through a different spelling of "this object is
          // a map". So the object is deliberately NOT closed: doing that is the
          // deletion, not the fix.
          //
          // One thing this can say that the open-map arm cannot: the value
          // schema is still in the file, because we did not strip it. That is
          // the difference between a dead field we CREATED and the fossil of
          // one created upstream (which is advisory, since nothing in that file
          // can be acted on).
          ledger.push(entry("!", path,
            "This object describes its keys with " +
            mapEv.map(function (k) { return "`" + k + "`"; }).join(" + ") +
            " and declares no `properties`, so those keywords are the only thing " +
            "admitting a key. OpenAI strict mode supports none of them and requires " +
            "`additionalProperties: false` on every object — and doing both would " +
            "leave `{\"type\": \"object\", \"additionalProperties\": false}`, whose only " +
            "legal value is `{}`. The vendor ACCEPTS that, so nothing downstream would " +
            "tell you the field is dead. Left as-is rather than closed. " +
            OPEN_MAP_REMEDY,
            DOCS.openai));
        } else if (node.additionalProperties !== false) {
          var was = "additionalProperties" in node;
          var lost = was && node.additionalProperties !== false;
          node.additionalProperties = false;
          ledger.push(entry(was ? "~" : "+", path,
            "Set `additionalProperties: false` — required on every object." +
            (lost ? " The extra keys your `additionalProperties` allowed are no longer " +
              "accepted; only the declared `properties` survive." : ""),
            DOCS.openai));
        }

        // The node still has declared `properties`, so the field survives and
        // this is not a blocker — but the keys those map keywords admitted are
        // now forbidden, which is a narrowing rather than the widening a strip
        // normally is, and it is worth one line.
        //
        // Deliberately OUTSIDE the chain above. A schema that already carried
        // `additionalProperties: false` never enters the closing branch at all,
        // and that is the commonest spelling of a closed pattern-map
        // (`{patternProperties, additionalProperties: false}` is how you say
        // "only these keys, nothing else"). Keying this to the moment we write
        // the `false` reported the loss only when we happened to be the one
        // writing it.
        if (mapEv.length && !mapKilled && !isOpenMap(node)) {
          ledger.push(entry("!", path,
            "Keys admitted by " +
            mapEv.map(function (k) { return "`" + k + "`"; }).join(" + ") +
            " are no longer accepted. Strict mode supports none of those keywords and " +
            "requires the object to be closed, so only the declared `properties` " +
            "survive — the model can no longer emit the keys they described. Declare " +
            "the ones you actually expect as fixed `properties` if you need them.",
            DOCS.openai, true));
        }
        // every property must be required; keep optionals optional-in-spirit via nullable
        var props = node.properties ? Object.keys(node.properties) : [];
        var prev = Array.isArray(node.required)
          ? node.required.filter(function (k) { return typeof k === "string"; })
          : [];

        // A key in `required` that `properties` never declares. The vendor
        // REFUSES this outright — openai@7.4.0 throws "requires property `x`
        // but does not declare it in `properties`" — so it cannot be waved
        // through. It also cannot be repaired: the rewrite below sets
        // `required` to the declared keys, and doing that DELETES the
        // undeclared name, silently dropping a constraint the caller wrote
        // (and, where `properties` is absent entirely, leaves output the
        // vendor still rejects while the ledger claims a fix). Neither branch
        // is guessable from the schema — the name might be a stale leftover,
        // or a property whose declaration was lost — so name it and stop.
        var undeclared = prev.filter(function (k) { return props.indexOf(k) === -1; });
        if (undeclared.length) {
          ledger.push(entry("!", path,
            "`required` lists " + undeclared.map(function (k) { return "`" + k + "`"; }).join(", ") +
            ", which `properties` does not declare. OpenAI strict mode rejects this outright " +
            "(`requires property `" + undeclared[0] + "` but does not declare it in `properties``), " +
            "and there is no safe automatic fix: dropping the name from `required` would silently " +
            "remove a constraint you wrote, and declaring it here would mean inventing a type for it. " +
            "Either declare each one in `properties` (strict mode then also requires it to stay in " +
            "`required`), or remove it from `required` if it is stale.",
            DOCS.openai));
        }

        if (props.length) {
          var added = props.filter(function (k) { return prev.indexOf(k) === -1; });
          // Undeclared names are carried through rather than dropped, so the
          // shape stays visible in the output the reader is looking at.
          node.required = props.slice().concat(undeclared);
          added.forEach(function (k) {
            var pnode = node.properties[k];
            // make forced-required fields nullable so their optional semantics survive
            makeNullable(pnode);
            ledger.push(entry("~", path + "." + k,
              "`" + k + "` added to required (all fields must be required); made nullable to preserve optionality.",
              DOCS.openai));
          });
        }
      }
    });

    // ---- EXIT-SIDE ROOT PASS -------------------------------------------------
    // #341 already knew the typeless-root CHECK had to run after the walk,
    // because the walk can supply the `type`. The half it did not follow through
    // on is that the root REPAIRS have to move too: `inlineRootRef` and
    // `resolveRefSiblings` ran at entry, and the single-member `allOf` flatten in
    // the walk above copies every member key into the node — so it HOISTS a
    // `$ref` to the root, or next to a constraint, at a point where both
    // repairs have already been and gone. Measured on openai@7.4.0:
    //   {allOf:[{$ref -> object}]}                 raw ACCEPTED, we blocked it
    //                                              ("nothing left to inline" —
    //                                              there was, we just ran the
    //                                              inliner before it existed)
    //   {minLength, allOf:[{$ref -> string}]}      raw THROWS, our output THREW
    // and the second is the sharper one, because the SAME schema with the `$ref`
    // written directly at entry is repaired and accepted. One `allOf` wrapper
    // decided whether a constraint was fixed or silently shipped broken, and the
    // only difference is WHEN the keyword appeared.
    //
    // Only the ROOT inliner is re-run, and the boundary is deliberate. With the
    // flatten now guarded above, a `$ref` can no longer be hoisted next to a
    // CONSTRAINT — so `resolveRefSiblings` has nothing new to do, and re-running
    // it would newly inline the standard Pydantic v1 shape (`{title, description,
    // allOf:[{$ref}]}`), which the vendor accepts as a `$ref` beside annotations.
    // That would expand the document against OpenAI's 5000-property budget for no
    // benefit; an existing #349 test caught it, and the test was right.
    //
    // The root inliner IS still owed: an unguarded-but-legal flatten (annotation
    // siblings, or none) can hoist a bare `$ref` to the root, where the entry-side
    // `inlineRootRef` has already been and gone. Measured: `{allOf:[{$ref -> an
    // object}]}` is ACCEPTED by the vendor, which resolves the root chain — and we
    // used to BLOCK it with "nothing left to inline", when in fact there was; we
    // had simply run the inliner before the pointer existed. Re-running is safe:
    // it is a lossless inline, a no-op when there is nothing to inline, and it
    // reports what it did.
    s = inlineRootRef(s, ledger, undefined, undefined, refIntersectBlocked);

    // The ROOT `type` check runs LAST, because the walk above can supply the
    // `type` itself — a single-member object `allOf` is flattened there, and the
    // vendor accepts that exact input for the same reason. Running this earlier
    // blocked a schema the vendor repairs, which is the over-strictness class
    // this project has shipped five times (#312/#314/#317/#322/#337).
    //
    // MEASURED against openai@7.4.0's toStrictJsonSchema(): the root test is a
    // literal `type === "object"` comparison, NOT the properties-presence test
    // its nested object rules use (#329). Every typeless root throws `Root
    // schema must have type: 'object' but got type: undefined` — including
    // `{"properties": {...}, "required": [...]}`, which is an object in every
    // sense but the declared one.
    if (!s.type && !s.anyOf) {
      // Two situations, and per #329 what separates them is what the root has
      // LEFT once the missing `type` is supplied.
      if (isPlainObject(s.properties) && Object.keys(s.properties).length) {
        // Lossless: it already describes an object, it just never said so.
        s.type = "object";
        ledger.push(entry("+", "root",
          "Added `type: \"object\"` at the root. OpenAI strict mode tests the root with a " +
          "literal `type === \"object\"` check — unlike its nested object rules, declaring " +
          "`properties` is not enough — so this root was rejected even though it plainly " +
          "describes an object.",
          DOCS.openai));
      } else {
        // Adding `type: "object"` here would ALSO be accepted, and that is the
        // problem: the result is an object with no properties, whose only legal
        // value is `{}`. A rejection you can see beats a schema that is valid
        // and dead, so this is a blocker and the `type` is deliberately not
        // supplied (#329's rule, #340's shape).
        var bag = bagAtEntry;
        ledger.push(entry("!", "root",
          "The root declares no object shape at all — no `type`, no `properties`, and " +
          "nothing left to inline. OpenAI strict mode rejects it (`Root schema must have " +
          "type: 'object' but got type: undefined`)." +
          (bag
            ? " A `" + bag + "` bag is still here, so the definitions survived and the pointer " +
              "into them — a root `$ref` or `anyOf` — did not. One measured producer: " +
              "`llama-index-core`'s `ToolMetadata.get_parameters_dict()` keeps only `type`, " +
              "`properties`, `required`, `definitions` and `$defs`, so a `RootModel` tool " +
              "schema arrives as its own definition bag with no way in. Restore the root " +
              "`$ref`, or inline the definition you meant."
            : " Declare the properties you expect.") +
          " Do NOT just add `type: \"object\"`: the API accepts that, and the result is an " +
          "object whose only legal value is `{}` — a parameter that can never be populated.",
          DOCS.openai));
      }
    }

    // The root shape is decided HERE, on what we are actually handing back, and
    // not on what arrived (#342: a claim about the output belongs at the exit).
    // The entry-side blockers above cover the shapes the CALLER wrote; this covers
    // the ones WE wrote. Keying it on the outcome rather than on a keyword list is
    // the point (#352): it needs no knowledge of which rewrite produced the shape,
    // so a rewrite added later cannot slip past it the way the flatten slipped
    // past the entry-side pair.
    //
    // Deliberately NOT a repair. There is no root form of a union, and turning a
    // scalar root into an object means inventing a wrapper property whose name we
    // would be guessing — so per #329's corollary this names the remodelling
    // instead of manufacturing a schema that is valid and no longer the caller's.
    // The nested half of the same class, and it is the sharpest row measured:
    // `resolveRefSiblings` ran at entry, and the flatten above then HOISTS a
    // `$ref` up beside whatever the wrapper was carrying. So
    //   {minLength: 3, $ref: S}                     repaired -> ACCEPTED
    //   {minLength: 3, allOf: [{$ref: S}]}          shipped   -> REJECTED
    // are the same schema one wrapper apart, and the only difference is WHEN the
    // `$ref` appeared. Checked on the output for the same reason as the root:
    // whether the pointer was written by the caller or by us, it is ours now.
    //
    // The tolerated-sibling set is the vendor's, not ours (`$defs`/`definitions`
    // bags and the seven annotations do not constrain), so this fires only where
    // `toStrictJsonSchema()` actually throws.
    walk(s, "root", function (node, path) {
      if (typeof node.$ref !== "string") return;
      // Already owned by the intersection rule, which refused to merge this
      // exact node and said why. Reporting it again here would add a remedy
      // ("write the `$ref` WITHOUT the `allOf` wrapper") that is wrong for a
      // caller who never wrote a wrapper.
      if (refIntersectBlocked.indexOf(node) !== -1) return;
      var bad = Object.keys(node).filter(function (k) {
        return k !== "$ref" && !toleratedRefSibling(k, path === "root", node);
      });
      if (!bad.length) return;
      ledger.push(entry("!", path,
        "This `$ref` sits beside " + bad.map(function (k) { return "`" + k + "`"; }).join(", ") +
        ", which Draft 7 ignores and OpenAI refuses (`Schema $ref at `" + path + "` has " +
        "non-annotation siblings`). It is here because a single-member `allOf` was flattened " +
        "into this node, lifting the `$ref` up next to those keywords. Write the `$ref` " +
        "WITHOUT the `allOf` wrapper and we will inline the definition for you, which makes " +
        "the constraint and the reference coexist; or move the keywords into the definition.",
        DOCS.openai));
    });

    if (!rootShapeBlocked) {
      var badRootType = s.type && s.type !== "object" ? s.type : null;
      if (badRootType || s.anyOf) {
        ledger.push(entry("!", "root",
          "After the fixes above this root is " +
          (badRootType
            ? "`type: " + JSON.stringify(badRootType) + "`"
            : "a bare `anyOf` union") +
          ", which OpenAI strict mode rejects (`Root schema must " +
          (badRootType ? "have type: 'object'`" : "not use \\`anyOf\\`") + "`). You did not write " +
          "that root — it came out of flattening a single-member `allOf`, which copies the " +
          "member's keys up into the node (OpenAI's own transformer does the same, which is why " +
          "the original input is rejected too). Wrap the composed schema in an object: " +
          "`{\"type\": \"object\", \"properties\": {\"result\": <it>}, \"required\": [\"result\"], " +
          "\"additionalProperties\": false}`.",
          DOCS.openai));
      }
    }

    // Every edit above is justified by strict mode, and `strict` is optional at four
    // declaration sites in openai@7.4.0 — so a caller who never set it is being shown
    // work they do not need to do. Only say so when we actually changed something,
    // and keep it advisory: it must not fail a gate that legitimately passed.
    if (ledger.length) {
      ledger.push(entry("=", "root",
        "These changes are required by strict mode only. If you are NOT setting " +
        "`strict: true` (it is optional and defaults off — Instructor omits it on every " +
        "OpenAI path, including the deprecated `Mode.TOOLS_STRICT`), the keyword subset " +
        "does not apply and your schema is already valid: re-run with `--to openai-nonstrict`.",
        DOCS.openai, true));
    }

    noteEmptiedDocument(schema, s, ledger, DOCS.openai,
      "Measured over this project's whole fixture corpus: 13 of the 14 shapes that empty here " +
      "survive `--to openai-nonstrict` intact, so if you are not setting `strict: true` the " +
      "constraints are still in the request (unenforced, but present). Under strict mode they have to be remodelled.");
    return { schema: s, ledger: ledger };
  }

  function makeNullable(node) {
    if (!isPlainObject(node)) return;
    if (Array.isArray(node.type)) {
      if (node.type.indexOf("null") === -1) node.type.push("null");
    } else if (typeof node.type === "string") {
      if (node.type !== "null") node.type = [node.type, "null"];
    }
    // An `enum` alongside a nullable type has to admit null as well, or the two
    // constraints are unsatisfiable and the model can never legally emit null.
    // zod `z.enum([...]).optional()` / `.default()` hits this every time.
    if (Array.isArray(node.enum) && node.enum.indexOf(null) === -1) {
      node.enum = node.enum.concat([null]);
    }
  }

  // ---- Anthropic: TWO paths, and the switch is WHICH API FEATURE you call ---
  //
  // Verified 2026-08-09 against the vendor SDK `@anthropic-ai/sdk@0.116.0`, not
  // the doc. Like Gemini (#314) Anthropic has two accepted dialects, but the
  // routing is different: Gemini switches on a key inside the schema
  // (`$schema`), Anthropic switches on the request field you put it in.
  //
  //   Path T — `tools[].input_schema`   (helpers/beta `betaTool`, `betaZodTool`)
  //       NO client-side transform at all. Your JSON Schema is attached
  //       verbatim. The only client-side check is that the ROOT is
  //       `type: "object"`, which throws otherwise.
  //
  //   Path O — `output_format: { type: "json_schema" }`
  //       (`helpers/json-schema.js` -> `jsonSchemaOutputFormat`, `zodOutputFormat`,
  //        and the beta variants) runs `lib/transform-json-schema.js`, which
  //       REBUILDS the schema from a small allowlist.
  //
  // The policy on Path O is a THIRD kind, and it is the reason this converter
  // exists. OpenAI ERRORS on an unsupported keyword (#312). Gemini's
  // `responseJsonSchema` IGNORES it (#314). Anthropic DEMOTES it: every
  // unrecognised keyword left on a node is `JSON.stringify`'d and appended to
  // that node's `description`. Measured:
  //
  //   {type:"string", enum:["low","high"]}
  //     -> {"type":"string","description":"{enum: [\"low\",\"high\"]}"}
  //
  // The enum still reaches the model, as a sentence. It is no longer enforced.
  // Nothing errors, nothing warns — the constraint just silently stops being a
  // constraint, which is the worst of the three policies to debug.
  //
  // Recognised on Path O (everything else is demoted to prose):
  //   any node : $ref (returns EARLY — all siblings dropped), $defs, type,
  //              anyOf, oneOf (rewritten to anyOf), allOf, description, title
  //   object   : properties, required (passed through AS GIVEN — Anthropic does
  //              NOT require every key, unlike OpenAI), additionalProperties
  //              (popped and forced to false regardless of your value)
  //   string   : format, but only the 10 in SUPPORTED_STRING_FORMATS
  //   array    : items, and minItems only when it is exactly 0 or 1
  //
  // And it THROWS ("JSON schema must have a type defined if anyOf/oneOf/allOf
  // are not used") on any node with no `type`, because it recurses into that
  // node and finds nothing to key on.
  //
  // The two tuple spellings fail DIFFERENTLY here, and the difference matters:
  //   `items: [A, B]`  (draft-07)          -> recursed into as a schema -> THROWS
  //   `prefixItems: [A, B]` + `items:false` -> `items:false` recursed into -> THROWS
  //   `prefixItems: [A, B]` alone           -> NOT recognised -> demoted to prose,
  //        leaving a bare `{"type":"array"}` — an array with NO item schema and
  //        NO length, i.e. totally unconstrained. That is the worse outcome, and
  //        it is exactly what zod v4's `z.toJSONSchema(z.tuple([...]))` emits.

  // #367. `--to anthropic-json` is named for a CONDITION — "you are on the
  // structured-output path rather than the tools path" (#315). Nobody had asked
  // whether every way of reaching that path agrees, and they do not.
  //
  // The demote-to-prose rewrite is NOT a property of the request field. It is a
  // property of HOW YOU HAND THE SCHEMA OVER, measured 2026-08-10:
  //
  //   TypeScript @anthropic-ai/sdk 0.116.0 — `transformJSONSchema` has exactly
  //   FOUR call sites and every one is a HELPER; it is never called from the
  //   request path. So an inline `output_config: { format: { type:
  //   "json_schema", schema } }` (type-legal under --strict, verified with tsc)
  //   is sent VERBATIM. Two of the four helpers additionally take
  //   `{ transform: false }` and then skip it (`options?.transform ?? true`).
  //
  //   Python anthropic 0.121.0 — `transform_schema` IS in the request path
  //   (parse/stream/count_tokens), but behind `if is_dict(output_format)`, which
  //   casts and returns UNTRANSFORMED. Only a pydantic *type* is transformed.
  //   And the `output_config.format` parameter — the one the SDK's own
  //   DeprecationWarning tells you to migrate to — never transforms at all:
  //   every method takes a dict there, and a model is rejected outright
  //   (`TypeError: Object of type ModelMetaclass is not JSON serializable`).
  //
  // So the vendor's own deprecation notice moves a Python caller off the only
  // demoting form onto a parameter where no demoting form exists.
  //
  // Go is deliberately absent from this table and keeps the categorical claim:
  // #332 measured both of its helpers running `transformSchemaMap`, so it has no
  // verbatim form. That pair is the discriminator — without it the rule below
  // could be firing blanket and every other assertion would still pass.
  //
  // Honest limit, stated as #361 states its tables: the suite is dependency-free
  // and cannot run either SDK, so this pins a MEASURED SNAPSHOT of two versions
  // and re-measuring after a bump is manual. And "verbatim" is a claim about the
  // CLIENT only — whether the service then enforces the keyword is not
  // observable without an API key (#343's client-is-not-the-service boundary).
  var ANTHROPIC_TRANSFORM_SURFACES = [
    { lang: "ts", form: "jsonSchemaOutputFormat(schema)", transforms: true },
    { lang: "ts", form: "jsonSchemaOutputFormat(schema, { transform: false })", transforms: false },
    { lang: "ts", form: "betaJSONSchemaOutputFormat(schema)", transforms: true },
    { lang: "ts", form: "betaJSONSchemaOutputFormat(schema, { transform: false })", transforms: false },
    { lang: "ts", form: "zodOutputFormat(zodType)", transforms: true },
    { lang: "ts", form: "betaZodOutputFormat(zodType)", transforms: true },
    { lang: "ts", form: "inline { type: \"json_schema\", schema } (no helper)", transforms: false },
    { lang: "py", form: "output_format=<pydantic type> (deprecated param)", transforms: true },
    { lang: "py", form: "output_format=<dict> (deprecated param)", transforms: false },
    { lang: "py", form: "output_config={\"format\": <dict>} (recommended param)", transforms: false }
  ];

  function anthropicDemotingForms(lang) {
    return ANTHROPIC_TRANSFORM_SURFACES.filter(function (s) {
      return s.transforms && (!lang || s.lang === lang);
    });
  }

  var ANTHROPIC_STRING_FORMATS = {
    "date-time": 1, "time": 1, "date": 1, "duration": 1, "email": 1,
    "hostname": 1, "uri": 1, "ipv4": 1, "ipv6": 1, "uuid": 1
  };

  // Keys `transform-json-schema.js` consumes; anything else on a node is
  // stringified into `description`.
  // `pythonSdk` selects which of the vendor's TWO SDK implementations to model.
  // They are not a version skew: `anthropic==0.116.0` (Python) and
  // `@anthropic-ai/sdk@0.116.0` (JS) carry the SAME version string and disagree.
  // Measured over 43 schema shapes, they agree semantically on 41; `enum` is one
  // of the two exceptions (Python keeps it, JS stringifies it into `description`).
  // ---- Anthropic's THIRD SDK: `anthropic-sdk-go` ---------------------------
  //
  // Measured 2026-08-09 against `github.com/anthropics/anthropic-sdk-go@v1.62.0`
  // by calling its exported helpers directly, not by reading the diff.
  //
  // Three things make Go its own target rather than an alias of the other two:
  //
  //  1. THERE IS NO VERBATIM PATH. In TypeScript and Python `tools[].input_schema`
  //     applies no transform at all (#315/#321), which is what `--to anthropic`
  //     exists for. In Go BOTH exported helpers — `BetaJSONSchemaOutputFormat`
  //     and `BetaToolInputSchema` — call the same `transformSchemaMap`, so a Go
  //     caller gets the rebuild on the tools path too. Verified: identical output
  //     from both helpers on all 19 shapes probed.
  //
  //  2. IT KEEPS MORE. `supportedSchemaKeys` (schemautil.go) is a flat set that
  //     includes `enum`, `const` AND `pattern`. TypeScript demotes all three to
  //     prose; Python keeps `enum` only. So the three SDKs have three different
  //     supported-key sets at the same vendor, and `pattern` is kept only by Go.
  //
  //  3. IT CAN LOSE EVERYTHING. `transformSchemaMap` round-trips your map through
  //     `invopop/jsonschema.Schema` and `return nil`s on any unmarshal error,
  //     swallowing it. That struct types `Type` as a `string` and `Items` as a
  //     `*Schema`, so an array-valued `type` or a draft-07 tuple (`items: [A,B]`)
  //     ANYWHERE in the document — including inside `$defs` — makes the WHOLE
  //     schema come back `nil`. Measured, both at the root and nested.
  //
  // And a fourth difference that is not a policy but a bug, reported upstream:
  // `formatExtraValue` walks pointers with reflect but then formats the ORIGINAL
  // value, so every pointer-typed field renders as a hexadecimal address. The
  // demote-to-prose policy is defeated for exactly those keys — the model is told
  // `{maxLength: 0x162d307bcc80}`.
  var ANTHROPIC_GO_SUPPORTED = {
    "$ref": 1, "$defs": 1, "type": 1, "anyOf": 1, "oneOf": 1, "allOf": 1,
    "description": 1, "title": 1, "enum": 1, "const": 1, "properties": 1,
    "additionalProperties": 1, "required": 1, "items": 1, "minItems": 1,
    "format": 1, "pattern": 1
  };

  // Keys `invopop/jsonschema@v0.14.0` gives a struct field. Anything OUTSIDE
  // this set never survives the round-trip at all: `Schema.UnmarshalJSON` is a
  // plain alias unmarshal, so unknown keys are dropped before `transformSchema`
  // ever runs and never reach the extras-to-description path. Two different
  // severities hide behind one "unsupported": modelled keys become prose,
  // unmodelled keys vanish without a trace.
  var GO_INVOPOP_MODELLED = {
    "$schema": 1, "$id": 1, "$anchor": 1, "$ref": 1, "$dynamicRef": 1, "$defs": 1,
    "$comment": 1, "allOf": 1, "anyOf": 1, "oneOf": 1, "not": 1, "if": 1, "then": 1,
    "else": 1, "dependentSchemas": 1, "prefixItems": 1, "items": 1, "contains": 1,
    "properties": 1, "patternProperties": 1, "additionalProperties": 1,
    "propertyNames": 1, "type": 1, "enum": 1, "const": 1, "multipleOf": 1,
    "maximum": 1, "exclusiveMaximum": 1, "minimum": 1, "exclusiveMinimum": 1,
    "maxLength": 1, "minLength": 1, "pattern": 1, "maxItems": 1, "minItems": 1,
    "uniqueItems": 1, "maxContains": 1, "minContains": 1, "maxProperties": 1,
    "minProperties": 1, "required": 1, "dependentRequired": 1, "format": 1,
    "contentEncoding": 1, "contentMediaType": 1, "contentSchema": 1, "title": 1,
    "description": 1, "default": 1, "deprecated": 1, "readOnly": 1,
    "writeOnly": 1, "examples": 1
  };

  // Fields invopop declares as `*uint64`, i.e. the ones `formatExtraValue`
  // renders as a pointer address instead of a number. `minItems` is the one
  // near-miss: the array branch dereferences it explicitly before demoting, so
  // it is the only length keyword that prints its value.
  var GO_POINTER_FORMATTED = {
    "maxLength": 1, "minLength": 1, "maxItems": 1, "maxContains": 1,
    "minContains": 1, "maxProperties": 1, "minProperties": 1
  };

  function anthropicGoRecognises(node, key) {
    if (!ANTHROPIC_GO_SUPPORTED[key]) return false;
    // `supportedSchemaKeys` is consulted before the per-type switch, so a key in
    // the set survives on a node of any type. Only two get a second, type-gated
    // demotion afterwards.
    if (key === "format") {
      return node.type !== "string" || !!ANTHROPIC_STRING_FORMATS[node.format];
    }
    if (key === "minItems") {
      return node.type !== "array" || node.minItems === 0 || node.minItems === 1;
    }
    return true;
  }

  function anthropicRecognises(node, key, sdk) {
    if (sdk === "go") return anthropicGoRecognises(node, key);
    var pythonSdk = sdk === "python";
    switch (key) {
      case "$ref": case "$defs": case "type": case "anyOf": case "oneOf":
      case "allOf": case "description": case "title":
        return true;
      case "enum":
        // Python: `enum = json_schema.pop("enum"); if is_list(enum): keep`.
        // JS has no such clause, so it falls through to the prose demotion.
        return !!pythonSdk;
      case "properties": case "required": case "additionalProperties":
        return node.type === "object";
      case "format":
        return node.type === "string" && !!ANTHROPIC_STRING_FORMATS[node.format];
      case "items":
        return node.type === "array";
      case "minItems":
        return node.type === "array" && (node.minItems === 0 || node.minItems === 1);
      default:
        return false;
    }
  }

  // ---- Anthropic: an array-valued `type` is a DISPATCH MISS, and the two SDKs
  // fail on it in opposite directions ----------------------------------------
  //
  // Measured 2026-08-09 against `@anthropic-ai/sdk@0.116.0` and
  // `anthropic==0.121.0`:
  //
  //   * JS `_transformJSONSchema` dispatches on `type === "object" | "string" |
  //     "array"` — strict equality against a STRING — so an array-valued `type`
  //     matches no branch. The branch that would have copied `properties`,
  //     `items` or `format` never runs, and those keys fall through to the
  //     catch-all that stringifies leftovers into `description`. For
  //     `{type:["object","null"], properties:{…}, required:[…]}` the ENTIRE
  //     subtree becomes one line of prose and the transformer never recurses
  //     into it. No error, no warning. That is a different kind of loss from an
  //     ordinary demotion (#315): it is the structure, not a constraint.
  //   * Python `transform_schema` types `type` as a `Literal` of seven scalars
  //     and ends in `assert_never`, so ANY list raises `AssertionError: Expected
  //     code to be unreachable` — including the one-element `["string"]` and the
  //     canonical nullable spelling `["string","null"]`. The request cannot be
  //     built at all.
  //
  // `anyOf` is the form BOTH accept: the JS transformer maps itself over the
  // variants (so the subtree survives AND is processed properly — a nested
  // `minLength` is demoted at the leaf, which is the correct minimal loss) and
  // the Python transformer passes it through verbatim. Verified on both.
  //
  // Not exotic: our own `--to openai` output creates `type:["object","null"]`
  // for an optional object property (the forced-required rewrite from #311), and
  // `zod-to-json-schema` emits `type:["string","null"]` for a nullable primitive.
  // (Corrected while measuring: Zod v4's native `z.toJSONSchema` and Pydantic
  // v2 both emit `anyOf` instead, so this reaches Anthropic mainly through
  // hand-written / OpenAPI-derived schemas and through our own output — not
  // through those two generators, as I had first assumed.)
  function anthropicTypeBranchKeys(member) {
    if (member === "object") return ["properties", "required"];
    if (member === "array") return ["items", "minItems"];
    if (member === "string") return ["format"];
    return [];
  }

  // What an array-valued `type` costs, per SDK. The Go entry is the loudest of
  // the three and the only one that is not confined to this node.
  var ANTHROPIC_UNION_TYPE_COST = {
    python: "The Python `anthropic` SDK REFUSES TO BUILD the request for any array-valued `type` — " +
      "`transform_schema` types it as a `Literal` of seven scalars and falls through to " +
      "`assert_never`, raising `AssertionError: Expected code to be unreachable`. Even a " +
      "one-element list raises. ",
    go: "The Go SDK loses the ENTIRE DOCUMENT here, not just this node. `transformSchemaMap` " +
      "unmarshals your map into `invopop/jsonschema.Schema`, whose `Type` field is a `string`; " +
      "an array fails to unmarshal and the function `return nil`s, swallowing the error. Both " +
      "`BetaJSONSchemaOutputFormat` and `BetaToolInputSchema` then hand the API a null schema, " +
      "with nothing raised client-side. Measured on anthropic-sdk-go@v1.62.0 — and it fires " +
      "wherever the union is, including inside `$defs`. "
  };

  function normalizeAnthropicUnionType(node, path, ledger, url, sdk) {
    var pythonSdk = sdk !== "js";  // both Python and Go fail on ANY list
    var raw = node.type;
    if (!Array.isArray(raw)) return;
    // `type` beside a combinator: rewriting would have to invent a merge, so the
    // keyword is left visible. But bailing silently is only safe for the JS SDK,
    // which ignores the `type` once it sees `anyOf`. The Python SDK asserts on
    // the LIST before it ever looks at the combinator, so the request still
    // cannot be built — measured: `{type:["string","null"], anyOf:[…]}` raises
    // `AssertionError` there. Say so rather than exit 0 on a schema that throws.
    if (node.anyOf !== undefined || node.oneOf !== undefined || node.allOf !== undefined) {
      if (pythonSdk) {
        ledger.push(entry("!", path,
          "This node has an array-valued `type` (`" + JSON.stringify(raw) + "`) alongside " +
          "`anyOf`/`oneOf`/`allOf`. " + (sdk === "go"
            ? "The Go SDK fails on the list before any of this is interpreted — the unmarshal into " +
              "`invopop/jsonschema.Schema` errors on an array in `Type` and `transformSchemaMap` " +
              "returns nil, so the WHOLE schema is dropped, combinator included."
            : "The Python `anthropic` SDK raises `AssertionError: Expected code to be unreachable` on " +
              "the list REGARDLESS of the combinator — the assert runs before the combinator is " +
              "consulted — so the request cannot be built.") +
          " (The TypeScript SDK ignores the `type` once it sees a combinator, which is why this is " +
          "not a failure there.) Merging these two is a semantic decision only you can make, so drop " +
          "whichever one is redundant.",
          url));
      }
      return;
    }

    var members = [];
    raw.forEach(function (t) { if (members.indexOf(t) === -1) members.push(t); });
    var nonNull = members.filter(function (t) { return t !== "null"; });
    var hasNull = nonNull.length !== members.length;
    var others = Object.keys(node).filter(function (k) { return k !== "type"; });

    // Did the union actually SKIP a branch that would otherwise have run? That
    // is the only thing the JS SDK loses here. The Python SDK loses the whole
    // request whatever the members are, so it always needs the rewrite.
    var skippedBranch = nonNull.length === 1 &&
      anthropicTypeBranchKeys(nonNull[0]).some(function (k) { return node[k] !== undefined; });
    if (!pythonSdk && !skippedBranch) return;

    var before = JSON.stringify(raw);
    var loudly = pythonSdk
      ? ANTHROPIC_UNION_TYPE_COST[sdk]
      : "`@anthropic-ai/sdk` dispatches on `type === \"object\"`/`\"string\"`/`\"array\"` — strict " +
        "equality against a string — so an array-valued `type` matches no branch and the branch " +
        "that would have copied " +
        anthropicTypeBranchKeys(nonNull[0]).map(function (k) { return "`" + k + "`"; }).join("/") +
        " never runs. Those keys are stringified into this node's `description` instead, and the " +
        "transformer never recurses into them — so the whole subtree stops being schema. It does " +
        "not throw and it does not warn. ";

    // Several non-null members WITH keywords attached: there is no safe way to
    // decide which branch each keyword belongs to. Guessing would silently
    // re-attach a constraint to a type it never applied to, so say so instead.
    if (nonNull.length > 1 && others.length > 0) {
      if (pythonSdk) {
        ledger.push(entry("!", path,
          loudly + "This node also carries " +
          others.map(function (k) { return "`" + k + "`"; }).join(", ") +
          ", and with more than one non-null member there is no way to tell which branch each of " +
          "those belongs to — re-attaching them to the wrong type would be a silent semantic " +
          "change, so this is left for you. Rewrite it by hand as `anyOf`, one branch per type, " +
          "with each keyword on the branch it constrains.",
          url));
      }
      return;
    }

    var moved = {};
    others.forEach(function (k) {
      // Annotations are recognised at any node, including an `anyOf` node, so
      // they stay where the reader put them.
      if (k === "description" || k === "title") return;
      moved[k] = node[k];
      delete node[k];
    });

    var shape;
    if (nonNull.length === 0) {
      // `["null"]` — the scalar spelling is accepted verbatim by both SDKs.
      node.type = "null";
      Object.keys(moved).forEach(function (k) { node[k] = moved[k]; });
      shape = "`type: \"null\"`";
    } else if (nonNull.length === 1 && !hasNull) {
      // `["string"]` — a one-element list means exactly the scalar.
      node.type = nonNull[0];
      Object.keys(moved).forEach(function (k) { node[k] = moved[k]; });
      shape = "`type: " + JSON.stringify(nonNull[0]) + "`";
    } else if (nonNull.length === 1) {
      var branch = { type: nonNull[0] };
      Object.keys(moved).forEach(function (k) { branch[k] = moved[k]; });
      delete node.type;
      node.anyOf = [branch, { type: "null" }];
      shape = "`anyOf: [{type: " + JSON.stringify(nonNull[0]) + ", …}, {type: \"null\"}]`";
    } else {
      delete node.type;
      node.anyOf = members.map(function (t) { return { type: t }; });
      shape = "`anyOf` with one branch per type";
    }

    ledger.push(entry("~", path,
      "Rewrote `type: " + before + "` to " + shape + ". " + loudly +
      "`anyOf` is the form ALL THREE SDKs handle: the TypeScript transformer maps itself over the " +
      "variants, so the subtree survives and is processed properly; the Python transformer passes " +
      "`anyOf` through verbatim; and the Go transformer recurses into the variants (`AnyOf` is a " +
      "`[]*Schema`, so it unmarshals cleanly where an array in `type` does not). Lossless — every " +
      "keyword moves onto the branch it already " +
      "constrained (`properties` never applied to `null` in the first place), and `description`/" +
      "`title` stay where they are because they are recognised at any node.",
      url));
  }

  // A node with no `type` (and no anyOf/oneOf/allOf/$ref) throws on Path O.
  // When the node carries an `enum` or `const` the intended type is recoverable
  // losslessly, so add it rather than making the user do it.
  function inferTypeFromValues(values) {
    var types = {};
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v === null) types["null"] = 1;
      else if (Array.isArray(v)) types["array"] = 1;
      else if (typeof v === "object") types["object"] = 1;
      else if (typeof v === "number") types[Number.isInteger(v) ? "integer" : "number"] = 1;
      else if (typeof v === "boolean") types["boolean"] = 1;
      else if (typeof v === "string") types["string"] = 1;
      else return null;
    }
    var keys = Object.keys(types);
    if (keys.length === 1) return keys[0];
    if (keys.length === 2 && types["integer"] && types["number"]) return "number";
    return null;
  }

  // Anthropic is a TWO-PATH provider and the switch is not in the schema — it
  // is WHICH REQUEST FIELD you use (#315). Which one you are on is a fact only
  // the caller has, so it is an explicit target, never inferred (#319):
  //
  //   `--to anthropic`       -> tools[].input_schema. NO transform runs at all.
  //                             Re-verified 2026-08-09 against
  //                             @anthropic-ai/sdk@0.116.0: `betaTool()` returns
  //                             `input_schema` byte-identical, and the ONLY way
  //                             to make it throw is a root that is not
  //                             `type: "object"`. A tuple, a `definitions` bag,
  //                             a typeless nested node and a non-exclusive
  //                             `oneOf` all pass through untouched.
  //   `--to anthropic-json`  -> output_format:{type:"json_schema"}. Full rebuild
  //                             by `lib/transform-json-schema`, which demotes
  //                             every unrecognised keyword to prose.
  //
  // Conflating them is a false CI failure for the larger audience: Instructor's
  // default Anthropic mode is ANTHROPIC_TOOLS, so an ordinary Pydantic model
  // (tuple field, maxLength, $defs) is perfectly valid on the wire while the
  // old single target exited 1 and proposed a lossy tuple collapse.
  function toAnthropic(schema, outputFormatPath, sdk) {
    sdk = sdk || "js";
    var goSdk = sdk === "go";
    var pythonSdk = sdk === "python";
    var s = clone(schema);
    var ledger = [];
    var antRefBlocked = [];
    var url = outputFormatPath ? DOCS["anthropic-json"] : DOCS.anthropic;
    // Go has no verbatim surface at all (#332), so the remedy every other
    // Anthropic message can offer does not exist there.
    var ANTHROPIC_EMPTIED_REMEDY = goSdk
      ? "There is no verbatim escape hatch in Go — both helpers run the same transform — so the " +
        "constraint has to be remodelled into keywords the transform keeps, or enforced after the " +
        "response comes back."
      : "Measured: 13 of the 14 shapes that empty here survive `--to anthropic` (the " +
        "`tools[].input_schema` path) intact, because no transform runs there. On this path they have to be remodelled.";
    // On the Go SDK the tools path runs the SAME transform, so the sentence
    // every other Anthropic message ends with — "it survives on
    // tools[].input_schema" — is false there and must not be printed.
    var VERBATIM_ESCAPE = goSdk
      ? " Note there is no verbatim escape hatch in Go: `BetaToolInputSchema` calls the same " +
        "`transformSchemaMap` as `BetaJSONSchemaOutputFormat`, so `--to anthropic` (which models the " +
        "TypeScript/Python tools path, where no transform runs) does NOT describe your client."
      : " It IS sent as-is on the `tools[].input_schema` path, so this is kept, not stripped.";

    // #367. Reaching the structured-output path does NOT by itself mean the
    // rewrite runs — see ANTHROPIC_TRANSFORM_SURFACES. Which of the two branches
    // a caller is on is not derivable from the schema (it is a fact about their
    // call site), so per #366 the tool NAMES THE CHECK instead of guessing.
    // Deliberately empty for Go, which has no non-transforming form.
    var TRANSFORM_CONDITION = goSdk ? "" :
      " That is conditional on how you hand the schema over, and the request field does not decide " +
      "it: " + (pythonSdk
        ? "in Python the rewrite lives behind `if is_dict(output_format)`, so it runs ONLY for a " +
          "pydantic *type* passed to the deprecated `output_format=` parameter. A plain dict is cast " +
          "through untouched, and `output_config={\"format\": ...}` — the parameter the SDK's own " +
          "DeprecationWarning tells you to migrate to — never transforms on any method, because it " +
          "takes a dict and rejects a model outright. So following the deprecation notice moves you " +
          "off the only demoting form"
        : "in TypeScript `transformJSONSchema` has four call sites and all four are HELPERS, never " +
          "the request path. It runs for `jsonSchemaOutputFormat`/`betaJSONSchemaOutputFormat` " +
          "(unless you pass `{ transform: false }`) and for the two zod helpers (no opt-out). An " +
          "inline `{ type: \"json_schema\", schema }` written straight into the request — type-legal " +
          "under `--strict` — skips it entirely") +
      ". On the non-transforming forms this keyword is NOT rewritten into prose; it goes on the wire " +
      "as you wrote it, and whether the service then enforces it is not something this tool can " +
      "observe. Check your call site against the list above rather than assuming.";

    // Both paths: nothing on Anthropic's side ever RESOLVES a `$ref`, so a
    // pointer in a spelling that does not resolve locally is dead either way.
    // Rewriting is conditional and lossless (#320) — it only fires when the
    // target is really there.
    s = normalizeRefSpelling(s, ledger, url, outputFormatPath
      ? "Anthropic's transformer passes a `$ref` through verbatim without resolving or validating it, " +
        "so a mis-spelled pointer reaches the model dangling rather than erroring."
      : "This path sends the schema verbatim — nothing resolves or validates a `$ref` — so a pointer " +
        "in a spelling that does not resolve locally reaches the model dangling, with no error.");

    // A boolean subschema is the FOURTH thing this vendor's three SDKs disagree
    // about, and the disagreement is measured, not ported:
    //   TypeScript `transformJSONSchema`  -> THROWS "JSON schema must have a type
    //                                        defined if anyOf/oneOf/allOf are not
    //                                        used" (control: the same schema with
    //                                        `{"type":"string"}` in that slot is
    //                                        accepted, so the boolean is the cause)
    //   Go `BetaJSONSchemaOutputFormat`
    //      and `BetaToolInputSchema`      -> preserved VERBATIM, both surfaces
    //   TypeScript `betaTool`             -> preserved verbatim (no transform runs)
    //   Python `transform_schema`         -> RAISES `TypeError: 'bool' object is
    //                                        not a mapping` (`ValueError` under
    //                                        `not`), so the request is never built
    // #333 left the Python client unprobed and said so rather than guessing. It
    // has now been measured on anthropic==0.121.0 (`anthropic/lib/_parse/_transform.py`,
    // the module #333 could not find), and it sides with TypeScript, not Go — so
    // the vendor's three SDKs are 2-1 here rather than split three ways, and it is
    // OUR gate that disagreed with itself: the same bytes exited 3 on
    // `--to anthropic-json` and 0 on `--to anthropic-json-python`.
    //
    // Positions were mapped rather than assumed. The transform raises at a
    // property value, both spellings of `items`, an `anyOf`/`oneOf`/`allOf`
    // member, a nested property, `$defs` and the root. It ACCEPTS a boolean
    // under `prefixItems` — that keyword is demoted to `description` prose
    // before anything descends into it — and accepts the by-design boolean
    // slots (`additionalProperties`, `unevaluatedProperties`), which
    // findBooleanSubschemas already excludes.
    //
    // `not` is the other subtree the transform never descends — it demotes the
    // whole keyword to `description` prose — so a boolean ANYWHERE under `not`
    // is accepted and must not be blocked. Being merely stricter than the vendor
    // is this project's most repeated bug, so it is excluded below.
    //
    // `prefixItems` is nonetheless still blocked here, and deliberately: the
    // question is what OUR OUTPUT contains, not what the input did (#342). Our
    // own homogeneous-tuple collapse (#346) rewrites `prefixItems: [true]` into
    // `items: true`, moving the boolean out of the one slot the vendor tolerates
    // and into one it raises on. A rule keyed on the input position would have
    // excluded this row as vendor-safe and shipped a document that cannot be
    // built. `not` is not rewritten by us, so it stays where the vendor tolerates
    // it — same question, opposite answers, decided by whether WE move the node.
    if (outputFormatPath) {
      findBooleanSubschemas(s).forEach(function (h) {
        if (goSdk) {
          ledger.push(entry("=", h.path,
            "This is a boolean subschema (`" + h.value + "`), and the Go SDK keeps it — measured " +
            "verbatim through both `BetaJSONSchemaOutputFormat` and `BetaToolInputSchema` on " +
            "anthropic-sdk-go@v1.62.0. Nothing to fix. Worth knowing only because the clients " +
            "differ: the TypeScript `output_format` transformer THROWS on the same bytes, and " +
            "`--to openai` blocks it outright.",
            url, true));
          return;
        }
        // Measured, not assumed: `transform_schema` demotes `not` to prose
        // before descending, so every boolean below it is accepted verbatim.
        if (pythonSdk && h.path.indexOf("/not") !== -1) return;
        ledger.push(entry("!", h.path,
          booleanSubschemaMessage(h.value, pythonSdk
            ? "The Python `output_format` transformer rejects it: `transform_schema` " +
              "(anthropic==0.121.0) walks every sub-schema as a mapping and raises " +
              "`TypeError: 'bool' object is not a mapping` on the boolean, so the request " +
              "is never built. Note the Go SDK keeps the same bytes verbatim, so this is a " +
              "fact about the client you are using, not about Anthropic." + VERBATIM_ESCAPE
            : "The TypeScript `output_format` transformer rejects it: `transformJSONSchema` throws " +
              "`JSON schema must have a type defined if anyOf/oneOf/allOf are not used`, because a " +
              "boolean carries no `type` for it to dispatch on." + VERBATIM_ESCAPE),
          url));
      });

      // `definitions` is draft-07; the transformer only knows `$defs`. Left
      // alone it is not merely ignored — it is stringified into the root
      // `description` and every `#/definitions/...` pointer is left dangling.
      s = normalizeDefs(s, ledger, url, goSdk
        ? "Renamed draft-07 `definitions` to `$defs` and repointed every `$ref`. The Go SDK does not " +
          "merely ignore a `definitions` bag — `invopop/jsonschema.Schema` has no field for that " +
          "spelling, so the whole bag is dropped during the unmarshal inside `transformSchemaMap`, " +
          "silently, leaving every `#/definitions/...` pointer dangling with nothing to resolve to. " +
          "Measured: `{$ref:\"#/definitions/T\", definitions:{...}}` nested under a property comes " +
          "back as `{\"$ref\":\"#/definitions/T\"}` alone. This is the default output shape of " +
          "`zod-to-json-schema`."
        : "Renamed draft-07 `definitions` to `$defs` and repointed every `$ref`. Anthropic's " +
        "structured-output transformer only reads `$defs`; a `definitions` bag is not ignored, it is " +
        "stringified into the root `description` while every `#/definitions/...` pointer is left dangling.");
    }

    // A root `$ref` breaks BOTH paths, but for different reasons — so the fix
    // is shared and the explanation is not.
    //
    // On the structured-output path this is the ONE place the two SDKs disagree
    // about the shape of the output (the other, `enum`, only changes a warning).
    // The Python transformer pops `$defs` BEFORE its `$ref` early-return, with a
    // source comment naming exactly this case, so `{$ref, $defs}` survives intact
    // and needs no edit. The JS transformer returns first and drops the bag,
    // leaving a dangling pointer with the whole schema gone and no error raised.
    // Measured, not inferred — and note the draft-07 spelling `{$ref, definitions}`
    // is destroyed by BOTH, which is why the `definitions` -> `$defs` rename above
    // is unconditional and this skip is not.
    // Set when the root `$ref` is deliberately LEFT in place below, so the
    // outcome-keyed root check further down does not read that decision as a
    // defect. (Only the Python SDK path takes it, and only for `$defs`, because
    // `normalizeDefs` has already renamed the draft-07 spelling by then.)
    var rootRefKeptOnPurpose = false;
    if (outputFormatPath && pythonSdk && rootRefResolvesInDefs(s)) {
      rootRefKeptOnPurpose = true;
      ledger.push(entry("=", "root",
        "Left the root `$ref` (`" + s.$ref + "`) alone. The Python `anthropic` SDK calls " +
        "`transform_schema()` with no root-type guard, and that function pops `$defs` BEFORE its " +
        "`$ref` early-return, so the definition travels with the pointer and the schema arrives " +
        "whole. This is the one case where the two SDKs produce different SCHEMAS rather than " +
        "different warnings — but note the TypeScript failure is LOUD, not silent: both public " +
        "helpers (`jsonSchemaOutputFormat`, `betaJSONSchemaOutputFormat`) reject a root `$ref` " +
        "outright with \"JSON schema must be an object, but got undefined\", because a `$ref` root " +
        "has no `type`. (Only the internal `transformJSONSchema`, called directly, loses `$defs` " +
        "quietly.) So if a TypeScript service also sends this schema it will fail fast rather than " +
        "mis-send — run `--to anthropic-json` and take its edit.",
        url, true));
    } else {
      s = inlineRootRef(s, ledger, url, (outputFormatPath && goSdk)
        ? "A root `$ref` costs you the entire schema on the Go SDK, silently. `transformSchema` " +
          "starts with `if s.Ref != \"\" { *s = jsonschema.Schema{Ref: s.Ref}; return }` — every " +
          "sibling is discarded, `$defs` included, and neither `BetaJSONSchemaOutputFormat` nor " +
          "`BetaToolInputSchema` has a root-type guard to catch it, so what reaches the API is a lone " +
          "dangling pointer with no error raised. (The TypeScript helpers at least throw \"JSON schema " +
          "must be an object\"; the Python SDK pops `$defs` first and survives.) Inlining fixes it on " +
          "all three. `{$ref, $defs}` from Pydantic's `RootModel` and `{$ref, definitions}` from " +
          "zod-to-json-schema are the two shapes that land here."
        : outputFormatPath
        ? "A root `$ref` has no `type`, and `@anthropic-ai/sdk`'s public helpers " +
          "(`jsonSchemaOutputFormat`, `betaJSONSchemaOutputFormat`) reject that outright: \"JSON " +
          "schema must be an object, but got undefined\". Call the internal `transformJSONSchema` " +
          "directly instead and it fails the other way — it returns as soon as it sees the `$ref` " +
          "and drops `$defs`, leaving a dangling pointer with the whole schema gone and no error. " +
          "Inlining fixes both. `{$ref, $defs}` from Pydantic's `RootModel` and `{$ref, definitions}` " +
          "from zod-to-json-schema are the two shapes that land here. (The Python SDK has no root-type " +
          "guard and keeps `$defs`, so it accepts the first shape — but the draft-07 `definitions` " +
          "spelling is lost there too.)"
        : "A root `$ref` has no `type` of its own, and `betaTool()` throws \"JSON schema for tool ... " +
          "must be an object, but got undefined\" on any root that is not `type: \"object\"`. Inlining " +
          "the referenced definition gives the root its object type back. (Measured against " +
          "@anthropic-ai/sdk@0.116.0.)", antRefBlocked);
    }

    if (outputFormatPath) {
      // The same early return means `$ref` siblings are dropped outright — not
      // even demoted to prose, which is how other unknown keywords survive.
      s = resolveRefSiblings(s, ledger, url,
        "Anthropic's transformer returns immediately on `$ref` and drops every sibling key silently — " +
        "a `description` next to a `$ref` simply vanishes rather than being demoted to prose",
        "Anthropic's transformer drops silently", antRefBlocked);
    }

    if (!s.type && isObjectSchema(s)) {
      s.type = "object";
      ledger.push(entry("+", "root",
        "Added `type: object` at the root. Both Anthropic paths require it: `betaTool()` throws " +
        "unless `input_schema.type === \"object\"`, and `jsonSchemaOutputFormat()` throws " +
        "\"JSON schema must be an object\".",
        url));
    } else if (s.type && s.type !== "object") {
      ledger.push(entry("!", "root",
        "The root must be an object on BOTH Anthropic paths — `betaTool()` and " +
        "`jsonSchemaOutputFormat()` each throw on a non-object root. Wrap this schema in an object.",
        url));
    } else if (!s.type && !rootRefKeptOnPurpose) {
      // The third arm, and it is now keyed on the OUTCOME rather than on a list
      // of keywords. Anthropic's root contract is exactly one thing, measured on
      // @anthropic-ai/sdk@0.116.0 across a shape battery: the root must carry a
      // literal `type: "object"`. Not "no combinators" — `{type:"object", anyOf:
      // [...]}` is ACCEPTED by both helpers. Not "no definition bag" — a nested
      // `definitions` bag is forwarded verbatim. Just the type.
      //
      // The previous spelling was `!s.type && !s.$ref && !s.anyOf && !s.oneOf &&
      // !s.allOf`, which named the keywords that could POSSIBLY have supplied a
      // type and then excused every one of them. A root that is nothing but
      // `anyOf` still has no `type`, and both helpers still throw — so the four
      // most common typeless roots there are went out at exit 0 or 1.
      var branches = [];
      var sawCombinator = false;
      ["anyOf", "oneOf", "allOf"].forEach(function (kw) {
        if (!Array.isArray(s[kw])) return;
        sawCombinator = true;
        s[kw].forEach(function (b) { branches.push(b); });
      });

      // A combinator root is repairable only when every branch is provably an
      // object: then `type: "object"` is implied by each branch already and
      // stating it changes nothing. If any branch admits a non-object, adding
      // the type DELETES that branch — the #348 inversion — so it is refused.
      var allObjects = sawCombinator && branches.length > 0 &&
        branches.every(function (b) {
          var r = isPlainObject(b) && typeof b.$ref === "string" ? resolveLocalDef(s, b.$ref) : b;
          return isPlainObject(r) && r.type === "object";
        });

      if (allObjects) {
        s.type = "object";
        ledger.push(entry("+", "root",
          "Added `type: object` at the root. Both Anthropic helpers throw \"JSON schema ... must " +
          "be an object, but got undefined\" on a root with no `type`, and a union root has none " +
          "of its own. This is lossless here because EVERY branch of this union is already " +
          "`type: \"object\"`, so an instance that satisfies any branch was an object anyway — the " +
          "set of legal values does not change, and the union itself is preserved. Measured on " +
          "@anthropic-ai/sdk@0.116.0: `{type: \"object\", anyOf: [...]}` is accepted by " +
          "`betaTool()` and `betaJSONSchemaOutputFormat()` alike. (Pydantic's " +
          "`RootModel[Union[A, B]]` emits exactly this shape: `{$defs, anyOf: [{$ref}, {$ref}]}` " +
          "with no root `type`.)",
          url));
      } else {
        var abag = isPlainObject(s.$defs) ? "$defs"
          : (isPlainObject(s.definitions) ? "definitions" : null);
        ledger.push(entry("!", "root",
          "The root has no `type`, and both Anthropic paths reject that outright: `betaTool()` " +
          "and `jsonSchemaOutputFormat()` each throw \"JSON schema ... must be an object, but got " +
          "undefined\"." +
          (sawCombinator
            ? " This root is a bare `anyOf`/`oneOf`/`allOf`, and at least one branch is not " +
              "provably `type: \"object\"` — so `type: \"object\"` cannot just be added here the " +
              "way it can for an all-object union: it would be accepted, and it would silently " +
              "DELETE every branch that admits a non-object. Wrap the union in an object instead " +
              "— `{\"type\":\"object\",\"properties\":{\"result\": <your union>},\"required\":" +
              "[\"result\"]}` — which keeps every branch. (A single-member `allOf` is the other " +
              "shape that lands here; flatten it into the root yourself.)"
            : abag
            ? " A `" + abag + "` bag is still here, so the definitions survived and the pointer into " +
              "them — a root `$ref` or `anyOf` — did not. One measured producer: `llama-index-core`'s " +
              "`ToolMetadata.get_parameters_dict()` keeps only `type`, `properties`, `required`, " +
              "`definitions` and `$defs`, so a `RootModel` tool schema arrives as its own definition " +
              "bag with no way in. Restore the root `$ref`, or inline the definition you meant."
            : " Declare the properties you expect.") +
          " Do NOT just add `type: \"object\"` to an empty root: that is accepted, and it leaves an " +
          "object whose only legal value is `{}` — a tool input that can never be populated.",
          url));
      }
    }

    // A node with no legal values. Anthropic carries all of these — measured on
    // @anthropic-ai/sdk@0.116.0: `anyOf: []` is accepted verbatim and `enum: []`
    // is demoted to the prose `{enum: []}` — so it is advisory, never a failure.
    // It must run ABOVE the tools-path return: that path applies no transform,
    // which is exactly why nothing else would ever mention a dead field there.
    walk(s, "root", function (node, path) {
      noteUnsatisfiable(node, path, ledger, url);
    });

    if (!outputFormatPath) {
      // Nothing else is a defect here, because nothing else runs. Saying so is
      // the whole value of this target — the alternative is a gate that fails
      // on a payload the vendor accepts byte-for-byte (#312/#317).
      ledger.push(entry("=", "root",
        "On `tools[].input_schema` Anthropic applies NO transform: the schema below goes on the wire " +
        "byte-identical, so tuples (`prefixItems`), `maxLength`/`minimum`, `format`, a `definitions` " +
        "bag and a non-exclusive `oneOf` all survive intact — none of them need fixing here. What is " +
        "NOT automatic is enforcement: set `strict: true` on the TOOL definition (not inside the " +
        "schema) — the SDK documents it as \"guarantees schema validation on tool names and inputs\". " +
        "Without it the schema is guidance the model can violate, so keep validating the response.",
        url, true));
      ledger.push(entry("=", "root",
        "If you are actually using the structured-output path (`output_format` / `output_config`: " +
        "`{type: \"json_schema\"}`) rather than a tool, this is the WRONG target — that path rebuilds " +
        "the schema and demotes every keyword it does not recognise into `description` prose. Re-run " +
        "with `--to anthropic-json` (TypeScript SDK) or `--to anthropic-json-python` (Python SDK); " +
        "they differ on `enum` and on a root `$ref`.",
        url, true));
      ledger.push(entry("=", "root",
        "And if your client is `anthropic-sdk-go`, this target is wrong even for tools. Go is the one " +
        "SDK where `tools[].input_schema` is NOT verbatim: `BetaToolInputSchema` calls the same " +
        "`transformSchemaMap` as `BetaJSONSchemaOutputFormat` (schemautil.go), so both surfaces get " +
        "the rebuild. Use `--to anthropic-go`.",
        url, true));
      noteEmptiedDocument(schema, s, ledger, url, ANTHROPIC_EMPTIED_REMEDY);
      return { schema: s, ledger: ledger };
    }

    // Pre-pass, deliberately BEFORE the main walk: an array-valued `type` makes
    // the transformer skip its per-type branch, so the demotion pass below would
    // otherwise report a gutted subtree as an ordinary unenforced keyword. The
    // root is left out on purpose — a union root is a genuine blocker (both
    // paths require `type === "object"`) and is already reported as one above.
    // An open map survives the tools path untouched, so this is not a defect of
    // the schema — it is a defect of THIS path, and it is silent: the
    // transformer rebuilds the node as `{"type":"object","properties":{},
    // "additionalProperties":false}`, i.e. a field that can only ever be `{}`.
    // Advisory, never a gate failure, because the request still returns 200 —
    // that is the established policy for everything this path destroys.
    //
    // On the Go path, first find every node BELOW a map edge that the SDK's own
    // recursion will overwrite with `true`. This has to run before the walk
    // below, because the reassuring branch of the open-map note is only true
    // when this comes back empty for that map.
    var goDeep = goSdk ? goTrueNodesUnderMaps(s) : [];
    goDeep.forEach(function (d) {
      // Same defect, same severity as the typeless rule in a walked position:
      // for `anthropic-go` that is a blocker, and making the identical node
      // advisory purely because of WHERE it sits would be arbitrary. The
      // outcome is the same either way — a node silently inverted into
      // match-anything — so the two positions are made to agree.
      ledger.push(entry("!", d.path,
        "This node sits inside `" + d.mapPath + "`'s value schema, and the Go SDK will REPLACE IT " +
        "with the literal JSON `true`. `transformSchema`'s dictionary clause recurses into " +
        "`additionalProperties` and then keeps going — into `properties`, `items`, `anyOf` and any " +
        "further maps below — and every node it reaches without a `type` (or `anyOf`/`allOf`/`enum`/" +
        "`const` to stand in for one) is overwritten with the zero `jsonschema.Schema`, which " +
        "marshals as `true`. So a well-typed map value does not protect what is underneath it. " +
        "Nothing is raised and the request returns 200. Give this node an explicit `type`. " +
        "(`z.record(z.string(), z.object({ x: z.never() }))` on zod 4 emits exactly this — the " +
        "value model is inlined under `additionalProperties`, and `x`, which admitted NO value, " +
        "comes back admitting every value. Pydantic is not affected: it routes the value model out " +
        "to `$defs`, which is a position this tool already reaches.)",
        url));
    });
    walk(s, "root", function (node, path) {
      if (!isOpenMap(node)) return;
      // Measured: the Go SDK is the only one of the three that gets this right.
      // `transformSchema`'s object branch has an explicit dictionary clause —
      // no `properties`, `additionalProperties` non-nil -> preserve and recurse
      // into the value schema. Reporting a loss here would be the
      // stricter-than-the-vendor bug this project has shipped four times.
      if (goSdk) {
        // The dictionary clause preserves the MAP. What it then does to the
        // VALUE is decided by the same guard every other node goes through, and
        // "recurses into the value schema" is the mechanism, not a reassurance:
        // a value schema with no `type` is replaced by the literal `true`, so
        // the map survives with its value type deleted. Measured on
        // anthropic-sdk-go@v1.62.0 -- `{"additionalProperties":{"not":{}}}`,
        // which is what zod@4.4.3 emits for `z.record(z.string(), z.never())`,
        // comes back as `{"type":"object","additionalProperties":true}`: a map
        // that admitted NO value now admits every value. Unique to Go; the
        // TypeScript and Python `output_format` transformers empty the map
        // itself and never look at the value schema at all.
        if (goReplacesWithTrue(node.additionalProperties)) {
          ledger.push(entry("=", path,
            "This is an open map, and the Go SDK keeps the map but DESTROYS the value schema. " +
            "`transformSchema`'s dictionary clause recurses into `additionalProperties`, and that " +
            "value schema has no `type` (and no `anyOf`/`allOf`/`enum`/`const` to stand in for one), " +
            "so the SDK overwrites it with the zero `jsonschema.Schema`, which marshals as the " +
            "literal JSON `true`. You get `additionalProperties: true` — every key legal, every " +
            "value legal. No error is raised, and the output is byte-identical to what a genuinely " +
            "unconstrained map produces, so nothing downstream can tell the two apart. " +
            "Give the value schema an explicit `type`. (`z.record(z.string(), z.never())` on zod 4 " +
            "emits `additionalProperties: {\"not\":{}}`, which means NO key is legal — that one " +
            "inverts completely.) The `--to anthropic` tools path keeps your value schema verbatim.",
            url, true));
          return;
        }
        // Keyed on the OUTERMOST map, not the nearest one: a nested map has no
        // note of its own, so its losses have to surface under the map the
        // reader can actually see.
        var deepHits = goDeep.filter(function (d) { return d.owner === path; });
        ledger.push(entry("=", path,
          "This is an open map (`additionalProperties` with no `properties`), and the Go SDK keeps it " +
          "— `transformSchema` has an explicit dictionary clause that preserves `additionalProperties` " +
          "and recurses into the value schema. " + (deepHits.length
            ? "That recursion does not stop at the value schema, and it does not leave this subtree " +
              "intact: " + deepHits.length + " node" + (deepHits.length > 1 ? "s" : "") + " below this map " +
              "(" + deepHits.map(function (d) { return "`" + d.path + "`"; }).join(", ") + ") " +
              (deepHits.length > 1 ? "are" : "is") + " overwritten with `true`. See the entr" +
              (deepHits.length > 1 ? "ies" : "y") + " above."
            : "Your value schema declares a `type` and nothing below it is typeless, so that " +
              "recursion leaves the subtree intact.") + " Worth knowing only because the other " +
          "two paths differ: `--to anthropic-json` (TypeScript) rebuilds this node as " +
          "`{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}`, so the field can " +
          "never be populated, and `--to openai` blocks it outright.",
          url, true));
        return;
      }
      ledger.push(entry("=", path,
        "This is an open map (`additionalProperties` with no `properties`). The " +
        "`output_format` transformer discards your `additionalProperties` and forces " +
        "`false`, leaving `{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}` " +
        "— an object whose only legal value is `{}`, so the model can never populate this " +
        "field. No error is raised. " + OPEN_MAP_REMEDY +
        " It survives intact on `tools[].input_schema` (`--to anthropic`), which applies no " +
        "transform at all.",
        url, true));
    });

    // The other half of the same keyword, and the half nothing looked at: a node
    // that declares `properties` AND still carries a typed `additionalProperties`.
    // Two losses, and the second is the one that reads as a bug rather than a
    // missing constraint:
    //   1. the value schema is DELETED outright -- everything the extra keys were
    //      required to look like is gone;
    //   2. the map is CLOSED -- keys that were legal before are illegal after, so
    //      this NARROWS the accept set rather than widening it (#348).
    // Advisory, never a gate failure: the request still returns 200 and the
    // vendor is the one doing this, so blocking would be the
    // stricter-than-the-vendor bug this project has shipped repeatedly.
    walk(s, "root", function (node, path) {
      if (!hasTypedCatchall(node)) return;
      var had = node.additionalProperties === true
        ? "allowed any extra keys"
        : "required every extra key to match a schema of its own";
      ledger.push(entry("=", path,
        "This node declares `properties` AND an `additionalProperties` that " + had + " " +
        "(`z.object({...}).catchall(...)` emits exactly this). The `output_format` transformer " +
        "throws that schema away and forces `additionalProperties: false`, so two things change " +
        "silently: the extra keys stop being accepted at all, and whatever they were required to " +
        "look like is gone. No error is raised, and unlike an open map the node still looks " +
        "healthy afterwards — the declared properties are untouched. " +
        "ALL THREE SDKs do this, including Go: `transformSchema`'s dictionary clause only " +
        "preserves `additionalProperties` when the node has NO `properties`, so the very thing " +
        "that saves a plain open map on `--to anthropic-go` is what condemns this shape. " +
        "It survives intact on `tools[].input_schema` (`--to anthropic`), which applies no " +
        "transform at all. If the extra keys matter, declare them as fixed `properties`, or move " +
        "them into their own map field so the value type has somewhere to live.",
        url, true));
    });

    // The SAME question as the open-map arm above, asked through the other three
    // spellings of "this object admits a key" (#348). It needs its own arm
    // because the mechanism that destroys the node here is not a strip — it is
    // the demote-to-prose policy, which normally reads as graceful degradation.
    //
    // For a node that also declares `properties`, demotion IS graceful: the
    // field survives and only the pattern stops being enforced, which the
    // generic demotion note below already says correctly. For a node whose ONLY
    // way of admitting a key is one of these keywords, the same demotion plus
    // the forced close leaves `{"type":"object","properties":{},
    // "additionalProperties":false}` — the field can never be populated. #348's
    // composition (a strip WIDENS, a strip plus a forced default INVERTS) with
    // demote-to-prose standing in for the strip, and the prose framing is
    // exactly what hides it: "the model is told about it but nothing validates
    // it" is true of the keyword and false of the field.
    //
    // Measured 2026-08-10 on `@anthropic-ai/sdk@0.116.0`, `anthropic==0.121.0`
    // and `anthropic-sdk-go@v1.62.0`: 3-0 DESTROYED, with a discriminating
    // control (an ordinary closed object and a node carrying `properties` both
    // survive). Note that is a DIFFERENT split from the plain open map, which
    // goes 2-1 because Go's dictionary clause rescues it — that clause keys on
    // `additionalProperties`, so it does nothing for these three spellings.
    //
    // Advisory, never a gate failure: the request returns 200 and the VENDOR is
    // the one doing this, so blocking would be the stricter-than-the-vendor bug
    // this project has shipped repeatedly.
    walk(s, "root", function (node, path) {
      var ev = mapKeyEvidence(node);
      // `!isOpenMap` keeps a node reported once: zod 4's `z.record()` emits
      // `propertyNames` AND `additionalProperties` (measured on zod@4.4.3), so
      // it is an open map and the arm above already owns it.
      if (!ev.length || !isObjectSchema(node) || isOpenMap(node)) return;
      if (hasUsableProperties(node)) return;
      var names = ev.map(function (k) { return "`" + k + "`"; }).join(" + ");
      // Go alone loses `unevaluatedProperties` with no trace: invopop's `Schema`
      // models `patternProperties` and `propertyNames` but has no field for it,
      // so `encoding/json` drops it BEFORE Anthropic's transform can demote it
      // (#332's two-severity mechanism). Same dead node either way — but on the
      // other two the model at least sees the prose.
      var silent = goSdk && ev.length === 1 && ev[0] === "unevaluatedProperties";
      ledger.push(entry("=", path,
        "This object describes its keys with " + names + " and declares no `properties`, " +
        "so those keywords are the only thing admitting a key. " +
        (silent
          ? "The Go SDK has no field for `unevaluatedProperties` (invopop's `Schema` models " +
            "`patternProperties` and `propertyNames` but not this one), so it is dropped before " +
            "the transform runs — not even demoted to prose. "
          : "The transformer does not recognise them, so it demotes them into `description` " +
            "text and then forces `properties: {}` + `additionalProperties: false`. ") +
        "What is left is `{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}` " +
        "— an object whose only legal value is `{}`, so the model can never populate this field. " +
        "No error is raised. This is worth separating from the ordinary \"demoted to prose\" note: " +
        "there the field still works and only the constraint stops being enforced, whereas here " +
        "the keyword was the node's only way of admitting a key, so demoting it and closing the " +
        "object NARROWS the field to nothing rather than widening it. " +
        "ALL THREE SDKs do this — unlike a plain open map, which the Go SDK preserves via a " +
        "dictionary clause that keys on `additionalProperties` and so does nothing here. " +
        (goSdk
          ? "There is no verbatim escape hatch in Go: `BetaToolInputSchema` runs the same " +
            "`transformSchemaMap`, so both surfaces rebuild the node."
          : "It survives intact on `tools[].input_schema` (`--to anthropic`), which applies no " +
            "transform at all.") +
        " " + OPEN_MAP_REMEDY,
        url, true));
    });

    walk(s, "root", function (node, path) {
      if (path === "root") return;
      normalizeAnthropicUnionType(node, path, ledger, url, sdk);
    });

    var demoted = [];
    walk(s, "root", function (node, path) {
      // Tuples: `items`-as-array and `prefixItems` both reach the transformer
      // with no `type` and throw. The error text ("must have a type defined")
      // points nowhere near the real cause, so say what it is.
      if (normalizeTuple(node, path, ledger, url, goSdk
            ? "The Go SDK has no tuple form, and the two spellings fail differently — the draft-07 " +
              "one catastrophically. Array-form `items: [A, B]` cannot be unmarshalled into " +
              "`invopop/jsonschema.Schema` at all (its `Items` field is a `*Schema`), so " +
              "`transformSchemaMap` returns nil and the WHOLE document is dropped, swallowing the " +
              "error — measured on anthropic-sdk-go@v1.62.0. A bare `prefixItems` survives the " +
              "unmarshal but is not in `supportedSchemaKeys`, so it is demoted to prose, leaving an " +
              "array with no item schema and no length at all."
            : "Anthropic's structured-output transformer has no tuple form, and the two spellings fail " +
            "differently: array-form `items` (and `prefixItems` next to `items: false`) makes it throw " +
            "\"JSON schema must have a type defined if anyOf/oneOf/allOf are not used\" — a message " +
            "that never mentions tuples — while a bare `prefixItems` is quietly demoted to prose, " +
            "leaving an array with no item schema and no length at all.",
            goSdk
            ? "The Go SDK has no tuple form — array-form `items` makes the whole document come back " +
              "nil, and a bare `prefixItems` leaves an array with no item schema at all — so this " +
              "recovers the element type, which is the part that was being lost outright. The length " +
              "is a weaker guarantee here: `minItems` survives only when it is 0 or 1, and `maxItems` " +
              "is not in `supportedSchemaKeys` at all, so a fixed length of 2+ reaches the model as " +
              "prose only (and, because of the pointer-formatting bug, as a memory address)."
            : "Anthropic's transformer has no tuple form — it would either throw or, for a bare " +
            "`prefixItems`, leave an array with no item schema at all — so this recovers the element " +
            "type, which is the part that was being lost outright. The length is a weaker guarantee " +
            "here: on the `output_format` path `minItems` survives only when it is 0 or 1 and " +
            "`maxItems` never does, so a fixed length of 2+ reaches the model as prose only. On the " +
            "`tools[].input_schema` path both are sent as-is and do constrain.")) {
        return;
      }

      // `oneOf` is rewritten to `anyOf` by the transformer. Do it here so the
      // output matches the wire payload instead of differing from it.
      if (Array.isArray(node.oneOf) && !Array.isArray(node.anyOf)) {
        node.anyOf = node.oneOf;
        delete node.oneOf;
        ledger.push(entry("~", path,
          "Rewrote `oneOf` to `anyOf` — the transformer does this itself, so this is what actually " +
          "goes on the wire. Note the semantics differ: `oneOf` means exactly one branch matches, " +
          "`anyOf` means at least one.",
          url));
        // Anthropic and OpenAI diverge here, so the rule is NOT ported between
        // them (#314). `transformJSONSchema` maps oneOf -> anyOf with NO
        // exclusivity proof, so when branches can both match the constraint is
        // genuinely weakened on the wire — by the vendor, not by us. OpenAI's
        // transformer throws in that case; Anthropic's does not, so this is a
        // warning, never a gate failure.
        if (!oneOfProvablyExclusive(node.anyOf, s)) {
          ledger.push(entry("!", path,
            "These `oneOf` branches are not provably mutually exclusive, so \"exactly one\" becomes " +
            "\"at least one\" on the wire. Anthropic's own transformer performs this rewrite " +
            "unconditionally, so the widening happens with or without this tool — but nothing warns " +
            "you. If exclusivity matters, add a discriminator property with distinct literal values.",
            url, true));
        }
      } else if (Array.isArray(node.oneOf) && Array.isArray(node.anyOf)) {
        // `_transformJSONSchema` pops both and takes `anyOf` first, so a
        // co-existing `oneOf` is discarded outright — silently, like every
        // other Anthropic loss on this path.
        ledger.push(entry("!", path,
          "This node has both `anyOf` and `oneOf`. Anthropic's transformer reads `anyOf` first and " +
          "DISCARDS `oneOf` entirely — no error, no warning, the constraint is simply gone. Merge " +
          "them into one `anyOf` so what you send is what you meant.",
          url, true));
      }

      // No `type` and nothing to stand in for it -> throws on Path O.
      if (node.type === undefined && !node.$ref &&
          !Array.isArray(node.anyOf) && !Array.isArray(node.oneOf) && !Array.isArray(node.allOf)) {
        var vals = Array.isArray(node.enum) ? node.enum
                 : (node.const !== undefined ? [node.const] : null);
        var inferred = vals ? inferTypeFromValues(vals) : null;
        if (inferred) {
          node.type = inferred;
          ledger.push(entry("+", path,
            "Added `type: " + inferred + "`, inferred from the " +
            (Array.isArray(node.enum) ? "`enum` members" : "`const` value") + ". " + (goSdk
              ? "The Go SDK treats a typeless node as unusable, but it does not say so: " +
                "`transformSchema` overwrites it with the zero `jsonschema.Schema`, which marshals as " +
                "the literal JSON `true` — a match-anything schema. (A bare `enum`/`const` node is " +
                "actually spared, because those count as shape information, but adding the `type` " +
                "makes the intent explicit and is lossless.)"
              : "Without a `type` the transformer throws \"JSON schema must have a type defined if " +
                "anyOf/oneOf/allOf are not used\" — a bare enum is the most common way to hit that."),
            url));
        } else {
          ledger.push(entry("!", path, goSdk
            ? "This node has no `type` and no `anyOf`/`oneOf`/`allOf`/`enum`/`const`, and the Go SDK " +
              "does not reject it — it REPLACES it with the literal JSON `true`, a schema that " +
              "matches anything. `transformSchema` bails on a node it cannot key on by assigning the " +
              "zero `jsonschema.Schema`, and `MarshalJSON` renders that as `true`. Measured: a node " +
              "carrying only `{\"description\": \"...\"}` comes back as `true`, description included. " +
              "Give it an explicit `type`."
            : "This node has no `type` and no `anyOf`/`oneOf`/`allOf`, so Anthropic's " +
              "structured-output transformer throws \"JSON schema must have a type defined if " +
              "anyOf/oneOf/allOf are not used\". Give it an explicit `type`.",
            url));
        }
      }

      // Everything the transformer does not recognise survives only as prose.
      Object.keys(node).forEach(function (k) {
        if (anthropicRecognises(node, k, sdk)) return;
        if (k === "$schema" && path !== "root") return;
        demoted.push({ path: path, key: k, node: node });
      });

      // The SDKs disagree about `enum`, so whichever target you picked, say what
      // the OTHER one would do with this exact node. Advisory only: an `enum` is
      // kept either way, so it can never be a gate failure (#317).
      // On the JS target `enum` is already reported by the demotion pass below,
      // so only the Python target needs a note here — otherwise the same node
      // would be described twice in one ledger.
      if (goSdk && (Array.isArray(node.enum) || node.pattern !== undefined || node.const !== undefined)) {
        var kept = ["enum", "const", "pattern"].filter(function (k) {
          return k === "enum" ? Array.isArray(node.enum) : node[k] !== undefined;
        });
        ledger.push(entry("=", path,
          kept.map(function (k) { return "`" + k + "`"; }).join(" and ") +
          " survive here — `anthropic-sdk-go`'s `supportedSchemaKeys` lists all three, so they reach " +
          "the API rather than this node's `description`. Worth knowing if this schema is shared: the " +
          "vendor's three SDKs have three different supported-key sets at the same vendor. " +
          "`@anthropic-ai/sdk` demotes all three to prose; `anthropic` (Python) keeps `enum` only; " +
          "`pattern` is kept by Go alone. Check the other two with `--to anthropic-json` and " +
          "`--to anthropic-json-python`.",
          url, true));
      }

      if (pythonSdk && Array.isArray(node.enum)) {
        ledger.push(entry("=", path,
          "`enum` IS enforced here — the Python `anthropic` SDK preserves it verbatim. Worth knowing " +
          "if this schema is shared: the TypeScript SDK at the SAME version number does not. " +
          "`@anthropic-ai/sdk@0.116.0` stringifies it into this node's `description`, so a service " +
          "sending this file from TypeScript gets an unenforced enum. Check with `--to anthropic-json`.",
          url, true));
      }
    });

    // These are reported, never stripped. Stripping would destroy a constraint
    // that IS still enforced on the tools path and buys nothing on either —
    // the #314 rule: read the provider's error policy before porting a strip.
    demoted.forEach(function (d) {
      // Go splits "unsupported" into two very different outcomes, and the worse
      // one is invisible: a keyword `invopop/jsonschema` does not model is
      // dropped by `Schema.UnmarshalJSON` before `transformSchema` runs, so it
      // never reaches the extras-to-description path at all.
      if (goSdk && !GO_INVOPOP_MODELLED[d.key]) {
        ledger.push(entry("=", d.path,
          "`" + d.key + "` is DELETED without a trace by the Go SDK — not demoted to prose like the " +
          "keywords below it. `transformSchemaMap` round-trips your map through " +
          "`invopop/jsonschema.Schema`, whose `UnmarshalJSON` is a plain alias unmarshal with no " +
          "catch-all, so a keyword that library does not model is gone before Anthropic's own " +
          "transform runs and cannot be appended to any `description`. Nothing is logged. If this " +
          "keyword carries meaning for a downstream consumer, keep it somewhere other than the " +
          "schema you hand the SDK." + VERBATIM_ESCAPE,
          url, true));
        return;
      }
      // `format` is the one demoted key whose Go guard tests the VALUE, not the
      // key: `if s.Format != "" && !slices.Contains(supportedStringFormats, ...)`
      // (schemautil.go). An empty or null `format` therefore skips the demotion
      // branch entirely, and `invopop` declares `Format` as a bare `string` with
      // `omitempty`, so it is then serialised away. Measured on v1.62.0: the key
      // vanishes with NO `description` entry, where JS/Python both write
      // `{format: ""}` / `{format: null}` into prose. Saying "appended to the
      // description" here would be the #334 error — reporting a silent drop as a
      // visible demotion.
      if (goSdk && d.key === "format" &&
          (d.node.format === "" || d.node.format === null)) {
        ledger.push(entry("=", d.path,
          "`format` is DELETED without a trace here, not demoted to prose. The Go SDK guards its " +
          "format check on `s.Format != \"\"` (schemautil.go), so an empty or null value skips the " +
          "demotion branch, and `invopop` declares the field as a bare `string` with `omitempty` — so " +
          "it is serialised away with nothing written to this node's `description`. " +
          "`@anthropic-ai/sdk` and `anthropic` (Python) both guard on the key being PRESENT rather " +
          "than non-empty, so they record `{format: " +
          (d.node.format === null ? "null" : "\"\"") + "}` as text. Measured on " +
          "anthropic-sdk-go@v1.62.0. An empty `format` constrains nothing either way, so this costs " +
          "you no enforcement — it is flagged so the three SDKs' outputs are not assumed identical." +
          VERBATIM_ESCAPE,
          url, true));
        return;
      }
      if (goSdk && GO_POINTER_FORMATTED[d.key]) {
        ledger.push(entry("=", d.path,
          "`" + d.key + "` is not enforced by the Go SDK — and it does not even arrive as readable " +
          "prose. `formatExtraValue` (schemautil.go) dereferences pointers with reflect but then " +
          "formats the ORIGINAL value, and `invopop` declares this field as `*uint64`, so this node's " +
          "`description` gets a hexadecimal address: `{" + d.key + ": 0x162d307bcc80}`. The model is " +
          "told a memory address. Measured on anthropic-sdk-go@v1.62.0; reported upstream. " +
          "(`minItems` is the one length keyword that escapes this — the array branch dereferences it " +
          "explicitly before demoting.) Kept here, not stripped, because your value is the thing that " +
          "should have been quoted." + VERBATIM_ESCAPE,
          url, true));
        return;
      }
      var extra = "";
      if (d.key === "format") {
        extra = " Only these 10 `format` values survive: " +
          Object.keys(ANTHROPIC_STRING_FORMATS).join(", ") + ".";
      } else if (d.key === "minItems") {
        extra = " `minItems` survives only when it is exactly 0 or 1; any other value is demoted.";
      } else if (d.key === "additionalProperties") {
        extra = " On the output_format path the transformer discards your value and forces " +
          "`additionalProperties: false` regardless; on the tools path your value is sent as-is.";
      } else if (d.key === "enum") {
        // The one keyword where the vendor's two SDKs disagree about enforcement.
        extra = " This one is SDK-specific: the Python `anthropic` SDK PRESERVES `enum` on this same " +
          "path, so it really is enforced there. Not a version skew you can upgrade past — measured " +
          "identical on Python 0.110.0/0.116.0/0.121.0 against `@anthropic-ai/sdk@0.116.0`, i.e. the " +
          "same version string, opposite behaviour. If your request is built in Python, re-run with " +
          "`--to anthropic-json-python`.";
      }
      ledger.push(entry("=", d.path,
        "`" + d.key + "` is NOT enforced" + (goSdk
          ? " by the Go SDK — " + (ANTHROPIC_GO_SUPPORTED[d.key]
              ? "`supportedSchemaKeys` lists it, but `transformSchema`'s per-type branch demotes this " +
                "particular value anyway, so"
              : "it is not in `supportedSchemaKeys`, so")
          : " on the structured-output path WHENEVER ANTHROPIC'S TRANSFORM RUNS. The transformer does " +
            "not recognise it, so") +
        " it is appended to this node's `description` as text — the model is told about it but " +
        "nothing validates it." + TRANSFORM_CONDITION + VERBATIM_ESCAPE + extra,
        url, true));
    });

    var hasSubstantive = ledger.some(function (e) { return !e.advisory && e.op !== "="; });
    if (!hasSubstantive) {
      ledger.push(entry("=", "root", goSdk
        ? "No structural changes needed for `anthropic-sdk-go` — but read the notes above, because " +
          "they are the point: `transformSchemaMap` accepts this schema and then quietly demotes what " +
          "`supportedSchemaKeys` does not list, and deletes outright what `invopop/jsonschema` does " +
          "not model. Both of Go's helpers run it, so there is no verbatim surface to fall back to."
        : "No structural changes needed for the structured-output path — but read the " +
        "unenforced-keyword notes above, because they are the point: WHEN THE TRANSFORM RUNS it " +
        "accepts this schema and then silently demotes what it does not recognise to `description` " +
        "prose. Whether it runs is decided by your call site, not by the request field — see the " +
        "condition spelled out in those notes. If you are sending the schema as " +
        "`tools[].input_schema` instead, use `--to anthropic`, where it goes on the wire verbatim " +
        "and none of those notes apply.",
        url));
    }
    noteEmptiedDocument(schema, s, ledger, url, ANTHROPIC_EMPTIED_REMEDY);
    return { schema: s, ledger: ledger };
  }

  // ---- Gemini: TWO paths, and `$schema` is the switch between them ----------
  //
  // Verified 2026-08-09 against the vendor SDK `@google/genai@2.16.0`, not the
  // doc — the doc describes only the narrow path and never mentions the switch.
  //
  //   `GoogleGenAI.maybeMoveToResponseJsonSchema()`: if the schema handed to
  //   `responseSchema` contains a `$schema` key, the SDK MOVES it to the
  //   `responseJsonSchema` request field and sends it VERBATIM (`tJsonSchema`
  //   is the identity function). That path is full JSON Schema — `$ref`,
  //   `$defs` and recursion all survive to the wire.
  //
  //   With no `$schema` key it goes to `responseSchema`, which is the narrow
  //   `Schema` proto: `processJsonSchema()` upper-cases `type` and drops
  //   `additionalProperties`.
  //
  // This matters because `zod-to-json-schema` ALWAYS emits `$schema` and
  // `pydantic.model_json_schema()` never does — so the two generators our
  // audience uses land on opposite paths by default.
  //
  // GEMINI_ALLOWED below is the field list of the SDK's own exported `Schema`
  // interface (dist/genai.d.ts) — the vendor's encoding of what the proto
  // accepts. It is NOT the SDK's pass-through behaviour: `processJsonSchema`
  // is close to an identity function and forwards unknown keywords untouched,
  // so "the SDK didn't strip it" proves nothing here. (Contrast OpenAI, where
  // the transformer throws and pass-through IS the signal — see #312.)
  //
  // Corrections this list encodes, both directions:
  //   ADDED   pattern, minLength, maxLength, minProperties, maxProperties,
  //           default, example — all in the vendor `Schema` type, all of which
  //           the previous doc-derived list deleted. Pydantic emits
  //           minLength/maxLength/pattern/title constantly.
  //   REMOVED prefixItems — absent from `Schema` (same false pass as the
  //           OpenAI `prefixItems` bug fixed in the previous cycle).
  //   REMOVED additionalProperties — absent from `Schema`, and the SDK
  //           explicitly skips it ("not included in JSONSchema, skipping it").
  var GEMINI_ALLOWED = {
    "anyOf": 1, "default": 1, "description": 1, "enum": 1, "example": 1,
    "format": 1, "items": 1, "maxItems": 1, "maxLength": 1, "maxProperties": 1,
    "maximum": 1, "minItems": 1, "minLength": 1, "minProperties": 1,
    "minimum": 1, "nullable": 1, "pattern": 1, "properties": 1,
    "propertyOrdering": 1, "required": 1, "title": 1, "type": 1
  };
  // `format` values the vendor NAMES, per type. Source: the `format` field
  // description on `types.Schema` in `google-genai` 2.17.0 — the same class of
  // vendor-authored enumeration that gave us the `response_json_schema`
  // accepted-property list (#314), and the strongest one available here:
  //   "Optional. The format of the data. For `NUMBER` type, format can be
  //    `float` or `double`. For `INTEGER` type, format can be `int32` or
  //    `int64`. For `STRING` type, format can be `email`, `byte`, `date`,
  //    `date-time`, `password`, AND OTHER FORMATS to further refine the data
  //    type."
  //
  // Note the last clause: this is an OPEN list, not an allowlist. That is why
  // nothing is stripped on the strength of it — see the `format` rule below.
  // `enum` is documented separately, by the two worked examples in the same
  // docstring (`{type:STRING, format:enum, enum:[…]}` and `{type:INTEGER,
  // format:enum, enum:["101"]}`), and is the encoding #316 emits for a
  // non-string enum, so it must stay documented for both types.
  var GEMINI_NAMED_FORMATS = {
    "string":  { "email": 1, "byte": 1, "date": 1, "date-time": 1, "password": 1, "enum": 1 },
    "integer": { "int32": 1, "int64": 1, "enum": 1 },
    "number":  { "float": 1, "double": 1 }
  };

  // Keywords the BACKEND accepts but NO client type declares.
  //
  // GEMINI_ALLOWED above is a client-derived list — the JS `.d.ts` (#314), the
  // Python `types.Schema` (#314b) and the Go struct's json tags (#334), which
  // agreed exactly, and that agreement was read as "this is the proto". It is
  // not. Measured 2026-08-09 against the live `v1beta` `generateContent`
  // endpoint, which validates the payload BEFORE auth and so returns a real
  // verdict with a dummy key: an unknown field comes back as
  //   Invalid JSON payload received. Unknown name "X" at
  //   'generation_config.response_schema': Cannot find field.
  // Eleven keywords we strip do exactly that (`$ref`, `$schema`, `const`,
  // `uniqueItems`, `exclusiveMinimum`, `patternProperties`, `propertyNames`,
  // `if`, `contains`, `dependentRequired`, `multipleOf`), and a bogus `type`
  // control is rejected too, so the oracle is live and discriminating.
  // These three are NOT rejected, at the root or nested — the proto has the
  // fields, so the message "the proto cannot carry it" was false for them and
  // stripping deleted a constraint the destination would have accepted.
  //
  // Per client, on the SAME three (measured, not ported):
  //   @google/genai 2.16.0 (JS) — forwards all three verbatim into
  //     `responseSchema`; the request builds and the payload validates.
  //   google-genai 2.17.0 (Python) — `types.Schema` is `extra="forbid"`, so
  //     `model_validate` raises for each, at the root and nested.
  //   google.golang.org/genai (Go) — no such struct fields, so `encoding/json`
  //     drops them with `err == nil`: `{"oneOf":[…]}` unmarshals to `{}`.
  // So this is #334's three-client split again, and Go is again the silent one.
  var GEMINI_PROTO_ONLY = { "oneOf": 1, "allOf": 1, "not": 1 };

  // #365. `--to gemini-client` is named for a CLASS — "the caller hands JSON
  // Schema to a layer that rebuilds the request" — and until now it encoded
  // exactly ONE member of that class, `google-adk`. The members DISAGREE about
  // these very three keywords, so deciding for all of them was a guess wearing a
  // measurement's clothes.
  //
  // Measured 2026-08-10, each keyword on a node of the type it belongs to and
  // beside a `description` CONTROL that must survive, so a DROPPED verdict
  // cannot be an artifact of an unreached node (#364's method). `@ai-sdk/google`
  // read from the REAL wire payload via an intercepting `fetch` (#316), not from
  // its source; `google-adk` from `_to_gemini_schema` directly.
  //
  //   keyword | google-adk 2.6.3 | @ai-sdk/google 4.0.39
  //   oneOf   | DROPPED, node emptied | forwarded verbatim, recursed
  //   allOf   | DROPPED, node emptied | forwarded verbatim, recursed
  //   not     | DROPPED               | DROPPED
  //
  // #368 measured the three members #365/#366 recorded as UNMEASURED. Same
  // battery, same controls, all of which survived:
  //
  //   keyword | agno 2.8.7 | litellm 1.96.0 | @langchain/google-genai 2.2.0
  //   oneOf   | DROPPED, emptied | DROPPED, emptied | forwarded verbatim
  //   allOf   | DROPPED, emptied | DROPPED, emptied | forwarded verbatim
  //   not     | DROPPED          | DROPPED          | forwarded verbatim
  //
  // So the keep decision holds against five members rather than two: 3 drop
  // `oneOf`/`allOf` and 2 forward them; 4 drop `not` and 1 forwards it. For
  // every dropper our output is byte-identical to stripping, so keeping costs
  // them nothing and buys the forwarders an entire union.
  //
  // The decisive part is not that they disagree, it is the ASYMMETRY of the
  // strip we used to do. For google-adk, stripping bought NOTHING: its output is
  // byte-identical whether we strip the keyword or hand it over intact, because
  // it drops the keyword itself. For @ai-sdk/google it cost everything — that
  // client forwards `oneOf` and the live v1beta proto accepts it (#343), so we
  // were deleting a union that would have been enforced. A strip that is a no-op
  // for the client it was written for and a deletion for the client it was not.
  //
  // And neither client ERRORS on any of the three; both ignore what they cannot
  // carry. #314's error policy has one answer for that and it is the same answer
  // `--to gemini` already gives: ignore -> KEEP and flag, never strip.
  //
  // Snapshot, like the Go tables (#361) and #364's AI-SDK table: this suite is
  // dependency-free and cannot run either client, so re-measure on a version bump.
  // #368: DERIVED from GEMINI_CLIENT_MEMBERS below rather than hand-written, so
  // the exported table cannot drift from the measurements it summarises (#361).
  // It gained `not` when a fifth member turned out to forward it — with two
  // members it was `["oneOf","allOf"]` and that was a true statement about those
  // two, not about the class.
  //
  // NOTE the branch below keys on GEMINI_ANYOF_REMEDY, not on this: whether a
  // keyword is carried by SOMEBODY and whether a dropped keyword has a lossless
  // remodelling are different questions, and `not` answers them differently
  // (one client forwards it; there is no `anyOf` form of a negation).
  var GEMINI_ANYOF_REMEDY = { "oneOf": 1, "allOf": 1 };

  // #368. The class has a SECOND axis, and on it there is no intersection form.
  //
  // `nullForm` is what the client needs for an optional field, measured on the
  // real wire payload for the JS clients:
  //
  //   "rewrites" — the client turns `type:["X","null"]` into `nullable` ITSELF
  //                and DROPS a hand-written `nullable`. Needs the union form;
  //                handing it `nullable` loses the null constraint SILENTLY.
  //   "either"   — carries both forms to the backend intact.
  //   "forwards" — performs no rewrite. The union form reaches `responseSchema`
  //                verbatim and the proto REJECTS it ("Proto field is not
  //                repeating"), so this client needs `nullable`.
  //
  // A "forwards" client is not really a converting client at all: it is
  // transparent, so the document must satisfy the narrow proto directly, which
  // is exactly what `--to gemini` produces. That is why no new target is
  // warranted here (#362/#336 — a separate target is for a destination needing
  // a different DOCUMENT, and this one already exists).
  //
  // 3 rewrite, 1 either, 1 forwards. We emit the union form because the cost of
  // being wrong differs: a "forwards" client gives a LOUD 400 the caller can
  // act on, while "rewrites" clients lose nullability SILENTLY (#347/#335/#329).
  var GEMINI_CLIENT_MEMBERS = [
    { client: "google-adk",              version: "2.6.3",  forwards: [],                    nullForm: "rewrites" },
    { client: "agno",                    version: "2.8.7",  forwards: [],                    nullForm: "rewrites" },
    { client: "@ai-sdk/google",          version: "4.0.39", forwards: ["oneOf", "allOf"],    nullForm: "rewrites" },
    { client: "litellm",                 version: "1.96.0", forwards: [],                    nullForm: "either" },
    { client: "@langchain/google-genai", version: "2.2.0",  forwards: ["oneOf", "allOf", "not"], nullForm: "forwards" }
  ];

  // Derived so the prose below cannot drift from the table (#361).
  function geminiClientsBy(nullForm) {
    return GEMINI_CLIENT_MEMBERS.filter(function (m) { return m.nullForm === nullForm; });
  }
  function geminiClientsForwarding(kw) {
    return GEMINI_CLIENT_MEMBERS.filter(function (m) { return m.forwards.indexOf(kw) !== -1; });
  }
  function namesOf(list) {
    return list.map(function (m) { return "`" + m.client + "` " + m.version; }).join(", ");
  }
  // Every keyword at least one measured client forwards, derived not asserted.
  var GEMINI_CLIENT_CARRIED = {};
  GEMINI_CLIENT_MEMBERS.forEach(function (m) {
    m.forwards.forEach(function (k) { GEMINI_CLIENT_CARRIED[k] = 1; });
  });

  // The OTHER path. `google-genai` (Python) 2.17.0 documents the backend's
  // accepted set for `response_json_schema` verbatim on the field itself:
  //   "While the full JSON Schema may be sent, not all features are supported.
  //    Specifically, only the following properties are supported: $id, $defs,
  //    $ref, $anchor, type, format, title, description, enum (for strings and
  //    numbers), items, prefixItems, minItems, maxItems, minimum, maximum,
  //    anyOf, oneOf (interpreted the same as anyOf), properties,
  //    additionalProperties, required. The non-standard propertyOrdering
  //    property may also be set."
  //
  // So "the JS SDK sends it verbatim" describes the TRANSPORT, not acceptance.
  // Both SDKs' JSON-Schema path is a literal identity function (`t_json_schema`
  // in Python, `tJsonSchema` in JS), so — unlike the `responseSchema` path,
  // where `types.Schema` is `extra="forbid"` and therefore a hard oracle — the
  // vendor gives NO machine verdict here. The field text is the only source,
  // and it says the full schema MAY BE SENT: unsupported keywords are ignored,
  // not rejected. That is why unsupported keywords are kept + flagged advisory
  // below instead of stripped. Two clauses ARE phrased as prohibitions, and
  // those are treated as real findings: a `$ref` sub-schema may carry no
  // non-`$` siblings, and cyclic refs may only be used in non-required
  // properties.
  //
  // The two paths are partly COMPLEMENTARY, and neither is a superset:
  //   only responseSchema     : pattern, minLength, maxLength, minProperties,
  //                             maxProperties, default, example, nullable
  //   only responseJsonSchema : $ref, $defs, $anchor, $id, prefixItems,
  //                             additionalProperties, oneOf
  var GEMINI_JSON_ALLOWED = {
    "$schema": 1, "$id": 1, "$defs": 1, "$ref": 1, "$anchor": 1,
    "type": 1, "format": 1, "title": 1, "description": 1, "enum": 1,
    "items": 1, "prefixItems": 1, "minItems": 1, "maxItems": 1,
    "minimum": 1, "maximum": 1, "anyOf": 1, "oneOf": 1, "properties": 1,
    "additionalProperties": 1, "required": 1, "propertyOrdering": 1
  };

  // The keywords the NARROW `responseSchema` path genuinely enforces and this
  // one does not. This is a fact about GEMINI, and on its own it is exactly the
  // half that misleads: it is the list our "switch paths to get it enforced"
  // remedy is built on, and a remedy is only as true as the CLIENT that has to
  // carry it.
  var GEMINI_NARROW_ENFORCED = {
    "pattern": 1, "minLength": 1, "maxLength": 1,
    "minProperties": 1, "maxProperties": 1, "default": 1, "example": 1
  };

  // ...and the other half. `@ai-sdk/google` does not send your schema on the
  // narrow path — it REBUILDS the request with `convertJSONSchemaToOpenAPISchema`,
  // which destructures this fixed list and silently drops everything else. So
  // for that client the path switch above is a statement about a request it
  // never builds. Transcribed from the destructure in @ai-sdk/google 4.0.39 and
  // measured against the real wire payload (2026-08-10): of the seven keywords
  // in GEMINI_NARROW_ENFORCED, exactly `minLength` arrives.
  //
  // Snapshot, like the Go tables (#361): this suite is dependency-free and
  // cannot run @ai-sdk/google, so re-measure after a version bump.
  var AI_SDK_GOOGLE_FORWARDED = {
    "type": 1, "description": 1, "required": 1, "properties": 1, "items": 1,
    "allOf": 1, "anyOf": 1, "oneOf": 1, "format": 1, "const": 1,
    "minLength": 1, "enum": 1
  };

  // Gemini has no `$ref`, so the only correct transform is to inline the
  // definitions — not to warn and then strip the `$defs` bag, which is what
  // this used to do and which turned `{ $ref, definitions }` (the exact shape
  // zod-to-json-schema emits) into an empty `{ "$ref": ... }`.
  // Returns the inlined schema; pushes a blocker for genuinely recursive refs,
  // which Gemini cannot express at all.
  function inlineRefs(s, ledger, docUrl) {
    var defs = {};
    [s.$defs, s.definitions].forEach(function (bag) {
      if (isPlainObject(bag)) Object.keys(bag).forEach(function (k) { defs[k] = bag[k]; });
    });
    if (!Object.keys(defs).length) return s;

    var inlined = 0, recursive = [], geminiDropped = [];

    function resolve(node, stack, path) {
      if (Array.isArray(node)) {
        return node.map(function (n, i) { return resolve(n, stack, path + "[" + i + "]"); });
      }
      if (!isPlainObject(node)) return node;

      var ref = typeof node.$ref === "string" ? /^#\/(?:\$defs|definitions)\/(.+)$/.exec(node.$ref) : null;
      if (ref && defs[ref[1]]) {
        var name = ref[1];
        if (stack.indexOf(name) !== -1) {
          if (recursive.indexOf(name) === -1) recursive.push(name);
          return node; // leave it; a blocker is reported below
        }
        var target = resolve(clone(defs[name]), stack.concat([name]), path);
        // Siblings alongside `$ref` used to WIN over the definition's own keys,
        // which for `properties`/`required` is a deletion rather than a
        // precedence rule: a `$ref` beside constraining siblings is an
        // INTERSECTION (the same operation `allOf` spells differently, #370), so
        // the referent's declarations have to survive. Measured before the fix:
        // a nested `{properties:{a},required:["a"],$ref:T}` whose raw accept set
        // requires BOTH `a` and `b` came out of `--to gemini` accepting objects
        // with no `b` at all — silently, at zero blockers, with the ledger
        // saying only "Inlined 1 `$ref` reference".
        var sibs = Object.keys(node).filter(function (k) { return k !== "$ref"; });
        var visited = {};
        sibs.forEach(function (k) { visited[k] = resolve(node[k], stack, path); });
        var merged = intersectRef(target, visited, sibs, path, ledger, docUrl || DOCS.gemini);
        if (!merged) return node; // blocked: leave the shape visible (#318)
        merged.dropped.forEach(function (k) {
          if (geminiDropped.indexOf(k) === -1) geminiDropped.push(k);
        });
        inlined++;
        return merged.schema;
      }

      var out = {};
      Object.keys(node).forEach(function (k) { out[k] = resolve(node[k], stack, path + "/" + k); });
      return out;
    }

    var result = resolve(s, [], "root");
    delete result.$defs;
    delete result.definitions;

    if (geminiDropped.length) {
      ledger.push(entry("~", "root",
        "Dropped `" + geminiDropped.join("`, `") + "` while inlining a `$ref` with constraining " +
        "siblings: one side declares `additionalProperties: false` without declaring " +
        (geminiDropped.length > 1 ? "them" : "it") + ", so no object could ever have carried " +
        (geminiDropped.length > 1 ? "them" : "it") + ".",
        docUrl || DOCS.gemini));
    }
    if (inlined) {
      ledger.push(entry("~", "root",
        "Inlined " + inlined + " `$ref` reference" + (inlined === 1 ? "" : "s") +
        " and dropped the `$defs`/`definitions` block — `@google/genai`'s `Schema` type has " +
        "no `$ref`, so inlining is the form that works on this path. (Keep a top-level " +
        "`$schema` instead and you stay on `responseJsonSchema`, where `$ref`/`$defs` are accepted.) " +
        "What an un-inlined `$ref` costs depends on your client: JS forwards it and the API " +
        "answers `Unknown name \"$defs\" … Cannot find field`; Python refuses to build the " +
        "request; Go DROPS IT SILENTLY — `json.Unmarshal` into `genai.Schema` returns nil " +
        "error and the referencing property becomes `{}`, so the call succeeds with the " +
        "referenced model no longer described at all.",
        docUrl));
    }
    recursive.forEach(function (name) {
      ledger.push(entry("!", "root",
        "`" + name + "` is recursive (it references itself). Gemini cannot express a recursive schema — flatten it to a fixed depth before sending.",
        docUrl));
    });
    return result;
  }

  // Paths of `required` properties whose type is cyclic. Gemini's JSON-Schema
  // path unrolls cycles only inside NON-required properties, so a recursive
  // required field is a human fix, not something we can rewrite.
  function cyclicRequired(s) {
    var defs = {};
    [s.$defs, s.definitions].forEach(function (bag) {
      if (isPlainObject(bag)) Object.keys(bag).forEach(function (k) { defs[k] = bag[k]; });
    });
    if (!Object.keys(defs).length) return [];
    var out = [];

    function refName(node) {
      var m = isPlainObject(node) && typeof node.$ref === "string"
        ? /^#\/(?:\$defs|definitions)\/(.+)$/.exec(node.$ref) : null;
      return m ? m[1] : null;
    }

    function reachesCycle(node, stack) {
      if (Array.isArray(node)) {
        return node.some(function (n) { return reachesCycle(n, stack); });
      }
      if (!isPlainObject(node)) return false;
      var name = refName(node);
      if (name) {
        if (stack.indexOf(name) !== -1) return true;
        if (!defs[name]) return false;
        return reachesCycle(defs[name], stack.concat([name]));
      }
      return Object.keys(node).some(function (k) { return reachesCycle(node[k], stack); });
    }

    function scan(node, path, seen) {
      if (!isPlainObject(node)) return;
      if (isPlainObject(node.properties) && Array.isArray(node.required)) {
        node.required.forEach(function (k) {
          var child = node.properties[k];
          if (child && reachesCycle(child, [])) out.push(path + "." + k);
        });
      }
      if (isPlainObject(node.properties)) {
        Object.keys(node.properties).forEach(function (k) {
          scan(node.properties[k], path + "." + k, seen);
        });
      }
      if (isPlainObject(node.items)) scan(node.items, path + "[]", seen);
      var n = refName(node);
      if (n && defs[n] && seen.indexOf(n) === -1) scan(defs[n], path, seen.concat([n]));
    }

    scan(s, "root", []);
    Object.keys(defs).forEach(function (k) { scan(defs[k], "$defs." + k, [k]); });
    // de-dupe
    return out.filter(function (v, i) { return out.indexOf(v) === i; });
  }

  // `jsonPath` selects WHICH Gemini request field this schema is destined for:
  //   false -> `responseSchema`     (the narrow `Schema` proto)  = `--to gemini`
  //   true  -> `responseJsonSchema` (full JSON Schema)      = `--to gemini-json`
  //
  // It is a parameter and not an inference, and that is the whole point. #314
  // found that `@google/genai` routes on a top-level `$schema` key and this
  // function used to read that key as if it settled the question. It does not:
  // the routing lives in ONE client, not in Gemini. Measured (#319):
  //   @google/genai (JS)        — `maybeMoveToResponseJsonSchema()` auto-routes on `$schema`
  //   google-genai (Python)     — no `$schema` handling at all; you set the field yourself
  //   @google/generative-ai     — the LEGACY client, which `@langchain/google-genai@2.2.0`
  //                               depends on: ZERO occurrences of `responseJsonSchema`.
  //                               Everything goes to the narrow proto, `$schema` or not.
  // So for a LangChain caller a top-level `$schema` routes nothing, and reading
  // it as "permissive path" green-lit a payload the live API rejects with
  // `Unknown name "prefixItems" ... Cannot find field`. Only the caller knows
  // which client they hold, so the caller picks the target.
  // Union `type` for the narrow `responseSchema` proto.
  //
  // `type` is in GEMINI_ALLOWED, so an ARRAY sitting in `type` sailed straight
  // through the allowlist and `--check --to gemini` exited 0 — the same
  // alternate-spelling false pass as array-form `items`, one field over
  // (`definitions` vs `$defs` #311, array-`items` #313/#316, `/$defs/` #320).
  //
  // `types.Schema.type` is a SINGLE-valued enum, so `google-genai` (Python)
  // 2.17.0 refuses to build the request at all:
  //   properties.a.type: Input should be 'TYPE_UNSPECIFIED', 'STRING', 'NUMBER',
  //   'INTEGER', 'BOOLEAN', 'ARRAY' or 'NULL'
  // — even for a single-element list like ["string"]. `@google/genai` (JS)
  // 2.16.0 does NOT throw; it rewrites. The rewrite below is copied from what
  // that SDK actually emits, measured shape by shape rather than guessed:
  //   ["string","null"]           -> {type:"STRING", nullable:true}
  //   ["string","integer"]        -> {anyOf:[{STRING},{INTEGER}]}   (no `type`)
  //   ["string","integer","null"] -> {anyOf:[...], nullable:true}
  //   ["string"]                  -> {type:"STRING"}
  // Constraining siblings (`items`, `minLength`, …) stay OUTSIDE the generated
  // `anyOf`, which is also what the JS SDK does.
  //
  // Two deliberate divergences from that SDK, both because it is wrong there:
  //   * a null-only type. JS emits `{nullable:true, anyOf:[]}` for ["null"] but
  //     THROWS on the equivalent bare `"null"` ("type: null can not be the only
  //     possible type for the field."). Python is inconsistent in the mirror
  //     direction: it ACCEPTS bare `"null"` and rewrites it to `{nullable:true}`
  //     with no `type`, and throws on ["null"]. We emit `{nullable:true}` for
  //     both, the one form neither SDK rejects.
  //   * duplicates are collapsed. JS emits `anyOf:[{STRING},{STRING}]` for
  //     ["string","string","null"]; deduping makes that a plain nullable string.
  //
  // Not exotic: `zod-to-json-schema` emits `type:["string","null"]` for
  // `.nullable()`, and our own `--to openai` output CREATES it (the forced-
  // required rewrite shipped in #311).
  // `clientConverts` = the caller hands JSON Schema to a library that performs
  // the JSON-Schema -> `Schema` proto conversion itself (see `--to gemini-client`).
  // There the nullability spellings are EXCLUSIVE, not merely different, and the
  // exclusivity was measured rather than reasoned:
  //   * straight to `responseSchema`, `{type:"STRING", nullable:true}` is ACCEPTED
  //     and `{type:["string","null"]}` is REJECTED (`Unknown name "type"`).
  //   * through google-adk 2.6.3 it is the exact reverse: `nullable` is not a
  //     field of its `_ExtendedJSONSchema` (which DOES extend JSONSchema with
  //     `property_ordering`, so this is not a blanket refusal of proto fields),
  //     so it is silently DROPPED and the property stops being nullable, while
  //     the union form is converted to `nullable` correctly.
  // No single document carries nullability to both. That is why this is a target
  // the caller picks and never something inferred from the schema.
  function normalizeUnionType(node, path, ledger, clientConverts, inCombinator) {
    var raw = node.type;
    var isList = Array.isArray(raw);
    if (!isList && raw !== "null") return;

    // A scalar `"null"` that is one branch of a union needs NOTHING done to it,
    // and the rewrite below actively weakens it. Measured 2026-08-09:
    //   * live v1beta pre-auth proto parse ACCEPTS
    //     `anyOf:[{type:"string"},{type:"null"}]` (control `{"type":"frobnicate"}`
    //     in the same slot is rejected, so the oracle was discriminating);
    //   * `google-genai` 2.17.0 validates it into `types.Schema` without raising
    //     — `Type` has a `NULL` member;
    //   * `@google/genai` 2.16.0 reaches the network with it, and throws only for
    //     the STANDALONE form ("type: null can not be the only possible type for
    //     the field"), which is what the rewrite below exists for.
    // Rewriting it produced `{"nullable": true}` — a branch with no `type` at
    // all, i.e. TYPE_UNSPECIFIED rather than NULL — and made `--check` exit 1 on
    // a document the proto accepts verbatim. That shape is the canonical
    // pydantic v2 rendering of `Optional[x]`, so the false failure fired on
    // essentially every Python schema with an optional field. It is also #329's
    // tell exactly: the node consists of NOTHING BUT the keyword the rule
    // rewrites, so the "fix" empties it.
    if (!isList && inCombinator) return;

    var list = isList ? raw : ["null"];
    var hasNull = false;
    var rest = [];
    list.forEach(function (t) {
      if (t === "null") { hasNull = true; return; }
      if (rest.indexOf(t) === -1) rest.push(t);
    });

    // `type` + `anyOf` together is already reported as a blocker upstream, and
    // this rewrite would have to invent a merge. Leave it visible instead.
    if (rest.length > 1 && node.anyOf !== undefined) return;

    var before = JSON.stringify(raw);
    var why;

    if (clientConverts) {
      // One member (optionally + null): leave the spelling alone. The client
      // turns `["string","null"]` into `{type:STRING, nullable:true}` itself,
      // and pre-converting it here is the one edit that makes the output WORSE
      // than the raw input on this path.
      if (rest.length <= 1) {
        if (rest.length === 1 && hasNull) {
          // #368: "the converting client performs the rewrite itself" was a
          // categorical claim about a CLASS, and it is FALSE for a member that
          // forwards. Fork it, and — per #366 — name the CHECK instead of
          // guessing which client the caller is on, because that is a fact
          // about their call site rather than about the schema.
          var rewriters = geminiClientsBy("rewrites");
          var forwarders = geminiClientsBy("forwards");
          ledger.push(entry("=", path,
            "Left `type: " + before + "` as a union, and WHICH CLIENT YOU USE decides " +
            "whether that is right — measured 2026-08-10 across " +
            GEMINI_CLIENT_MEMBERS.length + " clients, no single spelling works for all " +
            "of them. " + namesOf(rewriters) + " each perform the `nullable` rewrite " +
            "THEMSELVES and DROP a hand-written `nullable`, so emitting `nullable` here " +
            "would make the property stop being nullable with nothing reporting it — " +
            "which is why this target keeps the union. But " + namesOf(forwarders) +
            " performs no rewrite at all: it strips only `$schema` and " +
            "`additionalProperties` and assigns the rest straight to `responseSchema`, " +
            "where the proto REJECTS a list-valued `type` (`Proto field is not " +
            "repeating, cannot start list`) — a hard 400. THE CHECK, and it takes one " +
            "look at your own call site: if your client hands your document to " +
            "`responseSchema` without rebuilding it, you are on the forwarding side and " +
            "want `--to gemini`, whose output carries `nullable` instead. If it rebuilds " +
            "the request from its own `Schema` type, stay here. `litellm` 1.96.0 carries " +
            "either form, so it needs no decision.",
            DOCS.gemini, true));
          return;
        }

        // #369. The `rest.length <= 1` guard above was written for `["X","null"]`
        // and is WIDER THAN ITS JUSTIFICATION. #368's trade-off is a decision
        // about NULLABILITY: keep the union so the three rewriting clients do not
        // silently lose the null constraint, and accept a loud 400 for the one
        // forwarding client. A list carrying NO nullability at stake buys those
        // clients nothing — #365's discriminator, asked of a sub-case — so
        // leaving it is a pure cost to the forwarder, paid for nothing.
        //
        // Measured 2026-08-10 on the live v1beta pre-auth proto, controls in the
        // `type` slot under test (#344 — bogus key REJECTED, bogus type value
        // REJECTED, plain reaching `API key not valid`):
        //   `["string"]`  REJECTED (`Proto field is not repeating, cannot start list`)
        //   `["null"]`    REJECTED (same)
        //   `"null"`      ACCEPTED — the scalar is a real proto `Type` member
        // Both rewrites below are LOSSLESS by JSON Schema semantics: a
        // one-element `type` array means exactly that type.
        //
        // A DRAFTED JUSTIFICATION FOR THIS DIED ON MEASUREMENT, and the corrected
        // version is the one worth carrying. The draft read "a rewriting client
        // normalizes either spelling, so its output does not move." FALSE for two
        // of the four rewriters, measured 2026-08-10 with a `description` control
        // beside each node that had to survive (#364) — and my first `@ai-sdk`
        // reader scored three vacuous IDENTICALs because the capture returned
        // null on BOTH sides and the control was absent (#368's trap, hit again):
        //   google-adk 2.6.3  identical on all three
        //   agno 2.8.7        identical on all three
        //   litellm 1.96.0    DIFFERS on `["null","null"]`: keeps it as
        //                     `anyOf:[null,null]`, vs `{"type":"null"}` for the
        //                     scalar
        //   @ai-sdk/google    DIFFERS on `["string"]`: emits
        //     4.0.39          `{"anyOf":[{"type":"string"}]}`, vs `{"type":"string"}`
        // So the honest claim is about MEANING, not bytes: no rewriter's accept
        // set moves, and where the emitted document DOES move, BOTH forms were
        // put through the live v1beta oracle and BOTH are accepted (controls in
        // the same nested slot rejected, so the oracle discriminates there).
        // The rewrite therefore costs the four rewriters nothing and converts a
        // hard 400 into a working request for the forwarder — which is the whole
        // reason it is worth making.
        //
        // Reachability measured on real generators rather than argued: zod 3 +
        // `zod-to-json-schema` 3.24.5 emits `{"type":["null","null"]}` verbatim
        // for `z.null().nullable()`. Redundant-but-legal user code, and the kind
        // of thing composed/generated schemas produce — weaker than "every user
        // hits this", and stated at that strength. For a plain null field
        // (`z.null()`, `a: None`) zod 4 native and pydantic 2.13.4 both emit the
        // SCALAR `{"type":"null"}`, which is already correct here and is
        // deliberately left alone below. Note zod 4's `z.null().nullable()` does
        // NOT reach this rule at all — it emits `anyOf:[null,null]`, a different
        // route — so zod 3 + `zod-to-json-schema` is the only measured producer.
        //
        // Scalar-only shapes are excluded by the `isList` guard: a bare `"null"`
        // is accepted by the proto and must keep passing through untouched.
        if (isList && rest.length === 1 && !hasNull) {
          node.type = rest[0];
          ledger.push(entry("~", path,
            "Rewrote `type: " + before + "` to `" + rest[0] + "`. A one-element `type` array " +
            "means exactly that type, so this is lossless — but the two spellings are NOT " +
            "interchangeable at the destination: measured on the live v1beta endpoint, a " +
            "list-valued `type` is rejected outright (`Proto field is not repeating, cannot " +
            "start list`), so a client that forwards your document to `responseSchema` " +
            "without rebuilding it gets a hard 400 on the list form. Unlike the `[\"X\",\"null\"]` " +
            "union this target deliberately keeps, there is no nullability here to trade away, " +
            "so nothing is gained by leaving it.",
            DOCS.gemini));
          return;
        }
        if (isList && rest.length === 0 && hasNull) {
          node.type = "null";
          ledger.push(entry("~", path,
            "Rewrote `type: " + before + "` to `\"null\"`. Lossless — a null-only union is the " +
            "null type — and it is the spelling the destination actually takes: measured on " +
            "the live v1beta endpoint, scalar `\"null\"` is ACCEPTED (`NULL` is a real member of " +
            "the proto's `Type` enum) while the list form is rejected (`Proto field is not " +
            "repeating`). It is also what zod 4 and pydantic already emit for a null field, so " +
            "this makes the two spellings agree.",
            DOCS.gemini));
          return;
        }
        return;
      }
      // Two or more real members. Left alone, a converting client keeps exactly
      // ONE: measured on google-adk 2.6.3, `["string","integer"]` -> `STRING`,
      // the integer branch discarded with no error. `anyOf` survives that layer
      // intact (its `any_of` branch recurses), so this is the lossless form —
      // and the null member goes INSIDE the `anyOf` rather than onto a sibling
      // `nullable`, for the same drop reason as above.
      delete node.type;
      node.anyOf = rest.map(function (t) { return { type: t }; });
      if (hasNull) node.anyOf.push({ type: "null" });
      ledger.push(entry("~", path,
        "Rewrote `type: " + before + "` to `anyOf`. A client that converts JSON Schema to " +
        "the `Schema` proto keeps only ONE member of a multi-type union — measured on " +
        "google-adk 2.6.3's `_to_gemini_schema`, `[\"string\",\"integer\"]` arrives as " +
        "`STRING` and the integer " +
        "branch is discarded with no error. `anyOf` is carried through that conversion " +
        "intact, so every branch survives. Lossless.",
        DOCS.gemini));
      return;
    }

    if (rest.length === 0) {
      delete node.type;
      node.nullable = true;
      why = "a null-only type has no proto spelling both SDKs accept; `{nullable: true}` " +
        "with no `type` is the form `google-genai` itself produces";
    } else if (rest.length === 1) {
      node.type = rest[0];
      if (hasNull) node.nullable = true;
      why = "`Schema.type` holds one value, and `nullable` is the proto's way to say " +
        "\"or null\"";
    } else {
      delete node.type;
      node.anyOf = rest.map(function (t) { return { type: t }; });
      if (hasNull) node.nullable = true;
      why = "a multi-type union has no single `Schema.type`, so it becomes `anyOf` — " +
        "which is what `@google/genai` emits for this input";
    }

    ledger.push(entry("~", path,
      "Rewrote `type: " + before + "` to " +
      JSON.stringify(node.anyOf !== undefined && rest.length > 1
        ? { anyOf: node.anyOf, nullable: node.nullable }
        : { type: node.type, nullable: node.nullable }, function (k, v) {
          return v === undefined ? undefined : v;
        }) + ". " +
      "`types.Schema.type` is a single-valued enum, so `google-genai` (Python) REFUSES TO " +
      "BUILD the request — `Input should be 'TYPE_UNSPECIFIED', 'STRING', … or 'NULL'` — " +
      "even for a one-element list. `@google/genai` (JS) does not throw; it performs this " +
      "same rewrite silently, so the two clients disagree about whether your schema is " +
      "sendable at all. Lossless: " + why + ".",
      DOCS.gemini));
  }

  function toGemini(schema, jsonPath, clientConverts) {
    var s = clone(schema);
    var ledger = [];

    // Applies to BOTH paths: the narrow proto has no `$ref` at all, and the
    // JSON-Schema path accepts `$ref`/`$defs` but resolves only real local
    // pointers. Either way a `/$defs/X` spelling is broken, so fix it before
    // the paths diverge.
    s = normalizeRefSpelling(s, ledger, DOCS.gemini,
      "Gemini resolves `$ref` only on the `responseJsonSchema` path, and only for genuine local " +
      "pointers.");

    // Measured 2026-08-09 over the whole corpus: all 14 shapes that empty on the
    // narrow proto or through a converting client survive `--to gemini-json`.
    // That is a real escape hatch rather than a guess, which is what makes the
    // blocker actionable instead of a bare refusal (#329's corollary).
    var GEMINI_EMPTIED_REMEDY = clientConverts
      ? "Measured: 13 of the 14 shapes that empty here survive `--to gemini-json` intact. That " +
        "path takes full JSON Schema — but only if you hand it to `responseJsonSchema` YOURSELF, " +
        "since the converting library you are using rebuilds the request from its own `Schema` type."
      : "Measured: 13 of the 14 shapes that empty here survive `--to gemini-json` intact — the " +
        "`responseJsonSchema` field takes full JSON Schema, and adding a top-level `$schema` is " +
        "what routes `@google/genai` there for you.";

    // A node with no legal values. Hoisted ABOVE the path split on purpose:
    // both Gemini paths carry these shapes, and Path A returns early, so a walk
    // placed after the split would silently cover only the narrow path.
    walk(s, "root", function (node, path) {
      noteUnsatisfiable(node, path, ledger, DOCS.gemini);
    });

    // Narrow path only. `types.Schema` is declared `extra="forbid"` and every
    // sub-schema slot is typed as a `Schema`, never a bool — measured on
    // google-genai==2.17.0, `model_validate` REJECTS a boolean at
    // `properties.a`, `properties.a.items` and `properties.a.anyOf.1`. The
    // `responseJsonSchema` path is ordinary JSON Schema and is left alone.
    if (!jsonPath) {
      findBooleanSubschemas(s).forEach(function (h) {
        ledger.push(entry("!", h.path,
          booleanSubschemaMessage(h.value,
            "The narrow `responseSchema` proto has no boolean form: `types.Schema` is " +
            "`extra=\"forbid\"` and types every sub-schema slot as a `Schema`, so " +
            "`model_validate()` rejects it. It IS legal on the `responseJsonSchema` path — " +
            "see `--to gemini-json`."),
          DOCS.gemini));
      });
    }

    // ---- Path A: `responseJsonSchema` -> the SDK sends this VERBATIM --------
    // Subsetting here would be actively destructive: it would throw away
    // constraints this path accepts. This is what the doc-derived version did
    // to every `zod-to-json-schema` user.
    if (jsonPath === true) {
      if (typeof s.$schema === "string") {
        // "sent verbatim" is the TRANSPORT, not acceptance — the backend still
        // has its own allowlist.
        ledger.push(entry("=", "root",
          "Kept `$schema`. It is not merely decorative: @google/genai (JS) reads a TOP-LEVEL " +
          "`$schema` and moves the schema to the `responseJsonSchema` request field for you. " +
          "No other client does — in Python set `response_json_schema` yourself, and the legacy " +
          "`@google/generative-ai` (what @langchain/google-genai uses) has no such field at all. " +
          "This path keeps `$ref`/`$defs` and recursion, but it does NOT ENFORCE `pattern`, " +
          "`minLength`, `maxLength`, `min/maxProperties`, `default` or `example` — those are " +
          "silently ignored here and reach Gemini only on the narrow `responseSchema` path. " +
          "That last clause is about GEMINI, not about your client: if you get there through " +
          "@ai-sdk/google, its `convertJSONSchemaToOpenAPISchema` rebuilds the request from a " +
          "fixed 12-keyword list and `minLength` is the only one of those seven that survives, " +
          "so switching is strictly worse there — it also drops `minimum`/`maximum`/" +
          "`minItems`/`maxItems`, which this path enforces. The two subsets are complementary; " +
          "neither is a superset. Nothing below is an error: unsupported keywords are ignored, " +
          "so `--check` stays green.",
          DOCS.gemini, true));
      } else {
        ledger.push(entry("=", "root",
          "No top-level `$schema`, so @google/genai (JS) will NOT auto-route this — it would " +
          "send it as `responseSchema`, the narrow proto, where much of the output below is " +
          "rejected outright. Put this schema in the `responseJsonSchema` request field " +
          "explicitly (Python: `response_json_schema=`), or add a top-level `$schema` if you " +
          "are on @google/genai. If you actually meant the narrow path, use `--to gemini`.",
          DOCS.gemini, true));
      }

      // `definitions` is the draft-07 spelling zod-to-json-schema emits, and it
      // is NOT in the accepted list — only `$defs` is. Renaming it (and
      // repointing every `$ref`) is the fix; deleting it as an unknown keyword
      // would orphan every reference and leave a schema of nothing but `$ref`.
      s = normalizeDefs(s, ledger, DOCS.gemini,
        "Renamed draft-07 `definitions` to `$defs` and repointed every `$ref` — " +
        "`responseJsonSchema` accepts `$defs`, not `definitions`. (zod-to-json-schema emits `definitions`.)");

      // Array-form `items` is the DRAFT-07 spelling of a tuple, and it is the
      // one the Vercel AI SDK actually puts on the wire for `z.tuple()`. The
      // accepted list above names `items` and `prefixItems` separately, in the
      // 2020-12 sense: `items` is the schema for every element, `prefixItems`
      // is the positional list. So an array sitting in `items` is not the
      // "items" that list accepts. Renaming it is lossless and lands on a
      // keyword this path explicitly accepts — unlike the narrow path below,
      // no positions have to be given up. Must run before the allowlist walk,
      // which would otherwise wave the array through as an accepted `items`.
      walk(s, "root", function (node, path) {
        if (!Array.isArray(node.items)) return;
        node.prefixItems = node.items;
        delete node.items;
        ledger.push(entry("~", path,
          "Rewrote draft-07 tuple-form `items` (an array of schemas) as `prefixItems`. " +
          "`responseJsonSchema` accepts `prefixItems` for positional tuples; an array inside " +
          "`items` is the draft-07 spelling and is not what that list means by `items`. " +
          "Nothing is lost — every position keeps its own schema. (`z.tuple()` through the " +
          "Vercel AI SDK emits exactly this array form.)",
          DOCS.gemini));
      });

      walk(s, "root", function (node, path) {
        Object.keys(node).forEach(function (k) {
          if (!GEMINI_JSON_ALLOWED[k]) {
            // KEPT, not removed — and the wording of the source is the whole
            // reason. The field doc says "While the full JSON Schema MAY BE
            // SENT, not all features are supported", i.e. an unsupported
            // keyword is IGNORED, not rejected. Contrast OpenAI, whose doc
            // says outright "you will receive an error" — that is what makes
            // stripping correct there and wrong here. Deleting a keyword the
            // request would have accepted destroys a real constraint to buy
            // nothing, which is precisely the bug the previous cycle fixed.
            var remedy =
              "If you need it enforced, drop the top-level `$schema` to take the narrow " +
              "`responseSchema` path (which does enforce `pattern`, `minLength`, `maxLength`, " +
              "`min/maxProperties`, `default`, `example`), or restate it in `description`.";
            // The remedy above is a claim about GEMINI. Whether it reaches Gemini
            // is a claim about the CLIENT, and only the caller knows which one
            // they are on — so name the fork rather than inferring it.
            if (GEMINI_NARROW_ENFORCED[k]) {
              remedy += AI_SDK_GOOGLE_FORWARDED[k]
                ? " That switch does survive a converting client: @ai-sdk/google's " +
                  "`convertJSONSchemaToOpenAPISchema` forwards `" + k + "` — the only one of " +
                  "those seven it does."
                : " BUT THAT IS A CLAIM ABOUT WHAT GEMINI ENFORCES, NOT ABOUT WHAT YOUR CLIENT " +
                  "SENDS. @ai-sdk/google does not forward your schema on the narrow path — it " +
                  "REBUILDS the request with `convertJSONSchemaToOpenAPISchema`, which forwards " +
                  "a fixed 12-keyword list and drops `" + k + "` before the request exists. On " +
                  "that client the switch buys nothing AND additionally costs " +
                  "`minimum`/`maximum`/`minItems`/`maxItems`, which THIS path does enforce, so " +
                  "it is strictly worse. `minLength` is the only one of the seven it forwards. " +
                  "(Measured on @ai-sdk/google 4.0.39; a REST-direct caller, or Python " +
                  "`response_json_schema=`, is unaffected and the remedy holds as written.)";
            }
            ledger.push(entry("=", path,
              "Kept `" + k + "`, but it is NOT enforced on this path — it is absent from the " +
              "accepted property list enumerated on the `response_json_schema` field of " +
              "`google-genai`. The full JSON Schema may be sent, so this is ignored rather " +
              "than rejected; your request still succeeds, but nothing constrains `" + k + "`. " +
              remedy,
              DOCS.gemini, true));
          }
        });

        // "If $ref is set on a sub-schema, no other properties, except for
        //  than those starting as a `$`, may be set."
        if (typeof node.$ref === "string") {
          // The vendor forbids the combination, so a `$ref` carrying
          // CONSTRAINING siblings has exactly two outcomes: inline that one node
          // and keep what it means, or delete the siblings and lose it. We used
          // to always delete — reported, so not silent, but still a constraint
          // loss where a lossless repair exists, and the removal note itself
          // said "Inline the definition if you need it". Inline it instead, as
          // an INTERSECTION (#370) rather than letting either side win, so this
          // path now agrees with the other nine targets about what the same
          // document means. Annotations, unresolvable pointers and recursive
          // definitions still take the delete path: there is no inline for a
          // recursive `$ref`, and this path's whole value is that it keeps
          // `$ref`/`$defs` and recursion elsewhere.
          var refTgt = resolveLocalDef(s, node.$ref);
          var constrains = isPlainObject(node.properties) || Array.isArray(node.required);
          var selfRef = refTgt && JSON.stringify(refTgt).indexOf(node.$ref) !== -1;
          if (refTgt && constrains && !selfRef) {
            var gSibs = Object.keys(node).filter(function (k) { return k !== "$ref"; });
            var gView = {};
            gSibs.forEach(function (k) { gView[k] = node[k]; });
            var gMerged = intersectRef(clone(refTgt), gView, gSibs, path, ledger, DOCS.gemini);
            if (gMerged) {
              Object.keys(node).forEach(function (k) { delete node[k]; });
              Object.keys(gMerged.schema).forEach(function (k) { node[k] = gMerged.schema[k]; });
              ledger.push(entry("~", path,
                "Inlined this `$ref` and merged it with its siblings — on the `responseJsonSchema` " +
                "path a `$ref` sub-schema may carry no properties except ones starting with `$`, " +
                "and these siblings constrain, so deleting them would drop what the node means. " +
                "A `$ref` beside constraining siblings is an intersection, so both sides are kept.",
                DOCS.gemini));
              return;
            }
          }
          Object.keys(node).forEach(function (k) {
            if (k.charAt(0) !== "$") {
              ledger.push(entry("x", path,
                "Removed `" + k + "` alongside `$ref` — on the `responseJsonSchema` path a " +
                "`$ref` sub-schema may carry no properties except ones starting with `$`. " +
                "Inline the definition if you need `" + k + "` on it.",
                DOCS.gemini));
              delete node[k];
            }
          });
        }
      });

      // Cyclic refs are allowed here, but only in NON-required properties.
      var cyc = cyclicRequired(s);
      cyc.forEach(function (p) {
        ledger.push(entry("!", p,
          "This property is `required` and its type is cyclic. Gemini unrolls cyclic " +
          "references only to a limited degree and only within non-required properties " +
          "(nullable is not sufficient) — make it optional or flatten it to a fixed depth.",
          DOCS.gemini));
      });
      noteEmptiedDocument(schema, s, ledger, DOCS["gemini-json"], GEMINI_EMPTIED_REMEDY);
      return { schema: s, ledger: ledger };
    }

    // ---- Path B: `responseSchema`, the narrow `Schema` proto ----------------
    // Reachable WITH a top-level `$schema` now, which is the #319 fix. A
    // LangChain caller has one (zod/`z.toJSONSchema()` emits it) and still
    // lands here, because their client cannot route. Strip it explicitly with
    // its own ledger line rather than letting the allowlist walk drop it as a
    // nameless unknown — the reason matters more than the removal.
    if (typeof s.$schema === "string") {
      delete s.$schema;
      ledger.push(entry("-", "root",
        "Removed `$schema`. The narrow `responseSchema` proto has no such field, and " +
        "`types.Schema` is declared `extra=\"forbid\"`, so leaving it is a rejection. Note this " +
        "key is ALSO the auto-routing switch in @google/genai (JS) only — if that is your " +
        "client and you wanted the permissive path, re-run with `--to gemini-json` instead of " +
        "taking this narrow-path output.",
        DOCS.gemini));
    }

    s = inlineRefs(s, ledger, DOCS.gemini);

    // The SDK throws outright before the request is even built.
    walk(s, "root", function (node, path) {
      if (node.type !== undefined && node.anyOf !== undefined) {
        ledger.push(entry("!", path,
          "`type` and `anyOf` are both set. @google/genai throws " +
          "\"type and anyOf cannot be both populated.\" before it sends anything — " +
          "drop one of them.",
          DOCS.gemini));
      }
    });

    walk(s, "root", function (node, path, inCombinator) {
      // Union `type`. Runs before the allowlist strip below so the `nullable` /
      // `anyOf` it produces are already in place when the allowlist sees them
      // (both are fields of `Schema`).
      normalizeUnionType(node, path, ledger, clientConverts, inCombinator);

      // An array that declares no element type. The proto ACCEPTS it — measured
      // against the live v1beta endpoint, `{"type":"ARRAY"}` gets past payload
      // validation, and `types.Schema` preserves it — so this is never a gate
      // failure. It is worth a note because nothing downstream leaves it alone:
      // google-adk 2.6.3 does `schema.setdefault("items", {"type": "string"})`,
      // so the elements are declared STRING and the backend then accepts the
      // result. A 4-integer bounding box arrives as four strings, with no error
      // anywhere. Unlike the emptied map of #335 this IS recoverable, because
      // the real element type is still in the caller's own schema at this point.
      if (!jsonPath && isArraySchema(node) && node.items === undefined &&
          node.prefixItems === undefined) {
        ledger.push(entry("=", path,
          "This array declares no element type. The `responseSchema` proto accepts that " +
          "(verified against the live v1beta endpoint) and simply leaves the elements " +
          "unconstrained — but a converting client will not: google-adk 2.6.3's " +
          "`_to_gemini_schema` inserts " +
          "`items: {\"type\": \"string\"}`, the backend accepts the result, and the model " +
          "is told the elements are strings. Declare the real element type in `items`.",
          DOCS.gemini, true));
      }

      // Tuples. `items` is in GEMINI_ALLOWED, so an ARRAY sitting in `items`
      // used to sail straight through the allowlist untouched — the third time
      // an alternate spelling of a container has hidden from a keyword check
      // (`definitions` vs `$defs`, then the same array-`items` false pass in
      // OpenAI). `types.Schema` is `extra="forbid"` and its `items` is a single
      // Schema, so it rejects the array outright:
      //   "properties.bbox.items: Input should be a valid dictionary or object"
      // `minItems`/`maxItems` ARE fields of `Schema` (verified against the same
      // oracle), so the homogeneous collapse keeps the fixed length here.
      var tupleBlocked = normalizeTuple(node, path, ledger, DOCS.gemini,
        "Gemini's `responseSchema` proto has no tuple form — `types.Schema` declares `items` " +
        "as a single schema and is `extra=\"forbid\"`, so it rejects both an array in `items` " +
        "and `prefixItems`.",
        "The `responseSchema` proto has no tuple form, but every position here has the same " +
        "schema, and `minItems`/`maxItems` are fields of `types.Schema`, so the fixed length " +
        "survives as a real constraint on this path.");

      // drop keywords outside the supported subset
      Object.keys(node).forEach(function (k) {
        // A blocked (heterogeneous) tuple stays visible so the reader can see
        // the shape they have to remodel.
        if (tupleBlocked && (k === "prefixItems" || k === "items")) return;
        if (!GEMINI_ALLOWED[k]) {
          if (GEMINI_PROTO_ONLY[k]) {
            // The proto has the field (see GEMINI_PROTO_ONLY). Deleting it
            // would be the error policy mistake of #314 in its purest form —
            // stripping something the destination accepts — and for `oneOf` on
            // a discriminated union the node is often nothing BUT the union, so
            // the strip did not narrow the schema, it emptied it: a `{"title":
            // "Pet"}` that constrains nothing, which the backend then accepts.
            //
            // A converting client was treated as the one case where it
            // genuinely cannot survive — "that layer rebuilds the request from
            // its own Schema type, and no client declares these." Measured
            // FALSE for @ai-sdk/google, which declares no `Schema` type at all
            // and forwards `oneOf`/`allOf` explicitly (see GEMINI_CLIENT_CARRIED).
            // So this keeps too, and reports the fate per client.
            if (clientConverts) {
              // Does the node survive its own repair? If the keyword is all it
              // had, a client that drops it leaves a property constraining
              // nothing — #329's question asked about the layer downstream.
              var withoutKw = {};
              Object.keys(node).forEach(function (kk) { if (kk !== k) withoutKw[kk] = node[kk]; });
              var emptied = !constrainsSomething(withoutKw);
              ledger.push(entry("=", path,
                GEMINI_ANYOF_REMEDY[k]
                  ? "Kept `" + k + "` — whether it survives depends on WHICH converting " +
                    "client you use, and that is the one fact only you have. Measured " +
                    "2026-08-10 across " + GEMINI_CLIENT_MEMBERS.length + " clients: " +
                    namesOf(geminiClientsForwarding(k)) + " forward `" + k + "` verbatim " +
                    "and recurse into its branches, and the live v1beta proto accepts it " +
                    "(no `Cannot find field`), so there it is carried end to end. " +
                    namesOf(GEMINI_CLIENT_MEMBERS.filter(function (m) {
                      return m.forwards.indexOf(k) === -1;
                    })) + " DROP it with no error" +
                    (emptied
                      ? " — and `" + k + "` is the only constraint on this node, so on that " +
                        "client this property ends up asserting nothing about the data " +
                        "while the call still succeeds."
                      : ".") +
                    " Deleting it here would have destroyed a constraint the forwarding " +
                    "clients enforce while changing nothing for the dropping ones, which " +
                    "drop it either way. If you are on a dropping client, remodel it as " +
                    "`anyOf` — every measured client carries that."
                  : "Kept `" + k + "` — " +
                    namesOf(GEMINI_CLIENT_MEMBERS.filter(function (m) {
                      return m.forwards.indexOf(k) === -1;
                    })) + " all drop it (measured 2026-08-10), so on " +
                    "this target expect it to be unenforced" +
                    (emptied
                      ? ", and since it is the only constraint on this node the property " +
                        "will assert nothing about the data while the call still succeeds."
                      : ".") +
                    " It is left in the file rather than deleted because no measured " +
                    "client ERRORS on it — they ignore it — and because " +
                    (geminiClientsForwarding(k).length
                      ? namesOf(geminiClientsForwarding(k)) + " DOES forward it, and this " +
                        "list is a snapshot of an open class, not a fact about every client."
                      : "this list is a snapshot of " + GEMINI_CLIENT_MEMBERS.length +
                        " members of an OPEN class, not a fact about every client."),
                DOCS.gemini, true));
            } else {
              // Advisory, never a gate failure: the destination accepts this,
              // so failing CI on it would be #317's mistake. Which client you
              // use is the one fact only the caller has (#319), so state the
              // outcome per client rather than picking one.
              ledger.push(entry("=", path,
                "Kept `" + k + "` — the live v1beta endpoint accepts it in `responseSchema` " +
                "(no `Cannot find field`), so the proto has this field even though no client " +
                "type declares it. What happens next depends on YOUR client: " +
                "`@google/genai` (JS) forwards it verbatim and the call goes through; " +
                "`google-genai` (Python) raises locally (`types.Schema` is `extra=\"forbid\"`), " +
                "so the request is never built; the Go client has no such field and " +
                "`encoding/json` DROPS it with no error — `{\"" + k + "\": …}` unmarshals to " +
                "`{}`, so the call succeeds against a schema that constrains nothing. " +
                "If you are on Python or Go, remodel it (a discriminated union is often " +
                "expressible as `anyOf`, which every client carries) rather than deleting it.",
                DOCS.gemini, true));
            }
          } else if (k === "$ref") {
            ledger.push(entry("!", path,
              "`$ref` is not supported by Gemini (except recursive `#`). Inline the referenced schema.",
              DOCS.gemini));
          } else if (k === "additionalProperties" && isOpenMap(node)) {
            // Dropping it here is the same deletion as OpenAI's rewrite: the
            // proto has no field for it, so the map's element type simply
            // vanishes and `{"type":"OBJECT"}` is left behind. Keep it visible.
            ledger.push(entry("!", path,
              "This is an open map (`additionalProperties` with no `properties`). The " +
              "`responseSchema` proto has no `additionalProperties` field, so the element " +
              "type would be dropped and this node would become a bare object with no " +
              "declared contents. " + OPEN_MAP_REMEDY +
              " (The `responseJsonSchema` path DOES accept `additionalProperties` — if you " +
              "can use it, run `--to gemini-json` instead.) Note that only a JS caller is " +
              "told about this: the API answers `Unknown name \"additionalProperties\"`, but " +
              "Go's `genai.Schema` has no such field and drops it during unmarshal with no " +
              "error, so the request succeeds and the map's element type is simply gone.",
              DOCS.gemini));
          } else if (k === "additionalProperties") {
            ledger.push(entry("x", path,
              "Removed `additionalProperties` — @google/genai strips it on the way out " +
              "(\"additionalProperties is not included in JSONSchema, skipping it\"), and live " +
              "v1beta calls reject it with `Unknown name \"additionalProperties\" at " +
              "generation_config.response_schema … Cannot find field`. (Note the Python " +
              "`Schema` type does declare it, so it may be accepted on Vertex; it is also " +
              "accepted on the `responseJsonSchema` path.) Unlike OpenAI, Gemini does not " +
              "need it to get strict behaviour.",
              DOCS.gemini));
            delete node[k];
          } else if (k === "prefixItems") {
            ledger.push(entry("x", path,
              "Removed `prefixItems` — not a field of the SDK's `Schema` type, so the " +
              "`responseSchema` proto has nowhere to put it. Gemini has no tuple form; " +
              "model it as an object with named fields, or a homogeneous `items` array.",
              DOCS.gemini));
            delete node[k];
          } else {
            ledger.push(entry("x", path,
              "Removed `" + k + "` — not a field of the SDK's `Schema` type " +
              "(`@google/genai` dist/genai.d.ts), so the `responseSchema` proto cannot carry it.",
              DOCS.gemini));
            delete node[k];
          }
        }
      });

      // Non-string `enum` values. `Schema.enum` is declared `list[str]` — a
      // NUMERIC enum is rejected by the oracle ("enum.0: Input should be a
      // valid string"), which is the live 400 people actually see:
      //   response_schema.properties[x].enum: only allowed for STRING type
      // The field's own doc gives the accepted form and it is not "drop it":
      //   "To mark a field as an enum, set `format` to `enum` and provide the
      //    list of possible values in `enum`. ... To define apartment numbers:
      //    {type:INTEGER, format:enum, enum:["101", "201", ...]}"
      // So the values are stringified and `format: "enum"` is set, while `type`
      // stays INTEGER/NUMBER/BOOLEAN — verified ACCEPTED for all three. The
      // constraint survives intact; only its encoding changes.
      // Narrow path only: `responseJsonSchema` accepts "enum (for strings and
      // numbers)" verbatim, so nothing needs rewriting there.
      if (Array.isArray(node.enum) && node.enum.some(function (v) { return typeof v !== "string"; })) {
        var before = JSON.stringify(node.enum);
        node.enum = node.enum.map(function (v) { return v === null ? "null" : String(v); });
        node.format = "enum";
        ledger.push(entry("~", path,
          "Rewrote `enum` " + before + " to " + JSON.stringify(node.enum) + " and set " +
          "`format: \"enum\"`. `Schema.enum` is declared `list[str]`, so a non-string enum is " +
          "rejected — this is the live `enum: only allowed for STRING type` 400. The vendor " +
          "field doc gives this exact form (`{type:INTEGER, format:enum, enum:[\"101\"]}`), so " +
          "`type` is left as-is and the allowed set is fully preserved; only its encoding " +
          "changes. `z.literal(15)` and any numeric enum land here.",
          DOCS.gemini));
      }

      // `format` is CARRIED, never stripped.
      //
      // This used to delete every string `format` outside a closed four-value
      // list, on a justification the code itself flagged as unverified: "an
      // unsupported `format` is a hard 400, while `format` is advisory, so
      // dropping it costs little." Both halves are wrong.
      //
      // Measured 2026-08-09 against the live `v1beta` pre-auth oracle: `format`
      // is a plain proto STRING field, so EVERY value validates — including
      // `frobnicate`, run as a control. The oracle discriminates on field NAMES
      // (unknown name -> `Cannot find field`) and on proto-ENUM fields (`type`
      // rejects a bogus value), and gives NO verdict on a free-string field. So
      // there is no 400 to avoid, and the cost of dropping is not little: an
      // ordinary `pydantic` contact model loses `email`, `uri` and `uuid`.
      //
      // And the vendor NAMES `email`, `byte` and `password` as supported while
      // this rule deleted all three (see GEMINI_NAMED_FORMATS). The same
      // description ends "and other formats to further refine the data type",
      // so the vendor's list is OPEN — a closed allowlist is the wrong shape
      // for it, and a keep-rule built on an open list must keep by default.
      // No client objects either: `format` is `Optional[str]` in Python, a bare
      // `string` in the JS `.d.ts` and a `string` in the Go struct.
      //
      // What remains true is that only the named values are DOCUMENTED, so for
      // anything else we carry it and say enforcement is undocumented. Advisory
      // only, never a gate failure — the destination accepts the document, and
      // an advisory that failed CI would be #317's mistake.
      if (node.format && typeof node.type === "string") {
        var namedForType = GEMINI_NAMED_FORMATS[node.type];
        if (namedForType && !namedForType[node.format]) {
          ledger.push(entry("!", path,
            "Kept `format: " + node.format + "` — it reaches the backend, but Gemini's `Schema.format` " +
            "names only " + Object.keys(namedForType).sort().join(", ") + " for `" + node.type + "`. " +
            "The vendor's list is explicitly open (\"and other formats\"), so this is carried rather than " +
            "dropped; treat it as a hint to the model, not an enforced constraint.",
            DOCS.gemini, true));
        }
      }

      // `default: null` survives this path in JS and Python and is DROPPED in Go.
      // `google.golang.org/genai`'s `Schema.Default` is `any` with `omitempty`,
      // so an explicit JSON `null` unmarshals to a nil interface and is then
      // omitted on the way out — indistinguishable from "no default at all".
      // Measured on v1.67.0, and it is the ONLY key our converted output loses
      // when a Go caller round-trips it through `genai.Schema`. The proto itself
      // accepts it (live v1beta pre-auth check passes), so this is a client
      // limitation, not a schema error — advisory, never a gate failure.
      // Pydantic emits `"default": null` for every `Optional[x] = None` field,
      // so Go callers converting Pydantic output hit this constantly.
      if (Object.prototype.hasOwnProperty.call(node, "default") && node.default === null) {
        ledger.push(entry("=", path,
          "`default: null` is kept — the proto accepts it and `@google/genai` (JS) and " +
          "`google-genai` (Python) both send it. If your client is Go, it will NOT arrive: " +
          "`google.golang.org/genai`'s `Schema.Default` is `any` with `omitempty`, so an " +
          "explicit null unmarshals to a nil interface and is dropped with no error. Set the " +
          "default in your Go struct literal if you need it.",
          DOCS.gemini, true));
      }

      // add propertyOrdering so field order is deterministic (Gemini honors it)
      if (isObjectSchema(node) && node.properties) {
        var keys = Object.keys(node.properties);
        if (keys.length && !node.propertyOrdering) {
          node.propertyOrdering = keys.slice();
          ledger.push(entry("+", path,
            "Added `propertyOrdering` — Gemini uses it to fix the field order it emits. " +
            "Optional: the schema is already accepted without it.",
            DOCS.gemini, true));
        }
      }
    });

    // If the output carries `nullable` — whether this run produced it or the
    // caller wrote it — the document is now correct for exactly one destination
    // and quietly wrong for the other. Advisory, never a gate
    // failure (#317): assigned to `responseSchema` — the stated target — it is
    // right, and the caller is the only one who knows where it is going.
    if (!jsonPath && !clientConverts) {
      var emittedNullable = false;
      walk(s, "root", function (n) {
        if (isPlainObject(n) && n.nullable === true) emittedNullable = true;
      });
      if (emittedNullable) {
        ledger.push(entry("=", "root",
          "This output now carries `nullable`, which is correct ONLY if you assign it " +
          "straight to `responseSchema`. If you instead hand it to a library that does " +
          "its own JSON-Schema-to-`Schema` conversion, `nullable` is dropped and those " +
          "fields silently stop being nullable — measured on google-adk 2.6.3's " +
          "`_to_gemini_schema`, where " +
          "`nullable` is not a field of its `_ExtendedJSONSchema` (which does extend " +
          "JSONSchema with `property_ordering`, so proto fields are not refused across " +
          "the board). The two spellings are exclusive, not merely different: the " +
          "backend REJECTS `type: [\"string\",\"null\"]` and that layer drops `nullable`, " +
          "so no single document satisfies both. For that pipeline use " +
          "`--to gemini-client`.",
          DOCS.gemini, true));
      }
    }

    // BEFORE the "no changes needed" fallback, deliberately: the orphan-`$defs`
    // pruner deletes a bag nothing points into WITHOUT a ledger entry, so a
    // document consisting only of that bag reached the fallback with an empty
    // ledger and was told "Every keyword here is a field of the SDK's `Schema`
    // type" — about a document whose keywords had just been removed. Exit 0.
    noteEmptiedDocument(schema, s, ledger, DOCS.gemini, GEMINI_EMPTIED_REMEDY);

    if (ledger.length === 0) {
      ledger.push(entry("=", "root",
        "No changes needed. Every keyword here is a field of the SDK's `Schema` type, " +
        "so the `responseSchema` proto can carry all of it. (Adding a top-level `$schema` " +
        "would instead route you to `responseJsonSchema`, which accepts full JSON Schema " +
        "including `$ref` and recursion.)",
        DOCS.gemini));
    }
    return { schema: s, ledger: ledger };
  }

  // ---- generic recursive walk ----------------------------------------------
  // Applies fn(node, path) to every schema node, depth-first.
  // `inCombinator` is true only for a node that is a DIRECT member of an
  // `anyOf`/`oneOf`/`allOf` array. Some rules are positional: `{"type":"null"}`
  // standing alone is refused by @google/genai ("type: null can not be the only
  // possible type for the field") but is ACCEPTED by both clients and by the
  // live proto when it is one branch of a union. A node deep inside a branch is
  // not itself a member, so the flag is not inherited.
  function walk(node, path, fn, inCombinator) {
    if (!isPlainObject(node)) return;
    fn(node, path, !!inCombinator);
    if (isPlainObject(node.properties)) {
      Object.keys(node.properties).forEach(function (k) {
        walk(node.properties[k], path + "." + k, fn);
      });
    }
    if (isPlainObject(node.items)) walk(node.items, path + "[]", fn);
    // draft-07 tuple form: `items` is an ARRAY of schemas. Descending only into
    // the object form left every sub-schema of a `z.tuple()` unvisited, so a
    // nested object inside a tuple never got `additionalProperties: false`.
    if (Array.isArray(node.items)) {
      node.items.forEach(function (it, i) { walk(it, path + "[" + i + "]", fn); });
    }
    if (Array.isArray(node.prefixItems)) {
      node.prefixItems.forEach(function (it, i) { walk(it, path + "[" + i + "]", fn); });
    }
    ["anyOf", "oneOf", "allOf"].forEach(function (kw) {
      if (Array.isArray(node[kw])) {
        node[kw].forEach(function (sub, i) {
          walk(sub, path + "/" + kw + "[" + i + "]", fn, true);
        });
      }
    });
    // `not` holds a SINGLE subschema rather than an array, so the combinator
    // loop above never saw it. That was latent while every target either
    // stripped `not` (openai, gemini) or demoted it (anthropic-json) before
    // anything could hide inside it — but `--to gemini` now KEEPS it (the
    // v1beta proto has the field), and a `$ref` or open map inside an unvisited
    // `not` would be a false pass. NOT passed as a combinator member: `not`
    // inverts its subschema rather than being one branch of a union, so the
    // positional rule #337 added for `anyOf` members does not apply here.
    if (isPlainObject(node.not)) walk(node.not, path + "/not", fn);
    ["$defs", "definitions"].forEach(function (bag) {
      if (isPlainObject(node[bag])) {
        Object.keys(node[bag]).forEach(function (k) { walk(node[bag][k], bag + "." + k, fn); });
      }
    });
  }

  // ---- OpenAI, NON-strict surfaces -----------------------------------------
  //
  // `openai` above models Structured Outputs / strict mode. That is not the only
  // OpenAI dialect, and the switch is not in the schema — it is which API you call.
  //
  // openai@7.4.0's `helpers/zod.js` exports FIVE schema builders. Four of them
  // (`zodResponseFormat`, `zodTextFormat`, `zodFunction`, `zodResponsesFunction`)
  // hardcode `strict: true` and run the schema through `toStrictJsonSchema()`.
  // The fifth, `zodRealtimeFunction`, calls `zodV3ToNonStrictJsonSchema` /
  // `zodV4ToNonStrictJsonSchema` — which never call `toStrictJsonSchema()` — and
  // deliberately omits `strict`, with this docstring:
  //
  //   "Unlike zodResponsesFunction, this helper does not add `strict` because
  //    Realtime function tools do not support that field."
  //
  // Corroborated by the request types themselves:
  //   - `FunctionDefinition` (chat/responses) has `strict?: boolean | null`, documented
  //     "Only a subset of JSON Schema is supported when `strict` is `true`."
  //     The subset restriction is CONDITIONAL on strict.
  //   - `RealtimeFunctionTool` has exactly four fields — description, name,
  //     `parameters?: unknown`, type. There is NO `strict` field at all, and
  //     `parameters` is documented as plain "Parameters of the function in JSON Schema"
  //     with no subset caveat.
  //
  // So the strip list in `toOpenAI` is justified by "unsupported schema -> you will
  // receive an error", which is a claim about STRICT MODE, not about OpenAI. Applying
  // it here would destroy real constraints to buy nothing — the same cross-policy
  // strip mistake the Gemini path already had.
  //
  // Error policy on this surface: the subset rule does not apply, so nothing is
  // stripped and nothing is rewritten. Constraints are not grammar-enforced either
  // (there is no constrained decoder without strict), so they are advisory to the
  // model — which is worth SAYING, and is the whole value of this target.
  //
  // #322 — THE NAME WAS THE DEFECT. Shipping this as `openai-realtime` only scoped it
  // to the surface where the condition was FIRST FOUND. The condition that actually
  // selects this dialect is `strict` being absent or false, and in openai@7.4.0 that
  // flag is optional at FOUR declaration sites outside Realtime:
  //   shared.d.ts:112   FunctionDefinition.strict?: boolean | null
  //   shared.d.ts:251   ResponseFormatJSONSchema.JSONSchema.strict?: boolean | null
  //   responses.d.ts:741, :2456 (responses tools / text.format)
  // each documented "Only a subset of JSON Schema is supported when `strict` is `true`".
  // Realtime is the special case where non-strict is not a choice (no field at all);
  // everywhere else it is the DEFAULT, because omitting `strict` is non-strict.
  //
  // This is not hypothetical. Instructor — Python-native, Pydantic-first, and the
  // most common way Python code gets structured output — omits `strict` on EVERY
  // OpenAI path: `Mode.TOOLS` (the default), `Mode.JSON_SCHEMA`, and even
  // `Mode.TOOLS_STRICT`, which is deprecated and collapses to `Mode.TOOLS`, so a
  // user who explicitly asks for strict silently gets non-strict. Measured on
  // instructor==1.15.4 via an intercepted `httpx.Client.send`: no `strict` key in
  // any of the three payloads. For those users `--to openai` exits 1 and proposes
  // four edits to a schema their API accepts as written — a false CI failure, the
  // #312/#314/#317 class — and the correct verdict was reachable only by typing a
  // Realtime-named target they have no reason to try.
  //
  // `surfaceHasNoStrictField` distinguishes the two, because the REASON differs and
  // the reader needs the true one: on Realtime there is no `strict` field to set;
  // elsewhere the field exists and is simply unset, which means the fix for someone
  // who WANTED enforcement is "set strict: true and re-run `--to openai`".
  //
  // #366 CORRECTION — "elsewhere the field exists and is simply unset" is itself
  // one member's story. Measured, the non-Realtime surfaces split three ways
  // (OPENAI_STRICT_SURFACES): four where unset means off, two where OMITTING it
  // means the service auto-negotiates strict and silently falls back, and two
  // where the field is REQUIRED so there is no unset state at all. The output is
  // byte-identical for all of them — the schema is legal either way, which is why
  // this stays one target — but the DIAGNOSIS is the deliverable here, so it
  // forks per group instead of asserting one group's answer for everyone.
  function toOpenAINonStrict(input, surfaceHasNoStrictField) {
    var schema = clone(input);
    var ledger = [];
    var url = surfaceHasNoStrictField
      ? DOCS["openai-realtime"] : DOCS["openai-nonstrict"];

    ledger.push(entry("=", "root", surfaceHasNoStrictField
      ? "No changes needed. This surface has no `strict` field, so the Structured Outputs " +
        "keyword subset does not apply — your schema is sent as plain JSON Schema."
      : "No changes needed. `strict` is absent or false, so the Structured Outputs keyword " +
        "subset does not apply — your schema is sent as plain JSON Schema.", url));

    // Everything `toOpenAI` would have removed or rewritten is legal here. Name the
    // specific keywords found so the reader can see the divergence is real and is
    // about their schema, not a generic disclaimer.
    var kept = [];
    walk(schema, "root", function (node, path) {
      noteUnsatisfiable(node, path, ledger, url);
    });

    walk(schema, "root", function (node, path) {
      Object.keys(node).forEach(function (k) {
        if (OPENAI_SUPPORTED[k] || kept.indexOf(k) !== -1) return;
        if (k === "properties" || k === "$defs" || k === "definitions") return;
        kept.push(k);
        ledger.push(entry("=", path,
          "`" + k + "` is kept. Strict mode cannot represent it, but this surface is not " +
          "strict, so it is neither an error nor stripped.", url));
      });
    });

    // #366 — this claim used to be unconditional, and it is FALSE on two of the
    // surfaces it was covering. `strict` unset does not mean the same thing
    // everywhere (see OPENAI_STRICT_SURFACES), so the sentence is scoped to the
    // surfaces where it holds and the other groups get their own, true, one.
    if (surfaceHasNoStrictField) {
      ledger.push(entry("!", "root",
        "Without `strict`, the model is not grammar-constrained: every constraint here is " +
        "guidance the model can violate, so keep validating the response yourself.",
        url, true));
    } else {
      var offs = openaiSurfacesWhereUnsetIs("off");
      var autos = openaiSurfacesWhereUnsetIs("auto");
      var reqs = openaiSurfacesWhereUnsetIs("required");

      ledger.push(entry("!", "root",
        "On " + offs.length + " of the surfaces where `strict` is optional (" +
        offs.map(function (s) { return s.api; }).join(", ") + "), leaving it unset means the " +
        "model is not grammar-constrained: every constraint here is guidance the model can " +
        "violate, so keep validating the response yourself.",
        url, true));

      // The group that makes the target's NAME wrong. Quote the vendor rather
      // than paraphrase, because the surprising half is that OMITTING the flag
      // is not the same as disabling it.
      ledger.push(entry("!", "root",
        "But `strict` unset is NOT non-strict everywhere. On " +
        autos.map(function (s) { return s.api; }).join(" and ") + " the SDK documents the " +
        "opposite: \"If omitted, Responses attempts to use strict validation when the schema " +
        "is compatible, and falls back to non-strict validation otherwise.\" So on those " +
        "surfaces this schema may well be enforced — and if it is not, the downgrade is " +
        "SILENT, with no error to tell you the constraints stopped applying.",
        url, true));

      // Deliberately does NOT predict which branch. Measured across 528 captured
      // schemas, our own ledger ops are not a sound proxy for the vendor's
      // compatibility test (a `~` covers both a lossless `definitions`->`$defs`
      // rename and a real optional->required+nullable repair), and the service's
      // exact notion of "compatible" is not observable without an API key. So
      // this names the check the reader can run instead of guessing for them.
      ledger.push(entry("=", "root",
        "To find out which branch you land on, run `--to openai`: if it reports no changes, " +
        "the schema is already strict-valid. If it reports changes, it is not valid as " +
        "written — whether the service repairs it or falls back is its call, not something " +
        "this tool can see from the schema.",
        url, true));

      ledger.push(entry("=", "root",
        "Note also that `strict` is not optional on every surface: on " +
        reqs.map(function (s) { return s.api; }).join(" and ") + " the field is required, so " +
        "there is no \"omitted\" state — a caller there passed `false` or `null` on purpose.",
        url, true));
    }

    // Name the sibling target, the same way the Anthropic and Gemini pairs do. The
    // reader picked a target from a flag they may not control (Instructor omits
    // `strict` even in Mode.TOOLS_STRICT), so say what switching would cost.
    ledger.push(entry("=", "root", surfaceHasNoStrictField
      ? "Realtime function tools have no `strict` field, so there is no enforced " +
        "alternative on this surface. On chat/responses you can set `strict: true` and " +
        "re-run with `--to openai`."
      : "If you want the constraints actually enforced, set `strict: true` on the tool or " +
        "response_format and re-run with `--to openai` — but that dialect is a subset, so " +
        "expect real edits. On namespace tools that edit may be unnecessary, since omitting " +
        "the flag there already attempts strict validation; setting it to `true` turns the " +
        "silent fallback into a loud rejection, which is usually what you want in CI. Note " +
        "that some clients omit `strict` for you: Instructor's `Mode.TOOLS_STRICT` is " +
        "deprecated and sends a non-strict payload.",
      url, true));

    noteEmptiedDocument(input, schema, ledger, url,
      "Nothing is removed on this surface, so if you are seeing this the document already " +
      "carried no assertion when it arrived.");
    return { schema: schema, ledger: ledger };
  }

  var CONVERTERS = {
    openai: toOpenAI,
    // Anthropic is two request fields, two dialects, two targets — same shape
    // as Gemini below. `tools[].input_schema` applies no transform at all;
    // `output_format` rebuilds the schema. Which one you are on is the
    // caller's fact, so it is never inferred from the schema (#315/#319).
    anthropic: function (s) { return toAnthropic(s, false); },
    // The structured-output path is split again, by which SDK builds the request.
    // That is a fact only the caller has (#319) and it is NOT inferable from the
    // schema — and NOT a version skew: the SDKs ship the same version string
    // with different behaviour, so it will not resolve itself. Three now, and
    // `anthropic-go` also covers the Go tools path, because Go is the one SDK
    // where `tools[].input_schema` runs the transform too.
    "anthropic-json": function (s) { return toAnthropic(s, true, "js"); },
    "anthropic-json-python": function (s) { return toAnthropic(s, true, "python"); },
    "anthropic-go": function (s) { return toAnthropic(s, true, "go"); },
    // Two request fields, two dialects, two targets. Never inferred — see the
    // note on toGemini(): the routing switch belongs to one client, not to
    // Gemini, so guessing it produces a false pass for everyone else.
    gemini: function (s) { return toGemini(s, false); },
    "gemini-json": function (s) { return toGemini(s, true); },
    // Third Gemini target, and the condition that selects it is neither a
    // request field nor an SDK but WHO PERFORMS THE CONVERSION. The proto's
    // constraints all apply (a converting client cannot send what the proto has
    // no field for), but the nullability spellings are EXCLUSIVE — `nullable`
    // reaches `responseSchema` and is dropped by the converting layer, while a
    // union `type` is dropped by `responseSchema` and converted correctly by
    // that layer. There is no intersection form here, which is why this is a
    // separate target rather than a wider rule on `gemini`.
    //
    // Scope, checked rather than assumed: google-adk 2.6.3 defaults
    // `JSON_SCHEMA_FOR_FUNC_DECL` to True, so its TOOL declarations now go to
    // `parameters_json_schema` and skip `_to_gemini_schema` entirely. The
    // measurements above are of that function, which is still shipped and still
    // reached with the flag disabled — so this target is justified by the
    // structural fact (`nullable` is not a JSON Schema keyword, so any layer
    // reading JSON Schema drops it), with ADK as the measured instance, NOT by a
    // claim that every ADK user hits it today.
    "gemini-client": function (s) { return toGemini(s, false, true); },
    // Non-strict is a property of the `strict` flag, not of one API surface, so the
    // primary name is the CONDITION. `openai-realtime` stays as the surface where
    // that condition is forced rather than chosen (and so nobody's script breaks).
    "openai-nonstrict": function (s) { return toOpenAINonStrict(s, false); },
    "openai-realtime": function (s) { return toOpenAINonStrict(s, true); }
  };

  // ---- public API ----------------------------------------------------------

  // convert(input, provider, opts) -> {ok, schema, ledger, inferred, error}
  // `input` may be a JSON string (browser textarea, CLI file read) OR an
  // already-parsed object — library callers hand us the object that
  // zod-to-json-schema / Pydantic .model_json_schema() just produced, and
  // making them JSON.stringify it first was pointless friction.
  function convert(input, provider, opts) {
    opts = opts || {};
    var parsed;
    if (typeof input === "string") {
      try {
        parsed = JSON.parse(input);
      } catch (e) {
        return { ok: false, error: "That isn't valid JSON: " + e.message };
      }
    } else if (input && typeof input === "object") {
      parsed = input;
    } else {
      return { ok: false, error: "Expected a JSON string or an object, got " + (input === null ? "null" : typeof input) };
    }
    var conv = CONVERTERS[provider];
    if (!conv) return { ok: false, error: "Unknown provider: " + provider };

    var inferred = false;
    var schema = parsed;
    var treatAsExample = opts.mode === "example" || (opts.mode !== "schema" && !looksLikeSchema(parsed));
    if (treatAsExample) {
      schema = inferSchema(parsed);
      inferred = true;
    }

    var result = conv(schema);

    // Well-formedness, on the INPUT and provider-independent. Entry side per
    // #341/#342: this is a claim about what the caller GAVE us, not about what
    // we are handing back. Skipped when the input was treated as an example --
    // an inferred schema is well formed by construction, and the "looked like
    // an example" note already tells that reader what happened.
    //
    // unshift, not push: if a keyword is malformed, every other line in the
    // ledger was computed from a document we could not fully read, so this has
    // to be the first thing the reader sees.
    if (!inferred) {
      var malformed = findMalformedKeywords(schema);
      for (var mi = malformed.length - 1; mi >= 0; mi--) {
        result.ledger.unshift(entry("!", malformed[mi].path,
          malformedKeywordMessage(malformed[mi]), DOCS[provider]));
      }
    }

    // An emptied map is provider-independent: it is a fact about the document
    // the caller is holding, not about who accepts it, and EVERY provider
    // accepts it. So it is reported once, here, for every target — and only as
    // an advisory, because there is genuinely nothing to fix in this file. The
    // value type is already gone; the fix belongs upstream, in whatever
    // compatibility layer ran before us.
    //
    // Reported on the INPUT, because a converter that legitimately closes an
    // object would otherwise make us report our own edit back to the caller.
    walk(schema, "root", function (node, path) {
      var form = emptiedMapForm(node);
      if (!form) return;
      // When `properties: {}` is present we genuinely cannot tell an emptied map
      // from a declared empty object — crewai produces the same bytes for both —
      // so the advisory says so instead of asserting a cause it cannot know.
      var causeNote = form === "empty-properties"
        ? " NOTE on this one: it also carries `properties: {}`, which USUALLY means someone " +
          "declared an empty object on purpose. It no longer settles it. Measured on crewai " +
          "1.15.14, `force_additional_properties_false` " +
          "(`crewai/utilities/pydantic_schema_utils.py`) overwrites the value schema of a " +
          "`Dict[str, str]` with `false` and then ADDS `properties: {}` and `required: []`, so " +
          "an emptied map and a genuinely empty model come out byte-identical on its tool path. " +
          "Whichever it is, the field is dead: check the source model."
        : "";
      result.ledger.push(entry("=", path,
        "This object is closed (`additionalProperties: false`) and declares no usable `properties`, " +
        "so its only legal value is `{}` — the model can never put anything in it. Every " +
        "provider accepts this, so nothing will warn you. Most often it is not what anyone " +
        "wrote: it is what is left after something set `additionalProperties: false` on a " +
        "map/dictionary, which does not close an open map, it empties it. Either way the value " +
        "type is already gone here and cannot be recovered from this file — but WHERE it was " +
        "lost decides what you can do about it, and there are two measured cases. (a) A " +
        "compatibility layer that ran AFTER your schema was generated: `@mastra/schema-compat`'s " +
        "`prepareJsonSchemaForOpenAIStrictMode` does this to an ordinary `z.record(z.string())`, " +
        "and agno 2.8.7's `make_nested_strict` (`agno/tools/function.py`) does it to a " +
        "`Dict[str, str]` TOOL PARAMETER. There the open map still existed at some point, so " +
        "check the schema BEFORE that layer runs. (b) The GENERATOR ITSELF, where the open form " +
        "was never emitted at all and there is no earlier point to check: semantic-kernel " +
        "1.44.1's `KernelJsonSchemaBuilder.build(..., structured_output=True)` builds the value " +
        "schema for a `Dict[str, str]` and then overwrites it with `false` three lines later in " +
        "the same function. In that case the only remedies are to remodel the field, or to take " +
        "a different code path in that framework — measured: handing semantic-kernel the same " +
        "model as a Pydantic `BaseModel` instead of a plain class keeps the map OPEN, which the " +
        "vendor then rejects loudly instead of accepting a field that can never be filled. " +
        causeNote +
        " If you really did mean an always-empty object, ignore this. " + OPEN_MAP_REMEDY,
        DOCS[provider], true));
    });

    // Dangling local `$ref`s are checked on the OUTPUT, not the input, and
    // deliberately: it is the document the caller is about to send, and running
    // it last means it also audits our own edits — the ref-spelling rewrite, the
    // `definitions`->`$defs` rename and the orphan-`$defs` pruner all move
    // pointers or bags around, and a keep-rule that gets that wrong deletes a
    // definition something still points at (#320). This is the check that would
    // have caught it.
    //
    // Severity is per provider and MEASURED, not ported (rule 0-bis) — being
    // merely stricter than the vendor is a false CI failure, which this project
    // has shipped five times:
    //   openai  BLOCKER  -- `toStrictJsonSchema()` (openai@7.4.0) throws
    //                       "Local $ref ... does not resolve to an object or
    //                       boolean schema".
    //   gemini  BLOCKER  -- the narrow `responseSchema` proto has no `$ref`
    //                       field at all, so we inline refs; an absent target
    //                       cannot be inlined and `types.Schema`
    //                       (google-genai 2.17.0, extra="forbid") REJECTS what
    //                       is left.
    //   others  ADVISORY -- measured on @anthropic-ai/sdk 0.116.0: BOTH
    //                       `betaTool()` and `betaJSONSchemaOutputFormat()`
    //                       accept a dangling ref and pass it through verbatim.
    //                       The remaining targets were not probed for this shape
    //                       this cycle, so they get the advisory too rather than
    //                       a blocker we cannot justify.
    // No repair is offered on purpose: the definition is gone from this file and
    // inventing one would silently narrow the schema to a guess (#329's rule --
    // when a repair is impossible, name the remodelling instead).
    var danglingBlocks = provider === "openai" || provider === "gemini";
    findDanglingLocalRefs(result.schema).forEach(function (d) {
      result.ledger.push(entry(danglingBlocks ? "!" : "=", d.path,
        "`$ref: \"" + d.ref + "\"` points into this document but there is nothing at that " +
        "location — the reference is dangling, so whatever that subschema constrained is " +
        "simply absent. " +
        (danglingBlocks
          ? (provider === "openai"
              ? "OpenAI strict mode rejects it: `toStrictJsonSchema()` throws \"Local $ref ... " +
                "does not resolve to an object or boolean schema\"."
              : "Gemini's narrow `responseSchema` proto has no `$ref` field, so a ref has to be " +
                "inlined — and this one has no target to inline, so `types.Schema` rejects what " +
                "is left. `--to gemini-json` accepts `$ref`, but a dangling one still points at " +
                "nothing.")
          : "Measured on `@anthropic-ai/sdk` 0.116.0, both `betaTool()` and " +
            "`betaJSONSchemaOutputFormat()` ACCEPT this and forward the pointer unresolved, so " +
            "nothing will error — the model is simply handed a field with no schema behind it.") +
        " The usual cause is that something moved or dropped the definition bag and left the " +
        "pointers: measured on strands-agents 1.51.0, `_flatten_schema` " +
        "(`strands/tools/structured_output/structured_output_utils.py`) rebuilds the schema from " +
        "a five-key keep-list (`type`, `properties`, `title`, `description`, `required`), so a " +
        "`Field(discriminator=...)` union keeps its `oneOf: [{\"$ref\": \"#/$defs/...\"}]` and " +
        "loses the `$defs` bag those refs point at. Restore the definition under `$defs`, or " +
        "inline the subschema at this location. It cannot be repaired automatically — the " +
        "content is not in this file, and guessing it would narrow your schema to whatever we " +
        "invented.",
        DOCS[provider], !danglingBlocks));
    });

    return {
      ok: true,
      schema: result.schema,
      ledger: result.ledger,
      inferred: inferred,
      docUrl: DOCS[provider]
    };
  }

  var api = {
    convert: convert,
    inferSchema: inferSchema,
    looksLikeSchema: looksLikeSchema,
    toOpenAI: toOpenAI,
    toAnthropic: toAnthropic,
    toGemini: toGemini,
    DOCS: DOCS,
    // The narrow `responseSchema` subset, exported so it can be diffed against
    // the vendor artifact it is derived from. It is now confirmed by three
    // independent ones: the JS `Schema` interface (dist/genai.d.ts), the Python
    // `types.Schema` model (`extra="forbid"`), and the Go `Schema` struct's
    // json tags (google.golang.org/genai v1.67.0) — all 22, identical.
    GEMINI_ALLOWED_KEYS: Object.keys(GEMINI_ALLOWED),

    // The keys @ai-sdk/google's `convertJSONSchemaToOpenAPISchema` destructures,
    // i.e. everything that can reach Gemini's narrow `responseSchema` path
    // through that client. Exported for the same reason as the Go tables (#361):
    // a table transcribed from a vendor artifact has no expiry date on it, so
    // make re-diffing it one command rather than a re-derivation.
    AI_SDK_GOOGLE_FORWARDED_KEYS: Object.keys(AI_SDK_GOOGLE_FORWARDED),

    // The subset of GEMINI_PROTO_ONLY that at least one MEASURED converting
    // client carries. Exported because it is the discriminator `--to
    // gemini-client` used to decide by itself: the two members of that class
    // disagree here, so the rule reports instead of choosing (#365).
    GEMINI_CLIENT_CARRIED_KEYS: Object.keys(GEMINI_CLIENT_CARRIED),
    GEMINI_CLIENT_MEMBERS: GEMINI_CLIENT_MEMBERS,

    // Every `strict` declaration in openai@7.4.0's resources, with what OMITTING
    // it means on that surface. Exported for #361's reason and one more: this is
    // the table that shows `openai-nonstrict` is named for a condition whose
    // meaning is per-surface, so the grouping is the finding and should be
    // re-diffable rather than re-derived.
    OPENAI_STRICT_SURFACES: OPENAI_STRICT_SURFACES.map(function (s) {
      return { path: s.path, file: s.file, line: s.line, unset: s.unset, api: s.api };
    }),

    // Every measured way of reaching Anthropic's structured-output path, and
    // whether the demote-to-prose transform runs on it. Exported for #361's
    // reason plus #366's: `anthropic-json` is named for a CONDITION whose
    // meaning turns out to be per-call-site rather than per-request-field, so
    // the grouping IS the finding and should be re-diffable, not re-derived.
    ANTHROPIC_TRANSFORM_SURFACES: ANTHROPIC_TRANSFORM_SURFACES.map(function (s) {
      return { lang: s.lang, form: s.form, transforms: s.transforms };
    }),

    // The `format` VALUES Anthropic's transformer keeps on a string. Exported
    // for the same reason as GEMINI_ALLOWED_KEYS: so "all three SDKs agree" is a
    // test rather than a sentence. Confirmed 2026-08-09 against three
    // independent vendor artifacts, each a LITERAL in code — the JS
    // `SUPPORTED_STRING_FORMATS` (`new Set([...])`, lib/transform-json-schema.js),
    // the Python `SupportedStringFormats` (a `set` literal, lib/_parse/_transform.py)
    // and the Go `supportedStringFormats` (`[]string{...}`, schemautil.go) —
    // all 10, identical.
    //
    // #344 asked whether a vendor list is CLOSED or OPEN before implementing it
    // as an allowlist. These three are CLOSED: each enumerates its members in
    // code with no "and others" escape, which is the opposite of Gemini's
    // `Schema.format`, whose own field description ends "and other formats to
    // further refine the data type". Same keyword, opposite answers, so the
    // question has to be asked per vendor rather than once per keyword.
    //
    // Honest boundary (#343): these are three CLIENTS agreeing, which is exactly
    // the shape that was wrong for Gemini. Unlike Gemini there is no free
    // pre-auth oracle here — Anthropic authenticates before validating — so the
    // service itself has NOT been asked, and this list is only a claim about
    // what the clients forward.
    ANTHROPIC_STRING_FORMATS_KEPT: Object.keys(ANTHROPIC_STRING_FORMATS),

    // #361. The two tables that decide a keyword's FATE on the Go SDK, exported
    // so the diff against the vendor is a test rather than a sentence (#351).
    // Both were transcribed by hand — `supportedSchemaKeys` in #332, the invopop
    // struct in #358 — and until now neither appeared anywhere in the suite, so
    // nothing would have noticed a typo or a vendor bump.
    //
    // They are read TOGETHER, and that is what makes the diff load-bearing in
    // both directions. #360's corollary is that agreeing with a vendor blocklist
    // is nearly free for an allowlist; here the derived quantity is three-valued,
    // so each table can be wrong in a way the other cannot mask:
    //
    //   in ANTHROPIC_GO_SUPPORTED          -> KEPT      (enforced)
    //   else in GO_INVOPOP_MODELLED        -> DEMOTED   (prose, unenforced)
    //   else                               -> DROPPED   (no trace at all)
    //
    // Get the first table wrong and we promise enforcement that is not there, or
    // warn about a keyword the vendor keeps. Get the second wrong and we call a
    // silent deletion a demotion, which is the severity users act on.
    ANTHROPIC_GO_SUPPORTED_KEYS: Object.keys(ANTHROPIC_GO_SUPPORTED),
    GO_INVOPOP_MODELLED_KEYS: Object.keys(GO_INVOPOP_MODELLED),
    OPENAI_ANNOTATION_KEYWORDS_LIST: Object.keys(OPENAI_ANNOTATION_KEYWORDS)
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LLMSchema = api;
})(typeof window !== "undefined" ? window : this);
