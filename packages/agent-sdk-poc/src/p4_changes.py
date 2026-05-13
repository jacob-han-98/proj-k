"""
p4_changes — Perforce changelist 증분 조회 wrapper (릴리스-C Phase B).

cron-tick 이 호출. P4 cli + P4PORT / P4USER / P4CLIENT env 미설정이면 graceful
skip (empty list + warning).

원본 위치: //main/ProjectK/Resource/design/*.xlsx (DataSheet) + //main/ProjectK/Design/*
(기획서). 사용자 환경에서 정확한 depot path 는 env 또는 .env.local 에서 받음.

설계:
- subprocess 로 `p4 changes -e <last_changelist> //depot/path/...` 호출
- 변경된 파일 list 추출 (changelist 별 -p4 describe 호출 또는 그냥 changelist 번호 list 만)
- 미설치 / 미설정 / 권한 오류 → 빈 list + warn print
- cron-tick 입장에서는 P4 가 영영 안 되어도 다른 source (Confluence) 는 동작해야 함
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
from typing import Iterable

_LOG = logging.getLogger("p4_changes")


def is_available() -> bool:
    """p4 cli + P4PORT 설정 확인. cron-tick 이 진입 가능 여부 판단."""
    if shutil.which("p4") is None:
        return False
    if not os.environ.get("P4PORT"):
        return False
    return True


def _run_p4(args: list[str], timeout: int = 30) -> tuple[bool, str, str]:
    """p4 subprocess. (success, stdout, stderr)."""
    try:
        r = subprocess.run(
            ["p4", *args],
            capture_output=True, text=True, timeout=timeout,
        )
        return r.returncode == 0, r.stdout or "", r.stderr or ""
    except FileNotFoundError:
        return False, "", "p4 cli not installed"
    except subprocess.TimeoutExpired:
        return False, "", f"p4 timeout after {timeout}s"
    except Exception as e:
        return False, "", str(e)


def list_changes_since(since_changelist: int | None, depot_paths: Iterable[str],
                       max_changelists: int = 200) -> list[dict]:
    """`p4 changes` 로 since 이후 changelist 의 list 반환.

    Args:
        since_changelist: None 이면 전체 (테스트), int 이면 그 이상.
        depot_paths: 검사할 depot 경로 (예: ['//main/ProjectK/Resource/design/...']).
        max_changelists: 보호 cap.

    Returns:
        [{"changelist": int, "user": str, "date": str, "desc": str}, ...]
        실패 / 미설치 시 빈 list.
    """
    if not is_available():
        _LOG.warning("p4 cli or P4PORT not configured — skip p4_changes")
        return []

    out_all: list[dict] = []
    seen: set[int] = set()

    for path in depot_paths:
        # 형식: p4 changes -e <CL> -m <N> -l <path>
        args = ["changes", "-l", "-m", str(max_changelists)]
        if since_changelist:
            args.extend(["-e", str(since_changelist)])
        args.append(path)

        ok, stdout, stderr = _run_p4(args)
        if not ok:
            _LOG.warning(f"p4 changes failed for {path}: {stderr[:200]}")
            continue

        for cl in _parse_changes_long(stdout):
            if cl["changelist"] in seen:
                continue
            seen.add(cl["changelist"])
            out_all.append(cl)

    out_all.sort(key=lambda c: c["changelist"])
    return out_all


def list_files_in_changelist(changelist: int) -> list[str]:
    """`p4 describe -s <CL>` 의 affected files list. cron-tick 이 ChromaDB upsert path 도출용."""
    if not is_available():
        return []
    ok, stdout, _ = _run_p4(["describe", "-s", str(changelist)])
    if not ok:
        return []
    files: list[str] = []
    for line in stdout.splitlines():
        # 형식: "... //depot/path/file.xlsx#3 edit"
        line = line.strip()
        if line.startswith("//") and "#" in line:
            files.append(line.split("#", 1)[0])
    return files


def latest_changelist(depot_path: str = "//...") -> int | None:
    """현재 head changelist 번호. cron-tick 의 last_changelist 갱신용."""
    if not is_available():
        return None
    ok, stdout, _ = _run_p4(["changes", "-m", "1", "-s", "submitted", depot_path])
    if not ok or not stdout.strip():
        return None
    # 형식: "Change 12345 on 2026/05/13 by user@client 'desc'"
    parts = stdout.strip().split(maxsplit=2)
    if len(parts) >= 2 and parts[0].lower() == "change":
        try:
            return int(parts[1])
        except ValueError:
            return None
    return None


def _parse_changes_long(stdout: str) -> list[dict]:
    """`p4 changes -l` 의 long format 출력 파싱.

    각 changelist 는:
        Change <N> on <date> by <user@client>
                <description line 1>
                <description line 2>
                ...
        (빈 줄)
    """
    out: list[dict] = []
    current: dict | None = None
    desc_lines: list[str] = []
    for line in stdout.splitlines():
        if line.startswith("Change "):
            if current:
                current["desc"] = "\n".join(desc_lines).strip()
                out.append(current)
            parts = line.split(maxsplit=4)
            try:
                cl = int(parts[1])
            except (IndexError, ValueError):
                continue
            current = {
                "changelist": cl,
                "date": parts[3] if len(parts) > 3 else "",
                "user": parts[5].split("@")[0] if len(parts) > 5 else "",
                "desc": "",
            }
            desc_lines = []
        elif line.startswith("\t") and current:
            desc_lines.append(line.strip())
    if current:
        current["desc"] = "\n".join(desc_lines).strip()
        out.append(current)
    return out
