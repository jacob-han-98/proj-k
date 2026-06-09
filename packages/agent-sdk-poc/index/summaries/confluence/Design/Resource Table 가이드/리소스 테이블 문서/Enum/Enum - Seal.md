# Enum - Seal (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Seal
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Seal/content.md

## 한 줄 설명
Project K의 봉인석(Seal) 시스템에서 사용되는 Enum 정의로, 봉인석 종류와 강화 결과 상태를 구분한다.

## 핵심 용어
- SealTypeEnum
- SealAscensionResult
- Warrior
- Guardian
- Success
- Fail
- MiracleRetrySuccess
- MiracleRetryFail
- JumpSuccess
- InvalidCondition
- NotEnoughMaterial
- MaxLevel
- 봉인석
- 강화
- 레벨
- 능력치
- 버프
- 기적 재시도
- 기적 점프
- BonusEnum
- CurrencyEnum
- PlayerConditionEnum

## 숫자/상수/공식
- Warrior: 0
- Guardian: 1
- Success: 0
- Fail: 1
- MiracleRetrySuccess: 2
- MiracleRetryFail: 3
- JumpSuccess: 4
- InvalidCondition: 5
- NotEnoughMaterial: 6
- MaxLevel: 7
- 일반 강화 성공 시 레벨 +1
- 기적 점프 성공 시 레벨 +2

## 참조 시스템
- Seal 시트
- BonusEnum (EffectStatName01~03에서 사용)
- CurrencyEnum (CurrencyType에서 사용)
- PlayerConditionEnum (SealPrerequisite의 Type에서 사용)

## 주요 섹션
- SealTypeEnum
- SealAscensionResult
- 관련 Enum (다른 시스템에서 정의)
