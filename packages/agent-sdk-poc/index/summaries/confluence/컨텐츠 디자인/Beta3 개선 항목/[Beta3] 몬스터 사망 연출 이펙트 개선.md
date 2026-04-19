# [Beta3] 몬스터 사망 연출 이펙트 개선 (요약)

> 출처: 컨텐츠 디자인 / Beta3 개선 항목 / [Beta3] 몬스터 사망 연출 이펙트 개선
> 원본: packages/confluence-downloader/output/컨텐츠 디자인/Beta3 개선 항목/[Beta3] 몬스터 사망 연출 이펙트 개선/content.md

## 한 줄 설명
몬스터 사망 후 메시 제거 연출을 검은 연기 FX에서 디졸브 효과로 변경하여 단조로움을 해소하고 세계관에 맞는 불안정한 리프 흩뿌림 연출을 구현하는 기획.

## 핵심 용어
- 디졸브 (Dissolve)
- 디졸브 노티파이 (Dissolve Notify)
- 디졸브 FX (Dissolve Effect)
- 랙돌 사망 (Ragdoll Death)
- 일반 사망 애니메이션 (Death Animation)
- 네임드 몬스터 (Named Monster)
- 일반 몬스터 (Normal Monster)
- 필드보스 (Field Boss)
- 메시 (Mesh)
- 리프 (Leaf)
- 스폰 FX (Spawn Effect)
- MonsterDissolveDelayTime
- MonsterDissolveSecond
- MonsterDeathRetentionSecond
- DA_ClientDesignDataAsset
- ContentSetting.xlsx
- 배속 (Speed Multiplier)
- 노티파이 프레임 타임 (Notify Frame Time)
- 시야 밖 몬스터 (Off-screen Monster)

## 숫자/상수/공식
- 기본 디졸브 딜레이: 2~3초
- 기본 디졸브 FX 길이: 1~1.5초
- 기본 디졸브 FX 배속: 1배
- MonsterDissolveDelayTime 값: 5초
- 일반 몬스터 랙돌 사망 후 메시 제거 시간: 약 3~4초
- 유지 시간 계산 공식 (디졸브 노티파이 존재 시): Death 애니메이션 내 디졸브 노티파이 프레임 타임 + 디졸브 FX 출력 시간 (FX 길이 / 배속)
- 유지 시간 계산 공식 (노티파이 없거나 랙돌 사망): MonsterDissolveDelayTime + 디졸브 FX 출력 시간(디폴트)

## 참조 시스템
- DA_ClientDesignDataAsset
- ContentSetting.xlsx

## 주요 섹션
- 개요
- 기획 의도
- 내용 요약
- 구현 필요 사항
- 상세 기획
- 사망 연출 현황
- 연출 개선
- 구현 필요 항목
- FX 컨셉
- 이외 추가 레퍼런스
