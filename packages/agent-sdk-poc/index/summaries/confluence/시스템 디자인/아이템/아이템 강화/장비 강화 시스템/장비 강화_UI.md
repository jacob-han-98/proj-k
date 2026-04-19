# 장비 강화_UI (요약)

> 출처: 시스템 디자인 / 아이템 / 아이템 강화 / 장비 강화 시스템 / 장비 강화_UI
> 원본: packages/confluence-downloader/output/시스템 디자인/아이템/아이템 강화/장비 강화 시스템/장비 강화_UI/content.md

## 한 줄 설명
장비 아이템의 능력치를 상승시키는 강화 시스템의 UI 구성, 진입 경로, 화면 요소, 진행 흐름을 정의한 문서.

## 핵심 용어
- 장비 강화
- 강화 재료
- 강화 단계
- 안전 강화 구간
- 장비 파괴 구간
- 대성공
- 일반 성공
- 실패 (보존)
- 실패 (파괴)
- 강화 슬롯
- 강화 스탯 변화
- 안전 구간 즉시 강화
- 컬렉션 강화 단계 표시
- 강화 연출
- 전체화면 연출
- 아이템 툴팁
- 메인 메뉴
- 인벤토리

## 숫자/상수/공식
- 강화 연출 시간: 최대 3초
- 안전 강화 연출: 약 1초 (좌측-중앙-우측 이동)
- SuccessProb = 100%: 안전 강화 구간
- SuccessProb ≠ 100%: 장비 파괴 가능 구간
- 비용: Enchant > GoldPrice
- 강화 재료 소비: {최대 안전구간 단계} - {현재 단계}

## 참조 시스템
- ItemEquipClass
- EnchantBonus
- Enchant (SuccessProb, GoldPrice)
- EnchantCategory
- ItemType
- EquipType
- EquipParts Enum
- CanAuction
- CanStorage
- CanEnchant
- Grade
- Tier
- Enchant ID

## 주요 섹션
- UX 의도
- 화면 설명 ([1] 진입 경로, [2] 화면 구성 요소, [2-1] 상단 영역, [2-2] 장비/재료 선택 영역, [2-3] 강화 정보 영역, [2-4] 강화 연출 페이지, [2-5] 강화 결과 페이지)
- 진행 흐름 ([3-1] 진입, [3-2] 장비/재료 등록 및 해제, [3-3] 강화 진행)
