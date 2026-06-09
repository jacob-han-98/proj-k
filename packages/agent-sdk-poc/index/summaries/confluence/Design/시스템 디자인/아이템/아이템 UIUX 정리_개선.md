# 아이템 UIUX 정리/개선 (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/아이템/아이템 UIUX 정리_개선/content.md

## 한 줄 설명
Project K의 아이템(장비/소모품/재료) 정보 모달/팝업 UI 구성과 아이콘 표기 규칙, 동작 방식을 정의한 문서.

## 핵심 용어
- ItemEquipClass
- ItemConsumeClass
- ItemEtcClass
- 아이템 정보 모달
- 아이템 정보 팝업
- 귀속
- 강화 단계
- 티어 표기
- 레드닷
- 상위 스탯 표기
- 장착 표기
- 시간제(기간) 표기
- 거래 가능 표기
- 잠금 여부
- 아이콘 리소스
- 롱터치
- HUD
- 인벤토리 버튼 영역
- 장비 비교
- EnchantBonus
- EnchantRandom
- 분해
- 컬렉션
- 채팅 링크

## 숫자/상수/공식
- 롱터치 게이지: 0.5초
- 아이템 개수 표기: 1 이하 제외, 만 미만 전체 표기, 1만~1억 미만 '만' 단위, 1억 이상 '억' 단위
- 유효 일자 경고: 24시간 전부터 붉은 색 표기
- 기간 만료 아이템 우편 수령 기간: 7일
- 아이콘 위치별 정보 우선순위: 1(장착/상위스탯) > 2(레드닷/티어) > 3(시간제) > 4(강화단계) > 6(거래가능) > 7(잠금)

## 참조 시스템
- 박스 아이템 UIUX 정리/개선
- 아이템 툴팁 정보
- 인벤토리 UIUX 개선
- 아이템 분해_UI
- 장비 다중 강화_UI
- 장비 강화
- Mail 테이블
- CharacterClass 테이블
- ConsumeTypeEnum 테이블
- BuffClass 테이블
- EffectClass 테이블
- EnchantBonus 테이블
- TextKeyClass 테이블

## 주요 섹션
- 개요
- 공통 규칙
- 아이템 정보 모달/팝업
- Equip Class
- ItemConsumeClass
- ItemEtcClass
- 시스템 메시지
- 데이터
