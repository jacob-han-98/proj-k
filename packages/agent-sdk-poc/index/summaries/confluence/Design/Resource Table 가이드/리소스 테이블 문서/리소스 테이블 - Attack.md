# 리소스 테이블 - Attack (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Attack/content.md

## 한 줄 설명
월드 습격(World Attack) 이벤트를 정의하는 리소스 테이블로, 특정 몬스터 처치 시 확률적으로 발동되는 보스 습격 이벤트의 전체 진행 흐름과 파라미터를 명시한다.

## 핵심 용어
- Attack 테이블
- AttackServer 시트
- World Attack (월드 습격)
- TargetMonsterId
- SpawnWaitMonsterId
- SpawnMonsterId
- SpawnProb
- SpawnDelayTime
- SpawnHoldTime
- AreaRadius
- ClearDelayTime
- Monster 테이블
- ContentSetting
- Buff
- 발동 판정
- 대기 단계
- 전투 단계
- 영역 이탈
- 재진입

## 숫자/상수/공식
- SpawnProb: 천분율(‰) 단위, 0 ~ 1000 범위 (1000 = 100% 발동)
- 전체 최대 지속 시간 = SpawnDelayTime + SpawnHoldTime
- SpawnDelayTime, SpawnHoldTime, ClearDelayTime: 밀리초 단위

## 참조 시스템
- Monster 테이블
- Quest 테이블 (추정)
- ContentSetting
- Buff 테이블

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- 이벤트 진행 흐름
- 새 습격 이벤트 추가하기
- 자주 하는 실수
- 트러블슈팅
