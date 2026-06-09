# 리소스 테이블 - Collection (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Collection
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Collection/content.md

## 한 줄 설명
특정 아이템을 모아서 등록하면 능력치 보너스를 얻는 컬렉션(도감) 시스템의 데이터 테이블 정의 및 운영 가이드.

## 핵심 용어
- ItemCollectionClass
- ItemCollectionGroupClass
- 컬렉션(Collection)
- 완성 보너스(EffectStatName/Value)
- 부분 보너스(PartialEffectStatName/Value)
- TargetItem01~06
- ItemCount01~06
- PartialCount
- 아이템 표현식(Item Expression)
- CollectionCategoryEnum
- CollectionCategoryGroupEnum
- BonusEnum
- 슬롯(Slot)
- 강화수치(Enhancement Level)
- 아이템 그룹(Item Group)
- Category (Equipment / Collectable / Achievement / Skill / Event)
- 무결성 검사(Integrity Check)

## 숫자/상수/공식
- 최대 슬롯 수: 6개
- EffectStatName 최대 개수: 3개
- PartialEffectStatName 최대 개수: 2개
- 슬롯 인덱스 유효 범위: 0~5
- PartialCount 유효 범위: 0 (부분 보너스 없음) 이상

## 참조 시스템
- Collection.xlsx (ItemCollectionClass, ItemCollectionGroupClass 시트)
- Item 테이블 (아이템 참조)

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전 — ItemCollectionClass
- 전체 컬럼 사전 — ItemCollectionGroupClass
- 새 컬렉션 추가하기
- 자주 하는 실수
- 트러블슈팅
