# Enum - Trigger (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Trigger
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Trigger/content.md

## 한 줄 설명
Project K의 트리거 시스템에서 사용되는 조건, 액션, 범위 Enum을 정의하는 문서. TriggerCondition 및 TriggerAction 시트의 Type 컬럼에서 참조되는 열거형 값들을 명시한다.

## 핵심 용어
- TriggerEnum
- TriggerActionEnum
- ScopeEnum
- TriggerCondition
- TriggerAction
- KillMonster
- KillSpawnVolume
- ReachVolume
- QuestGroupProgressing
- QuestObjectiveComplete
- QuestComplete
- TimeElapsed
- SpawnMonster
- InstanceEnter
- InstanceOut
- DungeonComplete
- SpawnNpc
- DespawnNpc
- Personal
- Instance
- ConditionScope

## 숫자/상수/공식
- Arg0, Arg1, Arg2 (트리거 파라미터 3개)
- 0 (무시/기본값 판정 기준)
- 1회 (ReachVolume, QuestObjectiveComplete, TimeElapsed 충족 조건)

## 참조 시스템
- TriggerCondition 시트
- TriggerAction 시트
- QuestInstanceSpawn 데이터

## 주요 섹션
- TriggerEnum
- TriggerActionEnum
- ScopeEnum
