"""Project K (Klaud) desktop-app Python sidecar.

Phase 2.2 (current):
  - /health        — readiness probe used by the Electron main process
  - /search_docs   — search-first endpoint. If PROJK_RETRIEVER_URL is set,
                     proxies to qna-poc /search and aggregates chunks to
                     document level. Otherwise returns an empty list (graceful).
  - /ask_stream    — NDJSON SSE stream. If PROJK_AGENT_URL is set, forwards
                     line-by-line from upstream agent-sdk-poc. Otherwise echo stub.

The sidecar deliberately does NOT call Anthropic/Bedrock directly. All LLM
traffic goes through agent-sdk-poc (dev) or the internal proxy gateway (prod).
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

app = FastAPI(title="klaud-sidecar", version="0.3.0")

# Renderer 가 dev 모드 (electron-vite) 에선 http://localhost:5174 origin 으로 sidecar
# 호출. browser 는 localhost / 127.0.0.1 을 다른 origin 으로 보고 POST + JSON
# Content-Type 가 preflight 발동 → 차단. /health 는 GET 이라 안 막혔지만 /ask_stream
# /search_docs /review_stream /suggest_edits 모두 죽었다 (핸드오프의 "network error
# 채팅 회귀" 의 진짜 원인). production 은 file:// origin → 동일 이슈 가능.
# sidecar 는 항상 localhost 만 listen 하니 origin 제한은 무의미 — 모두 허용.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r".*",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- 공용: 데이터 경로 정규화 ----------

def _wsl_distro_candidates() -> list[str]:
    hint = os.environ.get("PROJK_WSL_DISTRO")
    if hint:
        return [hint]
    return ["Ubuntu-24.04", "Ubuntu", "Ubuntu-22.04", "Debian"]


def _is_windows() -> bool:
    return platform.system() == "Windows"


def _normalize_repo_root(p: str) -> str:
    """플랫폼별로 sidecar 가 native fs 로 접근할 수 있는 경로로 변환.

    Klaud main(Windows) 의 settings 에는 `\\\\wsl.localhost\\Ubuntu-24.04\\home\\jacob\\repos\\proj-k`
    같은 UNC 가 들어올 수도 있고, 사용자가 `/home/jacob/repos/proj-k` 같은 native Linux
    스타일을 입력할 수도 있다. sidecar 가 도는 OS 에 따라 둘 중 어느 형태가 fs 에서 통하는지
    달라지므로 분기한다:

      - **Windows sidecar (production)**: UNC 형식이 fs 접근에 필요. Linux-style absolute path
        를 받았으면 `\\\\wsl.localhost\\<distro>\\...` 로 prefix 를 복원한다. 후보 distro 를
        순회하며 실재하는 path 를 찾고, 없으면 첫 후보를 반환 (health 에서 _exists=false 로 노출).
      - **WSL Linux sidecar (dev)**: 기존 동작 — UNC prefix 를 떼어 `/home/...` native 로 변환.
    """
    if not p:
        return p

    if _is_windows():
        if p.startswith("\\\\"):
            return p  # already UNC
        is_linux_style = p.startswith("/") or (
            p.startswith("\\") and not p.startswith("\\\\")
        )
        if is_linux_style:
            tail = p.replace("/", "\\").lstrip("\\")
            for distro in _wsl_distro_candidates():
                cand = f"\\\\wsl.localhost\\{distro}\\{tail}"
                if Path(cand).is_dir():
                    return cand
            return f"\\\\wsl.localhost\\{_wsl_distro_candidates()[0]}\\{tail}"
        return p  # Windows local path (C:\..., D:\...) — 그대로

    # WSL Linux sidecar.
    s = p.replace("\\", "/")
    for prefix in ("//wsl.localhost/", "//wsl$/"):
        if s.startswith(prefix):
            rest = s[len(prefix):]
            parts = rest.split("/", 1)
            if len(parts) == 2:
                return "/" + parts[1]
            return "/"
    return s


def _repo_root() -> str:
    return _normalize_repo_root(os.environ.get("PROJK_REPO_ROOT") or "")


# ---------- /health ----------

# ---------- WSL fallback (Windows 측 9P symlink 우회) ----------
#
# 사용자 셋업: WSL 의 packages/xlsx-extractor/output 이 /mnt/e/proj-k-data/... 로 가는
# Linux symlink. Windows 가 \\wsl.localhost\Ubuntu-24.04\... 로 그 path 에 들어가면
# 9P 가 mount 매핑을 표현 못 해서 NotADirectoryError [WinError 267]. 부모 listing
# 에는 이름만 보이지만 들어가려는 순간 깨짐.
#
# 해결: Windows sidecar 가 그런 path 에서 막히면 wsl.exe 로 readlink 후
# /mnt/<drive>/... → <drive>:\... 로 변환해서 Windows fs 에 직접 access.

# 결과 캐시 — 한 번 resolve 한 path 는 재호출 안 함.
_resolved_cache: dict[str, str] = {}


def _wsl_unc_to_linux(p: str) -> tuple[str, str] | None:
    """\\\\wsl.localhost\\<distro>\\<rest> 또는 \\\\wsl$\\<distro>\\<rest> 를
    (distro, /<rest>) 로 분리. UNC 가 아니면 None.
    """
    s = p.replace("\\", "/")
    for prefix in ("//wsl.localhost/", "//wsl$/"):
        if s.startswith(prefix):
            rest = s[len(prefix):]
            parts = rest.split("/", 1)
            if len(parts) == 2:
                return parts[0], "/" + parts[1]
            return parts[0], "/"
    return None


def _wsl_readlink(distro: str, linux_path: str) -> str | None:
    """wsl.exe -d <distro> -e readlink -f <linux-path> 로 symlink resolve.
    실패 시 None.
    """
    try:
        proc = subprocess.run(
            ["wsl.exe", "-d", distro, "-e", "readlink", "-f", "--", linux_path],
            capture_output=True, text=True, timeout=8, encoding="utf-8",
        )
        if proc.returncode != 0:
            return None
        out = proc.stdout.strip()
        return out or None
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None


def _linux_mnt_to_windows(linux_path: str) -> str | None:
    """/mnt/<drive>/<rest> → <drive>:\\<rest>. 다른 형태면 None."""
    if not linux_path.startswith("/mnt/"):
        return None
    rest = linux_path[len("/mnt/"):]
    parts = rest.split("/", 1)
    if not parts or len(parts[0]) != 1:
        return None
    drive = parts[0].upper()
    tail = parts[1] if len(parts) == 2 else ""
    return f"{drive}:\\" + tail.replace("/", "\\")


def _resolve_wsl_path(unc_path: str) -> str | None:
    """Windows 사이드카가 \\\\wsl.localhost\\... UNC 에서 막힐 때 마지막 시도:
    wsl.exe 로 readlink → /mnt/<drive>/... 면 Windows drive path 로 변환.
    실패 시 None.
    """
    if unc_path in _resolved_cache:
        return _resolved_cache[unc_path]
    parsed = _wsl_unc_to_linux(unc_path)
    if not parsed:
        return None
    distro, linux_path = parsed
    target = _wsl_readlink(distro, linux_path)
    if not target:
        return None
    win = _linux_mnt_to_windows(target)
    if not win:
        # symlink 가 /mnt/... 가 아니라 다른 Linux path 면 우회 불가.
        return None
    _resolved_cache[unc_path] = win
    print(f"[wsl-fallback] {unc_path} → {win}", flush=True)
    return win


def _safe_list_dir(p: Path) -> tuple[list[str] | None, str | None]:
    """`Path(p).iterdir()` 가 실패할 수 있는 환경 (Windows + WSL UNC + 9P + symlink)
    에서 리스트가 가능한지 + sample 을 함께 돌려주기 위한 helper.

    1차: 직접 scandir 시도.
    2차 (Windows + UNC fail 시): WSL fallback — readlink 로 symlink target 받아
        /mnt/<drive>/... 면 Windows drive path 로 변환 후 재시도.
    Returns (entries_or_None, error_or_None).
    """
    path_str = str(p)
    try:
        with os.scandir(path_str) as it:
            entries = sorted(e.name for e in it)
        return entries, None
    except (OSError, FileNotFoundError, NotADirectoryError) as e:
        # Windows + UNC 에서만 fallback 시도.
        if _is_windows() and ("\\\\wsl." in path_str or "\\\\wsl$" in path_str.lower()):
            resolved = _resolve_wsl_path(path_str)
            if resolved:
                try:
                    with os.scandir(resolved) as it:
                        entries = sorted(e.name for e in it)
                    return entries, None
                except OSError as e2:
                    return None, f"WSL fallback also failed ({resolved}): {type(e2).__name__}: {e2}"
        return None, f"{type(e).__name__}: {e}"


@app.get("/health")
def health() -> dict[str, Any]:
    resolved = _repo_root()

    # is_dir 만으로는 9P 환경에서 빈 결과 false 를 받는 케이스가 있어 scandir 도 시도.
    is_dir = False
    listable = False
    listable_error = None
    sample: list[str] | None = None
    if resolved:
        try:
            is_dir = Path(resolved).is_dir()
        except OSError as e:
            listable_error = f"is_dir failed: {type(e).__name__}: {e}"
        entries, err = _safe_list_dir(Path(resolved))
        if entries is not None:
            listable = True
            sample = entries[:8]
        elif listable_error is None:
            listable_error = err

    return {
        "status": "ok",
        "version": "0.3.0",
        "retriever_url": os.environ.get("PROJK_RETRIEVER_URL") or None,
        "agent_url": os.environ.get("PROJK_AGENT_URL") or None,
        "repo_root_input": os.environ.get("PROJK_REPO_ROOT") or None,
        "repo_root_resolved": resolved or None,
        "repo_root_exists": is_dir,
        "repo_root_listable": listable,
        "repo_root_listdir_error": listable_error,
        "repo_root_sample": sample,
        "platform": platform.system(),
        "ts": time.time(),
    }


# ---------- /tree — 데이터 미러 트리 빌드 (sidecar native FS) ----------

class TreeNode(BaseModel):
    id: str
    type: str  # 'category' | 'workbook' | 'sheet' | 'space' | 'page' | 'folder'
    title: str
    children: list["TreeNode"] | None = None
    relPath: str | None = None
    confluencePageId: str | None = None
    xlsxRepoPath: str | None = None


class TreeResult(BaseModel):
    nodes: list[TreeNode]
    rootDir: str
    loadedAt: int
    debug: dict[str, Any] | None = None


def _resolve_for_listing(p: Path) -> Path:
    """Windows + UNC + Linux symlink 결합으로 scandir 막히면 wsl readlink 통해
    Windows drive path 로 변환. 정상이면 그대로 반환.
    이 함수를 트리 root 진입 시 한 번 거치면, 그 아래 자식들은 모두 Windows fs 위라
    추가 fallback 없이 동작.
    """
    path_str = str(p)
    try:
        with os.scandir(path_str):
            pass
        return p
    except (OSError, FileNotFoundError, NotADirectoryError):
        if _is_windows() and ("\\\\wsl." in path_str or "\\\\wsl$" in path_str.lower()):
            resolved = _resolve_wsl_path(path_str)
            if resolved:
                return Path(resolved)
        return p


def _scandir_dirs(d: Path) -> list[tuple[str, Path]]:
    """`os.scandir` 결과를 (name, child_path) 리스트로. 디렉터리/파일 구분은 호출 측에서
    실제 listing 가능성으로 판단 (9P 위 `DirEntry.is_dir()` 신뢰 안 함). iterate 자체가
    OSError 면 빈 list.
    """
    try:
        with os.scandir(str(d)) as it:
            kept = [
                (e.name, Path(e.path))
                for e in it if not e.name.startswith(("_", "."))
            ]
        kept.sort(key=lambda x: x[0].lower())
        return kept
    except (OSError, FileNotFoundError, NotADirectoryError) as e:
        print(f"[tree] scandir 실패 {d}: {e}", flush=True)
        return []


def _drill_diag(root: Path, max_steps: int = 4) -> dict[str, Any]:
    """root → packages → xlsx-extractor → output 까지 단계별로 listable 여부 검증.
    어느 깊이에서 막히는지 진단."""
    steps: list[dict[str, Any]] = []
    cur = root
    parts = ["", "packages", "xlsx-extractor", "output"]
    for i, part in enumerate(parts[:max_steps]):
        if part:
            cur = cur / part
        entries, err = _safe_list_dir(cur)
        steps.append({
            "depth": i,
            "path": str(cur),
            "listable": entries is not None,
            "count": len(entries) if entries else 0,
            "sample": (entries[:5] if entries else None),
            "error": err,
        })
        if entries is None:
            break
    return {"drill": steps}


def _is_existing_file(p: Path) -> bool:
    """is_file 대신 stat 결과를 직접 받아 9P 위에서 더 안정적인 존재 검증."""
    try:
        st = os.stat(str(p))
        # Mode 의 file 비트 (regular file).
        import stat as stat_mod
        return stat_mod.S_ISREG(st.st_mode)
    except (OSError, FileNotFoundError):
        return False


def _build_p4_tree(root: Path) -> list[TreeNode]:
    """사용자 P4 워크스페이스(PROJK_P4_ROOT) 자체를 트리 source 로.

    옛 구현은 xlsx-extractor/output 디렉토리 (AI 처리 결과의 스냅샷) 를 트리로 썼는데,
    그게 사용자 워크스페이스의 실재 파일과 어긋나는 경우 트리엔 있지만 클릭하면 404
    회귀가 나왔다. 이제 살아있는 워크스페이스 fs 를 그대로 트리로 → mismatch 원천 차단.

    구조:
      <P4 workspace root>/             ← D:\\ProjectK\\Design 같은 곳
        7_System/                       ← category (top-level dir)
          PK_HUD 시스템.xlsx              ← workbook leaf (relPath = '7_System/PK_HUD 시스템')
          경제밸런스/                     ← folder (nested)
            PK_골드 밸런스.xlsx           ← workbook leaf

    relPath 규칙: P4 root 기준 상대경로에서 `.xlsx` 확장자만 떼냄. 기존 sheetMappings
    및 xlsx_raw API 컨벤션과 호환. 서브 폴더 안 파일도 그대로 (예: '7_System/경제밸런스/PK_골드 밸런스').

    9P/UNC + Linux symlink 위에서도 동작하도록 root 진입 시 한 번 _resolve_for_listing 거침.
    """
    root = _resolve_for_listing(root)
    top_entries = _scandir_dirs(root)
    if not top_entries:
        return []

    categories: list[TreeNode] = []
    for name, entry_path in top_entries:
        children = _walk_xlsx_dir(entry_path, root)
        if not children:
            continue
        children.sort(key=_node_sort_key)
        categories.append(TreeNode(
            id=f"cat:{name}",
            type="category",
            title=name,
            children=children,
        ))

    categories.sort(key=_node_sort_key)
    return categories


def _node_sort_key(n: TreeNode) -> tuple[int, str]:
    # folder 가 위, sheet 가 아래로 정렬 (VS Code 익숙한 순서). 같은 type 내에선 title.
    type_rank = 0 if n.type == "folder" else (1 if n.type == "category" else 2)
    return (type_rank, n.title.casefold())


def _walk_xlsx_dir(dir_path: Path, root: Path) -> list[TreeNode]:
    """디렉토리 안 .xlsx 파일들을 leaf 로, 서브디렉토리는 folder 노드로 (재귀).
    .xlsx 가 없는 서브트리는 결과에 포함 안 됨 (빈 카테고리·폴더 안 보임).
    """
    nodes: list[TreeNode] = []
    # files (workbook leaves)
    try:
        with os.scandir(dir_path) as it:
            entries = list(it)
    except OSError as e:
        print(f"[tree_p4] scandir 실패 {dir_path}: {e}", flush=True)
        return []
    for entry in entries:
        if not entry.is_file():
            continue
        name = entry.name
        # Excel 잠금 파일 (`~$파일명.xlsx`) 은 트리에 노출 X
        if name.startswith("~$"):
            continue
        if not name.lower().endswith(".xlsx"):
            continue
        rel_xlsx = Path(entry.path).relative_to(root).as_posix()
        rel_no_ext = rel_xlsx[: -len(".xlsx")]
        title = name[: -len(".xlsx")]
        nodes.append(TreeNode(
            id=f"sheet:{rel_no_ext}",
            type="sheet",
            title=title,
            relPath=rel_no_ext,
        ))
    # subdirectories (folder nodes, recursive)
    for sub_name, sub_path in _scandir_dirs(dir_path):
        sub_children = _walk_xlsx_dir(sub_path, root)
        if not sub_children:
            continue
        sub_children.sort(key=_node_sort_key)
        rel_dir = sub_path.relative_to(root).as_posix()
        nodes.append(TreeNode(
            id=f"folder:{rel_dir}",
            type="folder",
            title=sub_name,
            relPath=rel_dir,
            children=sub_children,
        ))
    return nodes


def _build_confluence_tree(manifest_path: Path) -> list[TreeNode]:
    # is_file() 대신 직접 read_text 시도 — 9P 위에서 stat 가 깨지더라도 read 는 동작하는 경우 있음.
    raw: str | None = None
    try:
        raw = manifest_path.read_text(encoding="utf-8")
    except (OSError, FileNotFoundError) as e:
        # WSL UNC + Linux symlink fail → wsl readlink fallback.
        path_str = str(manifest_path)
        if _is_windows() and ("\\\\wsl." in path_str or "\\\\wsl$" in path_str.lower()):
            # 부모 디렉터리 단에서 resolve 후 manifest 다시 읽기.
            resolved_parent = _resolve_for_listing(manifest_path.parent)
            if resolved_parent != manifest_path.parent:
                try:
                    raw = (resolved_parent / manifest_path.name).read_text(encoding="utf-8")
                except OSError as e2:
                    print(f"[tree] confluence manifest read fallback 실패 {resolved_parent}: {e2}", flush=True)
        if raw is None:
            print(f"[tree] confluence manifest 읽기 실패 {manifest_path}: {e}", flush=True)
            return []
    try:
        data = json.loads(raw)
    except Exception as e:
        print(f"[tree] confluence manifest 파싱 실패: {e}")
        return []

    def to_node(m: dict[str, Any], parent_path: list[str]) -> TreeNode:
        path = [*parent_path, m.get("title", "")]
        children_raw = m.get("children") or []
        children = [to_node(c, path) for c in children_raw] if children_raw else None
        return TreeNode(
            id=f"confluence:{m.get('id')}",
            type="folder" if m.get("type") == "folder" else "page",
            title=m.get("title", ""),
            confluencePageId=str(m.get("id")) if m.get("id") is not None else None,
            relPath="/".join(path),
            children=children,
        )

    return [to_node(data, [])]


@app.get("/tree/p4", response_model=TreeResult)
def tree_p4() -> TreeResult:
    # 트리 source = 사용자 P4 워크스페이스 (PROJK_P4_ROOT). 없으면 빈 트리.
    # 0.1.51 이전: xlsx-extractor/output 을 source 로 썼는데 옛 스냅샷이라 사용자 실재 파일과
    # 어긋나서 트리엔 보이는데 클릭하면 404 회귀 발생. 이제 살아있는 워크스페이스를 직접 walk.
    p4 = _normalize_repo_root(os.environ.get("PROJK_P4_ROOT") or "")
    if not p4:
        return TreeResult(nodes=[], rootDir="", loadedAt=int(time.time() * 1000))
    root = Path(p4)
    nodes = _build_p4_tree(root)
    debug: dict[str, Any] | None = None
    if not nodes:
        debug = _drill_diag(root)
        print(f"[tree_p4] empty → drill={debug}", flush=True)
    return TreeResult(
        nodes=nodes, rootDir=str(root), loadedAt=int(time.time() * 1000), debug=debug
    )


# ---------- /xlsx_raw — P4 원본 .xlsx 의 raw bytes 응답 ----------
#
# 0.1.47 (PoC 2C) — 사용자 PC 의 file picker 부담 제거. Klaud main 이 sidecar 에
# `/xlsx_raw?relPath=7_System/PK_HUD 시스템` 호출 → P4 root 의 `.xlsx` 를 stream →
# main 이 받아 OneDrive Sync 폴더에 write → 본인용 SharePoint URL 로 webview 임베드.
#
# 0.1.48: PROJK_P4_ROOT (사용자 PC 의 D:\ProjectK\Design 같은 P4 워크스페이스) 우선.
# 미설정 또는 file 없으면 PROJK_REPO_ROOT 로 fallback (legacy).
def _p4_root() -> str:
    return _normalize_repo_root(os.environ.get("PROJK_P4_ROOT") or "")


def _resolve_xlsx_candidates(relPath: str) -> list[Path]:
    """xlsx_raw / xlsx_stat 가 공유하는 후보 경로 리스트 생성.

    P4 client view 가 한 단계 sub-prefix 로 매핑된 경우 (흔함): client root =
    D:\\ProjectK 인데 실제 .xlsx 는 D:\\ProjectK\\Design\\7_System\\... 에 sync.
    `p4 info` 의 Client root 만으론 sub-prefix 알 수 없어 자식 폴더를 한 번 살핀다.
    """
    candidates: list[Path] = []
    p4 = _p4_root()
    if p4:
        candidates.append(Path(p4) / f"{relPath}.xlsx")
        try:
            for child in sorted(Path(p4).iterdir()):
                if child.is_dir():
                    candidates.append(child / f"{relPath}.xlsx")
        except OSError:
            pass
    repo = _repo_root()
    if repo:
        candidates.append(Path(repo) / f"{relPath}.xlsx")
    return candidates


@app.get("/xlsx_raw")
def xlsx_raw(relPath: str) -> FileResponse:
    candidates = _resolve_xlsx_candidates(relPath)
    if not candidates:
        raise HTTPException(status_code=503, detail="PROJK_P4_ROOT/PROJK_REPO_ROOT 모두 미설정")
    for c in candidates:
        if c.is_file():
            return FileResponse(
                str(c),
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                filename=f"{Path(relPath).name}.xlsx",
            )
    # 사용자 P4 워크스페이스에 sync 안 받은 파일 — xlsx-extractor output 의 옛 스냅샷에는 있어
    # 트리에 노출됐지만 실재는 없음. /tree/p4 의 available=false 마킹과 같은 케이스. 트리 회색
    # 아이콘으로 사전에 차단했으면 여기 도달 X — Klaud 의 다른 진입점 (검색·QuickFind 등) 이
    # 매핑 없이 호출했을 때만 도달. 진단 가능한 메시지 포함.
    raise HTTPException(
        status_code=404,
        detail=(
            f"'{relPath}' 가 사용자 P4 워크스페이스에 sync 되어 있지 않음. "
            f"P4 sync 받거나 depot 트리에서 보세요. "
            f"(시도한 후보: {', '.join(str(c) for c in candidates)})"
        ),
    )


# 0.1.50 (Step 1+2) — main 이 OneDrive sync 폴더의 사본과 mtime 비교해 stale 인지 확인
# 후 필요할 때만 xlsx_raw 로 다운로드. raw 의 byte 스트림 없이 light HEAD-ish 응답.
@app.get("/xlsx_stat")
def xlsx_stat(relPath: str) -> dict:
    candidates = _resolve_xlsx_candidates(relPath)
    if not candidates:
        raise HTTPException(status_code=503, detail="PROJK_P4_ROOT/PROJK_REPO_ROOT 모두 미설정")
    for c in candidates:
        if c.is_file():
            st = c.stat()
            return {
                "mtime_ms": int(st.st_mtime * 1000),
                "size": st.st_size,
                "path": str(c),
            }
    raise HTTPException(
        status_code=404,
        detail=f"파일 없음 (시도: {', '.join(str(c) for c in candidates)})",
    )


@app.get("/tree/confluence", response_model=TreeResult)
def tree_confluence() -> TreeResult:
    repo = _repo_root()
    if not repo:
        return TreeResult(nodes=[], rootDir="", loadedAt=int(time.time() * 1000))
    out_dir = Path(repo) / "packages" / "confluence-downloader" / "output"
    manifest = out_dir / "_manifest.json"
    nodes = _build_confluence_tree(manifest)
    debug: dict[str, Any] | None = None
    if not nodes:
        debug = {
            "manifest": str(manifest),
            "manifest_readable": False,
            "out_dir_listable": False,
        }
        try:
            manifest.read_text(encoding="utf-8")
            debug["manifest_readable"] = True
        except OSError as e:
            debug["manifest_error"] = f"{type(e).__name__}: {e}"
        entries, err = _safe_list_dir(out_dir)
        if entries is not None:
            debug["out_dir_listable"] = True
            debug["out_dir_sample"] = entries[:5]
        elif err:
            debug["out_dir_error"] = err
        print(f"[tree_confluence] empty → debug={debug}", flush=True)
    return TreeResult(
        nodes=nodes, rootDir=str(out_dir), loadedAt=int(time.time() * 1000), debug=debug
    )


# ---------- /search_docs ----------

class SearchRequest(BaseModel):
    query: str
    limit: int = 20
    types: list[str] | None = None


class SearchHit(BaseModel):
    type: str  # 'xlsx' | 'confluence'
    doc_id: str
    title: str
    path: str
    url: str | None = None
    local_path: str | None = None
    snippet: str = ""
    matched_sheets: list[str] = Field(default_factory=list)
    score: float = 0.0
    source: str = "structural"


class SearchResponse(BaseModel):
    results: list[SearchHit]
    took_ms: int


def _retriever_url() -> str:
    return (os.environ.get("PROJK_RETRIEVER_URL") or "").rstrip("/")


def _agent_url() -> str:
    return (os.environ.get("PROJK_AGENT_URL") or "").rstrip("/")


def _aggregate_chunks_to_docs(chunks: list[dict[str, Any]], limit: int) -> list[SearchHit]:
    """qna-poc 의 chunk-level 결과를 document-level 로 dedup·집계.

    그룹화 키 — Excel 은 workbook 명, Confluence 는 workbook prefix.
    각 그룹의 best chunk score 를 score 로 채택. snippet 도 best chunk 의 text 일부.
    matched_sheets 에는 같은 워크북 안에서 매칭된 시트들 누적.
    """
    by_doc: dict[str, dict[str, Any]] = {}
    for c in chunks:
        workbook = c.get("workbook") or ""
        sheet = c.get("sheet") or ""
        is_confluence = workbook.startswith("Confluence/")
        doc_id = workbook
        if not doc_id:
            continue

        existing = by_doc.get(doc_id)
        if existing is None or c.get("score", 0) > existing.get("score", 0):
            title = workbook.split("/")[-1] if is_confluence else workbook
            # qna-poc 는 'preview' 키, 다른 retriever 구현은 'text' 키 — 둘 다 허용.
            snippet_text = c.get("text") or c.get("preview") or c.get("snippet") or ""
            by_doc[doc_id] = {
                "type": "confluence" if is_confluence else "xlsx",
                "doc_id": doc_id,
                "title": title,
                "path": workbook,  # breadcrumb 용도 — 향후 더 예쁘게 가공 가능
                "url": c.get("source_url"),
                "snippet": snippet_text[:280],
                "matched_sheets": [sheet] if sheet else [],
                "score": float(c.get("score", 0)),
                "source": str(c.get("source", "structural")),
            }
        else:
            if sheet and sheet not in existing["matched_sheets"]:
                existing["matched_sheets"].append(sheet)

    ranked = sorted(by_doc.values(), key=lambda x: x["score"], reverse=True)[:limit]
    return [SearchHit(**hit) for hit in ranked]


@app.post("/search_docs", response_model=SearchResponse)
async def search_docs(req: SearchRequest) -> SearchResponse:
    t0 = time.time()
    base = _retriever_url()
    if not base:
        # 백엔드 URL 미설정 — 빈 결과로 정직하게 반환. UI 는 "관련 문서 0개" 표시.
        return SearchResponse(results=[], took_ms=int((time.time() - t0) * 1000))

    payload = {"query": req.query, "top_k": max(req.limit * 3, 30)}
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(f"{base}/search", json=payload)
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPError as e:
        print(f"[sidecar] retriever proxy error: {e}")
        return SearchResponse(results=[], took_ms=int((time.time() - t0) * 1000))

    chunks = data.get("results") if isinstance(data, dict) else data
    if not isinstance(chunks, list):
        chunks = []
    hits = _aggregate_chunks_to_docs(chunks, req.limit)
    return SearchResponse(results=hits, took_ms=int((time.time() - t0) * 1000))


# ---------- /ask_stream ----------

class AskRequest(BaseModel):
    question: str


def _stream_stub(question: str) -> AsyncIterator[str]:
    """stub — 백엔드 URL 미설정 시 사용자에게 그 사실을 명시."""

    async def gen() -> AsyncIterator[str]:
        yield json.dumps({"type": "status", "payload": "stub — agent 백엔드 미연결"}) + "\n"
        intro = f"받은 질문: {question}\n\n실제 답변을 받으려면 SettingsModal 의 'agent 백엔드 URL' 을 설정하세요."
        for chunk in intro.split(" "):
            yield json.dumps({"type": "token", "payload": chunk + " "}) + "\n"
        yield json.dumps({"type": "result", "payload": {"answer": intro}}) + "\n"

    return gen()


async def _proxy_ask_stream(question: str) -> AsyncIterator[str]:
    """upstream agent-sdk-poc 의 /ask_stream 을 line-by-line 으로 forward."""
    base = _agent_url()
    payload = {"question": question}
    timeout = httpx.Timeout(connect=10.0, read=None, write=10.0, pool=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", f"{base}/ask_stream", json=payload) as r:
                if r.status_code != 200:
                    err = await r.aread()
                    yield json.dumps(
                        {"type": "error", "payload": f"upstream {r.status_code}: {err.decode('utf-8', 'ignore')[:200]}"}
                    ) + "\n"
                    return
                async for line in r.aiter_lines():
                    if line.strip():
                        yield line + "\n"
    except httpx.HTTPError as e:
        yield json.dumps({"type": "error", "payload": f"upstream 연결 실패: {e!s}"}) + "\n"


@app.post("/ask_stream")
async def ask_stream(req: AskRequest):
    base = _agent_url()
    gen = _proxy_ask_stream(req.question) if base else _stream_stub(req.question)
    return StreamingResponse(gen, media_type="application/x-ndjson")


# ---------- /preset_prompts (A3-a: agent 의 큐레이션된 추천 prompt 노출) ----------
#
# agent-sdk-poc 의 PRESETS — Project K 시스템·데이터시트·운영 영역에 특화된 자주 묻는
# 질문들. Klaud QnATab 의 입력란 위에 카테고리별 chips 로 노출 → 사용자 한 번 클릭으로
# 검증된 prompt 자동 채움. 빈 chat 화면 ("뭐부터 물어볼까") 의 진입 장벽 제거.
#
# 응답: { "presets": [{ "label": "...", "prompt": "...", "category": "..." }, ...] }
# upstream 미설정 또는 fail 시 빈 list — UI 가 chips 자체를 hide.


@app.get("/preset_prompts")
async def preset_prompts() -> dict:
    base = _agent_url()
    if not base:
        return {"presets": []}
    timeout = httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(f"{base}/preset_prompts")
            if r.status_code != 200:
                return {"presets": []}
            data = r.json()
            # agent 가 {"presets": [...]} 형식 반환. defensive — list 직접 반환도 허용.
            if isinstance(data, dict) and isinstance(data.get("presets"), list):
                return {"presets": data["presets"]}
            if isinstance(data, list):
                return {"presets": data}
            return {"presets": []}
    except httpx.HTTPError:
        return {"presets": []}


# ---------- /review_stream (Phase 4-2: Confluence webview body → agent → stream) ----------

class ReviewRequest(BaseModel):
    title: str
    text: str
    model: str | None = None
    review_instruction: str | None = None


async def _proxy_review_stream(payload: dict[str, Any]) -> AsyncIterator[str]:
    base = _agent_url()
    timeout = httpx.Timeout(connect=10.0, read=None, write=10.0, pool=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", f"{base}/review_stream", json=payload) as r:
                if r.status_code != 200:
                    err = await r.aread()
                    yield json.dumps(
                        {"type": "error", "payload": f"upstream {r.status_code}: {err.decode('utf-8', 'ignore')[:200]}"}
                    ) + "\n"
                    return
                async for line in r.aiter_lines():
                    if line.strip():
                        yield line + "\n"
    except httpx.HTTPError as e:
        yield json.dumps({"type": "error", "payload": f"upstream 연결 실패: {e!s}"}) + "\n"


@app.post("/review_stream")
async def review_stream(req: ReviewRequest):
    base = _agent_url()
    if not base:
        async def stub() -> AsyncIterator[str]:
            yield json.dumps({"type": "error", "payload": "agent 백엔드 URL 미설정 — SettingsModal 에서 설정"}) + "\n"
        return StreamingResponse(stub(), media_type="application/x-ndjson")
    payload = req.model_dump(exclude_none=True)
    return StreamingResponse(_proxy_review_stream(payload), media_type="application/x-ndjson")


# ---------- /suggest_edits (Phase 4-3.5: review 결과 기반 변경안 생성) ----------
# WSL agent (agent-sdk-poc) 가 NDJSON 으로 status/token/result 이벤트 흘림 →
# /review_stream 과 동일한 proxy 패턴. result.data.changes 에 [{id, section,
# description, before, after}] 들어옴.

class SuggestEditsRequest(BaseModel):
    title: str
    text: str
    instruction: str
    max_changes: int | None = Field(default=None, alias="maxChanges")
    html: str | None = None
    model: str | None = None

    model_config = {"populate_by_name": True}


async def _proxy_suggest_edits_stream(payload: dict[str, Any]) -> AsyncIterator[str]:
    base = _agent_url()
    timeout = httpx.Timeout(connect=10.0, read=None, write=10.0, pool=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", f"{base}/suggest_edits", json=payload) as r:
                if r.status_code != 200:
                    err = await r.aread()
                    yield json.dumps(
                        {"type": "error", "payload": f"upstream {r.status_code}: {err.decode('utf-8', 'ignore')[:200]}"}
                    ) + "\n"
                    return
                async for line in r.aiter_lines():
                    if line.strip():
                        yield line + "\n"
    except httpx.HTTPError as e:
        yield json.dumps({"type": "error", "payload": f"upstream 연결 실패: {e!s}"}) + "\n"


@app.post("/suggest_edits")
async def suggest_edits(req: SuggestEditsRequest):
    base = _agent_url()
    if not base:
        async def stub() -> AsyncIterator[str]:
            yield json.dumps({"type": "error", "payload": "agent 백엔드 URL 미설정 — SettingsModal 에서 설정"}) + "\n"
        return StreamingResponse(stub(), media_type="application/x-ndjson")
    payload = req.model_dump(exclude_none=True, by_alias=True)
    return StreamingResponse(_proxy_suggest_edits_stream(payload), media_type="application/x-ndjson")


# ---------- /quick_find (Quick Find sidebar — Confluence/Excel 메타 검색) ----------
# WSL agent (agent-sdk-poc) 의 /quick_find 로 NDJSON forward.
# Public API:
#   - fast=false (default): auto v2.1 (L1+Vector 병렬 + 자연어 expand). p50 ~324ms / 85% quality.
#   - fast=true: L1 only. ~50ms, 76% quality. typing-as-you-search 용.
# strategy 등 implementation detail 은 backend internal — frontend 노출 X.

class QuickFindRequest(BaseModel):
    query: str
    limit: int | None = None
    kinds: list[str] | None = None
    fast: bool | None = None


async def _proxy_quick_find_stream(payload: dict[str, Any]) -> AsyncIterator[str]:
    base = _agent_url()
    # quick_find 도 streaming — read timeout 무한 (auto 의 expand 발동 시 ≤ 3s)
    timeout = httpx.Timeout(connect=10.0, read=None, write=10.0, pool=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", f"{base}/quick_find", json=payload) as r:
                if r.status_code != 200:
                    err = await r.aread()
                    yield json.dumps(
                        {"type": "error", "payload": f"upstream {r.status_code}: {err.decode('utf-8', 'ignore')[:200]}"}
                    ) + "\n"
                    return
                async for line in r.aiter_lines():
                    if line.strip():
                        yield line + "\n"
    except httpx.HTTPError as e:
        yield json.dumps({"type": "error", "payload": f"upstream 연결 실패: {e!s}"}) + "\n"


@app.post("/quick_find")
async def quick_find(req: QuickFindRequest):
    base = _agent_url()
    if not base:
        async def stub() -> AsyncIterator[str]:
            yield json.dumps({"type": "error", "payload": "agent 백엔드 URL 미설정 — SettingsModal 에서 설정"}) + "\n"
        return StreamingResponse(stub(), media_type="application/x-ndjson")
    payload = req.model_dump(exclude_none=True)
    return StreamingResponse(_proxy_quick_find_stream(payload), media_type="application/x-ndjson")
