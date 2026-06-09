# [Beta3] 퀘스트 개선 (요약)

> 출처: Confluence / Design/컨텐츠 디자인/Beta3 개선 항목/[Beta3] 퀘스트 개선
> 원본: packages/confluence-downloader/output/Design/컨텐츠 디자인/Beta3 개선 항목/[Beta3] 퀘스트 개선/content.md

## 한 줄 설명
Beta3 버전에서 일일 퀘스트, 서브 퀘스트, 공통 퀘스트 시스템의 UI/UX 개선 및 신규 퀘스트 목표 타입 추가를 정의하는 문서.

## 핵심 용어
- 일일퀘스트 (Daily Quest)
- 서브퀨스트 (Sub Quest)
- 메인퀘스트 (Main Quest)
- 퀘스트 목표 (PlayerObjective)
- KillMonster
- CollectItem
- ObjectInteraction
- 보상 모두 받기
- 텔레포트
- 미니맵
- 월드맵
- 다이얼로그
- 스킵 버튼
- 퀘스트 카테고리
- 탭 잠금
- 권장 난이도
- 허드 (HUD)
- 자동 진행
- 파티 공유
- 가방 처리
- 초과 수락

## 숫자/상수/공식
- 텔레포트 거리 조건: 50M 미만 시 도보 이동
- 보상 모두 받기 조건: 진행 완료 퀘스트 2개 이상 (선택/랜덤 보상 제외)
- 일일 퀘스트 정렬 규칙: 보상 획득 가능 > 진행 중 > 수락 가능 > 완료 (동일 순위 시 ID순)
- 몬스터 헤드 표시 우선순위: Main(1순위) > Sub(2순위) > Daily(3순위) > Intro/InfiniteTower/AttackServer/ExploreServer(4순위)
- PlayerObjectiveEnum 신규 추가: Equip(10), StatPointUse(11), KillOtherServerPlayer(12)

## 참조 시스템
- QuestPrerequisite
- QuestCategory
- MaxRefreshCount
- MaxRechargeCount
- MaxRechargeCostType
- RechargeCost
- MaxAccept
- MaxComplete
- DailyResetTime
- BattleObjectTypeEnum
- EquipTypeEnum
- EquipPartEnum
- ContentsType (SubQuest=23, DailyQuest=24)

## 주요 섹션
- 개선: 일일 퀘스트
- 개선: 서브 퀘스트
- 개선: 퀘스트 공통
- 신규: 퀘스트 타입
- 다이얼로그 개선
- 탭 잠금 추가
