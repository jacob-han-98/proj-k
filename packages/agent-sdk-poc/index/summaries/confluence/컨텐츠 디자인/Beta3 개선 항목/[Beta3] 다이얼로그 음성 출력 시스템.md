# [Beta3] 다이얼로그 음성 출력 시스템 (요약)

> 출처: 컨텐츠 디자인 / Beta3 개선 항목 / [Beta3] 다이얼로그 음성 출력 시스템
> 원본: packages/confluence-downloader/output/컨텐츠 디자인/Beta3 개선 항목/[Beta3] 다이얼로그 음성 출력 시스템/content.md

## 한 줄 설명
퀘스트 및 컷신 다이얼로그에 성우 음성 연출을 추가하기 위해 테이블에 Voice 컬럼을 추가하고 음성 리소스 출력 규칙을 정의한 시스템.

## 핵심 용어
- 다이얼로그 음성 출력 시스템
- Voice 컬럼
- DialogSequence 시트
- CinematicDialog 시트
- 음성 리소스
- 사운드 큐
- 레벨 시퀀스
- 시네마틱
- 컷신
- L10N
- 내러티브 몰입감
- 음성 리소스 네이밍
- SC_Quest_다이얼로그Id_시퀀스 넘버
- SC_Cinematic_다이얼로그Id_Dia 넘버
- Start Dialog 타이밍
- End 프로퍼티 타이밍
- 페이드 효과
- 스킵 조작

## 숫자/상수/공식
- Voice 컬럼 디폴트 값 = null
- 음성 리소스 네이밍 규칙(퀘스트): SC_Quest_다이얼로그Id_시퀀스 넘버
- 음성 리소스 네이밍 규칙(컷신): SC_Cinematic_다이얼로그Id_Dia 넘버

## 참조 시스템
- PK_퀘스트.xlsx
- Quest.xlsx
- PK_시네마틱_시스템.xlsx
- Cinematic.xlsx

## 주요 섹션
- 개요
- 기획 의도
- 내용 요약
- 참고 문서
- 퀘스트 다이얼로그
- 퀘스트 테이블 다이얼로그 시트에 Voice 컬럼 추가
- 음성 리소스 출력 규칙
- 컷신 다이얼로그
- 시네마틱 테이블 다이얼로그 시트에 Voice 컬럼 추가
