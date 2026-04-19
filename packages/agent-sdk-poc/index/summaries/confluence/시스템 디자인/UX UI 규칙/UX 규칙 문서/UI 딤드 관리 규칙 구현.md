# UI 딤드 관리 규칙 구현 (요약)

> 출처: 시스템 디자인 / UX UI 규칙 / UX 규칙 문서 / UI 딤드 관리 규칙 구현
> 원본: packages/confluence-downloader/output/시스템 디자인/UX UI 규칙/UX 규칙 문서/UI 딤드 관리 규칙 구현/content.md

## 한 줄 설명
UI 팝업 위젯에서 딤드 중첩으로 인한 메모리 낭비와 화면 어두워짐 현상을 방지하기 위해 공통 레이어 구조를 설계하고 구현 규칙을 정의한 문서.

## 핵심 용어
- UI 딤드
- UMG 위젯
- 레이어 뎁스
- Order 값
- 포커스 관리
- 계층 구조
- 딤드 투명도
- 딤드 클릭 창 닫기
- 시스템 다이얼로그
- 공통 레이어 구조
- UseDimmed
- CloseOnDimmedClick
- DimmedOpacity
- NeedCurrencyWidget
- DA_UIWidgetContentSettingDataAsset
- 블러 이미지
- 툴팁 딤드
- 다이얼로그 딤드

## 숫자/상수/공식
- (없음)

## 참조 시스템
- 공통 팝업 및 모달 UI 시스템 가이드
- DA_UIWidgetContentSettingDataAsset

## 주요 섹션
- 문서 개요
- 구조 상세 기획
- UMG 위젯 베이스 설계
- 시스템 구현 구조
- 위젯 내부 속성 변수
- 딤드 클릭 창 닫기 기능
- 구현시 위젯 세팅 방법
