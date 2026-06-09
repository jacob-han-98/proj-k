# 리소스 테이블 - Intro (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Intro
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Intro/content.md

## 한 줄 설명
캐릭터 생성 후 최초 진입(인트로) 시나리오를 직업별로 정의하는 테이블로, 인트로 시작 위치, 진행 퀘스트 체인, 종료 후 이동 위치를 설정한다.

## 핵심 용어
- IntroSetting 테이블
- IntroSetting.xlsx
- CharacterClassEnum
- ClassEnum
- IntroLandId
- IntroVolumeId
- IntroStartQuestId
- IntroEndQuestId
- IntroEndTeleportWorld
- IntroEndTeleportVolume
- Land
- Volume
- PlayerSpawn
- Quest
- NextQuest
- Intro 카테고리
- 퀘스트 체인
- 직업별 인트로 설정
- 에러 검증

## 숫자/상수/공식
- Id: int32 (sc), 1 이상의 정수
- ClassEnum 유효값: Guardian, Warrior, Archer, Arbalester, Magician, Shaman
- IntroLandId: int32 (sc)
- IntroVolumeId: int32 (s)
- IntroStartQuestId: int32 (sc)
- IntroEndQuestId: int32 (sc)
- IntroEndTeleportWorld: int32 (s)
- IntroEndTeleportVolume: int32 (s)

## 참조 시스템
- Land 테이블
- Quest 테이블
- CharacterClassEnum (Enum 정의 문서)

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- Enum 참조
- 전체 컬럼 사전
- 새 인트로 설정 추가하기
- 자주 하는 실수
- 트러블슈팅
