# [Beta1] 캐릭터 충돌패스 구역 (요약)

> 출처: Confluence / Design > 컨텐츠 디자인 > Beta1 개선 항목
> 원본: packages/confluence-downloader/output/Design/컨텐츠 디자인/Beta1 개선 항목/[Beta1] 캐릭터 충돌패스 구역/content.md

## 한 줄 설명
특정 구역 진입 시 플레이어 캐릭터 간 컬리젼 충돌을 비활성화하여 밀집 지역의 길막힘을 해소하고 서버 부하를 감소시키는 기능.

## 핵심 용어
- 캐릭터 충돌패스 구역
- PlayerCollisionPass
- WorldTerritory 테이블
- 컬리젼 충돌
- 플레이어 캐릭터
- 충돌 비활성화 지역
- 비전투 지역 (safe)
- 충돌 무시 기능
- 마을
- 다리
- 밀집 지역
- 길막힘
- 시야 방해
- 컬리젼 이동
- 끌어오기 스킬
- NPC
- 오브젝트

## 숫자/상수/공식
- PlayerCollisionPass 디폴트값: FALSE
- TRUE: 플레이어 간 충돌처리하지 않음
- FALSE: 충돌처리 함

## 참조 시스템
- (없음)

## 주요 섹션
- 개요
- 기획 의도
- 테이블 대응
- 개발 처리 사항
- 예외 처리 사항
