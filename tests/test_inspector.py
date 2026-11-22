"""End-to-end unit tests for Antigravity Context Inspector (stdlib only)."""

from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
INSPECTOR_DIR = ROOT / "sidecars" / "inspector"
sys.path.insert(0, str(INSPECTOR_DIR))

from inspector import build_snapshot  # noqa: E402
from lib.protobuf import Msg, encode_varint  # noqa: E402


# --- Minimal protobuf wire encoders for synthetic test DBs -------------------


def pb_varint(fn: int, val: int) -> bytes:
    if val < 0:
        val &= (1 << 64) - 1
    return encode_varint((fn << 3) | 0) + encode_varint(val)


def pb_bytes(fn: int, data: bytes) -> bytes:
    return encode_varint((fn << 3) | 2) + encode_varint(len(data)) + data


def pb_str(fn: int, text: str) -> bytes:
    return pb_bytes(fn, text.encode("utf-8"))


def create_empty_db(db_path: Path):
    con = sqlite3.connect(db_path)
    con.executescript(
        """
        CREATE TABLE steps (
            idx INTEGER PRIMARY KEY,
            step_type INTEGER NOT NULL DEFAULT 0,
            status INTEGER NOT NULL DEFAULT 0,
            has_subtrajectory NUMERIC NOT NULL DEFAULT 0,
            metadata BLOB,
            error_details BLOB,
            permissions BLOB,
            task_details BLOB,
            render_info BLOB,
            step_payload BLOB,
            step_format INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE gen_metadata (
            idx INTEGER PRIMARY KEY,
            data BLOB,
            size INTEGER NOT NULL DEFAULT 0
        );
        """
    )
    con.commit()
    return con


def make_group(gtype: int, name: str, total: int, children: list[tuple[str, int]]) -> bytes:
    out = pb_str(1, name) + pb_varint(2, gtype) + pb_varint(4, total)
    for cname, ctok in children:
        out += pb_bytes(5, pb_str(1, cname) + pb_varint(3, ctok))
    return out


class TestProtobuf(unittest.TestCase):
    def test_roundtrip_fields(self):
        raw = pb_varint(1, 42) + pb_str(2, "hello") + pb_bytes(3, pb_varint(1, 99))
        msg = Msg(raw)
        self.assertEqual(msg.int(1), 42)
        self.assertEqual(msg.str(2), "hello")
        nested = msg.msg(3)
        self.assertIsNotNone(nested)
        self.assertEqual(nested.int(1), 99)


class TestInspectorEndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _build_full_conversation_db(self, conv_id: str, subagent_id: str | None = None) -> Path:
        db_path = self.tmp_path / f"{conv_id}.db"
        con = create_empty_db(db_path)

        # Build synthetic gen_metadata with exact breakdown + content
        breakdown = (
            pb_bytes(1, make_group(1, "System Prompt", 1200, [("identity", 300), ("guidelines", 900)]))
            + pb_bytes(1, make_group(5, "Skills", 800, [("skills", 800)]))
            + pb_bytes(1, make_group(2, "Tools", 600, [("read_file", 600)]))
            + pb_bytes(1, make_group(4, "MCP Tools", 400, [("mcp_github_search", 400)]))
            + pb_bytes(
                1,
                make_group(
                    7,
                    "Chat Messages",
                    2500,
                    [("0: USER_INPUT", 200), ("1: PLANNER_RESPONSE", 500), ("2: GENERIC", 1800)],
                ),
            )
        )
        cwm = pb_bytes(3, breakdown) + pb_varint(4, 512_000)
        chat_start = pb_varint(2, -1) + pb_bytes(10, cwm)

        usage = (
            pb_varint(2, 500)      # uncached input
            + pb_varint(3, 450)    # output
            + pb_varint(5, 5000)   # cached input
            + pb_varint(9, 120)    # thinking
            + pb_varint(10, 330)   # response
        )

        # System sections (chat[16])
        sec_identity = pb_str(1, "identity") + pb_str(2, "You are Antigravity.") + pb_varint(6, 1)
        sec_guidelines = pb_str(1, "guidelines") + pb_str(2, "Follow best practices.") + pb_varint(6, 1)
        sec_skills = pb_str(1, "skills") + pb_str(2, "Available skills: plugin") + pb_varint(6, 5)

        # Tool declarations (chat[8])
        tool_read = pb_str(1, "read_file") + pb_str(2, "Read a file") + pb_str(3, '{"type":"object"}')
        tool_mcp = pb_str(1, "mcp_github_search") + pb_str(2, "Search GitHub") + pb_str(3, '{"type":"object"}')

        # Chat messages (chat[2])
        msg_user = pb_varint(2, 1) + pb_str(3, "Inspect this repo") + pb_varint(4, 200) + pb_varint(18, 0)
        tc_call = pb_str(1, "call_1") + pb_str(2, "read_file") + pb_str(3, '{"Path":"/app/main.py"}')
        msg_agent = (
            pb_varint(2, 2)
            + pb_varint(4, 500)
            + pb_bytes(6, tc_call)
            + pb_str(11, "Let me read main.py first.")
            + pb_varint(18, 1)
        )
        msg_tool = (
            pb_varint(2, 4)
            + pb_str(3, "print('hello')")
            + pb_varint(4, 1800)
            + pb_str(7, "call_1")
            + pb_varint(18, 2)
        )

        chat = (
            pb_str(1, "You are Antigravity.\nFollow best practices.")
            + pb_bytes(2, msg_user)
            + pb_bytes(2, msg_agent)
            + pb_bytes(2, msg_tool)
            + pb_bytes(4, usage)
            + pb_bytes(8, tool_read)
            + pb_bytes(8, tool_mcp)
            + pb_bytes(9, chat_start)
            + pb_bytes(16, sec_identity)
            + pb_bytes(16, sec_guidelines)
            + pb_bytes(16, sec_skills)
            + pb_str(19, "gemini-4-neon-high")
            + pb_str(21, "Gemini 4 Neon (High)")
        )
        gen = pb_bytes(1, chat)
        con.execute("INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)", (gen, len(gen)))

        if subagent_id:
            tc_sub = pb_str(2, "invoke_subagent") + pb_str(
                3,
                json.dumps({"Role": "Codebase Researcher", "TypeName": "research", "Model": "flash_lite"}),
            )
            md_sub = pb_bytes(4, tc_sub)
            res_text = f'Created the following subagent:\n{{"conversationId": "{subagent_id}"}}'
            generic = pb_bytes(2, pb_str(1, res_text))
            step_pl = pb_varint(1, 132) + pb_varint(4, 3) + pb_bytes(5, md_sub) + pb_bytes(140, generic)
            con.execute(
                "INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (3, 132, 3, ?, ?)",
                (md_sub, step_pl),
            )

        con.commit()
        con.close()
        return db_path

    def test_exact_breakdown_content_and_subagents(self):
        sub_id = "11111111-2222-3333-4444-555555555555"
        main_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

        self._build_full_conversation_db(sub_id)
        main_db = self._build_full_conversation_db(main_id, subagent_id=sub_id)

        snap = build_snapshot(main_db)
        s = snap["summary"]
        c = snap["content"]

        # Totals & model info
        self.assertEqual(s["model"], "Gemini 4 Neon (High)")
        self.assertEqual(s["limit_tokens"], 1_048_576)
        self.assertEqual(s["request_budget_tokens"], 512_000)
        self.assertEqual(s["used_tokens"], 1200 + 800 + 600 + 400 + 2500)
        self.assertTrue(s["has_breakdown"])

        # API cache hit ratio: 5000 / (500 + 5000) = 90.9%
        self.assertAlmostEqual(s["api_usage"]["cache_hit_pct"], 90.9, places=1)

        # System sections
        self.assertEqual(len(c["system_sections"]), 3)
        by_name = {x["name"]: x for x in c["system_sections"]}
        self.assertEqual(by_name["identity"]["tokens"], 300)
        self.assertEqual(by_name["skills"]["group_type"], 5)

        # Tools (built-in vs MCP)
        tools_by_name = {x["name"]: x for x in c["tools"]}
        self.assertFalse(tools_by_name["read_file"]["is_mcp"])
        self.assertTrue(tools_by_name["mcp_github_search"]["is_mcp"])
        self.assertEqual(tools_by_name["mcp_github_search"]["tokens"], 400)

        # Messages & linked tool result
        self.assertEqual(len(c["messages"]), 3)
        self.assertEqual(c["messages"][0]["role"], "user")
        self.assertTrue(c["messages"][1]["has_thinking"])
        self.assertEqual(c["messages"][2]["role"], "tool")
        self.assertEqual(c["messages"][2]["tool_name"], "read_file")

        # Subagent discovery
        self.assertEqual(len(s["subagents"]), 1)
        sa = s["subagents"][0]
        self.assertEqual(sa["conversation_id"], sub_id)
        self.assertEqual(sa["role"], "Codebase Researcher")
        self.assertEqual(sa["used_tokens"], 5500)
        self.assertTrue(sa["has_db"])

    def test_pre_generation_step_fallback(self):
        db_path = self.tmp_path / "bbbbbbbb-1111-2222-3333-444444444444.db"
        con = create_empty_db(db_path)
        ui_payload = pb_str(2, "Hello Antigravity! " * 20)
        step_pl = pb_varint(1, 14) + pb_varint(4, 3) + pb_bytes(19, ui_payload)
        con.execute(
            "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (0, 14, 3, ?)",
            (step_pl,),
        )
        con.commit()
        con.close()

        snap = build_snapshot(db_path)
        self.assertFalse(snap["summary"]["has_breakdown"])
        self.assertGreater(snap["summary"]["used_tokens"], 0)
        self.assertEqual(len(snap["content"]["messages"]), 1)
        self.assertEqual(snap["content"]["messages"][0]["role"], "user")

    def test_cli_json_invocation(self):
        db_path = self._build_full_conversation_db("cccccccc-1111-2222-3333-444444444444")
        proc = subprocess.run(
            [sys.executable, str(INSPECTOR_DIR / "inspector.py"), "--db", str(db_path), "--json"],
            capture_output=True,
            text=True,
            check=True,
        )
        parsed = json.loads(proc.stdout)
        self.assertEqual(parsed["summary"]["used_tokens"], 5500)


if __name__ == "__main__":
    unittest.main()
