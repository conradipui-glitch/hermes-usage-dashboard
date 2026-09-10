# Hermes Usage Monitor

Локальный read-only дашборд для `state.db` и `logs/agent.log` Hermes Agent.

## Запуск

```text
C:\Users\kato55\Documents\Codex\hermes-usage-dashboard\start-dashboard.bat
```

Или из каталога проекта:

```bash
python server.py --port 8765
```

Откройте `http://127.0.0.1:8765/`.

Параметры:

```bash
python server.py --help
python server.py --hermes-home C:/path/to/.hermes --poll-ms 2000 --no-open
```

## Что читает монитор

- `state.db` открывается SQLite в `mode=ro` с `PRAGMA query_only=ON`.
- `agent.log` и `agent.log.1` читаются только для строк API-вызовов и tool events.
- Ключи API, `.env` и конфигурационные секреты не читаются.
- Hermes не изменяется, дополнительный лог не создаётся.

Frontend каждые 2 секунды проверяет только `mtime/size` `state.db`, `state.db-wal`, `state.db-shm` и логов. Полный SQL-запрос выполняется только после изменения сигнатуры. Фиксированного интервала записи логов у Hermes нет: события коммитятся по ходу API/tool-вызовов, а token accounting может попасть в SQLite с небольшой асинхронной задержкой.

## Данные

- периоды 1/7/30/90 дней;
- токены input/output/cache/reasoning, API calls, estimated/actual cost;
- модель × provider × task;
- инструменты и навыки извлекаются динамически из `messages`, поэтому новый реально вызванный tool появляется без изменения кода дашборда;
- список последних запросов/сессий с сортировкой;
- карта `session → request → API/tool/task/skill → subtask`;
- live feed из agent log.

## Важное ограничение атрибуции

Hermes хранит точные токены каждого основного API-вызова в строках `agent.log`, а в `state.db` — агрегаты по `(session, model, provider, task)`. Поэтому карта и live feed показывают per-call tokens, а стоимость и task/model totals берутся из агрегатов. Стоимость на отдельный API request намеренно не выдумывается. Для полной per-request cost attribution нужен отдельный append-only usage event в Hermes.

## Проверка

```bash
python -m unittest discover -s tests -v
python -m py_compile hermes_usage.py server.py
```
