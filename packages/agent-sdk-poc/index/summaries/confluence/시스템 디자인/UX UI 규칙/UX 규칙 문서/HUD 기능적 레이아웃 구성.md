# HUD 기능적 레이아웃 구성 (요약)

> 출처: 시스템 디자인 / UX UI 규칙 / UX 규칙 문서 / HUD 기능적 레이아웃 구성
> 원본: packages/confluence-downloader/output/시스템 디자인/UX UI 규칙/UX 규칙 문서/HUD 기능적 레이아웃 구성/content.md

## 한 줄 설명
크로스 플랫폼(모바일/PC) 간 기능적 불일치를 해소하고 조작 규칙의 일관성을 유지하기 위해 HUD 영역을 기능적 역할에 따라 9개 구역으로 정의하는 문서.

## 핵심 용어
- HUD (Heads-Up Display)
- Anchored 기준
- 좌측 상단 (Top-Left)
- 중앙 상단 (Top-Center)
- 우측 상단 (Top-Right)
- 좌측 중앙 (Center-Left)
- 중앙 중앙 (Center-Center)
- 우측 중앙 (Center-Right)
- 좌측 하단 (Bottom-Left)
- 중앙 하단 (Bottom-Center)
- 우측 하단 (Bottom-Right)
- Window Group [Left][Right]
- 캐릭터 초상화
- 버프/디버프 아이콘
- 파티 정보
- 보스 몬스터 스케줄
- 월드맵
- 미니맵
- 가상 조이스틱
- 퀵 슬롯
- 메인 공격 버튼
- 스킬 슬롯 (액티브/패시브)
- 자동 사냥/전투 모드
- Safe Area
- 세이프존
- 자동 사용 (Auto-Use)
- Cool-time
- 글로잉 이펙트 (Glowing Effect)

## 숫자/상수/공식
- 9개 영역으로 설정 가능 (논의 중)
- 메인 공격 버튼: 180 x 180 px
- 일반 스킬 슬롯: 90 x 90 px
- 소모품(물약) 슬롯: 80 x 80 px
- 슬롯 내 아이콘: 76 x 76 px
- 슬롯 간격 (스킬): 12 px
- 슬롯 간격 (물약): 10 px
- Safe Area 세이프존: 좌우 100 px
- 메인 공격 버튼 위치: Right 100px, Bottom 32px 기준
- 기준 해상도: 1920 x 1080

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
- 인터랙션 및 상태 표시 (Visual States)
