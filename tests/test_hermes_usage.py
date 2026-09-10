import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from hermes_usage import HermesReader, parse_agent_log_line


class LogParserTests(unittest.TestCase):
    def test_parses_api_call_with_cache_and_route(self):
        line = (
            "2026-09-10 13:00:47,978 INFO [session-1] agent.conversation_loop: "
            "API call #16: model=gpt-5.6-luna provider=openai-codex "
            "in=95073 out=106 total=95179 latency=5.3s "
            "cache=91648/95073 (96%) id=resp_123 upstream=OpenAI"
        )

        event = parse_agent_log_line(line, "agent.log")

        self.assertIsNotNone(event)
        self.assertEqual(event["session_id"], "session-1")
        self.assertEqual(event["kind"], "api_call")
        self.assertEqual(event["input_tokens"], 95073)
        self.assertEqual(event["output_tokens"], 106)
        self.assertEqual(event["cache_read_tokens"], 91648)
        self.assertEqual(event["provider"], "openai-codex")
        self.assertEqual(event["request_id"], "resp_123")

    def test_parses_unavailable_usage_without_inventing_counts(self):
        line = (
            "2026-09-10 13:00:47,978 INFO [session-2] agent.conversation_loop: "
            "API call #3: model=m provider=p in=? out=? total=? latency=2.0s usage=unavailable"
        )

        event = parse_agent_log_line(line, "agent.log")

        self.assertEqual(event["kind"], "api_call")
        self.assertIsNone(event["input_tokens"])
        self.assertIsNone(event["output_tokens"])
        self.assertEqual(event["usage_status"], "unavailable")

    def test_parses_background_review_summary(self):
        line = (
            "2026-09-10 12:50:34,614 INFO [session-3] agent.background_review: "
            "Background review complete: thread=bg-review calls=3 in=7111 out=1737 "
            "cache_read=269312 result=skill"
        )

        event = parse_agent_log_line(line, "agent.log")

        self.assertEqual(event["kind"], "aux_summary")
        self.assertEqual(event["task"], "background_review")
        self.assertEqual(event["api_calls"], 3)
        self.assertEqual(event["cache_read_tokens"], 269312)


class ReaderTests(unittest.TestCase):
    def make_db(self, root: Path) -> Path:
        db_path = root / "state.db"
        conn = sqlite3.connect(db_path)
        now = time.time()
        conn.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, source TEXT, display_name TEXT, model TEXT,
                started_at REAL, ended_at REAL, message_count INTEGER, tool_call_count INTEGER,
                input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
                cache_write_tokens INTEGER, reasoning_tokens INTEGER, billing_provider TEXT,
                billing_base_url TEXT, billing_mode TEXT, estimated_cost_usd REAL,
                actual_cost_usd REAL, cost_status TEXT, cost_source TEXT, parent_session_id TEXT,
                last_activity_at REAL, title TEXT, tool_names TEXT, archived INTEGER DEFAULT 0
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
                tool_calls TEXT, tool_name TEXT, timestamp REAL
            );
            CREATE TABLE session_model_usage (
                session_id TEXT, model TEXT, billing_provider TEXT, billing_base_url TEXT,
                billing_mode TEXT, task TEXT, api_call_count INTEGER, input_tokens INTEGER,
                output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
                reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL,
                cost_status TEXT, cost_source TEXT, first_seen REAL, last_seen REAL
            );
            """
        )
        conn.execute(
            """INSERT INTO sessions VALUES
            ('s1','desktop',NULL,'model-a',?,?,5,2,100,20,80,0,4,
             'provider-a','https://provider.test/v1','',0.12,NULL,'estimated','catalog',NULL,
             ?,NULL,'[\"terminal\",\"new_tool\"]',0)""",
            (now - 100, now - 50, now - 50),
        )
        conn.execute(
            """INSERT INTO messages VALUES
            (1,'s1','user','Build it',NULL,NULL,?),
            (2,'s1','assistant',NULL,'[{\"function\":{\"name\":\"new_tool\",\"arguments\":\"{\\\"name\\\":\\\"skills/demo\\\"}\"}}]',NULL,?),
            (3,'s1','tool',NULL,NULL,'new_tool',?)""",
            (now - 100, now - 90, now - 89),
        )
        conn.execute(
            """INSERT INTO session_model_usage VALUES
            ('s1','model-a','provider-a','https://provider.test/v1','', '',2,100,20,80,0,4,0.12,0,'estimated','catalog',?,?),
            ('s1','aux-model','provider-a','https://provider.test/v1','', 'compression',1,30,5,0,0,0,0,0,'unknown','none',?,?)""",
            (now - 100, now - 50, now - 60, now - 60),
        )
        conn.commit()
        conn.close()
        return db_path

    def test_snapshot_discovers_tools_and_aux_tasks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = self.make_db(root)
            (root / "agent.log").write_text(
                "2026-09-10 13:00:47,978 INFO [s1] agent.conversation_loop: "
                "API call #1: model=model-a provider=provider-a in=100 out=20 total=120 latency=1.0s\n",
                encoding="utf-8",
            )
            reader = HermesReader(db_path=db, log_paths=[root / "agent.log"])
            snapshot = reader.snapshot(days=3650)

            self.assertEqual(snapshot["summary"]["sessions"], 1)
            self.assertEqual(snapshot["summary"]["api_calls"], 3)
            self.assertIn("new_tool", [item["name"] for item in snapshot["tools"]])
            self.assertIn("compression", [item["task"] for item in snapshot["tasks"]])
            self.assertEqual(snapshot["live_events"][0]["input_tokens"], 100)
            self.assertEqual(snapshot["daily"][0]["input_tokens"], 130)

    def test_heartbeat_changes_after_log_append(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log = root / "agent.log"
            log.write_text("", encoding="utf-8")
            reader = HermesReader(db_path=root / "state.db", log_paths=[log])
            first = reader.heartbeat()["signature"]["hash"]
            log.write_text(
                "2026-09-10 13:00:47,978 INFO [s1] agent.conversation_loop: "
                "API call #1: model=m provider=p in=1 out=1 total=2 latency=0.1s\n",
                encoding="utf-8",
            )
            second = reader.heartbeat()["signature"]["hash"]
            self.assertNotEqual(first, second)

    def test_graph_contains_request_tool_and_task_nodes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = self.make_db(root)
            reader = HermesReader(db_path=db, log_paths=[])
            graph = reader.graph("s1")
            kinds = {node["kind"] for node in graph["nodes"]}

            self.assertIn("session", kinds)
            self.assertIn("request", kinds)
            self.assertIn("tool", kinds)
            self.assertIn("task", kinds)
            self.assertGreaterEqual(len(graph["edges"]), 3)
            self.assertIn("sequence", [edge["relation"] for edge in graph["edges"]])


if __name__ == "__main__":
    unittest.main()
