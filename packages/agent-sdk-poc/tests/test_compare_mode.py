"""
test_compare_mode.py — 비교 모드 E2E 검증 + 회귀 테스트
=========================================================
agent.run_query(compare_mode=True/False) 를 직접 호출하고 답변·툴트레이스 검증.

실행:
    .venv/bin/python tests/test_compare_mode.py            # 1번 케이스만 (비용 절약)
    .venv/bin/python tests/test_compare_mode.py --all      # 4 케이스 모두
    .venv/bin/python tests/test_compare_mode.py --case 3   # 특정 케이스만

검증 항목:
- compare_mode=True: compare_with_reference_games 도구 호출, external 출처 ≥1, "## 타게임 사례" 섹션
- compare_mode=False: compare_with_reference_games 도구 호출 0회 (회귀 방지)
- compare_mode=True + 매칭 0건: "타게임 사례 확인되지 않음" 명시 (환각 금지)

결과는 tests/compare_out/<timestamp>_<case_id>.json 에 저장.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "src"))

from claude_agent_sdk import (  # noqa: E402
    AssistantMessage,
    ResultMessage,
    SystemMessage,
    UserMessage,
    TextBlock,
    ToolUseBlock,
)

from agent import run_query  # noqa: E402


CASES = [
    {
        "id": 1,
        "label": "compare_on_combat",
        "question": "Project K 의 명중 판정 공식은 어떻게 되나? 리니지M·W, Lord Nine, Vampir 등 타게임은 비슷한 부분을 어떻게 다루는지도 함께 알려줘.",
        "compare_mode": True,
        "expect": {
            "tool_call_compare": True,
            "external_sources_min": 1,
            "section_in_answer": "## 타게임 사례",
        },
    },
    {
        "id": 2,
        "label": "compare_on_enhancement",
        "question": "PK 의 장비 강화 시스템에 강화 실패 보호 메카닉을 도입한다면 타게임 레퍼런스 사례가 있나?",
        "compare_mode": True,
        "expect": {
            "tool_call_compare": True,
            "external_sources_min": 1,
            "section_in_answer": "## 타게임 사례",
        },
    },
    {
        "id": 3,
        "label": "compare_off_regression",
        "question": "Project K 의 명중 판정 공식은 어떻게 되나?",
        "compare_mode": False,
        "expect": {
            "tool_call_compare": False,
            "external_sources_max": 0,
            "section_not_in_answer": "## 타게임 사례",
        },
    },
    {
        "id": 4,
        "label": "compare_on_no_match",
        "question": "PK_HUD 의 색상 토큰 정의는 어떻게 되어 있고, 타게임에는 같은 패턴이 있나?",
        "compare_mode": True,
        "expect": {
            "tool_call_compare": True,
            "must_contain_one_of": ["타게임 사례 확인되지 않음", "데이터 없음"],
        },
    },
    # ── 기획팀장 사용 패턴 (cp.tech2.hybe.im 공유 스레드 1776674162264 기반) ──
    {
        "id": 5,
        "label": "teamlead_strategy_review",
        # Turn 1 — 차별화 전략 dump 를 PK 와 대조 분석
        "question": (
            "아래 서버 컨텐츠에 대한 차별화 전략을 고민 중인데, K에 넣는다면 어떻게 하는 것이 좋을 지 검토해주세요.\n\n"
            "<이하 차별화 전략 요약본>\n"
            "서버 별 컨텐츠 오픈 차등화 시스템\n"
            "로바르스 이후 국가(필드) / 인터서버 상층 / 주간, 성주 던전 등 경쟁 (1주 선오픈)\n"
            "특정 인터서버 보스 or 보너스 보스 쟁탈 or 월드 공성전 등의 트리거 (승리 서버 우선)\n"
            "시즌 단위로 차상위 서버 선정 - 서버 이전(스펙 제한) 시기\n"
            "서버 계층화 & 상위 서버는 하위 서버의 이권(시혼 or 다이아 세금/공물 등) 누릴 수 있음\n\n"
            "서버 버프 (시혼의 결정 - 서버 총 획득량 or HIT2의 투표 방식 고려)\n"
            "or 지역 버프 / 셀레탄, 스켈라, 로라브스 공성전 승리 길드가 버프 선택 권한\n"
            "승리 / 패배 서버의 버프 목록이 다르게, 승리 서버는 보상 Buff 위주 vs 패배 서버는 스펙 따라잡는 Buff"
        ),
        "compare_mode": True,
        "expect": {
            "tool_call_compare": True,
            # 전략 분석은 PK 매칭이 핵심 — Excel/Confluence 출처가 있어야 신뢰도 high
            "primary_sources_min": 2,
            # 서로 다른 PK 시스템 매칭 + 충돌 식별이 핵심
            "must_contain_one_of": ["월드 공성전", "서버 이동", "코어", "PvP 컨텐츠"],
            # "보강 제안" 또는 그에 준하는 헤더 (대안/우려/위험 등) 가 있어야 의미있는 분석
            "must_contain_one_of_2": ["보강 제안", "위험", "충돌", "주의", "권장"],
        },
    },
    {
        "id": 6,
        "label": "teamlead_external_game_named",
        # Turn 3 — HIT2 직접 조사 (이전엔 agent 가 "외부 검색 도구 없음"으로 막혔던 케이스)
        "question": "HIT2의 서버 별 버프 투표 시스템에 대해 조사해주세요.",
        "compare_mode": False,  # 토글 OFF 라도 외부 게임 자동 발동 규칙으로 시도해야 함
        "expect": {
            "tool_call_external": True,  # search_external_game 또는 compare 도구 호출
            "must_contain_one_of": [
                "HIT2", "히트2",
                "확인되지 않", "찾지 못",
            ],
        },
    },
    # ── Deep Research 프리셋 검증 (preset_prompts.py 의 새 2개를 그대로 실행) ──
    {
        "id": 8,
        "label": "preset_bdo_siege",
        # preset_prompts.py 의 "🌐 검은사막 거점전 vs PK 월드 공성전" prompt 동일
        "question": (
            "검은사막의 거점전·점령전 시스템을 공식 자료까지 조사해서 "
            "PK 의 월드 공성전과 비교 분석해줘. PK가 도입할 만한 메카닉 3가지 이상을 "
            "구체 수치와 위험·trade-off 와 함께 제안."
        ),
        "compare_mode": True,
        "expect": {
            "tool_call_external": True,
            # PK 1차 출처 + 검은사막 web 출처 둘 다 있어야
            "primary_sources_min": 2,
            "must_contain_one_of": ["검은사막", "BDO", "Black Desert"],
            "must_contain_one_of_2": ["(출처: web/", "(웹)"],
        },
    },
    {
        "id": 9,
        "label": "preset_hit2_voting",
        # preset_prompts.py 의 "🌐 HIT2 서버별 버프 투표 시스템 조사" prompt 동일
        "question": (
            "HIT2의 서버별 버프 투표 시스템을 조사해서 PK에 적용한다면 어떤 형태가 좋을지 검토해줘. "
            "PK 의 기존 서버 단위 메커니즘(연대기·공성전·서버 이동)과의 정합성도 같이."
        ),
        "compare_mode": True,
        "expect": {
            "tool_call_external": True,
            # PK 1차 출처 (연대기·공성전·서버이동) 최소 2건
            "primary_sources_min": 2,
            "must_contain_one_of": ["HIT2", "히트2"],
            # web 출처 OR 4-tier honest miss 둘 중 하나
            "must_contain_one_of_2": ["(출처: web/", "(웹)", "web 미확인", "확인되지 않"],
        },
    },
    # ── 사용자 직접 검증 (3게임 cross-reference 차별화 전략 dump) ──
    {
        "id": 10,
        "label": "user_3game_strategy_mix",
        "question": (
            "아래 서버 컨텐츠에 대한 차별화 전략을 고민 중인데, K에 넣는다면 어떻게 하는 것이 좋을 지 검토해주세요. "
            "특히, HIT2의 조율의 제단 시스템과 이브 온라인의 약탈 시스템, 리니지m의 월드 공성전 시스템\n"
            "세가지 요소를 전략적으로 섞어보고 싶습니다.\n\n"
            "<이하 차별화 전략 요약본>\n"
            "서버 별 컨텐츠 오픈 차등화 시스템\n"
            "로바르스 이후 국가(필드) / 인터서버 상층 / 주간, 성주 던전 등 경쟁 (1주 선오픈)\n"
            "특정 인터서버 보스 or 보너스 보스 쟁탈 or 월드 공성전 등의 트리거 (승리 서버 우선)\n"
            "시즌 단위로 차상위 서버 선정 - 서버 이전(스펙 제한) 시기\n"
            "서버 계층화 & 상위 서버는 하위 서버의 이권(시혼 or 다이아 세금/공물 등) 누릴 수 있음\n\n"
            "서버 버프 (시혼의 결정 - 서버 총 획득량 or HIT2의 투표 방식 고려)\n"
            "or 지역 버프 / 셀레탄, 스켈라, 로라브스 공성전 승리 길드가 버프 선택 권한\n"
            "승리 / 패배 서버의 버프 목록이 다르게, 승리 서버는 보상 Buff 위주 vs 패배 서버는 스펙 따라잡는 Buff\n\n"
            "서버 탐험/침공 요소\n"
            "로바르스/소르브 등 순차 오픈 시, 최대 보유량 현황판 -> 오픈 시 48개 서버라면, 48개 다 노출??\n"
            "인터서버 던전은 스켈라01, 스켈라02, 스켈라03으로 그룹화되어 진행하지만\n"
            "서버 탐험/침공의 컨텐츠는 현황판을 보고 유저들이 자유롭게 이동할 수 있는 구조로 고민\n"
            "각 서버/국가(필드) 별로 시혼 잔여/최대 보유 정보 or 필드 보스 현황보고 탐험 가능\n"
            "월드 공성전 or 스팟전? 을 통해 최대 보유량 상승 / 서버 승격 or 하위 서버 약탈/상납금 부여 가능"
        ),
        "compare_mode": True,
        "expect": {
            "tool_call_external": True,
            "primary_sources_min": 3,   # PK Confluence 다수
            # 3 게임 모두 본문에 등장
            "must_contain_one_of": ["HIT2", "히트2"],
            "must_contain_one_of_2": ["EVE", "이브", "약탈"],
        },
    },
    {
        "id": 7,
        "label": "deepresearch_web_fallback_bdo",
        # Deep Research — oracle 에 없는 게임 (검은사막) → WebSearch fallback 가동
        "question": (
            "검은사막의 길드/공성전 시스템을 PK 의 월드 공성전과 비교해서 "
            "PK가 도입할 만한 메카닉이 있는지 분석해줘."
        ),
        "compare_mode": True,
        "expect": {
            # WebSearch 또는 search_external_game(BDO) 둘 중 하나는 호출되어야 함
            "tool_call_external": True,
            # 답변에 검은사막/BDO 언급 + (web 출처 OR 정직한 miss)
            "must_contain_one_of": ["검은사막", "BDO", "Black Desert"],
            # PK 1차 출처는 여전히 있어야 (월드 공성전은 PK 코퍼스에 풍부)
            "primary_sources_min": 2,
            # 답변에 web 출처가 있거나, web 미확인을 명시
            "must_contain_one_of_2": ["(출처: web/", "(웹)", "web 미확인", "WebSearch"],
        },
    },
]


async def run_case(case: dict) -> dict:
    """단일 케이스 실행. SDK 메시지를 누적하고 검증 결과를 반환."""
    start = time.time()
    answer_parts: list[str] = []
    tool_calls: list[dict] = []
    cost = None

    async for msg in run_query(case["question"], compare_mode=case["compare_mode"]):
        if isinstance(msg, AssistantMessage):
            for block in msg.content:
                if isinstance(block, TextBlock):
                    answer_parts.append(block.text)
                elif isinstance(block, ToolUseBlock):
                    tool_calls.append({
                        "tool": block.name,
                        "input": block.input if isinstance(block.input, dict) else {},
                    })
        elif isinstance(msg, ResultMessage):
            cost = getattr(msg, "total_cost_usd", None)
        elif isinstance(msg, (SystemMessage, UserMessage)):
            pass

    elapsed = round(time.time() - start, 2)
    answer = "".join(answer_parts).strip()
    return {
        "case_id": case["id"],
        "label": case["label"],
        "compare_mode": case["compare_mode"],
        "question": case["question"],
        "answer": answer,
        "tool_calls": tool_calls,
        "elapsed_s": elapsed,
        "cost_usd": cost,
    }


def assess(result: dict, expect: dict) -> tuple[bool, list[str]]:
    """검증. (모두 통과 여부, 실패 메시지 리스트) 반환."""
    failures: list[str] = []
    answer = result["answer"]
    tools = result["tool_calls"]

    compare_calls = [t for t in tools if "compare_with_reference_games" in t["tool"]]
    external_calls = [t for t in tools if "search_external_game" in t["tool"]]
    any_external_tool = compare_calls or external_calls

    if "tool_call_compare" in expect:
        if expect["tool_call_compare"] and not compare_calls:
            failures.append("expected compare tool to be called, but it wasn't")
        if not expect["tool_call_compare"] and compare_calls:
            failures.append(f"expected NO compare tool calls, got {len(compare_calls)}")

    if "tool_call_external" in expect:
        # 둘 중 하나는 호출되어야 함 (compare 또는 search_external_game)
        if expect["tool_call_external"] and not any_external_tool:
            failures.append("expected external tool (compare OR search_external_game), got none")

    if "external_sources_min" in expect:
        ext_count = answer.count("(출처: external/") + answer.count("(참고 자료)")
        if ext_count < expect["external_sources_min"]:
            failures.append(f"external sources < min ({ext_count} < {expect['external_sources_min']})")

    if "external_sources_max" in expect:
        ext_count = answer.count("(출처: external/") + answer.count("(참고 자료)")
        if ext_count > expect["external_sources_max"]:
            failures.append(f"external sources > max ({ext_count} > {expect['external_sources_max']})")

    if "primary_sources_min" in expect:
        # PK 1차 출처 (.xlsx 또는 Confluence) 카운트 — 본문 패턴 기반
        primary_count = answer.count(".xlsx /") + answer.count("Confluence /")
        if primary_count < expect["primary_sources_min"]:
            failures.append(f"PK primary sources < min ({primary_count} < {expect['primary_sources_min']})")

    if "section_in_answer" in expect:
        if expect["section_in_answer"] not in answer:
            failures.append(f"missing section: {expect['section_in_answer']!r}")

    if "section_not_in_answer" in expect:
        if expect["section_not_in_answer"] in answer:
            failures.append(f"unexpected section present: {expect['section_not_in_answer']!r}")

    if "must_contain_one_of" in expect:
        if not any(s in answer for s in expect["must_contain_one_of"]):
            failures.append(f"none of expected phrases present: {expect['must_contain_one_of']}")

    if "must_contain_one_of_2" in expect:
        if not any(s in answer for s in expect["must_contain_one_of_2"]):
            failures.append(f"none of must_contain_one_of_2 present: {expect['must_contain_one_of_2']}")

    return len(failures) == 0, failures


def save_result(result: dict, ok: bool, failures: list[str]) -> Path:
    out_dir = HERE / "compare_out"
    out_dir.mkdir(exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    fname = f"{ts}_{result['case_id']}_{result['label']}.json"
    payload = {**result, "ok": ok, "failures": failures}
    fpath = out_dir / fname
    fpath.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return fpath


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="모든 케이스 실행")
    ap.add_argument("--case", type=int, help="특정 케이스만 실행 (1~4)")
    args = ap.parse_args()

    if args.case:
        cases = [c for c in CASES if c["id"] == args.case]
    elif args.all:
        cases = CASES
    else:
        cases = [CASES[0]]  # 기본: 1번만 (비용 절약)

    print(f"실행 케이스 {len(cases)}개:")
    for c in cases:
        print(f"  [{c['id']}] {c['label']} (compare_mode={c['compare_mode']})")
    print()

    overall_ok = True
    summary: list[tuple[int, str, bool, str, float, float | None]] = []

    for case in cases:
        print(f"=== Case {case['id']} — {case['label']} ===")
        print(f"  Q: {case['question']}")
        result = await run_case(case)
        ok, failures = assess(result, case["expect"])
        fpath = save_result(result, ok, failures)
        print(f"  elapsed: {result['elapsed_s']}s, cost: ${result['cost_usd']}, tools: {len(result['tool_calls'])}")
        print(f"  → saved: {fpath.name}")
        if ok:
            print(f"  ✅ PASS")
        else:
            overall_ok = False
            print(f"  ❌ FAIL")
            for f in failures:
                print(f"      - {f}")
        summary.append((
            case["id"],
            case["label"],
            ok,
            "" if ok else "; ".join(failures),
            result["elapsed_s"],
            result["cost_usd"],
        ))
        print()

    print("=== Summary ===")
    for cid, label, ok, msg, sec, cost in summary:
        cost_str = f"${cost:.4f}" if cost is not None else "?"
        print(f"  [{cid}] {label}: {'PASS' if ok else 'FAIL'} ({sec}s, {cost_str}) {msg}")
    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
