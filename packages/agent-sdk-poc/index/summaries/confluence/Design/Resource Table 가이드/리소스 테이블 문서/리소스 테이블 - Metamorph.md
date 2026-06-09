# 리소스 테이블 - Metamorph (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Metamorph/content.md

## 한 줄 설명
캐릭터 변신 시스템의 능력치, 강화, 합성, 도감 보너스를 정의하는 리소스 테이블 모음. 변신(Metamorph)과 외형(Skin/Siege) 두 가지 유형을 구분하여 관리한다.

## 핵심 용어
- Metamorph (변신)
- Skin/Siege (외형)
- MetamorphClass
- MetamorphStatGroup
- MetamorphEnchant
- MetamorphGradeInfo
- MetamorphComposeList
- MetamorphPointStat
- Grade (등급)
- Enchant (강화)
- Compose (합성)
- StatGroupId
- EnchantId
- Attack01, Attack02
- Invoke01~04
- Skill01~08
- BuffId
- BonusEnum
- GradeEnum
- MetamorphTypeEnum
- EquipPartsEnum
- AssetName
- NeedEnchantExp
- ProbAdjust
- UseGrade
- ClassId

## 숫자/상수/공식
- MetamorphEnchantLv 유효 범위: 0 ~ 20
- MetamorphStatGroup 최대 능력치 슬롯: 10개
- MetamorphEnchant 최대 능력치 슬롯: 10개
- MetamorphClass 기본 공격 스킬: 2개 (Attack01, Attack02)
- MetamorphClass 발동 스킬: 4개 (Invoke01~04)
- MetamorphClass 보유 스킬: 8개 (Skill01~08)
- 강화 확률 판정: EnchantProb + ProbAdjust
- 등급 그룹: Rare (Common, Uncommon, Rare), Unique, Legendary (Legendary, Myth)

## 참조 시스템
- 스킬(Skill) 테이블
- 버프(Buff) 테이블
- SkillClass
- BuffClass

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 카테고리 페이지 매핑
- 카테고리별 컬럼 사용 매트릭스
- MetamorphClass
- MetamorphStatGroup
- MetamorphEnchant
- MetamorphGradeInfo
- MetamorphComposeList
- MetamorphPointStat
