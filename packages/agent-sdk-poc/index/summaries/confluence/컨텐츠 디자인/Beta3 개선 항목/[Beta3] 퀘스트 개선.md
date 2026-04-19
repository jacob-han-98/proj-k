# [Beta3] 퀘스트 개선 (요약)

> 출처: 컨텐츠 디자인 / Beta3 개선 항목 / [Beta3] 퀘스트 개선
> 원본: packages/confluence-downloader/output/컨텐츠 디자인/Beta3 개선 항목/[Beta3] 퀘스트 개선/content.md

## 한 줄 설명
Beta3 버전에서 일일 퀘스트, 서브 퀘스트, 공통 퀘스트 시스템의 UI/UX 개선 및 신규 퀘스트 목표 타입 추가를 정의하는 기획 문서.

## 핵심 용어
- 일일퀘스트 (Daily Quest)
- 서브퀘스트 (Sub Quest)
- 메인퀘스트 (Main Quest)
- 퀘스트 목표 (PlayerObjective)
- 보상 모두 받기
- 텔레포트
- 미니맵 표시
- 월드맵 표시
- 몬스터 헤드 표시
- 퀘스트 수락 조건 (QuestPrerequisite)
- 선택 보상 (Select Reward)
- 랜덤 보상 (Random Reward)
- 목표 갱신 (Refresh)
- 완료 개수 충전 (Recharge)
- 파티 카운트 공유
- 가방 처리 (Inventory)
- 서버 탐험/침공 (ExploreServer/AttackServer)
- 정령의 탑 (InfiniteTower)
- 인스턴스 던전

## 숫자/상수/공식
- 텔레포트 거리 조건: 50M 미만 시 도보 이동
- 보상 모두 받기 조건: 진행 완료 퀘스트 2개 이상 (선택/랜덤 보상 제외)
- 일일 퀘스트 레벨 표시: "{0}레벨." (TextKey: Quest_Level)
- 완료 가능 개수 표시: "완료 가능개수 {0}/{1}" (TextKey: Quest_MaxCompleteCount)
- 초과 수락 안내: "수락 개수를 초과하였습니다. {0}개까지 동시 수락 가능합니다." (TextKey: Quest_AcceptLimit)
- 가방 부족 메시지: "가방 내 공간이 충분하지 않습니다." (TextKey: Inventory_NotEnoughSlot)
- 텔레포트 불가 메시지: "마법의 힘으로 제약되어 있어 텔레포트할 수 없습니다." (TextKey: Teleport_Disable)
- 짧은 거리 이동 메시지: "거리가 짧아 도보로 이동합니다." (TextKey: Teleport_ShortDistance)
- 퀘스트 타입 우선순위: Main(1순위) > Sub(2순위) > Daily(3순위) > Intro/InfiniteTower/AttackServer/ExploreServer(4순위)
- 퀘스트 상태 정렬 우선순위: 보상 획득 가능(1순위) > 진행 중(2순위) > 수락 가능(3순위) > 완료(4순위)

## 참조 시스템
- (없음)

## 주요 섹션
- 개요
- 개선 항목
- 신규 추가 항목
- 1. 개선: 일일 퀘스트
- 2. 개선: 서브 퀘스트
- 3. 개선: 퀘스트 공통
- 4. 신규: 퀘스트 타입
