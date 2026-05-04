// Phase C: agent-sdk-poc 의 assistantRender.tsx 를 desktop-app 으로 이식한 축약 버전.
// 원본: packages/agent-sdk-poc/frontend/src/assistantRender.tsx (사용자 결정 — 양쪽 분리,
// 코드 공통화 X, 메시지로 동기화). Mermaid / DataSheet / 우측 패널 / 스크린샷 모달은
// 후순위 — 지금은 인라인 마크다운 + (출처: …) 클릭 가능한 링크까지만.
//
// kind 별 아이콘 + 클릭 동작:
//   xlsx / confluence : 우측 SourceModal 열기 (onOpenSource)
//   external (oracle 큐레이트 타게임) : v1 미지원 — 클릭 무시
//   web (Deep Research) : href = https://<domain> 새 창
//
// 호출자 (QnATab 등) 는 sources/onOpenSource 만 넘기면 됨. theme 자동 detect 안 하고
// CSS 변수로 처리 — 본 프로젝트는 styles.css 가 var(--bg) 등으로 light/dark 자동 적용.

import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

// agent-sdk-poc backend 의 Source 타입 — askStream 결과의 sources 배열에 들어옴.
// desktop-app 의 api.ts 에 별도 export 가 없어 여기서 minimal interface 정의.
export interface QnASource {
  workbook?: string;
  sheet?: string;
  section_path?: string;
  source_url?: string;
  path?: string;
  source?: 'xlsx' | 'confluence' | 'summary' | 'image' | 'external' | 'web' | 'datasheet' | 'other';
  origin_label?: string;
  origin_url?: string;
}

function DataSheetIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0 }}>
      <rect width="18" height="18" rx="3" fill="#dc2626" />
      <rect x="4" y="4" width="10" height="10" rx="1" fill="none" stroke="white" strokeWidth="1.1" />
      <line x1="4" y1="7.5" x2="14" y2="7.5" stroke="white" strokeWidth="1.1" />
      <line x1="4" y1="11" x2="14" y2="11" stroke="white" strokeWidth="1.1" />
      <line x1="7.5" y1="4" x2="7.5" y2="14" stroke="white" strokeWidth="1.1" />
      <line x1="11" y1="4" x2="11" y2="14" stroke="white" strokeWidth="1.1" />
    </svg>
  );
}

// ── Icons ──
export function ExcelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0 }}>
      <rect width="18" height="18" rx="3" fill="#217346" />
      <path
        d="M4.5 4.5L8 9L4.5 13.5H6.5L9 10L11.5 13.5H13.5L10 9L13.5 4.5H11.5L9 8L6.5 4.5H4.5Z"
        fill="white"
      />
    </svg>
  );
}

export function ConfluenceIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0 }}>
      <rect width="18" height="18" rx="3" fill="#1868DB" />
      <path
        d="M3.5 12.5C3.5 12.5 4 11.5 5 11.5C6.5 11.5 7 13 9 13C11 13 12 11 13.5 11C14.5 11 14.5 12 14.5 12L14.5 13.5C14.5 13.5 14 14.5 13 14.5C11.5 14.5 11 13 9 13C7 13 6 15 4.5 15C3.5 15 3.5 14 3.5 14V12.5Z"
        fill="white"
      />
      <path
        d="M14.5 5.5C14.5 5.5 14 6.5 13 6.5C11.5 6.5 11 5 9 5C7 5 6 7 4.5 7C3.5 7 3.5 6 3.5 6L3.5 4.5C3.5 4.5 4 3.5 5 3.5C6.5 3.5 7 5 9 5C11 5 12 3 13.5 3C14.5 3 14.5 4 14.5 4V5.5Z"
        fill="white"
      />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0 }}>
      <rect width="18" height="18" rx="3" fill="#9333ea" />
      <path
        d="M4 4.5C4 4.22 4.22 4 4.5 4H8.5V13.5L8 13.2L7.5 13.5L7 13.2L6.5 13.5L6 13.2L5.5 13.5L5 13.2L4.5 13.5C4.22 13.5 4 13.28 4 13V4.5Z"
        fill="white"
      />
      <path
        d="M9.5 4.5C9.5 4.22 9.72 4 10 4H13.5C13.78 4 14 4.22 14 4.5V13C14 13.28 13.78 13.5 13.5 13.5L13 13.2L12.5 13.5L12 13.2L11.5 13.5L11 13.2L10.5 13.5L10 13.2L9.5 13.5V4.5Z"
        fill="white"
      />
    </svg>
  );
}

function WebIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0 }}>
      <rect width="18" height="18" rx="3" fill="#0891b2" />
      <circle cx="9" cy="9" r="5" fill="none" stroke="white" strokeWidth="1.2" />
      <ellipse cx="9" cy="9" rx="2" ry="5" fill="none" stroke="white" strokeWidth="1.2" />
      <line x1="4" y1="9" x2="14" y2="9" stroke="white" strokeWidth="1.2" />
    </svg>
  );
}

// ── 본문 전처리: (출처: …) → projk-source: 링크 ──
// 매우 축약 — agent-sdk-poc 원본의 (참고 자료: …) / **xlsx 라벨** 변환은 후순위.
export function linkifyInlineSources(text: string): string {
  if (!text) return text;
  const re = /\(\s*(?:출처|참고\s*자료)\s*[:：]\s*/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const afterPrefix = m.index + m[0].length;
    let depth = 1;
    let i = afterPrefix;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    if (i >= text.length) break;
    const body = text.slice(afterPrefix, i).trim();
    const displayBody = body.replace(/[\[\]]/g, (c) => '\\' + c);
    const enc = encodeURIComponent(body);
    out += text.slice(last, start) + `[(출처: ${displayBody})](projk-source:${enc})`;
    last = i + 1;
    re.lastIndex = last;
  }
  out += text.slice(last);
  return out;
}

// inline code 가 도메인-스타일 URL 이면 자동 링크. event-hit2.nexon.com/kr 같은 inline 코드.
const URL_LIKE = /^[\w-]+(?:\.[\w-]+){1,}(?:\/[^\s)]*)?$/;
function inlineCodeToUrl(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 200) return null;
  if (URL_LIKE.test(t)) return t.startsWith('http') ? t : `https://${t}`;
  return null;
}

// ── 인라인 출처 body 파서 — kind 별 분기 ──
export interface ParsedSourceBody {
  kind: 'xlsx' | 'confluence' | 'external' | 'web' | 'datasheet' | 'other';
  levels: string[];
  url?: string;
}

export function parseInlineSourceBody(body: string): ParsedSourceBody {
  let label = body.trim();
  let section = '';
  const sep = body.indexOf('§');
  if (sep >= 0) {
    label = body.slice(0, sep).trim();
    section = body.slice(sep + 1).trim();
  }
  const sections = section ? section.split(/\s*>\s*/).map((s) => s.trim()).filter(Boolean) : [];
  const sectionLevels = sections.map((s) => `"${s}"`);

  if (/^web\//i.test(label)) {
    const parts = label.replace(/^web\//i, '').split(/\s*\/\s*/).map((p) => p.trim()).filter(Boolean);
    const domain = parts[0] ?? '';
    const title = parts.slice(1).map((p) => `"${p}"`);
    const url = domain && domain.includes('.') ? `https://${domain}` : undefined;
    return { kind: 'web', levels: [`${domain} (웹)`, ...title, ...sectionLevels], url };
  }
  if (/^external\//i.test(label)) {
    const parts = label.replace(/^external\//i, '').split(/\s*\/\s*/).map((p) => p.trim()).filter(Boolean);
    const game = parts[0] ?? '타게임';
    const rest = parts.slice(1).map((p) => `"${p}"`);
    return { kind: 'external', levels: [`${game} (참고)`, ...rest, ...sectionLevels] };
  }
  if (/^Confluence\s*\//.test(label)) {
    const rest = label.replace(/^Confluence\s*\/\s*/, '').trim();
    const parts = rest.split(/\s*\/\s*/).map((p) => p.trim()).filter(Boolean);
    return { kind: 'confluence', levels: ['Confluence', ...parts.map((p) => `"${p}"`), ...sectionLevels] };
  }
  if (/^DataSheet\s*\//i.test(label)) {
    const rest = label.replace(/^DataSheet\s*\/\s*/i, '').trim();
    const parts = rest.split(/\s*\/\s*/).map((p) => p.trim()).filter(Boolean);
    return { kind: 'datasheet', levels: ['DataSheet', ...parts.map((p) => `"${p}"`), ...sectionLevels] };
  }
  const xm = label.match(/^(.+?\.xlsx)\s*\/\s*(.+?)(?:\s+시트)?\s*$/);
  if (xm) return { kind: 'xlsx', levels: [xm[1], `"${xm[2]}" 시트`, ...sectionLevels] };
  return { kind: 'other', levels: [label, ...sectionLevels] };
}

// ── 인라인 소스 클릭 → onOpen(path, section) 정규화 헬퍼 ──
function openInlineSourceFromBody(
  body: string,
  sources: QnASource[] | undefined,
  onOpen: (path: string, section: string) => void,
) {
  let label = body;
  let section = '';
  const sep = body.indexOf('§');
  if (sep >= 0) {
    label = body.slice(0, sep).trim();
    section = body.slice(sep + 1).trim();
  }
  const match = sources?.find((s) => ((s.origin_label ?? '').trim()) === label);
  if (match?.path) {
    onOpen(match.path, section);
    return;
  }
  onOpen(label, section);
}

// ── 공통 Markdown 렌더러 ──
export interface RenderAssistantMarkdownProps {
  content: string;
  sources?: QnASource[];
  // xlsx/confluence 인라인 출처 클릭 시. 호출자가 SourceModal 또는 우측 패널을 열어줌.
  onOpenSource: (path: string, section: string) => void;
}

export function RenderAssistantMarkdown({
  content,
  sources,
  onOpenSource,
}: RenderAssistantMarkdownProps) {
  const processed = useMemo(() => linkifyInlineSources(content), [content]);

  const components: Components = {
    code({ className, children, ...props }) {
      const txt = String(children);
      // pre 의 자식인 경우 (block) → 그대로. inline 은 도메인-스타일이면 링크화.
      // ReactMarkdown v10 부터 inline prop 이 없어 부모 노드로 판별 — 여기선 단순화:
      // className 에 language-* 가 있으면 block 으로 간주, 없으면 inline.
      const isBlock = !!className && /language-/.test(className);
      if (!isBlock) {
        const url = inlineCodeToUrl(txt);
        if (url) {
          return (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-code-link"
              title={`${url} 새 창에서 열기`}
            >
              <code className={className} {...props}>
                {children}
              </code>
            </a>
          );
        }
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
    a({ href, children, ...props }) {
      const h = href ?? '';
      if (h.startsWith('projk-source:')) {
        const body = decodeURIComponent(h.slice('projk-source:'.length));
        const parsed = parseInlineSourceBody(body);
        const Icon =
          parsed.kind === 'confluence'
            ? ConfluenceIcon
            : parsed.kind === 'external'
              ? ExternalIcon
              : parsed.kind === 'web'
                ? WebIcon
                : parsed.kind === 'datasheet'
                  ? DataSheetIcon
                  : ExcelIcon;
        const isExternal = parsed.kind === 'external';
        const isWeb = parsed.kind === 'web';
        return (
          <a
            href={isWeb && parsed.url ? parsed.url : '#'}
            target={isWeb ? '_blank' : undefined}
            rel={isWeb ? 'noreferrer' : undefined}
            className={`inline-source-link inline-source-${parsed.kind}`}
            onClick={(e) => {
              if (isWeb) {
                e.stopPropagation();
                return;
              }
              e.preventDefault();
              e.stopPropagation();
              if (isExternal) return;
              openInlineSourceFromBody(body, sources, onOpenSource);
            }}
            title={
              isWeb
                ? `웹 자료 새 창에서 열기 — ${parsed.url ?? '도메인 정보 없음'}`
                : isExternal
                  ? '외부 참고 자료 — 원문 링크는 향후 지원'
                  : '출처 보기'
            }
          >
            <span className="inline-source-icon">
              <Icon />
            </span>
            {parsed.levels.map((lvl, i) => (
              <span key={i} className="inline-source-part">
                {i > 0 && <span className="inline-source-sep"> › </span>}
                <span>{lvl}</span>
              </span>
            ))}
          </a>
        );
      }
      return (
        <a href={h} {...props}>
          {children}
        </a>
      );
    },
  };

  return (
    <div className="qna-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {processed}
      </ReactMarkdown>
    </div>
  );
}

// ── 출처 카드 ── (Phase D)
// agent-sdk-poc 의 RenderSourceCards 이식. 답변 하단에 sources 를 3 그룹으로 분리:
//   PK (xlsx / confluence / datasheet — 회사 자산)
//   타게임 (external — oracle 큐레이트 참고 자료)
//   웹 (web — Deep Research)
// 같은 path 의 sources 는 section 만 누적 (중복 카드 방지). path 없으면 workbook|sheet 키.
export interface RenderSourceCardsProps {
  sources: QnASource[];
  onOpen: (path: string, section: string) => void;
}

export function RenderSourceCards({ sources, onOpen }: RenderSourceCardsProps) {
  if (!sources || sources.length === 0) return null;

  // 동일 path 의 source 중복 제거 + section 누적.
  const groups = new Map<string, { src: QnASource; sections: string[] }>();
  for (const s of sources) {
    const key = s.path ?? `${s.workbook ?? ''}|${s.sheet ?? ''}`;
    const existing = groups.get(key);
    const sec = (s.section_path ?? '').trim();
    if (existing) {
      if (sec && !existing.sections.includes(sec)) existing.sections.push(sec);
    } else {
      groups.set(key, { src: s, sections: sec ? [sec] : [] });
    }
  }
  const entries = Array.from(groups.values());
  const primary = entries.filter(({ src }) => src.source !== 'external' && src.source !== 'web');
  const external = entries.filter(({ src }) => src.source === 'external');
  const web = entries.filter(({ src }) => src.source === 'web');

  return (
    <div className="qna-message-sources" data-testid="qna-message-sources">
      {primary.length > 0 && (
        <>
          <p className="qna-sources-title">출처</p>
          <div className="qna-source-cards">{primary.map((e, i) => renderSourceCard(e, i, onOpen))}</div>
        </>
      )}
      {external.length > 0 && (
        <>
          <p className="qna-sources-title qna-sources-title-external">참고 자료 (타게임)</p>
          <div className="qna-source-cards">{external.map((e, i) => renderSourceCard(e, i, onOpen))}</div>
        </>
      )}
      {web.length > 0 && (
        <>
          <p className="qna-sources-title qna-sources-title-web">참고 자료 (웹)</p>
          <div className="qna-source-cards">{web.map((e, i) => renderSourceCard(e, i, onOpen))}</div>
        </>
      )}
    </div>
  );
}

function renderSourceCard(
  { src, sections }: { src: QnASource; sections: string[] },
  i: number,
  onOpen: (path: string, section: string) => void,
) {
  const isConfluence =
    src.source === 'confluence' || (src.workbook ?? '').startsWith('Confluence');
  const isExternal = src.source === 'external';
  const isWeb = src.source === 'web';
  const isDataSheet = src.source === 'datasheet';
  const displayLabel =
    src.origin_label ||
    [src.workbook, src.sheet].filter(Boolean).join(' / ') ||
    src.path ||
    '(unknown)';
  const extLink = src.origin_url ?? src.source_url ?? '';
  const firstSection = sections[0] ?? '';
  const canOpen = !!src.path && !isExternal && !isWeb;
  const Icon = isWeb
    ? WebIcon
    : isExternal
      ? ExternalIcon
      : isDataSheet
        ? DataSheetIcon
        : isConfluence
          ? ConfluenceIcon
          : ExcelIcon;
  const cardClass = `qna-source-card${isExternal ? ' qna-source-card-external' : ''}${isWeb ? ' qna-source-card-web' : ''}`;
  const onCardClick = () => {
    if (canOpen) onOpen(src.path!, firstSection);
    else if (isWeb && extLink) window.open(extLink, '_blank', 'noopener,noreferrer');
  };
  const cardTitle = isWeb
    ? `웹 자료 새 창에서 열기 — ${extLink || '링크 없음'}`
    : isExternal
      ? '외부 참고 자료 — 원문 링크는 향후 지원'
      : src.path ?? displayLabel;
  return (
    <div key={i} className={cardClass} title={cardTitle}>
      <button
        className="qna-source-card-main"
        onClick={onCardClick}
        disabled={!canOpen && !isWeb}
        type="button"
        data-testid={`qna-source-card-${i}`}
      >
        <span className="qna-source-card-icon">
          <Icon />
        </span>
        <div className="qna-source-card-body">
          <span className="qna-source-card-text">{displayLabel}</span>
          {sections.length > 0 && (
            <span className="qna-source-card-sections">
              {sections.slice(0, 4).join(' · ')}
              {sections.length > 4 ? ` …+${sections.length - 4}` : ''}
            </span>
          )}
        </div>
      </button>
      {extLink && !isWeb && (
        <a
          className="qna-source-card-ext"
          href={extLink}
          target="_blank"
          rel="noreferrer"
          title="원본 링크 새 창에서 열기"
        >
          ↗
        </a>
      )}
    </div>
  );
}

// ── 진행 내역 타임라인 ── (Phase E)
// agent backend 가 stream 중 status/thinking/tool_start/tool_end 이벤트를 흘리면 그 시퀀스를
// 메시지에 부착해 사용자에게 "Agent 가 무엇을 했는지" 가시화. 기본 collapsed, "✅ 진행 내역
// 펼치기 · 툴 N회" 토글로 펼침. streaming 중에는 자동 expanded. 사용자가 토글 가능.
//
// 영속: 메모리만. 같은 thread 를 다시 mount 해도 옛 turn 의 진행 내역은 안 보임 (DB 부담 X).
// 사용자가 thread 안에서 새로 답변 받으면 그 turn 부터 다시 누적.
export type ProgressEvent =
  | { kind: 'status'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; label: string; summary?: string; ended: boolean };

export interface ProgressTimelineProps {
  events: ProgressEvent[];
  expanded: boolean;
  onToggle: () => void;
  // streaming 중인지 — true 면 자동 펼침 + 라벨 다르게 ("진행 중").
  streaming: boolean;
}

export function ProgressTimeline({ events, expanded, onToggle, streaming }: ProgressTimelineProps) {
  if (events.length === 0 && !streaming) return null;

  const toolCount = events.filter((e) => e.kind === 'tool').length;
  const isOpen = streaming || expanded;
  const summaryLabel = streaming
    ? `⏳ 진행 중 · 툴 ${toolCount}회`
    : `✅ 진행 내역 ${expanded ? '접기' : '펼치기'} · 툴 ${toolCount}회`;

  return (
    <div className="qna-progress-timeline" data-testid="qna-progress-timeline">
      <button
        type="button"
        className="qna-progress-summary"
        onClick={streaming ? undefined : onToggle}
        aria-expanded={isOpen}
        data-testid="qna-progress-summary"
      >
        <span className="qna-progress-arrow" aria-hidden="true">{isOpen ? '▼' : '▶'}</span>
        <span>{summaryLabel}</span>
      </button>
      {isOpen && (
        <div className="qna-progress-events" data-testid="qna-progress-events">
          {events.map((e, i) => (
            <ProgressEventRow key={i} event={e} />
          ))}
          {events.length === 0 && streaming && (
            <div className="qna-progress-row qna-progress-row-status">대기 중<span className="dots" /></div>
          )}
        </div>
      )}
    </div>
  );
}

function ProgressEventRow({ event }: { event: ProgressEvent }) {
  if (event.kind === 'status') {
    return <div className="qna-progress-row qna-progress-row-status">{event.text}</div>;
  }
  if (event.kind === 'thinking') {
    return (
      <div className="qna-progress-row qna-progress-row-thinking" title={event.text}>
        💭 {event.text.slice(0, 100)}
        {event.text.length > 100 ? '…' : ''}
      </div>
    );
  }
  // tool
  return (
    <div className="qna-progress-row qna-progress-row-tool">
      <span className="qna-progress-tool-icon" aria-hidden="true">
        {event.ended ? '✓' : '🔧'}
      </span>
      <span className="qna-progress-tool-label">{event.label}</span>
      {event.summary && <span className="qna-progress-tool-summary">{event.summary}</span>}
    </div>
  );
}

// ── Follow-up 질문 카드 ── (Phase C → D 디자인 강화)
// agent-sdk-poc 의 FollowUpCards 디자인에 가깝게 — 큰 카드 + 화살표 ›. 클릭 → 입력란 채움.
export interface FollowUpCardsProps {
  followUps: string[];
  onPick: (q: string) => void;
}

export function FollowUpCards({ followUps, onPick }: FollowUpCardsProps) {
  if (!followUps || followUps.length === 0) return null;
  return (
    <div className="qna-followups" data-testid="qna-followups">
      <p className="qna-followups-title">이어서 물어볼 만한 질문</p>
      <div className="qna-followups-cards">
        {followUps.map((q, i) => (
          <button
            key={i}
            type="button"
            className="qna-followup-card"
            onClick={() => onPick(q)}
            title="이 질문으로 이어서 물어보기"
            data-testid={`qna-followup-${i}`}
          >
            <span className="qna-followup-arrow">›</span>
            <span className="qna-followup-text">{q}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
