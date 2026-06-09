# 리소스 테이블 - Metamorph - Base (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Metamorph/리소스 테이블 - Metamorph - Base/content.md

## 한 줄 설명
Metamorph 타입의 전투용 변신 리소스 테이블 설정 가이드. 능력치, 강화, 기본 공격, 스킬, 버프를 포함한 완전한 변신 정의 방법을 명시한다.

## 핵심 용어
- Metamorph
- MetamorphClass
- MetamorphStatGroup
- MetamorphEnchant
- MetamorphGradeInfo
- MetamorphComposeList
- MetamorphPointStat
- Type
- Grade
- StatGroupId
- EnchantId
- UseWeapon
- Attack01
- Attack02
- Invoke01~04
- Skill01~08
- BuffId
- AssetName
- MetamorphEnchantLv
- NeedEnchantExp
- ProbAdjust
- EffectStatName
- EffectStatValue
- UseGrade

## 숫자/상수/공식
- MetamorphEnchantLv 범위: 0~20
- 성공 확률 = MetamorphGradeInfo의 EnchantProb + MetamorphEnchant의 ProbAdjust
- 예시: Grade=Rare, StatGroupId=1, EnchantId=1, Attack01=5001, Attack02=5002
- 예시 강화 단계: Lv0(NeedEnchantExp=0), Lv5(NeedEnchantExp=500), Lv10(NeedEnchantExp=1500)

## 참조 시스템
- MetamorphGradeInfo
- MetamorphStatGroup
- MetamorphEnchant
- MetamorphComposeList
- MetamorphPointStat
- 스킬 테이블

## 주요 섹션
- 변신 (Metamorph 타입)
- 설정할 컬럼
- 새 변신(Metamorph) 추가하기
- 실제 예시
- 강화 시스템 동작
- 변신 장착/해제 시 동작
- 합성 시스템
- 자주 하는 실수
- 트러블슈팅
