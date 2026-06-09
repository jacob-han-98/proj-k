# 장비 강화 시스템 UIUX 개선 (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/아이템/장비 강화 시스템 UIUX 개선/content.md

## 한 줄 설명
장비 강화 시스템의 UI/UX 개선 사항과 시스템 로직 최적화를 정의하는 문서로, 정보 레이아웃 개선, 인벤토리 슬롯 처리, 연출 효과 추가 등을 포함한다.

## 핵심 용어
- 단일 강화
- 다중 강화
- 안전 강화
- 축복 강화
- 저주 강화
- 파괴 보상
- 랜덤 능력치
- 성물
- 강화 주문서
- 인벤토리 슬롯
- 오퍼시티
- 딤드(Dimmed)
- 강화 바로가기
- 강화 재료
- 강화 단계
- 능력치 Diff
- 성공 확률
- 파괴 보상 팝업
- 성공 연출 팝업
- EnchantBonus 테이블

## 숫자/상수/공식
- 배경 오퍼시티: 1.0 → 0.5로 수정
- 슬롯 초과 허용: 1회(강화 버튼 1회 클릭 시점)에 한해 실행 허용
- 강화 실패 시 파괴 보상으로 인한 슬롯 초과 가능

## 참조 시스템
- ItemEtcClass 테이블
- Enchant 테이블
- ItemEquipClass 테이블
- EnchantBonus 테이블
- ItemType (Material)
- EtcType (EnchantWeapon, EnchantArmor, EnchantAccessory, BlessedEnchantWeapon, BlessedEnchantArmor, BlessedEnchantAccessory, CursedEnchantWeapon, CursedEnchantArmor, CursedEnchantAccessory, EnchantHolyRelic, BlessedEnchantHolyRelic, CursedEnchantHolyRelic)

## 주요 섹션
- 개선 리스트
- UIUX 및 정보 레이아웃 개선
- 단일 강화
- 다중 강화
- 배경 딤드
- 보유 재료 없는 상태
- 파괴 보상 확인 팝업
- 성공 연출 팝업
- 시스템 로직 및 인벤토리 최적화
- 랜덤 능력치 연출 추가
