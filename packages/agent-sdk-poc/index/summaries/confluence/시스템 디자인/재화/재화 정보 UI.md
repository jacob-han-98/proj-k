# 재화 정보 UI (요약)

> 출처: 시스템 디자인 / 재화 정보 UI
> 원본: packages/confluence-downloader/output/시스템 디자인/재화/재화 정보 UI/content.md

## 한 줄 설명
게임 내 재화(골드, 다이아, 마일리지 등)를 HUD와 컨텐츠 UI에서 표시하고, 클릭 시 정보 툴팁으로 확인할 수 있도록 구성한 UI 시스템.

## 핵심 용어
- 재화 정보 UI
- HUD (Heads-Up Display)
- 재화 드롭다운 리스트
- Gold
- Diamond
- Mileage
- Coin
- GuildCoin
- MissionCoin
- InfiniteCoin
- BattleCoin
- HonorCoin
- CurrencyClass
- IconResourceSmall
- TextkeyTitle
- 정보 툴팁
- ItemEtcClass
- DummyItem
- 컨텐츠 UI 재화 표시
- 재화 리스트 닫힘 조건

## 숫자/상수/공식
- HUD 재화 표시 종류: 2종 (골드, 다이아)
- 컨텐츠 UI 상단 표시 재화: 최대 3가지
- 재화 아이콘 표시 순서: Gold → Diamond → Mileage → Coin → GuildCoin → MissionCoin → InfinityCoin → BattleCoin → HonorCoin

## 참조 시스템
- CurrencyClass
- ItemEtcClass

## 주요 섹션
- 개요
- UI
- [1] 재화 드롭다운 리스트 (HUD)
- [2] 컨텐츠 UI 재화 표시
- [3] 재화 정보 툴팁
