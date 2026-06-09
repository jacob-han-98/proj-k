# 리소스 테이블 - Pet (요약)

> 출처: PK / 리소스 테이블 - Pet
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Pet/content.md

## 한 줄 설명
펫(Pet) 시스템의 리소스 테이블을 정의하며, 펫의 등급·타입·능력치·강화·합성 규칙을 관리하는 문서다.

## 핵심 용어
- PetClass
- PetStatGroup
- PetComposeList
- PetGradeInfo
- PetEnchant
- PetType (Normal, Growth)
- Grade (Common, Rare, Epic)
- EnchantId
- BuffId
- StatGroupId
- CanEquip
- CanEnchant
- CanCompose
- MaxEnchantLv
- PetEnchantLv
- NeedEnchantExp
- UseGrade
- Prob
- AttackCategory (Melee, Range, Magic, All)
- EffectStatName
- EffectStatValue
- GetExp

## 숫자/상수/공식
- 합성 확률(Prob) 합: 같은 UseGrade 내 정확히 10,000
- PetEnchantLv 범위: 0 ~ 255
- MaxEnchantLv 범위: 0 ~ 255
- NeedEnchantExp 범위: 0 이상
- GetExp: 강화 재료로 사용 시 제공 경험치

## 참조 시스템
- Pet.xlsx (PetClass, PetStatGroup, PetComposeList, PetGradeInfo, PetEnchant)
- Buff 테이블

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전 (PetClass, PetStatGroup, PetComposeList, PetGradeInfo, PetEnchant)
- 새 펫 추가하기
- 실제 예시
- 자주 하는 실수
- 트러블슈팅
