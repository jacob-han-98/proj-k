# Enum - World (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/Enum
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - World/content.md

## 한 줄 설명
월드 이벤트 시스템에서 사용되는 Enum 정의 모음. 이벤트 참여 주체, 액션 추적 방식, 스케줄 시작/지속 방식, 서버 적용 조건 등을 규정한다.

## 핵심 용어
- WorldEventActorTypeEnum
- WorldEventActionTypeEnum
- WorldEventScheduleTypeEnum
- WorldEventDurationTypeEnum
- WorldEventApplyServerTypeEnum
- Character
- Guild
- GrowCombatPoint
- AchieveCombatPoint
- EnchantSkillCount
- EnchantSkillLevel
- EnchantItemCount
- EnchantItemLevel
- ClearInfiniteTowerStep
- CollectItem
- UseItem
- CollectCurrency
- UseCurrency
- KillMonster
- KillMonsterByType
- KillMonsterByLevel
- KillMonsterInWorld
- ServerOpen
- DateTime
- Chain
- Trigger
- Period
- Infinite
- None
- OpenDateExceptBefore
- OpenDateExceptAfter
- ExceptServer
- OnlyServer

## 숫자/상수/공식
- 목표 레벨 (1 이상)
- 최소 레벨, 최대 레벨 (비우면 상한 없음)
- 막타 여부 (true/false, 기본 false)
- 서버 오픈 후 경과 일수 (정수)
- 지속 일수 (정수)
- 서버 오픈일 ≥ 지정 날짜
- 서버 오픈일 ≤ 지정 날짜

## 참조 시스템
- RewardTypeEnum
- RewardUnitTypeEnum
- GradeEnum
- CurrencyEnum
- WorldTypeEnum
- WorldSubTypeEnum
- ChannelTypeEnum
- PlayerRespawnTypeEnum
- CombatZoneTypeEnum
- VolumeTypeEnum
- TerritoryCollisionEnum
- WorldEvent 시트
- WorldEventAction 시트
- WorldEventSchedule 시트
- WorldEventRankReward
- WorldEventMission
- WorldClass
- WorldTerritory
- WorldVolume

## 주요 섹션
- WorldEventActorTypeEnum
- WorldEventActionTypeEnum
- WorldEventScheduleTypeEnum
- WorldEventDurationTypeEnum
- WorldEventApplyServerTypeEnum
- 다른 시스템에서 정의된 Enum (참조)
