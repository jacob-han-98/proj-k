# NpcClass (요약)

> 출처: PK_퀘스트_서브퀘스트 / NpcClass
> 원본: packages/xlsx-extractor/output/8_Contents/PK_퀘스트_서브퀘스트/NpcClass/_final/content.md

## 한 줄 설명
Project K의 모든 NPC 및 적 캐릭터의 분류 체계, 리소스 매핑, AI 타입, 영역 배치를 정의하는 마스터 테이블.

## 핵심 용어
- EnemyCharacterID
- TerritoryNpc
- FieldBoss
- RaidBoss
- EnemyAIType
- EnemyClassType
- EnemyClassDetailTag
- EnemyCharacterGroupTag
- EnemyGroupTag
- ResourceName
- SysTerritoryFile_Town
- SysTerritoryFile_Village
- SysTerritoryFile_Field
- SysTerritoryFile_Quest
- NpcLivingCityZone_Interface
- NpcLivingCityZone_Citizen
- Npc_Village
- Npc_Citizen
- GuildBPR_Battle_Goblin
- GuildBPR_Battle_Skeleton
- GuildBPR_Daily_Male1
- StoryNpc
- FunctionNpc
- MonsterBookID
- CounterAttackType
- TerritoryRange
- StayType

## 숫자/상수/공식
- ID 범위: 1~7 (도시/마을 기본 NPC)
- ID 범위: 10~250 (영지/공성/가이드 NPC)
- ID 범위: 1000~1104 (시민/퀘스트 NPC)
- ID 범위: 10001~11201 (환경 동물)
- ID 범위: 15001~15002 (장식물)
- ID 범위: 20001~20503 (전투형 일반 몬스터)
- ID 범위: 25001~25401 (전투형 두목급)
- ID 범위: 30001~30301 (고급 몬스터)
- ID 범위: 50001~50020 (일상 주민 NPC)
- ID 범위: 60001~70003 (필드/레이드 보스)
- ID 범위: 80001~80005 (주요 스토리 NPC)
- ID 범위: 90001~90007 (상인/기능 NPC)
- ID 범위: 100001~100007 (B1 지역 NPC)
- ID 범위: 110001~110005 (B1_02 지역 NPC)
- TerritoryRange 값: 0 (대부분의 기본 NPC)

## 참조 시스템
- (없음)

## 주요 섹션
- NPC 클래스 정의 테이블 (ID 1~250)
- NPC 클래스 테이블 (ID 1000번대~)
- 우측 확장 컬럼 (보이는 범위)
- NpcClass 테이블 (계속)
- 전투 NPC 영역 후반 ~ 기능 NPC
- 상단 중복 영역
- 신규 데이터 행 (ID 90006 이후~)
- 하단 영역 - 새로운 ID 범위
- 최하단 행들 (110xxx 범위)
