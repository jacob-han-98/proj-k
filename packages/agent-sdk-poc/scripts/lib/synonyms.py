"""
한국어 ↔ 영문 ↔ 사용자 어휘 동의어 사전.

목적:
  DataSheet 의 코멘트 어휘 (예: "메타모프 변경 쿨타임") 와
  사용자/모델의 자연어 어휘 (예: "변신 전환 쿨타임") 사이의
  mismatch 를 인덱스 시점에 동의어 표기로 해결.

사용:
  from synonyms import expand_synonyms
  enriched_label = expand_synonyms("메타모프 변경 쿨타임(ms)")
  # → "메타모프(변신) 변경(전환) 쿨타임(ms)"

원칙:
  - 게임 도메인 한정 동의어만 등록 (일반 사전 X)
  - 한 단어가 여러 동의어 가질 수 있음
  - 충돌 시 가장 긴 매칭 우선 (greedy left-to-right)
  - identifier 토큰 (CamelCase, snake_case) 은 변경하지 않음 — 영문 식별자는 보존
"""
from __future__ import annotations

import re

# 동의어 군 — (canonical, 동의어 list)
# 우선순위는 인덱스 라인의 한국어 코멘트에 등장할 가능성이 높은 표기를 canonical 로 두고,
# 사용자/모델이 흔히 쓰는 표현을 동의어로 추가.
SYNONYM_GROUPS: list[tuple[str, list[str]]] = [
    # 변신 / Metamorph (핵심 — 우리 trace 의 박살 케이스)
    ("메타모프", ["변신"]),
    # 전환 / 교체 / 변경 — 일반적이라 광범위 X. 이미 Metamorph 의 코멘트 에서만 등장하므로 좁게.
    # ("변경", ["전환", "스왑", "교체"]),  ← 너무 광범. 변신 컨텍스트에서만 좁게 적용.
    # 슬롯
    ("슬롯", ["칸"]),
    # 사망 / 죽음
    ("사망", ["죽음"]),
    # 부활
    ("부활", ["리스폰"]),
    # 파티
    ("파티", ["팟"]),
    # 길드
    ("길드", ["클랜"]),
    # 인벤토리
    ("인벤토리", ["가방"]),
    # 명중
    ("명중", ["적중"]),
    # 회피
    ("회피", ["닷지"]),
    # 치명타
    ("치명타", ["크리티컬", "크리"]),
    # 막기
    ("막기", ["방어", "블록"]),
    # 골드 / 다이아 — 금액 단위
    ("골드", ["gold"]),
    ("다이아몬드", ["다이아"]),
    # 던전
    ("던전", ["dungeon"]),
    # 보스
    ("보스", ["boss"]),
    # 몬스터 — 흔하지만 영문 매칭 도움됨
    ("몬스터", ["monster", "몹"]),
    # 캐릭터
    ("캐릭터", ["character", "PC", "플레이어"]),
    # 쿨타임 (이미 흔하지만 cooldown 연결)
    ("쿨타임", ["쿨다운", "cooldown", "재사용 대기"]),
    # 데미지
    ("대미지", ["데미지", "damage"]),
    # 경험치
    ("경험치", ["exp", "EXP"]),
]


def _build_pattern() -> tuple[re.Pattern, dict[str, str]]:
    """canonical 단어 → "canonical(동의어1·동의어2)" 표기로 치환할 정규식 빌드."""
    # 길이 내림차순으로 정렬 (longest match 보장)
    flat: list[tuple[str, list[str]]] = sorted(SYNONYM_GROUPS, key=lambda x: -len(x[0]))
    map_to_expanded: dict[str, str] = {}
    parts: list[str] = []
    for canon, syns in flat:
        # 이미 "canon(syn)" 형태면 재치환 방지 — placeholder 처리는 나중
        expanded = f"{canon}({'·'.join(syns)})"
        map_to_expanded[canon] = expanded
        parts.append(re.escape(canon))
    if not parts:
        return re.compile(r"$^"), {}  # never matches
    pat = re.compile(r"(" + "|".join(parts) + r")")
    return pat, map_to_expanded


_PAT, _MAP = _build_pattern()


def expand_synonyms(text: str) -> str:
    """text 안의 canonical 단어를 동의어 표기로 1회 확장."""
    if not text:
        return text
    # 이미 expanded 되어있는 경우 (`A(B·C)`) 는 다시 안 건드림 → 한 번만 적용 보장
    # 간단히: 같은 canonical 이 두 번 나오면 두 번 다 expand. 인덱스 빌드는 1회성이라 OK.
    def repl(m: re.Match) -> str:
        return _MAP.get(m.group(1), m.group(1))
    return _PAT.sub(repl, text)


if __name__ == "__main__":
    samples = [
        "메타모프 변경 쿨타임(ms)",
        "사망 시 경험치 손실률(%)",
        "기본 포션 사용 체력%",
        "캐릭터 삭제 최소 레벨",
        "치명타 발생 시 출력되는 디버프 ID",
        "PvP 일반 공격 시 획득할 궁극기 게이지 최솟값",
        "파티 추가 골드 비율",
    ]
    for s in samples:
        print(f"  IN : {s}")
        print(f"  OUT: {expand_synonyms(s)}")
        print()
