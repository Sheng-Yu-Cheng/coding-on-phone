"""Minimal LSP client: keeps clangd / a Python language server running and
exposes completion + diagnostics to the HTTP layer."""
import json
import os
import shutil
import subprocess
import threading
import time

from store import PROBLEMS

LANG_ID = {"cpp": "cpp", "c": "c", "py": "python"}


def _find_clangd():
    for name in ["clangd"] + ["clangd-%d" % v for v in range(25, 10, -1)]:
        if shutil.which(name):
            return [name, "--header-insertion=never", "--function-arg-placeholders=0",
                    "--background-index=false", "--completion-style=detailed",
                    "--limit-results=60", "--pch-storage=memory", "--log=error"]
    return None


def _find_python_ls():
    for cmd in (["basedpyright-langserver", "--stdio"], ["pyright-langserver", "--stdio"],
                ["pylsp"], ["jedi-language-server"]):
        if shutil.which(cmd[0]):
            return cmd
    return None


class LspServer:
    def __init__(self, cmd):
        self.cmd = cmd
        self.proc = None
        self.lock = threading.RLock()
        self.wlock = threading.Lock()
        self.next_id = 1
        self.pending = {}      # id -> [event, response]
        self.docs = {}         # path -> (version, text)
        self.diags = {}        # path -> (version, [diagnostics])
        self.diag_cond = threading.Condition()
        self.failed = 0

    # ---- transport -------------------------------------------------------
    def _write(self, msg):
        body = json.dumps(msg).encode("utf-8")
        with self.wlock:
            self.proc.stdin.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
            self.proc.stdin.flush()

    def _reader(self, proc):
        f = proc.stdout
        try:
            while True:
                length = None
                while True:
                    line = f.readline()
                    if not line:
                        return
                    line = line.strip()
                    if not line:
                        break
                    if line.lower().startswith(b"content-length:"):
                        length = int(line.split(b":")[1])
                if length is None:
                    continue
                msg = json.loads(f.read(length).decode("utf-8"))
                self._dispatch(msg)
        except Exception:
            return
        finally:
            for slot in list(self.pending.values()):
                slot[0].set()

    def _dispatch(self, msg):
        if "method" in msg and "id" in msg:      # request from the server
            result = None
            if msg["method"] == "workspace/configuration":
                result = [None for _ in msg.get("params", {}).get("items", [])]
            self._write({"jsonrpc": "2.0", "id": msg["id"], "result": result})
        elif "id" in msg:                         # response to us
            slot = self.pending.get(msg["id"])
            if slot:
                slot[1] = msg
                slot[0].set()
        elif msg.get("method") == "textDocument/publishDiagnostics":
            p = msg["params"]
            path = _uri_to_path(p["uri"])
            with self.diag_cond:
                self.diags[path] = (p.get("version"), p.get("diagnostics", []))
                self.diag_cond.notify_all()

    def request(self, method, params, timeout=8):
        with self.lock:
            rid = self.next_id
            self.next_id += 1
            slot = [threading.Event(), None]
            self.pending[rid] = slot
            self._write({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        slot[0].wait(timeout)
        self.pending.pop(rid, None)
        if slot[1] is None:
            raise TimeoutError(method)
        if "error" in slot[1]:
            raise RuntimeError(slot[1]["error"].get("message", "lsp error"))
        return slot[1].get("result")

    def notify(self, method, params):
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    # ---- lifecycle -------------------------------------------------------
    def ensure(self):
        with self.lock:
            if self.proc and self.proc.poll() is None:
                return
            if self.failed >= 3:
                raise RuntimeError("language server keeps crashing")
            self.docs.clear()
            self.diags.clear()
            self.proc = subprocess.Popen(self.cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=subprocess.DEVNULL, cwd=PROBLEMS)
            threading.Thread(target=self._reader, args=(self.proc,), daemon=True).start()
            try:
                self.request("initialize", {
                    "processId": os.getpid(),
                    "rootUri": _path_to_uri(PROBLEMS),
                    "workspaceFolders": [{"uri": _path_to_uri(PROBLEMS), "name": "problems"}],
                    "capabilities": {
                        "textDocument": {
                            "synchronization": {"didSave": False},
                            "completion": {"completionItem": {"snippetSupport": False},
                                           "contextSupport": True},
                            "publishDiagnostics": {"versionSupport": True},
                        },
                        "workspace": {"configuration": True, "workspaceFolders": True},
                    },
                }, timeout=20)
                self.notify("initialized", {})
                self.failed = 0
            except Exception:
                self.failed += 1
                self.stop()
                raise

    def stop(self):
        with self.lock:
            if self.proc:
                try:
                    self.proc.kill()
                except OSError:
                    pass
                self.proc = None

    # ---- documents -------------------------------------------------------
    def sync(self, path, lang, text):
        with self.lock:
            self.ensure()
            uri = _path_to_uri(path)
            cur = self.docs.get(path)
            if cur is None:
                version = 1
                self.notify("textDocument/didOpen", {"textDocument": {
                    "uri": uri, "languageId": LANG_ID[lang], "version": version, "text": text}})
            elif cur[1] == text:
                return cur[0]
            else:
                version = cur[0] + 1
                self.notify("textDocument/didChange", {
                    "textDocument": {"uri": uri, "version": version},
                    "contentChanges": [{"text": text}]})
            self.docs[path] = (version, text)
            if len(self.docs) > 8:   # close the oldest documents
                for old in list(self.docs)[:-8]:
                    if old != path:
                        self.notify("textDocument/didClose", {"textDocument": {"uri": _path_to_uri(old)}})
                        self.docs.pop(old, None)
                        self.diags.pop(old, None)
            return version

    def complete(self, path, lang, text, line, col, trigger=None):
        self.sync(path, lang, text)
        ctx = {"triggerKind": 2, "triggerCharacter": trigger} if trigger else {"triggerKind": 1}
        res = self.request("textDocument/completion", {
            "textDocument": {"uri": _path_to_uri(path)},
            "position": {"line": line, "character": col},
            "context": ctx}, timeout=6)
        items = res.get("items", []) if isinstance(res, dict) else (res or [])
        items.sort(key=lambda it: it.get("sortText") or it.get("label") or "")
        out = []
        for it in items[:60]:
            label = (it.get("filterText") or it.get("label") or "").strip(" •")
            edit = it.get("textEdit") or {}
            rng = edit.get("range") or edit.get("replace") or edit.get("insert")
            insert = edit.get("newText") or it.get("insertText") or label
            if not label or "\n" in insert:
                continue
            out.append({
                "label": label,
                "insert": insert,
                "from": rng["start"]["character"] if rng and rng["start"]["line"] == line else None,
                "detail": ((it.get("detail") or "") + " " + (it.get("label") or "").strip(" •"))[:80].strip(),
                "kind": it.get("kind"),
            })
        return out

    def diagnostics(self, path, lang, text, wait=4.0):
        version = self.sync(path, lang, text)
        deadline = time.monotonic() + wait
        with self.diag_cond:
            while True:
                got = self.diags.get(path)
                if got and (got[0] is None or got[0] >= version):
                    break
                left = deadline - time.monotonic()
                if left <= 0:
                    return None
                self.diag_cond.wait(left)
        out = []
        for d in got[1]:
            r = d.get("range", {})
            out.append({
                "line": r.get("start", {}).get("line", 0),
                "col": r.get("start", {}).get("character", 0),
                "endLine": r.get("end", {}).get("line", 0),
                "endCol": r.get("end", {}).get("character", 0),
                "severity": d.get("severity", 1),
                "message": str(d.get("message", ""))[:400],
            })
        return out


def _path_to_uri(path):
    from urllib.parse import quote
    return "file://" + quote(os.path.abspath(path))


def _uri_to_path(uri):
    from urllib.parse import unquote, urlparse
    return unquote(urlparse(uri).path)


_servers = {}
_guard = threading.Lock()


def get(lang):
    """Return the LspServer for a language, or None if none is installed."""
    key = "clangd" if lang in ("cpp", "c") else "python"
    with _guard:
        if key not in _servers:
            cmd = _find_clangd() if key == "clangd" else _find_python_ls()
            _servers[key] = LspServer(cmd) if cmd else None
        return _servers[key]


def available():
    return {lang: (get(lang).cmd[0] if get(lang) else None) for lang in LANG_ID}
