# 리소스 테이블 - Shop (요약)

> 출처: Design/Resource Table 가이드/리소스 테이블 문서
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Shop/content.md

## 한 줄 설명
NPC 상점에서 판매하는 상품을 정의하는 시스템으로, 상품 목록, 구매 조건, 구매 횟수 제한을 설정할 수 있다.

## 핵심 용어
- SellItem
- SellPrerequisite
- SellLimit
- Merchant.xlsx
- ProductId
- ItemId
- Currency
- CurrencyAmount
- PlayerConditionEnum
- LimitResetTypeEnum
- DbEntityEnum
- LimitType
- ResetType
- ResetArg0
- ResetEndTime
- MerchantNPC
- Id (상점 그룹)
- ItemAmount
- GroupId
- Count
- GuildFund
- RoutineTime
- ExactTime
- ResetTimeFromInit
- ResetTimeFromFull

## 숫자/상수/공식
- ItemAmount × 구매 수량 = 총 지급 아이템 수
- CurrencyAmount × 구매 수량 = 총 차감 화폐
- int32 범위 초과 시 구매 실패
- Count: 1 이상의 정수 (최대 구매 가능 횟수)
- ResetArg0 (ResetTimeFromInit/ResetTimeFromFull): 양의 정수 초
- ResetArg0 (RoutineTime): cron 표현식 (초 단위 6필드)
- ResetArg0 (ExactTime): YYYY-MM-DD hh:mm:ss 형식
- ResetEndTime: YYYY-MM-DD hh:mm:ss 형식 (비우면 영구 반복)

## 참조 시스템
- Item 테이블
- CurrencyEnum
- PlayerConditionEnum
- LimitResetTypeEnum
- DbEntityEnum

## 주요 섹션
- 상점(Merchant) 테이블
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- SellItem 시트
- SellPrerequisite 시트
- SellLimit 시트
- 새 상점 상품 추가하기
- 실제 예시
- 자주 하는 실수
- 트러블슈팅
