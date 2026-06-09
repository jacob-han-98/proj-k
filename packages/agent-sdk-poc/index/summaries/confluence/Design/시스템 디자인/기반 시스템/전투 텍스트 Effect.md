# 전투 텍스트 Effect (요약)

> 출처: Confluence / 전투 텍스트 Effect
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/기반 시스템/전투 텍스트 Effect/content.md

## 한 줄 설명
전투 중 발생하는 다양한 상황(치명타, 회피, 방어, 저항 등)에 대응하는 텍스트 이펙트 7가지를 정의하고 각 이펙트의 조건, 중요도, 위젯명을 정리한 리스트.

## 핵심 용어
- 치명타
- 최대 대미지
- 일반 방어
- 스킬 방어
- 저항
- 일반 회피
- 스킬 회피
- Widget
- WBP_Damage_Text_Critical
- WBP_Damage_Text_Great
- WBP_Damage_Text_Defense
- WBP_Damage_Text_Reflect_Defense
- WBP_Damage_Text_Invalid
- WBP_Damage_Text_Evade
- WBP_Damage_Text_RefelectEvade
- 명중
- 막기 효과
- 상태 이상 공격
- 미적용 판정

## 숫자/상수/공식
- MinWeaponAttack + (MaxWeaponAttack - MinWeaponAttack) * (ContentSetting:MaxDamageCheckRangePercent)

## 참조 시스템
- PK_텍스트 이펙트 시스템.xlsx

## 주요 섹션
- 리스트
