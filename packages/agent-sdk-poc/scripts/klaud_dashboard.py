#!/usr/bin/env python3
"""
klaud_dashboard.py — Klaud 크롤 파이프라인 운영 콘솔 (백엔드 + 웹 UI).

기능:
  - 3 소스(Confluence / p4 GDD / p4 DataSheet) 저장소 vs 로컬 인덱싱 현황 요약
  - 좌(저장소) / 우(로컬) 동기화 브라우징 (같은 path 로 양쪽 정렬 비교)
  - 리소스 세부(content.md/요약/테이블) 미리보기
  - 최근 다운로드/변환/sync 로그 tail
  - 화이트리스트 klaud-crawl 명령 웹 실행 + 결과 (백그라운드)

보안: 명령 실행은 고정 allowlist(klaud-crawl 하위명령) + 검증된 인자만. shell 미사용.
바인드: 0.0.0.0 (단, 박스가 사설 IP 라 SSH 통해서만 도달).

실행: PROJK_CRAWL_PYTHON scripts/klaud_dashboard.py [PORT]
"""
from __future__ import annotations
import os, sys, json, re, time, uuid, sqlite3, subprocess, threading, html
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                       # packages/agent-sdk-poc
REPO = ROOT.parent.parent                # repo root
sys.path.insert(0, str(ROOT / "src"))
import klaud_crawl_state as state        # noqa


def _load_env(p):
    p = Path(p)
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())


_load_env(HERE / "crawl.env")
_load_env(REPO / "scripts" / ".env")
_load_env(REPO / "packages" / "confluence-downloader" / ".env")

WEB_ROOT = Path(os.environ.get("PROJK_WEB_ROOT", "/home/jacob/proj-k-data/web"))
DATA = ROOT / "data"
CONF_OUT = REPO / "packages" / "confluence-downloader" / "output"
XLSX_OUT = Path(os.environ.get("PROJK_GDD_OUTPUT", str(REPO / "packages" / "xlsx-extractor" / "output")))
SUMM = ROOT / "index" / "summaries"
P4SYNC = Path("/home/jacob/p4sync")
GAMEDB = Path.home() / ".qna-poc-gamedata" / "game_data.db"
LOGDIR = Path("/home/jacob/proj-k-data/_logs")
VENVPY = os.environ.get("PROJK_CRAWL_PYTHON", sys.executable)
GDD_DEPOT = "//main/ProjectK/Design"
DS_DEPOT = "//main/ProjectK/Resource/design"
CONF_TREE_CACHE = DATA / "confluence_tree.json"

RUNS: dict = {}     # id -> {proc, log, cmd, started, label}
_TREE_LOCK = threading.Lock()


# ── p4 helpers ──
def _p4(args, timeout=60):
    try:
        r = subprocess.run(["p4", *args], capture_output=True, text=True, timeout=timeout)
        return r.stdout.splitlines() if r.returncode == 0 else []
    except Exception:
        return []


def _p4_login():
    pw = os.environ.get("P4PASSWD")
    if pw:
        try:
            subprocess.run(["p4", "login"], input=pw + "\n", capture_output=True, text=True, timeout=15)
        except Exception:
            pass


# ── summary ──
def _report(src):
    f = DATA / f"report_{src}_latest.json"
    if f.exists():
        try:
            return json.loads(f.read_text())
        except Exception:
            return None
    return None


def api_summary():
    st = state.stats()
    out = []
    # Confluence
    r = _report("confluence-projk")
    nloc = sum(1 for _ in CONF_OUT.rglob("content.md")) if CONF_OUT.exists() else 0
    nsum = sum(1 for _ in (SUMM / "confluence").rglob("*.md")) if (SUMM / "confluence").exists() else 0
    out.append({
        "id": "confluence", "label": "Confluence (기획 wiki)",
        "upstream": r["upstream_count"] if r else None,
        "local": st["per_source"].get("confluence-projk", 0),
        "files": nloc, "indexed": nsum,
        "new": len(r["to_fetch_new"]) if r else 0,
        "stale": st.get("stale", 0),
        "deleted": len(r["deleted"]) if r else 0,
        "report_at": r["generated_at"] if r else None,
        "note": "이미지 401 → text-only",
    })
    # GDD
    r = _report("p4-xlsx")
    gdd_files = 0
    for cat in ("7_System", "8_Contents"):
        d = XLSX_OUT / cat
        if d.exists():
            gdd_files += sum(1 for _ in d.rglob("content.md"))
    gdd_sum = 0
    for cat in ("7_System", "8_Contents"):
        d = SUMM / "xlsx" / cat
        if d.exists():
            gdd_sum += sum(1 for _ in d.rglob("*.md"))
    out.append({
        "id": "gdd", "label": "p4 GDD 기획서 (7·8)",
        "upstream": r["upstream_count"] if r else None,
        "local": st["per_source"].get("p4-xlsx", 0),
        "files": gdd_files, "indexed": gdd_sum,
        "new": len(r["to_fetch_new"]) if r else 0, "stale": 0,
        "deleted": len(r["deleted"]) if r else 0,
        "report_at": r["generated_at"] if r else None,
        "note": "OnlyOffice 변환",
    })
    # DataSheet
    tables = rows = 0
    if GAMEDB.exists():
        try:
            c = sqlite3.connect(str(GAMEDB))
            ts = [x[0] for x in c.execute("select name from sqlite_master where type='table'")]
            tables = len([t for t in ts if not t.startswith("_")])
            for t in ts:
                if not t.startswith("_"):
                    try:
                        rows += c.execute(f'select count(*) from "{t}"').fetchone()[0]
                    except Exception:
                        pass
            c.close()
        except Exception:
            pass
    synced = sum(1 for _ in (P4SYNC / "Resource" / "design").glob("*.xlsx")) if (P4SYNC / "Resource" / "design").exists() else 0
    out.append({
        "id": "datasheet", "label": "p4 DataSheet (수치 테이블)",
        "upstream": synced, "local": tables, "files": synced, "indexed": tables,
        "new": 0, "stale": 0, "deleted": 0,
        "report_at": None, "note": f"{rows:,} 행 · game_data.db",
        "baseline": state.get_kv("p4_datasheet_cl"),
    })
    return {"sources": out, "ts": _now()}


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


# ── browse (merged 좌우 동기화) ──
def _local_conf_entries(rel):
    base = CONF_OUT / rel if rel else CONF_OUT
    res = {}
    if base.is_dir():
        for ch in sorted(base.iterdir()):
            if ch.name.startswith("_") or ch.name == "images":
                continue
            if ch.is_dir():
                has_md = (ch / "content.md").exists()
                relpath = (Path(rel) / ch.name) if rel else Path(ch.name)
                summ = (SUMM / "confluence" / relpath).with_suffix(".md").exists()
                res[ch.name] = {"type": "dir", "content": has_md, "indexed": summ}
    return res


def _tree_node_at(tree, segs):
    node = tree
    for s in segs:
        kids = node.get("children", []) if node else []
        nxt = next((k for k in kids if k.get("title") == s), None)
        if nxt is None:
            return None
        node = nxt
    return node


def api_browse(source, path):
    rel = path.strip("/")
    segs = [s for s in rel.split("/") if s]
    breadcrumb = [{"name": "(root)", "path": ""}]
    acc = []
    for s in segs:
        acc.append(s)
        breadcrumb.append({"name": s, "path": "/".join(acc)})
    entries = {}

    if source == "confluence":
        # left: cached tree, right: local FS
        loc = _local_conf_entries(rel)
        up = {}
        tree_ok = CONF_TREE_CACHE.exists()
        if tree_ok:
            try:
                tree = json.loads(CONF_TREE_CACHE.read_text())
                node = _tree_node_at(tree, segs) if segs else tree
                for k in (node.get("children", []) if node else []):
                    up[k["title"]] = {"type": "page", "id": k.get("id"),
                                      "haschild": bool(k.get("children"))}
            except Exception:
                tree_ok = False
        names = sorted(set(up) | set(loc))
        for n in names:
            entries[n] = {
                "name": n,
                "up": up.get(n),
                "loc": loc.get(n),
                "dir": True,  # confluence nodes are navigable (pages can have children + folder)
            }
        return {"breadcrumb": breadcrumb, "entries": list(entries.values()),
                "tree_ready": tree_ok, "leaf_kind": "confluence"}

    if source == "gdd":
        # GDD 파이프라인 범위 = Design/7_System + Design/8_Contents 만 (★ 7·8 외 제외)
        if not rel:
            up = {"7_System": {"type": "dir"}, "8_Contents": {"type": "dir"}}
            loc = {}
            for cat in ("7_System", "8_Contents"):
                if (P4SYNC / "Design" / cat).is_dir() or (XLSX_OUT / cat).is_dir():
                    loc[cat] = {"type": "dir"}
            for n in ("7_System", "8_Contents"):
                entries[n] = {"name": n, "up": up.get(n), "loc": loc.get(n), "dir": True}
            return {"breadcrumb": breadcrumb, "entries": list(entries.values()),
                    "tree_ready": True, "leaf_kind": "gdd"}
        depot = f"{GDD_DEPOT}/{rel}".rstrip("/")
        cat = rel.split("/")[0]
        up = {}
        for d in _p4(["dirs", f"{depot}/*"]):
            up[d.rsplit("/", 1)[-1]] = {"type": "dir"}
        for fl in _p4(["files", f"{depot}/*"]):
            if "#" not in fl or " - delete" in fl or " - move/delete" in fl:
                continue
            nm = fl.split("#")[0].rsplit("/", 1)[-1]
            up[nm] = {"type": "file"}
        lbase = P4SYNC / "Design" / rel
        loc = {}
        if lbase.is_dir():
            for ch in sorted(lbase.iterdir()):
                if ch.is_dir():
                    loc[ch.name] = {"type": "dir"}
                elif ch.suffix == ".xlsx":
                    wb = ch.stem
                    converted = (XLSX_OUT / cat / wb).exists()
                    indexed = (SUMM / "xlsx" / cat / wb).exists()
                    loc[ch.name] = {"type": "file", "converted": converted, "indexed": indexed}
        # 요약만 있고 로컬 xlsx 미동기인 워크북도 '인덱싱'으로 표기(커밋 요약 반영)
        sdir = SUMM / "xlsx" / cat
        if sdir.is_dir() and rel == cat:
            for wbdir in sdir.iterdir():
                key = wbdir.name + ".xlsx"
                if wbdir.is_dir() and key not in loc:
                    loc[key] = {"type": "file", "converted": (XLSX_OUT / cat / wbdir.name).exists(), "indexed": True}
        names = sorted(set(up) | set(loc))
        for n in names:
            is_dir = (up.get(n, {}).get("type") == "dir") or (loc.get(n, {}).get("type") == "dir")
            entries[n] = {"name": n, "up": up.get(n), "loc": loc.get(n), "dir": is_dir}
        return {"breadcrumb": breadcrumb, "entries": list(entries.values()),
                "tree_ready": True, "leaf_kind": "gdd"}

    if source == "datasheet":
        # flat: stem 으로 정렬 (xlsx 파일 ↔ 1+ 테이블). 한 파일이 여러 테이블을 가질 수 있음.
        up, loc = {}, {}
        for fl in _p4(["files", f"{DS_DEPOT}/*.xlsx"]):
            if "#" not in fl or " - delete" in fl:
                continue
            stem = fl.split("#")[0].rsplit("/", 1)[-1].rsplit(".xlsx", 1)[0]
            up[stem] = {"type": "file"}
        if GAMEDB.exists():
            try:
                c = sqlite3.connect(str(GAMEDB))
                for (t,) in c.execute("select name from sqlite_master where type='table'"):
                    if t.startswith("_"):
                        continue
                    try:
                        n = c.execute(f'select count(*) from "{t}"').fetchone()[0]
                    except Exception:
                        n = 0
                    loc[t] = {"type": "table", "rows": n}
                c.close()
            except Exception:
                pass
        # 테이블명이 xlsx stem 과 정확히 일치하면 같은 행, 아니면 별 행(테이블은 detail 가능)
        names = sorted(set(up) | set(loc))
        for n in names:
            entries[n] = {"name": n, "up": up.get(n), "loc": loc.get(n), "dir": False,
                          "table": n in loc}
        return {"breadcrumb": [{"name": "(root)", "path": ""}],
                "entries": list(entries.values()), "tree_ready": GAMEDB.exists(),
                "leaf_kind": "datasheet"}

    return {"error": "unknown source"}


# ── detail ──
def _preview(p, limit=6000):
    try:
        t = Path(p).read_text(encoding="utf-8", errors="ignore")
        return t[:limit] + ("\n…(이하 생략)" if len(t) > limit else "")
    except Exception as e:
        return f"(읽기 실패: {e})"


def api_detail(source, path):
    rel = path.strip("/")
    if source == "confluence":
        cm = CONF_OUT / rel / "content.md"
        sm = (SUMM / "confluence" / rel).with_suffix(".md")
        return {"title": rel.split("/")[-1],
                "content": _preview(cm) if cm.exists() else "(content.md 없음 — 폴더이거나 미다운로드)",
                "summary": _preview(sm, 2500) if sm.exists() else "(요약 없음)"}
    if source == "gdd":
        cat = rel.split("/")[0]
        wb = Path(rel).stem
        wbdir = XLSX_OUT / cat / wb
        sheets = []
        first = ""
        if wbdir.exists():
            for cm in sorted(wbdir.rglob("content.md")):
                sheets.append(cm.parent.parent.name)
                if not first:
                    first = _preview(cm, 4000)
        sdir = SUMM / "xlsx" / cat / wb
        summ = ""
        if sdir.exists():
            for m in sorted(sdir.glob("*.md")):
                summ += f"### {m.stem}\n" + _preview(m, 1200) + "\n\n"
        return {"title": wb, "sheets": sheets,
                "content": first or "(변환된 content.md 없음 — 미변환)",
                "summary": summ or "(요약 없음)"}
    if source == "datasheet":
        tbl = rel
        if not GAMEDB.exists():
            return {"title": tbl, "content": "(game_data.db 없음)", "summary": ""}
        try:
            c = sqlite3.connect(str(GAMEDB))
            cols = [r[1] for r in c.execute(f'PRAGMA table_info("{tbl}")')]
            sample = c.execute(f'select * from "{tbl}" limit 12').fetchall()
            c.close()
            lines = ["| " + " | ".join(cols[:8]) + " |",
                     "|" + "|".join(["---"] * min(len(cols), 8)) + "|"]
            for row in sample:
                lines.append("| " + " | ".join(str(x)[:24] for x in row[:8]) + " |")
            return {"title": tbl, "content": "\n".join(lines),
                    "summary": f"{len(cols)} 컬럼: {', '.join(cols)}"}
        except Exception as e:
            return {"title": tbl, "content": f"(조회 실패: {e})", "summary": ""}
    return {"error": "unknown"}


# ── logs ──
LOG_FILES = {
    "8_Contents Vision(진행)": LOGDIR / "8c_full_vision.log",
    "8_Contents 캡처": LOGDIR / "8c_capture.log",
    "8_Contents 요약/등록": LOGDIR / "8c_chain.out",
    "다운로드(Confluence 전체)": LOGDIR / "full_download.log",
    "GDD 변환": LOGDIR / "gdd_delta_convert.log",
    "요약 빌드": LOGDIR / "summaries.log",
    "인덱스 재빌드": LOGDIR / "index_rebuild.log",
}


def api_logs(name):
    if name == "sync (systemd journal)":
        try:
            r = subprocess.run(["journalctl", "-u", "klaud-crawl-sync.service", "--no-pager",
                                "-o", "short-iso", "-n", "150"],
                               capture_output=True, text=True, timeout=20)
            txt = "\n".join(l for l in r.stdout.splitlines() if "이미지 다운로드 실패" not in l)
            return {"text": txt[-12000:]}
        except Exception as e:
            return {"text": f"(journal 실패: {e})"}
    p = LOG_FILES.get(name)
    if p and Path(p).exists():
        t = Path(p).read_text(encoding="utf-8", errors="ignore")
        t = "\n".join(l for l in t.splitlines() if "이미지 다운로드 실패" not in l)
        return {"text": t[-12000:]}
    return {"text": "(로그 없음)"}


def api_capture_failures():
    f = DATA / "capture_failures.json"
    if not f.exists():
        return {"failures": [], "captured_ok": None, "failed": 0}
    try:
        return json.loads(f.read_text())
    except Exception:
        return {"failures": [], "failed": 0}


def api_fail_text(stem):
    """캡처 실패 파일의 openpyxl 추출 텍스트(렌더 없이 내용 조회)."""
    safe = re.sub(r'[/\\:*?"<>|]', "_", stem)
    p = DATA / "capture_fail_text" / f"{safe}.md"
    if p.exists():
        t = p.read_text(encoding="utf-8", errors="ignore")
        return {"stem": stem, "text": t[:60000]}
    return {"stem": stem, "text": "(추출 텍스트 없음 — capture_failure_report 미실행)"}


def api_log_list():
    # sync 저널(연월일 타임스탬프, 라이브 운영 로그)을 첫 탭으로
    items = [{"name": "sync (systemd journal)", "size": 0, "mtime": "live ⏱"}]
    for nm, p in LOG_FILES.items():
        if Path(p).exists():
            items.append({"name": nm, "size": Path(p).stat().st_size,
                          "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(Path(p).stat().st_mtime))})
    return {"logs": items}


# ── exec (allowlist) ──
ALLOWED_CMDS = {"status", "report", "diff", "reindex-run", "sync", "cron-tick"}
SRC_MAP = {"confluence": "confluence-projk", "gdd": "p4-xlsx", "datasheet": None}


def build_argv(p):
    cmd = p.get("cmd")
    if cmd not in ALLOWED_CMDS:
        raise ValueError("허용되지 않은 명령")
    argv = [VENVPY, "scripts/klaud-crawl.py", cmd]
    src = p.get("source")
    cs = SRC_MAP.get(src, src)
    if cs in state.VALID_SOURCES:
        argv += ["--source", cs]
    if p.get("dry_run"):
        argv.append("--dry-run")
    if p.get("no_index"):
        argv.append("--no-index")
    lim = str(p.get("limit", "")).strip()
    if lim.isdigit():
        argv += ["--limit", str(int(lim))]
    if cmd == "report" and p.get("purge_missing"):
        argv.append("--purge-missing")
    if cmd == "diff":
        since = str(p.get("since", "1d"))
        argv += ["--since", since if re.match(r"^\d+[smhd]$", since) else "1d"]
    return argv


# 영속화: 실행 메타는 _web_runs/index.json, 출력은 <id>.log (재시작/재접속에도 복원)
RUNS_INDEX = DATA / "_web_runs" / "index.json"
PROCS: dict = {}   # id -> Popen (in-memory only)
_RUNS_LOCK = threading.Lock()


def _save_runs():
    with _RUNS_LOCK:
        try:
            RUNS_INDEX.parent.mkdir(parents=True, exist_ok=True)
            RUNS_INDEX.write_text(json.dumps(RUNS, ensure_ascii=False))
        except Exception:
            pass


def _load_runs():
    global RUNS
    try:
        if RUNS_INDEX.exists():
            RUNS = json.loads(RUNS_INDEX.read_text())
            for r in RUNS.values():
                if r.get("status") == "running":
                    r["status"] = "interrupted"   # 서버 재시작으로 끊김
    except Exception:
        RUNS = {}


def _ts():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _pump(proc, logpath, rid):
    """proc 출력을 라인마다 [연월일시간분초] 프리픽스로 로그에 기록."""
    try:
        with open(logpath, "w", encoding="utf-8") as f:
            f.write(f"[{_ts()}] $ {RUNS[rid]['cmd']}\n")
            f.flush()
            for line in proc.stdout:
                f.write(f"[{_ts()}] {line}")
                f.flush()
    except Exception:
        pass
    proc.wait()
    RUNS[rid]["ended"] = time.time()
    RUNS[rid]["returncode"] = proc.returncode
    RUNS[rid]["status"] = "done"
    _save_runs()


def start_run(argv, label):
    rid = uuid.uuid4().hex[:8]
    LOGDIR.mkdir(parents=True, exist_ok=True)
    logf = DATA / "_web_runs" / f"{rid}.log"
    logf.parent.mkdir(parents=True, exist_ok=True)
    if any("p4" in a for a in argv) or "sync" in label or "reindex" in label or "report" in label:
        _p4_login()
    env = os.environ.copy()
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            cwd=str(ROOT), env=env, text=True, bufsize=1)
    RUNS[rid] = {"log": str(logf), "cmd": " ".join(argv[2:]) if len(argv) > 2 else " ".join(argv),
                 "label": label, "started": time.time(), "started_ts": _ts(),
                 "status": "running", "returncode": None, "ended": None}
    PROCS[rid] = proc
    _save_runs()
    threading.Thread(target=_pump, args=(proc, str(logf), rid), daemon=True).start()
    return rid


def run_output(rid):
    r = RUNS.get(rid)
    if not r:
        return {"error": "no such run"}
    txt = ""
    try:
        txt = Path(r["log"]).read_text(encoding="utf-8", errors="ignore")
    except Exception:
        pass
    txt = "\n".join(l for l in txt.splitlines() if "이미지 다운로드 실패" not in l)
    proc = PROCS.get(rid)
    running = proc is not None and proc.poll() is None
    return {"cmd": r["cmd"], "label": r["label"], "running": running,
            "returncode": r.get("returncode"), "output": txt[-18000:],
            "started_ts": r.get("started_ts"), "status": r.get("status"),
            "elapsed": round((r.get("ended") or time.time()) - r["started"], 1)}


def api_runs():
    items = sorted(RUNS.items(), key=lambda kv: kv[1].get("started", 0), reverse=True)[:20]
    return {"runs": [{"id": k, "cmd": v["cmd"], "label": v["label"],
                      "started_ts": v.get("started_ts"), "status": v.get("status"),
                      "returncode": v.get("returncode")} for k, v in items]}


# build confluence tree (background)
def build_conf_tree():
    with _TREE_LOCK:
        try:
            cd = REPO / "packages" / "confluence-downloader"
            if str(cd) not in sys.path:
                sys.path.insert(0, str(cd))
            from src.client import ConfluenceClient
            url = os.environ.get("CONFLUENCE_URL"); usr = os.environ.get("CONFLUENCE_USERNAME")
            tok = os.environ.get("CONFLUENCE_API_TOKEN"); root = os.environ.get("CONFLUENCE_ROOT_PAGE_ID")
            cl = ConfluenceClient(url, usr, tok, request_delay=0.15)

            def walk(pid, title, depth=0):
                node = {"id": pid, "title": title, "children": []}
                if depth > 9:
                    return node
                for c in cl.get_children(pid):
                    # page + folder 모두 포함·재귀 (native build_page_tree 와 동일 — 완전한 비교용)
                    if c.get("type") in ("page", "folder"):
                        node["children"].append(walk(c["id"], c.get("title", ""), depth + 1))
                return node

            # 로컬 출력 규약(Design/ 최상위)과 정렬되도록 "Design" 노드로 래핑
            design = walk(root, "Design")
            tree = {"id": "_root", "title": "(root)", "children": [design]}
            CONF_TREE_CACHE.write_text(json.dumps(tree, ensure_ascii=False))
        except Exception as e:
            CONF_TREE_CACHE.with_suffix(".err").write_text(str(e))


# ── HTTP ──
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        b = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if "json" in ctype or "html" in ctype else ""))
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path
        if p in ("/", "/dashboard"):
            return self._send(200, DASH_HTML, "text/html")
        if p == "/api/summary":
            return self._send(200, api_summary())
        if p == "/api/browse":
            return self._send(200, api_browse(q.get("source", "confluence"), q.get("path", "")))
        if p == "/api/detail":
            return self._send(200, api_detail(q.get("source", "confluence"), q.get("path", "")))
        if p == "/api/logs":
            return self._send(200, api_logs(q.get("name", "")))
        if p == "/api/loglist":
            return self._send(200, api_log_list())
        if p == "/api/runs":
            return self._send(200, api_runs())
        if p == "/api/capture-failures":
            return self._send(200, api_capture_failures())
        if p == "/api/fail-text":
            return self._send(200, api_fail_text(q.get("stem", "")))
        if p.startswith("/api/exec/"):
            return self._send(200, run_output(p.rsplit("/", 1)[-1]))
        # static from WEB_ROOT
        rel = p.lstrip("/")
        fp = (WEB_ROOT / rel).resolve()
        if str(fp).startswith(str(WEB_ROOT.resolve())) and fp.is_file():
            ext = fp.suffix.lower()
            ctype = {".html": "text/html", ".png": "image/png", ".pdf": "application/pdf",
                     ".css": "text/css", ".js": "application/javascript",
                     ".json": "application/json", ".jpg": "image/jpeg"}.get(ext, "application/octet-stream")
            return self._send(200, fp.read_bytes(), ctype)
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        ln = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(ln) or "{}") if ln else {}
        if u.path == "/api/exec":
            try:
                argv = build_argv(body)
            except Exception as e:
                return self._send(400, {"error": str(e)})
            rid = start_run(argv, body.get("cmd", "run"))
            return self._send(200, {"id": rid})
        if u.path == "/api/build-tree":
            threading.Thread(target=build_conf_tree, daemon=True).start()
            return self._send(200, {"started": True})
        return self._send(404, {"error": "not found"})


DASH_HTML = r"""<!DOCTYPE html><html lang=ko><head><meta charset=UTF-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Klaud 크롤 운영 콘솔</title>
<style>
:root{--bg:#0f1115;--pan:#181b22;--pan2:#1e222b;--bd:#2a2f3a;--tx:#e6e8ec;--mu:#9aa3b2;--ac:#5b9cff;--ok:#3fb950;--wa:#d29922;--ba:#f85149;--cd:#0a0c10;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font-family:Pretendard,"Malgun Gothic",system-ui,sans-serif;font-size:14px;line-height:1.5}
header{padding:14px 20px;border-bottom:1px solid var(--bd);background:linear-gradient(180deg,#1a1f2b,#0f1115);display:flex;align-items:center;gap:16px;flex-wrap:wrap}
h1{font-size:18px;margin:0}.tabs{display:flex;gap:6px;margin-left:auto}
.tab{padding:7px 14px;border:1px solid var(--bd);border-radius:8px;cursor:pointer;background:var(--pan);font-size:13px}
.tab.on{background:var(--ac);color:#fff;border-color:var(--ac)}
.wrap{padding:16px 20px;max-width:1500px;margin:0 auto}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:8px}
.card{background:var(--pan);border:1px solid var(--bd);border-radius:9px;padding:11px 13px}
.card .n{font-size:22px;font-weight:700;color:#fff}.card .l{font-size:11.5px;color:var(--mu)}
.bar{display:flex;gap:8px;align-items:center;margin:10px 0;flex-wrap:wrap}
button{background:var(--pan2);color:var(--tx);border:1px solid var(--bd);border-radius:7px;padding:7px 13px;cursor:pointer;font-size:13px}
button:hover{border-color:var(--ac)}button.pri{background:var(--ac);color:#fff;border-color:var(--ac)}
button.warn{border-color:rgba(210,153,34,.5);color:var(--wa)}
.split{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.pane{background:var(--pan);border:1px solid var(--bd);border-radius:9px;overflow:hidden;min-height:240px}
.pane h3{margin:0;padding:9px 13px;font-size:13px;background:#20242e;color:var(--mu);border-bottom:1px solid var(--bd)}
.crumb{padding:7px 13px;font-size:12.5px;color:var(--mu);border-bottom:1px solid var(--bd);background:var(--cd)}
.crumb a{color:var(--ac);cursor:pointer;text-decoration:none}.crumb a:hover{text-decoration:underline}
.rows{max-height:420px;overflow:auto}
.row{display:flex;align-items:center;gap:8px;padding:6px 13px;border-bottom:1px solid #20242e;cursor:pointer;font-size:13px}
.row:hover{background:var(--pan2)}.row .ic{width:16px;text-align:center}
.row .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{font-size:10.5px;padding:1px 7px;border-radius:9px;border:1px solid}
.t-ok{color:var(--ok);border-color:rgba(63,185,80,.4);background:rgba(63,185,80,.1)}
.t-dl{color:var(--ac);border-color:rgba(91,156,255,.4);background:rgba(91,156,255,.1)}
.t-miss{color:var(--mu);border-color:var(--bd)}
.t-up{color:var(--wa);border-color:rgba(210,153,34,.4);background:rgba(210,153,34,.1)}
.empty{color:var(--mu);font-size:12px;padding:8px 13px}
.det{background:var(--pan);border:1px solid var(--bd);border-radius:9px;margin-top:10px;padding:0}
.det h3{margin:0;padding:9px 13px;font-size:13px;background:#20242e;border-bottom:1px solid var(--bd)}
.det .body{display:grid;grid-template-columns:1fr 1fr;gap:0}
.det pre{margin:0;padding:12px 14px;font-size:12px;line-height:1.5;color:#c9d1d9;white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;font-family:ui-monospace,monospace}
.det .l{border-right:1px solid var(--bd)}
.sec{margin-top:18px}.sec h2{font-size:15px;border-left:3px solid var(--ac);padding-left:9px;margin:0 0 10px}
select,input{background:var(--pan2);color:var(--tx);border:1px solid var(--bd);border-radius:6px;padding:6px 9px;font-size:13px}
pre.out{background:var(--cd);border:1px solid var(--bd);border-radius:8px;padding:12px;font-size:12px;max-height:360px;overflow:auto;white-space:pre-wrap;color:#c9d1d9;font-family:ui-monospace,monospace}
.mu{color:var(--mu);font-size:12px}.run{color:var(--wa)}.done{color:var(--ok)}
a.link{color:var(--ac)}
</style></head><body>
<header>
  <h1>🛰️ Klaud 크롤 운영 콘솔</h1>
  <span class=mu id=ts></span>
  <div class=tabs id=tabs></div>
  <a class=link href="klaud-crawl.html" style="font-size:13px">↗ 레퍼런스</a>
</header>
<div class=wrap>
  <div class=cards id=cards></div>
  <div class=bar>
    <button class=pri onclick="act('report')">🔄 현황 새로고침 (report)</button>
    <button class=warn onclick="act('sync')">⬇ 증분 동기화 (sync)</button>
    <button onclick="act('reindex-run',{dry_run:true})">미리보기 (reindex --dry-run)</button>
    <button class=warn onclick="if(confirm('저장소에 없고 로컬에만 있는 리소스를 검증 후 삭제합니다. 진행?'))act('report',{purge_missing:true})">🗑 삭제 정리 (purge-missing)</button>
    <span class=mu id=actmsg></span>
  </div>
  <pre class=out id=actout style="display:none;max-height:240px"></pre>

  <div class=split>
    <div class=pane>
      <h3>📦 저장소 (upstream)</h3>
      <div class=crumb id=crumbL></div>
      <div class=rows id=rowsL></div>
    </div>
    <div class=pane>
      <h3>💾 로컬 (다운로드 + 인덱싱)</h3>
      <div class=crumb id=crumbR></div>
      <div class=rows id=rowsR></div>
    </div>
  </div>

  <div class=det id=det style=display:none>
    <h3 id=detTitle></h3>
    <div class=body><pre class=l id=detContent></pre><pre id=detSummary></pre></div>
  </div>

  <div class=sec id=failsec style=display:none>
    <h2>⛔ 변환 실패 파일 <span class=mu id=failcount></span> <span class=mu>(렌더 실패 — openpyxl 텍스트로 내용 조회)</span></h2>
    <div style="display:grid;grid-template-columns:340px 1fr;gap:10px">
      <div class=pane style=min-height:0>
        <h3>실패 목록 (크기순)</h3>
        <div class=rows id=faillist style=max-height:420px></div>
      </div>
      <div class=pane style=min-height:0>
        <h3 id=failtitle>파일 선택 → 텍스트 내용</h3>
        <pre id=failtext style="margin:0;padding:12px;font-size:12px;white-space:pre-wrap;max-height:420px;overflow:auto;color:#c9d1d9">(좌측에서 파일 클릭)</pre>
      </div>
    </div>
  </div>

  <div class=sec>
    <h2>📜 최근 로그 <span class=mu>(라인별 연월일시간분초)</span></h2>
    <div class=tabs id=logtabs style="margin-bottom:8px"></div>
    <div class=bar><button onclick=loadLog()>↻ 새로고침</button><label class=mu><input type=checkbox id=logauto> 자동(3s)</label><span class=mu id=logname></span></div>
    <pre class=out id=logout style=max-height:420px>(로그 탭 선택)</pre>
  </div>

  <div class=sec>
    <h2>⌨️ CLI 실행 <span class=mu>(허용된 명령만 · 실행 즉시 로그 스트리밍)</span></h2>
    <div class=mu style="margin-bottom:6px">사용법: 명령 선택 → (선택)소스/옵션 → ▶ 실행. 결과가 아래에 실시간 출력됩니다. 새로고침·재접속해도 최근 실행이 복원됩니다.</div>
    <div class=bar>
      <select id=cmd onchange=cmdHint()>
        <option value=status>status — 현황표</option>
        <option value=report>report — 저장소vs로컬 diff</option>
        <option value=diff>diff — 변경이벤트</option>
        <option value=reindex-run>reindex-run — fetch+변환+요약</option>
        <option value=sync>sync — 통합 원샷</option>
        <option value=cron-tick>cron-tick — 변경감지</option>
      </select>
      <select id=esrc><option value="">(전체)</option><option value=confluence>confluence</option><option value=gdd>gdd(p4)</option></select>
      <label class=mu><input type=checkbox id=edry> --dry-run</label>
      <label class=mu><input type=checkbox id=enoidx> --no-index</label>
      <input id=elim placeholder="--limit N" style=width:84px>
      <button class=pri onclick=execCmd()>▶ 실행</button>
      <span class=mu id=execmsg></span>
    </div>
    <div class=mu id=cmdhint style=margin-bottom:6px></div>
    <div style="display:grid;grid-template-columns:200px 1fr;gap:10px">
      <div class=pane style=min-height:0>
        <h3>최근 실행</h3>
        <div class=rows id=runlist style=max-height:340px></div>
      </div>
      <pre class=out id=execout style=max-height:360px>(명령 실행 결과 — ▶ 실행 또는 최근 실행 클릭)</pre>
    </div>
  </div>
</div>
<script>
let SRC='confluence', PATH='', POLL=null, CUR_EXEC=null, CUR_LOG=null, LOGTIMER=null;
const SRCS=[['confluence','Confluence'],['gdd','p4 GDD'],['datasheet','p4 DataSheet']];
function el(id){return document.getElementById(id)}
function tabsInit(){el('tabs').innerHTML=SRCS.map(s=>`<div class="tab ${s[0]==SRC?'on':''}" onclick="setSrc('${s[0]}')">${s[1]}</div>`).join('')}
function setSrc(s){SRC=s;PATH='';tabsInit();el('det').style.display='none';loadSummary();browse()}
async function loadSummary(){
  const d=await (await fetch('/api/summary')).json();el('ts').textContent='갱신 '+d.ts;
  const s=d.sources.find(x=>x.id==SRC)||{};
  const f=(v)=>v==null?'—':v.toLocaleString();
  el('cards').innerHTML=[
    ['저장소(upstream)',f(s.upstream)],['로컬 등록',f(s.local)],
    ['다운로드 파일',f(s.files)],['인덱싱(요약/테이블)',f(s.indexed)],
    ['받아야할것(신규)',f(s.new)],['삭제(추정)',f(s.deleted)]
  ].map(c=>`<div class=card><div class=n>${c[1]}</div><div class=l>${c[0]}</div></div>`).join('')
   +`<div class=card><div class=n style=font-size:13px>${s.report_at?s.report_at.slice(5,16).replace('T',' '):(s.note||'')}</div><div class=l>${s.report_at?'last report':'note'}</div></div>`;
}
function tagFor(e){
  let t=[];
  if(e.up&&!e.loc) t.push('<span class="tag t-up">저장소만</span>');
  else if(!e.up&&e.loc) t.push('<span class="tag t-miss">로컬만</span>');
  if(e.loc){
    if(e.loc.indexed) t.push('<span class="tag t-ok">인덱싱</span>');
    else if(e.loc.content||e.loc.type=='file'||e.loc.type=='table') t.push('<span class="tag t-dl">다운로드</span>');
    if(e.loc.rows!=null) t.push('<span class=mu>'+e.loc.rows.toLocaleString()+'행</span>');
  }
  return t.join(' ');
}
async function browse(){
  const d=await (await fetch(`/api/browse?source=${SRC}&path=${encodeURIComponent(PATH)}`)).json();
  // breadcrumb (shared)
  const cb=(d.breadcrumb||[]).map(b=>`<a onclick="go('${b.path.replace(/'/g,"")}')">${b.name||'(root)'}</a>`).join(' / ');
  el('crumbL').innerHTML=cb; el('crumbR').innerHTML=cb;
  if(SRC=='confluence'&&!d.tree_ready){
    el('rowsL').innerHTML='<div class=empty>저장소 트리 캐시 없음 — <a class=link onclick=buildTree()>저장소 트리 빌드</a> (≈3분, 백그라운드)</div>';
  }
  const L=[],R=[];
  (d.entries||[]).forEach(e=>{
    const ic=e.dir?'📁':(e.up&&e.up.type=='file'||e.loc&&e.loc.type=='file'?'📄':(e.loc&&e.loc.type=='table'?'🗃️':'📄'));
    const click=e.dir?`go('${(PATH?PATH+'/':'')+e.name.replace(/'/g,"")}')`:`detail('${(PATH?PATH+'/':'')+e.name.replace(/'/g,"")}')`;
    // left = upstream presence
    L.push(`<div class=row onclick="${click}"><span class=ic>${ic}</span><span class=nm>${e.up?e.name:'<span class=mu>—</span>'}</span></div>`);
    R.push(`<div class=row onclick="${click}"><span class=ic>${ic}</span><span class=nm>${e.loc?e.name:'<span class=mu>—</span>'}</span>${tagFor(e)}</div>`);
  });
  if(!(SRC=='confluence'&&!d.tree_ready)) el('rowsL').innerHTML=L.join('')||'<div class=empty>(비어있음)</div>';
  el('rowsR').innerHTML=R.join('')||'<div class=empty>(비어있음)</div>';
}
function go(p){PATH=p;el('det').style.display='none';browse()}
async function detail(p){
  const d=await (await fetch(`/api/detail?source=${SRC}&path=${encodeURIComponent(p)}`)).json();
  el('det').style.display='';el('detTitle').textContent=(d.title||p)+(d.sheets?` · ${d.sheets.length} 시트`:'');
  el('detContent').textContent=d.content||'';el('detSummary').textContent=d.summary||'';
}
async function buildTree(){await fetch('/api/build-tree',{method:'POST'});el('rowsL').innerHTML='<div class=empty>트리 빌드 중… 3분 후 새로고침</div>'}
// 상단 액션(report/sync/purge/reindex) — actout 패널에 즉시 스트리밍
async function act(cmd,extra){
  const b=Object.assign({cmd,source:SRC},extra||{});
  el('actmsg').textContent='시작…';el('actout').style.display='';el('actout').textContent='(시작 중…)';
  const r=await (await fetch('/api/exec',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})).json();
  if(r.error){el('actmsg').textContent='오류: '+r.error;return}
  loadRuns();
  const t=setInterval(async()=>{
    const o=await (await fetch('/api/exec/'+r.id)).json();
    el('actout').textContent=o.output||'(출력 대기)';el('actout').scrollTop=el('actout').scrollHeight;
    el('actmsg').innerHTML=o.running?`<span class=run>실행 중 ${o.elapsed}s…</span>`:`<span class=done>완료 (exit ${o.returncode}, ${o.elapsed}s)</span>`;
    if(!o.running){clearInterval(t);loadSummary();browse();loadRuns()}
  },1000);
}
// CLI 콘솔 실행 — 즉시 스트리밍
async function execCmd(){
  const b={cmd:el('cmd').value,source:el('esrc').value,dry_run:el('edry').checked,no_index:el('enoidx').checked,limit:el('elim').value};
  el('execmsg').textContent='시작…';el('execout').textContent='(시작 중…)';
  const r=await (await fetch('/api/exec',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})).json();
  if(r.error){el('execout').textContent='오류: '+r.error;return}
  CUR_EXEC=r.id;loadRuns();pollExec();
}
function pollExec(){
  clearInterval(POLL);if(!CUR_EXEC)return;
  POLL=setInterval(async()=>{
    const o=await (await fetch('/api/exec/'+CUR_EXEC)).json();
    if(o.error){clearInterval(POLL);return}
    el('execout').textContent=o.output||'(출력 대기)';el('execout').scrollTop=el('execout').scrollHeight;
    el('execmsg').innerHTML=o.running?`<span class=run>● 실행 중 ${o.elapsed}s</span>`:`<span class=done>✓ 완료 (exit ${o.returncode}, ${o.elapsed}s)</span>`;
    if(!o.running){clearInterval(POLL);loadSummary();loadRuns()}
  },900);
}
function viewRun(id){CUR_EXEC=id;el('execmsg').textContent='로딩…';pollExec()}
async function loadRuns(){
  const d=await (await fetch('/api/runs')).json();
  el('runlist').innerHTML=(d.runs||[]).map(r=>{
    const st=r.status=='running'?'<span class=run>●</span>':(r.returncode===0?'<span class=done>✓</span>':(r.status=='interrupted'?'<span class=mu>⊘</span>':'<span style=color:#f85149>✗</span>'));
    return `<div class=row onclick="viewRun('${r.id}')"><span class=ic>${st}</span><span class=nm title="${r.cmd}">${r.cmd}</span></div>`+
           `<div class=mu style=padding:0_13px_4px>${r.started_ts||''}</div>`;
  }).join('')||'<div class=empty>(실행 기록 없음)</div>';
}
function cmdHint(){
  const h={status:'리소스 현황표 (읽기전용)',report:'저장소 전수 vs 로컬 set-diff + report JSON 저장 (confluence 는 트리 열거 ~분)',
    diff:'최근 변경 이벤트 로그',
    'reindex-run':'stale 실 fetch+변환+요약 (⚠ Bedrock 비용 — --dry-run 권장 먼저)',
    sync:'cron-tick→reindex→DataSheet→report 통합 (systemd 타이머와 동일)',
    'cron-tick':'변경 감지만 (stale 표시, 읽기 위주)'};
  el('cmdhint').textContent='ℹ '+(h[el('cmd').value]||'');
}
// 로그 탭
async function loadLogTabs(){
  const d=await (await fetch('/api/loglist')).json();
  el('logtabs').innerHTML=d.logs.map(l=>`<div class="tab ${l.name==CUR_LOG?'on':''}" onclick="setLog('${l.name.replace(/'/g,"")}')">${l.name} <span class=mu>${l.mtime||''}</span></div>`).join('');
  if(!CUR_LOG&&d.logs.length){CUR_LOG=d.logs[0].name;setLog(CUR_LOG)}
}
function setLog(n){CUR_LOG=n;loadLogTabs();loadLog()}
async function loadLog(){
  if(!CUR_LOG)return;el('logname').textContent=CUR_LOG;
  const d=await (await fetch('/api/logs?name='+encodeURIComponent(CUR_LOG))).json();
  el('logout').textContent=d.text||'(없음)';el('logout').scrollTop=el('logout').scrollHeight;
}
setInterval(()=>{if(el('logauto')&&el('logauto').checked)loadLog()},3000);
// 변환 실패 조회
async function loadFailures(){
  const d=await (await fetch('/api/capture-failures')).json();
  if(!d.failures||!d.failures.length){el('failsec').style.display='none';return}
  el('failsec').style.display='';
  el('failcount').textContent=`${d.failed}개 실패 / ${d.captured_ok}개 성공`;
  el('faillist').innerHTML=d.failures.map(f=>
    `<div class=row onclick="failText('${f.stem.replace(/'/g,"")}','${(f.error||'').replace(/'/g,"")}')"><span class=ic>✗</span><span class=nm title="${f.error}">${f.stem}</span><span class=mu>${f.size_mb}MB·${f.sheet_count}시트</span></div>`).join('');
}
async function failText(stem,err){
  el('failtitle').textContent=stem+'  ('+err+')';
  el('failtext').textContent='로딩…';
  const d=await (await fetch('/api/fail-text?stem='+encodeURIComponent(stem))).json();
  el('failtext').textContent=d.text||'(없음)';el('failtext').scrollTop=0;
}
// 초기화 + 재접속 복원
tabsInit();loadSummary();browse();loadLogTabs();cmdHint();loadFailures();
loadRuns().then(async()=>{const d=await (await fetch('/api/runs')).json();if(d.runs&&d.runs.length){viewRun(d.runs[0].id)}});
setInterval(loadSummary,30000);
setInterval(loadRuns,5000);
</script></body></html>"""


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8092
    state.init()
    _load_runs()
    srv = ThreadingHTTPServer(("0.0.0.0", port), H)
    print(f"klaud-dashboard on http://0.0.0.0:{port}  (web_root={WEB_ROOT})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
