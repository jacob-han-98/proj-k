# UI LayerType 규칙 (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/UX UI 규칙/UX 규칙 문서/UI LayerType 규칙/content.md

## 한 줄 설명
프로젝트 내 UI 레이어 타입의 분류 기준과 정의를 규정하여 HUD, 팝업, 모달, 시스템 메시지 등이 중첩될 때 우선순위를 명확히 하는 문서.

## 핵심 용어
- HUD
- Window (HUD Overlay)
- FullScreen
- TopHUD
- PopUp
- PopUpWindow
- PopUp Confirm
- System Info
- Tooltip
- Tutorial overlay
- Loading FullScreen
- Window Blur (Dimmed)
- DA_UIWidgetDataAsset
- Layer Type
- Dimmed
- 레이어 우선순위
- 포커싱
- 인터렉션

## 숫자/상수/공식
- 레이어 순서: 1(HUD) ~ 10(Tutorial overlay)
- BaseHUD: 시스템 메시지 (별도 레이어 타입 없음)

## 참조 시스템
- (없음)

## 주요 섹션
- 문서 개요
- UI 레이어 목록
- UI 레이어 타별 상세 정보
- HUD
- Window (HUD Overlay)
- FullScreen
- Window Blur (Dimmed)
- PopUp
- TopHUD
- PopUp Confirm
- System Info
- Loading FullScreen
