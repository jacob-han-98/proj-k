# Enum - Skill (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Skill
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Skill/content.md

## 한 줄 설명
Project K의 스킬 시스템에서 사용되는 Enum 타입들(카테고리, 타입, 범위, 공격 방식, 대상, 영향 필터, CC 효과)을 정의하는 리소스 테이블 가이드.

## 핵심 용어
- SkillCategoryEnum
- SkillTypeEnum
- SkillEntityEnum
- AttackTypeEnum
- TargetEnum
- AffectTypeEnum
- ShapeEnum
- CcEnum
- NormalAttack
- RepeatedAttack
- OnlyBuff
- Pull
- Push
- Composite
- PulseAreaAttack
- PulseAreaBuff
- CompositeRetarget
- BackDash
- TargetConditional
- Dash
- SummonMonster
- Guild
- Invalid
- Attack
- Invoke
- ActiveSkill
- PassiveSkill
- Ultimate
- Caster
- Target
- Melee
- Range
- Magic
- Self
- Enemy
- Friend
- All
- PartyMember
- Direction
- GuildMember
- None
- SelfOnly
- Hostile
- Friendly
- Party
- HostileExceptTarget
- FriendlyNotMe
- PartyNotMe
- AllNotMe
- AllNotNeutral
- AllNotMeNeutral
- Rectangle
- Circle
- Arc
- Convex
- Stun
- Hold
- Silence
- Slow
- Stiff
- Burn
- Frostbite
- Freeze
- PotionSeal

## 숫자/상수/공식
- AreaSize[0] = 가로 (Rectangle), 반지름 (Circle, Arc), 좌표 배열 (Convex)
- AreaSize[1] = 세로 (Rectangle), 각도 (Arc)
- Options[2] = 지역 버프 Id (PulseAreaAttack)
- Multiplier > 0 = 공격 후 CC 적용 (Pull, Push)
- Multiplier = 0 = CC만 적용 (Pull, Push)
- buff_stack = 길드원 수 (Guild)

## 참조 시스템
- shared.md (CcEnum 참조)

## 주요 섹션
- SkillCategoryEnum
- SkillTypeEnum
- SkillEntityEnum
- AttackTypeEnum
- TargetEnum
- AffectTypeEnum
- ShapeEnum
- CcEnum
