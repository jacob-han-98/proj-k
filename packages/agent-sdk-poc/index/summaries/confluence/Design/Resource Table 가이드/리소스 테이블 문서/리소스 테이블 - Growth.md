# 리소스 테이블 - Growth (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Growth/content.md

## 한 줄 설명
타이탄의 유산 시스템의 캐릭터 성장 메커니즘을 정의하는 리소스 테이블 가이드. 부위별 슬롯, 보너스 추첨, 해금 조건, 고정 비용을 관리하는 5개 시트의 구조와 컬럼 정의를 제시한다.

## 핵심 용어
- 타이탄의 유산 (Legacy of Titan)
- 슬롯 (Slot)
- 부위 (Type): LeftEye, RightEye, LeftEar, RightEar, Nose, Mouth, Head
- 단계 (Step)
- 슬롯 인덱스 (SlotIndex)
- 보너스 그룹 (BonusGroup)
- 보너스 (Bonus)
- 보너스 등급 (Grade)
- 해금 조건 (Prerequisite)
- 보너스 고정 (SlotPin)
- 기본 추첨 확률 가중치 (BaseProb)
- 변경된 추첨 확률 가중치 (AdjustProb)
- 능력치 (EffectStat)
- 화폐 (Currency)
- LegacyOfTitanSlot
- LegacyOfTitanBonusGroup
- LegacyOfTitanBonus
- LegacyOfTitanPrerequisite
- LegacyOfTitanSlotPin

## 숫자/상수/공식
- Type/Step/SlotIndex 유효 범위: 0 이상 32767 이하 (int16_t)
- SlotIndex: 같은 Type·Step 묶음 내에서 0부터 연속된 순서로 존재해야 함
- PrerequisiteId = 0: 조건 없이 항상 해금
- 추첨 확률 분모: 같은 그룹(Id) 내 모든 행의 BaseProb 합 (또는 AdjustProb 합)
- 보너스 고정 비용: 추첨 비용 + LegacyOfTitanSlotPin의 등급별 비용

## 참조 시스템
- LegacyOfTitan.xlsx (LegacyOfTitanSlot, LegacyOfTitanPrerequisite, LegacyOfTitanBonusGroup, LegacyOfTitanBonus, LegacyOfTitanSlotPin)
- ContentSetting.xlsx (ContentSetting 시트의 LegacyOfTitanProbChangeItemId/Count)
- PlayerConditionEnum
- CurrencyEnum
- GradeEnum
- BonusEnum
- LegacyOfTitanTypeEnum

## 주요 섹션
- 타이탄의 유산 테이블
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전 (LegacyOfTitanSlot, LegacyOfTitanPrerequisite, LegacyOfTitanBonusGroup, LegacyOfTitanBonus, LegacyOfTitanSlotPin)
- 새 타이탄의 유산 데이터 추가하기
- 자주 하는 실수
- 트러블슈팅
