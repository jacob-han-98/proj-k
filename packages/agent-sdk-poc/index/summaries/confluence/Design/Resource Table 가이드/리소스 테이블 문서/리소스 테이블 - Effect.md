# 리소스 테이블 - Effect (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Effect
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Effect/content.md

## 한 줄 설명
버프가 캐릭터에게 적용하는 구체적인 효과(능력치 변화, 특수 동작)를 정의하는 테이블로, 카테고리별로 동작 방식과 컬럼 설정이 완전히 달라진다.

## 핵심 용어
- Effect (이펙트)
- EffectId
- Category (카테고리)
- BonusEnum
- EffectCategoryEnum
- Buff
- Normal
- StatIncreaseRate
- StatRatedBonus
- LevelCheck
- GuildSkillLevel
- SkillChange
- SkillCoolReduce
- SkillEnhance
- SkillEnhanceByBuffStack
- StatRatedDamage
- StackDamage
- OpponentStatRatedDamage
- ConditionDamage
- Barrier
- TeleportToVolume
- AddBuffStack
- ValuePerBuffStack
- ValuePerBuffStackRef
- BuffEnhance
- BuffEnhanceByBuffStack
- DividePvpDamge
- DevCommand

## 숫자/상수/공식
- Id: int32 (양의 정수)
- Effect1 ~ Effect5: 5개 슬롯
- Value1 ~ Value5: int32 대응 수치
- Max: "BonusEnum,최대값" 형식
- Option: 세미콜론(`;`)으로 구분된 명령어 문자열

## 참조 시스템
- Effect.xlsx (EffectClass 시트)
- Buff 테이블 (EffectId 참조)
- stat-bonus.md (Normal, StatIncreaseRate, StatRatedBonus, LevelCheck, GuildSkillLevel)
- skill-effect.md (SkillChange, SkillCoolReduce, SkillEnhance, SkillEnhanceByBuffStack)
- damage.md (StatRatedDamage, StackDamage, OpponentStatRatedDamage, ConditionDamage)
- barrier-teleport.md (Barrier, TeleportToVolume)
- buff-interaction.md (AddBuffStack, ValuePerBuffStack, ValuePerBuffStackRef, BuffEnhance, BuffEnhanceByBuffStack)
- pvp.md (DividePvpDamge)
- dev-command.md (DevCommand)

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 카테고리 페이지 매핑
- 카테고리별 컬럼 사용 매트릭스
- 전체 컬럼 사전
