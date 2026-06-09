# Enum - Land (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Land
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Land/content.md

## 한 줄 설명
Project K의 월드(Land) 시스템에서 사용되는 Enum 타입들을 정의하는 문서. 월드 분류, 채널 관리, 부활 방식, 전투 구역, 볼륨, 영역 충돌, 몬스터 스폰, NPC 제어 등의 게임 동작을 제어하는 열거형 값들을 명시한다.

## 핵심 용어
- WorldTypeEnum
- WorldSubTypeEnum
- ChannelTypeEnum
- PlayerRespawnTypeEnum
- CombatZoneTypeEnum
- VolumeTypeEnum
- TerritoryCollisionEnum
- MonsterSpawnScheduleBasisEnum
- RespawnDisplayTypeEnum
- NpcControlEnum
- NpcControlConditionEnum
- Field
- Dungeon
- Instance
- BossRaid
- Quest
- TimeDungeon
- InfiniteTower
- Intro
- GuildRaid
- WestWorld
- EastWorld
- VoidRift
- Fixed
- Dynamic
- Static
- CurrentWorldRespawnVolume
- EntryWorldRespawnVolume
- EntryWorldPosition
- Safety
- Chaotic
- Town
- Hunting
- MonsterSpawn
- PlayerSpawn
- PlayerRespawn
- NpcSpawn
- Teleport
- Trigger
- QuestObjectSpawn
- PlayerIgnoreInTown
- AllIgnore
- CurrentTime
- LastSpawnTime
- Period
- Scheduled
- RoutineTime
- ExactTime_UTC

## 숫자/상수/공식
- ChannelCount ≥ 1 (Fixed, Static 채널 필수)
- ChannelCount ≥ 0 (Dynamic 채널 가능)
- Instance 타입에서 ChannelType이 None이면 ChannelCount/ChannelMaxCapacity/ChannelThresholdRate 모두 0
- RespawnPeriodMin/Max (리스폰 주기 표시 기반)
- Arg0~Arg2 (RoutineTime 및 ExactTime_UTC 인자)

## 참조 시스템
- WorldClass 시트
- MonsterSpawn 테이블
- WorldTerritory 시트
- NpcSpawn 테이블
- QuestObjectSpawn 테이블
- shared.md

## 주요 섹션
- WorldTypeEnum
- WorldSubTypeEnum
- ChannelTypeEnum
- PlayerRespawnTypeEnum
- CombatZoneTypeEnum
- VolumeTypeEnum
- TerritoryCollisionEnum
- MonsterSpawnScheduleBasisEnum
- RespawnDisplayTypeEnum
- NpcControlEnum
- NpcControlConditionEnum
