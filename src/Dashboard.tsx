import { useCallback, useEffect, useState } from 'react'
import { fetchDashboardUsage } from './api'
import type { DashboardUsageResponse, UsageComponent, UsageRequestGroup } from './types'

type Props = {
  onError: (msg: string) => void
}

const COMPONENT_LABELS: Record<string, string> = {
  answer: 'Answer (LLM)',
  rerank: 'Rerank',
  classify: 'Classify',
  router: 'Router',
  ocr: 'Vision OCR',
  embed: 'Embedding',
}

function componentLabel(c: string): string {
  return COMPONENT_LABELS[c] ?? c
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toLocaleString()
}

function fmtCost(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  // Tiny per-call costs need more precision than 2 dp.
  const digits = n > 0 && n < 0.01 ? 5 : 4
  return `$${n.toFixed(digits)}`
}

function shortWhen(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

function ComponentRows({ components }: { components: UsageComponent[] }) {
  return (
    <table className="usageSubTable">
      <thead>
        <tr>
          <th>Component</th>
          <th>Calls</th>
          <th>In</th>
          <th>Out</th>
          <th>Total</th>
          <th>Model</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        {components.map((c) => (
          <tr key={c.component}>
            <td>
              <span className={`compChip comp-${c.component}`}>{componentLabel(c.component)}</span>
            </td>
            <td>{fmtNum(c.count)}</td>
            <td>{fmtNum(c.prompt_tokens)}</td>
            <td>{fmtNum(c.completion_tokens)}</td>
            <td>
              <strong>{fmtNum(c.total_tokens)}</strong>
            </td>
            <td className="muted nowrap">{c.provider ? `${c.provider}/` : ''}{c.model ?? '—'}</td>
            <td>{fmtCost(c.cost_usd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function RequestRow({ req }: { req: UsageRequestGroup }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <tr className="usageReqRow" onClick={() => setOpen((o) => !o)}>
        <td className="usageExpandCell">
          <button type="button" className="usageExpandBtn" aria-label={open ? 'Collapse' : 'Expand'}>
            {open ? '▾' : '▸'}
          </button>
        </td>
        <td className="usageQuery" title={req.query_preview}>
          {req.query_preview || '(no query text)'}
        </td>
        <td>
          <div className="compDots">
            {req.components.map((c) => (
              <span key={c.component} className={`compDot comp-${c.component}`} title={`${componentLabel(c.component)}: ${fmtNum(c.total_tokens)} tok`} />
            ))}
          </div>
        </td>
        <td>
          <strong>{fmtNum(req.total_tokens)}</strong>
        </td>
        <td>{fmtCost(req.cost_usd)}</td>
        <td className="muted nowrap">{shortWhen(req.created_at)}</td>
      </tr>
      {open && (
        <tr className="usageDetailRow">
          <td />
          <td colSpan={5}>
            <ComponentRows components={req.components} />
          </td>
        </tr>
      )}
    </>
  )
}

export function Dashboard({ onError }: Props) {
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<DashboardUsageResponse | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetchDashboardUsage({ days, limit: 150 })
      setData(res)
    } catch (e) {
      onError(String(e))
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [days, onError])

  useEffect(() => {
    void load()
  }, [load])

  const s = data?.summary
  const componentTotals = data?.component_totals ?? []
  const requests = data?.requests ?? []

  return (
    <div className="dashboard">
      <div className="dashboardHeader">
        <div>
          <h2 className="dashboardTitle">Usage & tokens</h2>
          <p className="dashboardLead muted">
            Per-request token & cost breakdown across every step — answer, rerank, classify, router,
            vision OCR and embeddings. Cost uses API env rates: OpenAI <code>OPENAI_*_USD_PER_1M</code>,
            Groq <code>GROQ_*_USD_PER_1M</code>.
          </p>
        </div>
        <div className="dashboardToolbar">
          <label className="dashboardDays">
            Window
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </label>
          <button type="button" className="btnSm" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="dashboardLoading muted">Loading usage…</div>
      ) : !data ? (
        <div className="dashboardEmpty muted">No data.</div>
      ) : (
        <>
          <div className="dashboardCards">
            <div className="dashCard">
              <div className="dashCardLabel">Requests</div>
              <div className="dashCardValue">{fmtNum(s?.requests)}</div>
              <div className="dashCardHint">User queries in window</div>
            </div>
            <div className="dashCard">
              <div className="dashCardLabel">Prompt tokens</div>
              <div className="dashCardValue">{fmtNum(s?.prompt_tokens)}</div>
            </div>
            <div className="dashCard">
              <div className="dashCardLabel">Completion tokens</div>
              <div className="dashCardValue">{fmtNum(s?.completion_tokens)}</div>
            </div>
            <div className="dashCard dashCardHighlight">
              <div className="dashCardLabel">Total tokens</div>
              <div className="dashCardValue">{fmtNum(s?.total_tokens)}</div>
            </div>
            <div className="dashCard">
              <div className="dashCardLabel">Est. cost</div>
              <div className="dashCardValue">{fmtCost(s?.estimated_cost_usd ?? null)}</div>
              <div className="dashCardHint">All components</div>
            </div>
          </div>

          {componentTotals.length > 0 && (
            <div className="dashboardTableWrap">
              <h3 className="dashboardTableTitle">Tokens by component</h3>
              <div className="compTotals">
                {componentTotals.map((c) => {
                  const share = s?.total_tokens ? Math.round((c.total_tokens / s.total_tokens) * 100) : 0
                  return (
                    <div className="compTotalCard" key={c.component}>
                      <div className="compTotalHead">
                        <span className={`compChip comp-${c.component}`}>{componentLabel(c.component)}</span>
                        <span className="muted">{share}%</span>
                      </div>
                      <div className="compTotalValue">{fmtNum(c.total_tokens)}</div>
                      <div className="compBar">
                        <span className={`compBarFill comp-${c.component}`} style={{ width: `${share}%` }} />
                      </div>
                      <div className="dashCardHint">
                        {fmtNum(c.count)} calls · {fmtCost(c.cost_usd)}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="dashboardTableWrap">
            <h3 className="dashboardTableTitle">Recent requests</h3>
            {requests.length === 0 ? (
              <p className="muted">
                No usage recorded yet. Ask a question in Chat — each step's tokens appear here after the answer.
              </p>
            ) : (
              <div className="tableScroll">
                <table className="usageTable">
                  <thead>
                    <tr>
                      <th />
                      <th>Query</th>
                      <th>Steps</th>
                      <th>Total</th>
                      <th>Cost</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((req) => (
                      <RequestRow key={req.request_id ?? `${req.created_at}-${req.session_id ?? ''}`} req={req} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
