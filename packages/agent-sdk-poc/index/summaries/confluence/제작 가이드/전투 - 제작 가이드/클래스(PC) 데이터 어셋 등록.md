# 클래스(PC) 데이터 어셋 등록 (요약)

> 출처: 제작 가이드 / 전투 - 제작 가이드 / 클래스(PC) 데이터 어셋 등록
> 원본: packages/confluence-downloader/output/제작 가이드/전투 - 제작 가이드/클래스(PC) 데이터 어셋 등록/content.md

## 한 줄 설명
Project K에서 새로운 플레이어 캐릭터(PC)의 PawnData 어셋을 에디터에 등록하고 리소스를 생성하는 절차를 정의한다.

## 핵심 용어
- PC PawnData
- DA_PC_XXXXX
- 스켈레탈 메쉬 Low
- Base Anim Sequence Set
- Idle
- Run
- Battle Idle
- Battle Run
- Dead
- UnEquip
- Social Anim
- Slot Anim
- Hit
- Stun
- Death
- Pull
- Animated Nameplate Offset
- 네임테그
- Projectile Embed Offset
- MetamorphDataTable
- AssetName
- Metamorph.xlsx
- 리소스 제너레이트
- 에디터 테이블 데이터 리임포트
- 애님 리소스 익스포트
- AnimationDelay.json
- Diff

## 숫자/상수/공식
- (없음)

## 참조 시스템
- //main/ProjectK/Resource/design/Metamorph.xlsx
- //main/ProjectK/Resource/server/AnimationDelay.json

## 주요 섹션
- PC PawnData 추가
- 메시 및 애니메이션 시퀀스 연결
- Social Anim 설정
- Slot Anim 설정
- Nameplate 및 Projectile 오프셋 조정
- Metamorph.xlsx 테이블 입력
- 리소스 제너레이트 실행
- 에디터 테이블 데이터 리임포트
- 애님 리소스 익스포트
- AnimationDelay.json 검증 및 서밋
