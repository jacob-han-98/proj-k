# Enum - Monster (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Monster
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Monster/content.md

## 한 줄 설명
Project K 게임의 몬스터 시스템에서 사용되는 열거형(Enum) 정의 문서로, 몬스터 타입, 전투 행동, 전투 조건, 공격 성향, 어그로 대상 선택, 타겟 선택 방식 등 6가지 Enum을 명시한다.

## 핵심 용어
- MonsterTypeEnum
- MonsterBattleActionTypeEnum
- MonsterBattleConditionTypeEnum
- AggressionTypeEnum
- AggroTargetingTypeEnum
- TargetPickTypeEnum
- MonsterBase
- MonsterClass
- MonsterBattleGroup
- MonsterBattleClass
- BuffId
- Normal
- Boss
- Named
- WorldBoss
- DungeonBoss
- FieldBoss
- CrossWorldGuard
- ProtectTower
- Aggressive
- Passive
- HighestAggro
- LowestHealth
- CharacterPriority
- CompanionPriority
- ProtectTowerPriority

## 숫자/상수/공식
- ActionOrder01~ActionOrder03 (3개 슬롯)
- Attack01, Attack02 (평타 2종)
- Skill01~Skill08 (스킬 8종)
- BattleConditionValue (HP 비율 %, 백분율 입력)
- 보스급 판정: Boss, Named, WorldBoss, DungeonBoss, FieldBoss, CrossWorldGuard, ProtectTower (7가지)

## 참조 시스템
- MonsterBase 시트
- MonsterClass 시트
- MonsterBattleGroup 시트
- MonsterBattleClass 시트

## 주요 섹션
- MonsterTypeEnum
- MonsterBattleActionTypeEnum
- MonsterBattleConditionTypeEnum
- AggressionTypeEnum
- AggroTargetingTypeEnum
- TargetPickTypeEnum
