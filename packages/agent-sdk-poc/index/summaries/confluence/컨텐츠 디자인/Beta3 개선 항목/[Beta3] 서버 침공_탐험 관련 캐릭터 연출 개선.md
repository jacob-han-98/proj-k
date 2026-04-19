# [Beta3] 서버 침공_탐험 관련 캐릭터 연출 개선 (요약)

> 출처: 컨텐츠 디자인 / Beta3 개선 항목 / [Beta3] 서버 침공_탐험 관련 캐릭터 연출 개선
> 원본: packages/confluence-downloader/output/컨텐츠 디자인/Beta3 개선 항목/[Beta3] 서버 침공_탐험 관련 캐릭터 연출 개선/content.md

## 한 줄 설명
서버 탐험/침공 시작 및 종료 시 PC의 포탈 진입 애니메이션 연출을 추가하여 서버 이동 감각을 강화하는 개선 사항을 정의한다.

## 핵심 용어
- 서버 탐험
- 서버 침공
- 서버 이동 애니메이션
- NPC 상호작용
- 나가기(귀환 조작)
- 포탈
- 로딩 화면
- PC(플레이어 캐릭터)
- 개인 화면
- DA_PC 에셋
- Interaction 슬롯
- FX_AttackServer_Portal_01
- 귀환 대기 시간
- ReturnDurationTime
- 피격/이동 취소
- 클래스별 체형
- 메시 희미해지는 연출

## 숫자/상수/공식
- 3초 길이 (AM_클래스_Transfer 애니메이션 지속 시간)
- ReturnDurationTime (귀환 대기 시간, ContentSetting 내 정의)

## 참조 시스템
- ContentSetting (귀환 대기 시간 설정)
- Confluence 페이지: 귀환 대기 상태 관련 문서 (https://bighitcorp.atlassian.net/wiki/x/KIADMAE)

## 주요 섹션
- 개요
- 기획 의도
- 내용 요약
- 구현
- 연출
- 상세 기획
- 서버 탐험/침공 중 서버 이동이 발생하는 케이스
- 신규 리소스
