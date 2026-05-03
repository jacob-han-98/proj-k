"""Sidecar HTTP behavior tests.

Uses FastAPI TestClient so the server stays in-process — no port binding,
no real LLM calls. Verifies the contract the renderer relies on.
"""

import json
import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client() -> TestClient:
    # 매 테스트마다 모듈 재임포트 → env 변경이 반영되도록.
    import importlib
    import server as server_module
    importlib.reload(server_module)
    return TestClient(server_module.app)


def test_health_returns_ok(client: TestClient) -> None:
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert "version" in body
    assert "ts" in body


def test_search_docs_returns_expected_shape(client: TestClient) -> None:
    res = client.post("/search_docs", json={"query": "HUD", "limit": 5})
    assert res.status_code == 200
    body = res.json()
    assert "results" in body
    assert "took_ms" in body
    assert isinstance(body["results"], list)
    assert isinstance(body["took_ms"], int)
    # Phase 1 fallback returns [] when qna-poc retriever isn't wired up.
    # Once Phase 2 lands, replace with assertions on real shape.
    for hit in body["results"]:
        assert hit["type"] in {"xlsx", "confluence"}
        assert "doc_id" in hit
        assert "title" in hit
        assert "score" in hit


def test_search_docs_respects_limit(client: TestClient) -> None:
    res = client.post("/search_docs", json={"query": "test", "limit": 3})
    assert res.status_code == 200
    body = res.json()
    assert len(body["results"]) <= 3


def test_ask_stream_emits_ndjson(client: TestClient) -> None:
    """The renderer parses /ask_stream as line-delimited JSON. Verify it stays that way."""
    with client.stream("POST", "/ask_stream", json={"question": "hello"}) as res:
        assert res.status_code == 200
        assert "application/x-ndjson" in res.headers.get("content-type", "")

        events = []
        for line in res.iter_lines():
            if not line.strip():
                continue
            events.append(json.loads(line))

    # Must include at least one of each canonical event type.
    types = [e["type"] for e in events]
    assert "status" in types, f"missing 'status' in {types}"
    assert any(t == "token" for t in types), f"no 'token' events in {types}"
    assert "result" in types, f"missing 'result' in {types}"

    # Final result must contain the answer key the renderer reads.
    final = next(e for e in events if e["type"] == "result")
    assert "payload" in final
    assert "answer" in final["payload"]


def test_search_docs_validates_request(client: TestClient) -> None:
    # Missing required `query` → 422
    res = client.post("/search_docs", json={"limit": 5})
    assert res.status_code == 422


# ---------- proxy 모드 ----------

def test_search_docs_proxies_and_aggregates_to_doc_level(monkeypatch: pytest.MonkeyPatch) -> None:
    """PROJK_RETRIEVER_URL 설정 시 httpx 로 upstream 호출 + chunk → doc 집계."""
    monkeypatch.setenv("PROJK_RETRIEVER_URL", "http://upstream.test")

    import importlib
    import server as server_module
    importlib.reload(server_module)
    app = server_module.app

    # qna-poc 가 돌려줄 chunk-level 결과 mock
    upstream_chunks = {
        "results": [
            {
                "workbook": "PK_HUD 시스템",
                "sheet": "HUD_기본",
                "section_path": "레이아웃",
                "text": "HUD 기본 레이아웃 설명",
                "score": 0.91,
                "source": "vector",
                "source_url": None,
            },
            # 같은 워크북, 다른 시트 → 집계되어 matched_sheets 에 누적
            {
                "workbook": "PK_HUD 시스템",
                "sheet": "HUD_전투",
                "section_path": "전투 HUD",
                "text": "전투 시 HUD 변경",
                "score": 0.82,
                "source": "vector",
            },
            {
                "workbook": "Confluence/Design/시스템 디자인/HUD 개편안",
                "sheet": "",
                "text": "HUD 개편안 본문",
                "score": 0.78,
                "source": "fulltext",
                "source_url": "https://example.atlassian.net/wiki/x/HUD",
            },
        ]
    }

    class _MockResp:
        status_code = 200
        def raise_for_status(self) -> None: pass
        def json(self) -> dict: return upstream_chunks

    class _MockClient:
        def __init__(self, *_a, **_kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_a): return False
        async def post(self, _url, json=None):  # noqa: A002
            assert "/search" in _url
            return _MockResp()

    monkeypatch.setattr(server_module.httpx, "AsyncClient", _MockClient)

    client = TestClient(app)
    res = client.post("/search_docs", json={"query": "HUD", "limit": 10})
    assert res.status_code == 200
    body = res.json()

    assert len(body["results"]) == 2  # PK_HUD 시스템 + Confluence 페이지
    by_id = {h["doc_id"]: h for h in body["results"]}

    hud = by_id["PK_HUD 시스템"]
    assert hud["type"] == "xlsx"
    assert hud["score"] == 0.91  # max-of-chunks
    assert set(hud["matched_sheets"]) == {"HUD_기본", "HUD_전투"}

    conf = by_id["Confluence/Design/시스템 디자인/HUD 개편안"]
    assert conf["type"] == "confluence"
    assert conf["title"] == "HUD 개편안"
    assert conf["url"] == "https://example.atlassian.net/wiki/x/HUD"


def test_normalize_repo_root_linux_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """WSL Linux sidecar 분기 — UNC prefix 떼어 native /path 로."""
    import importlib
    import server as server_module
    importlib.reload(server_module)
    monkeypatch.setattr(server_module.platform, "system", lambda: "Linux")

    cases = [
        ("\\\\wsl.localhost\\Ubuntu-24.04\\home\\jacob\\repos\\proj-k", "/home/jacob/repos/proj-k"),
        ("\\\\wsl$\\Ubuntu-22.04\\home\\jacob\\repos\\proj-k", "/home/jacob/repos/proj-k"),
        ("/home/jacob/repos/proj-k", "/home/jacob/repos/proj-k"),  # 이미 Linux 경로면 그대로
        ("", ""),
    ]
    for input_path, expected in cases:
        actual = server_module._normalize_repo_root(input_path)
        assert actual == expected, f"{input_path} → {actual} (expected {expected})"


def test_normalize_repo_root_windows_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """Windows sidecar 분기 — UNC 그대로 유지, Linux-style 입력은 \\\\wsl.localhost 로 prefix 복원.

    이게 0.1.18 회귀의 핵심: Windows 에서 사용자가 `/home/jacob/repos/proj-k` 또는
    `\\home\\jacob\\repos\\proj-k` 를 saved value 로 가지고 있으면, 기존 normalize 는
    그걸 native Linux path 로 강제 변환해서 Windows fs 가 못 읽었다.
    """
    import importlib
    import server as server_module
    importlib.reload(server_module)
    monkeypatch.setattr(server_module.platform, "system", lambda: "Windows")
    # distro 후보 중 어떤 것도 실재하지 않게 → 첫 후보 fallback 으로 떨어지게.
    monkeypatch.setattr(server_module.Path, "is_dir", lambda self: False)

    # 1) UNC 입력은 그대로 통과 (Windows fs 가 직접 읽음).
    unc = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\jacob\\repos\\proj-k"
    assert server_module._normalize_repo_root(unc) == unc

    # 2) wsl$ UNC 도 그대로 (다른 형식이지만 Windows 가 인식하므로 건드리지 않음).
    unc2 = "\\\\wsl$\\Ubuntu-22.04\\home\\jacob"
    assert server_module._normalize_repo_root(unc2) == unc2

    # 3) Linux-style absolute → \\wsl.localhost\<첫 후보 distro>\... 로 prefix 복원.
    out = server_module._normalize_repo_root("/home/jacob/repos/proj-k")
    assert out.startswith("\\\\wsl.localhost\\Ubuntu-24.04\\")
    assert out.endswith("\\home\\jacob\\repos\\proj-k")

    # 4) backslash-only Linux-style (drive-relative) 도 같이 복원.
    out2 = server_module._normalize_repo_root("\\home\\jacob\\repos\\proj-k")
    assert out2 == "\\\\wsl.localhost\\Ubuntu-24.04\\home\\jacob\\repos\\proj-k"

    # 5) Windows local path (C:\..., D:\...) 는 그대로.
    assert server_module._normalize_repo_root("C:\\data\\proj-k") == "C:\\data\\proj-k"
    assert server_module._normalize_repo_root("D:\\Klaud\\data") == "D:\\Klaud\\data"

    # 6) 빈 문자열.
    assert server_module._normalize_repo_root("") == ""


def test_normalize_repo_root_windows_picks_existing_distro(monkeypatch: pytest.MonkeyPatch) -> None:
    """Windows 에서 distro 후보들을 순회하다가 실재하는 첫 path 를 반환."""
    import importlib
    import server as server_module
    importlib.reload(server_module)
    monkeypatch.setattr(server_module.platform, "system", lambda: "Windows")

    # `Ubuntu` 후보일 때만 is_dir() True 를 돌려주도록.
    def fake_is_dir(self) -> bool:
        return "\\Ubuntu\\" in str(self)

    monkeypatch.setattr(server_module.Path, "is_dir", fake_is_dir)

    out = server_module._normalize_repo_root("/home/jacob/repos/proj-k")
    assert out == "\\\\wsl.localhost\\Ubuntu\\home\\jacob\\repos\\proj-k"


def test_normalize_repo_root_windows_respects_distro_hint(monkeypatch: pytest.MonkeyPatch) -> None:
    """PROJK_WSL_DISTRO env-var 로 distro override."""
    import importlib
    import server as server_module
    importlib.reload(server_module)
    monkeypatch.setattr(server_module.platform, "system", lambda: "Windows")
    monkeypatch.setattr(server_module.Path, "is_dir", lambda self: False)
    monkeypatch.setenv("PROJK_WSL_DISTRO", "MyCustomDistro")

    out = server_module._normalize_repo_root("/home/jacob/foo")
    assert out == "\\\\wsl.localhost\\MyCustomDistro\\home\\jacob\\foo"


def test_health_includes_repo_root_exists_and_platform(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """/health 가 repo_root_exists + platform 을 노출 — settings UI validation 의 단일 신호."""
    monkeypatch.setenv("PROJK_REPO_ROOT", str(tmp_path))  # 실재하는 path

    import importlib
    import server as server_module
    importlib.reload(server_module)
    client = TestClient(server_module.app)

    body = client.get("/health").json()
    assert body["repo_root_exists"] is True
    assert body["repo_root_resolved"] == str(tmp_path)
    assert body["platform"] in {"Linux", "Windows", "Darwin"}

    # 존재하지 않는 path → False.
    monkeypatch.setenv("PROJK_REPO_ROOT", "/does/not/exist/xyz123")
    importlib.reload(server_module)
    client = TestClient(server_module.app)
    body = client.get("/health").json()
    assert body["repo_root_exists"] is False


def test_tree_endpoints_with_real_fs(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """진짜 파일시스템 (tmp_path) 으로 트리 빌더 검증.

    0.1.51 부터: /tree/p4 는 사용자 P4 워크스페이스 (PROJK_P4_ROOT) 자체를 walk —
    옛 xlsx-extractor/output 스냅샷 source 회귀 차단. confluence 는 그대로.
    """
    import importlib
    import server as server_module
    importlib.reload(server_module)
    from fastapi.testclient import TestClient

    # P4 워크스페이스 fixture
    p4_ws = tmp_path / "fake-p4-ws"
    sys_dir = p4_ws / "7_System"
    sys_dir.mkdir(parents=True)
    (sys_dir / "PK_HUD 시스템.xlsx").write_bytes(b"PK")
    (sys_dir / "PK_NPC.xlsx").write_bytes(b"PK")
    # 서브폴더 안 .xlsx — 옛 구현이 평면 구조만 처리해서 누락되던 케이스
    sub = sys_dir / "경제밸런스"
    sub.mkdir()
    (sub / "PK_골드 밸런스.xlsx").write_bytes(b"PK")
    # Excel 잠금 파일 — 트리에 노출되면 안 됨
    (sys_dir / "~$PK_HUD 시스템.xlsx").write_bytes(b"lock")
    # 비-xlsx 파일 — 트리 무시
    (sys_dir / "README.md").write_text("ignore me")

    # confluence 트리는 PROJK_REPO_ROOT 기반 별도 source — 같이 fixture
    repo = tmp_path / "fake-repo"
    conf_out = repo / "packages" / "confluence-downloader" / "output"
    conf_out.mkdir(parents=True)
    (conf_out / "_manifest.json").write_text(json.dumps({
        "id": "1",
        "title": "Design",
        "type": "page",
        "depth": 0,
        "children": [
            {"id": "2", "title": "시스템", "type": "page", "depth": 1, "children": []},
        ],
    }))

    monkeypatch.setenv("PROJK_P4_ROOT", str(p4_ws))
    monkeypatch.setenv("PROJK_REPO_ROOT", str(repo))
    importlib.reload(server_module)
    client = TestClient(server_module.app)

    r = client.get("/tree/p4")
    assert r.status_code == 200
    body = r.json()
    assert len(body["nodes"]) == 1
    sys_cat = body["nodes"][0]
    assert sys_cat["title"] == "7_System"
    assert sys_cat["type"] == "category"
    # children 정렬: folder 가 위, sheet 가 아래
    titles = [c["title"] for c in sys_cat["children"]]
    assert titles == ["경제밸런스", "PK_HUD 시스템", "PK_NPC"]
    # ~$lock 파일 / README.md 노출 안 됨
    assert "~$PK_HUD 시스템" not in titles
    assert "README" not in titles

    # 서브폴더 — folder 노드, .xlsx 자식 한 개
    folder = sys_cat["children"][0]
    assert folder["type"] == "folder"
    assert folder["relPath"] == "7_System/경제밸런스"
    assert len(folder["children"]) == 1
    gold = folder["children"][0]
    assert gold["type"] == "sheet"
    assert gold["title"] == "PK_골드 밸런스"
    assert gold["relPath"] == "7_System/경제밸런스/PK_골드 밸런스"

    # root level sheet — relPath 는 카테고리 + 파일명 (확장자 없음)
    sheet = sys_cat["children"][1]
    assert sheet["type"] == "sheet"
    assert sheet["relPath"] == "7_System/PK_HUD 시스템"

    r = client.get("/tree/confluence")
    assert r.status_code == 200
    body = r.json()
    assert len(body["nodes"]) == 1
    assert body["nodes"][0]["title"] == "Design"
    assert body["nodes"][0]["children"][0]["title"] == "시스템"


def test_tree_p4_empty_when_PROJK_P4_ROOT_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    """PROJK_P4_ROOT 미설정 시 트리 비어있음 (옛 xlsx-extractor fallback 제거)."""
    import importlib
    import server as server_module
    monkeypatch.delenv("PROJK_P4_ROOT", raising=False)
    importlib.reload(server_module)
    from fastapi.testclient import TestClient
    client = TestClient(server_module.app)

    r = client.get("/tree/p4")
    assert r.status_code == 200
    body = r.json()
    assert body["nodes"] == []
    assert body["rootDir"] == ""


def test_ask_stream_proxies_upstream_lines(monkeypatch: pytest.MonkeyPatch) -> None:
    """PROJK_AGENT_URL 설정 시 upstream NDJSON 을 line-by-line forward."""
    monkeypatch.setenv("PROJK_AGENT_URL", "http://agent.test")

    import importlib
    import server as server_module
    importlib.reload(server_module)
    app = server_module.app

    upstream_lines = [
        json.dumps({"type": "status", "payload": "upstream 시작"}),
        json.dumps({"type": "token", "payload": "안녕"}),
        json.dumps({"type": "token", "payload": "하세요"}),
        json.dumps({"type": "result", "payload": {"answer": "안녕하세요"}}),
    ]

    class _MockStreamCtx:
        status_code = 200
        async def __aenter__(self): return self
        async def __aexit__(self, *_a): return False
        async def aiter_lines(self):
            for line in upstream_lines:
                yield line

    class _MockClient:
        def __init__(self, *_a, **_kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_a): return False
        def stream(self, _method, _url, json=None):  # noqa: A002
            return _MockStreamCtx()

    monkeypatch.setattr(server_module.httpx, "AsyncClient", _MockClient)

    client = TestClient(app)
    with client.stream("POST", "/ask_stream", json={"question": "hi"}) as res:
        assert res.status_code == 200
        events = []
        for line in res.iter_lines():
            if line.strip():
                events.append(json.loads(line))

    types = [e["type"] for e in events]
    assert types == ["status", "token", "token", "result"]
    assert events[-1]["payload"]["answer"] == "안녕하세요"


def test_cors_preflight_returns_allow_origin(client: TestClient) -> None:
    """Renderer (electron-vite dev) lives at http://localhost:5174 — different
    origin from sidecar at http://127.0.0.1:<port>. POST + JSON triggers preflight,
    sidecar must answer or browser blocks all real requests. Past regression:
    핸드오프의 'network error 채팅 회귀' 의 진짜 원인이었다."""
    res = client.options(
        "/review_stream",
        headers={
            "Origin": "http://localhost:5174",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert res.status_code == 200
    assert res.headers.get("access-control-allow-origin") == "http://localhost:5174"
    assert "POST" in res.headers.get("access-control-allow-methods", "")


def test_cors_actual_response_includes_allow_origin(client: TestClient) -> None:
    """Browser also requires Allow-Origin on the actual response, not just preflight."""
    res = client.post(
        "/search_docs",
        headers={"Origin": "http://localhost:5174"},
        json={"query": "x", "limit": 1},
    )
    assert res.status_code == 200
    assert res.headers.get("access-control-allow-origin") == "http://localhost:5174"


def test_review_stream_returns_ndjson_error_without_agent_url(client: TestClient) -> None:
    """No PROJK_AGENT_URL → must still return 200 NDJSON with type=error so the
    renderer's stream parser handles it like any other event (not a 503 that
    breaks the stream contract)."""
    with client.stream("POST", "/review_stream", json={"title": "t", "text": "x"}) as res:
        assert res.status_code == 200
        assert "application/x-ndjson" in res.headers.get("content-type", "")
        events = [json.loads(line) for line in res.iter_lines() if line.strip()]
    assert len(events) >= 1
    assert events[0]["type"] == "error"


def test_suggest_edits_returns_ndjson_error_without_agent_url(client: TestClient) -> None:
    with client.stream(
        "POST",
        "/suggest_edits",
        json={"title": "t", "text": "x", "instruction": "i"},
    ) as res:
        assert res.status_code == 200
        assert "application/x-ndjson" in res.headers.get("content-type", "")
        events = [json.loads(line) for line in res.iter_lines() if line.strip()]
    assert len(events) >= 1
    assert events[0]["type"] == "error"


def test_quick_find_returns_ndjson_error_without_agent_url(client: TestClient) -> None:
    """No PROJK_AGENT_URL → 200 NDJSON with type=error (stream contract 유지)."""
    with client.stream("POST", "/quick_find", json={"query": "변신", "limit": 3}) as res:
        assert res.status_code == 200
        assert "application/x-ndjson" in res.headers.get("content-type", "")
        events = [json.loads(line) for line in res.iter_lines() if line.strip()]
    assert len(events) >= 1
    assert events[0]["type"] == "error"


def test_quick_find_fast_flag_accepted(client: TestClient) -> None:
    """fast: true 가 body 에 들어가도 sidecar 가 거부하지 않음 (그대로 forward)."""
    with client.stream(
        "POST", "/quick_find",
        json={"query": "변신", "limit": 3, "fast": True, "kinds": ["xlsx"]},
    ) as res:
        assert res.status_code == 200
        events = [json.loads(line) for line in res.iter_lines() if line.strip()]
    assert events  # at least one event (error 또는 forwarded)
