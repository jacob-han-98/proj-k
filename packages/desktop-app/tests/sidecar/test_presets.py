"""GET /presets/{mode} 프록시 + SummaryRequest / ReviewRequest 의 prompt_override pass-through.

2026-05-12: ModePickerEmpty ⚙ 설정 — backend agent-sdk-poc 의 preset 을 sidecar 가 그대로
프록시해서 frontend AssistantPromptSettings 가 fetch. sidecar 는 분기 없이 단순 forward.
"""

import json

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client_with_agent(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("PROJK_AGENT_URL", "http://upstream.test")
    import importlib
    import server as server_module
    importlib.reload(server_module)
    return TestClient(server_module.app)


@pytest.fixture
def client_no_agent(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.delenv("PROJK_AGENT_URL", raising=False)
    import importlib
    import server as server_module
    importlib.reload(server_module)
    return TestClient(server_module.app)


def _mock_httpx_get(monkeypatch: pytest.MonkeyPatch, response_body: dict, status: int = 200) -> None:
    import server as server_module

    class _MockResp:
        status_code = status
        text = json.dumps(response_body)
        def json(self) -> dict:
            return response_body

    class _MockClient:
        def __init__(self, *_a, **_kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_a): return False
        async def get(self, _url):
            return _MockResp()

    monkeypatch.setattr(server_module.httpx, "AsyncClient", _MockClient)


def test_get_summary_preset_proxies_to_upstream(
    monkeypatch: pytest.MonkeyPatch, client_with_agent: TestClient
) -> None:
    expected = {"prompt": "요약 preset", "model": "claude-opus-4-7", "version": "v1"}
    _mock_httpx_get(monkeypatch, expected)
    res = client_with_agent.get("/presets/summary")
    assert res.status_code == 200
    assert res.json() == expected


def test_get_review_preset_proxies_to_upstream(
    monkeypatch: pytest.MonkeyPatch, client_with_agent: TestClient
) -> None:
    expected = {"prompt": "리뷰 preset", "model": "claude-opus-4-7", "version": "v2"}
    _mock_httpx_get(monkeypatch, expected)
    res = client_with_agent.get("/presets/review")
    assert res.status_code == 200
    assert res.json() == expected


def test_get_preset_unknown_mode_returns_404(client_with_agent: TestClient) -> None:
    res = client_with_agent.get("/presets/garbage")
    assert res.status_code == 404


def test_get_preset_without_agent_url_returns_503(client_no_agent: TestClient) -> None:
    res = client_no_agent.get("/presets/summary")
    assert res.status_code == 503


def test_get_preset_upstream_failure_returns_502(
    monkeypatch: pytest.MonkeyPatch, client_with_agent: TestClient
) -> None:
    import httpx as _httpx
    import server as server_module

    class _BrokenClient:
        def __init__(self, *_a, **_kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_a): return False
        async def get(self, _url):
            raise _httpx.ConnectError("connection refused")

    monkeypatch.setattr(server_module.httpx, "AsyncClient", _BrokenClient)

    res = client_with_agent.get("/presets/summary")
    assert res.status_code == 502


def test_summary_request_accepts_prompt_override() -> None:
    """SummaryRequest 가 prompt_override 필드를 받고 forward payload 에 포함."""
    import importlib
    import server as server_module
    importlib.reload(server_module)

    req = server_module.SummaryRequest(
        title="T",
        text="본문",
        prompt_override="사용자 prompt",
    )
    payload = req.model_dump(exclude_none=True)
    assert payload["prompt_override"] == "사용자 prompt"

    # 미지정 시 prompt_override 키 누락 (exclude_none) — back-compat 보장.
    req_none = server_module.SummaryRequest(title="T", text="본문")
    payload_none = req_none.model_dump(exclude_none=True)
    assert "prompt_override" not in payload_none


def test_review_request_accepts_prompt_override() -> None:
    import importlib
    import server as server_module
    importlib.reload(server_module)

    req = server_module.ReviewRequest(
        title="T",
        text="본문",
        prompt_override="리뷰용 사용자 prompt",
    )
    payload = req.model_dump(exclude_none=True)
    assert payload["prompt_override"] == "리뷰용 사용자 prompt"

    req_none = server_module.ReviewRequest(title="T", text="본문")
    payload_none = req_none.model_dump(exclude_none=True)
    assert "prompt_override" not in payload_none


def test_review_request_prompt_override_coexists_with_review_options() -> None:
    """prompt_override 와 review_options 가 함께 와도 둘 다 보존 — payload 에 모두 살아 있어야."""
    import importlib
    import server as server_module
    importlib.reload(server_module)

    req = server_module.ReviewRequest(
        title="T",
        text="본문",
        prompt_override="사용자 prompt",
        review_options=server_module.ReviewOptionsModel(
            issue_cap=5,
            verification_cap=5,
            suggestion_cap=5,
            categories=["logic-flow"],
            reviewer_persona="planner-lead",
        ),
    )
    payload = req.model_dump(exclude_none=True)
    assert payload["prompt_override"] == "사용자 prompt"
    assert payload["review_options"]["categories"] == ["logic-flow"]
