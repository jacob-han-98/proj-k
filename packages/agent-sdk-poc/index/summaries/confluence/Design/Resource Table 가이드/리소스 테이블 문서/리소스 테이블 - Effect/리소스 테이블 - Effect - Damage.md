# 리소스 테이블 - Effect - Damage (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Effect/리소스 테이블 - Effect - Damage/content.md

## 한 줄 설명
Project K의 데미지 Effect 리소스 테이블 설정 가이드로, StatRatedDamage, StackDamage, OpponentStatRatedDamage, ConditionDamage 4가지 카테고리의 데미지 계산 방식과 컬럼 설정 방법을 정의한다.

## 핵심 용어
- StatRatedDamage
- StackDamage
- OpponentStatRatedDamage
- ConditionDamage
- EffectClass 시트
- Category
- Effect/Value 슬롯
- BonusEnum
- BaseValue
- RatioPerStack
- ValuePerStack
- MaxStat
- AddDamage
- Condition
- Resource
- 능력치 비율
- 버프 중첩
- 시각 효과 에셋
- BattleCondition 테이블
- integrity check

## 숫자/상수/공식
- StackDamage 최종 데미지 = BaseValue + (BaseValue × RatioPerStack × (중첩수 - 1)) + (ValuePerStack × (중첩수 - 1))
- OpponentStatRatedDamage 추가 데미지 = (min(상대 능력치, MaxStat) / Value1) × AddDamage
- StackDamage 예시: Id 500, BaseValue 100, ValuePerStack 50 → 1중첩 100, 2중첩 150, 3중첩 200

## 참조 시스템
- BattleCondition 테이블

## 주요 섹션
- StatRatedDamage
- StackDamage
- OpponentStatRatedDamage
- ConditionDamage
- 트러블슈팅
