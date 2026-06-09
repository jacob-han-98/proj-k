# HUD UIUX 개선 (요약)

> 출처: PK / HUD UIUX 개선
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/HUD/HUD UIUX 개선/content.md

## 한 줄 설명
HUD 시스템의 UI/UX 개선 사항을 정리한 문서로, 21개 항목의 위치 변경, 기능 추가, 디자인 수정 및 메뉴 시스템 재구성을 정의한다.

## 핵심 용어
- HUD (Heads-Up Display)
- WBP_MainHud
- 퀵슬롯 (QuickSlot)
- 미니맵 (Minimap)
- 월드 보스 알람 (WBP_BossRaidAlarm)
- 컨텐츠 알림 그룹
- 장비 추천 (WBP_Equipn_Notification)
- 미니 채팅 (WBP_SmallChat)
- 전투력 정보 (WBP_CombatScoreSystem)
- 자동 이동 정보 (WBP_Quest_Auto_Move)
- 마을 귀환 팝업
- WBP_Menu
- MainMenu 테이블
- MainMenuCategoryEnum 테이블
- AutoUse (자동 사용)
- RTL 정렬 (Right-to-Left)
- 레이어 우선순위
- 시스템 메시지 (SYSMS)
- TextKey
- 레드닷 (Redot)

## 숫자/상수/공식
- 21개 개선 항목
- 퀵슬롯 8개 슬롯 (1~8 숫자키)
- 퀵슬롯 확장 상태: 1줄(1~8), 2줄(Ctrl+1~8), 3줄(Shift+1~8)
- 시간 표시 형식: HH:MM:SS
- 경고 색상 기준: 5분 이하
- 붉은 색상 기준: 1분 이하
- MainMenu 테이블 카테고리: Header, ScrollBody, Footer
- ScrollBody 그리드 최대 5칸
- MainMenu 테이블 예시 Id: 101~304
- MainMenuCategoryEnum 예시 CategoryGroup: 100, 200, 300

## 참조 시스템
- HUD 기능적 레이아웃 구성 (문서)
- 가까운 마을로 귀환 기능 (섹션)
- 컨텐츠 오픈 조건 표기 방식 (Confluence 페이지 4929945617)

## 주요 섹션
- 개선 리스트
- WBP_MainHud
- Top-Left (귀환 버튼, 파티 생성 버튼, 미니맵, 던전 나가기, 월드 보스 알람)
- Top-Center (컨텐츠 알림 그룹, 지역 정보)
- Top-Right (사망 복구 버튼)
- Middle-Center (장비 추천, 미니 채팅, 전투력 정보, 자동 이동 정보)
- Bottom-Center (퀵슬롯)
- Bottom-Right (타겟 공유, 스캔, PVP, 상호 작용, 타겟 변경, 자동 사냥, 궁극기)
- 마을 귀환 팝업
- WBP_Menu (Header, ScrollBody, Footer 영역)
- MainMenu 테이블
- MainMenuCategoryEnum 테이블
