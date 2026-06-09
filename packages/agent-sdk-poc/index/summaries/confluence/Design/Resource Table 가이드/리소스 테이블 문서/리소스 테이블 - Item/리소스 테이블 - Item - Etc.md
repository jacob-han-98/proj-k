# 리소스 테이블 - Item - Etc (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Item/리소스 테이블 - Item - Etc/content.md

## 한 줄 설명
Project K의 기타(Etc) 아이템 리소스 테이블 설정 가이드. 강화 재료, 제작 재료 등 기타 아이템의 컬럼 정의, EtcType 분류, 추가 방법을 명시한다.

## 핵심 용어
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
- EnchantHolyRelic
- BlessedEnchantHolyRelic
- CursedEnchantHolyRelic
- GuildCraftingAccel
- SkillEnchant
- CraftMaterial
- MonsterParts
- PreserveProb
- BlessedPreserveProb
- BlessedSuccessProb
- ItemType
- Grade
- MaxStack

## 숫자/상수/공식
- 강화 성공 시 +1 (일반 강화)
- 강화 성공 시 +1~3 (축복 강화, 가중 확률)
- 저주 강화 강화 수치 -1 (항상 성공)
- MaxStack 예시: 99, 999
- SellPrice 예시: 100, 500, 50
- Id 채번: 기존 기타 아이템 Id 중 가장 큰 값 + 1
- BlessedPreserveProb < 1000(100%)일 경우 장비 파괴 가능

## 참조 시스템
- Item.xlsx (ItemEtcClass 시트)
- Enchant 테이블

## 주요 섹션
- 설정할 컬럼
- EtcType별 설정 가이드
- 강화 재료 계열
- 기타 유형
- 새 기타 아이템 추가하기
- 실제 예시
- 자주 하는 실수
- 트러블슈팅
