# Enum - Dungeon (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Dungeon
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Dungeon/content.md

## 한 줄 설명
Project K의 던전 시스템에서 사용되는 5가지 주요 Enum(무한의 탑 클리어 조건, 시간 던전 유형, 던전 영역 유형, 지원 모드 스케줄러, 공허의 균열 던전 레벨대)을 정의한다.

## 핵심 용어
- InfiniteTowerClearTypeEnum
- AllTargetKill
- SurviveUntilLimitTime
- KillUntilLimitTime
- BossKill
- ProtectTower
- DungeonTypeEnum
- Normal
- Special
- InterServer
- DungeonRegionTypeEnum
- Safe
- SupportModeSchedulerEnum
- ExpTimeDungeon
- GoldTimeDungeon
- WeeklyTimeDungeon
- VoidRiftDungeonTypeEnum
- Lower
- Upper
- RewardTypeEnum
- CurrencyEnum
- PlayerConditionEnum
- ContentResetTypeEnum

## 숫자/상수/공식
- 기본값: 0 (AllTargetKill, Normal, Safe, Quest)

## 참조 시스템
- InfiniteTowerFloor 시트
- TimeDungeon 시트
- VoidRiftDungeon 시트
- shared.md
- InfiniteTowerRankReward
- InfiniteTowerFloorReward
- VoidRiftReward
- TimeDungeonLevel
- TimeDungeonPrerequisite
- VoidRiftPrerequisite

## 주요 섹션
- InfiniteTowerClearTypeEnum
- DungeonTypeEnum
- DungeonRegionTypeEnum
- SupportModeSchedulerEnum
- VoidRiftDungeonTypeEnum
- 참조: 다른 시스템의 Enum
