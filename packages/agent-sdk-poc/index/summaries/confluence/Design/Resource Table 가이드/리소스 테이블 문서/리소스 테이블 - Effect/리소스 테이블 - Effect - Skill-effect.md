# 리소스 테이블 - Effect - Skill-effect (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Effect/리소스 테이블 - Effect - Skill-effect/content.md

## 한 줄 설명
스킬 관련 Effect 카테고리(SkillChange, SkillCoolReduce, SkillEnhance, SkillEnhanceByBuffStack)의 리소스 테이블 설정 방법과 컬럼 구성을 정의한다.

## 핵심 용어
- SkillChange
- SkillCoolReduce
- SkillEnhance
- SkillEnhanceByBuffStack
- RemoveSkill
- AddSkill
- ClassId
- MilliSeconds
- BaseValue
- AllAttack
- CriticalChance
- ValuePerStack
- BonusEnum
- EffectClass 시트
- Resource
- 보정 배수
- 버프 중첩 수

## 숫자/상수/공식
- 보정 배수 = 참조 버프의 현재 중첩 수 / ValuePerStack
- 스킬 보정량 = 설정한 보정치 × 보정 배수
- 예시 Id 400: 스킬 1001 제거, 스킬 2001 추가
- 예시 Id 410: 스킬 1001 쿨타임 3000밀리초(3초) 감소
- 예시 Id 420: 스킬 1001 공격력 +500 보정

## 참조 시스템
- (없음)

## 주요 섹션
- SkillChange
- SkillCoolReduce
- SkillEnhance
- SkillEnhanceByBuffStack
- 트러블슈팅
