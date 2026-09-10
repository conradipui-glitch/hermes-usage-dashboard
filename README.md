# Hermes Usage Dashboard

Локальный read-only дашборд для анализа использования [Hermes Agent](https://github.com/NousResearch/hermes-agent).

Дашборд собирает данные из `state.db` и `logs/agent.log`, показывает токены, модели, провайдеров, задачи и live-ленту событий — без изменения файлов Hermes и без отправки данных в интернет.

## Возможности

- периоды анализа: **1 / 7 / 30 / 90 дней**;
- input, output, cache и reasoning tokens;
- количество API-вызовов и оценка стоимости;
- разбивка по `model × provider × task`;
- последние запросы и сессии с сортировкой;
- граф связей `session → request → API/tool/task/skill → subtask`;
- live feed из `agent.log`;
- автоматическое обнаружение новых tools и skills из сообщений Hermes;
- обновление интерфейса при изменении базы или логов.

## Быстрый запуск

Требуется **Python 3.11+**. Внешние зависимости не нужны — используется только стандартная библиотека Python.

### Windows

```text
start-dashboard.bat
```

### Любая платформа

```bash
python server.py --port 8765
```

После запуска откройте [http://127.0.0.1:8765/](http://127.0.0.1:8765/).

## Параметры запуска

```bash
python server.py --help
python server.py --hermes-home C:/path/to/.hermes --poll-ms 2000 --no-open
```

| Параметр | Назначение |
| --- | --- |
| `--port` | Порт локального сервера |
| `--hermes-home` | Каталог Hermes с `state.db` и `logs/` |
| `--poll-ms` | Интервал проверки изменений файлов |
| `--no-open` | Не открывать браузер автоматически |

## Безопасность и режим read-only

- открывает SQLite с `mode=ro` и включает `PRAGMA query_only=ON`;
- не изменяет `state.db`, WAL-файлы или логи Hermes;
- не читает API-ключи, `.env` и конфигурационные секреты;
- не создаёт дополнительные логи;
- не требует сетевого API и сторонних сервисов.

Frontend сначала проверяет только `mtime/size` базы и логов. Полный запрос выполняется лишь после обнаружения изменения.

## Важное ограничение атрибуции

Hermes хранит точные токены отдельных основных API-вызовов в `agent.log`, а агрегаты — в `state.db` по `(session, model, provider, task)`.

Поэтому:

- карта и live feed показывают per-call tokens;
- стоимость и totals по task/model берутся из агрегатов;
- стоимость отдельного API-запроса намеренно не вычисляется искусственно.

Для полной per-request cost attribution нужен отдельный append-only usage event в Hermes.

## Структура проекта

```text
hermes-usage-dashboard/
├── hermes_usage.py          # чтение SQLite, парсинг логов и подготовка snapshot
├── server.py                # локальный HTTP-сервер и API дашборда
├── static/index.html        # frontend
├── tests/                   # автоматические тесты
├── requirements.txt         # зависимости (только стандартная библиотека)
└── start-dashboard.bat      # запуск в Windows
```

## Проверка

```bash
python -m unittest discover -s tests -v
python -m py_compile hermes_usage.py server.py
```

## Лицензия

Лицензия в репозитории пока не задана.
