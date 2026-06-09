# 리소스 테이블 - Karma (요약)

> 출처: PK / 리소스 테이블 - Karma
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Karma/content.md

## 한 줄 설명
캐릭터의 성향(카르마) 시스템을 정의하는 테이블로, 성향 타입별 게이지 범위, 적용 버프, PK 패널티, 사망 시 장비 손실 규칙, 상점 비용 배율을 설정한다.

## 핵심 용어
- KarmaTypeEnum
- Karma 시트
- DeathPenalty 시트
- GaugeMin
- GaugeMax
- BuffId
- KillPenaltyBuffId
- DeathPenaltyId
- Murderous
- Exemplary
- Neutral
- Virtuous
- ExpRestoreToDiamond
- FreeExpRestoreCount
- PenaltyRestoreCostRatio
- MerchantCostRatio
- DecreaseRatio
- Prob
- PenaltyCount

## 숫자/상수/공식
- 만분율 기준 (0 = 변동 없음)
- DeathPenalty Prob 합: 정확히 10000
- 스택 수 = max(0, 가해자 레벨 - 피해자 레벨) / 컨텐츠 설정의 레벨당 패널티 기준값 + 1
- 성향치 감소량 = 기본 감소량 × 피해자와의 레벨차 계수 × 피해자 성향치 계수(DecreaseRatio) × 일일 연속킬 계수
- DecreaseRatio 유효 범위: 0 이상

## 참조 시스템
- Buff 테이블
- Karma.xlsx (Karma 시트, DeathPenalty 시트)

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- 새 Karma 행 추가하기
- 새 DeathPenalty 추첨표 추가/수정하기
- 자주 하는 실수
- 트러블슈팅
