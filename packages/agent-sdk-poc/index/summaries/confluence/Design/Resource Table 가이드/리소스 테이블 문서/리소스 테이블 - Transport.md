# 리소스 테이블 - Transport (요약)

> 출처: Design/Resource Table 가이드/리소스 테이블 문서
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Transport/content.md

## 한 줄 설명
NPC를 통한 이동(텔레포트) 시스템의 비용과 도착 위치를 정의하는 리소스 테이블. 화폐 종류/수량과 월드/볼륨 정보를 설정한다.

## 핵심 용어
- Transport
- NPC
- 텔레포트
- Id
- PopUpTextKey
- Currency
- CurrencyEnum
- CurrencyAmount
- ArrivalWorldId
- ArrivalVolume
- Land
- Teleport
- CinematicId
- Transport.xlsx
- VolumeTypeEnum_Teleport
- 이동 비용
- 도착 위치
- 월드
- 볼륨

## 숫자/상수/공식
- Id: int32 (양의 정수)
- CurrencyAmount: int32 (0 이상의 정수)
- ArrivalWorldId: int32
- ArrivalVolume: int32

## 참조 시스템
- Land 테이블
- CurrencyEnum

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- 새 Transport 추가하기
- 자주 하는 실수
- 트러블슈팅
