# 리소스 테이블 - Npc - Merchant (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Npc/리소스 테이블 - Npc - Merchant/content.md

## 한 줄 설명
Project K에서 상점(Merchant) NPC를 리소스 테이블에 정의하고 배치하기 위한 컬럼 설정 및 작성 가이드.

## 핵심 용어
- NpcClass 시트
- Merchant
- SubCategory
- FunctionId
- MerchantClass 테이블
- NpcPrerequisite 시트
- NpcSpawn 시트
- Category
- AssetName
- CollisionRadius
- InteractionRadius
- IsCollision
- NpcId
- Potion
- Skill
- Weapon
- Armor

## 숫자/상수/공식
- CollisionRadius: 50 (예시값)
- InteractionRadius: 300 (예시값)
- FunctionId 예시: 1001, 1002
- NpcClass Id 예시: 100, 101

## 참조 시스템
- MerchantClass 테이블
- NpcClass 시트
- NpcPrerequisite 시트
- NpcSpawn 시트

## 주요 섹션
- 설정할 컬럼
- NpcClass 시트
- NpcPrerequisite 시트 (선택)
- NpcSpawn 시트 (필수)
- 새 상점 NPC 추가하기
- 실제 예시
- 자주 하는 실수
- 트러블슈팅
