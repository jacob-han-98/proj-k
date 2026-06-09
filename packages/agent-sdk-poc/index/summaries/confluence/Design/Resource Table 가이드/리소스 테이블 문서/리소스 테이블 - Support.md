# 리소스 테이블 - Support (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Support/content.md

## 한 줄 설명
서포트 모드에서 자동으로 배정할 시간 던전과 사냥터를 정의하는 리소스 테이블 가이드 문서.

## 핵심 용어
- 서포트 모드
- SupportModeSchedulerEnum
- SupportMode 시트
- SupportModeTimeDungeon 시트
- SupportModeHuntingGround 시트
- 시간 던전
- 사냥터
- 스케줄러 유형
- TimeDungeonId
- WorldId
- TerritoryId
- Land 테이블
- LandTerritory 테이블
- TimeDungeon 테이블
- 권장 전투력
- 자동 배정

## 숫자/상수/공식
- Type: SupportModeSchedulerEnum (s)
- TimeDungeonId: int32 (s)
- Id: int32 (s)
- WorldId: int32 (s)
- TerritoryId: int32 (s)
- 스케줄러 유형: ExpTimeDungeon, GoldTimeDungeon, WeeklyTimeDungeon

## 참조 시스템
- SupportMode.xlsx (SupportMode 시트)
- SupportMode.xlsx (SupportModeTimeDungeon 시트)
- SupportMode.xlsx (SupportModeHuntingGround 시트)
- TimeDungeon 테이블
- Land 테이블
- LandTerritory 테이블

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- 새 서포트 모드 데이터 추가하기
- 자주 하는 실수
- 트러블슈팅
