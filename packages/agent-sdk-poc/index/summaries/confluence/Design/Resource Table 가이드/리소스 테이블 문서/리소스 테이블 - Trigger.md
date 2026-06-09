# 리소스 테이블 - Trigger (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Trigger/content.md

## 한 줄 설명
특정 조건 충족 시 자동으로 동작을 실행하는 트리거 시스템을 정의하는 리소스 테이블 가이드. Trigger, TriggerCondition, TriggerAction 세 시트로 구성되며 던전, 퀘스트 인스턴스에서 몬스터 스폰, 인스턴스 이동, NPC 등장 등을 제어한다.

## 핵심 용어
- Trigger
- TriggerCondition
- TriggerAction
- GroupId
- TriggerActionId
- GroupLogic
- SequentialAction
- ActionDelayTime
- ConditionScope
- TriggerEnum
- TriggerActionEnum
- OperatorEnum
- ScopeEnum
- Id
- Type
- Arg0
- Arg1
- Arg2
- KillMonster
- SpawnMonster
- SpawnNpc
- DespawnNpc
- QuestInstanceSpawn
- Volume

## 숫자/상수/공식
- ActionDelayTime: 밀리초 단위, 0 이상
- GroupLogic 유효 값: And (기본값/None 포함), Or
- SequentialAction 유효 값: false (기본값, 동시 실행), true (순차 실행)
- ConditionScope 유효 값: None, Personal, Instance
- KillMonster 조건의 Arg1(처치 수): 1 이상 필수

## 참조 시스템
- Trigger.xlsx (Trigger 시트)
- Trigger.xlsx (TriggerCondition 시트)
- Trigger.xlsx (TriggerAction 시트)
- QuestInstanceSpawn
- QuestInstance
- Npc
- Monster
- Quest

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- Trigger 시트
- TriggerCondition 시트
- TriggerAction 시트
- 새 트리거 추가하기
- 자주 하는 실수
- 트러블슈팅
