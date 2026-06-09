# RegenHP 스탯의 현재 상태 검토 및 신규 방향성 제안 (요약)

> 출처: Confluence / Design/시스템 디자인/성장 밸런스
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/성장 밸런스/RegenHP 스탯의 현재 상태 검토 및 신규 방향성 제안/content.md

## 한 줄 설명
Project K의 HP 자연 회복(RegenHP) 스탯의 현재 설정을 검토하고, CON 스탯의 가치 상향을 위해 Con to RegenHP 계수를 1에서 3으로 증가시킬 것을 제안하는 문서.

## 핵심 용어
- RegenHP
- HP 자연 회복
- CON (Constitution)
- Con to RegenHP
- 전투 상황
- 비전투 상황
- 틱 (Tick)
- MaxHP
- 포션
- 리니지 라이크
- 지속력
- ContentSetting.xlsx
- PK_Stat 및 공식.xlsx
- 로드나인
- 소울 라이크
- WoW
- Diablo
- PoE

## 숫자/상수/공식
- 현재 설정: Con to RegenHP = 1, Tick = 15초
- 현재 기본 CON = 12
- 현재 기본 RegenHP/sec = 0.8
- 제안1: Con to RegenHP = 3 (CON 투자 없음 시 HP 0→100% 18~87분)
- 제안1: Con to RegenHP = 3 (CON 전부 투자 시 HP 0→100% 18~9분)
- 제안2: Con to RegenHP = 1, Initial RegenHP = 24 (CON 투자 없음 시 HP 0→100% 18~87분)
- 제안2: Con to RegenHP = 1, Initial RegenHP = 24 (CON 전부 투자 시 HP 0→100% 18~23분)
- 로드나인 레퍼런스: 틱 5초, 틱당 전체 HP의 0.82% 회복
- 현재 70레벨 기준: 약 0.008%/초, HP 0→100% 약 3.3시간

## 참조 시스템
- PK_Stat 및 공식.xlsx
- ContentSetting.xlsx
- PK-4707 (태스크)

## 주요 섹션
- 기획 의도 및 목적
- RegenHP Stat의 Beta 2 개발 상황
- 게임 장르별 HP 자연 회복 레퍼런스
- 로드나인의 사례
- Project K의 HP 자연 회복 방향성
- 현재 빌드 설정
- 제안1: HP 0 to 100% 시간을 줄이기 위해 Con to RegenHP를 3으로 증가
- 제안2: Con to RegenHP가 1이나 초기 값이 24 주어짐
- 결론
