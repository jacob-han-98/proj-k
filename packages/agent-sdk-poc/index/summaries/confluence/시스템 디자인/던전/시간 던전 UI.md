# 시간 던전 UI (요약)

> 출처: 시스템 디자인 / 던전 / 시간 던전 UI
> 원본: packages/confluence-downloader/output/시스템 디자인/던전/시간 던전 UI/content.md

## 한 줄 설명
시간 제한 방식의 던전 콘텐츠에 대한 UI 구조 및 화면 설계 명세. 던전 진입부터 층 선택, 시간 충전, 입장까지의 전체 플로우를 정의한다.

## 핵심 용어
- 시간 던전 (TimeDungeon)
- 던전 층 정보 (TimeDungeonLevelInfo)
- 던전 전제조건 (TimeDungeonPrerequisite)
- 기본 시간 (FreePlayTime)
- 충전 시간 (RechargedPlayTime)
- 초기화 시간 (ResetTime)
- 2뎁스 형태
- 나이트크로우식 레이아웃
- 안전/자유/위험 (ZoneType)
- 보스 보상 (BossRewardList)
- 주요 보상 (NormalRewardList)
- 입장료 (CostCurrencyType, CostCurrencyAmount)
- 입장 아이템 (CostItemType, CostItemAmount)
- 충전 아이템 (RechargeItem)
- 언락 조건 (PrerequisiteId)
- 잠금 아이콘
- 딤처리 (비활성화)
- 던전 나가기 버튼
- 던전 퇴장 팝업

## 숫자/상수/공식
- 남은 시간 = {FreePlayTime} - {유저가 사용한 시간}
- 남은 시간 = {RechargedPlayTime} - {유저가 사용한 시간}
- 다음 ResetTime - 현재 시간 계산 결과
- 초 단위까지 표시 (기본/충전 시간)
- 초 단위는 생략, 1분 미만인 경우 <0 으로 표시
- 0인 결과는 표시하지 않음
- 최소 수량 = 1개
- HH:MM:SS 형태 (잔여 충전 시간)
- "+" HH:MM:SS 형태 (충전 시간)

## 참조 시스템
- 시간 던전 시스템
- 컬렉션 UI
- ItemConsumeClass 테이블

## 주요 섹션
- UX 의도
- 화면 구성
- UI 시안
- 화면 설명
- 진입 경로
- 던전 메인 화면
- 상단 영역
- 상단 탭 / 던전 항목 (시간제)
- 던전 층 정보 (시간제형 던전)
- 좌측 탭 영역 (층 선택)
- 던전 층 정보 영역
- 시간 충전 / 입장 버튼
- 시간 충전 팝업
- 던전 내부
