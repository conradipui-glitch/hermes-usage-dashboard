from __future__ import annotations

import argparse
import json
import mimetypes
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from hermes_usage import HermesReader, resolve_hermes_home


STATIC_DIR = Path(__file__).resolve().parent / "static"


class DashboardApp:
    def __init__(self, reader: HermesReader, poll_ms: int = 2000) -> None:
        self.reader = reader
        self.poll_ms = max(500, min(int(poll_ms), 60000))
        self._lock = threading.Lock()
        self._cache: dict[int, tuple[str, dict]] = {}

    def heartbeat(self) -> dict:
        return {
            **self.reader.heartbeat(),
            "poll_ms": self.poll_ms,
        }

    def snapshot(self, days: int) -> dict:
        days = max(1, min(int(days), 3650))
        heartbeat = self.reader.heartbeat()
        signature = heartbeat["signature"]["hash"]
        with self._lock:
            cached = self._cache.get(days)
            if cached and cached[0] == signature:
                return cached[1]
            data = self.reader.snapshot(days=days)
            self._cache[days] = (data["signature"]["hash"], data)
            # Keep the cache bounded when the user clicks through many periods.
            if len(self._cache) > 8:
                oldest = next(iter(self._cache))
                if oldest != days:
                    self._cache.pop(oldest, None)
            return data

    def graph(self, session_id: str) -> dict:
        return self.reader.graph(session_id)


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "HermesUsageDashboard/0.1"

    @property
    def app(self) -> DashboardApp:
        return self.server.app  # type: ignore[attr-defined]

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path) -> None:
        if not path.is_file() or STATIC_DIR not in path.parents:
            self._send_json({"error": "not found"}, 404)
            return
        try:
            body = path.read_bytes()
        except OSError as exc:
            self._send_json({"error": str(exc)}, 500)
            return
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix == ".html":
            content_type = "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        try:
            if parsed.path == "/":
                self._send_file(STATIC_DIR / "index.html")
                return
            if parsed.path == "/api/health":
                self._send_json({"ok": True, "service": self.server_version})
                return
            if parsed.path == "/api/config":
                self._send_json({
                    "poll_ms": self.app.poll_ms,
                    "default_days": 7,
                    "read_only": True,
                    "title": "Hermes Usage Monitor",
                })
                return
            if parsed.path == "/api/heartbeat":
                self._send_json(self.app.heartbeat())
                return
            if parsed.path == "/api/snapshot":
                days = int(query.get("days", [30])[0])
                self._send_json(self.app.snapshot(days))
                return
            if parsed.path == "/api/graph":
                session_id = query.get("session_id", [""])[0]
                if not session_id or len(session_id) > 200:
                    self._send_json({"error": "session_id is required"}, 400)
                    return
                self._send_json(self.app.graph(session_id))
                return
            if parsed.path.startswith("/static/"):
                relative = parsed.path.removeprefix("/static/")
                self._send_file(STATIC_DIR / relative)
                return
            self._send_json({"error": "not found"}, 404)
        except (ValueError, TypeError) as exc:
            self._send_json({"error": str(exc)}, 400)
        except Exception as exc:  # Keep the monitor alive if one read races a log rotation.
            self._send_json({"error": str(exc)}, 500)

    def log_message(self, format: str, *args: object) -> None:
        # The monitor is local and quiet by default; errors are still handled as JSON.
        return


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only real-time Hermes token and tool monitor")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="HTTP port (default: 8765; 0 = auto)")
    parser.add_argument("--hermes-home", help="Hermes home; defaults to HERMES_HOME or LOCALAPPDATA/hermes")
    parser.add_argument("--poll-ms", type=int, default=2000, help="Frontend heartbeat interval (500-60000 ms)")
    parser.add_argument("--no-open", action="store_true", help="Do not open the browser")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    home = resolve_hermes_home(args.hermes_home)
    reader = HermesReader(
        db_path=home / "state.db",
        log_paths=(home / "logs" / "agent.log", home / "logs" / "agent.log.1"),
    )
    app = DashboardApp(reader, poll_ms=args.poll_ms)
    server = ThreadingHTTPServer((args.host, args.port), RequestHandler)
    server.app = app  # type: ignore[attr-defined]
    url = f"http://{args.host}:{server.server_address[1]}/"
    print(f"Hermes Usage Monitor: {url}")
    print(f"Read-only source: {home}")
    print("No API keys are read; no Hermes files are written.")
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
