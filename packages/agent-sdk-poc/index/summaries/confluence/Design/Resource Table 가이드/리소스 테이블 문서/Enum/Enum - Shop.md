# Enum - Shop (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Shop
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Shop/content.md

## 한 줄 설명
상점 시스템에서 사용되는 구매 횟수 관리 범위(DbEntityEnum)와 초기화 방식(LimitResetTypeEnum)을 정의하는 Enum 가이드.

## 핵심 용어
- DbEntityEnum
- LimitResetTypeEnum
- Character
- Account
- Guild
- Server
- None
- Count
- ResetType
- ResetArg0
- ResetEndTime
- SellLimit
- ResetTimeFromInit
- ResetTimeFromFull
- RoutineTime
- ExactTime
- cron 표현식
- 구매 횟수 초기화
- 타이머

## 숫자/상수/공식
- 3600 (초 단위, 1시간)
- 0 0 * * 1 (cron 표현식 예시: 매주 월요일 00시)
- Count = 5 (예시)

## 참조 시스템
- shared.md

## 주요 섹션
- DbEntityEnum
- LimitResetTypeEnum
- ResetTimeFromInit vs ResetTimeFromFull 차이
- ResetEndTime 공통 동작
