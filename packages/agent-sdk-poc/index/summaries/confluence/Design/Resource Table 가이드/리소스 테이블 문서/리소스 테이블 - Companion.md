# 리소스 테이블 - Companion (요약)

> 출처: Design/Resource Table 가이드/리소스 테이블 문서
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Companion/content.md

## 한 줄 설명
동료(펫) 시스템의 기본 능력치, 전투 스킬, 스킬 발동 조건, 인챈트 보너스 등을 정의하는 리소스 테이블 그룹.

## 핵심 용어
- CompanionClass
- CompanionStatGroup
- CompanionEnchant
- CompanionSkillClass
- CompanionAttackCategoryInfo
- AttackCategory
- CollisionRadius
- BaseHp
- BaseMp
- BaseMoveSpeed
- Str, Dex, Con, Int, Wis
- StatGroupId
- EnchantId
- Attack01, Attack02
- Skill01, Skill02, Skill03
- CompanionActionConditionEnum
- CompanionActionTargetEnum
- BonusEnum
- TierGrade
- SkillType
- SkillCategory
- CcType
- AttackType
- TargetType
- AffectType

## 숫자/상수/공식
- Skill01ConditionProb, Skill02ConditionProb, Skill03ConditionProb: 0 ~ 100 (백분율)
- PetTotalEnchantLv: 동료의 총 인챈트 레벨 (같은 Id 내에서 중복 불가)
- TierGrade: Low / Mid / High
- AttackCategory: Melee / Range / Magic / All
- EffectStatName01 ~ EffectStatName10: 최대 10개 추가 능력치
- EffectStatValue01 ~ EffectStatValue10: 추가 능력치 수치
- AreaSize, AreaLocation: repeated int32
- MaxCount: 최대 타격 횟수
- CoolTime: 스킬 쿨타임 (쿨타임 중인 스킬은 선택 제외)
- MpCost: 스킬 MP 소모량
- Multiplier: 데미지 배율
- PortentFxDuration: 전조 이펙트 지속 시간

## 참조 시스템
- Companion.xlsx (CompanionClass, CompanionStatGroup, CompanionEnchant, CompanionAttackCategoryInfo)
- CompanionSkill.xlsx (CompanionSkillClass)
- Buff 테이블
- Enum 문서 (CompanionActionConditionEnum, CompanionActionTargetEnum, BonusEnum, TierGradeEnum, SkillTypeEnum, SkillCategoryEnum, CcEnum, AttackTypeEnum, TargetEnum, AffectTypeEnum, ShapeEnum, SkillEntityEnum, ProjectileTypeEnum, AttackCategoryEnum)

## 주요 섹션
- Companion 테이블
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- CompanionClass
- CompanionStatGroup
- CompanionEnchant
- CompanionAttackCategoryInfo
- CompanionSkillClass
- 동료 AI 동작 방식
- 새 동료 추가하기
- 자주 하는 실수
- 트러블슈팅
