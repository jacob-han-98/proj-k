# 아이템 ID 그룹화 기능 (요약)

> 출처: 시스템 디자인 / 아이템 / 아이템 ID 그룹화 기능
> 원본: packages/confluence-downloader/output/시스템 디자인/아이템/아이템 ID 그룹화 기능/content.md

## 한 줄 설명
동일한 기능을 가진 귀속/비귀속 아이템들을 대표 ID 하나(Group Id)로 묶어 컨텐츠에서 일괄 처리하는 기능.

## 핵심 용어
- Group Id
- Class Id
- ItemEquipClass
- ItemConsumeClass
- ItemEtcClass
- 거래가능
- 서버 귀속
- 캐릭터 귀속
- 이벤트 한정 배포
- 아이템 그룹 구성
- 접두어
- 컨텐츠 테이블
- 제작 시스템
- 컬렉션
- 아이템 개별 ID
- 귀속 유형
- 동일한 외형
- 동일한 기능
- 동일한 명칭
- 서버 에러 처리

## 숫자/상수/공식
- GroupId 데이터 타입: int
- 예시 아이템 ID: 1000, 1001, 1002, 1003
- 예시 그룹 ID: 1000 (대표 ID)
- 예시 그룹 표기: g1000, group_1000

## 참조 시스템
- (없음)

## 주요 섹션
- 개요
- 기본 규칙
- 테이블
