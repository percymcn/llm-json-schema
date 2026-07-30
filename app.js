/* UI wiring for LLM JSON Schema. Pure DOM; the transforms live in engine.js. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };

  var state = { provider: "openai", mode: "convert" };

  var SAMPLES = {
    basic: {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" } },
      required: ["name", "age"]
    },
    optional: {
      type: "object",
      properties: {
        id: { type: "string" },
        nickname: { type: "string", description: "optional display name" }
      },
      required: ["id"]
    },
    nested: {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: { email: { type: "string", format: "email" } },
          required: ["email"]
        },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["user", "tags"]
    },
    example: { id: 42, title: "Ship it", done: false, labels: ["urgent", "backend"] },
    rejected: {
      type: "object",
      properties: {
        query: { type: "string", pattern: "^.{1,80}$" },
        filters: { type: "object", properties: { since: { type: "string", format: "date" } } }
      },
      allOf: [{ required: ["query"] }]
    }
  };

  var OP = {
    "+": { cls: "add", glyph: "+" },
    "~": { cls: "chg", glyph: "~" },
    "x": { cls: "rm", glyph: "−" },
    "!": { cls: "vio", glyph: "!" },
    "=": { cls: "same", glyph: "=" }
  };

  // ---- JSON syntax highlight (safe: escape first, then tag tokens) ----
  function highlight(obj) {
    var json = JSON.stringify(obj, null, 2);
    json = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return json.replace(
      /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
      function (m) {
        var c = "n";
        if (/^"/.test(m)) c = /:$/.test(m) ? "k" : "s";
        else if (/true|false/.test(m)) c = "b";
        else if (/null/.test(m)) c = "null";
        return '<span class="' + c + '">' + m + "</span>";
      }
    );
  }

  function renderLedger(res) {
    var body = $("ledgerBody");
    var count = $("count");
    if (!res.ok) {
      body.innerHTML = '<div class="err">' + esc(res.error) + "</div>";
      count.textContent = "";
      return;
    }
    var L = res.ledger || [];
    var vios = L.filter(function (l) { return l.op === "!"; }).length;
    var changes = L.filter(function (l) { return l.op !== "=" && l.op !== "!"; }).length;
    if (state.mode === "validate") {
      var issues = vios + changes;
      count.textContent = issues ? issues + (issues === 1 ? " issue" : " issues") + " to fix" : "valid as-is";
    } else {
      count.textContent = changes + (changes === 1 ? " change" : " changes") + (vios ? " · " + vios + " needs your attention" : "");
    }

    if (!L.length) {
      body.innerHTML = '<p class="empty">No changes needed.</p>';
      return;
    }
    var ol = document.createElement("ol");
    L.forEach(function (l) {
      var o = OP[l.op] || OP["="];
      var li = document.createElement("li");
      li.className = "row";
      var path = l.path && l.path !== "root" ? '<span class="path">' + esc(l.path) + "</span>" : "";
      li.innerHTML =
        '<span class="op ' + o.cls + '">' + o.glyph + "</span>" +
        '<span class="msg">' + path + esc(l.msg) +
        (l.ruleUrl ? '<br><a class="cite" href="' + l.ruleUrl + '" target="_blank" rel="noopener">official rule ↗</a>' : "") +
        "</span>";
      ol.appendChild(li);
    });
    body.innerHTML = "";
    body.appendChild(ol);
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function run() {
    var raw = $("input").value.trim();
    if (!raw) {
      $("output").innerHTML = "";
      $("ledgerBody").innerHTML = '<p class="empty">Paste a schema or a JSON example, then Convert.</p>';
      $("count").textContent = "";
      $("hint").textContent = "";
      return;
    }
    var res = LLMSchema.convert(raw, state.provider, {});
    if (res.ok) {
      $("output").innerHTML = highlight(res.schema);
      $("hint").textContent = res.inferred ? "detected a JSON example → inferred a schema first" : "";
    } else {
      $("output").innerHTML = "";
      $("hint").textContent = "";
    }
    renderLedger(res);
  }

  // ---- events ----
  function selectProvider(p) {
    state.provider = p;
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
      t.setAttribute("aria-selected", t.dataset.p === p ? "true" : "false");
    });
    run();
  }
  function selectMode(m) {
    state.mode = m;
    Array.prototype.forEach.call(document.querySelectorAll(".modeswitch button"), function (b) {
      b.setAttribute("aria-pressed", b.dataset.mode === m ? "true" : "false");
    });
    $("run").textContent = m === "validate" ? "Validate →" : "Convert →";
    run();
  }

  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () { selectProvider(t.dataset.p); });
  });
  document.querySelectorAll(".modeswitch button").forEach(function (b) {
    b.addEventListener("click", function () { selectMode(b.dataset.mode); });
  });
  document.querySelectorAll(".samples button").forEach(function (b) {
    b.addEventListener("click", function () {
      $("input").value = JSON.stringify(SAMPLES[b.dataset.sample], null, 2);
      run();
    });
  });
  $("run").addEventListener("click", run);
  var t;
  $("input").addEventListener("input", function () { clearTimeout(t); t = setTimeout(run, 350); });
  $("copy").addEventListener("click", function () {
    var text = $("output").textContent;
    if (!text) return;
    navigator.clipboard && navigator.clipboard.writeText(text).then(function () {
      var c = $("copy"); c.textContent = "Copied"; setTimeout(function () { c.textContent = "Copy"; }, 1200);
    });
  });

  // first paint
  $("input").value = JSON.stringify(SAMPLES.optional, null, 2);
  run();
})();
