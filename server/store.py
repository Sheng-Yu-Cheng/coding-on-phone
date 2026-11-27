"""On-disk storage: problems, solutions, history, snippets."""
import json
import os
import re
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("COP_DATA") or os.path.join(ROOT, "data")
PROBLEMS = os.path.join(DATA, "problems")
EXT = {"cpp": "cpp", "c": "c", "py": "py"}
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
HISTORY_KEEP = 40
_lock = threading.Lock()

CLANGD_CONFIG = """If:
  PathMatch: .*\\.cpp
CompileFlags:
  Add: [-std=gnu++20, -Wall, -Wextra, -Wshadow]
---
If:
  PathMatch: .*\\.c
CompileFlags:
  Add: [-std=gnu17, -Wall, -Wextra]
"""


def init():
    os.makedirs(PROBLEMS, exist_ok=True)
    cfg = os.path.join(PROBLEMS, ".clangd")
    if not os.path.exists(cfg):
        with open(cfg, "w") as f:
            f.write(CLANGD_CONFIG)


def check_id(pid):
    if not isinstance(pid, str) or not ID_RE.match(pid):
        raise ValueError("bad problem id")
    return pid


def check_lang(lang):
    if lang not in EXT:
        raise ValueError("bad language")
    return lang


def pdir(pid):
    return os.path.join(PROBLEMS, check_id(pid))


def code_path(pid, lang):
    return os.path.join(pdir(pid), "main." + EXT[check_lang(lang)])


def _read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def save_problem(prob):
    with _lock:
        d = pdir(prob["id"])
        os.makedirs(d, exist_ok=True)
        prob["updated"] = time.time()
        _write_json(os.path.join(d, "problem.json"), prob)
    return prob


def load_problem(pid):
    prob = _read_json(os.path.join(pdir(pid), "problem.json"), None)
    if prob is None:
        return None
    prob["code"] = {}
    for lang in EXT:
        try:
            with open(code_path(pid, lang), encoding="utf-8") as f:
                prob["code"][lang] = f.read()
        except OSError:
            pass
    return prob


def update_problem(pid, **fields):
    with _lock:
        path = os.path.join(pdir(pid), "problem.json")
        prob = _read_json(path, None)
        if prob is None:
            raise ValueError("no such problem")
        prob.update(fields)
        prob["updated"] = time.time()
        _write_json(path, prob)
    return prob


def list_problems():
    out = []
    for name in os.listdir(PROBLEMS):
        if not ID_RE.match(name):
            continue
        p = _read_json(os.path.join(PROBLEMS, name, "problem.json"), None)
        if p:
            out.append({k: p.get(k) for k in ("id", "source", "title", "url", "updated", "lang", "solved")})
    out.sort(key=lambda p: -(p.get("updated") or 0))
    return out


def delete_problem(pid):
    import shutil
    shutil.rmtree(pdir(pid), ignore_errors=True)


def save_code(pid, lang, code, snapshot=False):
    """Write the solution file; with snapshot=True also keep a history copy."""
    with _lock:
        d = pdir(pid)
        os.makedirs(d, exist_ok=True)
        path = code_path(pid, lang)
        with open(path, "w", encoding="utf-8") as f:
            f.write(code)
        if snapshot and code.strip():
            h = os.path.join(d, "history")
            os.makedirs(h, exist_ok=True)
            names = sorted(n for n in os.listdir(h) if n.endswith("." + EXT[lang]))
            last = None
            if names:
                with open(os.path.join(h, names[-1]), encoding="utf-8") as f:
                    last = f.read()
            if last != code:
                name = "%d.%s" % (int(time.time() * 1000), EXT[lang])
                with open(os.path.join(h, name), "w", encoding="utf-8") as f:
                    f.write(code)
                names.append(name)
            for old in names[:-HISTORY_KEEP]:
                os.remove(os.path.join(h, old))
    return path


def list_history(pid):
    h = os.path.join(pdir(pid), "history")
    out = []
    if os.path.isdir(h):
        for n in sorted(os.listdir(h), reverse=True):
            m = re.match(r"^(\d+)\.(cpp|c|py)$", n)
            if m:
                st = os.stat(os.path.join(h, n))
                out.append({"name": n, "time": int(m.group(1)) / 1000, "lang": m.group(2), "size": st.st_size})
    return out


def read_history(pid, name):
    if not re.match(r"^\d+\.(cpp|c|py)$", name or ""):
        raise ValueError("bad history name")
    with open(os.path.join(pdir(pid), "history", name), encoding="utf-8") as f:
        return f.read()


def load_snippets():
    data = _read_json(os.path.join(DATA, "snippets.json"), None)
    if data is None:
        data = _read_json(os.path.join(ROOT, "server", "default_snippets.json"), [])
    return data


def save_snippets(snips):
    if not isinstance(snips, list):
        raise ValueError("snippets must be a list")
    clean = []
    for s in snips:
        clean.append({
            "abbr": str(s.get("abbr", ""))[:40],
            "name": str(s.get("name", ""))[:80],
            "lang": s.get("lang") if s.get("lang") in EXT else "cpp",
            "body": str(s.get("body", ""))[:20000],
            "template": bool(s.get("template")),
        })
    with _lock:
        _write_json(os.path.join(DATA, "snippets.json"), clean)
    return clean
