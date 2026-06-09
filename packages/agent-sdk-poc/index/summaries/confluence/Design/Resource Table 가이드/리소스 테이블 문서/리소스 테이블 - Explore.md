# 리소스 테이블 - Explore (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Explore/content.md

## 한 줄 설명
탐험(크로스 월드) 시스템에서 서버별 몬스터 보상 보정, 탐험자 경험치/골드/아이템 드롭율 조정, 자동 수락 퀘스트를 정의하는 ExploreServer 테이블 가이드.

## 핵심 용어
- ExploreServer
- 탐험(크로스 월드)
- 원주민(NativeCoinBaseRatio)
- 탐험자(StrangerCoinBaseRatio)
- 코인 획득 확률
- 퍼밀 단위
- 만분율 단위
- 레벨 차이 보정
- 경험치 보정 비율(StrangerExpRatio)
- 골드 보정 비율(StrangerGoldRatio)
- 아이템 드롭율 보정(StrangerRewardRatio)
- 자동 수락 퀘스트(QuestId)
- 월드 ID
- 몬스터 보상 처리
- 파티 보너스

## 숫자/상수/공식
- 원주민 코인 확률 = NativeCoinBaseRatio + (몬스터 레벨 - 플레이어 레벨) × NativeCoinAdjustRatio (퍼밀 판정)
- 탐험자 코인 확률 = StrangerCoinBaseRatio + (몬스터 레벨 - 플레이어 레벨) × StrangerCoinEarningRatio (퍼밀 판정)
- 만분율 단위: 10000 = 100%, 5000 = 50%, 15000 = 150%
- 필수 컬럼 4개: NativeCoinBaseRatio, NativeCoinAdjustRatio, StrangerCoinBaseRatio, StrangerCoinEarningRatio (모두 0이 아닌 값)

## 참조 시스템
- Quest 테이블

## 주요 섹션
- 탐험 서버(ExploreServer) 테이블
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- 새 탐험 서버 설정 추가하기
- 실제 예시
- 자주 하는 실수
- 트러블슈팅
