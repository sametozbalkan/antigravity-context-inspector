"""Subagent (invoke_subagent) and Swarm worker discovery and stats."""

from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import time

from .accounting import (
    CHAT_START_CHECKPOINT_FIELD,
    CHAT_START_CWM_FIELD,
    CHAT_START_FIELD,
    CHECKPOINT_INDEX_FIELD,
    CONV_ID_JSON_RE,
    CWM_BREAKDOWN_FIELD,
    GEN_CHAT_FIELD,
    MD_TOOL_CALL_FIELD,
    STATUS_DONE,
    STEP_CHECKPOINT,
    STEP_ENVELOPE_FIELDS,
    STEP_GENERIC,
    STEP_STATUS_ACTIVE,
    STEP_TYPE_CHECKPOINT,
    STEP_TYPE_ERROR_MESSAGE,
    STEP_TYPE_FINISH,
    STEP_TYPE_INVOKE_SUBAGENT,
    STEP_TYPE_PLANNER_RESPONSE,
    UUID_RE,
    Step,
    collect_stats,
    extract_model_id,
    extract_model_name,
    extract_request_budget,
    infer_context_limit,
    pct,
    sqlite_ro_uri,
)
from .protobuf import Msg

TERMINAL_STEP_TYPES = frozenset({
    STEP_TYPE_FINISH,
    STEP_TYPE_PLANNER_RESPONSE,
    STEP_TYPE_ERROR_MESSAGE,
})
SUBAGENT_THINKING_WINDOW_SEC = 180.0


def _recent_db_mtime(db_path: Path) -> float:
    mtime = 0.0
    for cand in (db_path, db_path.with_name(f"{db_path.name}-wal")):
        try:
            st = cand.stat()
            if st.st_mtime > mtime:
                mtime = st.st_mtime
        except OSError:
            pass
    return mtime


def quick_subagent_stats(sub_db: Path, catalog: dict) -> dict | None:
    """Fast read-only summary for a subagent conversation database."""
    if not sub_db.is_file():
        return None
    uri = sqlite_ro_uri(sub_db)
    try:
        con = sqlite3.connect(uri, uri=True, timeout=1.5, isolation_level=None)
        began = False
        try:
            con.execute("BEGIN")
            began = True
            last_step = con.execute(
                "SELECT idx, step_type, status FROM steps ORDER BY idx DESC LIMIT 1"
            ).fetchone()
            has_active_step = bool(
                con.execute(
                    "SELECT 1 FROM steps WHERE status IN (?, ?) LIMIT 1",
                    STEP_STATUS_ACTIVE,
                ).fetchone()
            )
            gen_rows = con.execute(
                "SELECT data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx DESC LIMIT 5"
            ).fetchall()
            gen: Msg | None = None
            for (data,) in gen_rows:
                if not isinstance(data, (bytes, bytearray, memoryview)) or not data:
                    continue
                cand = Msg(data)
                if cand.msg(GEN_CHAT_FIELD) is not None:
                    gen = cand
                    break

            step_rows = []
            chat = gen.msg(GEN_CHAT_FIELD) if gen is not None else None
            chat_start = chat.msg(CHAT_START_FIELD) if chat is not None else None
            cwm = chat_start.msg(CHAT_START_CWM_FIELD) if chat_start is not None else None
            has_breakdown = cwm is not None and cwm.msg(CWM_BREAKDOWN_FIELD) is not None

            if gen is None or not has_breakdown:
                step_rows = con.execute(
                    "SELECT idx, step_payload, step_type, status, metadata FROM steps ORDER BY idx ASC"
                ).fetchall()
            else:
                gen_ck = (
                    chat_start.int(CHAT_START_CHECKPOINT_FIELD, signed32=True)
                    if chat_start is not None
                    else -1
                )
                ck_row = con.execute(
                    "SELECT idx, step_payload, step_type, status, metadata FROM steps "
                    "WHERE step_type = ? AND status = ? ORDER BY idx DESC LIMIT 1",
                    (STEP_TYPE_CHECKPOINT, STATUS_DONE),
                ).fetchone()
                if ck_row is not None:
                    ck_step = Step(*ck_row)
                    ck_payload = ck_step.payload(STEP_CHECKPOINT)
                    if ck_payload is not None and ck_payload.int(CHECKPOINT_INDEX_FIELD) > gen_ck:
                        step_rows = con.execute(
                            "SELECT idx, step_payload, step_type, status, metadata FROM steps "
                            "WHERE idx >= ? ORDER BY idx ASC",
                            (ck_row[0],),
                        ).fetchall()
        finally:
            if began:
                try:
                    con.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
            con.close()
    except Exception:
        return None

    steps = [Step(i, pl, st, s, md) for i, pl, st, s, md in step_rows]
    mid = extract_model_id(gen)
    cat_entry = catalog.get(mid) if isinstance(catalog, dict) else None
    if not isinstance(cat_entry, dict):
        cat_entry = {}
    try:
        cat_limit = int(cat_entry.get("maxTokens") or 0)
    except (TypeError, ValueError):
        cat_limit = 0
    limit = cat_limit if cat_limit > 0 else infer_context_limit(gen)
    display_name = cat_entry.get("displayName")
    model = display_name if isinstance(display_name, str) and display_name else extract_model_name(gen)
    budget = extract_request_budget(gen)
    st, _ = collect_stats(steps, gen, limit)
    used = st["total"]

    if last_step is None:
        status = "starting"
    elif has_active_step:
        status = "running"
    elif last_step[1] not in TERMINAL_STEP_TYPES and (time.time() - _recent_db_mtime(sub_db)) <= SUBAGENT_THINKING_WINDOW_SEC:
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


def _extract_subagent_id(step: Step, self_id: str) -> str:
    """Extract spawned subagent conversation UUID from generic or native step payloads."""
    candidates: list[str] = []
    if step.generic_result_text:
        candidates.append(step.generic_result_text)
    generic = step.pb.msg(STEP_GENERIC)
    if generic is not None:
        res = generic.msg(2)
        if res is not None and res.str(1):
            candidates.append(res.str(1))

    if not candidates:
        for fn, vals in step.pb.fields.items():
            if fn in STEP_ENVELOPE_FIELDS:
                continue
            for v in vals:
                if isinstance(v, bytes):
                    decoded = v.decode("utf-8", errors="ignore")
                    if decoded:
                        candidates.append(decoded)

    for text in candidates:
        for m in CONV_ID_JSON_RE.finditer(text):
            cid = m.group(1).lower()
            if cid != self_id:
                return cid
    for text in candidates:
        for cand in UUID_RE.findall(text):
            if cand.lower() != self_id:
                return cand.lower()
    return ""


def _iter_swarm_member_entries(raw) -> list[tuple[str, dict]]:
    """Normalize Swarm members.json shapes (list, dict, or {members: ...}) into (roster_name, obj)."""
    if isinstance(raw, dict) and "members" in raw:
        raw = raw["members"]
    entries: list[tuple[str, dict]] = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                name = str(item.get("name") or item.get("roster_name") or item.get("role") or "")
                entries.append((name, item))
    elif isinstance(raw, dict):
        for key, item in raw.items():
            if isinstance(item, dict):
                name = str(item.get("name") or item.get("roster_name") or item.get("role") or key)
                entries.append((name, item))
    return entries


def _load_swarm_members(db_path: Path) -> list[dict]:
    """Read Swarm workers from <appData>/brain/<convId>/.system_generated/swarm/members.json."""
    resolved = db_path.resolve()
    members_path = (
        resolved.parent.parent / "brain" / resolved.stem / ".system_generated" / "swarm" / "members.json"
    )
    if not members_path.is_file():
        return []
    try:
        raw = json.loads(members_path.read_text(encoding="utf-8"))
    except Exception:
        return []

    out: list[dict] = []
    for name, item in _iter_swarm_member_entries(raw):
        cid_raw = str(
            item.get("conversation_id")
            or item.get("conversationId")
            or item.get("conv_id")
            or item.get("id")
            or ""
        ).strip()
        m = UUID_RE.search(cid_raw)
        if not m:
            continue
        state = str(item.get("state") or item.get("status") or "").strip().lower()
        model = str(
            item.get("model_display_name")
            or item.get("modelDisplayName")
            or item.get("model")
            or item.get("model_id")
            or ""
        ).strip()
        out.append({
            "conversation_id": m.group(0).lower(),
            "role": name or "worker",
            "model": model,
            "state": state,
        })
    return out


def extract_subagents(steps: list[Step], db_path: Path, catalog: dict) -> list[dict]:
    """Discover child subagents (invoke_subagent) and Swarm workers (members.json)."""
    conv_dir = db_path.parent
    self_id = db_path.stem.lower()
    seen: set[str] = set()
    out: list[dict] = []

    for step in steps:
        tc = step.md.msg(MD_TOOL_CALL_FIELD)
        tc_name = tc.str(2) if tc is not None else ""
        if tc_name != "invoke_subagent" and step.type != STEP_TYPE_INVOKE_SUBAGENT:
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

        sub_id = _extract_subagent_id(step, self_id)

        if not sub_id or sub_id == self_id or sub_id in seen:
            continue
        seen.add(sub_id)

        stats = quick_subagent_stats(conv_dir / f"{sub_id}.db", catalog)
        out.append({
            "conversation_id": sub_id,
            "source": "subagent",
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

    for member in _load_swarm_members(db_path):
        sub_id = member["conversation_id"]
        if not sub_id or sub_id == self_id or sub_id in seen:
            continue
        seen.add(sub_id)

        stats = quick_subagent_stats(conv_dir / f"{sub_id}.db", catalog)
        raw_state = member["state"]
        if raw_state == "killed":
            status = "killed"
        elif raw_state in ("working", "running"):
            status = "running"
        elif raw_state in ("waiting", "idle", "stopped"):
            status = raw_state
        else:
            status = stats["status"] if stats else "starting"

        out.append({
            "conversation_id": sub_id,
            "source": "swarm",
            "role": member["role"],
            "type_name": "swarm",
            "requested_model": member["model"],
            "model": stats["model"] if stats else (member["model"] or "Pending"),
            "used_tokens": stats["used_tokens"] if stats else 0,
            "limit_tokens": stats["limit_tokens"] if stats else 0,
            "used_pct": stats["used_pct"] if stats else 0.0,
            "request_budget_tokens": stats["request_budget_tokens"] if stats else 0,
            "budget_pct": stats["budget_pct"] if stats else 0.0,
            "status": status,
            "swarm_state": raw_state,
            "has_db": bool(stats is not None),
        })

    return out
