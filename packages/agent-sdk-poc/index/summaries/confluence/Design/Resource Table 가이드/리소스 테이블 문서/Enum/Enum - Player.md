# Enum - Player (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/Enum
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Player/content.md

## 한 줄 설명
플레이어 시스템(CharacterClass, CharacterLevelUp, CharacterExp, StatClass)에서 사용하는 Enum 정의 및 게임 동작 명세.

## 핵심 용어
- TribeEnum
- NumberTypeEnum
- StatCategoryEnum
- OperationEnum
- CharacterClass
- CharacterLevelUp
- CharacterExp
- StatClass
- Tribe
- ApplyType
- Category
- Operation
- Asha
- Base
- Potential
- Second
- Normal
- Percent
- All
- Odd
- Even
- StatName
- StatValue
- EquipPartsEnum
- UseWeapon
- CharacterClassEnum
- BonusEnum

## 숫자/상수/공식
- 전투력 환산 시 Normal 방식: ×100 보정 적용
- 전투력 환산 시 Percent 방식: 보정 없이 그대로 적용
- StatName1~5, StatValue1~5 (레벨업 보너스 컬럼)

## 참조 시스템
- shared.md (CharacterClassEnum, BonusEnum)
- item.md (EquipPartsEnum)

## 주요 섹션
- TribeEnum
- NumberTypeEnum
- StatCategoryEnum
- OperationEnum
