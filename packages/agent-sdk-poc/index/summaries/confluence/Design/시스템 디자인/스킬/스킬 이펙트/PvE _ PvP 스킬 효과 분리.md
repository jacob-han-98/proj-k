# PvE / PvP 스킬 효과 분리 (요약)

> 출처: Confluence / Design/시스템 디자인/스킬/스킬 이펙트
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/스킬/스킬 이펙트/PvE _ PvP 스킬 효과 분리/content.md

## 한 줄 설명
1개의 스킬에 PvE와 PvP 타겟에 따라 서로 다른 2개의 효과를 분리하여 연결하는 기능으로, 고급 스킬 밸런싱 시 양쪽 환경의 영향을 최소화하기 위해 설계됨.

## 핵심 용어
- PvE 효과
- PvP 효과
- CharacterSkillClass 테이블
- 부모 데이터
- 자식 데이터
- SkillType
- SkillCategory
- TargetConditionalAttack
- TargetAttack
- NormalAttack
- AttackType
- CoolTime
- Dice 컬럼
- BuffId
- 광역 스킬
- 장판
- 전조 정보
- 랙돌 정보
- SkillCategoryEnum
- TargetConditional
- Composite 방식
- TagetType

## 숫자/상수/공식
- 1개 스킬당 PvE 효과 최대 1개
- 1개 스킬당 PvP 효과 최대 1개

## 참조 시스템
- (없음)

## 주요 섹션
- 정의 및 배경
- 규칙
- 테이블 구조
- 필요 Enum 정보
