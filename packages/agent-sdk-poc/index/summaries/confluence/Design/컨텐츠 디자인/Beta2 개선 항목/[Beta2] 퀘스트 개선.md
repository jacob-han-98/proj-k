# [Beta2] 퀘스트 개선 (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/컨텐츠 디자인/Beta2 개선 항목/[Beta2] 퀘스트 개선/content.md

## 한 줄 설명
Beta2 버전에서 퀘스트 시스템의 자동 진행, 허드 표시, 수락 조건, 목록 정렬, 텔레포트, 포기 안내, 다이얼로그, 주간 탭, 그리고 인트로/무한의 탑 전용 퀘스트 등 8가지 주요 개선 사항을 정의한다.

## 핵심 용어
- QuestClass
- 자동 진행
- 허드(Hud)
- 메인 퀘스트
- 서브 퀘스트
- 일일 퀘스트(Daily)
- 주간 퀘스트
- 수락 조건
- 수락 가능
- 보상 획득
- 진행 중
- 완료
- 텔레포트
- NpcInteractionAccept
- 인트로 던전
- 무한의 탑(InfiniteTower)
- 월드
- 다이얼로그
- 시스템 메시지
- PlayerConditionEnum
- QuestCategoryEnum

## 숫자/상수/공식
- EnteredInFloor: 10 (PlayerConditionEnum Value)
- Intro: 4 (QuestCategoryEnum Value)
- InfiniteTower: 5 (QuestCategoryEnum Value)
- 우선 순위 1순위: 보상 획득 가능
- 우선 순위 2순위: 진행 중
- 우선 순위 3순위: 수락 가능
- 우선 순위 4순위: 수락 불가
- 우선 순위 5순위: 완료

## 참조 시스템
- (없음)

## 주요 섹션
- 자동 진행 개선
- 퀘스트 허드 개선
- 퀘스트 수락 조건 표시 개선
- �에스트 목록 표시 개선
- 퀘스트 찾아가기 및 텔레포트 개선
- 퀘스트 포기 개선
- 다이얼로그 개선
- 주간 퀘스트 탭 감추기
- 인트로 및 무한의 탑 전용 퀘스트 추가
