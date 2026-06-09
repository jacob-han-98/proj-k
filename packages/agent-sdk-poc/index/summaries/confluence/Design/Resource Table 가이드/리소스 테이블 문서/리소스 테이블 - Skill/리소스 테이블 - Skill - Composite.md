# 리소스 테이블 - Skill - Composite (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Skill/리소스 테이블 - Skill - Composite
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Skill/리소스 테이블 - Skill - Composite/content.md

## 한 줄 설명
여러 개의 자식 스킬을 딜레이에 맞춰 순차적으로 발동하는 Composite 스킬과 개별 타게팅을 수행하는 CompositeRetarget 스킬의 설정 및 운영 가이드.

## 핵심 용어
- Composite
- CompositeRetarget
- SkillCategory
- Options
- delay
- skill_id
- 자식 스킬
- 타게팅
- 최초 타게팅
- 개별 타게팅
- 딜레이-스킬Id 쌍
- MaxCount
- PreBuffId
- AnimationName
- Multiplier
- BuffId
- MinRange
- SkillAnimationDelay
- 타겟 후보
- 순환 배분

## 숫자/상수/공식
- Options 개수: 짝수 필수
- Options 최소 쌍: 2쌍(4개) 이상
- 예시 딜레이: 0ms, 500ms
- 예시 스킬 Id: 110100, 110200

## 참조 시스템
- Skill 테이블

## 주요 섹션
- Composite
- CompositeRetarget
