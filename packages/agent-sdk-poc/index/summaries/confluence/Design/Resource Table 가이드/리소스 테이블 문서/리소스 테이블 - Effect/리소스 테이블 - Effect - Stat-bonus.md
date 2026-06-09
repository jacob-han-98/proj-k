# 리소스 테이블 - Effect - Stat-bonus (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Effect
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Effect/리소스 테이블 - Effect - Stat-bonus/content.md

## 한 줄 설명
능력치 보너스 Effect의 5가지 카테고리(Normal, StatIncreaseRate, StatRatedBonus, LevelCheck, GuildSkillLevel)에 대한 설정 방법과 컬럼 정의, 에러 처리 가이드.

## 핵심 용어
- Normal
- StatIncreaseRate
- StatRatedBonus
- LevelCheck
- GuildSkillLevel
- EffectClass 시트
- BonusEnum
- Effect1~5
- Value1~5
- Max
- Resource
- AllAttack
- MaxHp
- MoveSpeedRate
- AllDefence
- BaseLevel
- PerLevel
- MaxLevel
- BaseValue
- GuildSkillType

## 숫자/상수/공식
- MoveSpeedRate 300 = 3% (만분율 기준)
- StatIncreaseRate Value = 500 → 현재 능력치의 5%
- StatIncreaseRate Value = 1000 → 현재 능력치의 10%
- StatRatedBonus 보너스 = (현재 기준 능력치 / Value1) × Value2~5
- StatRatedBonus 예시: MaxHp 100당 AllDefence +10
- Value1은 0보다 커야 함
- PerLevel은 0보다 커야 함

## 참조 시스템
- (없음)

## 주요 섹션
- Normal
- StatIncreaseRate
- StatRatedBonus
- LevelCheck
- GuildSkillLevel
- 트러블슈팅
