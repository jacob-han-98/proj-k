# 리소스 테이블 - Monster (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Monster/content.md

## 한 줄 설명
Project K의 몬스터 시스템을 정의하는 8개 시트(MonsterBase, MonsterClass, MonsterBattleClass, MonsterBattleGroup, MonsterSkillClass, MonsterReward, MonsterRandomReward, MonsterSpawn)의 컬럼, 관계도, 에러 처리를 종합 가이드한다.

## 핵심 용어
- MonsterBase
- MonsterClass
- MonsterBattleClass
- MonsterBattleGroup
- MonsterSkillClass
- MonsterReward
- MonsterRandomReward
- MonsterSpawn
- MonsterTypeEnum
- AggressionType
- BattleConditionType
- SkillCategory
- BuffId
- BattleId
- AssetName
- CollisionRadius
- MoveSpeedPeace
- MoveSpeedBattle
- TargetRefreshTime
- MaxEnemySearchRange
- MaxChaseTime
- MaxRoamingDistance
- PatternOrder
- ActionOrder
- AggroType
- AreaShape
- RewardType
- RespawnPeriod

## 숫자/상수/공식
- BattleConditionValue (MaxHpPercent 기준): 0 ~ 100
- Prob (MonsterBattleGroup): 1 이상 (0 이하 시 에러)
- PatternOrder: 같은 Id 내에서 중복 불가
- DeathAction: 1개 패턴만 허용
- ActionOrder: 01 ~ 03 (3개 슬롯)
- EffectStatName/EffectStatValue: 10개 슬롯 (01 ~ 10)
- Skill 슬롯: 01 ~ 08 (8개)
- SpeechBubbleId: repeated int64
- AreaSize: repeated int32
- AreaLocation: repeated int32
- Options: repeated int32

## 참조 시스템
- MonsterBase → MonsterBattleClass (battle_id)
- MonsterBase → MonsterSkillClass (attack01, attack02, skill01~08, spawn_skill)
- MonsterClass → MonsterBase (monster_base_id)
- MonsterClass → MonsterReward (reward_id, gold_reward_id)
- MonsterClass → Buff (buff_id)
- MonsterBattleClass → MonsterBattleGroup (battle_group_id)
- MonsterBattleClass → Buff (buff_id)
- MonsterBattleGroup → MonsterSkillClass (ActionOrder)
- MonsterSkillClass → Buff (buff_id, pre_buff_id)
- MonsterSpawn → MonsterClass (monster_id)
- MonsterSpawn → MonsterReward (spawn_extra_reward_id)
- MonsterSpawn → World (world_id)
- MonsterReward → Item (item_id)
- MonsterRandomReward → Item (item_id)

## 주요 섹션
- 몬스터 테이블 개요
- 관련 시트
- 테이블 관계도
- 몬스터 타입별 참고사항
- 전체 컬럼 사전 (MonsterBase, MonsterClass, MonsterBattleClass, MonsterBattleGroup, MonsterSkillClass, MonsterReward, MonsterRandomReward, MonsterSpawn)
- 새 몬스터 추가하기
- 자주 하는 실수
- 트러블슈팅
