import type {
  BatchUploadResponse,
  ChatFigure,
  ChatRequest,
  ChatResponse,
  ChatSession,
  DashboardUsageResponse,
  DocumentInfo,
  SessionDocumentsRequest,
  SessionMessagesResponse,
} from './types'

/** Set in `.env.production` or host env at build time: `VITE_API_BASE_URL=https://your-api.onrender.com` (no trailing slash). Empty = same-origin / Vite dev proxy. */
const rawBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? ''
export const API_BASE_URL = rawBase.replace(/\/$/, '')

export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  return API_BASE_URL ? `${API_BASE_URL}${p}` : p
}

/** Prefix API origin onto relative /documents/... and /upload/... URLs inside Markdown (production builds). */
export function absolutizeMarkdownApiPaths(md: string): string {
  if (!API_BASE_URL || !md) return md
  const b = API_BASE_URL
  return md.replace(
    /(\]\(|!\[[^\]]*\]\()(\/(?:documents|upload)\/[^)\s]+)\)/g,
    (_, prefix: string, path: string) => `${prefix}${b}${path})`,
  )
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as any
    return data?.detail ? String(data.detail) : JSON.stringify(data)
  } catch {
    return await res.text()
  }
}

export async function fetchSessions(): Promise<ChatSession[]> {
  const res = await fetch(apiUrl('/sessions/'), { method: 'GET' })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as ChatSession[]
}

export async function createSession(title?: string): Promise<ChatSession> {
  const res = await fetch(apiUrl('/sessions/'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(title ? { title } : null),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as ChatSession
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(apiUrl(`/sessions/${encodeURIComponent(sessionId)}`), { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
}

export async function deleteAllSessions(): Promise<{ deleted_count: number }> {
  const res = await fetch(apiUrl('/sessions/'), { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
  const data = (await res.json()) as { deleted_count?: number }
  return { deleted_count: data.deleted_count ?? 0 }
}

export async function fetchSessionMessages(sessionId: string) {
  const res = await fetch(apiUrl(`/sessions/${encodeURIComponent(sessionId)}/messages`), { method: 'GET' })
  if (!res.ok) throw new Error(await readError(res))
  const data = (await res.json()) as SessionMessagesResponse
  return data.messages
}

export async function fetchSessionDocuments(sessionId: string): Promise<string[]> {
  const res = await fetch(apiUrl(`/sessions/${encodeURIComponent(sessionId)}/documents`), { method: 'GET' })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as string[]
}

export async function setSessionDocuments(sessionId: string, payload: SessionDocumentsRequest): Promise<string[]> {
  const res = await fetch(apiUrl(`/sessions/${encodeURIComponent(sessionId)}/documents`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as string[]
}

export async function sendChat(payload: ChatRequest): Promise<ChatResponse> {
  const res = await fetch(apiUrl('/chat/'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as ChatResponse
}

export type ChatStreamHandlers = {
  onMeta?: (data: {
    session_id: string
    detected_technology?: string | null
    detected_domain?: string | null
    figures?: ChatFigure[] | null
  }) => void
  onToken?: (content: string) => void
  onDone?: (data: ChatResponse) => void
  onError?: (detail: string) => void
}

/** Stream assistant reply via SSE (POST /chat/stream). */
export async function sendChatStream(
  payload: ChatRequest,
  handlers: ChatStreamHandlers,
): Promise<ChatResponse> {
  const res = await fetch(apiUrl('/chat/stream'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(await readError(res))
  if (!res.body) throw new Error('Streaming not supported by this browser')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalResponse: ChatResponse | null = null
  let streamError: string | null = null

  const dispatch = (obj: Record<string, unknown>) => {
    const type = obj.type as string
    if (type === 'meta' && obj.session_id) {
      handlers.onMeta?.({
        session_id: String(obj.session_id),
        detected_technology: (obj.detected_technology as string | null) ?? null,
        detected_domain: (obj.detected_domain as string | null) ?? null,
        figures: (obj.figures as ChatFigure[] | null) ?? null,
      })
    } else if (type === 'token' && typeof obj.content === 'string') {
      handlers.onToken?.(obj.content)
    } else if (type === 'done' && typeof obj.answer === 'string') {
      finalResponse = {
        answer: obj.answer,
        session_id: String(obj.session_id ?? payload.session_id ?? ''),
        sources: (obj.sources as string[] | null) ?? null,
        detected_technology: (obj.detected_technology as string | null) ?? null,
        detected_domain: (obj.detected_domain as string | null) ?? null,
        figures: (obj.figures as ChatFigure[] | null) ?? null,
      }
      handlers.onDone?.(finalResponse)
    } else if (type === 'error') {
      streamError = String(obj.detail ?? 'Stream error')
      handlers.onError?.(streamError)
    }
  }

  const parseSseBuffer = (chunk: string) => {
    const parts = chunk.split('\n\n')
    const remainder = parts.pop() ?? ''
    for (const part of parts) {
      for (const line of part.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const jsonStr = trimmed.slice(5).trim()
        if (!jsonStr) continue
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(jsonStr) as Record<string, unknown>
        } catch {
          continue
        }
        dispatch(obj)
      }
    }
    return remainder
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    buffer = parseSseBuffer(buffer)
  }
  if (buffer.trim()) {
    parseSseBuffer(`${buffer}\n\n`)
  }

  if (streamError) {
    throw new Error(streamError)
  }
  if (!finalResponse) {
    throw new Error('Stream ended without a completion event')
  }
  return finalResponse
}

export type AgentToolInfo = { name: string; description: string }

export async function fetchAgentTools(): Promise<AgentToolInfo[]> {
  const res = await fetch(apiUrl('/agent/tools'), { method: 'GET' })
  if (!res.ok) throw new Error(await readError(res))
  const data = (await res.json()) as { tools?: AgentToolInfo[] }
  return data.tools ?? []
}

export type AgentStreamHandlers = {
  /** Fired as each graph node runs (router_node, rag_node, tools, general_support_node). */
  onNode?: (node: string, toolsUsed: string[]) => void
  onDone?: (data: ChatResponse & { intent?: string | null; route?: string | null; tools_used?: string[] }) => void
  onError?: (detail: string) => void
}

/**
 * Stream the LangGraph agent reply via SSE (POST /agent/chat/stream).
 *
 * Unlike /chat/stream, the agent emits node-progress events (no token stream) followed by a
 * single `done` event carrying the full answer. Returns a ChatResponse-shaped object so the
 * caller can share the same post-send handling as classic chat.
 */
export async function sendAgentChatStream(
  payload: ChatRequest,
  handlers: AgentStreamHandlers,
): Promise<ChatResponse> {
  const res = await fetch(apiUrl('/agent/chat/stream'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(await readError(res))
  if (!res.body) throw new Error('Streaming not supported by this browser')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalResponse: ChatResponse | null = null
  let streamError: string | null = null

  const dispatch = (obj: Record<string, unknown>) => {
    const type = obj.type as string
    if (type === 'node') {
      handlers.onNode?.(String(obj.node ?? ''), (obj.tools_used as string[] | undefined) ?? [])
    } else if (type === 'done' && typeof obj.answer === 'string') {
      finalResponse = {
        answer: obj.answer,
        session_id: String(obj.session_id ?? payload.session_id ?? ''),
        sources: (obj.sources as string[] | null) ?? null,
        detected_technology: (obj.intent as string | null) ?? null,
        detected_domain: (obj.route as string | null) ?? null,
        figures: (obj.figures as ChatFigure[] | null) ?? null,
        grounded: (obj.grounded as boolean | undefined) ?? true,
        offer_general_knowledge: (obj.offer_general_knowledge as boolean | undefined) ?? false,
      }
      handlers.onDone?.({
        ...finalResponse,
        intent: (obj.intent as string | null) ?? null,
        route: (obj.route as string | null) ?? null,
        tools_used: (obj.tools_used as string[] | undefined) ?? [],
      })
    } else if (type === 'error') {
      streamError = String(obj.detail ?? 'Stream error')
      handlers.onError?.(streamError)
    }
  }

  const parseSseBuffer = (chunk: string) => {
    const parts = chunk.split('\n\n')
    const remainder = parts.pop() ?? ''
    for (const part of parts) {
      for (const line of part.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const jsonStr = trimmed.slice(5).trim()
        if (!jsonStr) continue
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(jsonStr) as Record<string, unknown>
        } catch {
          continue
        }
        dispatch(obj)
      }
    }
    return remainder
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    buffer = parseSseBuffer(buffer)
  }
  if (buffer.trim()) {
    parseSseBuffer(`${buffer}\n\n`)
  }

  if (streamError) {
    throw new Error(streamError)
  }
  if (!finalResponse) {
    throw new Error('Stream ended without a completion event')
  }
  return finalResponse
}

export async function uploadBatch(files: File[]): Promise<BatchUploadResponse> {
  const form = new FormData()
  for (const f of files) form.append('files', f)
  const res = await fetch(apiUrl('/upload/batch'), { method: 'POST', body: form })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as BatchUploadResponse
}

export async function fetchDocuments(): Promise<DocumentInfo[]> {
  const res = await fetch(apiUrl('/documents/'), { method: 'GET' })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as DocumentInfo[]
}

export function documentPdfUrl(documentId: string): string {
  return apiUrl(`/documents/${encodeURIComponent(documentId)}/pdf`)
}

export async function replaceDocument(documentId: string, file: File): Promise<any> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(apiUrl(`/documents/${encodeURIComponent(documentId)}/replace`), { method: 'POST', body: form })
  if (!res.ok) throw new Error(await readError(res))
  return await res.json()
}

export async function fetchDashboardUsage(params?: {
  days?: number
  limit?: number
}): Promise<DashboardUsageResponse> {
  const q = new URLSearchParams()
  if (params?.days != null) q.set('days', String(params.days))
  if (params?.limit != null) q.set('limit', String(params.limit))
  const qs = q.toString()
  const res = await fetch(apiUrl(`/dashboard/usage${qs ? `?${qs}` : ''}`), { method: 'GET' })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as DashboardUsageResponse
}

export async function deleteDocument(documentId: string): Promise<{
  deleted: boolean
  document_id: string
  errors?: string[]
}> {
  const res = await fetch(apiUrl(`/documents/${encodeURIComponent(documentId)}`), { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as {
    deleted: boolean
    document_id: string
    errors?: string[]
  }
}

export async function deleteAllDocuments(): Promise<{ deleted_count: number; errors?: string[] }> {
  const res = await fetch(apiUrl('/documents/'), { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
  const data = (await res.json()) as { deleted_count?: number; errors?: string[] }
  return { deleted_count: data.deleted_count ?? 0, errors: data.errors }
}
