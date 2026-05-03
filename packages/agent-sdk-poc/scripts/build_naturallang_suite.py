"""
자연어 어휘 테스트 suite 생성기 — 동의어 layer 효과 측정용.

기존 sample/full suite 는 질문이 한국어 코멘트 그대로 (예: "메타모프 변경 쿨타임의 정확한 값?").
이건 인덱스의 어휘와 그대로 매칭되어 동의어 layer 효과를 못 봄.

이 suite 는 **사용자가 실제로 던질 자연어** 로 작성:
  - "변신 슬롯 전환 쿨타임 몇 초?"  (코멘트는 "메타모프", 사용자는 "변신")
  - "사망 시 경험치 얼마나 잃어?"  (코멘트는 "사망", 사용자는 자연스러운 표현)
  - "PvP 치명타 게이지 최댓값"
  - 등 12 질문

기대 효과:
  - 인덱스 (동의어 무) 상태: 일부 fishing → 느림
  - 인덱스 (동의어 적용): 첫 Grep 에서 hit → 빠름

실행 결과 비교:
  Before (no index) → After (index, no synonyms) → After-2 (index + synonyms)
  의 3-tier 측정 가능.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "scripts" / "bench_out" / "benchmark_naturallang.json"


# 자연어 질문 — 인덱스의 코멘트 어휘와 의도적으로 다른 표현
QUESTIONS = [
    # 변신 (코멘트는 "메타모프")
    {
        "id": "nl-meta-cooltime",
        "category": "nl-shortform",
        "question": "변신 슬롯 전환 쿨타임은 몇 초인가? 정확한 값과 상수명 알려줘.",
        "expected": {"must_contain": ["MetamorphSwitchCoolTime", "3000"], "source_hint": "ContentSetting"},
        "vocab_pair": "메타모프↔변신",
    },
    # 사망 / 죽음 — 코멘트는 "사망"
    {
        "id": "nl-death-exp-loss",
        "category": "nl-shortform",
        "question": "캐릭터가 죽으면 경험치 몇% 잃어? 상수명과 값.",
        "expected": {"must_contain": ["DeathPenaltyExpRatio", "5"], "source_hint": "ContentSetting"},
        "vocab_pair": "사망↔죽음",
    },
    # 부활
    {
        "id": "nl-revive-hp",
        "category": "nl-shortform",
        "question": "리스폰할 때 HP 몇% 차서 부활? 상수명 포함.",
        "expected": {"must_contain": ["ReviveMaxHpHeal", "20"], "source_hint": "ContentSetting"},
        "vocab_pair": "부활↔리스폰",
    },
    # 파티
    {
        "id": "nl-party-extra-gold",
        "category": "nl-shortform",
        "question": "팟 추가 골드 비율 어디서 정의됨?",
        "expected": {"must_contain": ["PartyExtraGoldRate", "1000"], "source_hint": "ContentSetting"},
        "vocab_pair": "파티↔팟",
    },
    # 인벤토리
    {
        "id": "nl-inv-base-slot",
        "category": "nl-shortform",
        "question": "캐릭터 처음 만들면 가방 칸 몇개?",
        "expected": {"must_contain": ["InventoryBaseSlot", "100"], "source_hint": "ContentSetting"},
        "vocab_pair": "인벤토리↔가방",
    },
    # 명중
    {
        "id": "nl-hit-base",
        "category": "nl-shortform",
        "question": "공격 적중 기본값 몇%?",
        "expected": {"must_contain": ["HitBasePercent", "80"], "source_hint": "ContentSetting"},
        "vocab_pair": "명중↔적중",
    },
    # 치명타
    {
        "id": "nl-crit-max",
        "category": "nl-shortform",
        "question": "전투 시 크리 확률 최대값은?",
        "expected": {"must_contain": ["CriticalMaxPercent", "85"], "source_hint": "ContentSetting"},
        "vocab_pair": "치명타↔크리",
    },
    # 길드 / 클랜
    {
        "id": "nl-guild-found",
        "category": "nl-shortform",
        "question": "클랜 만들 때 비용 얼마?",
        "expected": {"must_contain": ["GuildFoundationPrice", "100"], "source_hint": "ContentSetting"},
        "vocab_pair": "길드↔클랜",
    },
    # 몬스터 / 몹
    {
        "id": "nl-monster-target-refresh",
        "category": "nl-shortform",
        "question": "몹 타기팅 갱신 주기 몇 초?",
        "expected": {"must_contain": ["MonsterDefaultTargetRefreshTime", "5"], "source_hint": "ContentSetting"},
        "vocab_pair": "몬스터↔몹",
    },
    # 데미지 (자주 쓰는 외래어 표기)
    {
        "id": "nl-damage-modifier",
        "category": "nl-shortform",
        "question": "최대 무기 피해 허용 오차 만분율은?",
        "expected": {"must_contain": ["MaxDamageCheckRangePercent", "10"], "source_hint": "ContentSetting"},
        "vocab_pair": "대미지↔피해",
    },
    # 텔레포트
    {
        "id": "nl-tp-base",
        "category": "nl-shortform",
        "question": "텔레포트 기본 비용은?",
        "expected": {"must_contain": ["TeleportBaseFee", "1000"], "source_hint": "ContentSetting"},
        "vocab_pair": "공통",
    },
    # 궁극기
    {
        "id": "nl-ult-open",
        "category": "nl-shortform",
        "question": "궁극기 시스템 몇 레벨에 열려?",
        "expected": {"must_contain": ["UltimateOpenLevel", "30"], "source_hint": "ContentSetting"},
        "vocab_pair": "공통",
    },
]


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "seed": "manual",
        "intent": "natural-language vocabulary test for synonym layer validation",
        "questions": QUESTIONS,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[saved] {OUT.relative_to(ROOT)} ({len(QUESTIONS)} 질문)")
    print()
    print("vocab pairs:")
    for q in QUESTIONS:
        print(f"  {q['vocab_pair']:<20} | {q['question'][:60]}")


if __name__ == "__main__":
    main()
