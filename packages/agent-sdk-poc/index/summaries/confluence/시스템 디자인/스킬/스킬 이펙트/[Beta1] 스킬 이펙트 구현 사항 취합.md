# [Beta1] 스킬 이펙트 구현 사항 취합 (요약)

> 출처: 시스템 디자인 / 스킬 / 스킬 이펙트
> 원본: packages/confluence-downloader/output/시스템 디자인/스킬/스킬 이펙트/[Beta1] 스킬 이펙트 구현 사항 취합/content.md

## 한 줄 설명
Beta1 단계에서 클래스별로 구현해야 할 스킬 이펙트 목록과 각 효과의 기능, 입력 정보, 우선순위를 정의한 문서.

## 핵심 용어
- 스킬 이펙트
- 발동 액션
- 조건부 효과
- InvokeConditionEnum
- OnAllDamage
- OnLethalDamage
- BonusEnum
- ApplyMaxDamage
- SetHP
- SetHPRate
- 무기 최대 대미지
- 명중/크리티컬
- 빈사 상태
- 출혈
- DoT
- 버프 스택
- BuffID
- BonusPerStack
- 버프 스택 부여
- 조건부 효과
- 감속 효과
- CCtype
- Slow
- 백 대쉬 어택
- Push
- 대상 상태에 따른 추가 효과
- CCEnum
- 스킬 쿨타임 감소
- 패시브 스킬
- 버프 종료 후 발동 효과
- 필중 옵션
- ConditionType
- OverHP
- UnderHP
- 버프 소모형 기본 공격
- 토글 타입 스킬
- 은신
- 워리어
- 아처
- 아발리스터

## 숫자/상수/공식
- 우선순위: 1, 2, 3, 4 (beta2)
- OnAllDamage = 2
- 트랜스 버프 예시: 20스택마다 공격력 1 증가, 크리티컬 확률 1% 증가
- 대상 HP 70% 이상 조건 예시

## 참조 시스템
- (없음)

## 주요 섹션
- 클래스 구현에 필요한 스킬 이펙트 리스트
- 백 대쉬 어택
