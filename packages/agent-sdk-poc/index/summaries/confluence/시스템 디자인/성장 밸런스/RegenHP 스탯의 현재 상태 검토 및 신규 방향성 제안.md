# RegenHP 스탯의 현재 상태 검토 및 신규 방향성 제안 (요약)

> 출처: 시스템 디자인 / 성장 밸런스
> 원본: packages/confluence-downloader/output/시스템 디자인/성장 밸런스/RegenHP 스탯의 현재 상태 검토 및 신규 방향성 제안/content.md

## 한 줄 설명
Project K의 HP 자연 회복(RegenHP) 스탯 시스템의 현재 설정을 검토하고, CON 스탯과의 연계 강화를 통해 회복 속도를 개선하는 방향성을 제안하는 문서.

## 핵심 용어
- RegenHP
- CON (Constitution)
- 전투 상황
- 비전투 상황
- 틱 (Tick)
- HP 자연 회복
- 포션
- 생존력
- 게임 템포
- 리니지 라이크
- 스탯 투자
- 회복 속도
- MaxHP
- RegenHP/sec
- Con to RegenHP

## 숫자/상수/공식
- RegenHP 틱: 15초
- 현재 Con to RegenHP: 1
- 제안 Con to RegenHP: 3
- 초기 CON 값: 12
- 레벨 70 기준 현재 회복률: 약 0.008%/초
- 레벨 70 기준 현재 HP 0→100% 회복 시간: 약 198분
- 제안1 (Con to RegenHP=3, CON 미투자): 레벨 70 기준 66분
- 제안1 (Con to RegenHP=3, CON 전투): 레벨 70 기준 10분
- 제안2 (Con to RegenHP=1, 초기값 24, CON 전투): 레벨 70 기준 23분

## 참조 시스템
- PK_Stat 및 공식.xlsx
- ContentSetting.xlsx
- PK-4707 (Jira 태스크)

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
