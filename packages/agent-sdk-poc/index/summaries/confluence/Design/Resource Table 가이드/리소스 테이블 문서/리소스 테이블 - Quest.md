# 리소스 테이블 - Quest (요약)

> 출처: PK / 리소스 테이블 - Quest
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Quest/content.md

## 한 줄 설명
Project K의 퀘스트 시스템을 정의하는 리소스 테이블 문서로, 퀘스트 기본 정의, 선행 조건, 목표, 보상, 인스턴스 퀘스트, 퀘스트 오브젝트 등 모든 퀘스트 관련 데이터 구조와 컬럼을 명시한다.

## 핵심 용어
- QuestClass
- QuestPrerequisite
- QuestObjective
- QuestReward
- QuestRandomReward
- QuestSelectReward
- QuestCategory
- QuestActivate
- QuestDeactivate
- QuestInstance
- QuestTriggerSpawn
- QuestObjectClass
- QuestObjectSpawn
- QuestAct
- InstanceTrigger
- PlayerConditionEnum
- PlayerObjectiveEnum
- PlayerTriggerEnum
- QuestCategoryEnum
- QuestAcceptEnum
- RewardTypeEnum
- CurrencyEnum
- KillMonster
- CollectItem
- TalkToNpc
- ReachVolume
- ObjectInteraction
- EnteredInWorld
- Cinematic

## 숫자/상수/공식
- MaxAccept: 동시 수락 가능 최대 퀘스트 수 (0 = 제한 없음)
- MaxComplete: 기간 내 최대 완료 횟수
- CandidateCount: 랜덤 배정 시 제시할 퀘스트 후보 수
- MaxRefreshCount: 최대 갱신 횟수
- MaxRechargeCount: 최대 충전 횟수
- InteractionRadius: 상호작용 반경 (플레이어-오브젝트 거리 = 이 값 + 50 이내)
- CollisionRadius: 충돌 반경 (길찾기 이동체 크기)
- Timelimit: 인스턴스 제한 시간 (초)
- Prob: 보상 확률 가중치
- GroupId: 조건/목표 그룹화 (같은 GroupId 내 조건은 AND, 목표는 OR)
- Order: 목표 순서 (중복 불가)

## 참조 시스템
- Quest.xlsx (QuestClass, QuestPrerequisite, QuestObjective, QuestReward, QuestRandomReward, QuestSelectReward, QuestCategory, QuestActivate, QuestDeactivate, QuestInstance, QuestAct)
- QuestObject.xlsx (QuestTriggerSpawn, QuestObjectClass, QuestObjectSpawn)
- Trigger.xlsx (InstanceTrigger)
- 월드/볼륨 테이블
- 몬스터 테이블
- 아이템 테이블
- NPC 테이블
- Cinematic 테이블

## 주요 섹션
- 퀘스트 테이블
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전 (QuestClass, QuestPrerequisite, QuestObjective, QuestReward, QuestRandomReward, QuestSelectReward, QuestCategory, QuestActivate/QuestDeactivate, QuestInstance, QuestTriggerSpawn, QuestObjectClass, QuestObjectSpawn, QuestAct, InstanceTrigger)
- 새 퀘스트 추가하기
- 일일 퀘스트 추가 시 주의사항
- 인스턴스 퀘스트 추가 시
- 자주 하는 실수
- 트러블슈팅
