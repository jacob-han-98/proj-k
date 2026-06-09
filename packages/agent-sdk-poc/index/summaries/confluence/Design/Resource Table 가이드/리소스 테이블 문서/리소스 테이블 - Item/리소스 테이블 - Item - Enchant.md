# 리소스 테이블 - Item - Enchant (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Item/리소스 테이블 - Item - Enchant/content.md

## 한 줄 설명
장비 아이템을 강화하여 추가 능력치를 부여하는 시스템으로, 강화 단계별 확률/비용, 추가 능력치, 랜덤 옵션을 정의하는 3개 시트(Enchant, EnchantBonus, EnchantRandom)로 구성된다.

## 핵심 용어
- Enchant
- EnchantBonus
- EnchantRandom
- EnchantId
- EnchantBonusId
- EnchantLv
- SuccessProb
- PreserveProb
- BlessedSuccessProb01
- BlessedSuccessProb02
- BlessedSuccessProb03
- BlessedPreserveProb
- GoldPrice
- Broadcasting
- EnchantRandomGroup
- EffectStatName
- EffectStatValue
- BonusEnum
- GroupId
- CanEnchant
- 일반 강화
- 축복 강화
- 저주 강화
- 안전 강화

## 숫자/상수/공식
- SuccessProb: 만분율 (10000 = 100%)
- PreserveProb: 만분율 (10000 = 100%)
- BlessedPreserveProb: 만분율 (10000 = 100%)
- BlessedSuccessProb01/02/03: 가중치 (상승량 +1, +2, +3 결정)
- EnchantLv: 1부터 시작, 연속 필수
- GoldPrice: 0 이상 (음수 불가)
- EffectStatName/Value: 최대 6개 능력치 쌍
- 저주 강화: 강화 수치 -1 (항상 성공, 확률 판정 없음)
- SuccessProb ≥ 10000: 안전 강화 (실패 없음)

## 참조 시스템
- equip.md (장비 아이템 설정)

## 주요 섹션
- 개요
- Enchant 시트
- EnchantBonus 시트
- EnchantRandom 시트
- 새 강화 테이블 추가하기
- 실제 예시
- 자주 하는 실수
- 트러블슈팅
