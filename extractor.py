import base64
import json
import re
from pathlib import Path
from typing import Any, Optional, Union

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

import anthropic

client = anthropic.AsyncAnthropic()

SYSTEM_PROMPT = (
    "You are a precise document analysis assistant. "
    "Return ONLY a valid JSON object — no markdown fences, no commentary, no trailing text."
)


# ── Field extraction ──────────────────────────────────────────────────────────

def _format_field_instruction(field) -> str:
    ftype, name, prompt = field.type, field.name, field.prompt
    if ftype == "text":
        return f'"{name}": {prompt or f"Extract the value of {name}."}'
    if ftype == "list":
        desc = (prompt + " " if prompt else "") + "Return as a JSON array of strings."
        return f'"{name}" (list): {desc}'
    if ftype == "table":
        desc = (prompt + " " if prompt else "") + "Return as a JSON array of objects (one per row)."
        return f'"{name}" (table): {desc}'
    if ftype == "reasoning":
        desc = prompt or f"Analyze and explain the {name} from the document."
        return f'"{name}" (reasoning): {desc}  Return your full analysis as a string.'
    return f'"{name}": {prompt or "Extract as appropriate."}'


def _normalize(raw_val: Any, field_type: str) -> Any:
    if field_type in ("list", "table") and isinstance(raw_val, str):
        try:
            return json.loads(_strip_fences(raw_val))
        except json.JSONDecodeError:
            pass
    return raw_val


def _image_blocks(path: Path) -> list:
    media_type = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    data = base64.standard_b64encode(path.read_bytes()).decode("utf-8")
    return [{"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}}]


def _build_extraction_prompt(doc_content: Optional[str], fields: list) -> str:
    instructions = "\n".join(f"{i+1}. {_format_field_instruction(f)}" for i, f in enumerate(fields))
    example = ", ".join(f'"{f.name}": {{"value": ..., "confidence": 0.95}}' for f in fields)
    doc_part = "Document: [see image above]" if doc_content is None else f"Document:\n---\n{doc_content}\n---"
    return (
        f"{doc_part}\n\n"
        "Extract the following fields. For each field return an object with:\n"
        '  "value": the extracted data\n'
        '  "confidence": your confidence as a float 0.0–1.0\n\n'
        f"Fields:\n{instructions}\n\n"
        f"Return a single JSON object: {{{example}}}"
    )


def _strip_fences(text: str) -> str:
    return re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE)



async def _call_claude(content: Union[str, list], use_thinking: bool = False) -> str:
    kwargs: dict = {
        "model": "claude-opus-4-8",
        "max_tokens": 8192,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": content}],
        "output_config": {"effort": "high"},
    }
    if use_thinking:
        kwargs["thinking"] = {"type": "adaptive"}
    async with client.messages.stream(**kwargs) as stream:
        message = await stream.get_final_message()
    return "".join(block.text for block in message.content if block.type == "text")


async def extract_fields(doc_content: Optional[str], fields: list, image_path: Optional[Path] = None) -> "dict[str, Any]":
    use_thinking = any(f.type == "reasoning" for f in fields)
    prompt_text = _build_extraction_prompt(doc_content, fields)
    content = _image_blocks(image_path) + [{"type": "text", "text": prompt_text}] if image_path else prompt_text
    raw = await _call_claude(content, use_thinking=use_thinking)

    try:
        parsed: dict = json.loads(_strip_fences(raw))
    except json.JSONDecodeError:
        parsed = {f.name: {"value": raw, "confidence": None} for f in fields}

    results: dict = {}
    for field in fields:
        item = parsed.get(field.name, {})
        if isinstance(item, dict) and "value" in item:
            value, confidence = _normalize(item["value"], field.type), item.get("confidence")
        else:
            value, confidence = _normalize(item, field.type), None
        results[field.name] = {"value": value, "confidence": confidence}

    for field in fields:
        if field.post_process and field.post_process_prompt:
            entry = results[field.name]
            value_str = (
                json.dumps(entry["value"]) if not isinstance(entry["value"], str) else entry["value"]
            )
            pp_prompt = (
                f'Extracted value for field "{field.name}":\n\n{value_str}\n\n---\n\n'
                f'{field.post_process_prompt}\n\nReturn only the processed result as plain text.'
            )
            pp_raw = await _call_claude(pp_prompt)
            results[field.name] = {
                "value": {"extracted": entry["value"], "processed": pp_raw.strip()},
                "confidence": entry["confidence"],
            }

    return results


async def validate_field(field_name: str, entry: Any, validate_rule: str) -> dict:
    value = entry.get("value", entry) if isinstance(entry, dict) else entry
    if isinstance(value, dict) and "processed" in value:
        value = value["processed"]
    value_str = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    prompt = (
        f'Extracted value for field "{field_name}":\n{value_str}\n\n'
        f"Validation rule: {validate_rule}\n\n"
        'Does this value pass or fail? Return ONLY JSON: '
        '{"result": "pass", "reason": "one concise sentence"} or '
        '{"result": "fail", "reason": "one concise sentence"}'
    )
    raw = await _call_claude(prompt)
    try:
        return json.loads(_strip_fences(raw))
    except json.JSONDecodeError:
        lower = raw.lower()
        return {"result": "pass" if "pass" in lower else "fail", "reason": raw.strip()}


# ── Document classification ───────────────────────────────────────────────────

async def classify_single(doc_content: Optional[str], class_name: str, prompt: Optional[str], image_path: Optional[Path] = None) -> dict:
    effective_prompt = prompt or f'Determine whether this document belongs to the class "{class_name}".'
    doc_part = "Document: [see image above]" if image_path else f"Document:\n---\n{doc_content}\n---"
    text = (
        f"{doc_part}\n\n"
        f"{effective_prompt}\n\n"
        f'If this document belongs to the class "{class_name}", return:\n'
        f'{{"class": "{class_name}", "confidence": 0.95, "reason": "one sentence"}}\n\n'
        f'If it does not belong to this class, return:\n'
        f'{{"class": "Other", "reason": "one sentence"}}\n\n'
        "Return ONLY the JSON object."
    )
    content = _image_blocks(image_path) + [{"type": "text", "text": text}] if image_path else text
    raw = await _call_claude(content)
    try:
        result = json.loads(_strip_fences(raw))
        if result.get("class") == "Other":
            result.pop("confidence", None)
        return result
    except json.JSONDecodeError:
        return {"class": "Other", "reason": raw.strip()}


async def validate_classification(classification: dict, validate_rule: str) -> dict:
    cls        = classification.get("class", "Other")
    confidence = classification.get("confidence")
    reason     = classification.get("reason", "")

    summary = f'Classification: "{cls}"'
    if confidence is not None:
        summary += f" (confidence: {round(confidence * 100)}%)"
    if reason:
        summary += f"\nReason: {reason}"

    prompt = (
        f"{summary}\n\n"
        f"Validation rule: {validate_rule}\n\n"
        'Does this classification pass or fail? Return ONLY JSON: '
        '{"result": "pass", "reason": "one concise sentence"} or '
        '{"result": "fail", "reason": "one concise sentence"}'
    )
    raw = await _call_claude(prompt)
    try:
        return json.loads(_strip_fences(raw))
    except json.JSONDecodeError:
        lower = raw.lower()
        return {"result": "pass" if "pass" in lower else "fail", "reason": raw.strip()}
