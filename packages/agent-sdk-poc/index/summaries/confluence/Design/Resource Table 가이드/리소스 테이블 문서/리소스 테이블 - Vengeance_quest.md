# 리소스 테이블 - Vengeance_quest (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Vengeance_quest/content.md

## 한 줄 설명
지정한 재료 아이템을 단계별로 소모하여 진행하는 복수 퀘스트 시스템의 리소스 테이블 정의 및 작성 가이드.

## 핵심 용어
- VengeanceQuest
- VengeanceQuestStep
- VengeanceQuestAwakening
- VengeanceQuestReward
- 복수 퀘스트
- Step (단계)
- 각성 (Awakening)
- 능력치 보너스
- CostItemId
- CostItemAmount
- EffectStatName
- EffectStatValue
- CompleteAwakeningId
- RewardId
- BonusEnum
- 누적
- 서버 전용 (s)

## 숫자/상수/공식
- Id: int32 (s), 1 이상
- Step: int32 (s), 1부터 시작하여 1씩 증가하는 연속된 값 (1, 2, 3 …)
- CostItemAmount: int32 (s), 1 이상
- EffectStatValue: int32 (s)
- 능력치 보너스 누적: 1~n단계 완료 시 1~n단계의 보너스 모두 합산

## 참조 시스템
- 아이템 테이블
- 보상 테이블
- BonusEnum

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- VengeanceQuest 시트
- VengeanceQuestStep 시트
- VengeanceQuestAwakening 시트
- VengeanceQuestReward 시트
- 새 복수 퀘스트 추가하기 (How-to)
- 자주 하는 실수
- 트러블슈팅
