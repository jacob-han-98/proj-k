# 리소스 테이블 - Land (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Land/content.md

## 한 줄 설명
게임 내 월드(맵)의 기본 정보, 채널 설정, 볼륨, 영역, 몬스터/NPC/퀘스트 오브젝트 배치를 정의하는 Land 리소스 테이블 시스템.

## 핵심 용어
- Land (월드/맵)
- WorldClass
- WorldTerritory (영역)
- WorldTerritoryBox
- WorldVolume (볼륨)
- WorldBoundary
- MonsterSpawn
- NpcSpawn
- NpcAppear
- QuestObjectSpawn
- WorldTypeEnum (Field / Dungeon / Instance)
- WorldSubTypeEnum (BossRaid / Quest / TimeDungeon / InfiniteTower / Intro / GuildRaid / WestWorld / EastWorld / VoidRift)
- ChannelTypeEnum (None / Fixed / Dynamic / Static)
- VolumeTypeEnum (MonsterSpawn / PlayerSpawn / PlayerRespawn / NpcSpawn / Teleport / Quest / Condition / Sequence / Trigger / QuestObjectSpawn)
- CombatZoneTypeEnum (Normal / Safety / Safety_2 / Chaotic / Town / Hunting / Invalid)
- PlayerRespawnTypeEnum (CurrentWorldRespawnVolume / EntryWorldRespawnVolume / EntryWorldPosition)
- TerritoryCollisionEnum (None / PlayerIgnoreInTown / AllIgnore)
- NpcControlEnum (None / Appear / Disappear)
- NpcControlConditionEnum (RoutineTime / ExactTime_UTC)
- NavMesh
- Fallback 좌표
- AABB 박스

## 숫자/상수/공식
- GuaranteeMinSpawnRatio: 0 ~ 10000 (만분율 기준)
- 텔레포트 비용: 기본 요금 + (거리 / 50000) × 거리당 요금 (같은 월드), 기본 요금 + 대륙 이동 요금 + (거리 / 50000) × 거리당 요금 (다른 월드)
- VoidRiftSpawn: 6개 독립 컬럼 (VoidRiftSpawn01 ~ VoidRiftSpawn06)
- OriginWorldId: -1(미사용) 또는 유효한 WorldClass.Id

## 참조 시스템
- WorldClass.xlsx
- WorldTerritory.xlsx
- WorldTerritoryBox.xlsx
- WorldVolume.xlsx
- WorldBoundary.xlsx
- MonsterSpawn.xlsx
- Npc.xlsx (NpcSpawn, NpcAppear 시트)
- QuestObject.xlsx (QuestObjectSpawn 시트)
- MonsterClass.xlsx
- NpcClass.xlsx
- QuestObjectClass.xlsx
- Buff 테이블
- ContentSetting (TeleportBaseFee, TeleportFeePerDistance, TeleportFeeMax, TeleportFeeContinental)

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전 (WorldClass / WorldTerritory / WorldTerritoryBox / WorldVolume / WorldBoundary / MonsterSpawn / NpcSpawn / NpcAppear / QuestObjectSpawn)
- 새 월드 추가하기
- 서브 월드 추가하기 (OriginWorldId 사용)
- 텔레포트 비용 계산
- 자주 하는 실수
- 트러블슈팅
