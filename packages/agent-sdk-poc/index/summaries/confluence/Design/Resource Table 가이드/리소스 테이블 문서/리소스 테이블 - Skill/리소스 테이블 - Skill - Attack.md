# 리소스 테이블 - Skill - Attack (요약)

> 출처: Confluence / PK 공간
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Skill/리소스 테이블 - Skill - Attack/content.md

## 한 줄 설명
Project K의 공격 스킬 리소스 테이블 정의 문서로, NormalAttack과 RepeatedAttack 두 가지 공격 스킬 타입의 설정 방법, 필수 컬럼, 예시 및 트러블슈팅을 제시한다.

## 핵심 용어
- NormalAttack
- RepeatedAttack
- SkillType
- SkillCategory
- AttackType
- TargetType
- AffectType
- Multiplier
- MaxCount
- MinRange
- BuffId
- PreBuffId
- AreaShape
- AreaSize
- AreaStandard
- AnimationName
- CoolTime
- MpCost
- CcType
- AbsProb
- AbsCriticalProb
- MotherSkillId
- SkillLevel
- Options
- Melee
- Range
- Magic
- Enemy
- Hostile
- Friendly
- Circle
- Caster

## 숫자/상수/공식
- Multiplier > 0 (공격 가능 조건)
- RepeatedAttack Options[0]: 1~5 (반복 공격 횟수, 기본값 2)
- 예시 Multiplier: 15771, 24938
- 예시 MinRange: 130, 200
- 예시 AreaSize: 300

## 참조 시스템
- Skill.xlsm
- MonsterSkill.xlsm
- CompanionSkill.xlsx
- Buff 테이블
- SkillAnimationDelay.xlsx

## 주요 섹션
- NormalAttack
- RepeatedAttack
