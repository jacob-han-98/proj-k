import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import AdminPage from './AdminPage.tsx'
import ConflictsPage from './ConflictsPage.tsx'
import SharedPage from './SharedPage.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/admin/:tab" element={<AdminPage />} />
        <Route path="/conflicts" element={<ConflictsPage />} />
        <Route path="/shared/:id" element={<SharedPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
