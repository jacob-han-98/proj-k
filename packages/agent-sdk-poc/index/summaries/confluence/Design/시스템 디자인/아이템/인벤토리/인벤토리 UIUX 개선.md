# 인벤토리 UIUX 개선 (요약)

> 출처: PK / 인벤토리 UIUX 개선
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/아이템/인벤토리/인벤토리 UIUX 개선/content.md

## 한 줄 설명
인벤토리 시스템의 UI/UX를 정리하고 개선하기 위한 기획서로, 슬롯 관리, 정렬, 필터, 아이템 사용, 장착, AutoUse, 잠금 등의 기능과 모달 구조를 정의한다.

## 핵심 용어
- 인벤토리
- 슬롯 (InventoryBaseSlot, InventoryMaxSlot, InventoryExtendOnce)
- 아이템 타입 (ItemType: Equip, Consume, Material, Etc)
- 정렬 (기본, 획득, 등급)
- 카테고리 필터 (전체, 장비, 소모품, Etc, AutoUse)
- 장착/해제 (Equip/UnEquip)
- 사용 (Use, ItemRandomBox, ItemChoiceBox)
- AutoUse (CanAutoUse, CoolTimeGroupId)
- 잠금 (Lock, CanLock)
- 분해 (Dismantle)
- 강화 (Enchant)
- 슬롯 확장 (InventoryExtendCurrencyType, InventoryExtendValue)
- 재화 (Currency, FreeDiamond, Gold)
- 쿨타임 (Cooltime, CoolTimeGroupId, InventoryItemSortCoolTime)
- 등급 (Grade, Tier)
- 거래 (CanAuction)
- 레드닷 (RedDot)
- 창고 (Storage, StorageExtendCurrencyType, StorageExtendValue)
- 박스 (ItemBoxId, ItemRandomBox, ItemChoiceBox)
- 조건 (ConditionMinLv, ConditionMaxLv, ConditionClass)
- 스택 (Stack, MaxStack)
- 장착 가능 여부 (EquipPartsEnum)
- 비교 (Compare)

## 숫자/상수/공식
- InventoryBaseSlot: 100 (기본 슬롯 개수)
- InventoryMaxSlot: 200 (최대 확장 슬롯)
- InventoryExtendOnce: 1 (1회 확장 시 증가 슬롯 수)
- InventoryExtendValue: 10000 (1회 확장 비용)
- InventoryItemSortCoolTime: 3000 (정렬 쿨타임, 초)
- 슬롯 사용률 색상: 0~79% 기본, 80~99% 주황, 100% 붉은색
- 박스 개봉 조건: IF (박스 내 아이템 종류 수 > 인벤토리 잔여 슬롯) THEN 개봉 실패
- 쿨타임 표기: 1초 미만은 표기 제외
- AutoUse 소모 순서: 귀속(CanAuction=FALSE) 우선 → 비귀속(CanAuction=TRUE)

## 참조 시스템
- 아이템 UIUX 정리/개선
- 성물 시스템
- [예외처리] 인벤토리 공간 가득 참
- 아이템 자동 정렬
- 레드닷 시스템 UIUX 정리/개선
- 아이템 분해_규칙
- 아이템 분해_UI
- 장비 강화 시스템
- 장비 강화_UI
- 장비 다중 강화
- 장비 다중 강화_UI
- HUD UIUX 개선
- [작성예정] 분해 UIUX 개선

## 주요 섹션
- 0. 추가 내용 (WBP_Equip_New 이동, 인벤토리 레이아웃)
- 1. 목적
- 2. 규칙 (아이콘 표기, 슬롯, 정렬 방식, 카테고리 필터, 장착/해제, 사용, 분해, 장비 강화, AutoUse, 자동 장착, 잠금 설정, 퀵슬롯 등록/해제, 예외처리)
- 3. UI (인벤토리 팝업, 아이템 정보 팝업, 슬롯 확장 모달, 아이템 사용 확인 모달, ItemChoiceBox 선택 모달, 수량 선택 모달, 보상 확인 모달)
