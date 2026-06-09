# 리소스 테이블 - Buff (요약)

> 출처: Design/Resource Table 가이드/리소스 테이블 문서
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Buff/content.md

## 한 줄 설명
캐릭터, 몬스터 등에 적용되는 버프/디버프의 지속 시간, 적용 확률, 중첩 규칙, 조건부 발동을 정의하는 테이블 가이드.

## 핵심 용어
- BuffClass
- BuffOverlapRule
- BuffType (Good, Bad)
- CcType (Stun, Hold, Silence, Pull, Push, Slow, Stiff, Burn, Frostbite, Freeze, PotionSeal)
- OverlapRule
- Duration
- MaxDuration
- RandomDurationInterval
- TargetType
- EffectId
- ConditionType
- ConditionProb
- ConditionTarget (Self, Opponent)
- ConditionBuffId
- ConditionCoolTime
- BattleConditionId
- IntervalDuration
- MaxStack
- IsRemainOnDead
- PartyNotify
- IsSave
- Prob
- Channel
- Grade
- MaxCount
- IgnoreSameRule

## 숫자/상수/공식
- Duration: 양수(ms 단위 지속), 0(즉시 효과), 음수(무한 지속)
- IntervalDuration: 1000의 배수 (초 단위)
- MaxDuration ≥ Duration
- RandomDurationInterval > 0 이고 ≤ (MaxDuration - Duration)
- MaxStack: 0 이상 (0 = 중첩 불가)

## 참조 시스템
- Skill 테이블
- Effect 테이블
- BattleCondition 테이블
- Buff.xlsx (BuffClass 시트, BuffOverlapRule 시트)

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전 — BuffClass
- 전체 컬럼 사전 — BuffOverlapRule
- 새 버프 추가하기
- 조건부 발동 버프 설정 방법
- 주기적 효과 버프 설정 방법
- 랜덤 지속 시간 버프 설정 방법
- 자주 하는 실수
- 트러블슈팅
