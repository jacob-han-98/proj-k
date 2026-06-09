# 정령의 탑 UI (요약)

> 출처: Design / 시스템 디자인 / 던전 / 정령의 탑 UI
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/던전/정령의 탑 UI/content.md

## 한 줄 설명
무한의 탑(InfiniteTower) 던전 콘텐츠의 입장 전, 전투 중, 클리어 후 전체 UI 화면 구성 및 상호작용 규칙을 정의한 기획 문서.

## 핵심 용어
- InfiniteTower (무한의 탑)
- 정령의 탑
- 도깨비 (Companion)
- 버프 보상 (BuffReward)
- 클리어 보상 (ClearReward)
- 클리어 방식 (ClearType)
- 섬멸전
- 방어전
- 공격전
- 보스전
- 고유 효과 (CharacteristicEffect)
- 랭킹 (Ranking)
- 시즌 (Season)
- 전투력 (CombatPoint)
- 입장 횟수 (WeeklyEntranceMaxCount)
- 적용 버프 (ActiveBuff)
- 도전 상태
- 층 (Floor)
- 퀘스트 (Quest)

## 숫자/상수/공식
- 1층~100층 (총 100개 층)
- 최대 100위 랭킹 정보 출력
- 클리어 보상 최대 8.5개 노출 (좌우 스크롤)
- 버프 보상 최대 4.5개 노출 (상하 스크롤)
- 고유 효과 최대 3개 표현 (초과 시 스크롤)
- 랭킹 보상 최대 4.5개 노출 (좌우 스크롤)
- 버프 보상 선택 UI 자동 선택 시간: 10초
- 다음 층 입장 버튼 자동 사용 시간: 10초
- 클리어 실패 시 자동 나가기 시간: 10초
- 클리어 시간 표기: 분:초 (소숫점 둘째자리)
- 랭킹 갱신 간격: BoardRefreshInterval (60초 단위 권장)

## 참조 시스템
- 시간 던전 UI
- 정령의 탑 시스템
- 정령 시스템_UI
- 월드 이벤트 시스템 UI
- PK_아이템 및 기타 아이콘_요청서.xlsx

## 주요 섹션
- UX 의도
- 진입 경로
- 입장 전 (메인 UI)
- 입장 후 (대기 지역, 전투 시작, 전투 중, 클리어 성공, 클리어 실패, 버프 보상 선택, 나가기)
- 랭킹 정보 / 보상 정보
- 클리어 방식 팝업 UI
- 적용 중인 버프 정보 UI
- 랭킹 팝업 UI
- 랭킹 보상 팝업 UI
