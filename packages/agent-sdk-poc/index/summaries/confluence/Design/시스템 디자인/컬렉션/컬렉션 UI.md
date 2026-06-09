# 컬렉션 UI (요약)

> 출처: Design / 시스템 디자인 / 컬렉션 / 컬렉션 UI
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/컬렉션/컬렉션 UI/content.md

## 한 줄 설명
아이템을 등록하여 스탯 보상을 얻는 컬렉션 시스템의 UI 설계 문서로, 메인 화면, 탭 구성, 아이템 등록 프로세스, 보상 획득, 필터 기능을 정의한다.

## 핵심 용어
- 컬렉션 세트
- TargetItem
- TargetEnchantLv
- RewardEffectStat
- RewardEffectValue
- CollectionCategoryEnum
- 즐겨찾기
- 숨기기
- 레드닷
- 아이템 등급
- 강화 단계
- 인벤토리
- 거래소
- 일괄 등록
- 일괄 구매
- 진행 상태 필터
- 등급 필터
- 강화 단계 필터
- 스탯 필터
- 컬렉션 달성률
- 컬렉션 효과
- ItemCount
- CanAuction
- ContentSetting
- TextKeyTitle
- TextKeyName

## 숫자/상수/공식
- 최대 2000개 정도 정보 (전체 탭)
- 최소 1개 ~ 최대 6개 아이콘 표시 (4개에서 줄바꿈)
- 3줄까지 보상 효과 지원
- 강화 단계: +0~+15
- 달성 게이지: 소수점 둘째 자리까지 (100분율)
- Refresh 버튼 쿨타임: 3초
- 특정 등급 이상 아이템 팝업 조건: Rare 등급 이상

## 참조 시스템
- 컬렉션 시스템
- Collection 테이블
- Stat 테이블
- ItemEquipClass 테이블
- Item 테이블
- ContentSetting

## 주요 섹션
- UX 의도
- 화면 설명 (진입 경로, 메인 화면)
- 컬렉션 세트 정보 (리스트, 상세 정보)
- 아이템 등록 (아이템 정보 창, 등록 팝업)
- 보상 획득
- 필터 기능 / 아이템 검색 기능
