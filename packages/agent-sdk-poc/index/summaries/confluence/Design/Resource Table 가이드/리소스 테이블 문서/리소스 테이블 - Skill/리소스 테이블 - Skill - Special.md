# 리소스 테이블 - Skill - Special (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Skill/리소스 테이블 - Skill - Special/content.md

## 한 줄 설명
Project K의 특수 스킬 카테고리(TargetConditional, SummonMonster, Guild)의 설정 방법과 컬럼 정의를 명시한 리소스 테이블 가이드 문서.

## 핵심 용어
- TargetConditional
- SummonMonster
- Guild
- SkillCategory
- Options
- PvE
- PvP
- BuffId
- MaxCount
- AnimationName
- Multiplier
- AreaShape
- AreaSize
- AffectType
- TargetType
- monster_id
- despawn_dependency
- spawn_range
- GuildMember
- buff_stack

## 숫자/상수/공식
- Options 개수 (TargetConditional): 정확히 2개
- Options 인덱스 (TargetConditional): [0]=monster_skill_id, [1]=player_skill_id
- Options 인덱스 (SummonMonster): [0]=monster_id, [1]=despawn_dependency(기본값 false), [2]=spawn_range(기본값 없음)
- despawn_dependency 유효값: 0(false) / 1(true)
- spawn_range 유효값: > 0

## 참조 시스템
- Skill 테이블
- Monster 테이블
- Buff 테이블

## 주요 섹션
- TargetConditional
- SummonMonster
- Guild
