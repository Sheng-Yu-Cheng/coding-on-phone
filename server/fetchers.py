"""Fetch problem statements + sample tests from CSES, Codeforces and LeetCode.

CSES is the primary, supported source. Codeforces and LeetCode are best effort:
both sit behind anti-bot protection and may refuse automated requests.
"""
import html
import json
import re
import urllib.error
import urllib.request
from html.parser import HTMLParser

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/17.4 Safari/605.1.15")


class FetchError(Exception):
    pass


def http_get(url, data=None, headers=None, timeout=15):
    h = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9",
         "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(4 * 1024 * 1024)
            return raw.decode(r.headers.get_content_charset() or "utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise FetchError("網站回應 HTTP %d" % e.code)
    except Exception as e:  # DNS, timeout, TLS…
        raise FetchError("連線失敗：%s" % e)


# ---- HTML helpers -----------------------------------------------------------
ALLOWED = {"p", "pre", "code", "ul", "ol", "li", "b", "strong", "i", "em", "u", "br", "hr",
           "sup", "sub", "h3", "h4", "table", "thead", "tbody", "tr", "td", "th", "blockquote",
           "span", "div", "img", "tt"}
RENAME = {"h1": "h3", "h2": "h3", "h5": "h4", "h6": "h4", "tt": "code"}
VOID = {"br", "hr", "img"}
DROP = {"script", "style", "noscript", "iframe", "svg", "button", "input", "form", "select"}


class _Sanitizer(HTMLParser):
    """Re-emit a whitelist of tags with all attributes removed."""

    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.skip = 0
        self.base = base

    def handle_starttag(self, tag, attrs):
        if tag in DROP:
            self.skip += 1
            return
        if self.skip:
            return
        tag = RENAME.get(tag, tag)
        if tag not in ALLOWED:
            return
        if tag == "img":
            src = dict(attrs).get("src") or ""
            if src.startswith("//"):
                src = "https:" + src
            elif src.startswith("/"):
                src = self.base + src
            if src.startswith("https://"):
                self.out.append('<img src="%s">' % html.escape(src, quote=True))
            return
        self.out.append("<%s>" % tag)

    def handle_endtag(self, tag):
        if tag in DROP:
            self.skip = max(0, self.skip - 1)
            return
        tag = RENAME.get(tag, tag)
        if self.skip or tag not in ALLOWED or tag in VOID:
            return
        self.out.append("</%s>" % tag)

    def handle_data(self, data):
        if not self.skip:
            self.out.append(html.escape(data, quote=False))


def sanitize(fragment, base=""):
    s = _Sanitizer(base)
    s.feed(fragment)
    s.close()
    return "".join(s.out)


def inner_of(page, open_re):
    """Inner HTML of the first element whose opening tag matches open_re."""
    m = re.search(open_re, page, re.S | re.I)
    if not m:
        return None
    tag = re.match(r"<(\w+)", m.group(0)).group(1)
    depth, pos = 1, m.end()
    for t in re.finditer(r"<(/?)%s\b[^>]*>" % tag, page[pos:], re.I):
        depth += -1 if t.group(1) else 1
        if depth == 0:
            return page[pos:pos + t.start()]
    return page[pos:]


def pre_text(fragment):
    """Text of a <pre> block: <br> and line <div>s become newlines."""
    t = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.I)
    t = re.sub(r"</div\s*>", "\n", t, flags=re.I)
    t = re.sub(r"<[^>]+>", "", t)
    t = html.unescape(t).replace("\r\n", "\n").replace("\xa0", " ")
    t = t.strip("\n")
    return t + "\n" if t else ""


TEX = [(r"\\leq?(?![a-zA-Z])", "≤"), (r"\\geq?(?![a-zA-Z])", "≥"), (r"\\neq?(?![a-zA-Z])", "≠"),
       (r"\\cdots?(?![a-zA-Z])", "·"), (r"\\times(?![a-zA-Z])", "×"), (r"\\l?dots(?![a-zA-Z])", "…"),
       (r"\\(rightarrow|to)(?![a-zA-Z])", "→"), (r"\\leftarrow(?![a-zA-Z])", "←"),
       (r"\\in(?![a-zA-Z])", "∈"), (r"\\sum(?![a-zA-Z])", "∑"), (r"\\infty(?![a-zA-Z])", "∞"),
       (r"\\oplus(?![a-zA-Z])", "⊕"), (r"\\bmod(?![a-zA-Z])", " mod "), (r"\\pmod", " mod "),
       (r"\\lfloor(?![a-zA-Z])", "⌊"), (r"\\rfloor(?![a-zA-Z])", "⌋"),
       (r"\\lceil(?![a-zA-Z])", "⌈"), (r"\\rceil(?![a-zA-Z])", "⌉"),
       (r"\\(,|;|:|!|quad|qquad| )", " "), (r"\\(left|right|displaystyle)(?![a-zA-Z])", ""),
       (r"\\%", "%"), (r"\\_", "_"), (r"\\\{", "{"), (r"\\\}", "}"), (r"~", " ")]


def tex(s):
    """Very small TeX → HTML prettifier, enough for typical constraints."""
    for pat, rep in TEX:
        s = re.sub(pat, rep, s)
    s = re.sub(r"\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}", r"(\1)/(\2)", s)
    s = re.sub(r"\\(?:text|textit|textbf|mathrm|mathit|mathbf|texttt|operatorname)\s*\{([^{}]*)\}", r"\1", s)
    s = re.sub(r"\^\s*\{([^{}]*)\}", r"<sup>\1</sup>", s)
    s = re.sub(r"\^\s*(\\?[A-Za-z0-9])", r"<sup>\1</sup>", s)
    s = re.sub(r"_\s*\{([^{}]*)\}", r"<sub>\1</sub>", s)
    s = re.sub(r"_\s*([A-Za-z0-9])", r"<sub>\1</sub>", s)
    s = re.sub(r"\\([A-Za-z]+)", r"\1", s)
    return "<i>" + s.strip() + "</i>"


def render_math(fragment):
    fragment = re.sub(r"\$\$\$(.+?)\$\$\$", lambda m: tex(m.group(1)), fragment, flags=re.S)
    fragment = re.sub(r"\\\((.+?)\\\)", lambda m: tex(m.group(1)), fragment, flags=re.S)
    fragment = re.sub(r"\\\[(.+?)\\\]", lambda m: "<p>" + tex(m.group(1)) + "</p>", fragment, flags=re.S)
    return fragment


def pair_tests(inputs, outputs):
    return [{"input": i, "expected": o} for i, o in zip(inputs, outputs)]


# ---- CSES -------------------------------------------------------------------
def parse_cses(page, task_id):
    title = None
    block = inner_of(page, r'<div[^>]*class="[^"]*title-block[^"]*"[^>]*>')
    m = re.search(r"<h1[^>]*>(.*?)</h1>", block or "", re.S)
    if m:
        title = html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()
    if not title:
        m = re.search(r"<title>(?:CSES\s*-\s*)?(.*?)</title>", page, re.S)
        title = html.unescape(m.group(1)).strip() if m else "CSES %s" % task_id
    body = inner_of(page, r'<div[^>]*class="[^"]*\bmd\b[^"]*"[^>]*>')
    if body is None:
        body = inner_of(page, r'<div[^>]*class="[^"]*\bcontent\b[^"]*"[^>]*>')
    if body is None:
        raise FetchError("看不懂 CSES 的頁面格式（可能需要登入或網站改版）")
    tl = re.search(r"Time limit:\s*</b>\s*([\d.]+)\s*s", page)
    ml = re.search(r"Memory limit:\s*</b>\s*(\d+)\s*MB", page)
    ins, outs = [], []
    for m in re.finditer(r"(Input|Output)\s*:?\s*(?:</[a-z0-9]+>\s*)*<pre[^>]*>(.*?)</pre>", body, re.S | re.I):
        (ins if m.group(1).lower() == "input" else outs).append(pre_text(m.group(2)))
    if not ins:
        pres = [pre_text(p) for p in re.findall(r"<pre[^>]*>(.*?)</pre>", body, re.S)]
        ins, outs = pres[0::2], pres[1::2]
    return {
        "id": "cses-%s" % task_id, "source": "cses", "title": title,
        "html": sanitize(render_math(body), "https://cses.fi"),
        "timeLimit": float(tl.group(1)) if tl else 1.0,
        "memoryLimit": int(ml.group(1)) if ml else None,
        "tests": pair_tests(ins, outs),
    }


def fetch_cses(task_id):
    return parse_cses(http_get("https://cses.fi/problemset/task/%s" % task_id), task_id)


# ---- Codeforces -------------------------------------------------------------
def parse_codeforces(page, contest, index):
    st = inner_of(page, r'<div[^>]*class="problem-statement"[^>]*>')
    if st is None:
        if "Just a moment" in page or "cf-challenge" in page or "Cloudflare" in page:
            raise FetchError("Codeforces 的防機器人驗證擋下了這次抓取，請改用手動貼測資")
        raise FetchError("看不懂 Codeforces 的頁面格式")
    m = re.search(r'<div class="title">(.*?)</div>', st, re.S)
    title = html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip() if m else "%s%s" % (contest, index)
    tl = re.search(r'class="time-limit">.*?</div>\s*([\d.]+)\s*second', st, re.S)
    ins = [pre_text(x) for x in re.findall(r'<div class="input">.*?<pre[^>]*>(.*?)</pre>', st, re.S)]
    outs = [pre_text(x) for x in re.findall(r'<div class="output">.*?<pre[^>]*>(.*?)</pre>', st, re.S)]
    body = st
    head = inner_of(st, r'<div class="header">')
    if head is not None:
        at = st.find(head)
        body = st[:st.find('<div class="header">')] + st[at + len(head) + len("</div>"):]
    body = re.sub(r'<div class="section-title">(.*?)</div>', r"<h3>\1</h3>", body, flags=re.S)
    cut = body.find('<div class="sample-tests">')
    note = body.find('<div class="note">')
    if cut >= 0:
        body = body[:cut] + (body[note:] if note > cut else "")
    return {
        "id": "cf-%s%s" % (contest, index), "source": "codeforces", "title": title,
        "html": sanitize(render_math(body), "https://codeforces.com"),
        "timeLimit": float(tl.group(1)) if tl else 2.0,
        "tests": pair_tests(ins, outs),
    }


def fetch_codeforces(kind, contest, index):
    if kind == "gym":
        url = "https://codeforces.com/gym/%s/problem/%s" % (contest, index)
    else:
        url = "https://codeforces.com/contest/%s/problem/%s" % (contest, index)
    try:
        page = http_get(url)
    except FetchError as e:
        raise FetchError("Codeforces 抓取失敗（%s）。它常擋自動抓取，請改用手動貼測資" % e)
    return parse_codeforces(page, contest, index)


# ---- LeetCode ---------------------------------------------------------------
LC_QUERY = ("query q($titleSlug: String!) { question(titleSlug: $titleSlug) { questionFrontendId "
            "title content exampleTestcases isPaidOnly codeSnippets { langSlug code } } }")


def parse_leetcode(payload, slug):
    q = ((payload or {}).get("data") or {}).get("question")
    if not q:
        raise FetchError("LeetCode 找不到這一題")
    if q.get("isPaidOnly") and not q.get("content"):
        raise FetchError("這是 LeetCode 付費題，無法抓取")
    snippets = {}
    for s in q.get("codeSnippets") or []:
        lang = {"cpp": "cpp", "c": "c", "python3": "py"}.get(s.get("langSlug"))
        if lang:
            snippets[lang] = s.get("code", "")
    return {
        "id": "lc-%s" % re.sub(r"[^A-Za-z0-9_-]", "-", slug)[:70], "source": "leetcode",
        "title": "%s. %s" % (q.get("questionFrontendId", ""), q.get("title", slug)),
        "html": sanitize(q.get("content") or "", "https://leetcode.com"),
        "timeLimit": 2.0,
        "tests": [],
        "starter": snippets,
        "note": "LeetCode 是函式題：這裡只抓題敘與起始程式碼，要在本機測試得自己寫 main 讀輸入。",
    }


def fetch_leetcode(slug):
    body = json.dumps({"query": LC_QUERY, "variables": {"titleSlug": slug}}).encode()
    try:
        raw = http_get("https://leetcode.com/graphql", data=body, headers={
            "Content-Type": "application/json", "Referer": "https://leetcode.com/problems/%s/" % slug,
            "Origin": "https://leetcode.com"})
        payload = json.loads(raw)
    except (FetchError, ValueError) as e:
        raise FetchError("LeetCode 抓取失敗（%s）" % e)
    return parse_leetcode(payload, slug)


# ---- dispatcher -------------------------------------------------------------
def fetch(url):
    url = (url or "").strip()
    if re.fullmatch(r"\d{3,5}", url):          # bare CSES task number
        url = "https://cses.fi/problemset/task/" + url
    if not re.match(r"^https?://", url):
        url = "https://" + url
    m = re.search(r"cses\.fi/(?:problemset|\d+)/task/(\d+)", url)
    if m:
        prob = fetch_cses(m.group(1))
    elif re.search(r"codeforces\.(com|ml|net)/", url):
        m = (re.search(r"/(contest|gym)/(\d+)/problem/([A-Za-z][0-9]?)", url)
             or re.search(r"/(problemset)/problem/(\d+)/([A-Za-z][0-9]?)", url))
        if not m:
            raise FetchError("看不懂這個 Codeforces 網址")
        prob = fetch_codeforces(m.group(1), m.group(2), m.group(3).upper())
    elif "leetcode." in url:
        m = re.search(r"/problems/([a-z0-9-]+)", url)
        if not m:
            raise FetchError("看不懂這個 LeetCode 網址")
        prob = fetch_leetcode(m.group(1))
    else:
        raise FetchError("目前支援 CSES、Codeforces、LeetCode 的題目網址")
    prob["url"] = url
    return prob
