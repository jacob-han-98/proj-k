# [작성중] 스킬/버프 UIUX 개선 (요약)

> 출처: Confluence / PK
> 원본: /home/jacob/proj-k-data/confluence/output/Design/시스템 디자인/UX UI 규칙/UXUI 개선/[작성중] 스킬_버프 UIUX 개선/content.md

## 한 줄 설명
Project K의 스킬 및 버프 UI/UX 개선 사항을 정의하는 진행 중인 설계 문서로, 아이콘 표기, 팝업 진입 방식, 정보 표시 구조 등의 변경 사항을 명시한다.

## 핵심 용어
- 스킬 아이콘
- 액티브 (ActiveSkill)
- 패시브 (PassiveSkill)
- 궁극기 (Ultimate)
- 스킬 등급 (SkillGrade)
- 스킬 강화
- 버프 (Buff)
- 퀵슬롯
- AUTO 설정
- 주기 설정
- 스킬 정보 팝업
- 스킬 순서 설정 팝업
- 스킬 주기 설정 팝업
- HUD
- 프레임 변경
- 백판 색상
- 레벨 표시
- 스킬-버프 정보
- BuffType
- SkillCategory

## 숫자/상수/공식
- MaxCount > 1 = 광역
- MaxCount = 1 = 단일
- Duration = -1 인 경우 무제한으로 표기
- AUTO 상태 순환: AUTO OFF → AUTO ON → PVP → PVE → AUTO OFF
- 6개 이상 버프 표현 방식 변경 (HUD 버프 정보)

## 참조 시스템
- CharacterSkillClass 테이블
- BuffClass 테이블
- EffectClass 테이블
- BuffType 참조
- SkillCategory 참조
- SkillType 참조
- SkillGrade 참조

## 주요 섹션
- 스킬 개선 리스트
- 버프 개선 리스트
- 스킬 아이콘
- 스킬
- 스킬 정보 팝업
- 스킬 순서 설정 팝업
- 스킬 주기 설정 팝업
- 스킬 강화
- 버프 아이콘
- 버프 상태 정보
