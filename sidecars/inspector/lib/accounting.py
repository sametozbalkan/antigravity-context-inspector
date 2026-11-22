"""Token accounting, step decoding, file detection, and subagent discovery."""

from __future__ import annotations

import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import unquote, urlparse

from .protobuf import Msg, encode_varint

# --- Wire & enum constants ---------------------------------------------------

STEP_CODE_ACTION = 10
STEP_VIEW_FILE = 14
STEP_USER_INPUT = 19
STEP_PLANNER_RESPONSE = 20
STEP_CHECKPOINT = 30
STEP_GENERIC = 140
GENERIC_TYPE = 132
STATUS_DONE = 3
ORIGINAL_STEP_TYPE_URL = "/gemini_coder.Step"

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
    home = str(Path.home()).replace("\\", "/")
    p = p.replace("\\", "/")
    if p.startswith(home):
        return "~" + p[len(home) :]
    return p


def step_category(step_type: int) -> int:
    if step_type == 14:
        return CAT_USER
    if step_type == 15:
        return CAT_AGENT
    if step_type == 23:
        return CAT_CHECKPOINT
    if step_type in (0, 2, 101):
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
        self.type = self.pb.int(1) if self.pb.has(1) else step_type
        self.status = self.pb.int(4) if self.pb.has(4) else status
        self.md = self.pb.msg(5) or Msg(metadata)
        self.view_file_override: Msg | None = None
        if self.type == GENERIC_TYPE:
            self._rehydrate()

    def _rehydrate(self):
        generic = self.pb.msg(STEP_GENERIC)
        if generic is None:
            return
        original = packed_original_step(generic)
        if original is not None:
            self.pb = Msg(original)
            self.type = self.pb.int(1)
            self.md = self.pb.msg(5) or Msg(b"")
            return
        tc = self.md.msg(4)
        if tc is None or tc.str(2) not in ("view_file", "read_file"):
            return
        try:
            args = json.loads(tc.str(3) or "{}")
        except json.JSONDecodeError:
            return
        path = next(
            (args[k] for k in ("AbsolutePath", "Path", "FilePath") if isinstance(args.get(k), str) and args[k]),
            "",
        )
        if path:
            self.type = 8
            encoded = path.encode("utf-8")
            self.view_file_override = Msg(
                b"\x0a" + encode_varint(len(encoded)) + encoded + (b"\x88\x01\x01" if is_skill_file(path) else b"")
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
        tc = step.md.msg(4)
        n = len(tc.bytes(3)) if tc else 0
        out = step.md.int(23, signed32=True)
        if out > 0:
            return out
    return max(1, int(n / 4)) if n > 0 else 0


def step_tokens(step: Step) -> int:
    usage = step.md.msg(9)
    if usage is not None:
        return usage.int(3)
    return estimate_step_tokens(step)


def compaction_tokens(step: Step) -> int:
    for ri in reversed(step.md.msgs(28)):
        usage = ri.msg(2)
        if usage is None:
            continue
        resp = usage.int(10)
        if resp:
            return resp
        out, thinking = usage.int(3), usage.int(9)
        return out - thinking if thinking < out else 0
    return 0


def checkpoint_summary_tokens(step: Step) -> int:
    t = compaction_tokens(step)
    if t:
        return t
    ck = step.payload(STEP_CHECKPOINT) or Msg(b"")
    text = ck.str(4) or ck.str(3)
    return max(1, int(len(text.encode("utf-8")) / 4)) if text else 0


def checkpoint_newer_than_generation(steps: list[Step], chat_start: Msg | None) -> tuple[int, Step | None]:
    gen_ck = chat_start.int(2, signed32=True) if chat_start is not None else -1
    for i in range(len(steps) - 1, -1, -1):
        s = steps[i]
        if s.type == 23 and s.status == STATUS_DONE:
            ck = s.payload(STEP_CHECKPOINT)
            if ck is not None and ck.int(1) > gen_ck:
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
        tok = it.int(3, signed32=True)
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


def load_db(db_path: Path) -> tuple[list[Step], Msg | None, Msg | None]:
    """Read steps and latest generation records from a conversation SQLite DB."""
    uri = f"file:{db_path.as_posix()}?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=2.5)
    try:
        steps = [
            Step(idx, payload, stype, status, md)
            for idx, payload, stype, status, md in con.execute(
                "SELECT idx, step_payload, step_type, status, metadata FROM steps ORDER BY idx ASC"
            )
        ]
        gen_rows = con.execute(
            "SELECT idx, data FROM gen_metadata ORDER BY idx DESC LIMIT 20"
        ).fetchall()
    finally:
        con.close()

    latest_stats: Msg | None = None
    latest_content: Msg | None = None
    for _, data in gen_rows:
        if not data:
            continue
        gm = Msg(data)
        chat = gm.msg(1)
        if chat is None:
            continue
        if latest_stats is None:
            latest_stats = gm
        if latest_content is None and (chat.has(2) or chat.has(16) or chat.has(8) or chat.has(1)):
            latest_content = gm
        if latest_stats is not None and latest_content is not None:
            break

    return steps, latest_stats, latest_content


def extract_model_id(gen: Msg | None) -> str:
    chat = gen.msg(1) if gen is not None else None
    if chat is None:
        return ""
    return chat.str(19) or chat.str(11) or ""


def extract_model_name(gen: Msg | None) -> str:
    chat = gen.msg(1) if gen is not None else None
    if chat is None:
        return "Unknown Model"
    if chat.str(21):
        return chat.str(21)
    return extract_model_id(gen) or "Unknown Model"


def extract_request_budget(gen: Msg | None) -> int:
    chat = gen.msg(1) if gen is not None else None
    start = chat.msg(9) if chat is not None else None
    cwm = start.msg(10) if start is not None else None
    return cwm.int(4, signed32=True) if cwm is not None else 0


def infer_context_limit(gen: Msg | None) -> int:
    slug = extract_model_id(gen).lower()
    name = extract_model_name(gen).lower()
    for prefix, tokens in NATIVE_CONTEXT_WINDOWS:
        if slug.startswith(prefix) or prefix in name:
            return tokens
    return extract_request_budget(gen)


# --- Stats, files, and subagents ---------------------------------------------


def detect_system_files(home: str, workspace: str | None, app_dir: str) -> list[dict]:
    if not home:
        return []
    gemini = Path(home) / ".gemini"
    found = []
    if (gemini / "GEMINI.md").is_file():
        found.append("~/.gemini/GEMINI.md")
    for sub in ("skills", "rules", "agents", "global_workflows"):
        if (gemini / sub).is_dir():
            found.append(f"~/.gemini/{sub}/")
    if app_dir:
        for sub in ("rules", "skills", "agents", "global_workflows"):
            if (gemini / app_dir / sub).is_dir():
                found.append(f"~/.gemini/{app_dir}/{sub}/")
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

    chat = gen.msg(1) if gen is not None else None
    chat_start = chat.msg(9) if chat is not None else None
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
                    "index": ck.int(1),
                    "start": ck.int(11),
                    "end": ck.int(12),
                    "intent": ck.str(4),
                })
        else:
            st["system_messages"] += counted

        ca = step.payload(STEP_CODE_ACTION)
        result = ca.msg(2) if ca is not None else None
        edit = result.msg(1) if result is not None else None
        if edit is not None:
            uri = edit.str(8)
            short = shorten_path(uri)
            if ca.int(21) and uri not in seen_a:
                seen_a.add(uri)
                artifacts.append({"path": short, "tokens": tok})
            if ca.int(24) and uri not in seen_k:
                seen_k.add(uri)
                knowledge.append({"path": short, "tokens": tok})

        vf = step.payload(STEP_VIEW_FILE)
        if vf is not None and vf.int(17):
            uri = vf.str(1)
            if uri not in seen_s:
                seen_s.add(uri)
                skill_files.append({"path": shorten_path(uri), "tokens": tok})

    cwm = chat_start.msg(10) if chat_start is not None else None
    breakdown = cwm.msg(3) if cwm is not None else None

    if breakdown is not None:
        st["has_breakdown"] = True
        seen_prompt = seen_tools = False
        chat_tok, chat_items = 0, []
        for g in breakdown.msgs(1):
            gtype, gtok = g.int(2), g.int(4, signed32=True)
            if gtype == TOKEN_SYSTEM_PROMPT:
                extracted = 0
                for child in g.msgs(5):
                    name, ctok = child.str(1), child.int(3, signed32=True)
                    if name == "flows":
                        st["workflows"] += ctok
                    elif name == "skills":
                        st["skills"] += ctok
                    elif name == "subagents":
                        st["subagents"] += ctok
                    else:
                        continue
                    extracted += ctok
                st["system_prompt"] = gtok - extracted
                seen_prompt = True
            elif gtype == TOKEN_TOOLS:
                st["system_tools"] = gtok
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
                chat_tok, chat_items = gtok, g.msgs(5)
            elif gtype == TOKEN_WORKFLOWS:
                st["legacy_workflows"] += gtok
            elif gtype == TOKEN_PLUGINS:
                st["plugins"] += gtok
            elif gtype == TOKEN_FLOWS:
                st["workflows"] += gtok

        if not seen_prompt and not seen_tools and chat_tok and chat is not None:
            usage = chat.msg(4)
            api_input = (usage.int(2) + usage.int(5)) if usage is not None else 0
            if chat_tok < api_input:
                st["system_overhead"] = api_input - chat_tok

        if chat_tok and not has_newer:
            ok, cats = chat_tokens_by_category(chat_items)
            if ok:
                st["user"], st["agent"], st["tool"], st["system_messages"] = cats
            else:
                est = st["user"] + st["agent"] + st["tool"]
                if est == 0:
                    st["agent"] = chat_tok
                else:
                    f = chat_tok / est
                    st["user"] = int(st["user"] * f)
                    st["agent"] = int(st["agent"] * f)
                    st["tool"] = int(st["tool"] * f)

    if chat_start is not None:
        st["active_checkpoint"] = chat_start.int(2, signed32=True)
    if has_newer and newer_step is not None:
        st["agent"] += checkpoint_summary_tokens(newer_step)
        ck = newer_step.payload(STEP_CHECKPOINT)
        if ck is not None:
            st["active_checkpoint"] = ck.int(1)

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

    usage = chat.msg(4) if chat is not None else None
    if usage is not None:
        uncached = usage.int(2)
        cached = usage.int(5)
        total_in = uncached + cached
        st["api_usage"] = {
            "input_tokens": uncached,
            "cached_tokens": cached,
            "total_input_tokens": total_in,
            "output_tokens": usage.int(3),
            "thinking_tokens": usage.int(9),
            "response_tokens": usage.int(10),
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


def quick_subagent_stats(sub_db: Path, catalog: dict) -> dict | None:
    """Fast read-only summary for a subagent conversation database."""
    if not sub_db.is_file():
        return None
    uri = f"file:{sub_db.as_posix()}?mode=ro"
    try:
        con = sqlite3.connect(uri, uri=True, timeout=1.5)
        try:
            last_step = con.execute("SELECT status FROM steps ORDER BY idx DESC LIMIT 1").fetchone()
            gen_row = con.execute("SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1").fetchone()
            step_rows = []
            if gen_row is None:
                step_rows = con.execute(
                    "SELECT idx, step_payload, step_type, status, metadata FROM steps ORDER BY idx ASC"
                ).fetchall()
        finally:
            con.close()
    except Exception:
        return None

    gen = Msg(gen_row[0]) if gen_row and gen_row[0] else None
    steps = [Step(i, pl, st, s, md) for i, pl, st, s, md in step_rows]
    mid = extract_model_id(gen)
    cat_entry = catalog.get(mid) or {}
    limit = int(cat_entry.get("maxTokens") or 0) or infer_context_limit(gen)
    model = cat_entry.get("displayName") or extract_model_name(gen)
    budget = extract_request_budget(gen)
    st, _ = collect_stats(steps, gen, limit)
    used = st["total"]

    if last_step is None:
        status = "starting"
    elif last_step[0] == 2:
        status = "running"
    else:
        status = "idle"

    return {
        "model": model,
        "model_id": mid,
        "used_tokens": used,
        "limit_tokens": limit,
        "used_pct": round(min(100.0, pct(used, limit)), 1) if limit else 0.0,
        "request_budget_tokens": budget,
        "budget_pct": round(min(100.0, pct(used, budget)), 1) if budget else 0.0,
        "status": status,
    }


def extract_subagents(steps: list[Step], db_path: Path, catalog: dict) -> list[dict]:
    """Discover child subagents spawned via invoke_subagent steps."""
    conv_dir = db_path.parent
    self_id = db_path.stem.lower()
    seen: set[str] = set()
    out: list[dict] = []

    for step in steps:
        tc = step.md.msg(4)
        tc_name = tc.str(2) if tc is not None else ""
        if tc_name != "invoke_subagent" and step.type != 127:
            continue

        role = ""
        type_name = ""
        req_model = ""
        if tc is not None and tc.str(3):
            try:
                args = json.loads(tc.str(3))
                if isinstance(args, dict):
                    role = str(args.get("Role") or args.get("role") or "")
                    type_name = str(args.get("TypeName") or args.get("type_name") or "")
                    req_model = str(args.get("Model") or args.get("model") or "")
            except json.JSONDecodeError:
                pass

        sub_id = ""
        generic = step.pb.msg(STEP_GENERIC)
        if generic is not None:
            res = generic.msg(2)
            if res is not None:
                res_text = res.str(1)
                m = re.search(r'"conversationId"\s*:\s*"([0-9a-f-]{36})"', res_text, re.IGNORECASE)
                if m:
                    sub_id = m.group(1).lower()
                else:
                    for cand in UUID_RE.findall(res_text):
                        if cand.lower() != self_id:
                            sub_id = cand.lower()
                            break

        if not sub_id or sub_id == self_id or sub_id in seen:
            continue
        seen.add(sub_id)

        stats = quick_subagent_stats(conv_dir / f"{sub_id}.db", catalog)
        out.append({
            "conversation_id": sub_id,
            "role": role or type_name or f"Subagent {len(out) + 1}",
            "type_name": type_name,
            "requested_model": req_model,
            "model": stats["model"] if stats else (req_model or "Pending"),
            "used_tokens": stats["used_tokens"] if stats else 0,
            "limit_tokens": stats["limit_tokens"] if stats else 0,
            "used_pct": stats["used_pct"] if stats else 0.0,
            "request_budget_tokens": stats["request_budget_tokens"] if stats else 0,
            "budget_pct": stats["budget_pct"] if stats else 0.0,
            "status": stats["status"] if stats else "starting",
            "has_db": bool(stats is not None),
        })

    return out
