# 리소스 테이블 - Dungeon (요약)

> 출처: Design/Resource Table 가이드/리소스 테이블 문서
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Dungeon/content.md

## 한 줄 설명
Project K의 던전 시스템(무한의 탑, 시간 던전, 공허의 균열)을 정의하는 리소스 테이블 명세서. 각 던전 유형의 데이터 구조, 컬럼 정의, 제약 조건, 참조 관계를 상세히 기술한다.

## 핵심 용어
- 무한의 탑 (InfiniteTower)
- 시간 던전 (TimeDungeon)
- 공허의 균열 (VoidRift)
- InfiniteTowerFloor
- InfiniteTowerSpawn
- InfiniteTowerRank
- TimeDungeonLevel
- TimeDungeonPrerequisite
- VoidRiftDungeon
- VoidRiftReward
- 시즌 (Season)
- 층 (Floor)
- 난이도 (Level)
- 입장 조건 (Prerequisite)
- 보상 (Reward)
- 웨이브 (Wave)
- 랭킹 (Ranking)
- 버프 (Buff)
- 월드/맵 (Land/World)
- 몬스터 (Monster)

## 숫자/상수/공식
- 무한의 탑 층 범위: 1 ~ 511
- 동료 클래스 최대 개수: 3개
- 버프 보상 그룹 최대 개수: 3개
- 시즌 간 최소 버퍼 시간: 10분 (보상 지연 시간 + 10분)
- 공허의 균열 확률 가중치 기준: 1,000,000 (백만)
- 층 ID 연속성 요구: 1부터 N까지 빠짐없이 연속

## 참조 시스템
- InfiniteTower.xlsx
- Dungeon.xlsx
- SupportMode.xlsx
- VoidRift.xlsx
- Land 테이블
- Monster 테이블
- Item 테이블
- Quest 테이블
- Trigger 테이블
- Buff 테이블
- MailTemplate 테이블
- Ranking 시스템
- RewardResource
- PlayerConditionEnum
- DungeonTypeEnum
- ContentResetTypeEnum
- InfiniteTowerClearTypeEnum
- VoidRiftDungeonTypeEnum
- RewardTypeEnum
- CurrencyEnum
- SupportModeSchedulerEnum

## 주요 섹션
- 던전 테이블 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전 (InfiniteTower, InfiniteTowerFloor, InfiniteTowerSpawn, InfiniteTowerRank, InfiniteTowerRankReward, InfiniteTowerFloorReward, InfiniteTowerBuffGroup, InfiniteTowerScene, TimeDungeon, TimeDungeonLevel, TimeDungeonPrerequisite, SupportModeTimeDungeon, VoidRiftDungeon, VoidRiftPrerequisite, VoidRiftReward)
- How-to (새 시즌/층/던전/난이도/공허의 균열 추가 방법)
- 자주 하는 실수
- 트러블슈팅
