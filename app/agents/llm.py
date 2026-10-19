"""One async Gemini client with interchangeable back ends.

Providers (env GEMBA_LLM, default "auto"):
- vertex   Gemini on Google's Gemini Enterprise Agent Platform (formerly Vertex AI) via google-genai, service-account auth
           (Application Default Credentials). The deployed Cloud Run service uses this.
- aistudio Gemini API with an API key (GEMINI_API_KEY), via google-genai.
- gateway  Our own LLM gateway (LLM_GATEWAY_URL + LLM_INTERNAL_KEY + LLM_API_KEY + LLM_PROVIDER) that serves Gemini
           models; any reply from a non-Gemini model is rejected, never shown.
- mock     No model at all: callers fall back to their rules engine and label the output.

Messages use one neutral shape: {"role": system|user|assistant|tool, "content": str | [parts], "tool_calls": [...],
"tool_call_id", "name"}. Image or audio parts: {"type": "image"|"audio", "mime": ..., "data": base64}.
Tools: [{"name", "description", "parameters": JSON schema}].
"""
import asyncio
import base64
import json
import os
import time
import uuid
from dataclasses import dataclass, field

import httpx


class LLMError(RuntimeError):
    pass


@dataclass
class LLMResult:
    content: str = ""
    tool_calls: list = field(default_factory=list)     # [{"id", "name", "args"}]
    provider: str = ""
    model: str = ""
    ms: int = 0
    raw: object = None                                 # provider-native assistant turn (keeps Gemini thought signatures)
    usage: dict = field(default_factory=dict)


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def chain() -> list:
    """Providers in the order they are tried. GEMBA_LLM may list several, e.g. "gateway,aistudio"."""
    raw = _env("GEMBA_LLM", "auto").lower()
    if raw != "auto":
        out = [p.strip() for p in raw.split(",") if p.strip()]
    else:
        out = []
        if _env("GOOGLE_CLOUD_PROJECT") and (_env("K_SERVICE") or _env("GEMBA_USE_VERTEX")):
            out.append("vertex")
        if _env("LLM_INTERNAL_KEY") and _env("LLM_API_KEY"):
            out.append("gateway")
    if "aistudio" not in out and _env("GEMINI_API_KEY") and "mock" not in out:
        out.append("aistudio")            # a direct Gemini API key is always the backup when present
    return out or ["mock"]


def provider() -> str:
    return chain()[0]


# Last success / failure per provider, so the UI can say honestly when the model is unavailable.
STATUS: dict = {}


def _mark(p: str, ok: bool, err: str = ""):
    st = STATUS.setdefault(p, {"ok_at": None, "fail_at": None, "error": ""})
    if ok:
        st["ok_at"] = time.time()
    else:
        st["fail_at"], st["error"] = time.time(), err[:200]


def available() -> bool:
    """False when every provider's latest call failed (and none succeeded since)."""
    if provider() == "mock":
        return False
    for p in chain():
        st = STATUS.get(p)
        if not st or not st["fail_at"] or (st["ok_at"] and st["ok_at"] > st["fail_at"]):
            return True
        if time.time() - st["fail_at"] > 300:      # retry after 5 minutes
            return True
    return False


def model_for(role: str, prov: str | None = None) -> str:
    """role: agent | lead | vision | voice. The gateway only exposes gemini-3-flash."""
    if (prov or provider()) == "gateway":
        return _env("GEMBA_GATEWAY_MODEL", "gemini-3-flash")
    defaults = {"agent": "gemini-3.8-flash", "lead": "gemini-4-argon", "vision": "gemini-3.8-flash", "voice": "gemini-3.8-flash"}
    return _env(f"GEMBA_MODEL_{role.upper()}", defaults.get(role, "gemini-3.8-flash"))


LABELS = {"vertex": "Gemini on Google Cloud Agent Platform", "aistudio": "Gemini API (Google AI Studio)",
          "gateway": "Google Gemini", "mock": "No model configured: rules engine"}


def describe() -> dict:
    p = provider()
    return {"provider": p, "chain": chain(), "available": available(),
            "models": {r: model_for(r) for r in ("agent", "lead", "vision", "voice")} if p != "mock" else {},
            "status": {k: {"ok_at": v["ok_at"], "fail_at": v["fail_at"], "error": v["error"]} for k, v in STATUS.items()},
            "label": LABELS.get(p, p)}


# ----------------------------------------------------------------------------------------------- google-genai

_GENAI = {}


def _genai_client(prov: str):
    if prov not in _GENAI:
        from google import genai
        if prov == "vertex":
            _GENAI[prov] = genai.Client(vertexai=True, project=_env("GOOGLE_CLOUD_PROJECT"),
                                        location=_env("GOOGLE_CLOUD_LOCATION", "global"))
        else:
            _GENAI[prov] = genai.Client(api_key=_env("GEMINI_API_KEY"))
    return _GENAI[prov]


def _genai_parts(content):
    from google.genai import types
    if isinstance(content, str):
        return [types.Part(text=content)]
    parts = []
    for p in content or []:
        if p.get("type") == "text":
            parts.append(types.Part(text=p["text"]))
        elif p.get("type") in ("image", "audio"):
            parts.append(types.Part(inline_data=types.Blob(mime_type=p["mime"], data=base64.b64decode(p["data"]))))
    return parts


async def _genai_chat(messages, tools, role, temperature, json_schema, prov="aistudio") -> LLMResult:
    from google.genai import types
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    contents = []
    for m in messages:
        if m["role"] == "user":
            contents.append(types.Content(role="user", parts=_genai_parts(m["content"])))
        elif m["role"] == "assistant":
            if m.get("raw") is not None:
                contents.append(m["raw"])
            else:
                parts = [types.Part(text=m["content"])] if m.get("content") else []
                parts += [types.Part(function_call=types.FunctionCall(name=tc["name"], args=tc["args"])) for tc in m.get("tool_calls", [])]
                contents.append(types.Content(role="model", parts=parts))
        elif m["role"] == "tool":
            part = types.Part(function_response=types.FunctionResponse(name=m["name"], response={"result": m["content"]}))
            if contents and contents[-1].role == "user" and contents[-1].parts and contents[-1].parts[0].function_response:
                contents[-1].parts.append(part)       # parallel tool results go back in one turn
            else:
                contents.append(types.Content(role="user", parts=[part]))
    cfg = dict(system_instruction=system or None, temperature=temperature)
    if tools:
        cfg["tools"] = [types.Tool(function_declarations=[
            types.FunctionDeclaration(name=t["name"], description=t["description"], parameters_json_schema=t["parameters"])
            for t in tools])]
        cfg["automatic_function_calling"] = types.AutomaticFunctionCallingConfig(disable=True)
    if json_schema and not tools:
        cfg["response_mime_type"] = "application/json"
        cfg["response_json_schema"] = json_schema
    model = model_for(role, prov)
    if role == "lead" and "argon" in model:
        cfg["thinking_config"] = types.ThinkingConfig(thinking_level=_env("GEMBA_LEAD_THINKING", "LOW"))
    t = time.time()
    resp = await _genai_client(prov).aio.models.generate_content(model=model, contents=contents,
                                                                 config=types.GenerateContentConfig(**cfg))
    cand = resp.candidates[0] if resp.candidates else None
    out = LLMResult(provider=prov, model=model, ms=int(1000 * (time.time() - t)), raw=cand.content if cand else None)
    for p in (cand.content.parts if cand and cand.content and cand.content.parts else []):
        if p.function_call:
            out.tool_calls.append({"id": p.function_call.id or uuid.uuid4().hex[:8], "name": p.function_call.name,
                                   "args": dict(p.function_call.args or {})})
        elif p.text and not p.thought:
            out.content += p.text
    um = resp.usage_metadata
    if um:
        out.usage = {"in": um.prompt_token_count, "out": um.candidates_token_count}
    return out


# ----------------------------------------------------------------------------------------------- gateway

_HTTP = {}


def _http() -> httpx.AsyncClient:
    if "c" not in _HTTP:
        _HTTP["c"] = httpx.AsyncClient(timeout=httpx.Timeout(90.0, connect=10.0))
    return _HTTP["c"]


def _oa_content(content):
    if isinstance(content, str):
        return content
    out = []
    for p in content or []:
        if p.get("type") == "text":
            out.append({"type": "text", "text": p["text"]})
        elif p.get("type") == "image":
            out.append({"type": "image_url", "image_url": {"url": f"data:{p['mime']};base64,{p['data']}"}})
        elif p.get("type") == "audio":
            out.append({"type": "input_audio", "input_audio": {"data": p["data"], "format": p["mime"].split("/")[-1]}})
    return out


async def _gateway_chat(messages, tools, role, temperature, json_schema, prov="gateway") -> LLMResult:
    msgs = []
    for m in messages:
        if m["role"] == "assistant":
            d = {"role": "assistant", "content": m.get("content") or ""}
            if m.get("tool_calls"):
                d["tool_calls"] = [{"id": tc["id"], "type": "function",
                                    "function": {"name": tc["name"], "arguments": json.dumps(tc["args"])}} for tc in m["tool_calls"]]
            msgs.append(d)
        elif m["role"] == "tool":
            msgs.append({"role": "tool", "tool_call_id": m["tool_call_id"], "name": m["name"], "content": m["content"]})
        else:
            msgs.append({"role": m["role"], "content": _oa_content(m["content"])})
    body = {"messages": msgs, "api_key": _env("LLM_API_KEY"), "provider": _env("LLM_PROVIDER"),
            "model": model_for(role, "gateway"), "ref": _env("LLM_REF", "gemba-dev"), "temperature": temperature}
    if tools:
        body["tools"] = [{"type": "function", "function": t} for t in tools]
    if json_schema and not tools:
        body["response_format"] = {"type": "json_object"}
    base = _env("LLM_GATEWAY_URL")
    if not base:
        raise LLMError("LLM_GATEWAY_URL is not set")
    url = base.rstrip("/") + "/byok"
    t = time.time()
    r = await _http().post(url, headers={"X-Internal-Key": _env("LLM_INTERNAL_KEY")}, json=body)
    if r.status_code != 200:
        raise LLMError(f"gateway HTTP {r.status_code}: {r.text[:200]}")
    d = r.json()
    used = str(d.get("model") or "")
    if "gemini" not in used.lower():
        raise LLMError(f"gateway answered with a non-Gemini model ({used or 'unknown'}); rejected")
    msg = (d.get("choices") or [{}])[0].get("message") or {}
    if not (msg.get("content") or msg.get("tool_calls")):
        raise LLMError("gateway returned an empty answer")
    if not msg.get("tool_calls") and "no longer available" in (msg.get("content") or "").lower()[:200]:
        raise LLMError("model retired (gateway returned a notice instead of an answer)")
    out = LLMResult(content=msg.get("content") or "", provider="gateway", model=used, ms=int(1000 * (time.time() - t)))
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function", {})
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except json.JSONDecodeError:
            args = {}
        out.tool_calls.append({"id": tc.get("id") or uuid.uuid4().hex[:8], "name": fn.get("name"), "args": args})
    out.usage = d.get("usage") or {}
    return out


# ----------------------------------------------------------------------------------------------- public

async def chat(messages: list, tools: list | None = None, role: str = "agent", temperature: float = 0.2,
               json_schema: dict | None = None, retries: int = 1) -> LLMResult:
    """Try each provider in the chain; the first Gemini answer wins. Raises LLMError when all fail."""
    errors = []
    for p in chain():
        if p == "mock":
            continue
        st = STATUS.get(p)
        if st and st["fail_at"] and not (st["ok_at"] and st["ok_at"] > st["fail_at"]) and time.time() - st["fail_at"] < 60 \
                and len(chain()) > 1:
            errors.append(f"{p}: skipped (failed {int(time.time() - st['fail_at'])} s ago)")
            continue
        fn = _gateway_chat if p == "gateway" else _genai_chat
        for attempt in range(retries + 1):
            try:
                r = await fn(messages, tools, role, temperature, json_schema, p)
                _mark(p, True)
                return r
            except Exception as e:  # network, quota, safety block, non-Gemini fallback
                last = str(e)
                await asyncio.sleep(0.6 * (attempt + 1))
        _mark(p, False, last)
        errors.append(f"{p}: {last[:160]}")
    raise LLMError("; ".join(errors) or "no model configured")


def parse_json(text: str):
    """First JSON object in a model reply (tolerates ```json fences and prose around it)."""
    s = text.strip()
    if s.startswith("```"):
        s = s.strip("`")
        s = s[s.find("\n") + 1:] if "\n" in s else s
    i, j = s.find("{"), s.rfind("}")
    if i < 0 or j <= i:
        raise ValueError("no JSON object in reply")
    return json.loads(s[i:j + 1])
