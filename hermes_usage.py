from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


_TOKEN_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
)

_LOG_HEADER = re.compile(
    r"^(?P<stamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\s+"
    r"(?P<level>[A-Z]+)\s+(?:\[(?P<session_id>[^\]]+)\]\s+)?"
    r"(?P<logger>[\w.]+):\s+(?P<message>.*)$"
)
_API_CALL = re.compile(
    r"API call #(?P<call>\d+): model=(?P<model>\S+) provider=(?P<provider>\S+) "
    r"in=(?P<input>\d+|\?) out=(?P<output>\d+|\?) total=(?P<total>\d+|\?) "
    r"latency=(?P<latency>[\d.]+)s(?P<tail>.*)$"
)
_CACHE = re.compile(r"cache=(?P<read>\d+)/(?:\d+)\s+\([\d.]+%\)")
_WRITE = re.compile(r"(?:^|\s)write=(?P<write>\d+)")
_REQUEST_ID = re.compile(r"(?:^|\s)id=(?P<id>\S+)")
_UPSTREAM = re.compile(r"(?:^|\s)upstream=(?P<upstream>\S+)")
_BACKGROUND = re.compile(
    r"Background review complete: .*?calls=(?P<calls>\d+)\s+"
    r"in=(?P<input>\d+)\s+out=(?P<output>\d+)\s+"
    r"cache_read=(?P<cache>\d+)\s+result=(?P<result>\S+)"
)
_TOOL_COMPLETED = re.compile(
    r"tool\s+(?P<tool>[\w.-]+)\s+completed\s+\((?P<duration>[\d.]+)s,\s+(?P<size>[\d,]+) chars\)"
)
_TOOL_ERROR = re.compile(r"Tool\s+(?P<tool>[\w.-]+)\s+returned error\s+\((?P<duration>[\d.]+)s\):")


def resolve_hermes_home(value: str | os.PathLike[str] | None = None) -> Path:
    if value:
        return Path(value).expanduser().resolve()
    configured = os.environ.get("HERMES_HOME")
    if configured:
        return Path(configured).expanduser().resolve()
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        return Path(local_appdata) / "hermes"
    return Path.home() / ".hermes"


def _as_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _as_float(value: Any) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _iso(ts: Any) -> str | None:
    if ts in (None, ""):
        return None
    try:
        return datetime.fromtimestamp(float(ts)).isoformat(timespec="seconds")
    except (TypeError, ValueError, OSError):
        return None


def _timestamp(stamp: str) -> float | None:
    try:
        return datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S,%f").timestamp()
    except (TypeError, ValueError, OSError):
        return None


def _preview(value: Any, limit: int = 220) -> str:
    if value is None:
        return ""
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _json_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def _iter_tool_calls(raw: Any) -> Iterable[dict[str, Any]]:
    for item in _json_list(raw):
        if not isinstance(item, dict):
            continue
        function = item.get("function")
        if not isinstance(function, dict):
            function = item
        name = function.get("name") or item.get("name")
        if isinstance(name, str) and name:
            args = function.get("arguments", item.get("arguments"))
            parsed_args = _json_object(args)
            yield {
                "name": name,
                "arguments": parsed_args,
                "call_id": item.get("call_id") or item.get("id"),
            }


def parse_agent_log_line(line: str, source: str = "agent.log") -> dict[str, Any] | None:
    """Parse metadata-only observability lines; message content is never returned."""
    match = _LOG_HEADER.match(line.rstrip("\r\n"))
    if not match:
        return None
    data = match.groupdict()
    stamp = data["stamp"]
    timestamp = _timestamp(stamp)
    logger_name = data["logger"]
    message = data["message"]
    base = {
        "timestamp": timestamp,
        "time": stamp,
        "session_id": data.get("session_id"),
        "logger": logger_name,
        "source": source,
        "level": data["level"],
    }

    api = _API_CALL.search(message)
    if api:
        values = api.groupdict()
        tail = values.pop("tail") or ""
        event: dict[str, Any] = {
            **base,
            "kind": "api_call",
            "call_number": _as_int(values["call"]),
            "model": values["model"],
            "provider": values["provider"],
            "input_tokens": None if values["input"] == "?" else _as_int(values["input"]),
            "output_tokens": None if values["output"] == "?" else _as_int(values["output"]),
            "reported_total_tokens": None if values["total"] == "?" else _as_int(values["total"]),
            "latency_seconds": _as_float(values["latency"]),
            "cache_read_tokens": None,
            "cache_write_tokens": None,
            "request_id": None,
            "upstream": None,
            "usage_status": "unavailable" if "usage=unavailable" in tail else "available",
            "scope": "main" if logger_name.endswith("conversation_loop") else "unknown",
        }
        cache = _CACHE.search(tail)
        if cache:
            event["cache_read_tokens"] = _as_int(cache.group("read"))
        write = _WRITE.search(tail)
        if write:
            event["cache_write_tokens"] = _as_int(write.group("write"))
        request_id = _REQUEST_ID.search(tail)
        if request_id:
            event["request_id"] = request_id.group("id")
        upstream = _UPSTREAM.search(tail)
        if upstream:
            event["upstream"] = upstream.group("upstream")
        event["event_id"] = _event_id(event, message)
        return event

    background = _BACKGROUND.search(message)
    if background:
        event = {
            **base,
            "kind": "aux_summary",
            "task": "background_review",
            "api_calls": _as_int(background.group("calls")),
            "input_tokens": _as_int(background.group("input")),
            "output_tokens": _as_int(background.group("output")),
            "cache_read_tokens": _as_int(background.group("cache")),
            "result": background.group("result"),
        }
        event["event_id"] = _event_id(event, message)
        return event

    completed = _TOOL_COMPLETED.search(message)
    if completed:
        event = {
            **base,
            "kind": "tool_event",
            "tool": completed.group("tool"),
            "status": "completed",
            "duration_seconds": _as_float(completed.group("duration")),
            "result_chars": _as_int(completed.group("size").replace(",", "")),
        }
        event["event_id"] = _event_id(event, message)
        return event

    error = _TOOL_ERROR.search(message)
    if error:
        event = {
            **base,
            "kind": "tool_event",
            "tool": error.group("tool"),
            "status": "error",
            "duration_seconds": _as_float(error.group("duration")),
        }
        event["event_id"] = _event_id(event, message)
        return event

    return None


def _event_id(event: dict[str, Any], message: str) -> str:
    raw = "|".join(
        str(event.get(key, ""))
        for key in ("time", "session_id", "logger", "kind", "call_number", "task")
    ) + "|" + message
    return hashlib.sha1(raw.encode("utf-8", "replace")).hexdigest()[:20]


def _read_log_events(paths: Iterable[Path], cutoff: float, limit: int = 2000) -> list[dict[str, Any]]:
    seen: set[str] = set()
    events: list[dict[str, Any]] = []
    for path in paths:
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            event = parse_agent_log_line(line, path.name)
            if not event or (event.get("timestamp") or 0) < cutoff:
                continue
            event_id = event["event_id"]
            if event_id in seen:
                continue
            seen.add(event_id)
            events.append(event)
    events.sort(key=lambda item: (item.get("timestamp") or 0, item.get("event_id", "")), reverse=True)
    return events[:limit]


def build_signature(db_path: Path, log_paths: Iterable[Path]) -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    candidates = [db_path, Path(str(db_path) + "-wal"), Path(str(db_path) + "-shm"), *log_paths]
    seen: set[str] = set()
    for path in candidates:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        try:
            stat = path.stat()
        except OSError:
            files.append({"name": path.name, "exists": False})
            continue
        files.append({
            "name": path.name,
            "exists": True,
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
        })
    digest = hashlib.sha1(json.dumps(files, sort_keys=True).encode("utf-8")).hexdigest()[:20]
    return {"hash": digest, "files": files, "observed_at": time.time()}


def _open_readonly(path: Path) -> sqlite3.Connection:
    uri = f"file:{path.resolve().as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=1.5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn


def _has_table(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    if not _has_table(conn, table):
        return set()
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _select_columns(conn: sqlite3.Connection, table: str, wanted: Iterable[str]) -> str:
    available = _columns(conn, table)
    return ", ".join(name for name in wanted if name in available)


def _row_dict(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    return dict(row)


def _public_session(row: dict[str, Any], latest_request: str = "") -> dict[str, Any]:
    result = dict(row)
    for key in ("started_at", "ended_at", "last_activity_at"):
        if key in result:
            result[key + "_iso"] = _iso(result[key])
    for key in _TOKEN_FIELDS + ("message_count", "tool_call_count", "api_call_count"):
        if key in result:
            result[key] = _as_int(result[key])
    for key in ("estimated_cost_usd", "actual_cost_usd"):
        if key in result:
            result[key] = _as_float(result[key]) if result[key] is not None else None
    result["latest_request"] = _preview(latest_request)
    result["display_label"] = (
        result.get("title") or result.get("display_name") or result.get("latest_request")
        or result.get("id", "")
    )
    result["tool_names"] = _json_list(result.get("tool_names"))
    return result


class HermesReader:
    """Read-only projection of Hermes state.db plus rotating agent logs."""

    def __init__(
        self,
        db_path: Path | str | None = None,
        log_paths: Iterable[Path | str] | None = None,
    ) -> None:
        hermes_home = resolve_hermes_home()
        self.db_path = Path(db_path) if db_path else hermes_home / "state.db"
        self.db_path = self.db_path.expanduser().resolve()
        if log_paths is None:
            log_paths = (hermes_home / "logs" / "agent.log", hermes_home / "logs" / "agent.log.1")
        self.log_paths = [Path(path).expanduser().resolve() for path in log_paths]

    def heartbeat(self) -> dict[str, Any]:
        signature = build_signature(self.db_path, self.log_paths)
        return {
            "signature": signature,
            "db_path": str(self.db_path),
            "log_paths": [str(path) for path in self.log_paths],
            "db_exists": self.db_path.is_file(),
            "observed_at": time.time(),
        }

    def snapshot(self, days: int = 30, session_limit: int = 250) -> dict[str, Any]:
        days = max(1, min(int(days), 3650))
        cutoff = time.time() - days * 86400
        signature = self.heartbeat()["signature"]
        events = _read_log_events(self.log_paths, cutoff)
        if not self.db_path.is_file():
            return self._empty_snapshot(days, signature, "state.db not found")

        try:
            conn = _open_readonly(self.db_path)
        except (OSError, sqlite3.Error) as exc:
            return self._empty_snapshot(days, signature, f"state.db unavailable: {exc}")
        try:
            sessions_all = self._sessions(conn, cutoff, None)
            sessions = sessions_all[:max(1, min(int(session_limit), 1000))]
            session_ids = {row["id"] for row in sessions_all}
            latest_requests = self._latest_requests(conn, {row["id"] for row in sessions})
            sessions_public = [_public_session(row, latest_requests.get(row["id"], "")) for row in sessions]
            usage_rows = self._usage_rows(conn, cutoff, session_ids)
            models = self._group_models(usage_rows)
            tasks = self._group_tasks(usage_rows)
            tools, skills = self._tool_and_skill_breakdown(conn, cutoff)
            daily = self._daily_breakdown(sessions_all, usage_rows, events, days)
            descendants = sum(1 for row in sessions_all if row.get("parent_session_id"))
            summary = self._summary(sessions_all, usage_rows, events, descendants)
            return {
                "generated_at": time.time(),
                "period_days": days,
                "signature": signature,
                "summary": summary,
                "daily": daily,
                "models": models,
                "tasks": tasks,
                "tools": tools,
                "skills": skills,
                "sessions": sessions_public,
                "live_events": events[:250],
                "data_quality": self._data_quality(usage_rows, events),
                "source": {
                    "db": str(self.db_path),
                    "logs": [str(path) for path in self.log_paths],
                    "read_only": True,
                    "polling": "metadata heartbeat; full query only after signature change",
                },
            }
        except sqlite3.Error as exc:
            return self._empty_snapshot(days, signature, f"state.db query failed: {exc}")
        finally:
            conn.close()

    def graph(self, session_id: str) -> dict[str, Any]:
        if not self.db_path.is_file():
            return {"session_id": session_id, "nodes": [], "edges": [], "error": "state.db not found"}
        try:
            conn = _open_readonly(self.db_path)
        except (OSError, sqlite3.Error) as exc:
            return {"session_id": session_id, "nodes": [], "edges": [], "error": str(exc)}
        try:
            if not _has_table(conn, "sessions"):
                return {"session_id": session_id, "nodes": [], "edges": [], "error": "sessions table not found"}
            session_columns = [
                "id", "source", "display_name", "model", "started_at", "ended_at", "message_count",
                "tool_call_count", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
                "reasoning_tokens", "billing_provider", "billing_base_url", "billing_mode", "estimated_cost_usd",
                "actual_cost_usd", "cost_status", "cost_source", "parent_session_id", "last_activity_at", "title",
                "tool_names",
            ]
            selected = _select_columns(conn, "sessions", session_columns)
            row = conn.execute(f"SELECT {selected} FROM sessions WHERE id=?", (session_id,)).fetchone()
            if row is None:
                return {"session_id": session_id, "nodes": [], "edges": [], "error": "session not found"}
            session = _public_session(_row_dict(row))
            nodes: list[dict[str, Any]] = []
            edges: list[dict[str, Any]] = []
            node_ids: set[str] = set()

            def add_node(node: dict[str, Any]) -> str:
                node_id = str(node["id"])
                if node_id not in node_ids:
                    node_ids.add(node_id)
                    nodes.append(node)
                return node_id

            def add_edge(source: str, target: str, relation: str) -> None:
                key = (source, target, relation)
                if not any((edge["source"], edge["target"], edge["relation"]) == key for edge in edges):
                    edges.append({"source": source, "target": target, "relation": relation})

            root_id = add_node({
                "id": f"session:{session_id}",
                "kind": "session",
                "label": session.get("display_label") or session_id,
                "timestamp": session.get("started_at"),
                "meta": {
                    "session_id": session_id,
                    "model": session.get("model"),
                    "provider": session.get("billing_provider"),
                    "tokens": self._session_tokens(session),
                    "tool_calls": _as_int(session.get("tool_call_count")),
                    "cost": session.get("actual_cost_usd") or session.get("estimated_cost_usd") or 0,
                },
            })

            parent = session.get("parent_session_id")
            if parent:
                parent_row = conn.execute(f"SELECT {selected} FROM sessions WHERE id=?", (parent,)).fetchone()
                if parent_row:
                    parent_public = _public_session(_row_dict(parent_row))
                    parent_id = add_node({
                        "id": f"session:{parent}", "kind": "parent", "label": parent_public.get("display_label") or parent,
                        "timestamp": parent_public.get("started_at"), "meta": {"session_id": parent},
                    })
                    add_edge(parent_id, root_id, "parent")

            message_rows = []
            if _has_table(conn, "messages"):
                message_rows = conn.execute(
                    "SELECT id, role, content, tool_calls, tool_name, timestamp "
                    "FROM messages WHERE session_id=? ORDER BY id LIMIT 600", (session_id,)
                ).fetchall()
            last_request_id = root_id
            timeline_ids: list[str] = []
            for message in message_rows:
                message_dict = _row_dict(message)
                if message_dict.get("role") == "user":
                    request_id = add_node({
                        "id": f"request:{message_dict['id']}", "kind": "request",
                        "label": _preview(message_dict.get("content"), 150) or "User request",
                        "timestamp": message_dict.get("timestamp"),
                        "meta": {"message_id": message_dict["id"], "content": _preview(message_dict.get("content"), 2000)},
                    })
                    add_edge(root_id, request_id, "contains")
                    timeline_ids.append(request_id)
                    last_request_id = request_id
                for index, call in enumerate(_iter_tool_calls(message_dict.get("tool_calls"))):
                    tool_name = call["name"]
                    call_id = add_node({
                        "id": f"call:{message_dict['id']}:{index}", "kind": "tool",
                        "label": tool_name, "timestamp": message_dict.get("timestamp"),
                        "meta": {
                            "tool": tool_name,
                            "call_id": call.get("call_id"),
                            "skill": call.get("arguments", {}).get("name") if tool_name in {"skill_view", "skill_manage"} else None,
                        },
                    })
                    add_edge(last_request_id, call_id, "calls")
                    timeline_ids.append(call_id)
                    skill = call.get("arguments", {}).get("name") if tool_name in {"skill_view", "skill_manage"} else None
                    if isinstance(skill, str) and skill:
                        skill_id = add_node({
                            "id": f"skill:{skill}", "kind": "skill", "label": skill,
                            "timestamp": message_dict.get("timestamp"), "meta": {"skill": skill, "action": tool_name},
                        })
                        add_edge(call_id, skill_id, "loads")
                    last_request_id = call_id
                if message_dict.get("role") == "tool" and message_dict.get("tool_name"):
                    tool_id = add_node({
                        "id": f"result:{message_dict['id']}", "kind": "result",
                        "label": f"{message_dict['tool_name']} result", "timestamp": message_dict.get("timestamp"),
                        "meta": {"tool": message_dict["tool_name"]},
                    })
                    add_edge(last_request_id, tool_id, "returns")
                    timeline_ids.append(tool_id)
                    last_request_id = tool_id

            usage_rows = self._usage_rows(conn, 0, {session_id}, ignore_cutoff=True)
            for index, usage in enumerate(usage_rows):
                task = usage.get("task") or "main_agent"
                task_id = add_node({
                    "id": f"task:{session_id}:{index}", "kind": "task", "label": task,
                    "timestamp": usage.get("last_seen"),
                    "meta": {
                        "task": task,
                        "model": usage.get("model"),
                        "provider": usage.get("billing_provider"),
                        "api_calls": _as_int(usage.get("api_call_count")),
                        "tokens": self._usage_tokens(usage),
                        "estimated_cost": _as_float(usage.get("estimated_cost_usd")),
                        "actual_cost": _as_float(usage.get("actual_cost_usd")),
                        "cost_status": usage.get("cost_status"),
                    },
                })
                add_edge(root_id, task_id, "uses")

            cutoff = 0
            session_events = [
                event for event in _read_log_events(self.log_paths, cutoff, limit=1500)
                if event.get("session_id") == session_id
                and event.get("kind") in {"api_call", "aux_summary"}
            ]
            graph_events_truncated = len(session_events) > 320
            for event in session_events[:320]:
                event_id = add_node({
                    "id": f"event:{event['event_id']}", "kind": "api",
                    "label": (
                        f"API #{event.get('call_number', '?')} · {event.get('model', event.get('task', 'aux'))}"
                    ),
                    "timestamp": event.get("timestamp"),
                    "meta": {
                        "model": event.get("model"), "provider": event.get("provider"),
                        "task": event.get("task") or "main_agent",
                        "input_tokens": event.get("input_tokens"),
                        "output_tokens": event.get("output_tokens"),
                        "cache_read_tokens": event.get("cache_read_tokens"),
                        "latency_seconds": event.get("latency_seconds"),
                        "request_id": event.get("request_id"),
                        "cost_note": "cost is available in aggregate DB rows, not per log line",
                    },
                })
                add_edge(root_id, event_id, "api_call")
                timeline_ids.append(event_id)

            if _has_table(conn, "sessions"):
                children = conn.execute(
                    f"SELECT {selected} FROM sessions WHERE parent_session_id=? ORDER BY started_at LIMIT 100",
                    (session_id,),
                ).fetchall()
                for child_row in children:
                    child = _public_session(_row_dict(child_row))
                    child_id = add_node({
                        "id": f"session:{child['id']}", "kind": "subtask",
                        "label": child.get("display_label") or child["id"],
                        "timestamp": child.get("started_at"),
                        "meta": {
                            "session_id": child["id"], "model": child.get("model"),
                            "provider": child.get("billing_provider"), "tokens": self._session_tokens(child),
                            "tool_calls": _as_int(child.get("tool_call_count")),
                        },
                    })
                    add_edge(root_id, child_id, "delegates")

            node_by_id = {node["id"]: node for node in nodes}
            timeline = sorted(
                {node_id for node_id in timeline_ids if node_id in node_by_id},
                key=lambda node_id: (node_by_id[node_id].get("timestamp") or 0, node_id),
            )
            if timeline:
                add_edge(root_id, timeline[0], "starts")
                for previous, current in zip(timeline, timeline[1:]):
                    add_edge(previous, current, "sequence")

            nodes.sort(key=lambda node: (node.get("timestamp") or 0, node["id"]))
            return {
                "session_id": session_id, "session": session, "nodes": nodes, "edges": edges,
                "truncated": graph_events_truncated, "error": None,
            }
        except sqlite3.Error as exc:
            return {"session_id": session_id, "nodes": [], "edges": [], "error": str(exc)}
        finally:
            conn.close()

    def _sessions(self, conn: sqlite3.Connection, cutoff: float, limit: int | None) -> list[dict[str, Any]]:
        wanted = [
            "id", "source", "display_name", "model", "started_at", "ended_at", "message_count", "tool_call_count",
            "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens",
            "billing_provider", "billing_base_url", "billing_mode", "estimated_cost_usd", "actual_cost_usd",
            "cost_status", "cost_source", "parent_session_id", "last_activity_at", "title", "tool_names", "archived",
        ]
        selected = _select_columns(conn, "sessions", wanted)
        if not selected:
            return []
        sql = (
            f"SELECT {selected} FROM sessions "
            "WHERE COALESCE(last_activity_at, started_at) >= ? "
            "AND COALESCE(archived, 0) = 0 "
            "ORDER BY COALESCE(last_activity_at, started_at) DESC"
        )
        params: list[Any] = [cutoff]
        if limit is not None:
            sql += " LIMIT ?"
            params.append(max(1, min(int(limit), 10000)))
        rows = conn.execute(sql, params).fetchall()
        return [_row_dict(row) for row in rows]

    def _latest_requests(self, conn: sqlite3.Connection, session_ids: set[str]) -> dict[str, str]:
        if not session_ids or not _has_table(conn, "messages"):
            return {}
        rows = conn.execute(
            "SELECT session_id, content FROM messages WHERE role='user' ORDER BY id DESC LIMIT 3000"
        ).fetchall()
        result: dict[str, str] = {}
        for row in rows:
            if row["session_id"] in session_ids and row["session_id"] not in result:
                result[row["session_id"]] = _preview(row["content"])
        return result

    def _usage_rows(
        self,
        conn: sqlite3.Connection,
        cutoff: float,
        session_ids: set[str],
        ignore_cutoff: bool = False,
    ) -> list[dict[str, Any]]:
        if not _has_table(conn, "session_model_usage"):
            return []
        wanted = [
            "session_id", "model", "billing_provider", "billing_base_url", "billing_mode", "task",
            "api_call_count", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
            "reasoning_tokens", "estimated_cost_usd", "actual_cost_usd", "cost_status", "cost_source",
            "first_seen", "last_seen",
        ]
        selected = _select_columns(conn, "session_model_usage", wanted)
        if not selected:
            return []
        if ignore_cutoff:
            rows = conn.execute(
                f"SELECT {selected} FROM session_model_usage WHERE session_id=? ORDER BY last_seen",
                (next(iter(session_ids)),),
            ).fetchall()
        elif session_ids:
            placeholders = ",".join("?" for _ in session_ids)
            rows = conn.execute(
                f"SELECT {selected} FROM session_model_usage WHERE COALESCE(last_seen, first_seen) >= ? "
                f"AND session_id IN ({placeholders})",
                (cutoff, *sorted(session_ids)),
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT {selected} FROM session_model_usage WHERE COALESCE(last_seen, first_seen) >= ?",
                (cutoff,),
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def _tool_and_skill_breakdown(self, conn: sqlite3.Connection, cutoff: float) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        if not _has_table(conn, "messages"):
            return [], []
        tool_rows = conn.execute(
            "SELECT tool_name, COUNT(*) AS count FROM messages "
            "WHERE role='tool' AND tool_name IS NOT NULL AND timestamp >= ? "
            "GROUP BY tool_name", (cutoff,)
        ).fetchall()
        response_counts = Counter({row["tool_name"]: _as_int(row["count"]) for row in tool_rows})
        call_counts: Counter[str] = Counter()
        skill_counts: dict[str, dict[str, Any]] = {}
        assistant_rows = conn.execute(
            "SELECT session_id, tool_calls, timestamp FROM messages "
            "WHERE role='assistant' AND tool_calls IS NOT NULL AND timestamp >= ?", (cutoff,)
        ).fetchall()
        for row in assistant_rows:
            for call in _iter_tool_calls(row["tool_calls"]):
                name = call["name"]
                call_counts[name] += 1
                if name in {"skill_view", "skill_manage"}:
                    skill = call.get("arguments", {}).get("name")
                    if isinstance(skill, str) and skill.strip():
                        entry = skill_counts.setdefault(skill, {"skill": skill, "view_count": 0, "manage_count": 0, "last_used_at": None})
                        entry["view_count" if name == "skill_view" else "manage_count"] += 1
                        entry["last_used_at"] = max(entry["last_used_at"] or 0, row["timestamp"] or 0)
        all_tools = set(response_counts) | set(call_counts)
        tools = []
        total = 0
        for name in all_tools:
            count = max(response_counts.get(name, 0), call_counts.get(name, 0))
            total += count
            tools.append({"name": name, "count": count, "sessions": 0})
        tools.sort(key=lambda item: (-item["count"], item["name"]))
        for item in tools:
            item["percentage"] = round(item["count"] / total * 100, 2) if total else 0
        skills = []
        for entry in skill_counts.values():
            entry["total_count"] = entry["view_count"] + entry["manage_count"]
            entry["last_used_at_iso"] = _iso(entry["last_used_at"])
            skills.append(entry)
        skills.sort(key=lambda item: (-item["total_count"], item["skill"]))
        return tools, skills

    def _group_models(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        grouped: dict[tuple[str, str, str], dict[str, Any]] = {}
        for row in rows:
            key = (row.get("model") or "unknown", row.get("billing_provider") or "unknown", row.get("task") or "main_agent")
            item = grouped.setdefault(key, {
                "model": key[0], "provider": key[1], "task": key[2], "sessions": set(),
                **{field: 0 for field in _TOKEN_FIELDS}, "api_calls": 0, "estimated_cost_usd": 0.0,
                "actual_cost_usd": 0.0, "cost_status": row.get("cost_status"), "cost_source": row.get("cost_source"),
            })
            item["sessions"].add(row.get("session_id"))
            for field in _TOKEN_FIELDS:
                item[field] += _as_int(row.get(field))
            item["api_calls"] += _as_int(row.get("api_call_count"))
            item["estimated_cost_usd"] += _as_float(row.get("estimated_cost_usd"))
            item["actual_cost_usd"] += _as_float(row.get("actual_cost_usd"))
            item["cost_status"] = row.get("cost_status") or item["cost_status"]
            item["cost_source"] = row.get("cost_source") or item["cost_source"]
        result = []
        for item in grouped.values():
            item["sessions"] = len(item["sessions"])
            item["total_tokens"] = sum(item[field] for field in _TOKEN_FIELDS if field != "reasoning_tokens")
            item["cost_usd"] = item["actual_cost_usd"] or item["estimated_cost_usd"]
            result.append(item)
        return sorted(result, key=lambda item: (-item["total_tokens"], item["model"], item["task"]))

    def _group_tasks(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        grouped: dict[str, dict[str, Any]] = {}
        for row in rows:
            task = row.get("task") or "main_agent"
            item = grouped.setdefault(task, {
                "task": task, "models": set(), "providers": set(), "sessions": set(),
                **{field: 0 for field in _TOKEN_FIELDS}, "api_calls": 0, "estimated_cost_usd": 0.0,
                "actual_cost_usd": 0.0,
            })
            item["models"].add(row.get("model") or "unknown")
            item["providers"].add(row.get("billing_provider") or "unknown")
            item["sessions"].add(row.get("session_id"))
            for field in _TOKEN_FIELDS:
                item[field] += _as_int(row.get(field))
            item["api_calls"] += _as_int(row.get("api_call_count"))
            item["estimated_cost_usd"] += _as_float(row.get("estimated_cost_usd"))
            item["actual_cost_usd"] += _as_float(row.get("actual_cost_usd"))
        result = []
        for item in grouped.values():
            item["models"] = sorted(item["models"])
            item["providers"] = sorted(item["providers"])
            item["sessions"] = len(item["sessions"])
            item["total_tokens"] = sum(item[field] for field in _TOKEN_FIELDS if field != "reasoning_tokens")
            item["cost_usd"] = item["actual_cost_usd"] or item["estimated_cost_usd"]
            result.append(item)
        return sorted(result, key=lambda item: (-item["total_tokens"], item["task"]))

    def _daily_breakdown(
        self,
        sessions: list[dict[str, Any]],
        usage_rows: list[dict[str, Any]],
        events: list[dict[str, Any]],
        days: int,
    ) -> list[dict[str, Any]]:
        by_day: dict[str, dict[str, Any]] = defaultdict(lambda: {
            "day": "", "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
            "cache_write_tokens": 0, "reasoning_tokens": 0, "api_calls": 0, "sessions": 0,
            "estimated_cost_usd": 0.0, "actual_cost_usd": 0.0, "source": "state.db aggregate",
        })
        # Main totals are anchored to the session start, matching Hermes' existing analytics
        # semantics. Auxiliary rows are anchored to their last persisted accounting timestamp.
        for session in sessions:
            day = datetime.fromtimestamp(session.get("started_at") or time.time()).date().isoformat()
            item = by_day[day]
            item["day"] = day
            item["sessions"] += 1
            for field in _TOKEN_FIELDS:
                item[field] += _as_int(session.get(field))
            item["estimated_cost_usd"] += _as_float(session.get("estimated_cost_usd"))
            item["actual_cost_usd"] += _as_float(session.get("actual_cost_usd"))
            item["api_calls"] += _as_int(session.get("api_call_count"))
        for row in usage_rows:
            if not row.get("task"):
                continue
            ts = row.get("last_seen") or row.get("first_seen")
            if not ts:
                continue
            day = datetime.fromtimestamp(ts).date().isoformat()
            item = by_day[day]
            item["day"] = day
            item["source"] = "state.db task aggregate"
            for field in _TOKEN_FIELDS:
                item[field] += _as_int(row.get(field))
            item["estimated_cost_usd"] += _as_float(row.get("estimated_cost_usd"))
            item["actual_cost_usd"] += _as_float(row.get("actual_cost_usd"))
            item["api_calls"] += _as_int(row.get("api_call_count"))
        # Keep exact log observations separate: rotating logs may cover only part of a day,
        # so they must not overwrite the period aggregates from state.db.
        exact_days: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        for event in events:
            if event.get("kind") != "api_call" or event.get("scope") != "main" or not event.get("timestamp"):
                continue
            day = datetime.fromtimestamp(event["timestamp"]).date().isoformat()
            exact_days[day]["input_tokens"] += _as_int(event.get("input_tokens"))
            exact_days[day]["output_tokens"] += _as_int(event.get("output_tokens"))
            exact_days[day]["cache_read_tokens"] += _as_int(event.get("cache_read_tokens"))
            exact_days[day]["cache_write_tokens"] += _as_int(event.get("cache_write_tokens"))
            exact_days[day]["api_calls"] += 1
        for day, exact in exact_days.items():
            if day not in by_day:
                by_day[day] = {
                    "day": day,
                    **{field: exact.get(field, 0) for field in _TOKEN_FIELDS},
                    "api_calls": exact.get("api_calls", 0), "sessions": 0,
                    "estimated_cost_usd": 0.0, "actual_cost_usd": 0.0,
                    "source": "agent.log exact calls",
                }
                continue
            item = by_day[day]
            item["observed_input_tokens"] = exact["input_tokens"]
            item["observed_output_tokens"] = exact["output_tokens"]
            item["observed_cache_read_tokens"] = exact["cache_read_tokens"]
            item["observed_cache_write_tokens"] = exact["cache_write_tokens"]
            item["observed_api_calls"] = exact["api_calls"]
            item["source"] = "state.db aggregate + agent.log observed subset"
        return sorted(by_day.values(), key=lambda item: item["day"])[-max(days, 1):]

    def _summary(
        self,
        sessions: list[dict[str, Any]],
        usage_rows: list[dict[str, Any]],
        events: list[dict[str, Any]],
        descendants: int,
    ) -> dict[str, Any]:
        totals = {field: 0 for field in _TOKEN_FIELDS}
        api_calls = 0
        estimated = 0.0
        actual = 0.0
        statuses = Counter()
        for row in usage_rows:
            for field in _TOKEN_FIELDS:
                totals[field] += _as_int(row.get(field))
            api_calls += _as_int(row.get("api_call_count"))
            estimated += _as_float(row.get("estimated_cost_usd"))
            actual += _as_float(row.get("actual_cost_usd"))
            statuses[row.get("cost_status") or "unknown"] += 1
        if not usage_rows:
            for session in sessions:
                for field in _TOKEN_FIELDS:
                    totals[field] += _as_int(session.get(field))
                api_calls += _as_int(session.get("api_call_count"))
                estimated += _as_float(session.get("estimated_cost_usd"))
                actual += _as_float(session.get("actual_cost_usd"))
                statuses[session.get("cost_status") or "unknown"] += 1
        active_cutoff = time.time() - 120
        active = sum(1 for session in sessions if (session.get("last_activity_at") or 0) >= active_cutoff)
        main_log_events = sum(1 for event in events if event.get("kind") == "api_call")
        return {
            "sessions": len(sessions),
            "root_sessions": sum(1 for session in sessions if not session.get("parent_session_id")),
            "subtasks": descendants,
            "active_sessions": active,
            "api_calls": api_calls,
            "observed_api_log_events": main_log_events,
            **totals,
            "total_tokens": totals["input_tokens"] + totals["output_tokens"] + totals["cache_read_tokens"] + totals["cache_write_tokens"],
            "estimated_cost_usd": estimated,
            "actual_cost_usd": actual,
            "billable_cost_usd": actual or estimated,
            "cost_statuses": dict(statuses),
        }

    @staticmethod
    def _session_tokens(session: dict[str, Any]) -> int:
        return sum(_as_int(session.get(field)) for field in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"))

    @staticmethod
    def _usage_tokens(row: dict[str, Any]) -> int:
        return sum(_as_int(row.get(field)) for field in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"))

    @staticmethod
    def _data_quality(usage_rows: list[dict[str, Any]], events: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "state_db_usage_rows": len(usage_rows),
            "log_event_rows": len(events),
            "per_api_call_tokens": sum(1 for event in events if event.get("kind") == "api_call" and event.get("usage_status") == "available"),
            "aggregate_only_cost": True,
            "note": "Per-call token counts come from agent.log; per-task/model cost comes from state.db aggregate rows.",
        }

    @staticmethod
    def _empty_snapshot(days: int, signature: dict[str, Any], error: str) -> dict[str, Any]:
        return {
            "generated_at": time.time(), "period_days": days, "signature": signature,
            "summary": {"sessions": 0, "total_tokens": 0, "api_calls": 0}, "daily": [], "models": [],
            "tasks": [], "tools": [], "skills": [], "sessions": [], "live_events": [],
            "data_quality": {}, "source": {"read_only": True}, "error": error,
        }


__all__ = [
    "HermesReader",
    "build_signature",
    "parse_agent_log_line",
    "resolve_hermes_home",
]
