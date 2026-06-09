# 리소스 테이블 - Raid (요약)

> 출처: PK / 리소스 테이블 - Raid
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Raid/content.md

## 한 줄 설명
보스 레이드 콘텐츠의 스케줄, 월드, 보스 몬스터, 입장 조건, 채널 관리를 정의하는 BossRaidClass 및 BossRaidCondition 테이블의 컬럼 사전 및 운영 가이드.

## 핵심 용어
- BossRaidClass
- BossRaidCondition
- 보스 레이드
- 인스턴스
- cron 표현식
- 입장 단계
- 전투 단계
- 채널
- 기여도
- 어그로
- 스폰 볼륨
- MonsterSpawn
- WorldClass
- MonsterClass
- PlayerConditionEnum
- GroupId
- ConditionId
- EntranceTime
- SpawnVolumeId
- CoordinateExit

## 숫자/상수/공식
- EndTime 최소값: 60초 (1분)
- StartTime 최소값: 1초
- SpawnTime 최소값: 0초
- EnterMaxCharacter 최소값: 1
- MaxChannel: 0이면 무제한, 1 이상이면 제한
- DayEnterMaxCount: 0이면 일일 제한 없음
- WeekEnterMaxCount: 0이면 주간 제한 없음
- CoordinateExit: 0이면 원래 위치로 복귀
- 퇴장 대기 시간: 약 5초

## 참조 시스템
- WorldClass (인스턴스 타입 월드)
- MonsterClass (보스 타입 몬스터)
- PlayerConditionEnum
- MonsterSpawn 볼륨

## 주요 섹션
- 보스 레이드 테이블
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- BossRaidClass 시트
- BossRaidCondition 시트
- 레이드 진행 흐름
- 새 보스 레이드 추가하기
- 자주 하는 실수
- 트러블슈팅
