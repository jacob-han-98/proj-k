"""xlsx_raw / xlsx_stat 엔드포인트 회귀 테스트.

이번 세션에서 사용자 PC 에서 발견된 bug 의 회귀 방지:
  - P4 client root (D:\\ProjectK) 와 실제 .xlsx sync 경로 (D:\\ProjectK\\Design\\7_System\\)
    가 한 단계 어긋나는 흔한 client view 매핑. xlsx_raw 가 1단계 자식 폴더 자동 search 해야 함.
  - xlsx_stat 가 mtime/size 응답 shape 유지 (main 의 ensureFreshSync 가 이걸로 stale 판정).
"""

from __future__ import annotations

import importlib
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """가짜 P4 워크스페이스 — Design/7_System 1단계 sub-prefix 구조."""
    p4_root = tmp_path / "ProjectK"
    (p4_root / "Design" / "7_System").mkdir(parents=True)
    # 실제 sync 된 .xlsx 한 개 (binary 일부 byte).
    target = p4_root / "Design" / "7_System" / "PK_HUD 시스템.xlsx"
    target.write_bytes(b"PK\x03\x04xlsx-stub-bytes")
    # sibling 폴더 (자식 search 가 잘못 잡지 않게).
    (p4_root / "Build").mkdir()
    (p4_root / "PkServer").mkdir()
    monkeypatch.setenv("PROJK_P4_ROOT", str(p4_root))
    monkeypatch.delenv("PROJK_REPO_ROOT", raising=False)
    yield p4_root


@pytest.fixture
def client(workspace: Path) -> TestClient:
    # PROJK_P4_ROOT env 변경이 module-level 캐시에 잡히도록 reload.
    import server as server_module
    importlib.reload(server_module)
    return TestClient(server_module.app)


def test_xlsx_raw_finds_file_under_one_level_subfolder(client: TestClient) -> None:
    """client root 직속이 아닌 Design/ 자식에 있어도 자동 발견."""
    res = client.get("/xlsx_raw", params={"relPath": "7_System/PK_HUD 시스템"})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert res.content.startswith(b"PK\x03\x04")


def test_xlsx_raw_404_includes_attempted_paths(client: TestClient) -> None:
    """없는 file 은 404 + 시도한 경로 목록 포함 (사용자 진단용)."""
    res = client.get("/xlsx_raw", params={"relPath": "9_Missing/no-such-sheet"})
    assert res.status_code == 404
    detail = res.json()["detail"]
    assert "9_Missing/no-such-sheet" in detail or "9_Missing\\no-such-sheet" in detail
    # client root 직속과 자식들 모두 시도되었어야.
    assert "Design" in detail
    assert "Build" in detail


def test_xlsx_stat_returns_mtime_and_size(client: TestClient, workspace: Path) -> None:
    """ensureFresh 가 의존하는 contract — mtime_ms (int) + size + path."""
    res = client.get("/xlsx_stat", params={"relPath": "7_System/PK_HUD 시스템"})
    assert res.status_code == 200
    body = res.json()
    assert isinstance(body["mtime_ms"], int)
    assert body["mtime_ms"] > 0
    expected_size = (workspace / "Design" / "7_System" / "PK_HUD 시스템.xlsx").stat().st_size
    assert body["size"] == expected_size
    assert body["path"].endswith("PK_HUD 시스템.xlsx")


def test_xlsx_stat_404_for_missing_file(client: TestClient) -> None:
    res = client.get("/xlsx_stat", params={"relPath": "9_Missing/no-such-sheet"})
    assert res.status_code == 404


def test_xlsx_raw_503_when_neither_root_set(monkeypatch: pytest.MonkeyPatch) -> None:
    """P4_ROOT / REPO_ROOT 모두 미설정이면 503 — 사용자 settings 누락 신호."""
    monkeypatch.delenv("PROJK_P4_ROOT", raising=False)
    monkeypatch.delenv("PROJK_REPO_ROOT", raising=False)
    import server as server_module
    importlib.reload(server_module)
    c = TestClient(server_module.app)
    res = c.get("/xlsx_raw", params={"relPath": "x"})
    assert res.status_code == 503
