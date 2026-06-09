# 리소스 테이블 - Mail (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Mail/content.md

## 한 줄 설명
우편 시스템의 기본 설정과 템플릿을 정의하는 테이블로, 우편 종류별 보관 한도와 우편 템플릿(제목/본문/수령 기간)을 관리한다.

## 핵심 용어
- Mail 테이블
- MailClass 시트
- MailTemplate 시트
- MailTypeEnum
- MailMsgEnum
- Type (우편 종류)
- MaxCount (최대 보관 수)
- Id (템플릿 고유 식별자)
- MailType
- MailMsg (시스템 메시지 우편 식별자)
- NumberOfDaysToReceive (수령 가능 기간)
- MailTitle (우편 제목)
- MailBody (우편 본문)
- Character (우편 범위)
- Account (우편 범위)
- World (우편 범위)

## 숫자/상수/공식
- MaxCount: 0 이상 (0 = 보관 제한 없음)
- NumberOfDaysToReceive: 일 단위 (⚠️ 확인 필요)
- MailTypeEnum 값: Character, Account, World (3개)

## 참조 시스템
- Mail.xlsx (MailClass 시트)
- Mail.xlsx (MailTemplate 시트)

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- MailClass 시트
- MailTemplate 시트
- 새 우편 템플릿 추가하기
- 자주 하는 실수
- 트러블슈팅
