import { useState, useRef, useEffect } from 'react'
import './App.css'
import { askQuestionStream } from './api'
import type { AskResponse, StreamEvent } from './api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import mermaid from 'mermaid'

// Mermaid component for rendering diagrams
const MermaidBlock = ({ code }: { code: string }) => {
  const ref = useRef<HTMLDivElement>(null)
  
  useEffect(() => {
    mermaid.initialize({ startOnLoad: false, theme: 'dark' })
    if (ref.current) {
      const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`
      mermaid.render(id, code)
        .then((res) => {
          if (ref.current) ref.current.innerHTML = res.svg;
        })
        .catch(err => {
          console.error('Mermaid render error:', err)
          if (ref.current) ref.current.innerHTML = `<pre>Error rendering diagram</pre>`;
        })
    }
  }, [code])

  return <div ref={ref} className="mermaid-wrapper" />
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: AskResponse['sources'];
}

interface Thread {
  id: string;
  title: string;
  messages: Message[];
}

function App() {
  const [input, setInput] = useState('')
  const [threads, setThreads] = useState<Thread[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(false)
  const [activeStatus, setActiveStatus] = useState<string>('')
  const [model, setModel] = useState('claude-opus-4-5')
  
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Load threads from local storage on mount
  useEffect(() => {
    const saved = localStorage.getItem('qna-threads')
    if (saved) {
      try {
        setThreads(JSON.parse(saved))
      } catch(e) {}
    }
  }, [])

  // Save threads to local storage whenever they change
  useEffect(() => {
    localStorage.setItem('qna-threads', JSON.stringify(threads))
  }, [threads])

  const activeThread = threads.find(t => t.id === activeThreadId)
  const messages = activeThread ? activeThread.messages : []

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, isLoading])

  const handleNewChat = () => {
    setActiveThreadId(undefined)
  }

  const handleSelectThread = (id: string) => {
    setActiveThreadId(id)
  }

  const handleDeleteThread = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const newThreads = threads.filter(t => t.id !== id)
    setThreads(newThreads)
    if (activeThreadId === id) {
      setActiveThreadId(undefined)
    }
  }

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMsg = input.trim();
    setInput('');
    setIsLoading(true);

    let currentThreadId = activeThreadId;
    let updatedThreads = [...threads];

    // Create new thread if none is active
    if (!currentThreadId) {
      currentThreadId = Date.now().toString(); // temporary ID
      const newThread: Thread = {
        id: currentThreadId,
        title: userMsg.slice(0, 20) + (userMsg.length > 20 ? '...' : ''),
        messages: [{ role: 'user', content: userMsg }]
      };
      updatedThreads = [newThread, ...updatedThreads];
      setThreads(updatedThreads);
      setActiveThreadId(currentThreadId);
    } else {
      updatedThreads = updatedThreads.map(t => 
        t.id === currentThreadId 
          ? { ...t, messages: [...t.messages, { role: 'user', content: userMsg }] } 
          : t
      );
      setThreads(updatedThreads);
    }

    try {
      await askQuestionStream(
        userMsg,
        (event: StreamEvent) => {
          if (event.type === 'status') {
            setActiveStatus(event.message);
          } else if (event.type === 'result') {
            const res = event.data;
            const realId = res.conversation_id || currentThreadId!;

            setThreads(prev => prev.map(t => {
              if (t.id === currentThreadId) {
                return {
                  ...t,
                  id: realId,
                  messages: [...t.messages, { role: 'assistant', content: res.answer, sources: res.sources }]
                }
              }
              return t;
            }));
            if (currentThreadId !== realId) {
              setActiveThreadId(realId);
            }
          } else if (event.type === 'error') {
            setThreads(prev => prev.map(t =>
              t.id === currentThreadId
                ? { ...t, messages: [...t.messages, { role: 'assistant', content: `오류: ${event.message}` }] }
                : t
            ));
          }
        },
        model,
        '검증세트 최적화',
        currentThreadId,
      );
    } catch (error) {
      console.error(error);
      setThreads(prev => prev.map(t =>
        t.id === currentThreadId
          ? { ...t, messages: [...t.messages, { role: 'assistant', content: '오류가 발생했습니다. 서버가 실행 중인지 확인해주세요.' }] }
          : t
      ));
    } finally {
      setIsLoading(false);
      setActiveStatus('');
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const renderSources = (sources: AskResponse['sources']) => {
    if (!sources || sources.length === 0) return null;
    return (
      <div className="message-sources">
        <p className="sources-title">📚 출처:</p>
        <div className="source-cards-container">
          {sources.map((src, i) => {
            const isConfluence = src.workbook.startsWith('Confluence');
            const icon = isConfluence ? '🔗' : '📊';
            let link = '#';
            if (isConfluence) {
              const searchTerm = src.sheet || src.workbook.split('/').pop();
              link = `https://bighitcorp.atlassian.net/wiki/search?text=${encodeURIComponent(searchTerm || '')}&where=PK`;
            }
            return (
              <a key={i} href={link} target={link !== '#' ? "_blank" : undefined} rel="noreferrer" className="source-link-card glass">
                <span className="source-icon">{icon}</span>
                <span className="source-text">{src.workbook}{src.sheet ? ` / ${src.sheet}` : ''}</span>
                <span className="source-score">({src.score.toFixed(2)})</span>
              </a>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="layout">
      {/* Sidebar */}
      <aside className="sidebar glass">
        <div className="sidebar-header">
          <h2 className="logo">🎮 Project K QnA</h2>
        </div>
        <button className="new-chat-btn" onClick={handleNewChat}>
          <span className="icon">+</span> 새 대화
        </button>
        <div className="sidebar-section">
          <p className="section-title">히스토리</p>
          <div className="history-list">
            {threads.map(t => (
              <div 
                key={t.id} 
                className={`history-item ${activeThreadId === t.id ? 'active' : ''}`}
                onClick={() => handleSelectThread(t.id)}
              >
                <span className="history-title">{t.title}</span>
                <button className="delete-thread-btn" onClick={(e) => handleDeleteThread(e, t.id)}>×</button>
              </div>
            ))}
          </div>
        </div>
        <div className="sidebar-footer">
          <button className="kb-btn">📊 지식 베이스</button>
          <div className="status-text">PoC v0.2.0 (React)</div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <div className="chat-scroll-area">
          {messages.length === 0 ? (
            <div className="welcome-area animate-fade-in">
              <h1 className="main-title">Project K 기획 QnA</h1>
              <p className="sub-title">튜토리얼, 변신, 스킬 등 기획서에 대해 무엇이든 물어보세요.</p>
              
              <div className="suggested-prompts">
                <button className="prompt-card glass" onClick={() => { setInput('변신 시스템 정리해줘'); }}>변신 시스템 정리해줘</button>
                <button className="prompt-card glass" onClick={() => { setInput('텔레포트 시도 시 "거리가 짧아 텔레포트를 이용하지 않았습니다"라는 메시지가 나오는 조건은?'); }}>텔레포트 "거리가 짧아" 메시지 조건은?</button>
                <button className="prompt-card glass" onClick={() => { setInput('도깨비 등급을 올리고 싶은데요 (컷신 테스트에 필요) 치트가 있을까요?'); }}>도깨비 등급 올리는 치트?</button>
                <button className="prompt-card glass" onClick={() => { setInput('로컬 서버의 시간 기준이? 또는 로컬 서버의 시간을 보는 방법?'); }}>로컬 서버 시간 기준/확인 방법?</button>
              </div>
            </div>
          ) : (
            <div className="chat-container">
              {messages.map((msg, idx) => (
                <div key={idx} className={`message-wrapper ${msg.role}`}>
                  <div className={`message glass ${msg.role}`}>
                    <div className="message-content markdown-body">
                      {msg.role === 'user' ? (
                        msg.content
                      ) : (
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            code({ node, inline, className, children, ...props }: any) {
                              const match = /language-(\w+)/.exec(className || '');
                              if (!inline && match && match[1] === 'mermaid') {
                                return <MermaidBlock code={String(children).replace(/\n$/, '')} />;
                              }
                              return <code className={className} {...props}>{children}</code>;
                            }
                          }}
                        >
                          {msg.content}
                        </ReactMarkdown>
                      )}
                    </div>
                    {renderSources(msg.sources)}
                  </div>
                </div>
              ))}
              {isLoading && (
                <div className="message-wrapper assistant">
                  <div className="message glass assistant loading">
                    <span className="loading-status">
                      <span className="loading-spinner"></span>
                      {activeStatus || '처리 중...'}
                    </span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className="input-container glass">
          <button className="attach-btn" disabled={isLoading}>+</button>
          <input 
            type="text" 
            placeholder="기획 질문을 입력하세요..." 
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
          />
          <div className="model-selector">
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={isLoading}>
              <option value="claude-opus-4-5">Opus</option>
              <option value="claude-sonnet-3-5">Sonnet</option>
            </select>
          </div>
          <button className="send-btn" onClick={handleSend} disabled={isLoading}>↑</button>
        </div>
      </main>
    </div>
  )
}

export default App

