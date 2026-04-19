# [Beta3] 정령의 탑 컷신 재생 기능 추가 (요약)

> 출처: 컨텐츠 디자인 / Beta3 개선 항목 / [Beta3] 정령의 탑 컷신 재생 기능 추가
> 원본: packages/confluence-downloader/output/컨텐츠 디자인/Beta3 개선 항목/[Beta3] 정령의 탑 컷신 재생 기능 추가/content.md

## 한 줄 설명
정령의 탑 입장 시 정령 변신 컷신과 보스 등장 컷신을 1회씩 재생하고, 동행 정령의 등급별 외형을 컷신에 반영하는 기능을 추가한다.

## 핵심 용어
- 정령의 탑
- 컷신 재생
- 정령 변신(도깨비)
- 보스 등장 컷신
- PlayOnce
- InfiniteTowerCutscene
- CinematicTypeEnum
- Cinematic
- EnterCutscene
- EnterFloorCutscene
- CompanionDetailTypeEnum
- DetailType
- InfiniteTowerFloor
- InfiniteTowerScene
- 서브시퀀스
- 레벨 시퀀스
- 월드 입장
- 1회 재생
- 클라이언트 저장
- 연속 재생

## 숫자/상수/공식
- CinematicTypeEnum InfiniteTowerCutscene Value: 4
- PlayOnce 기본값: False
- 정령 타입별 컷신 재생: 1회씩
- 보스 등장 컷신: 층별 1대1 매칭
- 재생 순서: 정령 변신(도깨비) 등장 컷신 → 보스 등장 컷신

## 참조 시스템
- 무한의 탑 시스템
- Beta3 연출 컷신 제작

## 주요 섹션
- 개요
- 1. 컷신 종류
- 1.1. 탑 컷신 종류 및 특징
- 1.1.1. 정령 변신(도깨비) 등장 컷신
- 1.1.2. 보스 등장 컷신
- 1.2. 재생 방식
- 2. 컷신 구성
- 2.1. CinematicTypeEnum
- 2.2. Cinematic
- 3. 컷신 호출
- 3.1. InfiniteTower
- 4. 컷신 제작
- 4.1. 서브시퀀스 조건 추가
