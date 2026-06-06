/* ── State ───────────────────────────────────────────────── */
let currentDoc = null;
let fieldCounter = 0;
let classCounter = 0;
let activeTab = "fields";
let currentResults = null;

/* ── DOM refs ────────────────────────────────────────────── */
const docSelect      = document.getElementById("doc-select");
const docContent     = document.getElementById("doc-content");
const fieldsList     = document.getElementById("fields-list");
const classesList    = document.getElementById("classes-list");
const addFieldBtn    = document.getElementById("add-field-btn");
const addClassBtn    = document.getElementById("add-class-btn");
const runBtn         = document.getElementById("run-btn");
const runStatus      = document.getElementById("run-status");
const resultsContent = document.getElementById("results-content");
const clearBtn       = document.getElementById("clear-btn");
const fileInput      = document.getElementById("file-input");
const deleteDocBtn   = document.getElementById("delete-doc-btn");
const uploadStatus   = document.getElementById("upload-status");

/* ── Init ────────────────────────────────────────────────── */
async function init() {
  await loadDocList();
  addField();
  initTabs();
}

/* ── Class management ────────────────────────────────────── */
function addClassCard(name = "", prompt = "", validateRule = "") {
  const card = document.createElement("div");
  card.className = "field-card";

  card.innerHTML = `
    <div class="field-row">
      <input type="text" class="class-name" placeholder="Class name…" value="${escHtml(name)}" />
      <button class="remove-field-btn" title="Delete class">&#128465;</button>
    </div>
    <div class="field-label" style="margin-bottom:4px">Classification Prompt</div>
    <textarea class="field-textarea class-prompt" rows="3"
      placeholder="Describe how to identify this class in the document…">${escHtml(prompt)}</textarea>
    <label class="checkbox-row">
      <input type="checkbox" class="class-validate-check"${validateRule ? " checked" : ""} />
      Validation rule
    </label>
    <div class="class-validate-area${validateRule ? "" : " hidden"}">
      <div class="field-label" style="margin-bottom:4px">Validation rule</div>
      <textarea class="field-textarea class-validate-textarea"
        placeholder="Rule to validate this classification result…">${escHtml(validateRule)}</textarea>
    </div>`;

  const vCheck = card.querySelector(".class-validate-check");
  const vArea  = card.querySelector(".class-validate-area");
  vCheck.addEventListener("change", () => {
    vArea.classList.toggle("hidden", !vCheck.checked);
    if (!vCheck.checked) card.querySelector(".class-validate-textarea").value = "";
  });

  card.querySelector(".remove-field-btn").addEventListener("click", () => card.remove());
  classesList.appendChild(card);
}

addClassBtn.addEventListener("click", () => addClassCard());

function gatherClasses() {
  return Array.from(classesList.querySelectorAll(".field-card")).map(card => ({
    name: card.querySelector(".class-name").value.trim(),
    prompt: card.querySelector(".class-prompt").value.trim(),
    validate_rule: card.querySelector(".class-validate-check").checked
      ? (card.querySelector(".class-validate-textarea").value.trim() || null)
      : null,
  }));
}

/* ── Tabs ────────────────────────────────────────────────── */
function initTabs() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach(p => p.classList.add("hidden"));
      tab.classList.add("active");
      document.getElementById(`tab-${tab.dataset.tab}`).classList.remove("hidden");
      activeTab = tab.dataset.tab;
      runBtn.textContent = activeTab === "classes" ? "▶ Run Classification" : "▶ Run Extraction";
      if (currentResults) showResults(currentResults);
    });
  });
}

/* ── Document list ───────────────────────────────────────── */
async function loadDocList(selectName = null) {
  const docs = await apiFetch("/api/docs");
  const toSelect = selectName || currentDoc;
  docSelect.innerHTML = '<option value="">— select a document —</option>';
  docs.forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === toSelect) opt.selected = true;
    docSelect.appendChild(opt);
  });
}

docSelect.addEventListener("change", async () => {
  currentDoc = docSelect.value || null;
  runBtn.disabled = !currentDoc;
  deleteDocBtn.disabled = !currentDoc;

  if (!currentDoc) {
    docContent.className = "doc-content";
    docContent.innerHTML = '<span class="placeholder">Select a document to view its contents.</span>';
    showResults(null);
    return;
  }

  const ext = currentDoc.split(".").pop().toLowerCase();
  const isPdf   = ext === "pdf";
  const isImage = ["jpg", "jpeg", "png"].includes(ext);
  const rawUrl  = `/api/docs/${encodeURIComponent(currentDoc)}/raw`;

  if (isPdf) {
    docContent.className = "doc-content is-pdf";
    docContent.innerHTML = "";
    const embed = document.createElement("embed");
    embed.src  = rawUrl + "#navpanes=0";
    embed.type = "application/pdf";
    docContent.appendChild(embed);
  } else if (isImage) {
    docContent.className = "doc-content is-image";
    docContent.innerHTML = "";
    const img = document.createElement("img");
    img.src = rawUrl;
    img.alt = currentDoc;
    docContent.appendChild(img);
  } else {
    docContent.className = "doc-content";
    docContent.textContent = "Loading…";
    const data = await apiFetch(`/api/docs/${encodeURIComponent(currentDoc)}`);
    docContent.textContent = data.content;
  }

  const saved = await apiFetch(`/api/results/${encodeURIComponent(currentDoc)}`);

  // Always reset fields and classes when document changes
  fieldsList.innerHTML = "";
  fieldCounter = 0;
  classesList.innerHTML = "";

  if (saved && saved.fields && saved.fields.length > 0) {
    saved.fields.forEach(f => addField(
      f.name, f.type, f.prompt || "",
      f.post_process, f.post_process_prompt || "",
      f.validate_rule || ""
    ));
  } else {
    addField();
  }

  if (saved && saved.classes && saved.classes.length > 0) {
    saved.classes.forEach(c => addClassCard(c.name, c.prompt || "", c.validate_rule || ""));
  }

  currentResults = saved;
  showResults(saved);
});

/* ── Upload document ─────────────────────────────────────── */
fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileInput.value = "";
  setUploadStatus("loading", `<span class="spinner"></span>${file.name}`);
  try {
    const form = new FormData();
    form.append("file", file);
    const result = await apiFetch("/api/docs", { method: "POST", body: form });
    setUploadStatus("success", `&#10003; ${result.filename}`);
    await loadDocList(result.filename);
    docSelect.value = result.filename;
    docSelect.dispatchEvent(new Event("change"));
    setTimeout(() => setUploadStatus("", ""), 3000);
  } catch (err) {
    setUploadStatus("error", `Error: ${err.message}`);
  }
});

function setUploadStatus(type, html) {
  if (!type) { uploadStatus.className = "upload-status hidden"; return; }
  uploadStatus.className = `upload-status ${type}`;
  uploadStatus.innerHTML = html;
}

/* ── Delete document ─────────────────────────────────────── */
deleteDocBtn.addEventListener("click", async () => {
  if (!currentDoc) return;
  if (!confirm(`Delete "${currentDoc}"?\nThis will also remove saved results.`)) return;
  try {
    await apiFetch(`/api/docs/${encodeURIComponent(currentDoc)}`, { method: "DELETE" });
    currentDoc = null;
    runBtn.disabled = true;
    deleteDocBtn.disabled = true;
    docContent.innerHTML = '<span class="placeholder">Select a document to view its contents.</span>';
    showResults(null);
    await loadDocList();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
});

/* ── Field management ────────────────────────────────────── */
function addField(
  name = "", type = "text", prompt = "",
  postProcess = false, postPrompt = "", validateRule = ""
) {
  ++fieldCounter;
  const card = document.createElement("div");
  card.className = "field-card";

  card.innerHTML = `
    <div class="field-row">
      <input type="text" class="field-name" placeholder="Field name…" value="${escHtml(name)}" />
      <select class="field-type">
        <option value="text"${type==="text"?" selected":""}>Text</option>
        <option value="list"${type==="list"?" selected":""}>List</option>
        <option value="table"${type==="table"?" selected":""}>Table</option>
        <option value="reasoning"${type==="reasoning"?" selected":""}>Reasoning</option>
      </select>
      <button class="remove-field-btn" title="Delete field">&#128465;</button>
    </div>
    <div class="field-label" style="margin-bottom:4px">Prompt</div>
    <textarea class="field-textarea prompt-textarea" rows="2"
      placeholder="Describe what to extract…">${escHtml(prompt)}</textarea>
    <label class="checkbox-row">
      <input type="checkbox" class="post-process-check"${postProcess?" checked":""} />
      Post-process result
    </label>
    <div class="post-process-area${postProcess?"":" hidden"}">
      <div class="field-label" style="margin-bottom:4px">Post-process prompt</div>
      <textarea class="field-textarea post-process-textarea" placeholder="Instructions for transforming the extracted value…">${escHtml(postPrompt)}</textarea>
    </div>
    <label class="checkbox-row">
      <input type="checkbox" class="validate-check"${validateRule?" checked":""} />
      Validation rule
    </label>
    <div class="validate-area${validateRule?"":" hidden"}">
      <div class="field-label" style="margin-bottom:4px">Validation rule</div>
      <textarea class="field-textarea validate-textarea" placeholder="Rule to test this field's extracted value…">${escHtml(validateRule)}</textarea>
    </div>`;

  const ppCheck = card.querySelector(".post-process-check");
  const ppArea  = card.querySelector(".post-process-area");
  ppCheck.addEventListener("change", () => ppArea.classList.toggle("hidden", !ppCheck.checked));

  const vCheck = card.querySelector(".validate-check");
  const vArea  = card.querySelector(".validate-area");
  vCheck.addEventListener("change", () => {
    vArea.classList.toggle("hidden", !vCheck.checked);
    if (!vCheck.checked) card.querySelector(".validate-textarea").value = "";
  });

  card.querySelector(".remove-field-btn").addEventListener("click", () => card.remove());
  fieldsList.appendChild(card);
}

addFieldBtn.addEventListener("click", () => addField());

/* ── Gather helpers ──────────────────────────────────────── */
function gatherFields() {
  return Array.from(fieldsList.querySelectorAll(".field-card")).map(card => ({
    name: card.querySelector(".field-name").value.trim(),
    type: card.querySelector(".field-type").value,
    prompt: card.querySelector(".prompt-textarea").value.trim() || null,
    post_process: card.querySelector(".post-process-check").checked,
    post_process_prompt: card.querySelector(".post-process-textarea").value.trim() || null,
    validate_rule: card.querySelector(".validate-check").checked
      ? (card.querySelector(".validate-textarea").value.trim() || null)
      : null,
  }));
}

/* ── Change detection ────────────────────────────────────── */
function getChangedFieldNames(currentFields, savedFields) {
  const savedMap = {};
  (savedFields || []).forEach(f => { savedMap[f.name] = f; });
  return currentFields
    .filter(curr => {
      const prev = savedMap[curr.name];
      if (!prev) return true;
      return curr.type !== prev.type
        || (curr.prompt || "") !== (prev.prompt || "")
        || curr.post_process !== prev.post_process
        || (curr.post_process_prompt || "") !== (prev.post_process_prompt || "");
    })
    .map(f => f.name);
}

function isClassificationUnchanged(currentClasses, savedData) {
  if (!savedData || !savedData.classification_results) return false;
  const savedClasses = savedData.classes || [];
  if (currentClasses.length !== savedClasses.length) return false;
  return currentClasses.every((c, i) => {
    const prev = savedClasses[i];
    return prev && c.name === prev.name && c.prompt === prev.prompt;
  });
}

/* ── Extraction ──────────────────────────────────────────── */
runBtn.addEventListener("click", async () => {
  if (!currentDoc) return;

  const saved = await apiFetch(`/api/results/${encodeURIComponent(currentDoc)}`).catch(() => null);
  let body;

  if (activeTab === "classes") {
    const classes = gatherClasses();
    if (!classes.length) { setStatus("error", "Add at least one class."); return; }
    if (classes.some(c => !c.name)) { setStatus("error", "All classes need a name."); return; }
    const skipClassification = isClassificationUnchanged(classes, saved);

    body = {
      document: currentDoc,
      fields: (saved?.fields || []),
      fields_to_extract: [],
      cached_results: saved?.results || {},
      classes,
      skip_classification: skipClassification,
      cached_classification_results: saved?.classification_results || null,
    };
  } else {
    const fields = gatherFields();
    if (!fields.length) { setStatus("error", "Add at least one field."); return; }
    if (fields.some(f => !f.name)) { setStatus("error", "All fields need a name."); return; }

    let fieldsToExtract = null;
    let cachedResults = null;
    if (saved && saved.results) {
      const changed = getChangedFieldNames(fields, saved.fields || []);
      cachedResults = saved.results;
      fieldsToExtract = changed.length === 0 ? [] : changed;
    }

    body = {
      document: currentDoc,
      fields,
      classes: null,                             // skip classification
      ...(fieldsToExtract !== null && { fields_to_extract: fieldsToExtract, cached_results: cachedResults }),
    };
  }

  runBtn.disabled = true;
  setStatus("loading", `<span class="spinner"></span>${activeTab === "classes" ? "Classifying…" : "Extracting fields…"}`);
  showResults(null, true);

  try {
    const result = await apiFetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    currentResults = result;
    setStatus("success", "Done.");
    showResults(result);
  } catch (err) {
    setStatus("error", `Error: ${err.message}`);
    showResults(null);
  } finally {
    runBtn.disabled = false;
  }
});

/* ── Clear results ───────────────────────────────────────── */
clearBtn.addEventListener("click", async () => {
  if (!currentDoc) return;
  await apiFetch(`/api/results/${encodeURIComponent(currentDoc)}`, { method: "DELETE" });
  currentResults = null;
  showResults(null);
  setStatus("", "");
});

/* ── Render results ──────────────────────────────────────── */
function showResults(data, loading = false) {
  if (loading) {
    resultsContent.innerHTML = '<span class="placeholder"><span class="spinner"></span>Running…</span>';
    return;
  }
  if (!data) {
    resultsContent.innerHTML = '<span class="placeholder">Run extraction to see results.</span>';
    return;
  }

  let html = "";

  if (activeTab === "classes") {
    if (data.classification_results && data.classification_results.length) {
      html = renderClassificationResults(data.classes || [], data.classification_results);
    } else {
      html = '<span class="placeholder">Run Classification to see results.</span>';
    }
  } else {
    if (data.results && data.fields && data.fields.length) {
      html = data.fields.map(f => renderResultItem(f, data.results[f.name])).join("");
    } else {
      html = '<span class="placeholder">Run Extraction to see results.</span>';
    }
  }

  resultsContent.innerHTML = html || '<span class="placeholder">No results.</span>';
}

function renderClassificationResults(classes, results) {
  return results.map((result, i) => {
    const cls     = classes[i] || {};
    const isOther = result.class === "Other";
    const hasConf = !isOther && result.confidence != null;

    return `
      <div class="result-item">
        <div class="result-header">
          <span class="result-field-name">${escHtml(cls.name || result.class)}</span>
          <span class="result-type-badge">class</span>
          ${hasConf ? renderConfidence(result.confidence) : ""}
        </div>
        <div class="result-body">
          <div class="${isOther ? "class-no-match" : "class-match"}">
            ${isOther ? "&#10007; Other" : `&#10003; ${escHtml(result.class)}`}
          </div>
          ${result.reason ? `<div class="classification-reason" style="margin-top:5px">${escHtml(result.reason)}</div>` : ""}
          ${result.validation ? renderFieldValidation(result.validation) : ""}
        </div>
      </div>`;
  }).join("");
}

function renderResultItem(field, entry) {
  let value, confidence, validation;
  if (entry && typeof entry === "object" && "value" in entry) {
    value = entry.value; confidence = entry.confidence; validation = entry.validation || null;
  } else {
    value = entry; confidence = null; validation = null;
  }

  let bodyHtml;
  if (value && typeof value === "object" && "extracted" in value && "processed" in value) {
    bodyHtml = `
      <div class="result-section-label">Extracted</div>
      ${renderValue(field.type, value.extracted)}
      <div class="result-section-label">Post-processed</div>
      <div>${escHtml(String(value.processed))}</div>`;
  } else {
    bodyHtml = renderValue(field.type, value);
  }

  return `
    <div class="result-item">
      <div class="result-header">
        <span class="result-field-name">${escHtml(field.name)}</span>
        <span class="result-type-badge">${escHtml(field.type)}</span>
        ${confidence != null ? renderConfidence(confidence) : ""}
      </div>
      <div class="result-body">
        ${bodyHtml}
        ${validation ? renderFieldValidation(validation) : ""}
      </div>
    </div>`;
}

function renderFieldValidation(v) {
  if (!v || !v.result) return "";
  const isPass = v.result.toLowerCase() === "pass";
  return `
    <div class="field-validation">
      <span class="field-validation-verdict ${isPass ? "pass" : "fail"}">${isPass ? "&#10003;" : "&#10007;"} ${isPass ? "Pass" : "Fail"}</span>
    </div>`;
}


function renderConfidence(score) {
  const pct   = Math.round(score * 100);
  const color = score >= 0.9 ? "var(--green)"
    : score >= 0.7 ? "var(--yellow)"
    : score >= 0.5 ? "#ed8936"
    : "var(--danger)";
  return `
    <div class="confidence-wrap">
      <div class="confidence-bar-track">
        <div class="confidence-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <span class="confidence-pct" style="color:${color}">${pct}%</span>
    </div>`;
}

function renderValue(type, value) {
  if (value === null || value === undefined) return '<span style="color:var(--text-dim)">—</span>';
  if (type === "table" && Array.isArray(value) && value.length > 0) {
    const keys  = Object.keys(value[0]);
    const thead = `<tr>${keys.map(k => `<th>${escHtml(k)}</th>`).join("")}</tr>`;
    const tbody = value.map(row =>
      `<tr>${keys.map(k => `<td>${escHtml(String(row[k] ?? ""))}</td>`).join("")}</tr>`
    ).join("");
    return `<table class="result-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
  }
  if (type === "list" && Array.isArray(value)) {
    return `<ul class="result-list">${value.map(i => `<li>${escHtml(String(i))}</li>`).join("")}</ul>`;
  }
  if (typeof value === "object") {
    return `<pre style="font-family:monospace;font-size:11.5px;white-space:pre-wrap;color:#c9d1e0">${escHtml(JSON.stringify(value, null, 2))}</pre>`;
  }
  return `<div>${escHtml(String(value))}</div>`;
}

/* ── Helpers ─────────────────────────────────────────────── */
function setStatus(type, html) {
  if (!type) { runStatus.className = "run-status hidden"; return; }
  runStatus.className = `run-status ${type}`;
  runStatus.innerHTML = html;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function apiFetch(url, options = {}) {
  const resp = await fetch(url, options);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/* ── Boot ────────────────────────────────────────────────── */
init();
