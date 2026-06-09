# 리소스 테이블 - Item - Craft (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Item/리소스 테이블 - Item - Craft/content.md

## 한 줄 설명
Project K의 아이템 제작(Craft) 시스템을 정의하는 리소스 테이블 가이드. 제작 레시피의 컬럼 구조, 설정 방법, 검증 규칙을 명시한다.

## 핵심 용어
- Id
- OpenLevel
- SuccessProb
- ResultItem
- ResultItemCount
- LuckyProb
- LuckyResultItem
- LuckyResultItemCount
- Material01~08
- MaterialCount01~08
- Currency01~02
- CurrencyCount01~02
- ReturnItem01~03
- ReturnItemCount01~03
- ItemCraft 시트
- 제작 레시피
- 대성공
- 재료
- 화폐 비용
- 반환 아이템

## 숫자/상수/공식
- SuccessProb: 1 이상 필수
- ResultItemCount: 1 이상 필수
- LuckyResultItemCount: 1 이상 필수 (LuckyProb > 0일 때)
- MaterialCount: 1 이상 필수 (Material 설정 시)
- CurrencyCount: 1 이상 필수 (Currency가 None이 아닐 때)
- ReturnItemCount: 1 이상 필수 (ReturnItem이 0이 아닐 때)
- OpenLevel: 0이면 제한 없음
- LuckyProb: 0이면 대성공 없음
- Material: 최소 1개 필수
- 예시: Id 100, OpenLevel 20, SuccessProb 800, ResultItem 1001, ResultItemCount 1, LuckyProb 100, LuckyResultItem 1002, LuckyResultItemCount 1, Material01 8100, MaterialCount01 5, Material02 8101, MaterialCount02 3, Currency01 Gold, CurrencyCount01 10000

## 참조 시스템
- Item.xlsx

## 주요 섹션
- 설정할 컬럼
- 새 제작 레시피 추가하기
- 실제 예시
- 자주 하는 실수
- 트러블슈팅
