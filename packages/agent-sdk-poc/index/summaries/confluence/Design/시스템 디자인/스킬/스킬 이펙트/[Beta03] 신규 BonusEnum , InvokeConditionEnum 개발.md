# [Beta03] 신규 BonusEnum , InvokeConditionEnum 개발 (요약)

> 출처: Confluence / Design/시스템 디자인/스킬/스킬 이펙트
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/스킬/스킬 이펙트/[Beta03] 신규 BonusEnum , InvokeConditionEnum 개발/content.md

## 한 줄 설명
Beta03 단계에서 클래스 스킬(가디언)에 적용할 신규 BonusEnum 4종과 InvokeConditionEnum 1종의 개발 요청 및 명세를 정의한 문서.

## 핵심 용어
- BonusEnum
- InvokeConditionEnum
- DamageRateRecoveryHP
- MaxHPRateRecoveryHP
- DamageRateAddDamage
- MaxHPRateBarrierHP
- OnHitPlayer
- EffectCategoryEnum
- BarrierAbsorbRate
- 클래스 가디언
- 디펜시브 스탠스
- 라스트 원 스탠딩
- 펄스 임팩트
- 리플렉트 실드
- 데드 사일런스
- 만분율
- 보호막
- 피해 반사
- 조건부 피니시 스킬

## 숫자/상수/공식
- Value == 10000 (100%, 만분율)
- 디펜시브 스탠스: 막기 성공 시 생명력 소량 회복
- 라스트 원 스탠딩: 즉시 시전자 HP 20% 회복 / 3초간 모든 CC 면역
- 펄스 임팩트: 단일 적에게 대미지 3회 부여
- 펄스 임팩트 피니시 기믹(검토 중): 피격자 CurrentHP가 MaxHP의 30% 이하일 시 각 타당 스킬 대미지 300% 증가
- 데드 사일런스: 단일 적에게 대미지 1회 부여, n초간 상대가 받는 피해 대폭 증가

## 참조 시스템
- (없음)

## 주요 섹션
- 기획 목적
- 문서관리 참고
- 신규 BonusEnum
- 신규 InvokeConditionEnum
