# [작성중] 스킬/버프 UIUX 개선 (요약)

> 출처: Confluence / PK
> 원본: /home/jacob/proj-k-data/confluence/output/Design/시스템 디자인/UX UI 규칙/UXUI 개선/[작성중] 스킬_버프 UIUX 개선/content.md

## 한 줄 설명
Project K의 스킬 및 버프 UI/UX 개선 사항을 정의하는 진행 중인 기획 문서로, 아이콘 디자인 변경, 팝업 진입 방식 개선, 자동 등록 기능 제거 등을 포함한다.

## 핵심 용어
- 스킬 아이콘
- 액티브 (ActiveSkill)
- 패시브 (PassiveSkill)
- 궁극기 (Ultimate)
- 스킬 등급 (SkillGrade)
- 스킬 레벨 (SkillLevel)
- 프레임 변경
- 백판 색상
- AUTO 설정
- 퀵슬롯
- 스킬 정보 팝업
- 스킬 강화
- 버프 (Buff)
- 디버프 (Debuff)
- BuffType
- HUD
- 스킬 사용 설정
- 주기 설정
- 순서 설정
- 스킬-버프 정보

## 숫자/상수/공식
- 스킬 등급: Common (일반), Uncommon (고급), Rare (희귀), Unique (유니크), Legendary (전설)
- 스킬 레벨: 0~9 (업그레이드 단계)
- AUTO 상태 순환: AUTO OFF → AUTO ON → PVP → PVE → AUTO OFF
- 패시브 프레임: 원형 → 사각형 변경
- 궁극기 프레임: 원형 유지
- 액티브 프레임: 사각형 유지
- 스킬 타입: Attack, ActiveSkill, PassiveSkill, Ultimate
- 스킬 카테고리: NormalAttack, OnlyBuff, Dash, BackDash, Push, Pull, PulseAreaAttack, PulseAreaBuff, RepeatedAttack, Composite, Guild
- BuffType: Good (버프), Bad (디버프)
- MaxCount > 0 = 광역, MaxCount = 0 = 단일
- 버프 지속 시간: -1 (무제한/영구), 500~20000ms 등

## 참조 시스템
- CharacterSkillClass 테이블
- BuffClass 테이블
- EffectClass 테이블
- TEXTKEY (다국어 키)

## 주요 섹션
- 스킬 개선 리스트
- 버프 개선 리스트
- 스킬 아이콘
- 스킬 팝업 진입 방식
- 스킬 HUD PopUP
- 퀵슬롯 자동 등록 기능 제거
- 스킬 정보 팝업
- 스킬 기본 정보
- 스킬 상세 정보
- 버프 아이콘
- 버프 상태 정보
