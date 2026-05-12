"""
test_review_presets.py — frontend 요청 2건 (categories empty-array + prompt_override) 단위 검증
================================================================================
agent-sdk-poc/src/server.py 의:
- _build_review_options_block — categories None/empty/partial 시맨틱
- _resolve_review_system_prompt / _resolve_summary_system_prompt — override 분기
- GET /presets/summary, /presets/review — endpoint 응답 schema

실행:
    .venv/bin/python tests/test_review_presets.py

검증 항목:
- categories=None    → omit 지시 0개  (back-compat)
- categories=[]      → flow + qa_checklist + readability.issues 3개 omit 지시 모두 있음
- categories=["logic-flow"] → flow 는 유지, qa_checklist + readability.issues 만 omit
- prompt_override (non-empty) → system_prompt 가 override 그대로
- prompt_override (None/empty) → preset 사용
- GET /presets/{summary,review} → 200 + prompt/model/version 필드
- version 은 prompt 해시 → 동일 prompt 면 동일 version (재현성)
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "src"))

# 외부 의존 mock 회피용 환경 — Bedrock 호출은 안 함, import 만 깨지지 않으면 OK
from server import (  # noqa: E402
    ReviewOptions,
    ReviewStreamRequest,
    SummaryStreamRequest,
    _REVIEW_SYSTEM,
    _SUMMARY_SYSTEM_DEFAULT,
    _build_review_options_block,
    _preset_version,
    _resolve_review_system_prompt,
    _resolve_summary_system_prompt,
    app,
)
from fastapi.testclient import TestClient  # noqa: E402


PASS = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"

results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append((name, cond, detail))
    icon = PASS if cond else FAIL
    print(f"  {icon} {name}" + (f" — {detail}" if detail and not cond else ""))


# ─────────────────────────────────────────────────────────────────────────────
# 1. _build_review_options_block — categories 시맨틱
# ─────────────────────────────────────────────────────────────────────────────

def test_categories():
    print("\n[1] _build_review_options_block — categories 시맨틱")

    # None: 필드 미존재 → back-compat, omit 지시 없음
    b = _build_review_options_block(ReviewOptions(categories=None))
    check(
        "categories=None → omit 키 없음 (back-compat)",
        "`flow`" not in b and "`qa_checklist`" not in b and "`readability.issues`" not in b,
        f"block={b!r}",
    )

    # 빈 배열: 셋 다 omit
    b = _build_review_options_block(ReviewOptions(categories=[]))
    check(
        "categories=[] → `flow` omit 지시",
        "`flow`" in b,
        f"block={b!r}",
    )
    check(
        "categories=[] → `qa_checklist` omit 지시",
        "`qa_checklist`" in b,
    )
    check(
        "categories=[] → `readability.issues` omit 지시",
        "`readability.issues`" in b,
    )
    check(
        "categories=[] → OFF 안내 문구 ('모두 OFF')",
        "모두 OFF" in b,
    )

    # logic-flow 만: flow 는 유지, 나머지 omit
    b = _build_review_options_block(ReviewOptions(categories=["logic-flow"]))
    check(
        "categories=['logic-flow'] → `flow` omit 지시 없음 (logic-flow 는 유지)",
        "`flow`" not in b,
        f"block={b!r}",
    )
    check(
        "categories=['logic-flow'] → `qa_checklist` omit 지시 있음",
        "`qa_checklist`" in b,
    )
    check(
        "categories=['logic-flow'] → `readability.issues` omit 지시 있음",
        "`readability.issues`" in b,
    )
    check(
        "categories=['logic-flow'] → 로직/플로우 focus_line 포함",
        "로직/플로우" in b,
    )

    # qa-checklist 만
    b = _build_review_options_block(ReviewOptions(categories=["qa-checklist"]))
    check(
        "categories=['qa-checklist'] → `flow` omit 있음",
        "`flow`" in b,
    )
    check(
        "categories=['qa-checklist'] → `qa_checklist` omit 없음",
        "`qa_checklist`" not in b,
    )

    # readability 만
    b = _build_review_options_block(ReviewOptions(categories=["readability"]))
    check(
        "categories=['readability'] → `flow` omit + `qa_checklist` omit, readability 유지",
        "`flow`" in b and "`qa_checklist`" in b and "`readability.issues`" not in b,
    )

    # 셋 다: omit 지시 없음
    b = _build_review_options_block(
        ReviewOptions(categories=["logic-flow", "qa-checklist", "readability"])
    )
    check(
        "categories=셋 다 → omit 키 없음 (모두 명시적 ON)",
        "`flow`" not in b and "`qa_checklist`" not in b and "`readability.issues`" not in b,
        f"block={b!r}",
    )

    # opts=None: 전체 빈 문자열
    b = _build_review_options_block(None)
    check(
        "opts=None → 빈 문자열",
        b == "",
    )


# ─────────────────────────────────────────────────────────────────────────────
# 2. prompt_override 분기
# ─────────────────────────────────────────────────────────────────────────────

def test_prompt_override():
    print("\n[2] prompt_override 분기 (Review)")

    # None → preset 사용 (persona injection 됨)
    sp, used = _resolve_review_system_prompt(None, None)
    check("override=None → preset 사용, used=False", not used and sp.startswith("You are a senior game designer"))

    # 빈 문자열 → preset (back-compat)
    sp, used = _resolve_review_system_prompt("", None)
    check("override='' → preset, used=False", not used)

    # 공백만 → preset
    sp, used = _resolve_review_system_prompt("   \n  ", None)
    check("override=공백만 → preset, used=False", not used)

    # 실값 → override 그대로
    custom = "You are MY custom reviewer. Just list 3 issues. Respond in English."
    sp, used = _resolve_review_system_prompt(custom, None)
    check("override=실값 → 그대로 사용, used=True", used and sp == custom)

    # Pydantic 모델 직접 사용
    r = ReviewStreamRequest(title="t", text="b", prompt_override=custom)
    check("ReviewStreamRequest.prompt_override 직렬화", r.prompt_override == custom)

    r2 = ReviewStreamRequest(title="t", text="b")
    check("ReviewStreamRequest.prompt_override default = None", r2.prompt_override is None)

    print("\n[2-b] prompt_override 분기 (Summary)")
    sp, used = _resolve_summary_system_prompt(None)
    check(
        "summary override=None → preset _SUMMARY_SYSTEM_DEFAULT",
        not used and sp == _SUMMARY_SYSTEM_DEFAULT,
    )
    sp, used = _resolve_summary_system_prompt("custom summary prompt")
    check(
        "summary override=실값 → 그대로 사용",
        used and sp == "custom summary prompt",
    )
    s = SummaryStreamRequest(title="t", text="b", prompt_override="x")
    check("SummaryStreamRequest.prompt_override 직렬화", s.prompt_override == "x")


# ─────────────────────────────────────────────────────────────────────────────
# 3. GET /presets/{summary,review} endpoint
# ─────────────────────────────────────────────────────────────────────────────

def test_get_presets():
    print("\n[3] GET /presets/{summary,review}")
    client = TestClient(app)

    r = client.get("/presets/summary")
    check("GET /presets/summary 200", r.status_code == 200, f"status={r.status_code}")
    data = r.json()
    check("summary.prompt 비어있지 않음", isinstance(data.get("prompt"), str) and len(data["prompt"]) > 100)
    check("summary.model 존재", isinstance(data.get("model"), str) and data["model"])
    check("summary.version 존재 (8자 hex)", isinstance(data.get("version"), str) and len(data["version"]) == 8)
    check("summary.prompt == _SUMMARY_SYSTEM_DEFAULT", data["prompt"] == _SUMMARY_SYSTEM_DEFAULT)

    r = client.get("/presets/review")
    check("GET /presets/review 200", r.status_code == 200, f"status={r.status_code}")
    data = r.json()
    check("review.prompt 비어있지 않음", isinstance(data.get("prompt"), str) and len(data["prompt"]) > 100)
    check("review.model 존재", isinstance(data.get("model"), str))
    check("review.version 존재 (8자 hex)", isinstance(data.get("version"), str) and len(data["version"]) == 8)
    check("review.prompt == _REVIEW_SYSTEM (persona 미주입)", data["prompt"] == _REVIEW_SYSTEM)

    # version 재현성 — 동일 prompt 면 동일 version
    v1 = _preset_version(_SUMMARY_SYSTEM_DEFAULT)
    v2 = _preset_version(_SUMMARY_SYSTEM_DEFAULT)
    check("preset_version 재현성", v1 == v2)
    v_diff = _preset_version(_SUMMARY_SYSTEM_DEFAULT + " ")
    check("preset_version sensitivity — 1 char 추가 시 다름", v1 != v_diff)


# ─────────────────────────────────────────────────────────────────────────────
# 4. caps + categories 동시 사용 (회귀 방지)
# ─────────────────────────────────────────────────────────────────────────────

def test_caps_and_categories():
    print("\n[4] caps + categories 조합 (회귀 방지)")

    b = _build_review_options_block(
        ReviewOptions(issue_cap=3, verification_cap=0, categories=["logic-flow"])
    )
    check("caps + categories → 분량 가이드 + 우선 관점 양쪽 모두 출력", "분량 가이드" in b and "우선 관점" in b)
    check("issue_cap=3 → '최대 3건' 지시", "최대 3건" in b)
    check("verification_cap=0 → 생략 지시", "생략하고 빈 배열로 응답" in b)


# ─────────────────────────────────────────────────────────────────────────────

def main():
    test_categories()
    test_prompt_override()
    test_get_presets()
    test_caps_and_categories()

    total = len(results)
    passed = sum(1 for _, ok, _ in results if ok)
    failed = total - passed
    print(f"\n{'═' * 60}")
    print(f"  Total: {total} | Pass: {passed} | Fail: {failed}")
    if failed:
        print(f"\n  실패 항목:")
        for name, ok, detail in results:
            if not ok:
                print(f"    {FAIL} {name}" + (f"\n        {detail}" if detail else ""))
        sys.exit(1)
    print(f"  {PASS} 모두 통과")


if __name__ == "__main__":
    main()
