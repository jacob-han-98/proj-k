# HUD 기능적 레이아웃 구성 (요약)

> 출처: Confluence / HUD 기능적 레이아웃 구성
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/UX UI 규칙/UX 규칙 문서/HUD 기능적 레이아웃 구성/content.md

## 한 줄 설명
크로스 플랫폼(모바일/PC) 간 HUD 영역을 기능적 역할에 따라 9개 구역으로 정의하고, 각 영역의 UI 요소, 조작 규칙, 레이아웃 규격을 명시하는 문서.

## 핵심 용어
- HUD (Heads-Up Display)
- 크로스 플랫폼
- Safe Area
- 세이프존
- 앵커(Anchored)
- 좌측 상단 (Top-Left)
- 중앙 상단 (Top-Center)
- 우측 상단 (Top-Right)
- 좌측 중앙 (Center-Left)
- 중앙 중앙 (Center-Center)
- 우측 중앙 (Center-Right)
- 좌측 하단 (Bottom-Left)
- 중앙 하단 (Bottom-Center)
- 우측 하단 (Bottom-Right)
- 퀵슬롯
- 메인 공격 버튼
- 스킬 슬롯
- 자동 사용(Auto-Use)
- Cool-time
- 버프/디버프 아이콘
- 가상 조이스틱
- 햄버거 메뉴

## 숫자/상수/공식
- 9개 영역 구성
- 좌우 100px 세이프존
- 메인 공격 버튼: 180x180 px, Right 100px, Bottom 32px 기준
- 일반 스킬 슬롯: 90x90 px, 12px 마진, 8개 기본 구성
- 소모품(물약) 슬롯: 80x80 px, 10px 마진
- 슬롯 내 아이콘: 76x76 px
- 기준 해상도: 1920x1080

## 참조 시스템
- PK_HUD 시스템.xlsx

## 주요 섹션
- 문서 개요
- HUD 기능 구성 목록
- 영역 별 기능 상세 정보
- 좌측 상단 (캐릭터 정보 영역)
- 중앙 하단 (퀵슬롯)
- 퀵슬롯 레이아웃 구조
- 슬롯 상세 규격
- 자동 사용(Auto-Use) 시스템 구현
- 인터랙션 및 상태 표시
