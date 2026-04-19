# [컴포넌트] UI 버튼 규칙 (요약)

> 출처: 시스템 디자인 / UX UI 규칙 / UX 규칙 문서
> 원본: packages/confluence-downloader/output/시스템 디자인/UX UI 규칙/UX 규칙 문서/[컴포넌트] UI 버튼 규칙/content.md

## 한 줄 설명
모바일과 PC 크로스 플랫폼에서 일관성 있는 사용자 경험을 제공하기 위해 버튼의 입력 상태, 타입, UI 구조, 터치 범위, 예외 처리를 규정한 컴포넌트 설계 문서.

## 핵심 용어
- Normal
- On Pressed
- On Hovered
- On Unhovered
- On Released
- Selected/Focused
- Interactive Disabled
- Disabled
- 공통 UI 버튼
- 아이콘 + 텍스트
- 재화 소모 버튼
- 쿨타임/시간 제한 버튼
- 커스텀 버튼
- 아이콘형 버튼
- 히트 박스(Hit Box)
- 연타 방지
- 취소 로직(Drag-out Cancel)
- 오토 사이즈
- 세이프존

## 숫자/상수/공식
- 권장 터치 범위: 44 x 44 px 이상 (iOS 기준)
- 안전 범위: 48 x 48 px 이상 (Google Material Design 기준)
- UI 컴포넌트 간 간격: 8 px 이상
- 연타 방지 쿨타임: 0.2초~0.5초

## 참조 시스템
- (없음)

## 주요 섹션
- 문서 개요
- 버튼 기능 구현 상세
- 버튼 입력 규칙
- 버튼 타입
- 버튼 UI 구조
- 버튼 UI 컴포넌트
- 버튼 UI - 텍스트 적용 규칙
- 버튼 터치 범위 설정
- 예외 처리
