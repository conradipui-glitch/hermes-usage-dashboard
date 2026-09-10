"""Демонстрационные данные для панели использования Hermes.

Создаёт папку demo/home со структурой, которую ждёт панель:
  demo/home/state.db        — база Hermes (схема как в реальном state.db);
  demo/home/logs/agent.log  — текущий журнал;
  demo/home/logs/agent.log.1 — «уехавший» при ротации журнал.

После генерации запустите панель так:

    python server.py --hermes-home demo/home --no-open

и откройте http://127.0.0.1:8765/ — увидите панель с реалистичными данными:
разговоры за последние 90 дней, модели, провайдеры, подзадачи, навыки,
токены, стоимость и живая лента событий. Ничего не отправляется наружу.
"""

from __future__ import annotations

import argparse
import json
import random
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path

SCHEMA = """
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

# (модель, провайдер, цена за 1М input $, цена за 1М output $, доля использования)
MODELS = [
    ("qwen3-coder-480b-a35b-instruct", "openrouter", 0.9, 3.5, 0.40),
    ("glm-4.6", "z.ai", 0.6, 2.2, 0.25),
    ("kimi-k2-instruct", "moonshot", 0.5, 2.0, 0.20),
    ("llama-3.3-70b-instruct", "local-llama", 0.0, 0.0, 0.15),
]

TOPICS = [
    ("Помоги разобраться с ошибкой в Python-скрипте", ["terminal", "fs_read", "code_edit"]),
    ("Напиши unit-тесты для модуля авторизации", ["fs_read", "code_edit", "terminal"]),
    ("Поищи свежие статьи про локальные LLM", ["web_search"]),
    ("Отрефактори функцию parse_config", ["fs_read", "code_edit", "terminal"]),
    ("Сделай короткий отчёт по логам за неделю", ["fs_read", "terminal"]),
    ("Объясни, как работает кэширование промптов", []),
    ("Сгенерируй README для моего проекта", ["fs_read", "fs_write"]),
    ("Проверь зависимости проекта на уязвимости", ["terminal", "web_search"]),
    ("Придумай план статьи про ИИ-агентов", []),
    ("Сохрани заметки по встрече в файл", ["fs_write"]),
    ("Разбери, почему тормозит SQL-запрос", ["terminal", "fs_read"]),
    ("Сравни фреймворки для тестирования", ["web_search"]),
]

SKILLS = ["skills/python-expert", "skills/git-helper", "skills/writing-coach"]

USER_PROMPTS = {
    "default": [
        "Вот файл с ошибкой, помоги исправить",
        "Проверь, пожалуйста, и предложи правки",
        "Сделай то же самое, но компактнее",
        "Отлично, а теперь добавь комментарии",
        "Объясни, что ты поменял и почему",
    ],
}

UPSTREAMS = {"openrouter": "OpenRouter", "z.ai": "Z.AI", "moonshot": "Moonshot", "local-llama": "vLLM"}


def log_line(dt: datetime, level: str, session: str, logger: str, message: str) -> str:
    return f"{dt:%Y-%m-%d %H:%M:%S},{dt.microsecond // 1000:03d} {level} [{session}] {logger}: {message}"


def pick_model(rng: random.Random):
    roll = rng.random()
    acc = 0.0
    for name, provider, price_in, price_out, share in MODELS:
        acc += share
        if roll <= acc:
            return name, provider, price_in, price_out
    return MODELS[0][0], MODELS[0][1], MODELS[0][2], MODELS[0][3]


def build_sessions(rng: random.Random, now: float, days: int) -> list[dict]:
    """Разговоры: несколько сегодня, больше за неделю, остальные — до 90 дней."""
    offsets: list[float] = []
    offsets += [rng.uniform(0.05, 0.9) for _ in range(4)]                  # сегодня
    offsets += [rng.uniform(1.1, 6.8) for _ in range(8)]                     # последние 7 дней
    offsets += [rng.uniform(7.5, min(days, 30)) for _ in range(8)]           # последний месяц
    if days > 30:
        offsets += [rng.uniform(31, days) for _ in range(6)]                 # старее
    sessions = []
    for index, offset in enumerate(sorted(offsets, reverse=True), start=1):
        title, tools = rng.choice(TOPICS)
        model, provider, price_in, price_out = pick_model(rng)
        started = now - offset * 86400
        duration = rng.uniform(240, 2400)
        is_subtask = index > 4 and rng.random() < 0.22
        parent = None
        if is_subtask:
            parent = sessions[rng.randrange(max(1, len(sessions) // 2))]["id"]
        skill = rng.choice(SKILLS) if rng.random() < 0.3 else None
        input_tokens = int(rng.uniform(18_000, 140_000))
        output_tokens = int(rng.uniform(300, 6_500))
        cache_read = int(input_tokens * rng.uniform(0.55, 0.95))
        cache_write = int(input_tokens * rng.uniform(0.02, 0.10))
        reasoning = int(output_tokens * rng.uniform(0.1, 0.9)) if rng.random() < 0.5 else 0
        api_calls = int(rng.uniform(4, 18))
        estimated = round(
            (input_tokens * price_in + output_tokens * price_out) / 1_000_000, 4)
        actual = round(estimated * rng.uniform(0.9, 1.1), 4) if provider != "local-llama" and rng.random() < 0.6 else None
        tool_names = tools + (["skill_view"] if skill else [])
        sessions.append({
            "id": f"demo-{index:04d}", "title": title, "tools": tool_names, "skill": skill,
            "model": model, "provider": provider, "price_in": price_in, "price_out": price_out,
            "started": started, "last": started + duration, "parent": parent,
            "input_tokens": input_tokens, "output_tokens": output_tokens,
            "cache_read": cache_read, "cache_write": cache_write, "reasoning": reasoning,
            "api_calls": api_calls, "estimated": estimated, "actual": actual,
            "messages": int(rng.uniform(4, 14)), "tool_calls": len(tools) * int(rng.uniform(1, 3)),
        })
    return sessions


def insert_messages(conn: sqlite3.Connection, session: dict, rng: random.Random, counter: int) -> int:
    prompts = USER_PROMPTS["default"]
    mid = counter
    step = (session["last"] - session["started"]) / max(1, session["messages"])
    ts = session["started"]
    for i in range(session["messages"]):
        if i % 3 == 0:
            conn.execute(
                "INSERT INTO messages VALUES (?,?,?,?,?,?,?)",
                (mid, session["id"], "user", prompts[i % len(prompts)] if i else session["title"], None, None, ts),
            )
        else:
            tool = session["tools"][i % len(session["tools"])] if session["tools"] else None
            calls = None
            if tool:
                arguments = {"name": session["skill"]} if tool == "skill_view" and session["skill"] else {"query": "demo"}
                calls = json.dumps([{"function": {"name": tool, "arguments": json.dumps(arguments)}}], ensure_ascii=False)
            conn.execute(
                "INSERT INTO messages VALUES (?,?,?,?,?,?,?)",
                (mid, session["id"], "assistant", None, calls, None, ts),
            )
            if tool:
                mid += 1
                conn.execute(
                    "INSERT INTO messages VALUES (?,?,?,?,?,?,?)",
                    (mid, session["id"], "tool", None, None, tool, ts + rng.uniform(0.5, 8)),
                )
        mid += 1
        ts += step
    return mid


def insert_usage(conn: sqlite3.Connection, session: dict, rng: random.Random) -> None:
    def usage_row(task: str, share: float, model: str, provider: str) -> tuple:
        inp = int(session["input_tokens"] * share)
        out = int(session["output_tokens"] * share)
        cache = int(session["cache_read"] * share)
        price_in = session["price_in"]
        price_out = session["price_out"]
        est = round((inp * price_in + out * price_out) / 1_000_000, 4)
        act = round(est * rng.uniform(0.9, 1.1), 4) if session["actual"] is not None else 0
        return (
            session["id"], model, provider, "https://demo.local/v1", "", task,
            max(1, int(session["api_calls"] * share)), inp, out, cache,
            int(session["cache_write"] * share), int(session["reasoning"] * share),
            est, act, "estimated" if not act else "actual", "catalog",
            session["started"], session["last"],
        )

    rows = [usage_row("main_agent", rng.uniform(0.7, 0.9), session["model"], session["provider"])]
    if rng.random() < 0.5:
        rows.append(usage_row("compression", rng.uniform(0.05, 0.2), session["model"], session["provider"]))
    if session["parent"] or rng.random() < 0.25:
        rows.append(usage_row("background_review", rng.uniform(0.05, 0.2), session["model"], session["provider"]))
    conn.executemany("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)


def build_log(sessions: list[dict], rng: random.Random, now: float) -> tuple[list[str], list[str]]:
    """Журнал покрывает последние ~2 дня (реалистичное окно ротации)."""
    current: list[tuple[float, str]] = []
    older: list[tuple[float, str]] = []
    call_no = 0
    for session in sessions:
        started = datetime.fromtimestamp(session["started"])
        if session["started"] < now - 2 * 86400:
            continue
        dt = started
        for i in range(session["api_calls"]):
            call_no += 1
            inp = int(session["input_tokens"] / session["api_calls"] * rng.uniform(0.7, 1.3))
            out = int(session["output_tokens"] / session["api_calls"] * rng.uniform(0.7, 1.3))
            cache = int(inp * rng.uniform(0.55, 0.95))
            latency = round(rng.uniform(0.8, 14), 1)
            message = (
                f"API call #{call_no}: model={session['model']} provider={session['provider']} "
                f"in={inp} out={out} total={inp + out} latency={latency}s "
                f"cache={cache}/{inp} ({int(cache / max(1, inp) * 100)}%) "
                f"id=resp_demo_{call_no:04d} upstream={UPSTREAMS.get(session['provider'], 'Demo')}"
            )
            target = current if dt.timestamp() > now - 86400 else older
            target.append((dt.timestamp(), log_line(dt, "INFO", session["id"], "agent.conversation_loop", message)))
            dt = dt + timedelta(seconds=rng.uniform(15, 120))

            if i and session["tools"] and rng.random() < 0.7:
                tool = session["tools"][i % len(session["tools"])]
                dur = round(rng.uniform(0.2, 9), 2)
                size = int(rng.uniform(200, 30_000))
                if rng.random() < 0.08:
                    target.append((dt.timestamp(), log_line(
                        dt, "WARNING", session["id"], "agent.tools",
                        f"Tool {tool} returned error ({round(rng.uniform(0.5, 5), 1)}s): connection timed out")))
                else:
                    target.append((dt.timestamp(), log_line(
                        dt, "INFO", session["id"], "agent.tools",
                        f"tool {tool} completed ({dur}s, {size:,} chars)")))
                dt = dt + timedelta(seconds=rng.uniform(1, 8))

        if rng.random() < 0.25:
            target = current if dt.timestamp() > now - 86400 else older
            target.append((dt.timestamp(), log_line(
                dt, "INFO", session["id"], "agent.background_review",
                f"Background review complete: thread=bg-demo calls={session['api_calls']} "
                f"in={session['input_tokens']} out={session['output_tokens']} "
                f"cache_read={session['cache_read']} result=skill")))
    current.sort(key=lambda item: item[0])
    older.sort(key=lambda item: item[0])
    return [line for _, line in current], [line for _, line in older]


def main() -> None:
    parser = argparse.ArgumentParser(description="Сгенерировать демо-данные Hermes для панели")
    parser.add_argument("--seed", type=int, default=7, help="seed генератора случайных чисел")
    parser.add_argument("--days", type=int, default=90, help="за сколько дней создать разговоры")
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent / "home"), help="куда положить данные")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    home = Path(args.out).resolve()
    (home / "logs").mkdir(parents=True, exist_ok=True)
    db_path = home / "state.db"
    for suffix in ("", "-wal", "-shm"):
        stale = Path(str(db_path) + suffix)
        if stale.exists():
            stale.unlink()

    now = time.time()
    sessions = build_sessions(rng, now, args.days)

    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    counter = 1
    for session in sessions:
        conn.execute(
            "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                session["id"], "desktop", None, session["model"],
                session["started"], session["last"], session["messages"], session["tool_calls"],
                session["input_tokens"], session["output_tokens"], session["cache_read"],
                session["cache_write"], session["reasoning"], session["provider"],
                "https://demo.local/v1", "", session["estimated"], session["actual"],
                "actual" if session["actual"] is not None else "estimated", "catalog", session["parent"],
                session["last"], session["title"], json.dumps(session["tools"]), 0,
            ),
        )
        counter = insert_messages(conn, session, rng, counter)
        insert_usage(conn, session, rng)
    conn.commit()
    conn.close()

    current_lines, older_lines = build_log(sessions, rng, now)
    (home / "logs" / "agent.log").write_text("\n".join(current_lines) + "\n", encoding="utf-8")
    (home / "logs" / "agent.log.1").write_text("\n".join(older_lines) + "\n", encoding="utf-8")

    print(f"Готово: {len(sessions)} разговоров, {len(current_lines) + len(older_lines)} строк журнала.")
    print(f"Данные: {home}")
    print("Запуск панели:  python server.py --hermes-home " + str(home) + " --no-open")


if __name__ == "__main__":
    main()
