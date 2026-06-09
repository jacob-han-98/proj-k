# 마을 전투 HUD 처리 (요약)

> 출처: Confluence / Design/시스템 디자인/HUD/마을 전투 HUD 처리
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/HUD/마을 전투 HUD 처리/content.md

## 한 줄 설명
마을 진입 시 공격 버튼을 인터렉션 버튼으로 교체하고, 대상 타입에 따라 아이콘을 변경하며, 상황별 시스템 메시지를 출력하는 HUD 처리 규칙을 정의한다.

## 핵심 용어
- 공격 버튼
- 인터렉션 버튼
- 테리토리 볼륨
- 마을
- 테리토리
- NPC
- PC
- Hostile
- 인터렉션 거리
- 인터렉션 범위
- NPC Sub Category
- NpcSubCategoryEnum
- 메인 퀘스트
- 시스템 메시지
- 아이콘 교체
- UI 전환 연출
- 투명도
- 버프 스킬
- 공격 스킬

## 숫자/상수/공식
- 0.5초 (UI 전환 연출 시간)

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
