# 리소스 테이블 - Npc (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Npc/content.md

## 한 줄 설명
NPC(Non-Player Character)의 정의, 스폰 위치, 출현 조건, 상호작용 정보를 관리하는 시스템으로, 카테고리별로 상점, 창고, 이동 등 다양한 기능을 연결한다.

## 핵심 용어
- NPC (Non-Player Character)
- NpcClass
- NpcSpawn
- NpcPrerequisite
- NpcInteraction
- NpcAppear
- Category (Merchant, Storage, Transport, Dialogue, Speech, Function)
- SubCategory
- FunctionId
- CollisionRadius
- InteractionRadius
- IsCollision
- AssetName
- TextKeyTitle
- WorldId
- VolumeId
- PlayerConditionEnum
- NpcCategoryEnum
- NpcSubCategoryEnum
- NpcControlEnum
- NpcControlConditionEnum
- MerchantClass
- Transport
- SpeechBubbleClass

## 숫자/상수/공식
- InteractionRadius 판정: 실제 판정 시 +50 여유 추가
- CollisionRadius: 0 이상 유효
- InteractionRadius: 0 이상 유효

## 참조 시스템
- MerchantClass (Merchant 카테고리 FunctionId 참조)
- Transport (Transport 카테고리 FunctionId 참조)
- WorldClass (NpcSpawn.WorldId 참조)
- LandVolume (NpcSpawn.VolumeId 참조)
- SpeechBubbleClass (SpeechBubbleId, OtherServerSpeechBubbleId 참조)
- PlayerConditionEnum (NpcPrerequisite.Type 참조)

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 카테고리 페이지 매핑
- 카테고리별 컬럼 사용 매트릭스
- NpcClass 시트 전체 컬럼 사전
- NpcPrerequisite 시트 전체 컬럼 사전
- NpcSpawn 시트 전체 컬럼 사전
- NpcInteraction 시트 (c 전용)
- NpcAppear 시트 전체 컬럼 사전
