# Enum - Achievement (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/Enum
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Achievement/content.md

## 한 줄 설명
Project K의 업적 시스템에서 사용되는 카테고리, 진행 조건 타입, 보상 타입 Enum을 정의하는 문서.

## 핵심 용어
- AchievementCategoryEnum
- AchievementTypeEnum
- RewardTypeEnum
- Level
- Growth
- Item
- Currency
- Adventure
- Combat
- CategoryLevelPoint
- CategoryGrowthPoint
- CategoryItemPoint
- CategoryCurrencyPoint
- CategoryAdventurePoint
- CategoryCombatPoint
- LevelAttainment
- EnchantTrial
- EnchantAttainment
- EnchantFail
- DismantleTrial
- CurrencyConsumption
- ObtainMetamorph
- ComposeMetamorph
- ObtainPet
- ComposePet
- ClearQuest
- ClearQuestId
- GuildDonation
- KillMonsterType
- KillMonsterDungeon
- KillMonsterId
- AchievementPoint
- GradeEnum
- EquipTypeEnum
- CurrencyEnum
- QuestCategoryEnum
- MonsterTypeEnum

## 숫자/상수/공식
- 카테고리 포인트 진행 방식: 설정 (현재 포인트 값으로 덮어쓰기)
- 레벨 진행 방식: 설정 (현재 레벨 값으로 덮어쓰기)
- EnchantTrial: 저주 강화 제외, 시도 시마다 1 증가
- EnchantAttainment: 성공 시 1 증가, 실패/저주 강화 제외
- EnchantFail: 실패 시 1 증가
- DismantleTrial: 분해 시 1 증가 (장비만)
- CurrencyConsumption: 소비량만큼 증가
- ObtainMetamorph/ObtainPet: 획득 수만큼 증가
- ComposeMetamorph/ComposePet: 합성 수만큼 증가
- ClearQuest: 완료 시 1 증가
- GuildDonation: 기부 횟수만큼 증가
- KillMonster 계열: 처치 시 1 증가

## 참조 시스템
- Achievement 시트
- AchievementProgressType 시트
- shared.md

## 주요 섹션
- AchievementCategoryEnum
- AchievementTypeEnum
- 카테고리 포인트 계열
- 레벨 계열
- 강화 계열
- 분해 계열
- 재화 계열
- 변신/펫 계열
- 퀘스트 계열
- 길드 계열
- 몬스터 처치 계열
- RewardTypeEnum
