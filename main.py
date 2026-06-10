import asyncio
import json
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from extractor import classify_single, extract_fields, validate_classification, validate_field

DOCS_DIR = Path("docs")
RESULTS_DIR = Path("results")
CLASSES_FILE = Path("classes.json")
DOCS_DIR.mkdir(exist_ok=True)
RESULTS_DIR.mkdir(exist_ok=True)

ALLOWED_EXTENSIONS = {".txt", ".md", ".csv", ".json", ".pdf", ".jpg", ".jpeg", ".png"}
IMAGE_EXTENSIONS   = {".jpg", ".jpeg", ".png"}

app = FastAPI(title="Doc Extractor")


# ── Models ────────────────────────────────────────────────────────────────────

class FieldDefinition(BaseModel):
    name: str
    type: str
    prompt: Optional[str] = None
    post_process: bool = False
    post_process_prompt: Optional[str] = None
    validate_rule: Optional[str] = None


class ClassDefinition(BaseModel):
    name: str
    prompt: Optional[str] = None
    validate_rule: Optional[str] = None


class ExtractionRequest(BaseModel):
    document: str
    # Fields
    fields: List[FieldDefinition]
    fields_to_extract: Optional[List[str]] = None   # None=all, []=none
    cached_results: Optional[dict] = None
    # Classification
    classes: Optional[List[ClassDefinition]] = None
    skip_classification: bool = False
    cached_classification_results: Optional[List[dict]] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def read_doc_content(path: Path) -> str:
    if path.suffix.lower() == ".pdf":
        try:
            from pypdf import PdfReader
            reader = PdfReader(str(path))
            pages = [page.extract_text() or "" for page in reader.pages]
            return "\n\n".join(p for p in pages if p.strip())
        except ImportError:
            raise HTTPException(400, "PDF support requires: pip install pypdf")
    return path.read_text(encoding="utf-8")


# ── Class endpoints ───────────────────────────────────────────────────────────

@app.get("/api/classes")
async def get_classes():
    if not CLASSES_FILE.exists():
        return []
    return json.loads(CLASSES_FILE.read_text())


@app.put("/api/classes")
async def save_classes(classes: List[ClassDefinition]):
    CLASSES_FILE.write_text(
        json.dumps([c.model_dump() for c in classes], indent=2, ensure_ascii=False)
    )
    return {"status": "saved"}


# ── Document endpoints ────────────────────────────────────────────────────────

@app.get("/api/docs")
async def list_docs():
    return sorted(f.name for f in DOCS_DIR.iterdir() if f.is_file())


@app.post("/api/docs")
async def upload_doc(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(400, "No filename provided")
    safe_name = Path(file.filename).name
    if Path(safe_name).suffix.lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported type. Allowed: {', '.join(ALLOWED_EXTENSIONS)}")
    (DOCS_DIR / safe_name).write_bytes(await file.read())
    return {"filename": safe_name}


@app.delete("/api/docs/{filename}")
async def delete_doc(filename: str):
    path = DOCS_DIR / filename
    if not path.exists():
        raise HTTPException(404, "Document not found")
    path.unlink()
    result_path = RESULTS_DIR / f"{filename}.json"
    if result_path.exists():
        result_path.unlink()
    return {"status": "deleted"}


@app.get("/api/docs/{filename}/raw")
async def get_doc_raw(filename: str):
    path = DOCS_DIR / filename
    if not path.exists():
        raise HTTPException(404, "Document not found")
    content_types = {
        ".pdf":  "application/pdf",
        ".jpg":  "image/jpeg", ".jpeg": "image/jpeg",
        ".png":  "image/png",
        ".txt":  "text/plain", ".md":   "text/plain",
        ".csv":  "text/csv",   ".json": "application/json",
    }
    media_type = content_types.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(str(path), media_type=media_type)


@app.get("/api/docs/{filename}")
async def get_doc(filename: str):
    path = DOCS_DIR / filename
    if not path.exists():
        raise HTTPException(404, "Document not found")
    return {"content": read_doc_content(path)}


# ── Extraction endpoint ───────────────────────────────────────────────────────

@app.post("/api/extract")
async def run_extraction(request: ExtractionRequest):
    doc_path = DOCS_DIR / request.document
    if not doc_path.exists():
        raise HTTPException(404, "Document not found")

    cached   = request.cached_results or {}
    is_image = doc_path.suffix.lower() in IMAGE_EXTENSIONS

    # ── Field extraction ──────────────────────────────────────────────────────
    if request.fields_to_extract is not None and len(request.fields_to_extract) == 0:
        results = dict(cached)
    else:
        subset = (
            [f for f in request.fields if f.name in request.fields_to_extract]
            if request.fields_to_extract is not None
            else request.fields
        )
        new_results = await extract_fields(
            None if is_image else read_doc_content(doc_path),
            subset,
            image_path=doc_path if is_image else None,
        )
        results = {**cached, **new_results}

    # Drop results for removed fields
    active_names = {f.name for f in request.fields}
    results = {k: v for k, v in results.items() if k in active_names}

    # Clear stale validation for fields whose rule was removed
    for field in request.fields:
        if not field.validate_rule and field.name in results:
            entry = results[field.name]
            if isinstance(entry, dict):
                entry.pop("validation", None)

    # Per-field validation (concurrent)
    fields_to_validate = [f for f in request.fields if f.validate_rule and f.name in results]
    if fields_to_validate:
        validations = await asyncio.gather(*[
            validate_field(f.name, results[f.name], f.validate_rule)
            for f in fields_to_validate
        ])
        for field, v in zip(fields_to_validate, validations):
            entry = results[field.name]
            if isinstance(entry, dict):
                entry["validation"] = v
            else:
                results[field.name] = {"value": entry, "confidence": None, "validation": v}

    # ── Classification (one call per card, all concurrent) ────────────────────
    classification_results: List[dict] = []

    if request.classes:
        if request.skip_classification and request.cached_classification_results:
            # Reuse cached extraction results; still re-run validation
            raw_results = [dict(r) for r in request.cached_classification_results]
            for r in raw_results:
                r.pop("validation", None)
        else:
            if is_image:
                raw_results = list(await asyncio.gather(*[
                    classify_single(None, c.name, c.prompt, image_path=doc_path)
                    for c in request.classes
                ]))
            else:
                doc_content = read_doc_content(doc_path)
                raw_results = list(await asyncio.gather(*[
                    classify_single(doc_content, c.name, c.prompt)
                    for c in request.classes
                ]))

        # Per-card validation (concurrent)
        needs_validation = [(i, c) for i, c in enumerate(request.classes) if c.validate_rule]
        if needs_validation:
            validations = await asyncio.gather(*[
                validate_classification(raw_results[i], c.validate_rule)
                for i, c in needs_validation
            ])
            for (i, _), v in zip(needs_validation, validations):
                raw_results[i]["validation"] = v

        classification_results = raw_results

    # ── Save & return ─────────────────────────────────────────────────────────
    # Preserve classes/classification_results from existing save when not updated
    result_path = RESULTS_DIR / f"{request.document}.json"
    existing = {}
    if result_path.exists():
        try:
            existing = json.loads(result_path.read_text())
        except Exception:
            pass

    payload = {
        "document": request.document,
        "fields": [f.model_dump() for f in request.fields],
        "results": results,
        "classes": [c.model_dump() for c in request.classes] if request.classes is not None else existing.get("classes", []),
        "classification_results": classification_results if request.classes is not None else existing.get("classification_results", []),
    }

    (RESULTS_DIR / f"{request.document}.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False)
    )
    return payload


# ── Results endpoints ─────────────────────────────────────────────────────────

@app.get("/api/results/{filename}")
async def get_results(filename: str):
    path = RESULTS_DIR / f"{filename}.json"
    if not path.exists():
        return JSONResponse(None)
    return json.loads(path.read_text())


@app.delete("/api/results/{filename}")
async def clear_results(filename: str):
    path = RESULTS_DIR / f"{filename}.json"
    if path.exists():
        path.unlink()
    return {"status": "cleared"}


@app.delete("/api/results")
async def clear_all_results():
    for path in RESULTS_DIR.glob("*.json"):
        path.unlink()
    return {"status": "cleared"}


# ── Static files ──────────────────────────────────────────────────────────────
app.mount("/", StaticFiles(directory="static", html=True), name="static")
