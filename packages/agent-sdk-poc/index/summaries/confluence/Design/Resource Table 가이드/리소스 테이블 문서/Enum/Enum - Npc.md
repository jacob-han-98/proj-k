# Enum - Npc (요약)

> 출처: Design/Resource Table 가이드/리소스 테이블 문서/Enum
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Npc/content.md

## 한 줄 설명
NPC의 카테고리, 세부 카테고리, 제어 방식, 제어 조건을 정의하는 Enum 모음. NpcClass 테이블의 컬럼 값으로 사용되며 NPC의 동작 방식과 연결 테이블을 결정한다.

## 핵심 용어
- NpcCategoryEnum
- NpcSubCategoryEnum
- NpcControlEnum
- NpcControlConditionEnum
- NpcClass
- Category
- SubCategory
- Dialogue
- Merchant
- Storage
- Speech
- Transport
- Function
- MerchantClass
- FunctionId
- SpeechBubbleId
- Potion
- Skill
- Weapon
- Armor
- Guild
- TalkDialogue
- Named
- Noname
- Captain
- Smuggler
- AttackServer
- ExploreServer
- Achievement
- InfinityTower
- Raid
- Battlefield
- Appear
- Disappear
- RoutineTime
- ExactTime_UTC

## 숫자/상수/공식
- (없음)

## 참조 시스템
- NpcClass 테이블
- MerchantClass 테이블
- Transport 테이블
- shared.md
- PlayerConditionEnum (NpcPrerequisite의 Type 컬럼에서 사용)

## 주요 섹션
- NpcCategoryEnum
- NpcSubCategoryEnum
- NpcControlEnum
- NpcControlConditionEnum
- 관련 Enum (다른 시스템에서 정의)
