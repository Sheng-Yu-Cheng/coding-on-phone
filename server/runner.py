"""Compile and run solutions against test cases, with time/memory limits."""
import hashlib
import os
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

from store import DATA

CACHE = os.path.join(DATA, "build-cache")
OUT_LIMIT = 256 * 1024          # bytes of stdout/stderr returned to the phone
FILE_LIMIT = 32 * 1024 * 1024   # bytes a run may write to stdout
MEM_LIMIT = 1024 * 1024 * 1024  # address-space limit for a run
COMPILE_TIMEOUT = 60

COMPILE = {
    "cpp": ["g++", "-std=gnu++20", "-O2", "-Wall", "-Wextra", "-Wshadow", "-o", "{out}", "{src}"],
    "c": ["gcc", "-std=gnu17", "-O2", "-Wall", "-Wextra", "-o", "{out}", "{src}", "-lm"],
}
_build_locks = {}
_build_guard = threading.Lock()


def available():
    return {
        "cpp": bool(shutil.which("g++")),
        "c": bool(shutil.which("gcc")),
        "py": True,
    }


def _clip(data):
    text = data.decode("utf-8", "replace")
    if len(text) > OUT_LIMIT:
        text = text[:OUT_LIMIT] + "\n…（輸出過長，已截斷）"
    return text


def compile_code(lang, src_path, code):
    """Return (ok, stderr, binary_path). Binaries are cached by source hash."""
    if lang == "py":
        proc = subprocess.run([sys.executable, "-m", "py_compile", src_path],
                              capture_output=True, timeout=COMPILE_TIMEOUT)
        return proc.returncode == 0, _clip(proc.stderr), None
    os.makedirs(CACHE, exist_ok=True)
    key = hashlib.sha256((lang + "\0" + " ".join(COMPILE[lang]) + "\0" + code).encode()).hexdigest()[:32]
    out = os.path.join(CACHE, key)
    with _build_guard:
        lock = _build_locks.setdefault(key, threading.Lock())
    with lock:
        if os.path.exists(out):
            warn = ""
            try:
                with open(out + ".log", encoding="utf-8") as f:
                    warn = f.read()
            except OSError:
                pass
            return True, warn, out
        cmd = [a.format(out=out + ".tmp", src=src_path) for a in COMPILE[lang]]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=COMPILE_TIMEOUT,
                                  cwd=os.path.dirname(src_path))
        except subprocess.TimeoutExpired:
            return False, "編譯逾時", None
        except FileNotFoundError:
            return False, "找不到編譯器 %s，請在伺服器上安裝" % cmd[0], None
        err = _clip(proc.stderr).replace(src_path, os.path.basename(src_path))
        if proc.returncode != 0:
            return False, err, None
        os.replace(out + ".tmp", out)
        with open(out + ".log", "w", encoding="utf-8") as f:
            f.write(err)
        _prune_cache()
        return True, err, out


def _prune_cache(keep=60):
    try:
        files = [os.path.join(CACHE, n) for n in os.listdir(CACHE) if not n.endswith(".log")]
        files.sort(key=os.path.getmtime)
        for p in files[:-keep]:
            for q in (p, p + ".log"):
                try:
                    os.remove(q)
                except OSError:
                    pass
    except OSError:
        pass


def _limits(seconds):
    def apply():
        os.setsid()
        cpu = int(seconds) + 2
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 1))
        resource.setrlimit(resource.RLIMIT_FSIZE, (FILE_LIMIT, FILE_LIMIT))
        resource.setrlimit(resource.RLIMIT_AS, (MEM_LIMIT, MEM_LIMIT))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        hard = resource.getrlimit(resource.RLIMIT_STACK)[1]
        try:  # deep recursion is normal in contest code: lift the 8 MB default
            resource.setrlimit(resource.RLIMIT_STACK, (hard, hard))
        except (ValueError, OSError):
            pass
    return apply


def run_one(lang, binary, src_path, stdin_text, time_limit):
    cmd = [sys.executable, src_path] if lang == "py" else [binary]
    work = tempfile.mkdtemp(prefix="cop-run-")
    try:
        with open(os.path.join(work, "in"), "w", encoding="utf-8") as f:
            f.write(stdin_text)
        fin = open(os.path.join(work, "in"), "rb")
        fout = open(os.path.join(work, "out"), "wb")
        ferr = open(os.path.join(work, "err"), "wb")
        pre = _limits(time_limit)
        start = time.monotonic()
        proc = subprocess.Popen(cmd, stdin=fin, stdout=fout, stderr=ferr, cwd=work, preexec_fn=pre)
        timed_out = False
        try:
            proc.wait(timeout=time_limit)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                proc.kill()
            proc.wait()
        elapsed = time.monotonic() - start
        for f in (fin, fout, ferr):
            f.close()
        with open(os.path.join(work, "out"), "rb") as f:
            out = _clip(f.read(OUT_LIMIT + 1024))
        with open(os.path.join(work, "err"), "rb") as f:
            err = _clip(f.read(OUT_LIMIT + 1024)).replace(src_path, os.path.basename(src_path))
        code = proc.returncode
        status = "OK"
        detail = ""
        if timed_out or code == -signal.SIGXCPU:
            status = "TLE"
        elif code != 0:
            status = "RE"
            if code < 0:
                try:
                    detail = signal.Signals(-code).name
                except ValueError:
                    detail = "signal %d" % -code
            else:
                detail = "exit code %d" % code
        return {"status": status, "detail": detail, "stdout": out, "stderr": err,
                "timeMs": int(elapsed * 1000)}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def same_output(actual, expected):
    """Judge-style compare: ignore trailing whitespace and trailing blank lines."""
    def norm(s):
        lines = [ln.rstrip() for ln in s.replace("\r\n", "\n").split("\n")]
        while lines and not lines[-1]:
            lines.pop()
        return lines
    return norm(actual) == norm(expected)


def run_tests(lang, src_path, code, tests, time_limit):
    time_limit = max(0.2, min(float(time_limit or 2), 20))
    ok, cerr, binary = compile_code(lang, src_path, code)
    result = {"compile": {"ok": ok, "stderr": cerr}, "results": []}
    if not ok:
        return result
    for t in tests[:50]:
        r = run_one(lang, binary, src_path, str(t.get("input", "")), time_limit)
        exp = t.get("expected")
        if r["status"] == "OK" and isinstance(exp, str) and exp.strip() != "":
            r["status"] = "AC" if same_output(r["stdout"], exp) else "WA"
        result["results"].append(r)
    return result
