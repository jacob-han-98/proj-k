# 리소스 테이블 - Seal (요약)

> 출처: Design/Resource Table 가이드/리소스 테이블 문서
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Seal/content.md

## 한 줄 설명
캐릭터 능력치 강화 시스템인 봉인석(Seal Ascension)의 레벨, 재료, 확률, 특수 버프 데이터를 정의하는 리소스 테이블 가이드.

## 핵심 용어
- 봉인석(Seal Ascension)
- 전사(Warrior)
- 수호자(Guardian)
- SealTypeEnum
- SealLevelData
- SealPrerequisite
- SealBuffPool
- 특수 버프(Special Buff)
- 기적 재시도(Miracle Retry)
- 기적 점프(Miracle Jump)
- 버프 풀(Buff Pool)
- 가중 확률(Weighted Probability)
- 누적 능력치 보너스(Cumulative Stat Bonus)
- 재추첨(Reroll)
- PlayerConditionEnum
- BonusEnum
- CurrencyEnum
- BuffPoolId
- SuccessProb
- MiracleRetryProb
- MiracleJumpProb

## 숫자/상수/공식
- SuccessProb: 퍼밀(‰) 단위, 1000 = 100%, 유효 범위 0~1000
- MiracleRetryProb: 퍼밀(‰) 단위, 유효 범위 0~1000
- MiracleJumpProb: 퍼밀(‰) 단위, 유효 범위 0~1000
- 버프 추첨 확률 공식: 개별 Prob / 풀 내 전체 Prob 합
- Level: 1부터 MaxLevel까지, 중복 불가
- MaterialAmount: 0이면 재료 소모 없음
- RerollMaterialAmount: 0이면 재추첨 재료 소모 없음
- CurrencyAmount: 0이면 재화 소모 없음
- BuffPoolId: 0이면 특수 버프 미획득

## 참조 시스템
- 아이템 테이블 (Item)
- 버프 테이블 (Buff)
- 재화 시스템 (Currency)
- 콘텐츠 해금 시스템 (ContentsTypeEnum_Seal)

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전 (Seal, SealPrerequisite, SealLevelData, SealBuffPool)
- 강화 흐름 (일반 강화, 특수 버프 재추첨)
- 자주 하는 실수
- 트러블슈팅
