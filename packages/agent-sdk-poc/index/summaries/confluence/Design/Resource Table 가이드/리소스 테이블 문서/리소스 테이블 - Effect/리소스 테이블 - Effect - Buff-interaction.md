# 리소스 테이블 - Effect - Buff-interaction (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Effect
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Effect/리소스 테이블 - Effect - Buff-interaction/content.md

## 한 줄 설명
버프 연동 Effect 카테고리(AddBuffStack, ValuePerBuffStack, ValuePerBuffStackRef, BuffEnhance, BuffEnhanceByBuffStack)의 설정 방법과 검증 규칙을 정의한다.

## 핵심 용어
- AddBuffStack
- ValuePerBuffStack
- ValuePerBuffStackRef
- BuffEnhance
- BuffEnhanceByBuffStack
- 버프 중첩 수
- BaseValue
- BuffStackNum
- BuffStack
- ClassId
- ValuePerStack
- BuffProb
- BuffDuration
- BarrierMaxHP
- BonusEnum
- Effect/Value 슬롯
- Resource
- 보너스 배수
- 보정 배수

## 숫자/상수/공식
- 보너스 배수 = 현재 버프 중첩 수 / BuffStack
- 실제 보너스 = 설정한 능력치 값 × 보너스 배수
- 보정 배수 = 참조 버프의 현재 중첩 수 / ValuePerStack
- 버프 보정량 = 설정한 보정치 × 보정 배수
- BuffStackNum: 양수면 증가, 음수면 감소
- BuffStackNum: 0이 아닌 값 필수
- BuffStack: 0보다 큰 값 필수

## 참조 시스템
- (없음)

## 주요 섹션
- AddBuffStack
- ValuePerBuffStack
- ValuePerBuffStackRef
- BuffEnhance
- BuffEnhanceByBuffStack
- 트러블슈팅
