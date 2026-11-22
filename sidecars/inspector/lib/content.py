"""Extract raw context window items: system sections, tool schemas, and messages."""

from __future__ import annotations

import json
import re

from .accounting import (
    CAT_AGENT,
    CAT_CHECKPOINT,
    CAT_SYSTEM,
    CAT_TOOL,
    CAT_USER,
    GROUP_LABELS,
    STEP_PLANNER_RESPONSE,
    STEP_TYPE_NAMES,
    STEP_USER_INPUT,
    TOKEN_CHAT_MESSAGES,
    TOKEN_FLOWS,
    TOKEN_MCP_TOOLS,
    TOKEN_PLUGINS,
    TOKEN_RULES,
    TOKEN_SKILLS,
    TOKEN_SUBAGENTS,
    TOKEN_SYSTEM_PROMPT,
    TOKEN_TOOLS,
    TOKEN_WORKFLOWS,
    Step,
    pct,
    step_category,
    step_tokens,
)
from .protobuf import Msg

ROLE_MAP = {
    1: "user",
    2: "assistant",
    3: "system",
    4: "tool",
}


def make_preview(text: str, limit: int = 160) -> str:
    if not text:
        return ""
    flat = re.sub(r"\s+", " ", text).strip()
    if len(flat) <= limit:
        return flat
    return flat[: limit - 1].rstrip() + "…"


def parse_breakdown_maps(breakdown: Msg | None) -> dict:
    """Build exact per-item token lookups from ContextWindowMetadata.breakdown."""
    section_tokens: dict[str, int] = {}
    section_group: dict[str, int] = {}
    sys_tool_tokens: dict[str, int] = {}
    mcp_tool_tokens: dict[str, int] = {}
    step_tokens_map: dict[int, tuple[str, int]] = {}

    if breakdown is None:
        return {
            "section_tokens": section_tokens,
            "section_group": section_group,
            "sys_tool_tokens": sys_tool_tokens,
            "mcp_tool_tokens": mcp_tool_tokens,
            "step_tokens_map": step_tokens_map,
        }

    for g in breakdown.msgs(1):
        gtype = g.int(2)
        children = g.msgs(5)
        if gtype in (
            TOKEN_SYSTEM_PROMPT,
            TOKEN_RULES,
            TOKEN_SKILLS,
            TOKEN_SUBAGENTS,
            TOKEN_WORKFLOWS,
            TOKEN_PLUGINS,
            TOKEN_FLOWS,
        ):
            for ch in children:
                cname = ch.str(1)
                section_tokens[cname] = ch.int(3, signed32=True)
                section_group[cname] = gtype
        elif gtype == TOKEN_TOOLS:
            for ch in children:
                sys_tool_tokens[ch.str(1)] = ch.int(3, signed32=True)
        elif gtype == TOKEN_MCP_TOOLS:
            for ch in children:
                mcp_tool_tokens[ch.str(1)] = ch.int(3, signed32=True)
        elif gtype == TOKEN_CHAT_MESSAGES:
            for ch in children:
                left, sep, right = ch.str(1).partition(": ")
                if sep and re.fullmatch(r"[+-]?[0-9]+", left):
                    step_tokens_map[int(left)] = (right, ch.int(3, signed32=True))

    return {
        "section_tokens": section_tokens,
        "section_group": section_group,
        "sys_tool_tokens": sys_tool_tokens,
        "mcp_tool_tokens": mcp_tool_tokens,
        "step_tokens_map": step_tokens_map,
    }


def extract_content_items(
    steps: list[Step],
    content_gen: Msg | None,
    breakdown: Msg | None,
    total_used: int,
) -> dict:
    """Extract system prompt sections, tool declarations, and active chat messages."""
    maps = parse_breakdown_maps(breakdown)
    section_tokens = maps["section_tokens"]
    section_group = maps["section_group"]
    sys_tool_tokens = maps["sys_tool_tokens"]
    mcp_tool_tokens = maps["mcp_tool_tokens"]
    step_tokens_map = maps["step_tokens_map"]

    chat = content_gen.msg(1) if content_gen is not None else None
    denom = max(total_used, 1)

    # 1. System prompt sections
    system_sections: list[dict] = []
    if chat is not None and chat.has(16):
        for idx, sb in enumerate(chat.msgs(16)):
            name = sb.str(1) or f"section_{idx}"
            body = sb.str(2)
            gtype = sb.int(6) or section_group.get(name, TOKEN_SYSTEM_PROMPT)
            tok = section_tokens.get(name, 0)
            estimated = False
            if tok <= 0 and body:
                tok = max(1, len(body.encode("utf-8")) // 4)
                estimated = True
            system_sections.append({
                "id": f"sys-{idx}-{name}",
                "kind": "system",
                "order": idx,
                "name": name,
                "group": GROUP_LABELS.get(gtype, "System prompt"),
                "group_type": gtype,
                "tokens": tok,
                "pct": round(pct(tok, denom), 1),
                "estimated": estimated,
                "chars": len(body),
                "preview": make_preview(body),
                "content": body,
            })
    elif chat is not None and chat.has(1):
        raw_sys = chat.str(1)
        if raw_sys:
            tok = sum(section_tokens.values()) or max(1, len(raw_sys.encode("utf-8")) // 4)
            system_sections.append({
                "id": "sys-0-system_prompt",
                "kind": "system",
                "order": 0,
                "name": "system_prompt",
                "group": "System prompt",
                "group_type": TOKEN_SYSTEM_PROMPT,
                "tokens": tok,
                "pct": round(pct(tok, denom), 1),
                "estimated": not bool(section_tokens),
                "chars": len(raw_sys),
                "preview": make_preview(raw_sys),
                "content": raw_sys,
            })

    # 2. Tool declarations
    tools: list[dict] = []
    if chat is not None and chat.has(8):
        for idx, tb in enumerate(chat.msgs(8)):
            name = tb.str(1) or f"tool_{idx}"
            desc = tb.str(2)
            schema_raw = tb.str(3)
            schema_pretty = schema_raw
            if schema_raw:
                try:
                    schema_pretty = json.dumps(json.loads(schema_raw), indent=2, ensure_ascii=False)
                except json.JSONDecodeError:
                    pass

            if name in mcp_tool_tokens:
                is_mcp = True
                tok = mcp_tool_tokens[name]
                estimated = False
            elif name in sys_tool_tokens:
                is_mcp = False
                tok = sys_tool_tokens[name]
                estimated = False
            else:
                is_mcp = name.startswith("mcp_")
                tok = max(1, (len(name) + len(desc) + len(schema_raw)) // 4)
                estimated = True

            full_text = f"# {name}\n\n{desc}\n\nParameters:\n{schema_pretty}" if schema_pretty else f"# {name}\n\n{desc}"
            tools.append({
                "id": f"tool-{idx}-{name}",
                "kind": "tool",
                "order": idx,
                "name": name,
                "is_mcp": is_mcp,
                "group": "MCP tools" if is_mcp else "System tools",
                "description": desc,
                "schema": schema_pretty,
                "tokens": tok,
                "pct": round(pct(tok, denom), 1),
                "estimated": estimated,
                "chars": len(desc) + len(schema_raw),
                "preview": make_preview(desc or schema_raw),
                "content": full_text,
            })

    # 3. Active conversation messages
    messages: list[dict] = []
    call_id_to_name: dict[str, str] = {}

    if chat is not None and chat.has(2):
        for idx, mb in enumerate(chat.msgs(2)):
            role_num = mb.int(2)
            role = ROLE_MAP.get(role_num, f"role_{role_num}")
            text = mb.str(3)
            thinking = mb.str(11)
            step_idx = mb.int(18) if mb.has(18) else -1
            tool_call_id = mb.str(7)

            tool_calls = []
            for tc in mb.msgs(6):
                tc_id = tc.str(1)
                tc_name = tc.str(2)
                tc_args_raw = tc.str(3)
                tc_args_pretty = tc_args_raw
                if tc_args_raw:
                    try:
                        tc_args_pretty = json.dumps(json.loads(tc_args_raw), indent=2, ensure_ascii=False)
                    except json.JSONDecodeError:
                        pass
                if tc_id and tc_name:
                    call_id_to_name[tc_id] = tc_name
                tool_calls.append({
                    "id": tc_id,
                    "name": tc_name,
                    "arguments": tc_args_pretty,
                    "raw_arguments": tc_args_raw,
                })

            resolved_tool_name = call_id_to_name.get(tool_call_id, "") if tool_call_id else ""
            tok = mb.int(4, signed32=True)
            step_type_label = ""
            if step_idx in step_tokens_map:
                step_type_label, bd_tok = step_tokens_map[step_idx]
                if tok <= 0:
                    tok = bd_tok

            combined_chars = len(text) + len(thinking) + sum(
                len(tc["raw_arguments"]) + len(tc["name"]) for tc in tool_calls
            )
            estimated = False
            if tok <= 0 and combined_chars > 0:
                tok = max(1, combined_chars // 4)
                estimated = True

            if role == "user":
                label = "User message"
            elif role == "assistant":
                if tool_calls and not text.strip():
                    names = ", ".join(tc["name"] for tc in tool_calls[:3])
                    if len(tool_calls) > 3:
                        names += f" +{len(tool_calls) - 3}"
                    label = f"Agent → {names}"
                elif tool_calls:
                    label = f"Agent reply + {len(tool_calls)} tool call(s)"
                else:
                    label = "Agent response"
            elif role == "tool":
                label = f"Tool result · {resolved_tool_name}" if resolved_tool_name else "Tool result"
            elif role == "system":
                label = "System message"
            else:
                label = f"Message ({role})"

            preview_src = text or (
                f"Calls: {', '.join(tc['name'] for tc in tool_calls)}" if tool_calls else thinking
            )

            messages.append({
                "id": f"msg-{idx}",
                "kind": "message",
                "order": idx,
                "index": idx,
                "step_index": step_idx,
                "step_type": step_type_label,
                "role": role,
                "label": label,
                "tool_name": resolved_tool_name,
                "tool_call_id": tool_call_id,
                "tool_names": [tc["name"] for tc in tool_calls],
                "tool_call_count": len(tool_calls),
                "has_thinking": bool(thinking.strip()),
                "tokens": tok,
                "pct": round(pct(tok, denom), 1),
                "estimated": estimated,
                "chars": combined_chars,
                "preview": make_preview(preview_src),
                "text": text,
                "thinking": thinking,
                "tool_calls": [
                    {"id": tc["id"], "name": tc["name"], "arguments": tc["arguments"]}
                    for tc in tool_calls
                ],
            })
    elif steps:
        for idx, step in enumerate(steps):
            cat = step_category(step.type)
            role = {
                CAT_USER: "user",
                CAT_AGENT: "assistant",
                CAT_TOOL: "tool",
                CAT_SYSTEM: "system",
                CAT_CHECKPOINT: "system",
            }.get(cat, "tool")
            text = ""
            thinking = ""
            ui = step.payload(STEP_USER_INPUT)
            pr = step.payload(STEP_PLANNER_RESPONSE)
            if ui is not None:
                text = ui.str(2)
            elif pr is not None:
                text = pr.str(1)
                thinking = pr.str(3)
            else:
                tc = step.md.msg(4)
                if tc is not None:
                    text = f"{tc.str(2)}({tc.str(3)})"
            tok = step_tokens(step)
            sname = STEP_TYPE_NAMES.get(step.type, f"STEP_{step.type}")
            messages.append({
                "id": f"msg-{idx}",
                "kind": "message",
                "order": idx,
                "index": idx,
                "step_index": step.pos,
                "step_type": sname,
                "role": role,
                "label": f"{role.title()} ({sname})",
                "tool_name": "",
                "tool_call_id": "",
                "tool_names": [],
                "tool_call_count": 0,
                "has_thinking": bool(thinking.strip()),
                "tokens": tok,
                "pct": round(pct(tok, denom), 1),
                "estimated": True,
                "chars": len(text) + len(thinking),
                "preview": make_preview(text or thinking or sname),
                "text": text,
                "thinking": thinking,
                "tool_calls": [],
            })

    return {
        "system_sections": system_sections,
        "tools": tools,
        "messages": messages,
    }
