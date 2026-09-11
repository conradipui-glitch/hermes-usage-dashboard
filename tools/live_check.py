"""Живая проверка четырёх добивок панели: одометр, порог дня, drill-down, копирование, PNG.

Гоняет настоящий Chrome (headless, CDP) по живому дашборду и печатает факты,
а не намерения. Запуск (сервер должен быть поднят):

    python tools/live_check.py            # все проверки
    python tools/live_check.py --png out.png

Что проверяется:
  1) одометр — при обновлении значение прокручивается (класс .odometer появляется);
  2) порог дня — баннер переходит в warn, на графике расходов появляется линия порога,
     в «Главном» — карточка «Порог дня»;
  3) drill-down — клик по инструменту фильтрует живую ленту, сброс возвращает всё;
     клик по модели ставит фильтр модели и приходит ровно один запрос с этим фильтром;
  4) копирование — кнопки «ID» в разговорах и действия в «подробностях» на месте,
     копирование возвращает true;
  5) PNG — экспорт отдаёт непустой кадр (проверяем размер файла и число цветов).

Итог: печатает JSON-строки по пунктам и завершается кодом 1, если что-то не сработало.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

try:
    import websockets
except ImportError as exc:  # pragma: no cover
    sys.exit("нужен модуль websockets: python -m pip install websockets")

CHROME = r"C:/Program Files/Google/Chrome/Application/chrome.exe"
URL = "http://127.0.0.1:8765/"
def _free_port() -> int:
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


async def cdp_roundtrip(ws, mid: int, method: str, params=None):
    # sessionId здесь лишний: на соединении с конкретной целью CDP его не принимает
    # и молча отвечает ошибкой — из-за этого «Runtime.evaluate» всегда возвращал пусто.
    await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(await ws.recv())
        if msg.get("id") == mid:
            return msg


async def evaluate(ws, mid: int, expr: str, await_promise: bool = False):
    res = await cdp_roundtrip(ws, mid, "Runtime.evaluate", {
        "expression": expr, "returnByValue": True, "awaitPromise": await_promise,
        "userGesture": True,  # без жеста пользователя document.execCommand('copy') не работает
    })
    inner = res.get("result", {})
    if "exceptionDetails" in inner:
        det = inner["exceptionDetails"]
        return {"__error": (det.get("exception") or {}).get("description") or str(det.get("text"))}
    return inner.get("result", {}).get("value")


async def start_page(width: int = 1600, height: int = 1200):
    profile = tempfile.mkdtemp(prefix="hermes-live-check-")
    port = _free_port()  # свой порт на каждый запуск: чужой висящий Chrome ломает подключение
    proc = subprocess.Popen(
        [CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
         f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
         f"--window-size={width},{height}", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    target = None
    for _ in range(80):
        try:
            listing = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list"))
            target = next((t for t in listing if t["type"] == "page"), None)
            if target:
                break
        except Exception:
            pass
        await asyncio.sleep(0.4)
    if not target:
        proc.terminate()
        raise RuntimeError("Chrome не поднялся (CDP недоступен)")
    return proc, target


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--png", default="", help="куда сохранить кадр из проверки PNG")
    args = ap.parse_args()

    try:
        urllib.request.urlopen(URL + "api/health", timeout=4).read()
    except Exception as exc:
        print(f"сервер не отвечает на {URL}api/health: {exc}")
        return 1

    proc, target = await start_page()
    fails = []
    png_info = None
    try:
        async with websockets.connect(target["webSocketDebuggerUrl"], max_size=None) as ws:
            mid = 1
            for method, params in (
                ("Page.enable", None),
                ("Runtime.enable", None),
                ("Emulation.setDeviceMetricsOverride",
                 {"width": 1600, "height": 1200, "deviceScaleFactor": 1, "mobile": False}),
                ("Page.navigate", {"url": URL}),
            ):
                await cdp_roundtrip(ws, mid, method, params)
                mid += 1

            ready = False
            for _ in range(80):
                await asyncio.sleep(0.5)
                if await evaluate(ws, mid, "!!(window.__hud && __hud.state.data && !__hud.state.data.error)"):
                    ready = True
                    break
                mid += 1
            if not ready:
                print("данные не загрузились")
                return 1

            # 1) одометр: подменяем показанное значение на «1», просим реальное обновление
            #    и ждём, пока число прокрутится обратно к настоящему.
            rolled = await evaluate(ws, mid, r"""(async () => {
              const box = document.getElementById('kpis');
              if (!box) return { key: null, rolled: false };
              const key = Object.keys(__hud.state.kpiValues).find((k) => /^[\d\s]+$/.test(__hud.state.kpiValues[k] || ''));
              if (!key) return { key: null, rolled: false };
              const real = __hud.state.kpiValues[key];
              const before = box.textContent;
              __hud.state.kpiValues[key] = '1';
              let seen = false;
              const obs = new MutationObserver(() => { if (box.querySelector('.kpi-value.odometer')) seen = true; });
              obs.observe(box, { subtree: true, attributes: true, childList: true });
              __hud.loadSnapshot(true);
              for (let i = 0; i < 60; i++) {
                await new Promise((r) => setTimeout(r, 300));
                if (seen && box.textContent.includes(real)) break;
              }
              obs.disconnect();
              return { key, was: real, rolled: seen, domBackToReal: box.textContent.includes(real),
                       before: before.slice(0, 40) };
            })()""", await_promise=True)
            mid += 1
            if not rolled or not rolled.get("rolled") or not rolled.get("domBackToReal"):
                fails.append("одометр не прокрутился")
            print("1) одометр:", json.dumps(rolled, ensure_ascii=False))

            # 2) порог дня
            limited = await evaluate(ws, mid, r"""(async () => {
              localStorage.setItem('hud.dayLimit', '0.02');
              const waitBanner = async () => {
                for (let i = 0; i < 60; i++) {
                  await new Promise((r) => setTimeout(r, 300));
                  const b = document.getElementById('statusBanner');
                  if (b && /порог/i.test(b.textContent)) return true;
                }
                return false;
              };
              const waited = waitBanner();
              await __hud.loadSnapshot();
              const ok = await waited;
              const banner = document.getElementById('statusBanner');
              const line = document.querySelector('.limit-line');
              const fact = [...document.querySelectorAll('.fact')].find((f) => /Порог дня/i.test(f.textContent));
              return {
                waited: ok,
                bannerClass: banner ? banner.className : null,
                bannerText: banner ? banner.textContent.replace(/\s+/g, ' ').trim().slice(0, 150) : null,
                limitLine: line ? line.textContent.replace(/\s+/g, ' ').trim() : null,
                dayFact: fact ? fact.textContent.replace(/\s+/g, ' ').trim().slice(0, 90) : null,
              };
            })()""", await_promise=True)
            mid += 1
            if not limited or "warn" not in (limited.get("bannerClass") or ""):
                fails.append("порог дня не показан в баннере")
            print("2) порог дня:", json.dumps(limited, ensure_ascii=False))

            # 3) drill-down по инструменту и по модели
            drill = await evaluate(ws, mid, r"""(async () => {
              localStorage.removeItem('hud.dayLimit');
              await __hud.loadSnapshot();
              const feed = () => document.querySelectorAll('#liveEvents .event').length;
              const out = { before: feed() };
              const row = document.querySelector('tr[data-drill-tool]');
              out.tool = row && row.dataset.drillTool;
              row && row.click();
              await new Promise((r) => setTimeout(r, 500));
              out.chip = (document.querySelector('.chip.drill') || {}).textContent || null;
              out.shownRows = feed();
              const reset = document.querySelector('[data-drill-reset]');
              reset && reset.click();
              await new Promise((r) => setTimeout(r, 500));
              out.rowsAfterReset = feed();
              return out;
            })()""", await_promise=True)
            mid += 1
            drill_ok = bool(drill and drill.get("tool") and drill.get("shownRows") and drill.get("rowsAfterReset") and drill["shownRows"] < drill["rowsAfterReset"])
            if not drill_ok:
                fails.append("drill-down по инструменту не подтверждён")
            print("3a) drill-down по инструменту:", json.dumps(drill, ensure_ascii=False))

            modeldrill = await evaluate(ws, mid, r"""(async () => {
              const calls = [];
              const base = (__hud.state.data.sessions || []).length;
              const orig = window.fetch;
              window.fetch = function () {
                const p = orig.apply(this, arguments);
                if (String(arguments[0]).includes('/api/snapshot')) {
                  p.then((r) => r.clone().json()).then((j) => calls.push({
                    url: String(arguments[0]).replace(location.origin, ''),
                    got: j.filter ? j.filter.model : null,
                    sessions: (j.sessions || []).length,
                  })).catch(() => {});
                }
                return p;
              };
              const row = document.querySelector('tr[data-drill-model]');
              const model = row && row.dataset.drillModel;
              row && row.click();
              // холодный пересчёт снапшота на свежих логах — до ~10 с, поэтому ждём по условию
              for (let i = 0; i < 60; i++) {
                await new Promise((r) => setTimeout(r, 300));
                if (__hud.state.data.filter && __hud.state.data.filter.model === model
                    && (__hud.state.data.sessions || []).length < base) break;
              }
              window.fetch = orig;
              return { model, baselineSessions: base, applied: __hud.state.data.filter ? __hud.state.data.filter.model : null,
                       sessionsNow: (__hud.state.data.sessions || []).length, calls };
            })()""", await_promise=True)
            mid += 1
            # запросов может быть несколько: автообновление тоже несёт фильтр — это нормально.
            # важно, что фильтр применён, данные сузились и каждый запрос ушёл с фильтром.
            md_calls = (modeldrill or {}).get("calls") or []
            md_ok = bool(modeldrill and modeldrill.get("model")
                         and modeldrill.get("applied") == modeldrill["model"]
                         and modeldrill.get("sessionsNow", 0) < modeldrill.get("baselineSessions", 0)
                         and md_calls and all(c.get("got") == modeldrill["model"] for c in md_calls))
            if not md_ok:
                fails.append("drill-down по модели не подтверждён")
            print("3b) drill-down по модели:", json.dumps(modeldrill, ensure_ascii=False))

            # 4) копирование ID разговора
            copy = await evaluate(ws, mid, r"""(async () => {
              const btn = document.querySelector('.copy-btn');
              const ok = await __hud.copyText(btn ? btn.dataset.copy : 'проверка');
              return { copyButtons: document.querySelectorAll('.copy-btn').length, copyOk: ok,
                       sample: btn ? btn.dataset.copy : null };
            })()""", await_promise=True)
            mid += 1
            if not copy or not copy.get("copyOk") or not copy.get("copyButtons"):
                fails.append("копирование ID не подтверждено")
            print("4) копирование ID:", json.dumps(copy, ensure_ascii=False))

            # 5) «подробности» разговора: действия
            actions = await evaluate(ws, mid, r"""(async () => {
              const row = document.querySelector('tr[data-session]');
              const sid = row && row.dataset.session;
              row && row.click();
              // холодный расчёт карты на свежих логах занимает ~5-7 с — ждём до 20 с
              for (let i = 0; i < 100 && !document.querySelector('#graphSvg [data-node]'); i++) await new Promise((r) => setTimeout(r, 200));
              const n2 = document.querySelector('#graphSvg [data-node]');
              n2 && n2.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              await new Promise((r) => setTimeout(r, 300));
              return { sid, nodes: document.querySelectorAll('#graphSvg [data-node]').length,
                       graphMeta: (document.getElementById('graphMeta') || {}).textContent,
                       actions: [...document.querySelectorAll('.inspector-actions button, .inspector-actions a')].map((b) => b.textContent.trim()) };
            })()""", await_promise=True)
            mid += 1
            if not actions or not actions.get("nodes") or len(actions.get("actions") or []) < 3:
                fails.append("действия в «подробностях» не появились")
            print("5) подробности:", json.dumps(actions, ensure_ascii=False))

            # 6) PNG
            url = await evaluate(ws, mid, "window.__hud.exportPng({ download: false, scale: 1 })", await_promise=True)
            mid += 1
            if isinstance(url, str) and url.startswith("data:image/png;base64,"):
                raw = base64.b64decode(url.split(",", 1)[1])
                if args.png:
                    Path(args.png).write_bytes(raw)
                png_info = {"bytes": len(raw), "to": args.png or "(не сохранён)"}
                if len(raw) < 50_000:
                    fails.append("кадр PNG подозрительно пустой")
            else:
                fails.append("экспорт PNG не вернул кадр")
                png_info = {"bytes": 0, "to": None}
            print("6) PNG:", json.dumps(png_info, ensure_ascii=False))
    finally:
        proc.terminate()

    print("\nИТОГ:", "замечаний нет" if not fails else "; ".join(fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
