"""End-to-end unit tests for Antigravity Context Inspector (stdlib only)."""

from __future__ import annotations

import json
import os
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
from lib.accounting import (  # noqa: E402
    Step,
    compaction_tokens,
    detect_system_files,
    extract_turn_telemetry,
    infer_context_limit,
    load_db_with_history,
    shorten_path,
)
from lib.content import extract_mcp_server, make_preview  # noqa: E402
from lib.protobuf import Msg, encode_varint, iter_fields, read_varint  # noqa: E402
from lib.subagents import _extract_subagent_id, quick_subagent_stats  # noqa: E402


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

    def test_varint_bounds_and_non_bytes_guards(self):
        # 10-byte valid 64-bit unsigned varint (e.g. -1 as uint64)
        neg1_bytes = encode_varint((1 << 64) - 1)
        self.assertEqual(len(neg1_bytes), 10)
        val, pos = read_varint(neg1_bytes, 0)
        self.assertEqual(val, (1 << 64) - 1)
        self.assertEqual(pos, 10)

        # >10-byte varint raises overflow
        with self.assertRaises(ValueError):
            read_varint(b"\x80" * 10 + b"\x01", 0)
        with self.assertRaises(ValueError):
            read_varint(b"\x80" * 10, 0)

        # Negative encode_varint rejected
        with self.assertRaises(ValueError):
            encode_varint(-1)

        # Non-bytes inputs handled cleanly by Msg and iter_fields
        for bad in (None, 123, "not-bytes", []):
            self.assertEqual(Msg(bad).fields, {})
            self.assertEqual(list(iter_fields(bad)), [])

        # bytearray and memoryview work cleanly with Msg
        raw = pb_str(2, "ok")
        self.assertEqual(Msg(bytearray(raw)).str(2), "ok")
        self.assertEqual(Msg(memoryview(raw)).str(2), "ok")


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

    def test_system_prompt_subgroups_alignment(self):
        db_path = self.tmp_path / "dddddddd-1111-2222-3333-444444444444.db"
        con = create_empty_db(db_path)

        breakdown = pb_bytes(
            1,
            make_group(
                1,
                "System Prompt",
                1100,
                [("identity", 300), ("skills", 400), ("subagents", 250), ("flows", 150)],
            ),
        )
        cwm = pb_bytes(3, breakdown) + pb_varint(4, 256_000)
        chat_start = pb_varint(2, -1) + pb_bytes(10, cwm)

        # Sections nested under group_type=1 or unset (0)
        sec_identity = pb_str(1, "identity") + pb_str(2, "Identity text") + pb_varint(6, 1)
        sec_skills = pb_str(1, "skills") + pb_str(2, "Skills list") + pb_varint(6, 1)
        sec_subagents = pb_str(1, "subagents") + pb_str(2, "Subagent list")
        sec_flows = pb_str(1, "flows") + pb_str(2, "Workflows list") + pb_varint(6, 1)

        chat = (
            pb_bytes(9, chat_start)
            + pb_bytes(16, sec_identity)
            + pb_bytes(16, sec_skills)
            + pb_bytes(16, sec_subagents)
            + pb_bytes(16, sec_flows)
            + pb_str(19, "gemini-4-neon-high")
        )
        gen = pb_bytes(1, chat)
        con.execute("INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)", (gen, len(gen)))
        con.commit()
        con.close()

        snap = build_snapshot(db_path)
        cats = {c["key"]: c["tokens"] for c in snap["summary"]["categories"]}
        self.assertEqual(cats["system_prompt"], 300)
        self.assertEqual(cats["skills"], 400)
        self.assertEqual(cats["subagents"], 250)
        self.assertEqual(cats["workflows"], 150)

        secs = {s["name"]: s for s in snap["content"]["system_sections"]}
        self.assertEqual(secs["identity"]["group_type"], 1)
        self.assertEqual(secs["skills"]["group_type"], 5)
        self.assertEqual(secs["skills"]["group"], "Skills")
        self.assertEqual(secs["subagents"]["group_type"], 6)
        self.assertEqual(secs["subagents"]["group"], "Subagents")
        self.assertEqual(secs["flows"]["group_type"], 10)
        self.assertEqual(secs["flows"]["group"], "Workflows")

    def test_subagent_rehydrated_and_native_step_types(self):
        sub_rehydrated = "22222222-3333-4444-5555-666666666666"
        sub_native = "33333333-4444-5555-6666-777777777777"
        main_id = "eeeeeeee-1111-2222-3333-444444444444"

        self._build_full_conversation_db(sub_rehydrated)
        self._build_full_conversation_db(sub_native)

        db_path = self.tmp_path / f"{main_id}.db"
        con = create_empty_db(db_path)

        # 1) GENERIC step that rehydrates into step_type=127 via packed original step
        tc1 = pb_str(2, "invoke_subagent") + pb_str(3, json.dumps({"Role": "Rehydrated Worker", "TypeName": "research"}))
        md1 = pb_bytes(4, tc1)
        orig_step = pb_varint(1, 127) + pb_varint(4, 3) + pb_bytes(5, md1)
        packed_any = pb_str(1, "type.googleapis.com/gemini_coder.Step") + pb_bytes(2, orig_step)
        generic_res = pb_str(1, f'{{"conversationId": "{sub_rehydrated}"}}') + pb_bytes(6, packed_any)
        step1_pl = pb_varint(1, 132) + pb_varint(4, 3) + pb_bytes(5, md1) + pb_bytes(140, pb_bytes(2, generic_res))
        con.execute(
            "INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (0, 132, 3, ?, ?)",
            (md1, step1_pl),
        )

        # 2) Native INVOKE_SUBAGENT (step_type=127) without STEP_GENERIC wrapper
        tc2 = pb_str(2, "invoke_subagent") + pb_str(3, json.dumps({"Role": "Native Worker", "TypeName": "browser"}))
        md2 = pb_bytes(4, tc2)
        native_payload = pb_str(1, sub_native)
        step2_pl = pb_varint(1, 127) + pb_varint(4, 3) + pb_bytes(5, md2) + pb_bytes(130, native_payload)
        con.execute(
            "INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (1, 127, 3, ?, ?)",
            (md2, step2_pl),
        )
        con.commit()
        con.close()

        snap = build_snapshot(db_path)
        subs = {sa["conversation_id"]: sa for sa in snap["summary"]["subagents"]}
        self.assertIn(sub_rehydrated, subs)
        self.assertEqual(subs[sub_rehydrated]["role"], "Rehydrated Worker")
        self.assertIn(sub_native, subs)
        self.assertEqual(subs[sub_native]["role"], "Native Worker")

    def test_quick_subagent_stats_compaction_and_null_gen_row(self):
        sub_id = "44444444-5555-6666-7777-888888888888"
        main_id = "ffffffff-1111-2222-3333-444444444444"

        sub_db = self._build_full_conversation_db(sub_id)
        con = sqlite3.connect(sub_db)
        # Add a trailing NULL gen_metadata row and a completed compaction checkpoint newer than gen_ck=-1
        con.execute("INSERT INTO gen_metadata (idx, data, size) VALUES (1, NULL, 0)")
        ck_payload = pb_varint(1, 1) + pb_str(4, "Short compacted summary.")
        ck_step = pb_varint(1, 23) + pb_varint(4, 3) + pb_bytes(30, ck_payload)
        con.execute(
            "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (10, 23, 3, ?)",
            (ck_step,),
        )
        ui_step = pb_varint(1, 14) + pb_varint(4, 3) + pb_bytes(19, pb_str(2, "Continue after compact"))
        con.execute(
            "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (11, 14, 3, ?)",
            (ui_step,),
        )
        con.commit()
        con.close()

        main_db = self._build_full_conversation_db(main_id, subagent_id=sub_id)
        full_sub = build_snapshot(sub_db)["summary"]
        main_snap = build_snapshot(main_db)["summary"]
        sa = main_snap["subagents"][0]

        self.assertTrue(full_sub["compacted"])
        self.assertEqual(sa["used_tokens"], full_sub["used_tokens"])
        self.assertLess(sa["used_tokens"], 5500)

    def test_special_chars_in_db_path(self):
        special_dir = self.tmp_path / "folder #1 %20 space"
        special_dir.mkdir()
        src = self._build_full_conversation_db("55555555-6666-7777-8888-999999999999")
        dst = special_dir / src.name
        dst.write_bytes(src.read_bytes())

        snap = build_snapshot(dst)
        self.assertEqual(snap["summary"]["used_tokens"], 5500)

    def test_fingerprint_tracks_api_usage_and_budget(self):
        db_path = self.tmp_path / "66666666-7777-8888-9999-aaaaaaaaaaaa.db"

        def write_db(budget: int, output_tokens: int):
            if db_path.exists():
                db_path.unlink()
            con = create_empty_db(db_path)
            breakdown = pb_bytes(
                1, make_group(1, "System Prompt", 1000, [("identity", 1000)])
            )
            cwm = pb_bytes(3, breakdown) + pb_varint(4, budget)
            chat_start = pb_varint(2, -1) + pb_bytes(10, cwm)
            usage = pb_varint(2, 200) + pb_varint(3, output_tokens) + pb_varint(5, 800)
            chat = (
                pb_bytes(4, usage)
                + pb_bytes(9, chat_start)
                + pb_str(19, "gemini-4-neon-high")
                + pb_str(21, "Gemini 4 Neon (High)")
            )
            gen = pb_bytes(1, chat)
            con.execute("INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)", (gen, len(gen)))
            con.commit()
            con.close()

        write_db(budget=512_000, output_tokens=100)
        fp_base = build_snapshot(db_path)["summary"]["fingerprint"]

        write_db(budget=512_000, output_tokens=999)
        fp_usage = build_snapshot(db_path)["summary"]["fingerprint"]
        self.assertNotEqual(fp_base, fp_usage)

        write_db(budget=256_000, output_tokens=100)
        fp_budget = build_snapshot(db_path)["summary"]["fingerprint"]
        self.assertNotEqual(fp_base, fp_budget)

    def test_turn_history_and_session_cache_drop(self):
        db_path = self.tmp_path / "77777777-8888-9999-aaaa-bbbbbbbbbbbb.db"
        con = create_empty_db(db_path)

        def insert_turn(idx: int, uncached: int, cached: int, out_tok: int, think_tok: int, ck: int = -1):
            usage = (
                pb_varint(2, uncached)
                + pb_varint(3, out_tok)
                + pb_varint(5, cached)
                + pb_varint(9, think_tok)
            )
            chat_start = pb_varint(2, ck)
            chat = pb_bytes(4, usage) + pb_bytes(9, chat_start) + pb_str(19, "gemini-4-neon-high")
            gen = pb_bytes(1, chat)
            con.execute("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)", (idx, gen, len(gen)))

        # Turn 1: cold (10k uncached, 0 cached)
        insert_turn(0, 10_000, 0, 500, 100, ck=-1)
        # Turn 2: warm (2k uncached, 18k cached -> 90%, total 20k, delta +10k)
        insert_turn(1, 2_000, 18_000, 700, 200, ck=-1)
        # Turn 3: warm (1.5k uncached, 28.5k cached -> 95%, total 30k, delta +10k)
        insert_turn(2, 1_500, 28_500, 800, 150, ck=-1)
        # Turn 4: unexpected cache drop (34k uncached, 6k cached -> 15%, total 40k, delta +10k)
        insert_turn(3, 34_000, 6_000, 600, 50, ck=-1)
        con.commit()

        snap = build_snapshot(db_path)["summary"]
        hist = snap["history"]
        su = snap["session_usage"]

        self.assertEqual(len(hist), 4)
        self.assertEqual([h["tokens"] for h in hist], [10_000, 20_000, 30_000, 40_000])
        self.assertEqual([h["delta"] for h in hist], [0, 10_000, 10_000, 10_000])
        self.assertEqual(su["turns"], 4)
        self.assertEqual(su["total_output_tokens"], 2600)
        self.assertEqual(su["total_thinking_tokens"], 500)
        # Weighted avg excluding turn 1: (18000 + 28500 + 6000) / (20000 + 30000 + 40000) = 52500 / 90000 = 58.3%
        self.assertAlmostEqual(su["avg_cache_hit_pct"], 58.3, places=1)
        self.assertTrue(su["cache_drop"])
        self.assertFalse(su["cache_drop_after_compact"])

        # Turn 5: post-compaction cold turn (ck=1, 15k total, 1.5k cached -> 10%, delta -25k)
        insert_turn(4, 13_500, 1_500, 400, 0, ck=1)
        con.commit()
        con.close()

        snap2 = build_snapshot(db_path)["summary"]
        self.assertTrue(snap2["history"][-1]["compacted"])
        self.assertEqual(snap2["history"][-1]["delta"], -25_000)
        self.assertFalse(snap2["session_usage"]["cache_drop"])
        self.assertTrue(snap2["session_usage"]["cache_drop_after_compact"])

    def test_non_caching_model_does_not_trigger_cache_drop(self):
        db_path = self.tmp_path / "88888888-9999-aaaa-bbbb-cccccccccccc.db"
        con = create_empty_db(db_path)
        for i in range(3):
            usage = pb_varint(2, 5000 * (i + 1)) + pb_varint(3, 200) + pb_varint(5, 0)
            gen = pb_bytes(1, pb_bytes(4, usage) + pb_str(19, "gpt-oss"))
            con.execute("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)", (i, gen, len(gen)))
        con.commit()
        con.close()

        su = build_snapshot(db_path)["summary"]["session_usage"]
        self.assertEqual(su["avg_cache_hit_pct"], 0.0)
        self.assertFalse(su["cache_drop"])

    def test_mcp_server_grouping(self):
        self.assertEqual(extract_mcp_server("mcp_github_search_issues"), "github")
        self.assertEqual(extract_mcp_server("mcp_chrome-devtools_click"), "chrome-devtools")
        self.assertEqual(extract_mcp_server("supabase__execute_sql"), "supabase")
        self.assertEqual(extract_mcp_server("mcp__linear__list_issues"), "linear")
        self.assertEqual(extract_mcp_server("notion:search_pages"), "notion")
        self.assertEqual(extract_mcp_server("custom_tool"), "other")

        db_path = self._build_full_conversation_db("99999999-aaaa-bbbb-cccc-dddddddddddd")
        snap = build_snapshot(db_path)
        tools = {t["name"]: t for t in snap["content"]["tools"]}
        self.assertEqual(tools["mcp_github_search"]["mcp_server"], "github")
        self.assertEqual(tools["read_file"]["mcp_server"], "")

    def test_swarm_members_discovery(self):
        app_root = self.tmp_path / "antigravity"
        conv_dir = app_root / "conversations"
        conv_dir.mkdir(parents=True)

        main_id = "12121212-3434-5656-7878-909090909090"
        worker_active = "abababab-1111-2222-3333-444444444444"
        worker_killed = "cdcdcdcd-1111-2222-3333-444444444444"

        # Reuse helper DBs in conversations/
        for cid in (main_id, worker_active, worker_killed):
            src = self._build_full_conversation_db(cid)
            (conv_dir / f"{cid}.db").write_bytes(src.read_bytes())

        members_path = app_root / "brain" / main_id / ".system_generated" / "swarm" / "members.json"
        members_path.parent.mkdir(parents=True)
        members_path.write_text(
            json.dumps({
                "members": [
                    {
                        "name": "backend-1",
                        "conversationId": worker_active,
                        "model": "Gemini 4 Neon (High)",
                        "state": "working",
                    },
                    {
                        "name": "reviewer-1",
                        "conversation_id": worker_killed,
                        "model": "Claude Sonnet 4",
                        "state": "killed",
                    },
                ]
            }),
            encoding="utf-8",
        )

        snap = build_snapshot(conv_dir / f"{main_id}.db")["summary"]
        by_id = {sa["conversation_id"]: sa for sa in snap["subagents"]}
        self.assertEqual(len(by_id), 2)
        self.assertEqual(by_id[worker_active]["source"], "swarm")
        self.assertEqual(by_id[worker_active]["role"], "backend-1")
        self.assertEqual(by_id[worker_active]["status"], "running")
        self.assertEqual(by_id[worker_active]["used_tokens"], 5500)
        self.assertEqual(by_id[worker_killed]["source"], "swarm")
        self.assertEqual(by_id[worker_killed]["status"], "killed")

    def test_proto3_checkpoint_zero_compaction_and_cache_drop(self):
        db_path = self.tmp_path / "10101010-1111-2222-3333-444444444444.db"
        con = create_empty_db(db_path)

        def insert_turn(idx: int, uncached: int, cached: int, chat_start_bytes: bytes):
            usage = pb_varint(2, uncached) + pb_varint(3, 200) + pb_varint(5, cached)
            chat = pb_bytes(4, usage) + pb_bytes(9, chat_start_bytes) + pb_str(19, "gemini-4-neon-high")
            gen = pb_bytes(1, chat)
            con.execute("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)", (idx, gen, len(gen)))

        # Turns 1 & 2: pre-compaction (ck = -1 explicitly encoded), warm cache (90%)
        insert_turn(0, 10_000, 0, pb_varint(2, -1))
        insert_turn(1, 2_000, 18_000, pb_varint(2, -1))
        # Turn 3: first compaction (checkpoint = 0 -> omitted on wire in proto3!), cache drops to 10%
        cwm_only = pb_bytes(10, pb_varint(4, 256_000))
        insert_turn(2, 9_000, 1_000, cwm_only)
        con.commit()
        con.close()

        snap = build_snapshot(db_path)["summary"]
        self.assertTrue(snap["history"][-1]["compacted"])
        self.assertFalse(snap["session_usage"]["cache_drop"])
        self.assertTrue(snap["session_usage"]["cache_drop_after_compact"])

    def test_malformed_wire_json_catalog_and_db_cells(self):
        # 1) Wrong wire types in extract_turn_telemetry (field 1/4/9 as varint)
        self.assertIsNone(extract_turn_telemetry(pb_varint(1, 42)))
        self.assertIsNone(extract_turn_telemetry(pb_bytes(1, pb_varint(4, 99) + pb_varint(9, 7))))
        # Varint overflow inside gen_metadata blob stops cleanly without raising
        self.assertIsNone(extract_turn_telemetry(b"\x08" + b"\x80" * 12 + b"\x01"))

        # 2) Non-dict JSON tool args in Step._rehydrate for read_file/view_file
        for bad_args in ("[1, 2, 3]", "null", "42", "{not-json"):
            tc = pb_str(2, "read_file") + pb_str(3, bad_args)
            md = pb_bytes(4, tc)
            generic = pb_bytes(2, pb_str(1, "ok"))
            pl = pb_varint(1, 132) + pb_varint(4, 3) + pb_bytes(5, md) + pb_bytes(140, generic)
            step = Step(0, pl, 132, 3, md)
            self.assertEqual(step.type, 132)
            self.assertIsNone(step.view_file_override)

        # 3) compaction_tokens skips aborted retry (out <= thinking) and reads earlier entry
        retry_good = pb_bytes(2, pb_varint(3, 500) + pb_varint(9, 100))  # 400
        retry_aborted = pb_bytes(2, pb_varint(3, 50) + pb_varint(9, 50))  # 0 -> skip
        ck_md = pb_bytes(28, retry_good) + pb_bytes(28, retry_aborted)
        ck_step = Step(0, pb_varint(1, 23) + pb_bytes(5, ck_md), 23, 3, ck_md)
        self.assertEqual(compaction_tokens(ck_step), 400)

        # 4) Malformed model-catalog.json shapes fall back safely
        db_path = self._build_full_conversation_db("20202020-1111-2222-3333-444444444444")
        for bad_catalog in (
            '["not-a-dict"]',
            '{"gemini-4-neon-high": "not-a-dict"}',
            '{"gemini-4-neon-high": {"maxTokens": "bad", "displayName": 123}}',
            "{broken json",
        ):
            cat_file = self.tmp_path / "catalog.json"
            cat_file.write_text(bad_catalog, encoding="utf-8")
            snap = build_snapshot(db_path, catalog_path=str(cat_file))["summary"]
            self.assertEqual(snap["limit_tokens"], 1_048_576)
            self.assertEqual(snap["model"], "Gemini 4 Neon (High)")

        # 5) Non-bytes DB cells and >25 trailing content-less gen rows don't evict latest_content
        con = sqlite3.connect(db_path)
        con.execute("INSERT INTO gen_metadata (idx, data, size) VALUES (1, 'not-bytes', 9)")
        con.execute("INSERT INTO gen_metadata (idx, data, size) VALUES (2, 12345, 5)")
        minimal_usage = pb_bytes(1, pb_bytes(4, pb_varint(2, 100) + pb_varint(5, 500)) + pb_str(19, "gemini-4-neon-high"))
        for i in range(3, 35):
            con.execute("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)", (i, minimal_usage, len(minimal_usage)))
        con.commit()
        con.close()

        _, latest_stats, latest_content, history, _ = load_db_with_history(db_path)
        self.assertIsNotNone(latest_stats)
        self.assertIsNotNone(latest_content)
        self.assertTrue(latest_content.msg(1).has(16))
        self.assertEqual(len(history), 33)

    def test_system_overhead_no_double_counting_and_proportional_fallback(self):
        # Case A: system_overhead subtracts rules/skills so total == api_input
        db_path = self.tmp_path / "30303030-1111-2222-3333-444444444444.db"
        con = create_empty_db(db_path)
        breakdown = (
            pb_bytes(1, make_group(3, "Rules", 1000, [("r1", 1000)]))
            + pb_bytes(1, make_group(5, "Skills", 500, [("s1", 500)]))
            + pb_bytes(
                1,
                make_group(
                    7,
                    "Chat Messages",
                    4000,
                    [("0: USER_INPUT", 1500), ("1: PLANNER_RESPONSE", 2500)],
                ),
            )
        )
        cwm = pb_bytes(3, breakdown)
        chat_start = pb_varint(2, -1) + pb_bytes(10, cwm)
        usage = pb_varint(2, 2000) + pb_varint(5, 8000)  # total api_input = 10_000
        chat = pb_bytes(4, usage) + pb_bytes(9, chat_start) + pb_str(19, "gemini-4-neon-high")
        gen = pb_bytes(1, chat)
        con.execute("INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)", (gen, len(gen)))
        con.commit()
        con.close()

        snap = build_snapshot(db_path)["summary"]
        cats = {c["key"]: c["tokens"] for c in snap["categories"]}
        self.assertEqual(cats["system_overhead"], 4500)
        self.assertEqual(snap["used_tokens"], 10_000)

        # Case B: proportional fallback includes and scales system_messages
        db_prop = self.tmp_path / "31313131-1111-2222-3333-444444444444.db"
        con = create_empty_db(db_prop)
        # User step: 100 tokens via metadata usage[3]; System step (101): 100 tokens via metadata usage[3]
        u_md = pb_bytes(9, pb_varint(3, 100))
        s_md = pb_bytes(9, pb_varint(3, 100))
        con.execute(
            "INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (0, 14, 3, ?, ?)",
            (u_md, pb_varint(1, 14) + pb_varint(4, 3) + pb_bytes(5, u_md)),
        )
        con.execute(
            "INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (1, 101, 3, ?, ?)",
            (s_md, pb_varint(1, 101) + pb_varint(4, 3) + pb_bytes(5, s_md)),
        )
        # Unparseable chat items trigger proportional scaling to chat_tok = 1000
        bd_prop = pb_bytes(1, make_group(7, "Chat Messages", 1000, [("bad-label", 1000)]))
        gen_prop = pb_bytes(1, pb_bytes(9, pb_varint(2, -1) + pb_bytes(10, pb_bytes(3, bd_prop))))
        con.execute("INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)", (gen_prop, len(gen_prop)))
        con.commit()
        con.close()

        snap_prop = build_snapshot(db_prop)["summary"]
        cats_prop = {c["key"]: c["tokens"] for c in snap_prop["categories"]}
        self.assertEqual(cats_prop["user"], 500)
        self.assertEqual(cats_prop["system_messages"], 500)
        self.assertEqual(snap_prop["used_tokens"], 1000)

    def test_quick_subagent_stats_without_breakdown(self):
        sub_db = self.tmp_path / "40404040-1111-2222-3333-444444444444.db"
        con = create_empty_db(sub_db)
        # Steps with text/tokens, plus a gen_metadata record that has NO breakdown
        ui_pl = pb_varint(1, 14) + pb_varint(4, 3) + pb_bytes(19, pb_str(2, "Analyze module " * 40))
        con.execute("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (0, 14, 3, ?)", (ui_pl,))
        gen_no_bd = pb_bytes(1, pb_bytes(4, pb_varint(2, 500)) + pb_str(19, "gemini-4-neon-high"))
        con.execute("INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)", (gen_no_bd, len(gen_no_bd)))
        con.commit()
        con.close()

        full = build_snapshot(sub_db)["summary"]
        quick = quick_subagent_stats(sub_db, {"gemini-4-neon-high": {"maxTokens": "invalid"}})
        self.assertIsNotNone(quick)
        self.assertGreater(quick["used_tokens"], 0)
        self.assertEqual(quick["used_tokens"], full["used_tokens"])
        self.assertEqual(quick["limit_tokens"], 1_048_576)

    def test_step_idx_zero_omitted_proto3_and_colliding_sections_and_preview(self):
        db_path = self.tmp_path / "50505050-1111-2222-3333-444444444444.db"
        con = create_empty_db(db_path)

        breakdown = (
            pb_bytes(1, make_group(1, "System Prompt", 100, [("overview", 100)]))
            + pb_bytes(1, make_group(3, "Rules", 350, [("overview", 350)]))
            + pb_bytes(1, make_group(7, "Chat Messages", 222, [("0: USER_INPUT", 222)]))
        )
        cwm = pb_bytes(3, breakdown)
        chat_start = pb_varint(2, -1) + pb_bytes(10, cwm)

        sec_sys = pb_str(1, "overview") + pb_str(2, "System overview") + pb_varint(6, 1)
        sec_rule = pb_str(1, "overview") + pb_str(2, "Rule overview") + pb_varint(6, 3)
        # First message omits field 18 (step_index == 0 in proto3) and field 4 (tokens)
        msg0 = pb_varint(2, 1) + pb_str(3, "First prompt")
        # Huge schema (>100_000 chars) should skip pretty-printing cleanly
        huge_schema = '{"k":"' + ("a" * 100_050) + '"}'
        tool_huge = pb_str(1, "big_tool") + pb_str(2, "Big") + pb_str(3, huge_schema)

        chat = (
            pb_bytes(2, msg0)
            + pb_bytes(8, tool_huge)
            + pb_bytes(9, chat_start)
            + pb_bytes(16, sec_sys)
            + pb_bytes(16, sec_rule)
            + pb_str(19, "gemini-4-neon-high")
        )
        gen = pb_bytes(1, chat)
        con.execute("INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)", (gen, len(gen)))
        con.commit()
        con.close()

        snap = build_snapshot(db_path)
        secs = {(s["group_type"], s["name"]): s["tokens"] for s in snap["content"]["system_sections"]}
        self.assertEqual(secs[(1, "overview")], 100)
        self.assertEqual(secs[(3, "overview")], 350)

        m0 = snap["content"]["messages"][0]
        self.assertEqual(m0["step_index"], 0)
        self.assertEqual(m0["step_type"], "USER_INPUT")
        self.assertEqual(m0["tokens"], 222)
        self.assertFalse(m0["estimated"])

        self.assertEqual(snap["content"]["tools"][0]["schema"], huge_schema)
        # Streaming make_preview on massive no-whitespace string
        prev = make_preview("x" * 200_000, limit=20)
        self.assertEqual(len(prev), 20)
        self.assertTrue(prev.endswith("…"))

    def test_relative_db_swarm_and_rehydrate_outer_md_and_self_id_skip(self):
        app_root = self.tmp_path / "rel_app"
        conv_dir = app_root / "conversations"
        conv_dir.mkdir(parents=True)

        main_id = "60606060-1111-2222-3333-444444444444"
        worker_id = "61616161-1111-2222-3333-444444444444"
        sub_id = "62626262-1111-2222-3333-444444444444"

        for cid in (main_id, worker_id, sub_id):
            src = self._build_full_conversation_db(cid)
            (conv_dir / f"{cid}.db").write_bytes(src.read_bytes())

        # Rehydrated step where packed original step omits field 5 (metadata)
        # and generic_result_text lists self_id before child sub_id
        tc = pb_str(2, "invoke_subagent") + pb_str(3, json.dumps({"Role": "Preserved Role", "TypeName": "research"}))
        outer_md = pb_bytes(4, tc)
        orig_without_md = pb_varint(1, 127) + pb_varint(4, 3)
        packed = pb_str(1, "type.googleapis.com/gemini_coder.Step") + pb_bytes(2, orig_without_md)
        res_text = f'{{"conversationId": "{main_id}"}} -> {{"conversationId": "{sub_id}"}}'
        generic_res = pb_str(1, res_text) + pb_bytes(6, packed)
        step_pl = pb_varint(1, 132) + pb_varint(4, 3) + pb_bytes(5, outer_md) + pb_bytes(140, pb_bytes(2, generic_res))

        step_obj = Step(0, step_pl, 132, 3, outer_md)
        self.assertEqual(step_obj.md.msg(4).str(2), "invoke_subagent")
        self.assertEqual(_extract_subagent_id(step_obj, main_id), sub_id)

        con = sqlite3.connect(conv_dir / f"{main_id}.db")
        con.execute(
            "INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (5, 132, 3, ?, ?)",
            (outer_md, step_pl),
        )
        con.commit()
        con.close()

        members_path = app_root / "brain" / main_id / ".system_generated" / "swarm" / "members.json"
        members_path.parent.mkdir(parents=True)
        members_path.write_text(
            json.dumps({"members": [{"name": "rel-worker", "conversationId": worker_id, "state": "working"}]}),
            encoding="utf-8",
        )

        old_cwd = os.getcwd()
        try:
            os.chdir(conv_dir)
            snap = build_snapshot(Path(f"{main_id}.db"))["summary"]
        finally:
            os.chdir(old_cwd)

        by_id = {sa["conversation_id"]: sa for sa in snap["subagents"]}
        self.assertIn(worker_id, by_id)
        self.assertEqual(by_id[worker_id]["role"], "rel-worker")
        self.assertIn(sub_id, by_id)
        self.assertEqual(by_id[sub_id]["role"], "Preserved Role")

    def test_mcp_server_model_limits_shorten_path_and_cli_uuid_validation(self):
        # MCP double-underscore with mcp_ prefix
        self.assertEqual(extract_mcp_server("mcp_github__search_issues"), "github")
        self.assertEqual(extract_mcp_server("mcp_github_get__item"), "github")
        self.assertEqual(extract_mcp_server("mcp_chrome-devtools__click"), "chrome-devtools")

        # infer_context_limit normalization and short-prefix word boundaries
        def gen_for(slug: str, name: str) -> Msg:
            return Msg(pb_bytes(1, pb_str(19, slug) + pb_str(21, name)))

        self.assertEqual(infer_context_limit(gen_for("", "Claude Sonnet 4")), 250_000)
        self.assertEqual(infer_context_limit(gen_for("claude_opus_4", "Claude Opus 4")), 250_000)
        self.assertEqual(infer_context_limit(gen_for("pro4", "Pro4")), 0)
        self.assertEqual(infer_context_limit(gen_for("o4-mini", "o4 mini")), 200_000)
        self.assertEqual(infer_context_limit(gen_for("o3", "o3")), 200_000)

        # shorten_path directory boundary
        home = str(Path.home()).replace("\\", "/").rstrip("/")
        self.assertEqual(shorten_path(home), "~")
        self.assertEqual(shorten_path(f"{home}/projects/app"), "~/projects/app")
        sibling = f"{home}2/projects/app"
        self.assertEqual(shorten_path(sibling), sibling)

        # detect_system_files with custom gemini_dir
        custom_gemini = self.tmp_path / "custom_gemini"
        (custom_gemini / "skills").mkdir(parents=True)
        (custom_gemini / "GEMINI.md").write_text("# rules", encoding="utf-8")
        sys_files = [f["path"] for f in detect_system_files("", None, "antigravity", gemini_dir=custom_gemini)]
        self.assertTrue(any(p.endswith("/GEMINI.md") for p in sys_files))
        self.assertTrue(any(p.endswith("/skills/") for p in sys_files))

        # CLI rejects path traversal in --conversation-id
        proc = subprocess.run(
            [sys.executable, str(INSPECTOR_DIR / "inspector.py"), "--conversation-id", "../evil"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("Invalid conversation ID", proc.stderr)

    def test_fingerprint_reacts_to_checkpoints_categories_and_subagent_model(self):
        main_id = "70707070-1111-2222-3333-444444444444"
        sub_id = "71717171-1111-2222-3333-444444444444"
        main_db = self.tmp_path / f"{main_id}.db"
        sub_db = self.tmp_path / f"{sub_id}.db"

        def write_sub(model_name: str):
            if sub_db.exists():
                sub_db.unlink()
            con = create_empty_db(sub_db)
            bd = pb_bytes(1, make_group(1, "System Prompt", 500, [("id", 500)]))
            chat = pb_bytes(9, pb_varint(2, -1) + pb_bytes(10, pb_bytes(3, bd))) + pb_str(21, model_name)
            gen = pb_bytes(1, chat)
            con.execute("INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)", (gen, len(gen)))
            con.commit()
            con.close()

        def write_main(sys_tok: int, rules_tok: int, ck_intent: str):
            if main_db.exists():
                main_db.unlink()
            con = create_empty_db(main_db)
            bd = (
                pb_bytes(1, make_group(1, "System Prompt", sys_tok, [("id", sys_tok)]))
                + pb_bytes(1, make_group(3, "Rules", rules_tok, [("r", rules_tok)]))
            )
            chat = pb_bytes(9, pb_varint(2, 1) + pb_bytes(10, pb_bytes(3, bd))) + pb_str(19, "gemini-4-neon-high")
            gen = pb_bytes(1, chat)
            con.execute("INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)", (gen, len(gen)))
            ck_pl = pb_varint(1, 23) + pb_varint(4, 3) + pb_bytes(30, pb_varint(1, 1) + pb_str(4, ck_intent))
            con.execute("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (0, 23, 3, ?)", (ck_pl,))
            tc = pb_str(2, "invoke_subagent") + pb_str(3, json.dumps({"Role": "Worker"}))
            md = pb_bytes(4, tc)
            gen_step = pb_varint(1, 132) + pb_varint(4, 3) + pb_bytes(5, md) + pb_bytes(140, pb_bytes(2, pb_str(1, f'{{"conversationId": "{sub_id}"}}')))
            con.execute("INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (1, 132, 3, ?, ?)", (md, gen_step))
            con.commit()
            con.close()

        write_sub("Model A")
        write_main(sys_tok=600, rules_tok=400, ck_intent="Intent 1")
        fp_base = build_snapshot(main_db)["summary"]["fingerprint"]

        # 1) Same total (1000), shifted category split
        write_main(sys_tok=700, rules_tok=300, ck_intent="Intent 1")
        fp_cat = build_snapshot(main_db)["summary"]["fingerprint"]
        self.assertNotEqual(fp_base, fp_cat)

        # 2) Changed checkpoint intent
        write_main(sys_tok=600, rules_tok=400, ck_intent="Intent 2")
        fp_ck = build_snapshot(main_db)["summary"]["fingerprint"]
        self.assertNotEqual(fp_base, fp_ck)

        # 3) Changed subagent model (same used_tokens and status)
        write_main(sys_tok=600, rules_tok=400, ck_intent="Intent 1")
        write_sub("Model B")
        fp_sub = build_snapshot(main_db)["summary"]["fingerprint"]
        self.assertNotEqual(fp_base, fp_sub)

    def test_quick_subagent_running_status_detection(self):
        import time

        # 1) Parallel tool calls: earlier step status=2 (running) while latest step status=3 (done)
        db_parallel = self.tmp_path / "f1111111-1111-2222-3333-444444444444.db"
        con = create_empty_db(db_parallel)
        con.execute("INSERT INTO steps (idx, step_type, status) VALUES (0, 14, 3)")
        con.execute("INSERT INTO steps (idx, step_type, status) VALUES (1, 132, 2)")
        con.execute("INSERT INTO steps (idx, step_type, status) VALUES (2, 132, 3)")
        con.commit()
        con.close()
        self.assertEqual(quick_subagent_stats(db_parallel, {})["status"], "running")

        # 2) Thinking phase: last step is recently completed tool call (step_type=132, status=3)
        db_thinking = self.tmp_path / "f2222222-1111-2222-3333-444444444444.db"
        con = create_empty_db(db_thinking)
        con.execute("INSERT INTO steps (idx, step_type, status) VALUES (0, 14, 3)")
        con.execute("INSERT INTO steps (idx, step_type, status) VALUES (1, 132, 3)")
        con.commit()
        con.close()
        self.assertEqual(quick_subagent_stats(db_thinking, {})["status"], "running")

        # 3) Stale abandoned subagent (>3 min old non-terminal step) -> idle
        old_ts = time.time() - 600
        os.utime(db_thinking, (old_ts, old_ts))
        self.assertEqual(quick_subagent_stats(db_thinking, {})["status"], "idle")

        # 4) Completed turn ending with PLANNER_RESPONSE (step_type=15, status=3) -> idle
        db_done = self.tmp_path / "f3333333-1111-2222-3333-444444444444.db"
        con = create_empty_db(db_done)
        con.execute("INSERT INTO steps (idx, step_type, status) VALUES (0, 14, 3)")
        con.execute("INSERT INTO steps (idx, step_type, status) VALUES (1, 15, 3)")
        con.commit()
        con.close()
        self.assertEqual(quick_subagent_stats(db_done, {})["status"], "idle")


if __name__ == "__main__":
    unittest.main()
