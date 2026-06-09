# Enum - Item (요약)

> 출처: Confluence / PK / Enum - Item
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/Enum/Enum - Item/content.md

## 한 줄 설명
Project K의 아이템 시스템에서 사용되는 Enum 정의 모음. 아이템 타입, 소비 효과, 강화 재료, 장비 부위 등을 분류하는 열거형 값들을 명시한다.

## 핵심 용어
- ItemTypeEnum
- ItemType
- Equip
- Consume
- Material
- Quest
- Dummy
- Guild
- ConsumeTypeEnum
- ConsumeType
- Potion
- Cook
- RechargeTime
- Teleport
- ItemRandomBox
- ItemChoiceBox
- SkillBook
- TeleportTown
- AddKarma
- SlayerClear
- TeleportRandom
- TimedAccess
- ExtendOfflineCharacterSlot
- EtcTypeEnum
- EtcType
- EnchantWeapon
- BlessedEnchantWeapon
- CursedEnchantWeapon
- EnchantArmor
- BlessedEnchantArmor
- CursedEnchantArmor
- EnchantAccessory
- BlessedEnchantAccessory
- CursedEnchantAccessory
- GuildCraftingAccel
- SkillEnchant
- CraftMaterial
- EnchantHolyRelic
- BlessedEnchantHolyRelic
- CursedEnchantHolyRelic
- MonsterParts
- EquipTypeEnum
- EquipType
- Weapon
- Armor
- Accessory
- HolyRelic
- EquipPartsEnum
- EquipParts
- SwordShield
- GreatSword
- Bow
- Staff
- Orb
- Crossbow
- Helmet
- Shirt
- Jacket
- Gloves
- Pants
- Shoes
- Cloak
- Earring
- Belt
- Ring
- Necklace
- Brooch
- Pendant
- Bracelet
- Talisman
- Armband
- Crest
- Badge
- Epaulette
- EtcTypeCategoryEnum
- Normal
- Blessed
- Cursed
- MarketItemCategoryEnum
- MarketCategory
- EtcEquip
- Consumable
- CraftCategoryEnum
- CraftCategory
- Favorite

## 숫자/상수/공식
- RechargeTime: Value02는 초 단위, 1초 이상 필수
- TimedAccess: Value02는 일 단위, 1일 이상 필수
- BlessedEnchant 성공 시: +1~3 (가중 확률)
- CursedEnchant: 항상 성공, 강화 수치 -1

## 참조 시스템
- ItemEquipClass 시트
- ItemConsumeClass 시트
- ItemEtcClass 시트
- BuffId 테이블
- ItemReward 테이블
- ItemSelect 테이블
- ItemBoxId
- TimedAccessEnum
- GradeEnum
- AttackTypeEnum
- CharacterClassEnum
- BonusEnum
- CurrencyEnum

## 주요 섹션
- ItemTypeEnum
- ConsumeTypeEnum
- EtcTypeEnum
- EquipTypeEnum
- EquipPartsEnum
- EtcTypeCategoryEnum
- MarketItemCategoryEnum
- CraftCategoryEnum
- 공유 Enum 참조
