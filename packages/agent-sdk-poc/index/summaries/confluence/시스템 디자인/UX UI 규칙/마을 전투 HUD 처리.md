# 마을 전투 HUD 처리 (요약)

> 출처: 시스템 디자인 / UX UI 규칙 / 마을 전투 HUD 처리
> 원본: packages/confluence-downloader/output/시스템 디자인/UX UI 규칙/마을 전투 HUD 처리/content.md

## 한 줄 설명
마을 진입 시 공격 버튼을 인터렉션 버튼으로 교체하고, 대상 상태와 위치에 따라 시스템 메시지를 출력하며 인터렉션 아이콘을 동적으로 변경하는 HUD 처리 규칙을 정의한다.

## 핵심 용어
- 마을 전투 HUD
- 공격 버튼
- 인터렉션 버튼
- 테리토리 볼륨
- 테리토리
- NPC
- PC 타겟팅
- Hostile
- 인터렉션 거리
- 인터렉션 메뉴
- 메인 퀘스트
- 시스템 메시지
- 인터렉션 아이콘
- NPC Sub Category
- NpcSubCategoryEnum
- 버프 스킬
- 공격 스킬
- 피아 구분

## 숫자/상수/공식
- UI 전환 연출 시간: 0.5초

## 참조 시스템
- //main/ProjectK/Design/8_Contents/아이콘 요청서/PK_아이템 및 기타 아이콘_요청서.xlsx (HUD_메뉴 시트)

## 주요 섹션
- 개요
- 규칙
- 전환 조건
- 시스템 메시지
- 추가 기능
- UI
- UI전환 연출
- 인터렉션 아이콘 교체
- 레퍼런스
