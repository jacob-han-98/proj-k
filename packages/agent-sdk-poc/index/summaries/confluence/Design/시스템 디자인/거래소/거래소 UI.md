# 거래소 UI (요약)

> 출처: Design / 시스템 디자인 / 거래소 / 거래소 UI
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/거래소/거래소 UI/content.md

## 한 줄 설명
거래소 시스템의 구매, 판매, 거래 내역 UI 구성 및 상세 기획으로, 다중 뎁스 구조에서 최대한 정보를 노출하고 사용자 편의성을 극대화하는 설계를 정의한다.

## 핵심 용어
- 거래소 UI
- 구매 탭
- 판매 탭
- 거래 내역 탭
- 판매 수수료
- 세공 정보
- 아이템 검색
- 즐겨찾기 리스트
- 카테고리 리스트
- MarketGroupClass 테이블
- 뎁스 (1뎁스, 2뎁스, 3뎁스)
- 아이템 강화 정보
- 실제 매물 정보
- 다중 구매
- 단일 구매
- 구매 팝업
- 판매 팝업
- 판매 인벤토리
- 정산 금액
- 판매 등록 슬롯
- 일괄 회수
- 일괄 재등록
- 일괄 정산
- 거래 시세
- 거래 단가
- 수수료율
- 누적 세금
- 서버 세율
- 서버 그룹 세율

## 숫자/상수/공식
- ContentSetting > MarketTaxBase = 500 (5%)
- ContentSetting > MarketTaxContent1 = 1%
- ContentSetting > MarketTaxContent2 = 2%
- Market_List_Refresh_Cooldown = 3 (초)
- ContentSetting > MarketSellSlot = 10 (개)
- 판매 수수료 = 총 판매 금액의 8%
- 다중 구매 선택 수량 제한 = 기획 정의된 개수
- 고가 판정 기준 = 현재 최저 단가의 2배 이상

## 참조 시스템
- 거래소 시스템
- 컬렉션 카테고리 UI

## 주요 섹션
- 개요
- 메인 메뉴
- 거래소 UI_구매
- 상단 영역
- 상단 탭 영역
- 좌측 탭 영역
- UI FLOW
- 아이템 리스트
- 구매 팝업 - 단일 구매
- 구매 팝업 - 다중 구매
- 판매
- 판매 UI
- 판매 팝업
- 거래 내역
