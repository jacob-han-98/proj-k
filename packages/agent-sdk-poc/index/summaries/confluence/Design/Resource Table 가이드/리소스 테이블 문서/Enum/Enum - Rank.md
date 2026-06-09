# Enum - Rank (요약)

> 출처: Confluence / PK / Enum - Rank
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Rank/content.md

## 한 줄 설명
Project K의 랭킹 시스템에서 사용되는 Enum을 정의하며, 랭킹 종류(RankTypeEnum), 집계 범위(RankScopeEnum), 동점 처리 순서(RankOrderEnum)를 규정한다.

## 핵심 용어
- RankTypeEnum
- RankScopeEnum
- RankOrderEnum
- PlayerCombatPoint
- GuildCombatPoint
- InfiniteTower
- CharacterWorldEvent
- GuildWorldEvent
- GuildRaid
- PrerequisiteId
- RankPlayerPrerequisite
- World
- WorldGroup
- Global
- Ascending
- Descending
- PlayerConditionEnum
- GuildConditionEnum

## 숫자/상수/공식
- PrerequisiteId = 0 (조건 없음)
- GuildRaid는 점수만 사용, 동점자 간 시간 구분 없음

## 참조 시스템
- RankPlayerPrerequisite 시트

## 주요 섹션
- RankTypeEnum
- RankScopeEnum
- RankOrderEnum
- 참조: 다른 시스템 Enum
