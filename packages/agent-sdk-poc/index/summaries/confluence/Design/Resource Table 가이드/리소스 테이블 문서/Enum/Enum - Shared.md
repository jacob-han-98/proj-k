# Enum - Shared (요약)

> 출처: Confluence / Enum - Shared
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Shared/content.md

## 한 줄 설명
Project K 게임 시스템 전반에서 공통으로 사용하는 Enum(열거형) 타입들을 정의하고 각 값의 게임 동작을 설명하는 문서.

## 핵심 용어
- AttackCategoryEnum
- GradeEnum
- CharacterClassEnum
- BonusEnum
- CurrencyEnum
- OperatorEnum
- RewardTypeEnum
- PlayerConditionEnum
- TierGradeEnum
- CcEnum
- ContentResetTypeEnum
- DbEntityEnum
- NpcControlConditionEnum
- NpcControlEnum
- SupportModeSchedulerEnum
- Melee
- Range
- Magic
- Common
- Uncommon
- Rare
- Unique
- Legendary
- Myth
- Epic
- Guardian
- Warrior
- Archer
- Magician
- Shaman

## 숫자/상수/공식
- BonusEnum: 약 225개의 값 존재
- GradeEnum: 8개 등급 (Invalid, Common, Uncommon, Rare, Unique, Legendary, Myth, Epic)
- CharacterClassEnum: 6개 직업 (None, Guardian, Warrior, Archer, Arbalester, Magician, Shaman)
- CurrencyEnum: 14개 화폐 종류
- RewardTypeEnum: 28개 보상 타입
- PlayerConditionEnum: 11개 조건 판정 종류
- TierGradeEnum: 3개 등급 (Low, Mid, High)

## 참조 시스템
- Shared/Resource/Enum/resource_b_enum.proto
- CompanionClass
- PetClass
- ConditionClass
- CharacterClass
- EffectStatName
- BattleCondition
- ChronologyReward
- AchievementReward
- WorldEventMission
- ContentPrerequisite
- QuestPrerequisite
- NpcPrerequisite
- BossRaidCondition
- SealPrerequisite
- SellPrerequisite
- TimeDungeonPrerequisite
- LegacyOfTitanPrerequisite
- CompanionEnchant
- ContentSetting
- TimeDungeon
- SellLimit
- NpcAppear
- SupportModeTimeDungeon

## 주요 섹션
- AttackCategoryEnum
- GradeEnum
- CharacterClassEnum
- BonusEnum
- CurrencyEnum
- OperatorEnum
- RewardTypeEnum
- PlayerConditionEnum
- TierGradeEnum
- CcEnum
- ContentResetTypeEnum
- DbEntityEnum
- NpcControlConditionEnum
- NpcControlEnum
- SupportModeSchedulerEnum
