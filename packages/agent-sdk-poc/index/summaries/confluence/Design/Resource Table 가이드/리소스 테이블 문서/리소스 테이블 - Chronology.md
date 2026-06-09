# 리소스 테이블 - Chronology (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Chronology/content.md

## 한 줄 설명
월드 이벤트의 기록과 보상을 관리하는 연대기 시스템의 테이블 구조 및 컬럼 정의 가이드.

## 핵심 용어
- Chronology (연대기)
- ChronologyReward (연대기 보상)
- ChronologyHistory (연대기 기록)
- WorldEvent
- RewardId (보상 그룹 Id)
- ChronologyId
- RewardType
- RewardTypeEnum
- ChronologyHistoryTypeEnum
- ItemId
- SummaryDesc
- HistoryType
- Textkey
- 보상 그룹
- 월드 이벤트
- 클라이언트 전용 (c 전용)
- 서버 전용 (sc)

## 숫자/상수/공식
- 보상 지급 확률: 100%
- Id 타입: int32
- Amount 타입: int32 (양의 정수)

## 참조 시스템
- WorldEvent 시트
- Chronology.xlsx (Chronology, ChronologyReward, ChronologyHistory 시트)

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- Chronology 시트
- ChronologyReward 시트
- ChronologyHistory 시트 (c 전용)
- 새 연대기 항목 추가하기
- 자주 하는 실수
- 트러블슈팅
