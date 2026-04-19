# 컬렉션 UI (요약)

> 출처: 시스템 디자인 / 컬렉션 / 컬렉션 UI
> 원본: packages/confluence-downloader/output/시스템 디자인/컬렉션/컬렉션 UI/content.md

## 한 줄 설명
아이템을 등록하여 스탯 보상을 얻는 컬렉션 시스템의 UI 설계 문서로, 메인 화면, 세트 리스트, 아이템 등록, 보상 획득 등의 화면 구성과 상호작용을 정의한다.

## 핵심 용어
- 컬렉션 세트
- TargetItem
- RewardStat
- RewardEffectStat
- RewardEffectValue
- 즐겨찾기
- 숨기기
- 레드닷
- 강화 단계
- 등급 (Grade)
- 아이템 아이콘
- 세로 탭
- 카테고리
- 필터
- 일괄 등록
- 일괄 구매
- 아이템 정보 창
- 보상 획득 팝업
- 진행 상태 필터
- 컬렉션 달성률
- 컬렉션 효과
- TextKeyTitle
- ItemCount
- TargetEnchantLv
- CanAuction
- ContentSetting

## 숫자/상수/공식
- 최대 2000개 정도 정보 (전체 탭)
- 최소 1개 ~ 최대 6개 아이콘 표시 (4개에서 줄바꿈)
- 최대 3줄까지 보상 효과 지원
- 강화 단계: +0~+15
- 달성 게이지: 100분율 (소수점 둘째 자리까지)
- 특정 등급 이상 (Rare) 아이템 등록 시 확인 팝업 표시

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
