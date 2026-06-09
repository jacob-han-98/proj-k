# 리소스 테이블 - Item - Equip (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Item/리소스 테이블 - Item - Equip/content.md

## 한 줄 설명
Project K의 장비(Equip) 아이템 리소스 테이블 설정 가이드. ItemEquipClass 시트에서 장비 아이템의 컬럼 정의, 추가 절차, 검증 규칙을 명시한다.

## 핵심 용어
- ItemEquipClass
- EquipType
- EquipParts
- AttackType
- AttackDistance
- Grade
- EffectStatName/Value
- CanEnchant
- CanDismantle
- EnchantId
- EnchantBonusId
- DismantleRewardId
- BuffId
- Weapon
- Armor
- Accessory
- HolyRelic
- Melee
- ConditionMinLv
- ConditionMaxLv
- SellPrice
- ExpireTime
- CanAuction
- CanDelete
- CanLock
- CanStorage
- CanDeathDrop
- CanSell

## 숫자/상수/공식
- EffectStatName/Value: 최대 10개 쌍 설정 가능
- Id 채번: 기존 장비 아이템 Id 중 가장 큰 값 + 1
- ConditionMinLv/ConditionMaxLv: 0이면 제한 없음
- EnchantBonus 최대 레벨 ≥ Enchant 최대 레벨 (필수 조건)

## 참조 시스템
- Item.xlsx
- Enchant 테이블
- EnchantBonus 테이블
- ItemReward 테이블
- ItemConsumeClass 시트
- ItemEtcClass 시트

## 주요 섹션
- 설정할 컬럼
- 새 장비 아이템 추가하기
- 실제 예시
- 자주 하는 실수
- 트러블슈팅
