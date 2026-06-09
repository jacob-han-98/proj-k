# 리소스 테이블 - Rank (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Rank/content.md

## 한 줄 설명
플레이어 또는 길드의 점수를 기록하고 순위를 매기는 랭킹 시스템을 정의하는 리소스 테이블 가이드. 랭킹 종류(Type), 집계 범위(Scope), 참가 조건 등을 설정하여 다양한 랭킹(전투력, 무한의 탑, 월드 이벤트, 길드 레이드 등)을 구성한다.

## 핵심 용어
- Rank (랭킹)
- RankTypeEnum
- PlayerCombatPoint
- GuildCombatPoint
- InfiniteTower
- CharacterWorldEvent
- GuildWorldEvent
- GuildRaid
- RankScopeEnum
- World
- WorldGroup
- Global
- RankOrderEnum
- Ascending
- Descending
- MaxBoardSize
- TimeResolution
- PrerequisiteId
- RankPlayerPrerequisite
- RankGuildPrerequisite
- PlayerConditionEnum
- GuildConditionEnum
- GroupId
- BoardRefreshInterval
- EntityUpdateInterval

## 숫자/상수/공식
- MaxBoardSize: 1 이상 (필수)
- TimeResolution: 1 이상 (초 단위, 필수)
- PrerequisiteId: 0 또는 양의 정수 (0이면 조건 없음)
- 동점자 처리: 시간 반영 (GuildRaid 제외) 또는 점수만 사용 (GuildRaid)

## 참조 시스템
- Rank.xlsx (Rank 시트)
- Rank.xlsx (RankPlayerPrerequisite 시트)
- Rank.xlsx (RankGuildPrerequisite 시트)
- PlayerConditionEnum
- GuildConditionEnum

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전 (Rank 시트, RankPlayerPrerequisite 시트, RankGuildPrerequisite 시트)
- 새 랭킹 추가하기
- 자주 하는 실수
- 트러블슈팅
