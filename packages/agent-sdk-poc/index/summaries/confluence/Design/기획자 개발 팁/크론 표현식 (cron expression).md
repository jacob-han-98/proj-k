# 크론 표현식 (cron expression) (요약)

> 출처: Confluence / Design/기획자 개발 팁
> 원본: packages/confluence-downloader/output/Design/기획자 개발 팁/크론 표현식 (cron expression)/content.md

## 한 줄 설명
스케줄링 및 반복작업 설정에 사용되는 크론 표현식의 형식과 특수문자, 월/요일 표현 방식을 정의한 문서. Project K에서 몬스터 스폰 스케줄링 설정 시 사용 예정.

## 핵심 용어
- 크론 표현식 (cron expression)
- 쿼츠 크론 (Quartz Cron)
- Crontab
- 스프링 배치 (Spring Batch)
- 스케줄링 (Scheduling)
- 반복작업
- 몬스터 스폰 스케줄링
- 초 (Seconds)
- 분 (Minutes)
- 시 (Hours)
- 일 (Day of Month)
- 월 (Month)
- 요일 (Day of Week)
- 년 (Year)
- 특수문자
- 평일 (Weekday)

## 숫자/상수/공식
- 7자리 쿼츠 크론 표현식 (초, 분, 시, 일, 월, 요일, 년)
- 5자리 Crontab 크론 표현식 (분, 시, 일, 월, 요일)
- 6자리 스프링 배치 표현식 (년 생략 가능)
- 월: 1~12 (또는 JAN~DEC)
- 요일 (리눅스 크론): 0~6 (0=일요일, 6=토요일) 또는 SUN~SAT
- 요일 (쿼츠 크론): 1~7 (1=일요일, 7=토요일) 또는 SUN~SAT

## 참조 시스템
- (없음)

## 주요 섹션
- 크론 표현식 개요
- 크론 표현식에서 사용되는 문자
- 월 표현 숫자와 문자
- 요일 표현 숫자와 문자
