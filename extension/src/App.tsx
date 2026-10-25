import { useEffect, useMemo, useState } from 'react';
import './App.css';
import type { CollectorSettings, CollectorState, ExecutionContext, NavigationRecord, SavedSnippet, WorkbenchRun } from './types';

const SECTION_TABS = ['Overview', 'Network', 'DOM', 'Storage', 'JavaScript', 'Security', 'History', 'Workbench'] as const;

type SectionTab = (typeof SECTION_TABS)[number];

const defaultCode = `console.log({
  url: location.href,
  title: document.title,
  readyState: document.readyState
});`;

function formatValue(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'unavailable';
  return Number.isInteger(value) ? `${value}` : value.toFixed(2);
}

function downloadText(filename: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildRegressionSummary(records: NavigationRecord[]) {
  if (records.length < 2) {
    return ['Need at least two visits for regression comparison.'];
  }

  const [current, previous] = records;
  const messages: string[] = [];
  const currentLcp = current.metrics?.largestContentfulPaintMs;
  const previousLcp = previous.metrics?.largestContentfulPaintMs;
  const currentTtfb = current.metrics?.ttfbMs;
  const previousTtfb = previous.metrics?.ttfbMs;

  if (currentLcp !== undefined && previousLcp !== undefined && currentLcp !== null && previousLcp !== null) {
    const delta = currentLcp - previousLcp;
    if (delta > 300) messages.push(`LCP regression +${delta.toFixed(0)}ms`);
    else messages.push(`LCP delta ${delta.toFixed(0)}ms`);
  } else {
    messages.push('LCP unavailable in one of the samples.');
  }

  if (currentTtfb !== undefined && previousTtfb !== undefined && currentTtfb !== null && previousTtfb !== null) {
    const delta = currentTtfb - previousTtfb;
    if (delta > 150) messages.push(`TTFB regression +${delta.toFixed(0)}ms`);
    else messages.push(`TTFB delta ${delta.toFixed(0)}ms`);
  } else {
    messages.push('TTFB unavailable in one of the samples.');
  }

  const currentRequests = current.network.length;
  const previousRequests = previous.network.length;
  const requestDelta = currentRequests - previousRequests;
  if (requestDelta > 0) {
    messages.push(`Resource/request count increased by ${requestDelta}.`);
  } else {
    messages.push(`Resource/request delta ${requestDelta}.`);
  }

  return messages;
}

export default function App() {
  const [state, setState] = useState<CollectorState | null>(null);
  const [activeTab, setActiveTab] = useState<SectionTab>('Overview');
  const [search, setSearch] = useState('');
  const [selectedNavId, setSelectedNavId] = useState<string | null>(null);
  const [excludeInput, setExcludeInput] = useState('');

  const [workbenchCode, setWorkbenchCode] = useState(defaultCode);
  const [executionContext, setExecutionContext] = useState<ExecutionContext>('page');
  const [runOutput, setRunOutput] = useState<WorkbenchRun | null>(null);
  const [snippetName, setSnippetName] = useState('');
  const [selectedTabId, setSelectedTabId] = useState<number | ''>('');

  const refreshState = async () => {
    const response = await chrome.runtime.sendMessage({ type: 'collector:getState' });
    if (response?.ok) {
      setState(response.state as CollectorState);
      const first = (response.state as CollectorState).navigations[0];
      if (!selectedNavId && first) setSelectedNavId(first.navId);
    }
  };

  useEffect(() => {
    void refreshState();
    const timer = setInterval(() => {
      void refreshState();
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const records = state?.navigations ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return records;
    return records.filter((nav) => nav.url.toLowerCase().includes(q) || nav.metadata?.title.toLowerCase().includes(q));
  }, [records, search]);

  const selected = filtered.find((nav) => nav.navId === selectedNavId) ?? filtered[0] ?? null;

  const updateSettings = async (patch: Partial<CollectorSettings>) => {
    await chrome.runtime.sendMessage({ type: 'collector:updateSettings', payload: patch });
    await refreshState();
  };

  const exportData = async (format: 'json' | 'csv' | 'md') => {
    const response = await chrome.runtime.sendMessage({
      type: 'collector:export',
      payload: { format },
    });
    if (response?.ok) {
      const ext = format === 'md' ? 'md' : format;
      downloadText(`browser-collector-export.${ext}`, response.mime, response.content);
    }
  };

  const runCode = async () => {
    const response = await chrome.runtime.sendMessage({
      type: 'workbench:run',
      payload: {
        context: executionContext,
        code: workbenchCode,
        tabId: selectedTabId === '' ? undefined : selectedTabId,
        frameId: 0,
        timeoutMs: 12000,
      },
    });

    if (response?.ok) {
      setRunOutput(response.run as WorkbenchRun);
      await refreshState();
    }
  };

  const saveSnippet = async () => {
    if (!snippetName.trim()) return;
    const snippet: SavedSnippet = {
      id: crypto.randomUUID(),
      name: snippetName,
      code: workbenchCode,
      updatedAt: Date.now(),
    };
    await chrome.runtime.sendMessage({ type: 'workbench:saveSnippet', payload: snippet });
    setSnippetName('');
    await refreshState();
  };

  const loadSnippet = (snippet: SavedSnippet) => {
    setWorkbenchCode(snippet.code);
    setSnippetName(snippet.name);
  };

  if (!state) {
    return <div className="app">Loading collector state…</div>;
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Browser-wide Collector Dashboard</h1>
        <div className="actions">
          <button onClick={() => void exportData('json')}>Export JSON</button>
          <button onClick={() => void exportData('csv')}>Export CSV</button>
          <button onClick={() => void exportData('md')}>Export Markdown</button>
          <button onClick={() => void chrome.runtime.sendMessage({ type: 'collector:clearData' }).then(refreshState)}>
            Clear Data
          </button>
        </div>
      </header>

      <section className="controls">
        <label>
          Search
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter URL/title" />
        </label>
        <label>
          Retention
          <input
            type="number"
            min={25}
            max={3000}
            value={state.settings.retentionLimit}
            onChange={(event) => void updateSettings({ retentionLimit: Number(event.target.value) || 300 })}
          />
        </label>
        <button onClick={() => void updateSettings({ paused: !state.settings.paused })}>
          {state.settings.paused ? 'Resume Collection' : 'Pause Collection'}
        </button>
        <label>
          Exclude host
          <input value={excludeInput} onChange={(event) => setExcludeInput(event.target.value)} placeholder="example.com" />
        </label>
        <button
          onClick={() => {
            const next = Array.from(new Set([...state.settings.excludedHosts, excludeInput.trim()])).filter(Boolean);
            void updateSettings({ excludedHosts: next });
            setExcludeInput('');
          }}
        >
          Add Exclusion
        </button>
      </section>

      <nav className="section-tabs">
        {SECTION_TABS.map((tab) => (
          <button key={tab} className={tab === activeTab ? 'active' : ''} onClick={() => setActiveTab(tab)}>
            {tab}
          </button>
        ))}
      </nav>

      <main className="content-grid">
        <aside className="history-list">
          <h2>Visited Pages ({filtered.length})</h2>
          <ul>
            {filtered.map((nav) => (
              <li key={nav.navId} className={selected?.navId === nav.navId ? 'selected' : ''}>
                <button onClick={() => setSelectedNavId(nav.navId)}>
                  <div className="title">{nav.metadata?.title || nav.url}</div>
                  <div className="meta">{nav.url}</div>
                  <div className="meta">
                    {new Date(nav.startedAt).toLocaleString()} • {nav.isSpaNavigation ? 'SPA' : 'Full'}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="panel">
          {activeTab === 'Overview' && selected && (
            <>
              <h2>{selected.metadata?.title || selected.url}</h2>
              <p>{selected.url}</p>
              <div className="metrics">
                <div><strong>Navigation Type:</strong> {selected.navigationType}</div>
                <div><strong>Protocol:</strong> {selected.metadata?.protocol ?? 'unavailable'}</div>
                <div><strong>TTFB:</strong> {formatValue(selected.metrics?.ttfbMs)} ms</div>
                <div><strong>FCP:</strong> {formatValue(selected.metrics?.firstContentfulPaintMs)} ms</div>
                <div><strong>LCP:</strong> {formatValue(selected.metrics?.largestContentfulPaintMs)} ms</div>
                <div><strong>CLS:</strong> {formatValue(selected.metrics?.cumulativeLayoutShift)}</div>
                <div><strong>INP:</strong> {formatValue(selected.metrics?.interactionToNextPaintMs)} ms</div>
                <div><strong>Requests:</strong> {selected.network.length}</div>
              </div>
              <h3>Regression Comparison (latest two records)</h3>
              <ul>
                {buildRegressionSummary(
                  records.filter((record) => record.origin === selected.origin).slice(0, 2),
                ).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}

          {activeTab === 'Network' && selected && (
            <>
              <h2>Network</h2>
              <table>
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>URL</th>
                    <th>Status</th>
                    <th>Type</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.network.slice(0, 250).map((entry) => (
                    <tr key={entry.requestId + entry.startTime}>
                      <td>{entry.method}</td>
                      <td className="url-cell">{entry.url}</td>
                      <td>{entry.statusCode ?? entry.error ?? 'pending'}</td>
                      <td>{entry.type || 'n/a'}</td>
                      <td>{formatValue(entry.durationMs)} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {activeTab === 'DOM' && selected && (
            <>
              <h2>DOM Inventory</h2>
              <div className="metrics">
                <div><strong>Total Elements:</strong> {selected.dom?.totalElements ?? 'unavailable'}</div>
                <div><strong>Links:</strong> {selected.dom?.links ?? 'unavailable'}</div>
                <div><strong>Buttons:</strong> {selected.dom?.buttons ?? 'unavailable'}</div>
                <div><strong>Forms:</strong> {selected.dom?.forms ?? 'unavailable'}</div>
                <div><strong>Hidden Elements:</strong> {selected.dom?.hiddenElements ?? 'unavailable'}</div>
                <div><strong>Shadow Roots:</strong> {selected.dom?.shadowRoots ?? 'unavailable'}</div>
                <div><strong>ARIA-labeled elements:</strong> {selected.dom?.ariaCount ?? 'unavailable'}</div>
                <div><strong>Added Nodes:</strong> {selected.dom?.mutationSummary.addedNodes ?? 'unavailable'}</div>
                <div><strong>Removed Nodes:</strong> {selected.dom?.mutationSummary.removedNodes ?? 'unavailable'}</div>
              </div>
              <pre>{JSON.stringify(selected.dom?.byTag ?? {}, null, 2)}</pre>
            </>
          )}

          {activeTab === 'Storage' && selected && (
            <>
              <h2>Storage & Cookies</h2>
              <div className="metrics">
                <div><strong>Cookies:</strong> {selected.storage?.cookies.length ?? 'unavailable'}</div>
                <div><strong>Local Storage Keys:</strong> {selected.storage?.localStorageKeys.length ?? 'unavailable'}</div>
                <div><strong>Session Storage Keys:</strong> {selected.storage?.sessionStorageKeys.length ?? 'unavailable'}</div>
                <div><strong>IndexedDB Databases:</strong> {selected.storage?.indexedDbDatabases.length ?? 'unavailable'}</div>
                <div><strong>Cache Storage Keys:</strong> {selected.storage?.cacheStorageKeys.length ?? 'unavailable'}</div>
                <div><strong>Service Workers:</strong> {selected.storage?.serviceWorkers.length ?? 'unavailable'}</div>
              </div>
              <pre>{JSON.stringify(selected.storage, null, 2)}</pre>
            </>
          )}

          {activeTab === 'JavaScript' && selected && (
            <>
              <h2>JavaScript & Runtime Observations</h2>
              <div className="metrics">
                <div><strong>Framework Hints:</strong> {selected.js?.frameworkHints.join(', ') || 'none'}</div>
                <div><strong>Exposed Config Keys:</strong> {selected.js?.exposedConfigKeys.length ?? 'unavailable'}</div>
                <div><strong>Console Errors:</strong> {selected.js?.consoleErrors.length ?? 'unavailable'}</div>
                <div><strong>Unhandled Rejections:</strong> {selected.js?.unhandledRejections.length ?? 'unavailable'}</div>
              </div>
              <pre>{JSON.stringify(selected.js, null, 2)}</pre>
            </>
          )}

          {activeTab === 'Security' && selected && (
            <>
              <h2>Security Findings</h2>
              {selected.security?.findings.length ? (
                <ul>
                  {selected.security.findings.map((finding) => (
                    <li key={finding.id + finding.title}>
                      <strong>[{finding.severity.toUpperCase()}]</strong> {finding.title} ({finding.confidence} confidence) — {finding.evidence}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No findings currently observed for this navigation.</p>
              )}
              <pre>{JSON.stringify(selected.security, null, 2)}</pre>
            </>
          )}

          {activeTab === 'History' && (
            <>
              <h2>Collection Audit Log</h2>
              <ul>
                {state.auditLog.slice(0, 200).map((event) => (
                  <li key={event.timestamp + event.action}>
                    {new Date(event.timestamp).toLocaleString()} — <strong>{event.action}</strong> — {event.details}
                  </li>
                ))}
              </ul>
            </>
          )}

          {activeTab === 'Workbench' && (
            <>
              <h2>JavaScript Workbench</h2>
              <p className="warning">
                Review scripts before execution. Page context runs with website privileges, isolated context runs as a content script, and background context runs with extension privileges.
              </p>
              <div className="workbench-controls">
                <label>
                  Context
                  <select value={executionContext} onChange={(event) => setExecutionContext(event.target.value as ExecutionContext)}>
                    <option value="page">Current page context</option>
                    <option value="isolated">Isolated extension context</option>
                    <option value="background">Extension background context</option>
                  </select>
                </label>
                <label>
                  Target tab ID
                  <input
                    type="number"
                    value={selectedTabId}
                    onChange={(event) => setSelectedTabId(event.target.value === '' ? '' : Number(event.target.value))}
                    placeholder="Required for page/isolated"
                  />
                </label>
                <button onClick={runCode}>Run</button>
                <button onClick={() => setWorkbenchCode('')}>Clear</button>
              </div>

              <div className="editor-block">
                <div className="line-gutter">
                  {workbenchCode.split('\n').map((_, index) => (
                    <div key={index + 1}>{index + 1}</div>
                  ))}
                </div>
                <textarea value={workbenchCode} onChange={(event) => setWorkbenchCode(event.target.value)} spellCheck={false} />
              </div>

              <div className="snippet-controls">
                <input
                  value={snippetName}
                  onChange={(event) => setSnippetName(event.target.value)}
                  placeholder="Snippet name"
                />
                <button onClick={saveSnippet}>Save Snippet</button>
              </div>

              <div className="snippet-list">
                <h3>Saved snippets</h3>
                <ul>
                  {state.snippets.map((snippet) => (
                    <li key={snippet.id}>
                      <button onClick={() => loadSnippet(snippet)}>{snippet.name}</button>
                      <button
                        onClick={() =>
                          chrome.runtime
                            .sendMessage({ type: 'workbench:deleteSnippet', payload: { id: snippet.id } })
                            .then(refreshState)
                        }
                      >
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              <h3>Run output</h3>
              {runOutput ? (
                <div className="output">
                  <div><strong>Status:</strong> {runOutput.status}</div>
                  <div><strong>Timestamp:</strong> {new Date(runOutput.timestamp).toLocaleString()}</div>
                  {runOutput.result && <pre>{runOutput.result}</pre>}
                  {runOutput.error && <pre className="error">{runOutput.error}</pre>}
                  {runOutput.logs.length > 0 && <pre>{JSON.stringify(runOutput.logs, null, 2)}</pre>}
                </div>
              ) : (
                <p>Ready. Code has not been executed.</p>
              )}

              <h3>History</h3>
              <ul>
                {state.workbenchHistory.slice(0, 50).map((run) => (
                  <li key={run.runId}>
                    {new Date(run.timestamp).toLocaleString()} — {run.context} — {run.status}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
