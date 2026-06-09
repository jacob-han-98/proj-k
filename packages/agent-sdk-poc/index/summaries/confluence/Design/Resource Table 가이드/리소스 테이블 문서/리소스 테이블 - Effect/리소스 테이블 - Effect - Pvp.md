# 리소스 테이블 - Effect - Pvp (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Effect/리소스 테이블 - Effect - Pvp/content.md

## 한 줄 설명
PvP 환경에서 플레이어가 받는 피해를 같은 길드 파티원에게 분산시키는 DividePvpDamge 이펙트의 설정 및 동작 방식을 정의한다.

## 핵심 용어
- DividePvpDamge
- DividePvpDamage
- PvP Effect
- BonusEnum
- DividePvpDamage_MaxTarget
- DividePvpDamage_Radius
- DividePvpDamage_HpRatioLowerBound
- DividePvpDamage_Ratio
- 피해 분산
- 길드 파티원
- 반경
- HP 비율
- 만분율
- Resource
- Category
- Effect/Value 슬롯
- 시각 효과 에셋

## 숫자/상수/공식
- DividePvpDamage_HpRatioLowerBound: 0 < 값 ≤ 10000 (만분율)
- DividePvpDamage_Ratio: 0 < 값 ≤ (10000 / MaxTarget) (만분율)
- DividePvpDamage_MaxTarget: 값 > 0
- DividePvpDamage_Radius: 값 > 0
- 분산 피해 = 총 피해 × (Ratio / 10000)
- 원래 대상 피해 = 총 피해 - 분산된 피해

## 참조 시스템
- (없음)

## 주요 섹션
- PvP Effect
- DividePvpDamge
- 설정할 컬럼
- 필요한 BonusEnum 설정
- 동작 원리
- 자주 하는 실수
- 트러블슈팅
