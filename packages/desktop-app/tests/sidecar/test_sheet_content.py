"""B3: /sheet_content 엔드포인트 회귀 테스트.

xlsx-extractor output layout (<repo_root>/packages/xlsx-extractor/output/<workbook>/<sheet>/_final/content.md)
에서 워크북 단위로 sheet 들의 content.md 들을 concat 해 LLM 리뷰 입력으로 반환.

검증:
  - happy: 워크북 안 sheet 여럿 → sheets 배열에 모두 포함, char_count + total_chars 채워짐
  - 누락: 워크북 디렉토리 없음 → 404
  - 누락: 워크북은 있는데 _final/content.md 가 없음 → 404
  - max_chars truncation
  - PROJK_REPO_ROOT 미설정 → 503
"""

from __future__ import annotations

import importlib
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """가짜 xlsx-extractor output."""
    out = tmp_path / "packages" / "xlsx-extractor" / "output"
    # PK_HUD 시스템 — sheet 두 개.
    a = out / "PK_HUD 시스템" / "HUD_기본" / "_final"
    a.mkdir(parents=True)
    (a / "content.md").write_text("# HUD_기본\n\n레이아웃 ...\n", encoding="utf-8")
    b = out / "PK_HUD 시스템" / "HUD_전투" / "_final"
    b.mkdir(parents=True)
    (b / "content.md").write_text("# HUD_전투\n\n전투 HUD ...\n", encoding="utf-8")
    # 의도적으로 _final 없는 sheet (skip 되어야)
    c = out / "PK_HUD 시스템" / "HUD_미완성"
    c.mkdir(parents=True)
    # _* 시작 디렉토리는 무시 (워크북 메타데이터 폴더)
    meta = out / "PK_HUD 시스템" / "_meta"
    meta.mkdir(parents=True)

    monkeypatch.setenv("PROJK_REPO_ROOT", str(tmp_path))
    monkeypatch.delenv("PROJK_P4_ROOT", raising=False)
    yield tmp_path


@pytest.fixture
def client(repo: Path) -> TestClient:
    import server as server_module
    importlib.reload(server_module)
    return TestClient(server_module.app)


def test_sheet_content_returns_all_sheets(client: TestClient) -> None:
    """relPath 의 basename 으로 워크북 dir 매칭 — 카테고리 경로 무시."""
    res = client.get("/sheet_content", params={"relPath": "7_System/PK_HUD 시스템"})
    assert res.status_code == 200
    body = res.json()
    assert body["workbook"] == "PK_HUD 시스템"
    names = [s["name"] for s in body["sheets"]]
    assert names == ["HUD_기본", "HUD_전투"]
    assert all(s["char_count"] > 0 for s in body["sheets"])
    assert body["total_chars"] > 0
    # 각 sheet 의 content 가 실제 파일 본문 포함
    assert "레이아웃" in body["sheets"][0]["content"]
    assert "전투 HUD" in body["sheets"][1]["content"]


def test_sheet_content_404_when_workbook_missing(client: TestClient) -> None:
    res = client.get("/sheet_content", params={"relPath": "9_Missing/존재안함"})
    assert res.status_code == 404
    assert "워크북 디렉토리 없음" in res.json()["detail"]


def test_sheet_content_404_when_no_content_md(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """워크북 dir 만 있고 content.md 가 없으면 404."""
    out = repo / "packages" / "xlsx-extractor" / "output"
    (out / "EmptyBook" / "Sheet1").mkdir(parents=True)
    # _final/content.md 없음
    import server as server_module
    importlib.reload(server_module)
    c = TestClient(server_module.app)
    res = c.get("/sheet_content", params={"relPath": "EmptyBook"})
    assert res.status_code == 404
    assert "content.md" in res.json()["detail"]


def test_sheet_content_truncates_at_max_chars(client: TestClient) -> None:
    """max_chars 초과 시 truncated 플래그 + 안내 문구."""
    res = client.get(
        "/sheet_content",
        params={"relPath": "PK_HUD 시스템", "max_chars": 10},
    )
    assert res.status_code == 200
    body = res.json()
    # 첫 sheet 가 10 자 잘리고 truncated, 두번째는 빈 content + truncated
    assert body["sheets"][0]["truncated"] is True
    assert body["sheets"][1]["truncated"] is True
    assert body["sheets"][1]["content"] == ""


def test_sheet_content_503_when_repo_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PROJK_REPO_ROOT", raising=False)
    monkeypatch.delenv("PROJK_P4_ROOT", raising=False)
    import server as server_module
    importlib.reload(server_module)
    c = TestClient(server_module.app)
    res = c.get("/sheet_content", params={"relPath": "x"})
    assert res.status_code == 503


def test_sheet_content_400_for_empty_relpath(client: TestClient) -> None:
    res = client.get("/sheet_content", params={"relPath": ""})
    assert res.status_code == 400
