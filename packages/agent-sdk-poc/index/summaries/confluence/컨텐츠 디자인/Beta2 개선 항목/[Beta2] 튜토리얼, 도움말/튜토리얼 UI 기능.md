# 튜토리얼 UI 기능 (요약)

> 출처: 컨텐츠 디자인 / Beta2 개선 항목 / [Beta2] 튜토리얼, 도움말 / 튜토리얼 UI 기능
> 원본: packages/confluence-downloader/output/컨텐츠 디자인/Beta2 개선 항목/[Beta2] 튜토리얼, 도움말/튜토리얼 UI 기능/content.md

## 한 줄 설명
Project K의 튜토리얼 UI와 도움말 UI의 기능, 위젯 구조, 말풍선 배치 규칙, 스와이프 제스처 조작 조건을 정의한 기획 문서.

## 핵심 용어
- 조작 튜토리얼
- 도움말 UI
- 말풍선 (툴팁)
- 스와이프 기능
- 포커싱 대상 UI 위젯
- WBP_AttackButtonGroup
- WBP_SideQuickHUD
- WBP_QuestListHUD
- Pk_Target_Btn
- Widget_InteractionButton
- WBP_PlayerStatsGroup
- WBP_WorldMap
- WBP_Metamorph
- WBP_BossRaidStage
- WBP_Pet
- WBP_Collection
- WBP_ItemEnchant
- 세이프존
- 드래그 속도 감도
- 터치 시작 지점
- 전환 불가 조건

## 숫자/상수/공식
- 조작 튜토리얼 구분자: 1001, 1002, 1003, 1004, 1005
- 도움말 UI 연결 구분자: 101, 201, 301, 401, 501, 601, 701
- 말풍선 기본 노출 위치: 앵커 대상의 우측 상단
- 위치 변경 우선순위: 상단 → 하단 → 우측 → 좌측
- 스와이프 터치 시작 영역: 화면 좌/우측 가장자리로부터 20~30% (약 25%) 이내
- 스와이프 드래그 이동 거리: 화면 기준 70~80% (약 25%) 이상
- 도움말 이미지 최대 개수: 5개
- 페이지 네비게이터 아이콘 최소 사이즈: 44px 이상
- 도움말 설명 표시 줄 수: 3줄

## 참조 시스템
- 제스처 기능
- UI (도움말 UI 연결 - 컨텐츠 네임 관련 Confluence 페이지)

## 주요 섹션
- 조작 튜토리얼
- 조작 튜토리얼 진행 목록
- 말풍선 기능
- 툴팁 노출 자동 위치 출력
- 도움말 UI
- 도움말 UI 헤더
- 도움말 카테고리
- 도움말 이미지
- 도움말 설명
- 도움말 이미지 페이지 네비게이터
- UI FLOW
- 도움말 UI 연결 - 컨텐츠 네임
- 스와이프 기능 설정
- 기본 기능
- 조작 조건
- 터치 시작 정의
- 드래그 정의
- 전환 불가 조건
- 전환 결과
