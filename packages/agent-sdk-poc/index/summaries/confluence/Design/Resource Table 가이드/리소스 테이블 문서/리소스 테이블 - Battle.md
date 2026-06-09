# 리소스 테이블 - Battle (요약)

> 출처: Design/Resource Table 가이드/리소스 테이블 문서
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Battle/content.md

## 한 줄 설명
전투 시 개체 간 관계(적/아군/중립)를 결정하고 스킬·버프 발동 시 상태 조건을 평가하는 Battle 리소스 테이블의 구조, 컬럼 정의, 추가 방법을 명시한 가이드 문서.

## 핵심 용어
- BattleCondition
- BattleObjectTypeRelation
- BattleTeamTypeRelation
- BattleEntityEnum
- BattleConditionEnum
- BattleObjectTypeEnum
- BattleTeamTypeEnum
- BattleRelationTypeEnum
- OperatorEnum
- Self
- Other
- Hostile
- Friendly
- Neutral
- None
- HpPercent
- MpPercent
- Distance
- HasBarrier
- BuffClass
- 관계 판정 우선순위

## 숫자/상수/공식
- HpPercent / MpPercent 유효 범위: 0 ~ 10000 (만분율, 100% = 10000, 50% = 5000)
- Distance: 게임 내 거리 단위 (정수)
- HasBarrier: 1(보호막 있음) 또는 0(보호막 없음)
- 관계 판정 우선순위: 1. 자기 자신(Self) → 2. 팀 속성 관계 → 3. 개체 속성 관계

## 참조 시스템
- BattleCondition.xlsx
- BattleRelation.xlsx
- BuffClass

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전 (BattleCondition, BattleObjectTypeRelation, BattleTeamTypeRelation)
- 새 조건 추가하기
- 새 관계 추가하기
- 실제 예시
- 자주 하는 실수
- 트러블슈팅
