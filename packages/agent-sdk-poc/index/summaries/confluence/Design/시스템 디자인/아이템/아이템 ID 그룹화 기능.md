# 아이템 ID 그룹화 기능 (요약)

> 출처: Confluence / Design/시스템 디자인/아이템/아이템 ID 그룹화 기능
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/아이템/아이템 ID 그룹화 기능/content.md

## 한 줄 설명
거래가능/창고 저장 여부에 따라 생성되는 동일한 아이템들을 대표 Group Id 하나로 묶어 컨텐츠에서 공통으로 관리하는 기능.

## 핵심 용어
- Group Id
- Class Id
- 귀속 유형
- 거래가능
- 창고 저장
- 캐릭터 귀속
- 서버 귀속
- 이벤트 한정 배포
- CanAuction
- CanStorage
- ItemEquipClass
- ItemConsumeClass
- ItemEtcClass
- ExpireTime
- 아이템 소모 규칙
- 접두어
- 컨텐츠 테이블
- 아이템 테이블

## 숫자/상수/공식
- Group Id 데이터 타입: int
- 아이템 소모 순서: ExpireTime 유효기간 있는 아이템 → CanAuction=FALSE(CanStorage=FALSE: 캐릭터귀속 → CanStorage=TRUE: 계정귀속) → CanAuction=TRUE(거래가능)
- 예시 Group Id: 1000, 1001, 1002, 1003 (동일 그룹)
- 예시 Group Id 표기: g1000, group_1000

## 참조 시스템
- (없음)

## 주요 섹션
- 개요
- 기본 규칙
- 아이템 그룹 구성 기준
- 그룹 ID 표기 및 활용
- 아이템 개별 ID와 그룹 ID의 병행 사용
- 아이템 소모 규칙
- 테이블
