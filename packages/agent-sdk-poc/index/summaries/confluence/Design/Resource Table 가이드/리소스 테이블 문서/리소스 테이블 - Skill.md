# 리소스 테이블 - Skill (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Skill/content.md

## 한 줄 설명
캐릭터, 몬스터, 동료의 전투 행동을 정의하는 핵심 리소스 테이블로, 스킬 카테고리에 따라 공격, 버프, 이동, 복합, 지역 펄스, 소환 등 다양한 전투 동작을 수행한다.

## 핵심 용어
- Skill
- SkillCategory
- SkillType
- SkillGrade
- SkillLevel
- MotherSkillId
- CharacterClass
- Multiplier
- BuffId
- PreBuffId
- CostItemId
- Options
- AreaShape
- AreaSize
- MaxCount
- CcType
- AttackType
- TargetType
- AffectType
- SkillAnimationDelay
- SkillEnchant
- SkillEnchantItem
- NormalAttack
- RepeatedAttack
- OnlyBuff
- Composite
- CompositeRetarget
- PulseAreaAttack
- PulseAreaBuff
- Pull
- Push
- BackDash
- Dash
- TargetConditional
- SummonMonster
- Guild

## 숫자/상수/공식
- Id: int32 (세 파일 전체에서 유일)
- SkillLevel: int32 (강화 단계)
- MpCost: int32 (MP 소모)
- CoolTime: int32 (밀리초, >= 0)
- MinRange: int32 (>= 0)
- Multiplier: int32 (0보다 크면 공격 가능)
- MaxCount: int32 (>= 0)
- AbsProb: int32 (만분율, 선택)
- AbsCriticalProb: int32 (만분율, 선택)
- PortentFxDuration: int32 (밀리초)
- RepeatedAttack Options[0]: 1~5 (기본값 2)
- Pull Options[0]: 이동 시간(ms, 기본값 500)
- Push Options[0]: 이동 시간(ms, 기본값 500), Options[1]: 거리(기본값 100)
- BackDash Options[0]: 이동 시간(ms, 기본값 500), Options[1]: 거리(기본값 100)
- Composite/CompositeRetarget Options: 딜레이-스킬Id 쌍 (최소 2쌍/4개, 짝수 개수)
- PulseAreaAttack/PulseAreaBuff Options: [interval, life_time, zone_buff_id?] (2~3개, interval/life_time > 0)
- TargetConditional Options: [monster_skill_id, player_skill_id] (정확히 2개)
- SummonMonster Options: [monster_id, despawn_dependency?, spawn_range?]
- SkillEnchant 확률: UpgradeProb + DowngradeProb <= 10000 (유지 = 10000 - Upgrade - Downgrade)
- SkillEnchantItem GoldCost: > 0
- SkillEnchantItem NeedItemNum: > 0 (NeedItemId 설정 시)

## 참조 시스템
- Buff 테이블
- Item 테이블
- CharacterClass 테이블
- SkillAnimationDelay.xlsx
- Skill.xlsm (CharacterSkillClass, SkillEnchant, SkillEnchantItem 시트)
- MonsterSkill.xlsm (MonsterSkillClass 시트)
- CompanionSkill.xlsx (CompanionSkillClass 시트)

## 주요 섹션
- 스킬 테이블
- 개요
- 관련 시트
- 테이블 관계도
- 카테고리 페이지 매핑
- 카테고리별 컬럼 사용 매트릭스
- Options 카테고리별 해석
- 전체 컬럼 사전
- SkillAnimationDelay 테이블 컬럼 사전
- SkillEnchant 테이블 컬럼 사전
- SkillEnchantItem 테이블 컬럼 사전
