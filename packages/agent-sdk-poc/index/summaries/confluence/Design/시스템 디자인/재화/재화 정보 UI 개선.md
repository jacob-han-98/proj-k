# 재화 정보 UI 개선 (요약)

> 출처: Confluence / Design/시스템 디자인/재화/재화 정보 UI 개선
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/재화/재화 정보 UI 개선/content.md

## 한 줄 설명
박스 아이템 관련 재화 정보 모달(기존 툴팁)의 UI 표현 규칙과 정보 구조를 정의하는 문서. 재화 개수 표기법, 아이콘 표기 위치, 정보 모달 레이아웃을 명확한 개수와 Min~Max 개수 두 가지 경우로 구분하여 설명한다.

## 핵심 용어
- 재화 정보 UI
- 박스 아이템
- 정보 모달
- 툴팁
- 레드닷
- 시간제(기간) 표기
- 재화 개수
- Currency
- 명확한 개수
- Min~Max 개수
- CurrencyClass 테이블
- ItemEtcClass 테이블
- ItemConsumeClass 테이블
- DummyItem
- TextKeyTitle
- IconResource
- TextKeyDesc
- SellPrice
- CanSell
- 채팅 공유 버튼
- 상점 판매 금액 정보

## 숫자/상수/공식
- 1 이하: 개수 표기 제외
- 만 미만: 전체 표기 (예: 8,500)
- 1만 이상 ~ 1억 미만: '만' 단위 사용 (예: 1,520만)
- 1억 이상: '억' 단위 사용 (예: 1,000억)
- Min~Max 표현: ~{max} 형태
- textkey `ItemInfo_AmountMax_Value = ~{0}`
- textkey `ItemInfo_Count_M = {0}만`
- textkey `ItemInfo_Count_B = {0}억`
- textkey `ItemInfo_Count_T = {0}조`
- textkey `ItemInfo_Cantsell = 상점 판매 불가 상품`

## 참조 시스템
- 재화 정보 UI (기존 문서)
- 아이템 UIUX 정리/개선

## 주요 섹션
- 문서 개요
- 공통 규칙
- 아이콘 표기
- 정보 모달 (기존 툴팁)
- 구분
- 명확한 개수
- Min~Max 개수
