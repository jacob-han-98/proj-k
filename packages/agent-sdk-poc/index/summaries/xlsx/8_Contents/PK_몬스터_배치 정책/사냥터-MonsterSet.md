# 사냥터-MonsterSet (요약)

> 출처: PK_몬스터_배치 정책 / 사냥터-MonsterSet
> 원본: packages/xlsx-extractor/output/8_Contents/PK_몬스터_배치 정책/사냥터-MonsterSet/_final/content.md

## 한 줄 설명
사냥터 내 몬스터 배치의 기준을 정의하는 문서로, 필드 유형별 적정 개체 수, 스폰 주기, 몬스터 타입 비중 설정을 통해 전체 사냥터 구성을 결정한다.

## 핵심 용어
- 사냥터-MonsterSet
- 화면 (오토 영역)
- 몬스터 개체
- 필드 유형
- 포지션 타입
- 사냥터 유형
- Tier
- 몬스터 타입
- 스폰 볼륨 (Volume)
- SpawnPeriod
- RespawnPeriod
- GuaranteeMinSpawnRatio
- MoveRange
- SearchRange
- 개활지
- 실내
- 파티 사냥터
- 레이드 필드
- 퀘스트 지역
- 기본 전투 지역
- 핫스팟
- 보스존
- VolumeScale
- 화면 대비율

## 숫자/상수/공식
- 화면 내 적정 동시 사냥 유저 수: 4인 (기본)
- 화면 내 적정 몬스터 개체: 15개체 (중~중대형 기준)
- 화면 내 총 개체: 약 20개체 (유저 4인 + 몬스터 15개체)
- 저위 이벤트 사냥터: MinAmount 16, MaxAmount 20
- 일반 필드 (개활지): MinAmount 12, MaxAmount 15
- 일반 필드 (실내): MinAmount 8, MaxAmount 11
- 고위 파티 사냥터: MinAmount 4, MaxAmount 7
- 레이드 필드: MinAmount 1, MaxAmount 3
- 퀘스트 지역 몬스터 개체 수 보정: 90%
- 기본 전투 지역 몬스터 개체 수 보정: 100%
- 핫스팟 몬스터 개체 수 보정: 120%
- 보스존 몬스터 개체 수 보정: 85%
- 퀘스트 지역 플레이어 수 보정: 115%
- 기본 전투 지역 플레이어 수 보정: 100%
- 핫스팟 플레이어 수 보정: 85%
- 퀘스트 지역 SpawnPeriod 보정: 80%
- 기본 전투 지역 SpawnPeriod 보정: 80%
- 핫스팟 SpawnPeriod 보정: 60%
- 보스존 SpawnPeriod 보정: 80%
- SpawnPeriod 기준: 80%
- 최대 유지 리스폰 타임 공식: (화면 개체수 / 화면 인원수) × 사냥 속도
- Scale 1x1 기준: 0.15 화면
- MoveRange 기준: Scale 1 : 120
- SearchRange (근거리/원거리 후공): 250
- SearchRange (근거리/원거리 선공): 800
- SpawnNumberMin: 기준 개체 수의 90%
- SpawnNumberMax: 기준 개체 수의 110%

## 참조 시스템
- 비Stat_몬스터 타입 (필드 몬스터 타입 설정)
- 공간 정의 (전투 공간)

## 주요 섹션
- 사냥터 - 몬스터 셋 조합 기준
- 리전 - 몬스터 배치
- 필드 기본 설정 확인
- 사냥터 유형별 Spawn 기준점 설정
- 사냥터별 Volume 분할
- Volume내 몬스터별 비중 설정
- SpawnData 생성
