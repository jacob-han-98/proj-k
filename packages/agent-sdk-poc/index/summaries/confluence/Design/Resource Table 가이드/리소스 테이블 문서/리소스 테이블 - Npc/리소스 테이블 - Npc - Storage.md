# 리소스 테이블 - Npc - Storage (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Npc/리소스 테이블 - Npc - Storage/content.md

## 한 줄 설명
Project K에서 창고(Storage) NPC를 리소스 테이블에 설정하는 방법과 필수 컬럼, 스폰 배치 절차를 정의한다.

## 핵심 용어
- Storage
- NPC
- NpcClass
- NpcSpawn
- NpcPrerequisite
- Category
- SubCategory
- AssetName
- Id
- FunctionId
- CollisionRadius
- InteractionRadius
- IsCollision
- 창고 NPC
- 상호작용 거리
- 인벤토리
- 플레이어

## 숫자/상수/공식
- CollisionRadius: 50 (예시값)
- InteractionRadius: 300 (예시값)
- FunctionId: 0 (창고 NPC는 사용하지 않음)
- Id: 200 (예시값)

## 참조 시스템
- NpcClass 시트
- NpcPrerequisite 시트
- NpcSpawn 시트

## 주요 섹션
- 설정할 컬럼
- 새 창고 NPC 추가하기
- 실제 예시
- 기능 설명
- 자주 하는 실수
- 트러블슈팅
