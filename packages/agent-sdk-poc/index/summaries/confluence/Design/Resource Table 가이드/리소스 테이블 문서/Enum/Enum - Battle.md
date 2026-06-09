# Enum - Battle (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Battle
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Battle/content.md

## 한 줄 설명
Project K의 전투 시스템에서 사용되는 Enum 타입들을 정의하며, 조건 판정 대상, 조건 종류, 개체 속성, 팀 속성, 관계 판정 결과를 명시한다.

## 핵심 용어
- BattleEntityEnum
- BattleConditionEnum
- BattleObjectTypeEnum
- BattleTeamTypeEnum
- BattleRelationTypeEnum
- BattleCondition 시트
- BattleObjectTypeRelation 시트
- BattleTeamTypeRelation 시트
- Target 컬럼
- Type 컬럼
- HpPercent
- MpPercent
- Distance
- HasBarrier
- PassivePC
- AggressivePC
- Monster
- PartyMember
- GuildMember
- HostileGuildMember
- PCCompanion
- CrossWorldGuard
- ProtectTower
- Gray팀
- Black팀
- White팀
- Blue팀
- Red팀
- Purple팀
- Hostile
- Friendly
- Neutral

## 숫자/상수/공식
- HpPercent, MpPercent: 만분율 (100% = 10000)
- HasBarrier: 보호막 있음 = 1, 없음 = 0

## 참조 시스템
- BattleCondition 시트
- BattleObjectTypeRelation 시트
- BattleTeamTypeRelation 시트

## 주요 섹션
- BattleEntityEnum
- BattleConditionEnum
- BattleObjectTypeEnum
- BattleTeamTypeEnum
- BattleRelationTypeEnum
