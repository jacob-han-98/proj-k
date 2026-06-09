# 리소스 테이블 - Obstacle (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Obstacle/content.md

## 한 줄 설명
월드에 배치되는 장애물(Obstacle)의 형태를 정의하는 리소스 테이블로, 장애물 기본 정보와 꼭짓점 좌표로 구성되어 볼록 다각형 형태로 생성된다.

## 핵심 용어
- Obstacle
- ObstacleClass
- ObstaclePoint
- Convex Polygon
- 꼭짓점 좌표
- Id
- X 좌표
- Y 좌표
- direction
- scale
- Comment
- NameDesc_Kr
- 볼록 다각형
- 오목한 형태
- 꼬인 형태

## 숫자/상수/공식
- Id: int32 (1 이상의 정수)
- X: int32 (꼭짓점의 X 좌표)
- Y: int32 (꼭짓점의 Y 좌표)
- 최소 꼭짓점 개수: 3개 이상
- 예시 정사각형: 100x100 크기 (좌표 범위 -50 ~ 50)

## 참조 시스템
- ObstacleClass.xlsx
- ObstaclePoint.xlsx

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- 새 장애물 추가하기
- 실제 예시
- 자주 하는 실수
- 트러블슈팅
