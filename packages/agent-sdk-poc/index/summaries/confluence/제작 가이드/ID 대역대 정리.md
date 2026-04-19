# ID 대역대 정리 (요약)

> 출처: 제작 가이드 / ID 대역대 정리
> 원본: packages/confluence-downloader/output/제작 가이드/ID 대역대 정리/content.md

## 한 줄 설명
Project K에서 사용되는 모든 게임 오브젝트(몬스터, NPC, 퀘스트, 보상 등)의 ID 대역대와 명명 규칙을 정의한 문서.

## 핵심 용어
- ID 대역대
- Reward
- MonsterReward
- QuestReward
- Volume
- MonsterVolume
- NpcVolume
- TeleportVolume
- SpawnVolume
- RespawnVolume
- ObjectVolume
- QuestVolume
- Quest
- QuestClass
- QuestObject
- QuestObjective
- Npc
- NpcClass
- NpcSpawn
- Monster
- MonsterClass
- MonsterSpawn
- 필드 Monster
- 정령의 탑 Monster
- 던전 Monster
- WorldTerritory
- WorldClass
- Effect

## 숫자/상수/공식
- Reward: 8자리
- Volume: 8자리, 범위 10000001~999999999
- Quest: 8자리
  - 메인 퀘스트: 81000000~81999999
  - 서브 퀘스트: 82000000~82999999
  - 주간 퀘스트: 83000000~83999999
  - 일간 퀘스트: 84000000~84999999
- QuestObject: 8자리, 범위 70000000~79999999
- Npc: 8자리
  - 퀘스트 Npc: 30000000~30999999
  - 상인 및 기능 Npc: 31000000~31999999
- Monster: 6자리 또는 8자리
  - 필드 Monster: 6자리, 범위 10000~999999
  - 정령의 탑 Monster: 8자리, 범위 10000000~10099999
  - 던전 Monster: 8자리, 범위 20000000~20099999
- QuestObject Volume ID 규칙: QuestObject ID 1단위를 0~9까지 사용

## 참조 시스템
- (없음)

## 주요 섹션
- ID 대역대 정리 (표)
- 몬스터 볼륨 ID 규칙
- Quest ID 규칙
- Quest Volume ID 규칙
- QuestObject ID 규칙
- QuestObject Volume ID 규칙
- Npc ID 규칙
- Monster ID 규칙
