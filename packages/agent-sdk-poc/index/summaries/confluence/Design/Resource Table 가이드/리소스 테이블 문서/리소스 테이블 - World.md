# 리소스 테이블 - World (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - World
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - World/content.md

## 한 줄 설명
서버 전체에 걸쳐 진행되는 기간제 월드 이벤트 시스템의 리소스 테이블 정의. 이벤트 참여 주체, 미션, 점수, 랭킹 보상을 설정하고 스케줄에 따라 자동으로 시작/종료된다.

## 핵심 용어
- WorldEvent
- WorldEventSchedule
- WorldEventAction
- WorldEventMission
- WorldEventScore
- WorldEventRank
- WorldEventRankReward
- WorldEventRankWeight
- EventActorType
- ActionType
- ScheduleType
- MissionGroupId
- ScoreGroupId
- RankRewardGroupId
- GroupId
- Rank
- BranchPoint
- DurationType
- RewardType
- ChronologyId

## 숫자/상수/공식
- 최종 점수 = Score × 액션 진행 수치
- 미션 최소 1개 이상 필수
- 점수 최소 1개 이상 필수
- Rank 값 중복 불가 (같은 GroupId 내)
- EnchantSkillLevel/EnchantItemLevel Arg1(목표 레벨) 1 이상 필수
- KillMonsterByLevel 최대 레벨 ≥ 최소 레벨

## 참조 시스템
- WorldEvent.xlsx (WorldEvent, WorldEventSchedule, WorldEventAction, WorldEventMission, WorldEventScore, WorldEventRank, WorldEventRankReward, WorldEventRankWeight 시트)
- Chronology 테이블
- Mail 테이블
- Item 테이블

## 주요 섹션
- 월드 이벤트 테이블
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- 새 월드 이벤트 추가하기
- 자주 하는 실수
- 트러블슈팅
