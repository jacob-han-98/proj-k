# NpcClass (요약)

> 출처: PK_퀘스트_서브퀘스트 / NpcClass
> 원본: packages/xlsx-extractor/output/8_Contents/PK_퀘스트_서브퀘스트/NpcClass/_final/content.md

## 한 줄 설명
게임 내 NPC의 클래스, 카테고리, 기능, 상호작용 반경 등을 정의하는 마스터 데이터 시트.

## 핵심 용어
- NpcClass
- Id
- Category
- SubCategory
- Merchant
- Potion
- Scroll
- Skill
- Weapon
- Armor
- Storage
- Transport
- Captain
- Function
- ExploreServer
- Dialogue
- TalkDialogue
- Quest
- FunctionId
- CollisionRadius
- InteractionRadius
- ReactionRadius
- SpeechBubbleId
- OtherServerSpeechBubbleId
- LocalServer
- AssetName
- TextKeyTitle

## 숫자/상수/공식
- CollisionRadius: 50
- InteractionRadius: 250
- ReactionRadius: 350
- FunctionLimit 기본값: AllServer
- ReactionRadius 기본값: true
- Id 범위: 1~206, 30990001~30990003, 10005~10009

## 참조 시스템
- (없음)

## 주요 섹션
- NPC 클래스 정의 (테이블)
- 오스트하펜 상인 NPC (물약, 주문서, 박스, 스킬북, 무기, 방어구, 창고, 길드)
- 오스트하펜 기능 NPC (선장, 차원 이동 관리인)
- 엘바네스 상인 NPC (물약, 주문서, 장비, 방어구, 창고, 스킬북, 길드)
- 엘바네스 기능 NPC (차원 이동 관리인)
- 사그라진성터 상인 NPC (물약, 무기, 방어구)
- 퀘스트 대화 NPC (아비시, 상인자크, 경사대원은조, 경사대위무언, 노예순, 노예유안)
