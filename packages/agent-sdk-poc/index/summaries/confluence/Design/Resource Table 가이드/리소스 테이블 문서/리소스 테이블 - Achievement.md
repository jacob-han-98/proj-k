# 리소스 테이블 - Achievement (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Achievement/content.md

## 한 줄 설명
플레이어의 다양한 활동(레벨 달성, 강화 시도, 몬스터 처치 등)을 추적하고 목표 달성 시 보상을 지급하는 업적 시스템의 리소스 테이블 정의 문서.

## 핵심 용어
- Achievement (업적)
- AchievementProgressType (업적 진행 조건)
- AchievementTypeEnum (업적 진행 조건 종류)
- AchievementCategoryEnum (업적 분류 카테고리)
- AchievementGroup (업적 그룹)
- AchievementReward (업적 보상)
- RewardTypeEnum (보상 종류)
- ProgressTypeId (진행 조건 참조 ID)
- RewardId (보상 참조 ID)
- Count (목표 횟수)
- AllowOverflowSave (목표 초과 달성 저장 여부)
- FixedAmount (고정 수량 여부)
- AmountMin (보상 최소 수량)
- AmountMax (보상 최대 수량)
- Prob (확률 가중치)
- Arg0, Arg1, Arg2 (추가 조건 파라미터)
- Category (카테고리)
- ItemId (아이템 ID)

## 숫자/상수/공식
- Id: int32 (1 이상의 정수)
- Count: int32 (1 이상의 정수)
- Prob: int32 (1 이상의 정수)
- AmountMin: int32 (0 이상의 정수)
- AmountMax: int32 (AmountMin 이상의 정수)
- RewardId: 0 또는 유효한 AchievementReward.Id
- 같은 Id의 보상이 여러 개일 때: 각 행의 Prob 값에 비례하여 확률 결정
- FixedAmount=true: AmountMin 값이 고정 지급량
- FixedAmount=false: AmountMin~AmountMax 범위에서 랜덤 결정

## 참조 시스템
- 아이템 테이블 (ItemId 참조)
- AchievementTypeEnum (Type 값 정의)
- AchievementCategoryEnum (Category 값 정의)
- RewardTypeEnum (RewardType 값 정의)

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- AchievementProgressType 시트
- Achievement 시트
- AchievementReward 시트
- 새 업적 추가하기
- 단계별 업적 예시
- 자주 하는 실수
- 트러블슈팅
