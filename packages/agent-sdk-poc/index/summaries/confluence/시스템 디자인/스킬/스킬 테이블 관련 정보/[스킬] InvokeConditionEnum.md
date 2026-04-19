# [스킬] InvokeConditionEnum (요약)

> 출처: Confluence / 스킬 테이블 관련 정보
> 원본: packages/confluence-downloader/output/시스템 디자인/스킬/스킬 테이블 관련 정보/[스킬] InvokeConditionEnum/content.md

## 한 줄 설명
BuffClass의 ConditionType 필드에 입력되는 스킬/버프 발동 조건 열거형(Enum) 정의 및 각 조건의 작동 방식 설명.

## 핵심 용어
- InvokeConditionEnum
- BuffClass
- ConditionType
- OnAllAttack
- OnAllDamage
- Periodically
- HpBelowPercent
- OnAllHit
- OnAttackHit
- OnSkillHit
- OnCritical
- OnEndBuff
- OnHpDropsBelowPercent
- OnLethalDamage
- OnBuffStack
- OnGuard
- OnKill
- OnKillMonster
- OnKillPlayer

## 숫자/상수/공식
- None: 0
- OnAllAttack: 1
- OnAllDamage: 2
- Periodically: 3
- HpBelowPercent: 4
- OnAllHit: 5
- OnAttackHit: 6
- OnSkillHit: 7
- OnCritical: 8
- OnEndBuff: 9
- OnHpDropsBelowPercent: 10
- OnLethalDamage: 11
- OnBuffStack: 12
- OnGuard: 13
- OnKill: 14
- OnKillMonster: 15
- OnKillPlayer: 16

## 참조 시스템
- 발동 조건 작동 방식 기획서 (https://bighitcorp.atlassian.net/wiki/x/5AU1CAE)
- OnEndBuff 관련 기획서 (https://bighitcorp.atlassian.net/wiki/x/AYCFCAE)
- OnLethalDamage 관련 기획서 (https://bighitcorp.atlassian.net/wiki/x/RgCOCAE)
- OnBuffStack 관련 기획서 (https://bighitcorp.atlassian.net/wiki/x/AQD5DQE)
- OnGuard, OnKill, OnKillMonster, OnKillPlayer 관련 기획서 (https://bighitcorp.atlassian.net/wiki/x/MoBZEgE)

## 주요 섹션
- InvokeConditionEnum 열거형 정의 및 설명
