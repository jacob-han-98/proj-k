# 리소스 테이블 - Item (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Item/content.md

## 한 줄 설명
게임 내 모든 아이템을 정의하는 시스템으로, 장비(Equip), 소비(Consume), 기타(Etc) 3가지 타입으로 분류되며 각 타입별 별도 시트에서 관리된다.

## 핵심 용어
- ItemEquipClass
- ItemConsumeClass
- ItemEtcClass
- ItemCraft
- ItemCraftCategoryGroup
- Enchant
- EnchantBonus
- EnchantRandom
- ItemReward
- ItemRandom
- ItemSelect
- ItemMarket
- ItemMarketGroup
- ItemCollectionClass
- EffectClass
- EquipType
- EquipParts
- ConsumeType
- EtcType
- AttackType
- Grade
- BuffId
- DismantleRewardId
- EnchantId

## 숫자/상수/공식
- Id: int32, 1 이상의 정수, 시트 내 중복 불가
- GroupId: int32, 0(그룹 없음) 또는 1 이상
- AttackDistance: int32, 0 이상의 정수
- ConditionMinLv/ConditionMaxLv: int32, 0(제한 없음) 이상
- EffectStatValue01~10: int32, 음수 가능(패널티)
- Cooltime: int32, 밀리초 단위, 0 이상
- SellPrice: int32, 0 이상
- MaxStack: int32, 1 이상의 정수
- Value01/Value02: ConsumeType별 의미 상이
- ItemBoxId: ConsumeType별 의미 상이

## 참조 시스템
- ItemEquipClass.xlsx
- ItemConsumeClass.xlsx
- ItemEtcClass.xlsx
- ItemCraft.xlsx
- Enchant.xlsx
- ItemBox.xlsx
- Market.xlsx
- Collection.xlsx
- Effect.xlsx
- Buff 테이블
- ItemReward 테이블
- ItemSelect 테이블
- EnchantBonus 테이블

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 카테고리 페이지 매핑
- 카테고리별 컬럼 사용 매트릭스
- 아이템 공통 컬럼
- 장비 전용 컬럼
- 소비/기타 전용 컬럼
- 전체 컬럼 사전
