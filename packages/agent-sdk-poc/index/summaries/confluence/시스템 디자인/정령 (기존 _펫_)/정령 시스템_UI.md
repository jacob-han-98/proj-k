# 정령 시스템_UI (요약)

> 출처: 시스템 디자인 / 정령 (기존 _펫_) / 정령 시스템_UI
> 원본: packages/confluence-downloader/output/시스템 디자인/정령 (기존 _펫_)/정령 시스템_UI/content.md

## 한 줄 설명
정령 시스템의 UI 구성 및 상호작용 방식을 정의하는 문서로, 목록·합성·강화·도깨비 탭과 HUD 정보 UI, 신규 아이콘을 포함한다.

## 핵심 용어
- 정령 (Pet)
- 도깨비 (Companion)
- 근/원/마 심볼 (Melee/Range/Magic Symbol)
- 강화 단계 (Enchant Level)
- 합성 (Compose)
- 안전 강화 (Safe Enchant)
- 확률 강화 (Probability Enchant)
- 특수 정령 (Special Pet)
- PetClass
- AttackType
- PetType
- PetGradeInfo
- MaxEnchantLv
- 근거리 (Melee)
- 원거리 (Range)
- 마법 (Magic)
- 경험치 (Experience)
- 버프/디버프 (Buff/Debuff)
- HUD
- 무한의 탑 (Infinite Tower)

## 숫자/상수/공식
- 강화 단계: 기본 0단계에서 시작, "+0"은 출력하지 않음
- 합성 재료: 4장 단위로만 등록
- 버프/디버프 최대 개수: 각각 최대 7개 (HUD 기본), 3개 (HUD 간소화)
- 스킬 아이콘 규격: 한 줄에 3~4개
- 경험치 표기: 소숫점 둘째 자리까지

## 참조 시스템
- PK_스킬 및 버프 아이콘_요청서.xlsx
- 정령 시스템_기본 및 강화
- ContentSetting (일일 초기화 시간)
- PetClass - AttackType
- PetClass - CompanionAssetResource
- PetGradeInfo - MaxEnchantLv

## 주요 섹션
- 1. UI
- 1-1. 정령 UI - "목록"
- 1-2. 정령 UI - "합성"
- 1-3. 정령 UI - "강화"
- 1-4. 정령 UI - "도깨비"
- 1-5. HUD 도깨비 정보 UI
- 1-6. 무한의 탑 입장 UI (예시)
- 1-7. 기타 UI
- 2. 아이콘
- 2-1. 신규 아이콘
