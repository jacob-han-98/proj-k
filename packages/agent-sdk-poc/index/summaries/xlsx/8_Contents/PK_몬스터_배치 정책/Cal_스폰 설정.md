# Cal_스폰 설정 (요약)

> 출처: PK_몬스터_배치 정책 / Cal_스폰 설정
> 원본: packages/xlsx-extractor/output/8_Contents/PK_몬스터_배치 정책/Cal_스폰 설정/_final/content.md

## 한 줄 설명
특정 볼륨의 몬스터 스폰 설정을 계산하고 MonsterSpawnData를 자동 생성하기 위한 계산기 시트.

## 핵심 용어
- MonsterSpawn
- MonsterSpawnData
- SpawnVolumeID
- MonsterID
- 리전-볼륨 조정
- 볼륨 명
- 리전 명
- 리전 Tier
- 사냥터 유형
- 기본 전투 지역
- 점유 화면 수
- 볼륨 총 개체 수
- 몬스터 체크
- 기본 비율
- 상대 비율
- SpawnNumberMin
- SpawnNumberMax
- GuaranteeMinSpawnRatio
- RespawnPeriodMin
- RespawnPeriodMax
- SearchRange
- MoveRange

## 숫자/상수/공식
- 볼륨 사이즈 (Scale X): 8.5
- 볼륨 사이즈 (Scale Y): 8.5
- 점유 화면 수: 0.5 화면
- 볼륨 총 개체 수: 7개체
- 몬스터 A 기본 비율: 12.5%
- 몬스터 A 상대 비율: 43.8%
- 몬스터 A 개체 수: 3개체
- 몬스터 C 기본 비율: 16.1%
- 몬스터 C 상대 비율: 56.3%
- 몬스터 C 개체 수: 4개체
- WorldId: 12
- SpawnDirection: 0
- MoveRange: 1020
- SearchRange (A): 800
- SearchRange (B, C): 250
- RespawnPeriodMin: 11
- RespawnPeriodMax: 16
- SpawnNumberMin (A): 2
- SpawnNumberMax (A): 3
- SpawnNumberMin (B): 3
- SpawnNumberMin (C): 3
- SpawnNumberMax (C): 4

## 참조 시스템
- (없음)

## 주요 섹션
- 특정 볼륨의 Spawn 설정
- 리전 · 볼륨 조정
- 볼륨 내 사용 몬스터 체크
- 특정 볼륨 가 MonsterSpawnData
- MonsterSpawnData 테이블
