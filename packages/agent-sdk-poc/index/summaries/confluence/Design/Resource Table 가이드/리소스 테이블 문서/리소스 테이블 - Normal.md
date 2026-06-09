# 리소스 테이블 - Normal (요약)

> 출처: Design/Resource Table 가이드/리소스 테이블 문서
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Normal/content.md

## 한 줄 설명
일반 이벤트 시스템의 데이터 구조 정의. 기간 단위로 미션을 활성화하고 완료 시 보상 및 점수를 지급하는 캐릭터/계정 단위 이벤트를 구성하는 5개 시트의 컬럼, 관계, 제약조건을 명시한다.

## 핵심 용어
- NormalEvent
- NormalEventSchedule
- NormalEventMission
- NormalEventAction
- NormalEventScoreReward
- MissionGroupId
- ScoreRewardGroupId
- PeriodType
- RewardUnitType
- Period
- ActionId
- GoalValue
- Point
- ScheduleValue
- DurationValue
- ApplyServerType
- WorldEventActionTypeEnum
- RewardTypeEnum
- ActionType
- Arg0, Arg1, Arg2, Arg3

## 숫자/상수/공식
- Period 최소값: 1 (이벤트 시작 직후부터 진행 가능)
- GoalValue 최소값: 1 이상 (0 이하 시 로드 에러)
- Point 최소값: 1 이상 (0 이하 시 로드 에러)
- 미션 그룹 최소 개수: 1개 (0개 시 에러 발생)
- 점수 보상 임계값 비교: 이전 청구 점수보다 크고 현재 누적 점수 이하인 모든 임계값의 보상이 한꺼번에 지급

## 참조 시스템
- NormalEvent.xlsx (NormalEvent, NormalEventSchedule, NormalEventMission, NormalEventAction, NormalEventScoreReward 시트)
- Item 테이블
- WorldEventActionTypeEnum
- RewardTypeEnum
- WorldEventApplyServerTypeEnum

## 주요 섹션
- 일반 이벤트 테이블
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- 새 일반 이벤트 추가하기
- 자주 하는 실수
- 트러블슈팅
