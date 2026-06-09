# 리소스 테이블 - Tutorial (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Tutorial
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Tutorial/content.md

## 한 줄 설명
게임 내 튜토리얼 단계를 정의하는 테이블로, 퀘스트 수락/완료 등의 조건에 따라 플레이어에게 노출되는 튜토리얼을 제어한다.

## 핵심 용어
- Tutorial 테이블
- StartType
- StartSubType
- TutorialStartTypeEnum
- TutorialHighlightTypeEnum
- TutorialCompleteTypeEnum
- Id
- Order
- HighlightType
- HighlightSubType
- TooltipText
- InputDisableMS
- CompleteCheck
- QuestAccept
- QuestComplete
- NoHighlight
- Npc
- Widget
- InventoryItem
- 튜토리얼 시작 트리거
- 하이라이트 이펙트
- 완료 판정
- 플레이어 데이터

## 숫자/상수/공식
- Id: int32 (sc)
- StartSubType: int32 (sc)
- Order: int32 (c 전용)
- InputDisableMS: int32 (c 전용), 밀리초 단위
- StartType 유효 범위: None, QuestAccept, QuestComplete
- HighlightType 유효 범위: NoHighlight, Npc, Widget, InventoryItem
- (StartType, StartSubType) 조합은 전체 테이블에서 고유해야 함

## 참조 시스템
- Tutorial.xlsx
- Quest 테이블

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- Enum 참조
- 전체 컬럼 사전
- 새 튜토리얼 추가하기
- 동작 흐름
- 자주 하는 실수
