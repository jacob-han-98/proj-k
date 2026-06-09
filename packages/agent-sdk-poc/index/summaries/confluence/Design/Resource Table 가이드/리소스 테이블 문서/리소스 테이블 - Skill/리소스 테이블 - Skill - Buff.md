# 리소스 테이블 - Skill - Buff (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Skill/리소스 테이블 - Skill - Buff
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Skill/리소스 테이블 - Skill - Buff/content.md

## 한 줄 설명
공격 없이 버프/디버프만 적용하는 OnlyBuff 스킬의 리소스 테이블 정의 및 설정 가이드.

## 핵심 용어
- OnlyBuff
- SkillType
- SkillCategory
- TargetType
- AffectType
- BuffId
- MaxCount
- AnimationName
- PreBuffId
- MpCost
- CoolTime
- AreaShape
- Multiplier
- Options
- Self
- Friend
- PartyMember
- Enemy
- SelfOnly
- Hostile
- PassiveSkill
- ActiveSkill

## 숫자/상수/공식
- Id 110600 (가디언 디펜시브 스탠스): MpCost 1, CoolTime 1000, BuffId 1106000, MaxCount 1
- Id 210500 (워리어 아이언하트): MpCost 20, CoolTime 90000, BuffId 2005, MaxCount 1

## 참조 시스템
- Buff 테이블

## 주요 섹션
- OnlyBuff
- 개요
- 설정할 컬럼
- Options 설정
- 새 OnlyBuff 스킬 추가하기
- 실제 예시
- 자주 하는 실수
- 트러블슈팅
