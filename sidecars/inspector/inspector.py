#!/usr/bin/env python3
"""CLI entrypoint & snapshot assembler for Antigravity Context Inspector.

Reads ~/.gemini/antigravity/conversations/<uuid>.db (read-only) and outputs
either a concise CLI summary or a structured JSON snapshot used by the sidecar.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

# Ensure sibling lib/ is importable regardless of working directory
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.accounting import (
    CATEGORIES,
    collect_stats,
    detect_system_files,
    extract_model_id,
    extract_model_name,
    extract_request_budget,
    extract_subagents,
    fmt_tok,
    grid_segments,
    infer_context_limit,
    load_db,
    pct,
    stats_heading,
)
from lib.content import extract_content_items


def render_cli_text(report: dict) -> str:
    limit_str = fmt_tok(report["limit_tokens"]) if report["limit_tokens"] else "Unknown"
    lines = [
        f"{report['model']} · {fmt_tok(report['used_tokens'])}/{limit_str} tokens ({report['used_pct']:.1f}%)",
        report["heading"],
    ]
    if report["request_budget_tokens"]:
        lines.append(
            f"Request budget: {fmt_tok(report['used_tokens'])}/{fmt_tok(report['request_budget_tokens'])} ({report['budget_pct']:.1f}%)"
        )
    lines.append("")
    for c in report["categories"]:
        lines.append(f"  {c['name']:<20} {fmt_tok(c['tokens']):>8} ({c['pct']:>5.1f}%)")
    lines.append(
        f"  {'Free space':<20} {fmt_tok(report['free_tokens']):>8} ({pct(report['free_tokens'], report['limit_tokens']):>5.1f}%)"
    )
    if report["checkpoint_buffer"]:
        lines.append(f"  {'Checkpoint buffer':<20} {fmt_tok(report['checkpoint_buffer']):>8} (excluded)")
    if report.get("subagents"):
        lines.append("")
        lines.append(f"Subagents ({len(report['subagents'])}):")
        for sa in report["subagents"]:
            lines.append(f"  - {sa['role']} ({sa['model']}): {fmt_tok(sa['used_tokens'])} tokens [{sa['status']}]")
    return "\n".join(lines)


def build_snapshot(
    db_path: Path,
    workspace: str | None = None,
    catalog_path: str | None = None,
    app_dir: str = "antigravity",
) -> dict:
    steps, stats_gen, content_gen = load_db(db_path)

    catalog: dict = {}
    catalog_entry: dict = {}
    mid = extract_model_id(stats_gen)
    if catalog_path and Path(catalog_path).is_file():
        try:
            with open(catalog_path, encoding="utf-8") as fh:
                catalog = json.load(fh)
            catalog_entry = catalog.get(mid) or {}
        except Exception:
            catalog = {}
            catalog_entry = {}

    limit = int(catalog_entry.get("maxTokens") or 0) or infer_context_limit(stats_gen)
    model = catalog_entry.get("displayName") or extract_model_name(stats_gen)
    budget = extract_request_budget(stats_gen)

    st, breakdown = collect_stats(steps, stats_gen, limit)
    content_breakdown = breakdown
    if content_gen is not None and content_gen is not stats_gen:
        c_chat = content_gen.msg(1)
        c_start = c_chat.msg(9) if c_chat is not None else None
        c_cwm = c_start.msg(10) if c_start is not None else None
        content_breakdown = c_cwm.msg(3) if c_cwm is not None else breakdown

    content = extract_content_items(steps, content_gen, content_breakdown, st["total"])
    system_files = detect_system_files(os.path.expanduser("~"), workspace, app_dir)
    subagents = extract_subagents(steps, db_path, catalog)

    categories_out = [
        {
            "name": name,
            "key": key,
            "group": grp,
            "tokens": st[key],
            "pct": round(pct(st[key], limit), 1),
        }
        for name, key, always, grp in CATEGORIES
        if always or st[key]
    ]

    used = st["total"]
    summary = {
        "conversation_id": db_path.stem,
        "model": model,
        "model_id": mid,
        "heading": stats_heading(st),
        "used_tokens": used,
        "limit_tokens": limit,
        "used_pct": round(min(100.0, pct(used, limit)), 1) if limit else 0.0,
        "free_tokens": max(0, limit - used) if limit else 0,
        "request_budget_tokens": budget,
        "budget_pct": round(min(100.0, pct(used, budget)), 1) if budget else 0.0,
        "has_breakdown": st["has_breakdown"],
        "compacted": st["compacted"],
        "checkpoint_buffer": st["checkpoint"],
        "active_checkpoint": st["active_checkpoint"],
        "checkpoints": st["checkpoints"],
        "grid_segments": grid_segments(st),
        "categories": categories_out,
        "api_usage": st["api_usage"],
        "knowledge_files": st["knowledge_files"],
        "artifact_files": st["artifact_files"],
        "skill_files": st["skill_files"],
        "system_files": system_files,
        "subagents": subagents,
        "counts": {
            "system_sections": len(content["system_sections"]),
            "tools": len(content["tools"]),
            "messages": len(content["messages"]),
            "subagents": len(subagents),
        },
        "has_full_content": bool(content_gen is not None),
    }
    summary["cli_text"] = render_cli_text(summary)

    fp_src = json.dumps(
        [
            summary["used_tokens"],
            summary["limit_tokens"],
            summary["model"],
            summary["counts"],
            len(steps),
            st["active_checkpoint"],
            [(sa["conversation_id"], sa["used_tokens"], sa["status"]) for sa in subagents],
        ],
        sort_keys=True,
    )
    summary["fingerprint"] = hashlib.sha1(fp_src.encode("utf-8")).hexdigest()[:12]

    return {
        "summary": summary,
        "content": content,
    }


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Antigravity Context Inspector parser")
    parser.add_argument("--db", help="Path to a conversation .db file")
    parser.add_argument("--conversation-id", help="Conversation UUID (latest if omitted)")
    parser.add_argument("--workspace", default=None, help="Active workspace folder path")
    parser.add_argument("--model-catalog", default=None, help="Path to cached model catalog JSON")
    parser.add_argument("--json", action="store_true", help="Output structured JSON snapshot")
    args = parser.parse_args()

    if args.db:
        db_path = Path(args.db).expanduser()
    else:
        conv_dir = Path.home() / ".gemini" / "antigravity" / "conversations"
        if args.conversation_id:
            db_path = conv_dir / f"{args.conversation_id}.db"
        else:
            dbs = sorted(conv_dir.glob("*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
            if not dbs:
                raise SystemExit("No conversation databases found.")
            db_path = dbs[0]

    if not db_path.is_file():
        raise SystemExit(f"Conversation database not found: {db_path}")

    snapshot = build_snapshot(db_path, args.workspace, args.model_catalog)
    if args.json:
        print(json.dumps(snapshot, ensure_ascii=False))
    else:
        print(snapshot["summary"]["cli_text"])


if __name__ == "__main__":
    main()
