"""Token accounting, step decoding, and file detection."""

from __future__ import annotations

import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import quote, unquote, urlparse

from .protobuf import Msg, encode_varint, iter_fields

# --- Wire & enum constants ---------------------------------------------------

# Step payload field numbers on gemini_coder.Step
STEP_CODE_ACTION = 10
STEP_VIEW_FILE = 14
STEP_USER_INPUT = 19
STEP_PLANNER_RESPONSE = 20
STEP_CHECKPOINT = 30
STEP_GENERIC = 140

# Step envelope field numbers
STEP_FIELD_TYPE = 1
STEP_FIELD_STATUS = 4
STEP_FIELD_METADATA = 5
STEP_ENVELOPE_FIELDS = (STEP_FIELD_TYPE, STEP_FIELD_STATUS, STEP_FIELD_METADATA)

# Step type enum values
STEP_TYPE_UNSPECIFIED = 0
STEP_TYPE_FINISH = 2
STEP_TYPE_VIEW_FILE = 8
STEP_TYPE_USER_INPUT = 14
STEP_TYPE_PLANNER_RESPONSE = 15
STEP_TYPE_ERROR_MESSAGE = 17
STEP_TYPE_CHECKPOINT = 23
STEP_TYPE_SYSTEM_MESSAGE = 101
STEP_TYPE_INVOKE_SUBAGENT = 127
GENERIC_TYPE = 132

# Step status enum values
STATUS_PENDING = 1
STATUS_RUNNING = 2
STATUS_DONE = 3
STEP_STATUS_ACTIVE = (STATUS_PENDING, STATUS_RUNNING)

ORIGINAL_STEP_TYPE_URL = "/gemini_coder.Step"

# Step payload & metadata field numbers
CODE_ACTION_RESULT_FIELD = 2
CODE_ACTION_EDIT_FIELD = 1
CODE_ACTION_EDIT_URI_FIELD = 8
CODE_ACTION_IS_ARTIFACT_FIELD = 21
CODE_ACTION_IS_KNOWLEDGE_FIELD = 24
VIEW_FILE_PATH_FIELD = 1
VIEW_FILE_IS_SKILL_FIELD = 17

MD_TOOL_CALL_FIELD = 4
MD_USAGE_FIELD = 9
MD_OUTPUT_TOKENS_FIELD = 23
MD_RETRY_INFO_FIELD = 28

CHECKPOINT_INDEX_FIELD = 1
CHECKPOINT_SUMMARY_ALT_FIELD = 3
CHECKPOINT_INTENT_FIELD = 4
CHECKPOINT_START_FIELD = 11
CHECKPOINT_END_FIELD = 12

# GenMetadata / Chat / Usage / ContextWindowMetadata field numbers
GEN_CHAT_FIELD = 1
CHAT_SYSTEM_PROMPT_FIELD = 1
CHAT_MESSAGES_FIELD = 2
CHAT_USAGE_FIELD = 4
CHAT_TOOLS_FIELD = 8
CHAT_START_FIELD = 9
CHAT_MODEL_ID_ALT_FIELD = 11
CHAT_SYSTEM_SECTIONS_FIELD = 16
CHAT_MODEL_ID_FIELD = 19
CHAT_MODEL_NAME_FIELD = 21

USAGE_UNCACHED_INPUT_FIELD = 2
USAGE_OUTPUT_FIELD = 3
USAGE_CACHED_INPUT_FIELD = 5
USAGE_THINKING_FIELD = 9
USAGE_RESPONSE_FIELD = 10

CHAT_START_CHECKPOINT_FIELD = 2
CHAT_START_CWM_FIELD = 10
CWM_BREAKDOWN_FIELD = 3
CWM_REQUEST_BUDGET_FIELD = 4

GEN_CHAT_FIELDS = frozenset({GEN_CHAT_FIELD})
CHAT_CONTENT_FIELDS = frozenset({
    CHAT_SYSTEM_PROMPT_FIELD,
    CHAT_MESSAGES_FIELD,
    CHAT_TOOLS_FIELD,
    CHAT_SYSTEM_SECTIONS_FIELD,
})
CHAT_SCAN_FIELDS = CHAT_CONTENT_FIELDS | {CHAT_USAGE_FIELD, CHAT_START_FIELD}
CHAT_TELEMETRY_FIELDS = frozenset({CHAT_USAGE_FIELD, CHAT_START_FIELD})
USAGE_TELEMETRY_FIELDS = frozenset({
    USAGE_UNCACHED_INPUT_FIELD,
    USAGE_OUTPUT_FIELD,
    USAGE_CACHED_INPUT_FIELD,
    USAGE_THINKING_FIELD,
})
CHAT_START_CHECKPOINT_FIELDS = frozenset({CHAT_START_CHECKPOINT_FIELD})

TOKEN_SYSTEM_PROMPT = 1
TOKEN_TOOLS = 2
TOKEN_RULES = 3
TOKEN_MCP_TOOLS = 4
TOKEN_SKILLS = 5
TOKEN_SUBAGENTS = 6
TOKEN_CHAT_MESSAGES = 7
TOKEN_WORKFLOWS = 8
TOKEN_PLUGINS = 9
TOKEN_FLOWS = 10

SYSTEM_PROMPT_SUBGROUPS = {
    "flows": TOKEN_FLOWS,
    "skills": TOKEN_SKILLS,
    "subagents": TOKEN_SUBAGENTS,
}

GROUP_LABELS = {
    TOKEN_SYSTEM_PROMPT: "System prompt",
    TOKEN_TOOLS: "System tools",
    TOKEN_RULES: "Rules",
    TOKEN_MCP_TOOLS: "MCP tools",
    TOKEN_SKILLS: "Skills",
    TOKEN_SUBAGENTS: "Subagents",
    TOKEN_CHAT_MESSAGES: "Chat messages",
    TOKEN_WORKFLOWS: "Legacy workflows",
    TOKEN_PLUGINS: "Plugins",
    TOKEN_FLOWS: "Workflows",
}

STEP_TYPES = {
    "UNSPECIFIED": 0, "DUMMY": 1, "FINISH": 2, "PLAN_INPUT": 3, "MQUERY": 4, "CODE_ACTION": 5,
    "GIT_COMMIT": 6, "GREP_SEARCH": 7, "VIEW_FILE": 8, "LIST_DIRECTORY": 9, "COMPILE": 10,
    "VIEW_CODE_ITEM": 13, "USER_INPUT": 14, "PLANNER_RESPONSE": 15, "ERROR_MESSAGE": 17,
    "RUN_COMMAND": 21, "CHECKPOINT": 23, "PROPOSE_CODE": 24, "FIND": 25, "SUGGESTED_RESPONSES": 27,
    "COMMAND_STATUS": 28, "MEMORY": 29, "READ_URL_CONTENT": 31, "VIEW_CONTENT_CHUNK": 32,
    "SEARCH_WEB": 33, "RETRIEVE_MEMORY": 34, "MCP_TOOL": 38, "MANAGER_FEEDBACK": 39,
    "TOOL_CALL_PROPOSAL": 40, "TOOL_CALL_CHOICE": 41, "TRAJECTORY_CHOICE": 42, "CLIPBOARD": 45,
    "VIEW_FILE_OUTLINE": 47, "POST_PR_REVIEW": 49, "LIST_RESOURCES": 51, "READ_RESOURCE": 52,
    "LINT_DIFF": 53, "FIND_ALL_REFERENCES": 54, "BRAIN_UPDATE": 55, "OPEN_BROWSER_URL": 56,
    "RUN_EXTENSION_CODE": 57, "PROPOSAL_FEEDBACK": 59, "TRAJECTORY_SEARCH": 60,
    "EXECUTE_BROWSER_JAVASCRIPT": 61, "LIST_BROWSER_PAGES": 62, "CAPTURE_BROWSER_SCREENSHOT": 63,
    "CLICK_BROWSER_PIXEL": 64, "READ_TERMINAL": 65, "CAPTURE_BROWSER_CONSOLE_LOGS": 66,
    "READ_BROWSER_PAGE": 67, "BROWSER_GET_DOM": 68, "CODE_SEARCH": 73, "BROWSER_INPUT": 74,
    "BROWSER_MOVE_MOUSE": 75, "BROWSER_SELECT_OPTION": 76, "BROWSER_SCROLL_UP": 77,
    "BROWSER_SCROLL_DOWN": 78, "BROWSER_CLICK_ELEMENT": 79, "BROWSER_PRESS_KEY": 80,
    "TASK_BOUNDARY": 81, "NOTIFY_USER": 82, "CODE_ACKNOWLEDGEMENT": 83, "INTERNAL_SEARCH": 84,
    "BROWSER_SUBAGENT": 85, "FILE_CHANGE": 86, "MOVE": 87, "BROWSER_SCROLL": 88,
    "KNOWLEDGE_GENERATION": 89, "EPHEMERAL_MESSAGE": 90, "GENERATE_IMAGE": 91,
    "DELETE_DIRECTORY": 92, "COMPILE_APPLET": 93, "INSTALL_APPLET_DEPENDENCIES": 94,
    "INSTALL_APPLET_PACKAGE": 95, "BROWSER_RESIZE_WINDOW": 96, "BROWSER_DRAG_PIXEL_TO_PIXEL": 97,
    "CONVERSATION_HISTORY": 98, "KNOWLEDGE_ARTIFACTS": 99, "SEND_COMMAND_INPUT": 100,
    "SYSTEM_MESSAGE": 101, "WAIT": 102, "AGENCY_TOOL_CALL": 103, "CIDER_AGENT_DUMMY": 104,
    "SHELL_EXEC": 112, "INVOKE_SUBAGENT": 127, "GENERIC": 132, "ASK_QUESTION": 138,
    "DIRECTORY_RULES": 139, "TOOL_SEARCH": 140,
}

STEP_TYPE_NAMES = {v: k for k, v in STEP_TYPES.items()}

CAT_USER, CAT_AGENT, CAT_TOOL, CAT_CHECKPOINT, CAT_SYSTEM = 0, 1, 2, 3, 4

NATIVE_CONTEXT_WINDOWS = [
    ("gemini", 1_048_576),
    ("claude-sonnet-5", 1_000_000),
    ("claude-opus-5", 1_000_000),
    ("claude-5", 1_000_000),
    ("claude-sonnet-4", 250_000),
    ("claude-opus-4", 250_000),
    ("claude-4", 250_000),
    ("claude", 200_000),
    ("gpt-oss", 131_072),
    ("gpt-4", 128_000),
    ("o3", 200_000),
    ("o4", 200_000),
]

CATEGORIES = [
    ("User messages", "user", True, "conv"),
    ("Agent responses", "agent", True, "conv"),
    ("Tool calls", "tool", True, "conv"),
    ("System prompt", "system_prompt", False, "sys"),
    ("System tools", "system_tools", False, "sys"),
    ("System overhead", "system_overhead", False, "sys"),
    ("Rules", "rules", False, "custom"),
    ("Skills", "skills", False, "custom"),
    ("Subagents", "subagents", False, "custom"),
    ("Legacy workflows", "legacy_workflows", False, "custom"),
    ("Workflows", "workflows", False, "custom"),
    ("Plugins", "plugins", False, "custom"),
    ("MCP tools", "mcp_tools", False, "custom"),
    ("System messages", "system_messages", False, "conv"),
]

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
CONV_ID_JSON_RE = re.compile(rf'"conversationId"\s*:\s*"({UUID_RE.pattern})"', re.IGNORECASE)


# --- Formatting helpers ------------------------------------------------------


def fmt_tok(n: int) -> str:
    if n >= 1_000_000:
        v = n / 1_000_000.0
        return f"{v:.0f}M" if v.is_integer() else f"{v:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000.0:.1f}k"
    return str(n)


def pct(n: int, denom: int) -> float:
    return (n / denom * 100.0) if denom > 0 else 0.0


def shorten_path(uri: str) -> str:
    p = uri
    if p.startswith("file:"):
        parsed = urlparse(p)
        p = unquote(parsed.path)
        if len(p) > 2 and p[0] == "/" and p[2] == ":":
            p = p[1:]
    home = str(Path.home()).replace("\\", "/").rstrip("/")
    p = p.replace("\\", "/")
    if home and (p == home or p.startswith(home + "/")):
        return "~" + p[len(home) :]
    return p


def step_category(step_type: int) -> int:
    if step_type == STEP_TYPE_USER_INPUT:
        return CAT_USER
    if step_type == STEP_TYPE_PLANNER_RESPONSE:
        return CAT_AGENT
    if step_type == STEP_TYPE_CHECKPOINT:
        return CAT_CHECKPOINT
    if step_type in (STEP_TYPE_UNSPECIFIED, STEP_TYPE_FINISH, STEP_TYPE_SYSTEM_MESSAGE):
        return CAT_SYSTEM
    return CAT_TOOL


def is_skill_file(path: str) -> bool:
    return path.replace("\\", "/").endswith("/SKILL.md")


# --- Step decoding & token estimation ----------------------------------------


def packed_original_step(generic: Msg) -> bytes | None:
    result = generic.msg(2)
    if result is None:
        return None
    payload = result.msg(6)
    if payload is not None and payload.str(1).endswith(ORIGINAL_STEP_TYPE_URL):
        return payload.bytes(2)
    for entry in result.msgs(5):
        if entry.str(1) == "__original_cortex_step":
            value = entry.msg(2)
            if value is not None and value.str(1).endswith(ORIGINAL_STEP_TYPE_URL):
                return value.bytes(2)
    return None


class Step:
    def __init__(self, pos: int, payload: bytes, step_type: int, status: int, metadata: bytes | None):
        self.pos = pos
        self.pb = Msg(payload)
        self.type = self.pb.int(STEP_FIELD_TYPE) if self.pb.has(STEP_FIELD_TYPE) else step_type
        self.status = self.pb.int(STEP_FIELD_STATUS) if self.pb.has(STEP_FIELD_STATUS) else status
        self.md = self.pb.msg(STEP_FIELD_METADATA) or Msg(metadata)
        self.view_file_override: Msg | None = None
        self.generic_result_text: str = ""
        if self.type == GENERIC_TYPE:
            self._rehydrate()

    def _rehydrate(self):
        generic = self.pb.msg(STEP_GENERIC)
        if generic is None:
            return
        res = generic.msg(2)
        if res is not None:
            self.generic_result_text = res.str(1)
        original = packed_original_step(generic)
        if original is not None:
            self.pb = Msg(original)
            self.type = self.pb.int(STEP_FIELD_TYPE)
            self.md = self.pb.msg(STEP_FIELD_METADATA) or self.md
            return
        tc = self.md.msg(MD_TOOL_CALL_FIELD)
        if tc is None or tc.str(2) not in ("view_file", "read_file"):
            return
        try:
            args = json.loads(tc.str(3) or "{}")
        except (json.JSONDecodeError, RecursionError):
            return
        if not isinstance(args, dict):
            return
        path = next(
            (args[k] for k in ("AbsolutePath", "Path", "FilePath") if isinstance(args.get(k), str) and args[k]),
            "",
        )
        if path:
            self.type = STEP_TYPE_VIEW_FILE
            encoded = path.encode("utf-8")
            skill_flag = (
                encode_varint((VIEW_FILE_IS_SKILL_FIELD << 3) | 0) + b"\x01"
                if is_skill_file(path)
                else b""
            )
            self.view_file_override = Msg(
                encode_varint((VIEW_FILE_PATH_FIELD << 3) | 2)
                + encode_varint(len(encoded))
                + encoded
                + skill_flag
            )

    def payload(self, fn: int) -> Msg | None:
        if fn == STEP_VIEW_FILE and self.view_file_override is not None:
            return self.view_file_override
        return self.pb.msg(fn)


def estimate_step_tokens(step: Step) -> int:
    ui = step.payload(STEP_USER_INPUT)
    pr = step.payload(STEP_PLANNER_RESPONSE)
    if ui is not None:
        n = len(ui.bytes(2))
    elif pr is not None:
        n = len(pr.bytes(1))
    else:
        tc = step.md.msg(MD_TOOL_CALL_FIELD)
        n = len(tc.bytes(3)) if tc else 0
        out = step.md.int(MD_OUTPUT_TOKENS_FIELD, signed32=True)
        if out > 0:
            return out
    return max(1, int(n / 4)) if n > 0 else 0


def step_tokens(step: Step) -> int:
    usage = step.md.msg(MD_USAGE_FIELD)
    if usage is not None:
        return usage.int(USAGE_OUTPUT_FIELD)
    return estimate_step_tokens(step)


def compaction_tokens(step: Step) -> int:
    for ri in reversed(step.md.msgs(MD_RETRY_INFO_FIELD)):
        usage = ri.msg(2)
        if usage is None:
            continue
        resp = usage.int(USAGE_RESPONSE_FIELD)
        if resp:
            return resp
        out, thinking = usage.int(USAGE_OUTPUT_FIELD), usage.int(USAGE_THINKING_FIELD)
        if out > thinking:
            return out - thinking
    return 0


def checkpoint_summary_tokens(step: Step) -> int:
    t = compaction_tokens(step)
    if t:
        return t
    ck = step.payload(STEP_CHECKPOINT) or Msg(b"")
    text = ck.str(CHECKPOINT_INTENT_FIELD) or ck.str(CHECKPOINT_SUMMARY_ALT_FIELD)
    return max(1, int(len(text.encode("utf-8")) / 4)) if text else 0


def checkpoint_newer_than_generation(steps: list[Step], chat_start: Msg | None) -> tuple[int, Step | None]:
    gen_ck = chat_start.int(CHAT_START_CHECKPOINT_FIELD, signed32=True) if chat_start is not None else -1
    for i in range(len(steps) - 1, -1, -1):
        s = steps[i]
        if s.type == STEP_TYPE_CHECKPOINT and s.status == STATUS_DONE:
            ck = s.payload(STEP_CHECKPOINT)
            if ck is not None and ck.int(CHECKPOINT_INDEX_FIELD) > gen_ck:
                return i, s
            break
    return -1, None


def chat_tokens_by_category(items: list[Msg]) -> tuple[bool, list[int]]:
    out = [0, 0, 0, 0]
    if not items:
        return False, out
    for it in items:
        left, sep, right = it.str(1).partition(": ")
        if not sep or not re.fullmatch(r"[+-]?[0-9]+", left) or right not in STEP_TYPES:
            return False, [0, 0, 0, 0]
        cat = step_category(STEP_TYPES[right])
        tok = max(0, it.int(3, signed32=True))
        if cat == CAT_USER:
            out[0] += tok
        elif cat in (CAT_AGENT, CAT_CHECKPOINT):
            out[1] += tok
        elif cat == CAT_TOOL:
            out[2] += tok
        else:
            out[3] += tok
    return True, out


# --- Model & DB helpers ------------------------------------------------------


MAX_HISTORY_POINTS = 120


def _telemetry_from_views(usage_mv: memoryview, start_mv: memoryview | None) -> dict | None:
    uncached = output = cached = thinking = 0
    for fn, val in iter_fields(usage_mv, USAGE_TELEMETRY_FIELDS):
        if not isinstance(val, int):
            continue
        if fn == USAGE_UNCACHED_INPUT_FIELD:
            uncached = val
        elif fn == USAGE_OUTPUT_FIELD:
            output = val
        elif fn == USAGE_CACHED_INPUT_FIELD:
            cached = val
        elif fn == USAGE_THINKING_FIELD:
            thinking = val

    total_in = uncached + cached
    if total_in <= 0:
        return None

    active_ck = -1
    if start_mv is not None:
        active_ck = 0
        for fn, val in iter_fields(start_mv, CHAT_START_CHECKPOINT_FIELDS):
            if fn == CHAT_START_CHECKPOINT_FIELD and isinstance(val, int):
                active_ck = val - (1 << 64) if val >= (1 << 63) else val

    return {
        "tokens": total_in,
        "cached_tokens": cached,
        "output_tokens": output,
        "thinking_tokens": thinking,
        "active_checkpoint": active_ck,
    }


def extract_turn_telemetry(data: bytes | bytearray | memoryview) -> dict | None:
    """Fast zero-copy extractor for per-turn usage & checkpoint from a gen_metadata blob."""
    chat_mv = None
    for fn, val in iter_fields(data, GEN_CHAT_FIELDS):
        if fn == GEN_CHAT_FIELD and isinstance(val, memoryview):
            chat_mv = val
    if chat_mv is None:
        return None

    usage_mv = None
    start_mv = None
    for fn, val in iter_fields(chat_mv, CHAT_TELEMETRY_FIELDS):
        if fn == CHAT_USAGE_FIELD and isinstance(val, memoryview):
            usage_mv = val
        elif fn == CHAT_START_FIELD and isinstance(val, memoryview):
            start_mv = val

    if usage_mv is None:
        return None
    return _telemetry_from_views(usage_mv, start_mv)


def compute_history_and_session(raw_turns: list[dict]) -> tuple[list[dict], dict | None]:
    """Build turn-by-turn sparkline history and weighted session cache/output summary."""
    if not raw_turns:
        return [], None

    full_turns: list[dict] = []
    prev_tokens = 0
    prev_ck = -1
    total_output = 0
    total_thinking = 0
    warm_cached = 0
    warm_input = 0

    for i, t in enumerate(raw_turns):
        tok = t["tokens"]
        cached = t["cached_tokens"]
        out_tok = t["output_tokens"]
        think_tok = t["thinking_tokens"]
        ck = t["active_checkpoint"]

        delta = tok - prev_tokens if i > 0 else 0
        compacted = bool(i > 0 and ck > prev_ck)
        hit_pct = round(pct(cached, tok), 1)

        total_output += out_tok
        total_thinking += think_tok
        if i > 0:
            warm_cached += cached
            warm_input += tok

        full_turns.append({
            "turn": i + 1,
            "tokens": tok,
            "delta": delta,
            "cache_hit_pct": hit_pct,
            "output_tokens": out_tok,
            "compacted": compacted,
        })
        prev_tokens = tok
        prev_ck = ck

    n = len(full_turns)
    avg_cache = round(pct(warm_cached, warm_input), 1) if warm_input > 0 else full_turns[0]["cache_hit_pct"]
    last = full_turns[-1]
    prev = full_turns[-2] if n > 1 else None
    had_active_cache = bool(prev is not None and (prev["cache_hit_pct"] >= 50.0 or avg_cache >= 50.0))
    cache_drop = bool(n > 1 and had_active_cache and last["cache_hit_pct"] < 50.0 and not last["compacted"])
    cache_drop_after_compact = bool(n > 1 and had_active_cache and last["cache_hit_pct"] < 50.0 and last["compacted"])

    session_usage = {
        "turns": n,
        "total_output_tokens": total_output,
        "total_thinking_tokens": total_thinking,
        "avg_cache_hit_pct": avg_cache,
        "cache_drop": cache_drop,
        "cache_drop_after_compact": cache_drop_after_compact,
    }

    history = full_turns[-MAX_HISTORY_POINTS:] if n > MAX_HISTORY_POINTS else full_turns
    return history, session_usage


def sqlite_ro_uri(db_path: Path) -> str:
    """Build a percent-encoded SQLite read-only file URI."""
    return f"file:{quote(db_path.resolve().as_posix(), safe='/:')}?mode=ro"


def load_db_with_history(db_path: Path) -> tuple[list[Step], Msg | None, Msg | None, list[dict], dict | None]:
    """Read steps, latest generation records, and per-turn telemetry in a single read-only pass."""
    uri = sqlite_ro_uri(db_path)
    con = sqlite3.connect(uri, uri=True, timeout=2.5, isolation_level=None)
    raw_turns: list[dict] = []
    latest_stats_bytes: bytes | None = None
    latest_content_bytes: bytes | None = None
    began = False
    try:
        con.execute("BEGIN")
        began = True
        steps = [
            Step(idx, payload, stype, status, md)
            for idx, payload, stype, status, md in con.execute(
                "SELECT idx, step_payload, step_type, status, metadata FROM steps ORDER BY idx ASC"
            )
        ]
        for (data,) in con.execute(
            "SELECT data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx ASC"
        ):
            if not isinstance(data, (bytes, bytearray, memoryview)) or not data:
                continue
            chat_mv = None
            for fn, val in iter_fields(data, GEN_CHAT_FIELDS):
                if fn == GEN_CHAT_FIELD and isinstance(val, memoryview):
                    chat_mv = val
            if chat_mv is None:
                continue
            has_content = False
            usage_mv = None
            start_mv = None
            for fn, val in iter_fields(chat_mv, CHAT_SCAN_FIELDS):
                if fn in CHAT_CONTENT_FIELDS:
                    has_content = True
                elif fn == CHAT_USAGE_FIELD and isinstance(val, memoryview):
                    usage_mv = val
                elif fn == CHAT_START_FIELD and isinstance(val, memoryview):
                    start_mv = val
            latest_stats_bytes = data
            if has_content:
                latest_content_bytes = data
            if usage_mv is not None:
                tel = _telemetry_from_views(usage_mv, start_mv)
                if tel is not None:
                    raw_turns.append(tel)
    finally:
        if began:
            try:
                con.execute("ROLLBACK")
            except sqlite3.Error:
                pass
        con.close()

    latest_stats: Msg | None = Msg(latest_stats_bytes) if latest_stats_bytes is not None else None
    if latest_content_bytes is latest_stats_bytes:
        latest_content = latest_stats
    else:
        latest_content = Msg(latest_content_bytes) if latest_content_bytes is not None else None

    history, session_usage = compute_history_and_session(raw_turns)
    return steps, latest_stats, latest_content, history, session_usage


def load_db(db_path: Path) -> tuple[list[Step], Msg | None, Msg | None]:
    """Read steps and latest generation records from a conversation SQLite DB."""
    steps, latest_stats, latest_content, _, _ = load_db_with_history(db_path)
    return steps, latest_stats, latest_content


def extract_model_id(gen: Msg | None) -> str:
    chat = gen.msg(GEN_CHAT_FIELD) if gen is not None else None
    if chat is None:
        return ""
    return chat.str(CHAT_MODEL_ID_FIELD) or chat.str(CHAT_MODEL_ID_ALT_FIELD) or ""


def extract_model_name(gen: Msg | None) -> str:
    chat = gen.msg(GEN_CHAT_FIELD) if gen is not None else None
    if chat is None:
        return "Unknown Model"
    if chat.str(CHAT_MODEL_NAME_FIELD):
        return chat.str(CHAT_MODEL_NAME_FIELD)
    return extract_model_id(gen) or "Unknown Model"


def extract_request_budget(gen: Msg | None) -> int:
    chat = gen.msg(GEN_CHAT_FIELD) if gen is not None else None
    start = chat.msg(CHAT_START_FIELD) if chat is not None else None
    cwm = start.msg(CHAT_START_CWM_FIELD) if start is not None else None
    return cwm.int(CWM_REQUEST_BUDGET_FIELD, signed32=True) if cwm is not None else 0


def infer_context_limit(gen: Msg | None) -> int:
    slug = re.sub(r"[\s_]+", "-", extract_model_id(gen).strip().lower())
    name = re.sub(r"[\s_]+", "-", extract_model_name(gen).strip().lower())
    for prefix, tokens in NATIVE_CONTEXT_WINDOWS:
        if len(prefix) <= 2:
            pat = rf"(?<![a-z0-9]){re.escape(prefix)}(?![a-z0-9])"
            if re.search(pat, slug) or re.search(pat, name):
                return tokens
        elif slug.startswith(prefix) or prefix in name:
            return tokens
    return extract_request_budget(gen)


# --- Stats and files ---------------------------------------------------------


def detect_system_files(
    home: str,
    workspace: str | None,
    app_dir: str,
    gemini_dir: str | Path | None = None,
) -> list[dict]:
    if not home and not gemini_dir:
        return []
    gemini = Path(gemini_dir).expanduser() if gemini_dir else Path(home) / ".gemini"
    prefix = shorten_path(str(gemini)).rstrip("/") if gemini_dir else "~/.gemini"
    found = []
    if (gemini / "GEMINI.md").is_file():
        found.append(f"{prefix}/GEMINI.md")
    for sub in ("skills", "rules", "agents", "global_workflows"):
        if (gemini / sub).is_dir():
            found.append(f"{prefix}/{sub}/")
    if app_dir:
        for sub in ("rules", "skills", "agents", "global_workflows"):
            if (gemini / app_dir / sub).is_dir():
                found.append(f"{prefix}/{app_dir}/{sub}/")
    if workspace:
        ws = Path(workspace)
        for root in (".agents", "_agents"):
            for sub in ("rules", "skills", "agents", "workflows"):
                if (ws / root / sub).is_dir():
                    found.append(f"{root}/{sub}/")
            if (ws / root / "hooks.json").is_file():
                found.append(f"{root}/hooks.json")
    return [{"path": p} for p in found]


def collect_stats(steps: list[Step], gen: Msg | None, limit: int) -> tuple[dict, Msg | None]:
    st: dict = {
        k: 0
        for k in (
            "user", "agent", "tool", "checkpoint", "system_messages",
            "system_prompt", "system_tools", "system_overhead",
            "rules", "skills", "subagents", "legacy_workflows",
            "workflows", "plugins", "mcp_tools",
        )
    }
    st["has_breakdown"] = False
    st["active_checkpoint"] = -1
    checkpoints, knowledge, artifacts, skill_files = [], [], [], []
    seen_k, seen_a, seen_s = set(), set(), set()

    chat = gen.msg(GEN_CHAT_FIELD) if gen is not None else None
    chat_start = chat.msg(CHAT_START_FIELD) if chat is not None else None
    newer_pos, newer_step = checkpoint_newer_than_generation(steps, chat_start)
    has_newer = newer_step is not None
    st["compacted"] = has_newer

    for pos, step in enumerate(steps):
        cat = step_category(step.type)
        tok = step_tokens(step)
        counted = 0 if has_newer and newer_pos > pos else tok
        if cat == CAT_USER:
            st["user"] += counted
        elif cat == CAT_AGENT:
            st["agent"] += counted
        elif cat == CAT_TOOL:
            st["tool"] += counted
        elif cat == CAT_CHECKPOINT:
            st["checkpoint"] += tok
            ck = step.payload(STEP_CHECKPOINT)
            if ck is not None:
                checkpoints.append({
                    "index": ck.int(CHECKPOINT_INDEX_FIELD),
                    "start": ck.int(CHECKPOINT_START_FIELD),
                    "end": ck.int(CHECKPOINT_END_FIELD),
                    "intent": ck.str(CHECKPOINT_INTENT_FIELD),
                })
        else:
            st["system_messages"] += counted

        ca = step.payload(STEP_CODE_ACTION)
        result = ca.msg(CODE_ACTION_RESULT_FIELD) if ca is not None else None
        edit = result.msg(CODE_ACTION_EDIT_FIELD) if result is not None else None
        if edit is not None:
            uri = edit.str(CODE_ACTION_EDIT_URI_FIELD)
            short = shorten_path(uri)
            if ca.int(CODE_ACTION_IS_ARTIFACT_FIELD) and uri not in seen_a:
                seen_a.add(uri)
                artifacts.append({"path": short, "tokens": tok})
            if ca.int(CODE_ACTION_IS_KNOWLEDGE_FIELD) and uri not in seen_k:
                seen_k.add(uri)
                knowledge.append({"path": short, "tokens": tok})

        vf = step.payload(STEP_VIEW_FILE)
        if vf is not None and vf.int(VIEW_FILE_IS_SKILL_FIELD):
            uri = vf.str(VIEW_FILE_PATH_FIELD)
            if uri not in seen_s:
                seen_s.add(uri)
                skill_files.append({"path": shorten_path(uri), "tokens": tok})

    cwm = chat_start.msg(CHAT_START_CWM_FIELD) if chat_start is not None else None
    breakdown = cwm.msg(CWM_BREAKDOWN_FIELD) if cwm is not None else None

    if breakdown is not None:
        st["has_breakdown"] = True
        seen_prompt = seen_tools = False
        chat_tok, chat_items = 0, []
        for g in breakdown.msgs(1):
            gtype = g.int(2)
            gtok = max(0, g.int(4, signed32=True))
            if gtype == TOKEN_SYSTEM_PROMPT:
                extracted = 0
                for child in g.msgs(5):
                    name = child.str(1)
                    ctok = max(0, child.int(3, signed32=True))
                    if name == "flows":
                        st["workflows"] += ctok
                    elif name == "skills":
                        st["skills"] += ctok
                    elif name == "subagents":
                        st["subagents"] += ctok
                    else:
                        continue
                    extracted += ctok
                st["system_prompt"] += max(0, gtok - extracted)
                seen_prompt = True
            elif gtype == TOKEN_TOOLS:
                st["system_tools"] += gtok
                seen_tools = True
            elif gtype == TOKEN_RULES:
                st["rules"] += gtok
            elif gtype == TOKEN_MCP_TOOLS:
                st["mcp_tools"] += gtok
            elif gtype == TOKEN_SKILLS:
                st["skills"] += gtok
            elif gtype == TOKEN_SUBAGENTS:
                st["subagents"] += gtok
            elif gtype == TOKEN_CHAT_MESSAGES:
                chat_tok += gtok
                chat_items.extend(g.msgs(5))
            elif gtype == TOKEN_WORKFLOWS:
                st["legacy_workflows"] += gtok
            elif gtype == TOKEN_PLUGINS:
                st["plugins"] += gtok
            elif gtype == TOKEN_FLOWS:
                st["workflows"] += gtok

        if not seen_prompt and not seen_tools and chat_tok > 0 and chat is not None:
            usage = chat.msg(CHAT_USAGE_FIELD)
            api_input = (
                usage.int(USAGE_UNCACHED_INPUT_FIELD) + usage.int(USAGE_CACHED_INPUT_FIELD)
                if usage is not None
                else 0
            )
            known_custom = (
                st["rules"] + st["skills"] + st["subagents"]
                + st["legacy_workflows"] + st["workflows"] + st["plugins"] + st["mcp_tools"]
            )
            st["system_overhead"] = max(0, api_input - chat_tok - known_custom)

        if chat_tok > 0 and not has_newer:
            ok, cats = chat_tokens_by_category(chat_items)
            if ok:
                st["user"], st["agent"], st["tool"], st["system_messages"] = cats
            else:
                est = st["user"] + st["agent"] + st["tool"] + st["system_messages"]
                if est == 0:
                    st["agent"] = chat_tok
                    st["system_messages"] = 0
                else:
                    f = chat_tok / est
                    st["user"] = int(st["user"] * f)
                    st["agent"] = int(st["agent"] * f)
                    st["tool"] = int(st["tool"] * f)
                    st["system_messages"] = int(st["system_messages"] * f)

    if chat_start is not None:
        st["active_checkpoint"] = chat_start.int(CHAT_START_CHECKPOINT_FIELD, signed32=True)
    if has_newer and newer_step is not None:
        st["agent"] += checkpoint_summary_tokens(newer_step)
        ck = newer_step.payload(STEP_CHECKPOINT)
        if ck is not None:
            st["active_checkpoint"] = ck.int(CHECKPOINT_INDEX_FIELD)

    st["total"] = sum(
        st[k]
        for k in (
            "user", "agent", "tool", "system_messages", "system_prompt",
            "system_tools", "system_overhead", "rules", "skills", "subagents",
            "legacy_workflows", "workflows", "plugins", "mcp_tools",
        )
    )
    st["limit"] = limit
    st["checkpoints"] = checkpoints
    st["knowledge_files"] = knowledge
    st["artifact_files"] = artifacts
    st["skill_files"] = skill_files

    usage = chat.msg(CHAT_USAGE_FIELD) if chat is not None else None
    if usage is not None:
        uncached = usage.int(USAGE_UNCACHED_INPUT_FIELD)
        cached = usage.int(USAGE_CACHED_INPUT_FIELD)
        total_in = uncached + cached
        st["api_usage"] = {
            "input_tokens": uncached,
            "cached_tokens": cached,
            "total_input_tokens": total_in,
            "output_tokens": usage.int(USAGE_OUTPUT_FIELD),
            "thinking_tokens": usage.int(USAGE_THINKING_FIELD),
            "response_tokens": usage.int(USAGE_RESPONSE_FIELD),
            "cache_hit_pct": round(pct(cached, total_in), 1) if total_in > 0 else 0.0,
        }
    else:
        st["api_usage"] = None

    return st, breakdown


def grid_segments(st: dict) -> list[int]:
    """[system, user, agent, tool, customizations] token totals."""
    sys_tot = st["system_prompt"] + st["system_tools"] + st["system_overhead"] + st["system_messages"]
    custom_tot = (
        st["rules"] + st["skills"] + st["subagents"]
        + st["legacy_workflows"] + st["workflows"] + st["plugins"] + st["mcp_tools"]
    )
    return [sys_tot, st["user"], st["agent"], st["tool"], custom_tot]


def stats_heading(st: dict) -> str:
    if st["compacted"]:
        return "Estimated after compaction · updates next turn"
    if st["has_breakdown"]:
        return "Exact token usage from latest model call"
    return "Estimated usage (awaiting first generation)"
