#!/usr/bin/env python3
"""coding-on-phone backend. Python standard library only.

    python3 server/main.py [--host 127.0.0.1] [--port 8377]

It compiles and runs whatever code the client sends, so keep it bound to
localhost and expose it only through a private network (e.g. `tailscale serve`).
"""
import argparse
import json
import mimetypes
import os
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fetchers  # noqa: E402
import lsp       # noqa: E402
import runner    # noqa: E402
import store     # noqa: E402

PUBLIC = os.path.join(store.ROOT, "public")
MAX_BODY = 2 * 1024 * 1024


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def api_state(q, body):
    return {"langs": runner.available(), "lsp": lsp.available(),
            "snippets": store.load_snippets(), "problems": store.list_problems()}


def api_problems(q, body):
    return store.list_problems()


def api_problem(q, body):
    prob = store.load_problem(q.get("id", ""))
    if not prob:
        raise ApiError("找不到這一題", 404)
    return prob


def api_problem_new(q, body):
    pid = "scratch-%d" % int(time.time() * 1000)
    prob = {"id": pid, "source": "scratch", "title": (body.get("title") or "草稿")[:80],
            "url": "", "html": "", "timeLimit": 2.0, "tests": [], "lang": body.get("lang") or "cpp"}
    store.save_problem(prob)
    return store.load_problem(pid)


def api_problem_fetch(q, body):
    try:
        prob = fetchers.fetch(body.get("url"))
    except fetchers.FetchError as e:
        raise ApiError(str(e), 502)
    old = store.load_problem(prob["id"])
    if old:  # keep the user's own tests and settings, refresh the statement
        prob["tests"] = old.get("tests") or prob["tests"]
        prob["lang"] = old.get("lang", "cpp")
        prob["solved"] = old.get("solved", False)
    else:
        prob["lang"] = body.get("lang") or "cpp"
    store.save_problem(prob)
    return store.load_problem(prob["id"])


def api_problem_update(q, body):
    fields = {}
    if "tests" in body:
        fields["tests"] = [{"input": str(t.get("input", ""))[:200000],
                            "expected": str(t.get("expected", ""))[:200000]}
                           for t in body["tests"][:50]]
    if "title" in body:
        fields["title"] = str(body["title"])[:80]
    if "lang" in body:
        fields["lang"] = store.check_lang(body["lang"])
    if "timeLimit" in body:
        fields["timeLimit"] = max(0.2, min(float(body["timeLimit"]), 20))
    if "solved" in body:
        fields["solved"] = bool(body["solved"])
    store.update_problem(body.get("id", ""), **fields)
    return {"ok": True}


def api_problem_delete(q, body):
    store.delete_problem(body.get("id", ""))
    return {"ok": True}


def api_save(q, body):
    store.save_code(body.get("id", ""), body.get("lang"), str(body.get("code", "")))
    return {"ok": True}


def api_run(q, body):
    lang = store.check_lang(body.get("lang"))
    code = str(body.get("code", ""))
    path = store.save_code(body.get("id", ""), lang, code, snapshot=True)
    return runner.run_tests(lang, path, code, body.get("tests") or [], body.get("timeLimit"))


def _lsp_for(body):
    lang = store.check_lang(body.get("lang"))
    server = lsp.get(lang)
    path = store.code_path(body.get("id", ""), lang)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return server, lang, path


def api_complete(q, body):
    server, lang, path = _lsp_for(body)
    if not server:
        return {"available": False, "items": []}
    try:
        items = server.complete(path, lang, str(body.get("code", "")), int(body.get("line", 0)),
                                int(body.get("col", 0)), body.get("trigger") or None)
        return {"available": True, "items": items}
    except Exception as e:
        return {"available": True, "items": [], "error": str(e)}


def api_diagnostics(q, body):
    server, lang, path = _lsp_for(body)
    if not server:
        return {"available": False, "diagnostics": []}
    try:
        d = server.diagnostics(path, lang, str(body.get("code", "")))
        return {"available": True, "diagnostics": d or [], "pending": d is None}
    except Exception as e:
        return {"available": True, "diagnostics": [], "error": str(e)}


def api_history(q, body):
    return store.list_history(q.get("id", ""))


def api_history_file(q, body):
    try:
        return {"code": store.read_history(q.get("id", ""), q.get("name", ""))}
    except OSError:
        raise ApiError("找不到這個版本", 404)


def api_snippets(q, body):
    return store.save_snippets(body.get("snippets"))


GET = {"/api/state": api_state, "/api/problems": api_problems, "/api/problem": api_problem,
       "/api/history": api_history, "/api/history/file": api_history_file}
POST = {"/api/problem/new": api_problem_new, "/api/problem/fetch": api_problem_fetch,
        "/api/problem/update": api_problem_update, "/api/problem/delete": api_problem_delete,
        "/api/save": api_save, "/api/run": api_run, "/api/complete": api_complete,
        "/api/diagnostics": api_diagnostics, "/api/snippets": api_snippets}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "coding-on-phone"

    def log_message(self, fmt, *args):
        if os.environ.get("COP_VERBOSE"):
            super().log_message(fmt, *args)

    def _send(self, status, body, ctype="application/json; charset=utf-8", extra=None):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _api(self, table, body):
        url = urlparse(self.path)
        fn = table.get(url.path)
        if not fn:
            return self._send(404, {"error": "not found"})
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            self._send(200, fn(q, body))
        except ApiError as e:
            self._send(e.status, {"error": str(e)})
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            self._send(500, {"error": "伺服器錯誤：%s" % e})

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            return self._api(GET, {})
        rel = url.path.lstrip("/") or "index.html"
        path = os.path.realpath(os.path.join(PUBLIC, rel))
        if not path.startswith(os.path.realpath(PUBLIC) + os.sep) or not os.path.isfile(path):
            return self._send(404, b"not found", "text/plain")
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        with open(path, "rb") as f:
            self._send(200, f.read(), ctype)

    def do_POST(self):
        # Reject cross-site requests: this endpoint runs code.
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != self.headers.get("Host"):
            return self._send(403, {"error": "cross-origin request refused"})
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self._send(415, {"error": "JSON only"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if n < 0 or n > MAX_BODY:
            return self._send(413, {"error": "request too large"})
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            return self._send(400, {"error": "bad JSON"})
        self._api(POST, body)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default=os.environ.get("COP_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("COP_PORT", "8377")))
    args = ap.parse_args()
    store.init()
    mimetypes.add_type("application/manifest+json", ".webmanifest")
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print("coding-on-phone: http://%s:%d  (data: %s)" % (args.host, args.port, store.DATA), flush=True)
    print("  編譯器:", runner.available(), flush=True)
    print("  語言伺服器:", lsp.available(), flush=True)
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("  注意：這個服務會執行任意程式碼，請確認 %s 只在私有網路上可達。" % args.host, flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
