# 아이템 제작 UI (요약)

> 출처: Confluence / Design/시스템 디자인/제작/아이템 제작 UI
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/제작/아이템 제작 UI/content.md

## 한 줄 설명
재료를 사용해 아이템을 제작하는 UI 시스템으로, 카테고리별 제작식 선택, 재료 확인, 제작 결과 연출을 포함한 전체 플로우를 정의한다.

## 핵심 용어
- ItemCraft
- ResultItem
- GroupID
- 제작식
- 카테고리 (메인/서브)
- 즐겨찾기
- 제작 가능 필터
- 사용 가능 필터
- Material
- Currency
- SuccessProb
- LuckyProb
- LuckyItem
- 일반 성공
- 대성공
- 제작 결과 연출
- 즉시 제작 팝업
- 제작 메인 UI
- ItemCraftCategoryGroup
- CanAuction
- OpenLevel
- 창고 아이템 사용

## 숫자/상수/공식
- 즐겨찾기 수량 제한: 20개 (ItemCraft_Fav = 20)
- 제작식 링크 최대 뎁스: 3단계
- 레벨 제한 조건: ItemCraft > OpenLevel
- 성공 확률: ItemCraft > SuccessProb
- 대성공 확률: ItemCraft > LuckyProb

## 참조 시스템
- 아이템 ID 그룹화 기능
- 아이템 제작 시스템
- 거래소 카테고리
- 컴포넌트 범용 수량 조절 슬라이더
- 계층 구조 설계 (내비게이션형 팝업 시스템)

## 주요 섹션
- 레이아웃
- 진입 경로
- 메인 UI
- 상단 영역 (공통 UX)
- 각 영역 설명
- 상세 UI
- 카테고리 영역
- 제작식 목록
- 제작 결과물 정보
- 필요 재료/재화 리스트
- 제작 결과 연출
- 제작 시스템 분기 호출 프로세스 및 UX 설계
- 즉시 제작 팝업
- 제작 메인 UI 상세
- 예외 사항 처리
