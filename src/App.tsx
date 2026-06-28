import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  API_BASE_URL,
  createSession,
  deleteAllDocuments,
  deleteDocument,
  deleteAllSessions,
  deleteSession,
  documentPdfUrl,
  fetchDocuments,
  fetchSessionDocuments,
  fetchSessions,
  fetchSessionMessages,
  replaceDocument,
  sendAgentChatStream,
  sendChatStream,
  setSessionDocuments,
  uploadBatch,
} from './api'
import type { ChatMessage, ChatSession, DocumentInfo } from './types'
import { ChatMarkdown, stripDocumentFiguresFromMarkdown } from './ChatMarkdown'
import { ChatFigures } from './ChatFigures'
import { Dashboard } from './Dashboard'

type Mode = 'chat' | 'upload' | 'library' | 'dashboard'

type UploadedDoc = {
  file_id: string
  file_name: string
  technology?: string
  domain?: string
  status?: string
}

const MODE_META: Record<Mode, { label: string; title: string }> = {
  chat: { label: 'Chat', title: 'Chat' },
  upload: { label: 'Upload', title: 'Upload documents' },
  library: { label: 'Library', title: 'Document library' },
  dashboard: { label: 'Usage', title: 'Usage & tokens' },
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Friendly label shown while an agent graph node is running. */
function agentNodeLabel(node: string, toolsUsed: string[]): string {
  switch (node) {
    case 'router_node':
      return 'Understanding your request…'
    case 'rag_node':
      return toolsUsed.length ? `Reasoning (used: ${toolsUsed.join(', ')})…` : 'Reasoning over your documents…'
    case 'tools':
      return 'Searching documents & running tools…'
    case 'general_support_node':
      return 'Composing a reply…'
    default:
      return 'Working…'
  }
}

function NavIcon({ mode }: { mode: Mode }) {
  const common = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75 }
  if (mode === 'chat') {
    return (
      <svg {...common}>
        <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinejoin="round" />
      </svg>
    )
  }
  if (mode === 'upload') {
    return (
      <svg {...common}>
        <path d="M12 4v12M8 8l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
      </svg>
    )
  }
  if (mode === 'library') {
    return (
      <svg {...common}>
        <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M4 19V5M4 19h16M8 15v4M12 11v8M16 7v12" strokeLinecap="round" />
    </svg>
  )
}

export default function App() {
  const [mode, setMode] = useState<Mode>('chat')
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [agentMode, setAgentMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem('agentMode') === '1'
    } catch {
      return false
    }
  })
  const [agentActivity, setAgentActivity] = useState<string>('')
  // Consent offer kept OUT of the message list: the post-send message reload replaces `messages`
  // from the DB (which has no runtime flags), so this survives that reload. Tagged with its
  // session so it's only shown in the conversation it belongs to (no cross-session leakage).
  const [gkOffer, setGkOffer] = useState<{ sourceQuery: string; sessionId: string } | null>(null)
  const [pageBusy, setPageBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDoc[]>([])
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([])
  const [scopeOpen, setScopeOpen] = useState(false)
  const [libraryDocs, setLibraryDocs] = useState<DocumentInfo[]>([])
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [libraryBusyId, setLibraryBusyId] = useState<string | null>(null)
  const [toasts, setToasts] = useState<
    Array<{ id: number; type: 'success' | 'error' | 'info'; title?: string; text: string }>
  >([])

  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const loadGenRef = useRef(0)

  const pushToast = useCallback((type: 'success' | 'error' | 'info', text: string, title?: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000)
    setToasts((prev) => [...prev, { id, type, text, title }])
    const ms = type === 'error' ? 5200 : type === 'success' ? 4800 : 4000
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), ms)
  }, [])

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  )

  const availableDocOptions = useMemo(() => {
    const map = new Map<string, UploadedDoc>()
    for (const d of uploadedDocs) map.set(d.file_id, d)
    for (const id of selectedFileIds) {
      if (!map.has(id)) map.set(id, { file_id: id, file_name: id })
    }
    return Array.from(map.values()).sort((a, b) =>
      a.file_name.localeCompare(b.file_name, undefined, { sensitivity: 'base' }),
    )
  }, [uploadedDocs, selectedFileIds])

  const scopeLabel = useMemo(() => {
    const total = availableDocOptions.length
    const n = selectedFileIds.length
    if (total === 0) return 'No documents in library yet'
    if (n === 0) return `Searching all ${total} document${total === 1 ? '' : 's'}`
    if (n === total) return `Searching all ${total} selected`
    return `Searching ${n} of ${total} document${total === 1 ? '' : 's'}`
  }, [availableDocOptions.length, selectedFileIds.length])

  const refreshSessions = useCallback(async (selectId?: string) => {
    const list = await fetchSessions()
    setSessions(list)
    if (selectId) setActiveSessionId(selectId)
  }, [])

  const refreshLibrary = useCallback(async () => {
    setLibraryLoading(true)
    try {
      const docs = await fetchDocuments()
      setLibraryDocs(docs)
      setUploadedDocs((prev) => {
        const merged = new Map<string, UploadedDoc>()
        for (const d of prev) merged.set(d.file_id, d)
      for (const d of docs) {
        if (!d.document_id) continue
        if (String(d.status ?? '').toUpperCase() === 'FAILED') continue
        merged.set(d.document_id, {
            file_id: d.document_id,
            file_name: d.file_name,
            technology: d.technology ?? undefined,
            domain: d.domain ?? undefined,
            status: d.status ?? undefined,
          })
        }
        return Array.from(merged.values())
      })
    } finally {
      setLibraryLoading(false)
    }
  }, [])

  const loadMessages = useCallback(async (sessionId: string) => {
    const gen = ++loadGenRef.current
    setMessagesLoading(true)
    try {
      const msgs = await fetchSessionMessages(sessionId)
      if (loadGenRef.current !== gen) return
      setMessages(msgs)
    } finally {
      if (loadGenRef.current === gen) setMessagesLoading(false)
    }
  }, [])

  useEffect(() => {
    Promise.all([refreshSessions(), refreshLibrary()]).catch((e) => setError(String(e)))
  }, [refreshSessions, refreshLibrary])

  useEffect(() => {
    try {
      localStorage.setItem('agentMode', agentMode ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [agentMode])

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([])
      setMessagesLoading(false)
      return
    }
    // Do not refetch while streaming — onMeta sets session id mid-stream and would
    // replace local placeholders with server state (user-only) before tokens arrive.
    if (chatSending) return
    loadMessages(activeSessionId).catch((e) => setError(String(e)))
  }, [activeSessionId, loadMessages, chatSending])

  useEffect(() => {
    if (!activeSessionId) {
      setSelectedFileIds([])
      return
    }
    fetchSessionDocuments(activeSessionId)
      .then((ids) => setSelectedFileIds(ids))
      .catch((e) => setError(String(e)))
  }, [activeSessionId])

  useEffect(() => {
    if (mode !== 'chat') return
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, chatSending, mode])

  const bumpSessionMeta = useCallback((sessionId: string, deltaMessages = 2) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, message_count: (s.message_count ?? 0) + deltaMessages, last_message_at: new Date().toISOString() }
          : s,
      ),
    )
  }, [])

  async function onNewChat() {
    setError(null)
    setPageBusy(true)
    try {
      const s = await createSession()
      await refreshSessions(s.id)
      setMessages([])
      setActiveSessionId(s.id)
    } catch (e) {
      setError(String(e))
    } finally {
      setPageBusy(false)
    }
  }

  async function onDeleteChat(id: string) {
    setError(null)
    setPageBusy(true)
    try {
      await deleteSession(id)
      const next = activeSessionId === id ? null : activeSessionId
      await refreshSessions()
      setActiveSessionId(next)
      if (activeSessionId === id) setMessages([])
    } catch (e) {
      setError(String(e))
    } finally {
      setPageBusy(false)
    }
  }

  async function onClearAllChats() {
    if (sessions.length === 0) return
    const n = sessions.length
    if (
      !window.confirm(
        `Delete all ${n} chat${n === 1 ? '' : 's'}? Messages and scope for each conversation will be removed. This cannot be undone.`,
      )
    ) {
      return
    }
    setError(null)
    setPageBusy(true)
    try {
      const { deleted_count } = await deleteAllSessions()
      setSessions([])
      setActiveSessionId(null)
      setMessages([])
      pushToast('success', `Removed ${deleted_count} chat${deleted_count === 1 ? '' : 's'}.`, 'Chats cleared')
    } catch (e) {
      const msg = String(e)
      setError(msg)
      pushToast('error', msg)
    } finally {
      setPageBusy(false)
    }
  }

  async function onSend(opts?: { queryText?: string; allowUngrounded?: boolean; skipUserBubble?: boolean }) {
    const q = (opts?.queryText ?? prompt).trim()
    if (!q || chatSending) return

    if (!opts?.skipUserBubble) setPrompt('')
    setError(null)
    setGkOffer(null)

    const userMsg: ChatMessage = {
      id: Date.now(),
      session_id: activeSessionId ?? '',
      role: 'user',
      content: q,
      created_at: new Date().toISOString(),
    }
    const assistantId = Date.now() + 1
    const assistantPlaceholder: ChatMessage = {
      id: assistantId,
      session_id: activeSessionId ?? '',
      role: 'assistant',
      content: '',
      created_at: new Date().toISOString(),
    }
    setMessages((m) =>
      opts?.skipUserBubble ? [...m, assistantPlaceholder] : [...m, userMsg, assistantPlaceholder],
    )
    setChatSending(true)

    const payload = {
      query: q,
      session_id: activeSessionId ?? undefined,
      ...(selectedFileIds.length > 0 ? { file_ids: selectedFileIds } : {}),
      ...(opts?.allowUngrounded ? { allow_ungrounded: true } : {}),
    }

    // Patch the assistant placeholder with the final answer (shared by both modes).
    const applyDone = (data: {
      answer: string
      session_id: string
      figures?: ChatMessage['figures']
      offer_general_knowledge?: boolean
    }) => {
      setMessages((m) =>
        m.map((x) =>
          x.id === assistantId
            ? {
                ...x,
                content: data.answer,
                session_id: data.session_id,
                figures: data.figures ?? x.figures ?? null,
              }
            : x,
        ),
      )
      // Offer the general-knowledge fallback when the agent refused an ungrounded doc question.
      setGkOffer(
        data.offer_general_knowledge ? { sourceQuery: q, sessionId: data.session_id } : null,
      )
    }
    const applyError = (detail: string) => {
      setMessages((m) =>
        m.map((x) => (x.id === assistantId ? { ...x, content: `**Error:** ${detail}` } : x)),
      )
    }

    try {
      const res = agentMode
        ? await sendAgentChatStream(payload, {
            onNode: (node, tools) => setAgentActivity(agentNodeLabel(node, tools)),
            onDone: (data) => {
              setActiveSessionId((prev) => prev ?? data.session_id)
              applyDone(data)
            },
            onError: applyError,
          })
        : await sendChatStream(payload, {
            onMeta: (meta) => {
              const sid = meta.session_id
              if (!sid) return
              setMessages((m) =>
                m.map((x) => {
                  if (x.id === userMsg.id) return { ...x, session_id: sid }
                  if (x.id === assistantId) {
                    return {
                      ...x,
                      session_id: sid,
                      figures: meta.figures ?? x.figures ?? null,
                    }
                  }
                  return x
                }),
              )
              setActiveSessionId((prev) => prev ?? sid)
            },
            onDone: applyDone,
            onToken: (token) => {
              setMessages((m) => {
                const hasPlaceholder = m.some((x) => x.id === assistantId)
                if (hasPlaceholder) {
                  return m.map((x) =>
                    x.id === assistantId ? { ...x, content: x.content + token } : x,
                  )
                }
                const lastAssistant = [...m].reverse().find((x) => x.role === 'assistant')
                if (!lastAssistant) return m
                return m.map((x) =>
                  x.id === lastAssistant.id ? { ...x, content: x.content + token } : x,
                )
              })
            },
            onError: applyError,
          })
      const resolvedSessionId = res.session_id ?? activeSessionId ?? null
      if (resolvedSessionId && selectedFileIds.length > 0) {
        await setSessionDocuments(resolvedSessionId, { file_ids: selectedFileIds })
      }
      if (resolvedSessionId) {
        setActiveSessionId((prev) => prev ?? resolvedSessionId)
        if (!activeSessionId) {
          void refreshSessions(resolvedSessionId)
        } else {
          bumpSessionMeta(resolvedSessionId)
          void refreshSessions()
        }
      }
      setMessages((m) => {
        const hasPlaceholder = m.some((x) => x.id === assistantId)
        const patchAssistant = (x: (typeof m)[0]) => ({
          ...x,
          content: res.answer,
          session_id: res.session_id,
          figures: res.figures ?? x.figures ?? null,
        })
        if (hasPlaceholder) {
          return m.map((x) => (x.id === assistantId ? patchAssistant(x) : x))
        }
        const lastAssistant = [...m].reverse().find((x) => x.role === 'assistant')
        if (!lastAssistant) {
          return [
            ...m,
            {
              id: Date.now() + 2,
              session_id: res.session_id,
              role: 'assistant' as const,
              content: res.answer,
              figures: res.figures ?? null,
              created_at: new Date().toISOString(),
            },
          ]
        }
        return m.map((x) => (x.id === lastAssistant.id ? patchAssistant(x) : x))
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      pushToast('error', msg)
      setMessages((m) => {
        const assistant = m.find((x) => x.id === assistantId)
        if (assistant?.content?.trim()) {
          return m
        }
        return m.filter((x) => x.id !== assistantId)
      })
    } finally {
      setChatSending(false)
      setAgentActivity('')
    }
  }

  // User accepted the "answer from general knowledge?" prompt: hide the card and re-run the
  // original question with allow_ungrounded so the agent answers from training knowledge.
  async function onAcceptGeneralKnowledge() {
    const q = (gkOffer?.sourceQuery ?? '').trim()
    setGkOffer(null)
    if (!q || chatSending) return
    await onSend({ queryText: q, allowUngrounded: true, skipUserBubble: true })
  }

  function onDismissGeneralKnowledge() {
    setGkOffer(null)
  }

  async function onUpload() {
    if (files.length === 0) return
    setError(null)
    setPageBusy(true)
    try {
      const res = await uploadBatch(files)
      const results = res.results ?? []
      const nOk = results.filter((r) => r.status === 'success').length
      const nDup = results.filter((r) => r.status === 'duplicate').length
      const nErr = results.filter((r) => r.status === 'error').length
      const errResults = results.filter((r) => r.status === 'error')

      if (nOk > 0 || nDup > 0) {
        await refreshLibrary().catch(() => {})
        void refreshSessions()
        if (nOk > 0) setMode('chat')
        const nextDocs: UploadedDoc[] = []
        for (const r of results) {
          if (r.file_id && (r.status === 'success' || r.status === 'duplicate')) {
            nextDocs.push({
              file_id: r.file_id,
              file_name: r.file_name,
              technology: r.technology,
              domain: r.domain,
            })
          }
        }
        if (nextDocs.length) {
          setUploadedDocs((prev) => {
            const merged = new Map<string, UploadedDoc>()
            for (const d of prev) merged.set(d.file_id, d)
            for (const d of nextDocs) merged.set(d.file_id, d)
            return Array.from(merged.values())
          })
        }
      }

      if (nErr > 0 && nOk === 0 && nDup === 0) {
        const detail =
          errResults.map((r) => `${r.file_name}: ${r.message || 'Upload failed'}`).join(' ') ||
          res.message ||
          'Upload failed — file was not stored.'
        setError(detail)
        pushToast('error', detail, 'Upload failed')
      } else if (nErr > 0) {
        const detail = errResults.map((r) => `${r.file_name}: ${r.message}`).join(' · ')
        setError(detail)
        pushToast('error', detail, 'Some files failed')
        const parts: string[] = []
        if (nOk) parts.push(`${nOk} added`)
        if (nDup) parts.push(`${nDup} already in library`)
        if (nErr) parts.push(`${nErr} failed`)
        if (nOk || nDup) pushToast('success', parts.join(' · '), 'Upload finished')
        setFiles([])
      } else {
        const parts: string[] = []
        if (nOk) parts.push(`${nOk} added`)
        if (nDup) parts.push(`${nDup} already in library`)
        pushToast('success', parts.length ? parts.join(' · ') : res.message, 'Upload complete')
        setFiles([])
      }
    } catch (e) {
      const msg = String(e)
      setError(msg)
      pushToast('error', msg)
    } finally {
      setPageBusy(false)
    }
  }

  async function onToggleDoc(fileId: string, checked: boolean) {
    setError(null)
    const next = checked ? Array.from(new Set([...selectedFileIds, fileId])) : selectedFileIds.filter((x) => x !== fileId)
    setSelectedFileIds(next)
    if (activeSessionId) {
      try {
        await setSessionDocuments(activeSessionId, { file_ids: next })
      } catch (e) {
        setError(String(e))
      }
    }
  }

  async function persistSessionScope(ids: string[]) {
    if (!activeSessionId) return
    try {
      await setSessionDocuments(activeSessionId, { file_ids: ids })
    } catch (e) {
      setError(String(e))
    }
  }

  async function onSelectAllDocs() {
    const ids = availableDocOptions.map((d) => d.file_id)
    setSelectedFileIds(ids)
    await persistSessionScope(ids)
  }

  async function onClearDocSelection() {
    setSelectedFileIds([])
    await persistSessionScope([])
  }

  async function onClearAllLibrary() {
    if (libraryDocs.length === 0) return
    const n = libraryDocs.length
    if (
      !window.confirm(
        `Delete all ${n} document${n === 1 ? '' : 's'} from the library? Indexed chunks, vectors, and files will be removed. This cannot be undone.`,
      )
    ) {
      return
    }
    setError(null)
    setPageBusy(true)
    try {
      const { deleted_count, errors } = await deleteAllDocuments()
      if (errors?.length) {
        setError(`Deleted with warnings: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '…' : ''}`)
      }
      setLibraryDocs([])
      setUploadedDocs([])
      setSelectedFileIds([])
      if (activeSessionId) {
        try {
          await setSessionDocuments(activeSessionId, { file_ids: [] })
        } catch {
          /* ignore */
        }
      }
      pushToast('success', `Removed ${deleted_count} document${deleted_count === 1 ? '' : 's'}.`, 'Library cleared')
    } catch (e) {
      const msg = String(e)
      setError(msg)
      pushToast('error', msg)
    } finally {
      setPageBusy(false)
    }
  }

  async function onDeleteLibraryDocument(documentId: string) {
    if (!window.confirm('Delete this document and all indexed data? This cannot be undone.')) return
    setError(null)
    setLibraryBusyId(documentId)
    try {
      const out = await deleteDocument(documentId)
      if (out.errors?.length) setError(`Deleted with warnings: ${out.errors.join('; ')}`)
      setLibraryDocs((prev) => prev.filter((d) => d.document_id !== documentId))
      setUploadedDocs((prev) => prev.filter((d) => d.file_id !== documentId))
      const nextScope = selectedFileIds.filter((id) => id !== documentId)
      setSelectedFileIds(nextScope)
      if (activeSessionId) {
        try {
          await setSessionDocuments(activeSessionId, { file_ids: nextScope })
        } catch {
          /* ignore */
        }
      }
      pushToast('success', 'Document removed from library and search index.')
    } catch (e) {
      setError(String(e))
    } finally {
      setLibraryBusyId(null)
    }
  }

  const headerTitle =
    mode === 'chat' ? (activeSession?.title ?? 'New conversation') : MODE_META[mode].title

  const anyBusy = pageBusy || chatSending

  return (
    <div className="app">
      {toasts.length > 0 && (
        <div className="toastHost" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.type}`} role="status">
              <div className="toastBody">
                {t.title ? <div className="toastTitle">{t.title}</div> : null}
                <div className="toastText">{t.text}</div>
              </div>
              <button
                type="button"
                className="toastClose"
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <nav className="navRail" aria-label="App sections">
        <div className="navBrand" title="PDF Chatbot">
          <span className="navBrandMark">R</span>
        </div>
        {(Object.keys(MODE_META) as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            className={`navItem${mode === m ? ' navItemActive' : ''}`}
            onClick={() => {
              setMode(m)
              if (m === 'library' && libraryDocs.length === 0) {
                refreshLibrary().catch((e) => setError(String(e)))
              }
            }}
            title={MODE_META[m].label}
          >
            <NavIcon mode={m} />
            <span>{MODE_META[m].label}</span>
          </button>
        ))}
      </nav>

      {mode === 'chat' && (
        <aside className="sessionsPanel" aria-label="Conversations">
          <div className="sessionsPanelHead">
            <h2>Chats</h2>
            <div className="sessionsPanelActions">
              <button type="button" className="btnSm btnPrimary" onClick={onNewChat} disabled={pageBusy}>
                New
              </button>
              {sessions.length > 0 && (
                <button
                  type="button"
                  className="btnSm btnDanger"
                  onClick={() => void onClearAllChats()}
                  disabled={pageBusy}
                  title="Delete all conversations"
                >
                  Clear all
                </button>
              )}
            </div>
          </div>
          <div className="sessionsList">
            {sessions.length === 0 ? (
              <p className="emptyHint">Start a new chat to ask questions about your PDFs.</p>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className={`sessionRow${s.id === activeSessionId ? ' sessionRowActive' : ''}`}
                  onClick={() => setActiveSessionId(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setActiveSessionId(s.id)
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="sessionRowText">
                    <div className="sessionRowTitle" title={s.title}>
                      {s.title}
                    </div>
                    <div className="sessionRowMeta">{s.message_count ?? 0} messages</div>
                  </div>
                  <button
                    type="button"
                    className="sessionRowDelete"
                    title="Delete chat"
                    aria-label="Delete chat"
                    disabled={pageBusy}
                    onClick={(e) => {
                      e.stopPropagation()
                      void onDeleteChat(s.id)
                    }}
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>
      )}

      <div className={`workspace${mode === 'chat' ? ' workspaceChat' : ''}`}>
        <header className="workspaceHeader">
          <div>
            <h1 className="workspaceTitle">{headerTitle}</h1>
            {mode === 'chat' && (
              <p className="workspaceSubtitle muted">{scopeLabel}</p>
            )}
          </div>
          <div className="headerRight">
            {mode === 'chat' && (
              <div className="modeSwitch" role="group" aria-label="Answer mode">
                <button
                  type="button"
                  className={`modeSwitchBtn${!agentMode ? ' modeSwitchBtnOn' : ''}`}
                  onClick={() => setAgentMode(false)}
                  title="Classic RAG: retrieve and answer in one step"
                >
                  RAG
                </button>
                <button
                  type="button"
                  className={`modeSwitchBtn${agentMode ? ' modeSwitchBtnOn' : ''}`}
                  onClick={() => setAgentMode(true)}
                  title="Agent: plans, calls tools (search + calculator), and reasons in multiple steps"
                >
                  Agent
                </button>
              </div>
            )}
            <span className="apiPill" title="API endpoint">
              {API_BASE_URL ? API_BASE_URL.replace(/^https?:\/\//, '') : 'localhost:8000'}
            </span>
          </div>
        </header>

        {error && (
          <div className="bannerError" role="alert">
            <span>{error}</span>
            <button type="button" className="bannerDismiss" onClick={() => setError(null)} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}

        <div className="workspaceBody">
          <div key={mode} className="viewPane">
            {mode === 'dashboard' && (
              <Dashboard
                onError={(msg) => {
                  setError(msg)
                  pushToast('error', msg)
                }}
              />
            )}

            {mode === 'upload' && (
              <div className="uploadLayout">
                <section className="card uploadCard">
                  <h2>Add documents to your library</h2>
                  <p className="cardLead muted">
                    Files are extracted, chunked, and indexed for retrieval. Duplicates are detected automatically.
                  </p>
                  <label
                    className={`dropzone${pageBusy ? ' dropzoneDisabled' : ''}`}
                    onDragOver={(e) => {
                      e.preventDefault()
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      const picked = Array.from(e.dataTransfer.files).filter(
                        (f) =>
                          f.type === 'application/pdf' ||
                          f.name.toLowerCase().endsWith('.pdf') ||
                          f.type ===
                            'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
                          f.name.toLowerCase().endsWith('.docx'),
                      )
                      if (picked.length) setFiles(picked)
                    }}
                  >
                    <input
                      type="file"
                      accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx"
                      multiple
                      className="srOnly"
                      disabled={pageBusy}
                      onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                    />
                    <span className="dropzoneTitle">Drop PDF or Word (.docx) files here</span>
                    <span className="dropzoneSub muted">Multiple files supported</span>
                  </label>
                  {files.length > 0 && (
                    <ul className="filePickList">
                      {files.map((f, i) => (
                        <li key={`${f.name}-${f.size}-${i}`}>
                          <span>{f.name}</span>
                          <span className="muted">{formatFileSize(f.size)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="cardActions">
                    <button type="button" className="btnPrimary" onClick={onUpload} disabled={pageBusy || files.length === 0}>
                      {pageBusy ? (
                        <>
                          <span className="spinner" aria-hidden /> Processing…
                        </>
                      ) : (
                        'Upload & index'
                      )}
                    </button>
                    {files.length > 0 && (
                      <button type="button" className="btnGhost" onClick={() => setFiles([])} disabled={pageBusy}>
                        Clear
                      </button>
                    )}
                  </div>
                </section>
              </div>
            )}

            {mode === 'library' && (
              <section className="libraryLayout">
                <div className="libraryToolbar">
                  <p className="muted">
                    {libraryLoading ? 'Loading…' : libraryDocs.length ? `${libraryDocs.length} document(s)` : 'No documents yet.'}
                  </p>
                  <div className="libraryToolbarActions">
                    <button type="button" className="btnSm" disabled={libraryLoading || pageBusy} onClick={() => refreshLibrary().catch((e) => setError(String(e)))}>
                      Refresh
                    </button>
                    {libraryDocs.length > 0 && (
                      <button
                        type="button"
                        className="btnSm btnDanger"
                        disabled={libraryLoading || pageBusy}
                        onClick={() => void onClearAllLibrary()}
                      >
                        Clear all
                      </button>
                    )}
                  </div>
                </div>
                <div className="libraryGrid">
                  {libraryDocs.map((d) => (
                    <article key={d.document_id} className="libraryCard">
                      <div className="libraryCardMain">
                        <h3 title={d.file_name}>{d.file_name}</h3>
                        <div className="libraryCardMeta">
                          {d.status && <span className="tag">{d.status}</span>}
                          {d.technology && <span className="tag tagAccent">{d.technology}</span>}
                          {typeof d.chunk_count === 'number' && <span className="muted">{d.chunk_count} chunks</span>}
                        </div>
                      </div>
                      <div className="libraryCardActions">
                        <a className="btnSm" href={documentPdfUrl(d.document_id)} target="_blank" rel="noreferrer">
                          View
                        </a>
                        <label className="btnSm">
                          Replace
                          <input
                            type="file"
                            accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx"
                            className="srOnly"
                            disabled={libraryBusyId === d.document_id}
                            onChange={async (e) => {
                              const f = e.target.files?.[0]
                              if (!f) return
                              setLibraryBusyId(d.document_id)
                              try {
                                await replaceDocument(d.document_id, f)
                                await refreshLibrary()
                                pushToast('success', 'Document re-indexed.', 'Replaced')
                              } catch (err) {
                                const msg = String(err)
                                setError(msg)
                                pushToast('error', msg)
                              } finally {
                                setLibraryBusyId(null)
                                e.target.value = ''
                              }
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          className="btnSm btnDanger"
                          disabled={libraryBusyId === d.document_id}
                          onClick={() => onDeleteLibraryDocument(d.document_id)}
                        >
                          {libraryBusyId === d.document_id ? '…' : 'Delete'}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}

            {mode === 'chat' && (
              <div className={`chatLayout${messagesLoading ? ' chatLayoutLoading' : ''}`}>
                <div className="chatScroll">
                  {messages.length === 0 && !messagesLoading && !chatSending ? (
                    <div className="chatWelcome">
                      <h2>Ask your documents</h2>
                      <p className="muted">
                        Questions use your full library unless you narrow scope below. Upload PDFs from the Upload tab first.
                      </p>
                      <ul className="chatWelcomeTips">
                        <li>Summarize a report or contract section</li>
                        <li>Compare policies across uploaded files</li>
                        <li>Find tables, diagrams, or code snippets</li>
                      </ul>
                    </div>
                  ) : (
                    messages.map((m) => (
                      <div key={m.id} className={`chatRow chatRow-${m.role}`}>
                        <div className="chatAvatar" aria-hidden>
                          {m.role === 'user' ? 'You' : 'AI'}
                        </div>
                        <div
                          className={`chatBubble${m.role === 'assistant' ? ' chatBubbleMd' : ''}${m.role === 'assistant' && m.figures?.length ? ' chatBubbleMd--figures' : ''}${m.role === 'assistant' && chatSending && !m.content ? ' thinking' : ''}`}
                        >
                          {m.role === 'assistant' ? (
                            m.content ? (
                              <>
                                <ChatMarkdown
                                  content={
                                    m.figures?.length
                                      ? stripDocumentFiguresFromMarkdown(m.content)
                                      : m.content
                                  }
                                />
                                {m.figures?.length ? (
                                  <ChatFigures figures={m.figures} />
                                ) : null}
                              </>
                            ) : chatSending ? (
                              <>
                                <span className="spinner" aria-hidden />
                                <span>{agentActivity || 'Thinking…'}</span>
                              </>
                            ) : null
                          ) : (
                            m.content
                          )}
                        </div>
                      </div>
                    ))
                  )}
                  {messagesLoading && (
                    <div className="chatLoadingBar" aria-hidden>
                      <span className="spinner" />
                    </div>
                  )}
                  {gkOffer && agentMode && !chatSending && gkOffer.sessionId === activeSessionId ? (
                    <div className="gkConsent" role="group" aria-label="General knowledge fallback">
                      <span className="gkConsentText">
                        Not found in your documents. Answer from general AI knowledge instead?
                      </span>
                      <div className="gkConsentActions">
                        <button
                          type="button"
                          className="btnSm btnPrimary"
                          onClick={() => void onAcceptGeneralKnowledge()}
                        >
                          Yes, use general knowledge
                        </button>
                        <button type="button" className="btnSm" onClick={() => onDismissGeneralKnowledge()}>
                          No thanks
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <div ref={messagesEndRef} />
                </div>

                <footer className="chatFooter">
                  <div className={`scopeBar${scopeOpen ? ' scopeBarOpen' : ''}`}>
                    <button
                      type="button"
                      className="scopeToggle"
                      aria-expanded={scopeOpen}
                      onClick={() => setScopeOpen((o) => !o)}
                    >
                      <span className="scopeToggleLabel">Document scope</span>
                      <span className="scopeToggleValue muted">{scopeLabel}</span>
                      <span className="scopeChevron" aria-hidden>
                        {scopeOpen ? '▴' : '▾'}
                      </span>
                    </button>
                    {scopeOpen && (
                      <div className="scopePanel">
                        <div className="scopePanelHead">
                          <p className="muted scopeHint">
                            Leave none selected to search every ingested PDF. Check files to limit this chat.
                          </p>
                          <div className="scopePanelActions">
                            <button type="button" className="btnSm" disabled={anyBusy} onClick={() => void refreshLibrary()}>
                              Sync library
                            </button>
                            <button type="button" className="btnSm" disabled={anyBusy || !availableDocOptions.length} onClick={() => void onSelectAllDocs()}>
                              All
                            </button>
                            <button type="button" className="btnSm" disabled={anyBusy} onClick={() => void onClearDocSelection()}>
                              None
                            </button>
                          </div>
                        </div>
                        {availableDocOptions.length === 0 ? (
                          <p className="emptyHint">Upload PDFs to enable scoped search.</p>
                        ) : (
                          <div className="scopeDocList">
                            {availableDocOptions.map((d) => {
                              const checked = selectedFileIds.includes(d.file_id)
                              return (
                                <label key={d.file_id} className={`scopeDoc${checked ? ' scopeDocOn' : ''}`}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={anyBusy}
                                    onChange={(e) => onToggleDoc(d.file_id, e.target.checked)}
                                  />
                                  <span className="scopeDocName" title={d.file_name}>
                                    {d.file_name}
                                  </span>
                                  {d.status && <span className="tag">{d.status}</span>}
                                </label>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <form
                    className="composer"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void onSend()
                    }}
                  >
                    <textarea
                      rows={1}
                      value={prompt}
                      placeholder={agentMode ? 'Ask the agent — it can search and calculate…' : 'Ask about your documents…'}
                      disabled={chatSending}
                      onChange={(e) => setPrompt(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          void onSend()
                        }
                      }}
                    />
                    <button type="submit" className="btnPrimary composerSend" disabled={chatSending || !prompt.trim()}>
                      {chatSending ? '…' : 'Send'}
                    </button>
                  </form>
                </footer>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
