# 클래스(PC) 데이터 어셋 등록 (요약)

> 출처: Confluence / Design / 제작 가이드 / 전투 - 제작 가이드 / 클래스(PC) 데이터 어셋 등록
> 원본: packages/confluence-downloader/output/Design/제작 가이드/전투 - 제작 가이드/클래스(PC) 데이터 어셋 등록/content.md

## 한 줄 설명
Project K에서 새로운 플레이어 캐릭터(PC) 클래스의 데이터 어셋을 에디터에 등록하고 리소스를 생성·배포하는 절차를 정의한다.

## 핵심 용어
- PC PawnData
- DA_PC_XXXXX
- 스켈레탈 메쉬 Low
- Base Anim Sequence Set
- Social Anim
- Slot Anim
- Animated Nameplate Offset
- Projectile Embed Offset
- MetamorphDataTable
- Metamorph.xlsx
- AssetName
- 리소스 제너레이트
- 에디터 테이블 데이터 리임포트
- 애님 리소스 익스포트
- AnimationDelay.json
- Diff

## 숫자/상수/공식
- Projectile Embed Offset: 양수(바깥쪽), 음수(안쪽)

## 참조 시스템
- //main/ProjectK/Resource/design/Metamorph.xlsx
- //main/ProjectK/Resource/server/AnimationDelay.json

## 주요 섹션
- PC PawnData 추가 및 설정
- MetamorphDataTable 등록 (폐기됨)
- Metamorph.xlsx 테이블 입력
- 리소스 제너레이트 실행
- 에디터 테이블 데이터 리임포트
- 애님 리소스 익스포트
- AnimationDelay.json 체크아웃 및 검증
- 서버 및 클라이언트 실행 확인
