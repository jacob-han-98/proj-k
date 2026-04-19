# [Beta3] 정령의 탑 섬멸전 웨이브 스폰 (요약)

> 출처: 컨텐츠 디자인 / Beta3 개선 항목
> 원본: packages/confluence-downloader/output/컨텐츠 디자인/Beta3 개선 항목/[Beta3] 정령의 탑 섬멸전 웨이브 스폰/content.md

## 한 줄 설명
정령의 탑 섬멸전의 웨이브 스폰 데이터 작업 효율화를 위해 신규 InfiniteTowerSpawn 테이블을 도입하고, WaveNumber와 WaveDelay 컬럼을 추가하여 기존 트리거 기반 시스템을 통합하는 개선안을 정의한다.

## 핵심 용어
- 정령의 탑
- 섬멸전
- 공격전
- 방어전
- 보스전
- 웨이브
- InfiniteTowerSpawn
- MonsterSpawn
- WaveNumber
- WaveDelay
- SpawnVolumeId
- InfiniteTowerFloor
- QuestTriggerSpawn
- WorldId
- MonsterId
- SpawnNumber
- SpawnDirection

## 숫자/상수/공식
- WaveNumber=1: 정령의 탑 시작 딜레이 이후 스폰
- WaveNumber>1: 이전 웨이브(WaveNumber-1) 처치 완료 OR WaveDelay 시간 경과 시 스폰 (OR 조건)
- 현재 섬멸전 최대 웨이브: 3개
- 30층 기준 섬멸전 층수: 15층
- 기존 방식 필요 볼륨 데이터: 최소 45개 (15층 × 3웨이브)
- WaveDelay 단위: 초(s)

## 참조 시스템
- https://bighitcorp.atlassian.net/wiki/x/GwBkTAE
- https://bighitcorp.atlassian.net/wiki/x/JoAiTAE
- https://bighitcorp.atlassian.net/wiki/x/GQRDVAE
- MonsterClass
- MonsterSpawn.xlsx

## 주요 섹션
- 개요
- 배경 및 현황
- 정령의 탑 데이터 작업
- 추가적인 문제점
- 개선 방향
- InfiniteTower 내 InfiniteTowerSpawn 테이블 추가
- 테이블 예시
- 신규 테이블을 활용한 데이터 작업 예시
