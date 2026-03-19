import { useState } from 'react'
import './App.css'

function App() {
  const [input, setInput] = useState('')

  return (
    <div className="layout">
      {/* Sidebar */}
      <aside className="sidebar glass">
        <div className="sidebar-header">
          <h2 className="logo">🎮 Project K QnA</h2>
        </div>
        <button className="new-chat-btn">
          <span className="icon">+</span> 새 대화
        </button>
        <div className="sidebar-section">
          <p className="section-title">히스토리</p>
          <div className="history-list">
            {/* History items go here */}
          </div>
        </div>
        <div className="sidebar-footer">
          <button className="kb-btn">📊 지식 베이스</button>
          <div className="status-text">PoC v0.2.0 (React)</div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <div className="welcome-area animate-fade-in">
          <h1 className="main-title">Project K 기획 QnA</h1>
          <p className="sub-title">튜토리얼, 변신, 스킬 등 기획서에 대해 무엇이든 물어보세요.</p>
          
          <div className="suggested-prompts">
            <button className="prompt-card glass">변신 시스템 정리해줘</button>
            <button className="prompt-card glass">스킬 시스템 설명해줘</button>
            <button className="prompt-card glass">전투 시스템 알려줘</button>
            <button className="prompt-card glass">캐릭터 성장 정리해줘</button>
          </div>
        </div>

        {/* Input Area */}
        <div className="input-container glass">
          <button className="attach-btn">+</button>
          <input 
            type="text" 
            placeholder="기획 질문을 입력하세요..." 
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <div className="model-selector">
            <select>
              <option>Opus</option>
              <option>Sonnet</option>
            </select>
          </div>
          <button className="send-btn">↑</button>
        </div>
      </main>
    </div>
  )
}

export default App
