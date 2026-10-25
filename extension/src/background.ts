/// <reference types="chrome" />

import type {
  CollectorSettings,
  CollectorState,
  ExecutionContext,
  NavigationRecord,
  NetworkEntry,
  SavedSnippet,
  WorkbenchRun,
} from './types';

const STORAGE_KEY = 'browserCollectorState.v1';
const DEFAULT_SETTINGS: CollectorSettings = {
  paused: false,
  excludedHosts: [],
  retentionLimit: 300,
  collectNetworkBodies: false,
  inspectStorageValues: false,
  activeTestingAllowlist: [],
};

const state: CollectorState = {
  settings: DEFAULT_SETTINGS,
  navigations: [],
  workbenchHistory: [],
  snippets: [],
  auditLog: [],
};

const requestStart = new Map<string, NetworkEntry>();
const backgroundRuns = new Map<string, { cancelled: boolean }>();

const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function loadState() {
  const loaded = await chrome.storage.local.get(STORAGE_KEY);
  if (!loaded[STORAGE_KEY]) {
    await saveState('state-initialized', 'Default state created');
    return;
  }
  Object.assign(state, loaded[STORAGE_KEY] as Partial<CollectorState>);
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings ?? {}) };
  state.navigations = state.navigations ?? [];
  state.workbenchHistory = state.workbenchHistory ?? [];
  state.snippets = state.snippets ?? [];
  state.auditLog = state.auditLog ?? [];
}

async function saveState(action: string, details: string) {
  state.auditLog.unshift({ timestamp: Date.now(), action, details });
  state.auditLog = state.auditLog.slice(0, 500);

  const retention = Math.max(25, state.settings.retentionLimit || 300);
  state.navigations = state.navigations.slice(0, retention);
  state.workbenchHistory = state.workbenchHistory.slice(0, retention);

  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function extractOrigin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return 'unknown';
  }
}

function shouldSkipUrl(url?: string) {
  if (!url) return true;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return true;
  const host = new URL(url).hostname;
  return state.settings.excludedHosts.some((excluded) => host === excluded || host.endsWith(`.${excluded}`));
}

function upsertNavigation(record: NavigationRecord) {
  const idx = state.navigations.findIndex((n) => n.navId === record.navId);
  if (idx === -1) {
    state.navigations.unshift(record);
  } else {
    state.navigations[idx] = record;
  }
}

function latestNavForTab(tabId: number, frameId = 0) {
  return state.navigations.find((nav) => nav.tabId === tabId && nav.frameId === frameId);
}

function registerNavigation(args: {
  tabId: number;
  frameId: number;
  windowId?: number;
  url: string;
  navigationType: string;
  isSpaNavigation: boolean;
}) {
  if (state.settings.paused || shouldSkipUrl(args.url)) return;
  const nav: NavigationRecord = {
    navId: uid(),
    tabId: args.tabId,
    frameId: args.frameId,
    windowId: args.windowId,
    collectionSessionId: uid(),
    url: args.url,
    origin: extractOrigin(args.url),
    startedAt: Date.now(),
    navigationType: args.navigationType,
    isSpaNavigation: args.isSpaNavigation,
    network: [],
  };
  upsertNavigation(nav);
}

function attachNetworkEntry(entry: NetworkEntry) {
  const nav = latestNavForTab(entry.tabId, entry.frameId);
  if (nav) {
    entry.navId = nav.navId;
    nav.network.unshift(entry);
    nav.network = nav.network.slice(0, 1500);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await loadState();
  await saveState('installed', 'Extension installed');
});

void loadState();

chrome.action.onClicked.addListener(async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const before = state.navigations.length;
  state.navigations = state.navigations.filter((n) => n.tabId !== tabId);
  if (state.navigations.length !== before) {
    await saveState('tab-removed', `Pruned records for tab ${tabId}`);
  }
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0 || shouldSkipUrl(details.url)) return;
  registerNavigation({
    tabId: details.tabId,
    frameId: details.frameId,
    url: details.url,
    navigationType: details.transitionType,
    isSpaNavigation: false,
  });
  await saveState('navigation-committed', details.url);
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0 || shouldSkipUrl(details.url)) return;
  registerNavigation({
    tabId: details.tabId,
    frameId: details.frameId,
    url: details.url,
    navigationType: 'spa-history',
    isSpaNavigation: true,
  });
  await saveState('spa-navigation', details.url);
});

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const nav = latestNavForTab(details.tabId, details.frameId);
  if (!nav) return;
  nav.completedAt = Date.now();
  await saveState('navigation-completed', nav.url);
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || state.settings.paused) return;
    const entry: NetworkEntry = {
      requestId: details.requestId,
      tabId: details.tabId,
      frameId: details.frameId,
      method: details.method,
      url: details.url,
      type: details.type,
      initiator: details.initiator,
      startTime: Date.now(),
    };
    requestStart.set(details.requestId, entry);
    attachNetworkEntry(entry);
  },
  { urls: ['<all_urls>'] },
);

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    const entry = requestStart.get(details.requestId);
    if (!entry) return;
    entry.endTime = Date.now();
    entry.durationMs = entry.endTime - entry.startTime;
    entry.statusCode = details.statusCode;
    entry.fromCache = details.fromCache;
    entry.responseHeaders = details.responseHeaders;
    requestStart.delete(details.requestId);
    await saveState('request-completed', `${details.method} ${details.url}`);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

chrome.webRequest.onErrorOccurred.addListener(
  async (details) => {
    const entry = requestStart.get(details.requestId);
    if (!entry) return;
    entry.endTime = Date.now();
    entry.durationMs = entry.endTime - entry.startTime;
    entry.error = details.error;
    requestStart.delete(details.requestId);
    await saveState('request-failed', `${details.method} ${details.url} (${details.error})`);
  },
  { urls: ['<all_urls>'] },
);

function stableString(value: unknown) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function injectedRunner(code: string) {
  const logs: Array<{ level: string; args: string[] }> = [];
  const methods: Array<'log' | 'warn' | 'error' | 'info'> = ['log', 'warn', 'error', 'info'];
  const original: Partial<Record<'log' | 'warn' | 'error' | 'info', (...args: unknown[]) => void>> = {};

  methods.forEach((method) => {
    original[method] = console[method];
    console[method] = (...args: unknown[]) => {
      logs.push({
        level: method,
        args: args.map((arg) => {
          try {
            return typeof arg === 'string' ? arg : JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }),
      });
      original[method]?.(...args);
    };
  });

  const finalize = () => {
    methods.forEach((method) => {
      if (original[method]) {
        console[method] = original[method] as (...args: unknown[]) => void;
      }
    });
  };

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (async () => { ${code}\n })();`);
    return Promise.resolve(fn()).then((result) => {
      finalize();
      return { logs, result: stableString(result) };
    });
  } catch (error) {
    finalize();
    return Promise.resolve({
      logs,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
    });
  }
}

async function runBackgroundCode(
  runId: string,
  code: string,
  timeoutMs: number,
): Promise<{
  status: WorkbenchRun['status'];
  result: string | undefined;
  logs: Array<{ level: string; args: string[] }>;
  error: string | undefined;
}> {
  backgroundRuns.set(runId, { cancelled: false });
  try {
    type RunnerResult = { logs?: Array<{ level: string; args: string[] }>; result?: string; error?: string };
    const result = await Promise.race([
      injectedRunner(code),
      new Promise<{ error: string }>((resolve) => {
        setTimeout(() => resolve({ error: `Timed out after ${timeoutMs}ms` }), timeoutMs);
      }),
    ]) as RunnerResult;
    if (backgroundRuns.get(runId)?.cancelled) {
      return { status: 'cancelled' as const, result: undefined, logs: [], error: 'Cancelled' };
    }
    if (result.error) {
      const status: WorkbenchRun['status'] = result.error.startsWith('Timed out') ? 'timeout' : 'error';
      return { status, result: undefined, logs: result.logs ?? [], error: result.error };
    }
    return { status: 'success' as const, result: result.result ?? 'undefined', logs: result.logs ?? [], error: undefined };
  } finally {
    backgroundRuns.delete(runId);
  }
}

function toCsv(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return '';
  const keys = Object.keys(rows[0]);
  const header = keys.join(',');
  const body = rows
    .map((row) =>
      keys
        .map((key) => `"${String(row[key] ?? '').replaceAll('"', '""')}"`)
        .join(','),
    )
    .join('\n');
  return `${header}\n${body}`;
}

function toMarkdown(records: NavigationRecord[]) {
  return records
    .map((nav) => {
      const loadMs =
        nav.metrics?.loadEventEndMs && nav.metrics?.navigationStart
          ? nav.metrics.loadEventEndMs - nav.metrics.navigationStart
          : null;
      return [
        `## ${nav.metadata?.title || nav.url}`,
        `- URL: ${nav.url}`,
        `- Navigation: ${nav.navigationType}${nav.isSpaNavigation ? ' (SPA)' : ''}`,
        `- Started: ${new Date(nav.startedAt).toISOString()}`,
        `- Load duration: ${loadMs ?? 'unavailable'}`,
        `- Requests: ${nav.network.length}`,
        `- Findings: ${nav.security?.findings.length ?? 0}`,
      ].join('\n');
    })
    .join('\n\n');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    if (message?.type === 'collector:getState') {
      sendResponse({ ok: true, state });
      return;
    }

    if (message?.type === 'collector:clearData') {
      state.navigations = [];
      state.workbenchHistory = [];
      await saveState('clear-data', 'Collector data cleared');
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'collector:updateSettings') {
      state.settings = { ...state.settings, ...(message.payload ?? {}) };
      await saveState('settings-updated', JSON.stringify(message.payload ?? {}));
      sendResponse({ ok: true, settings: state.settings });
      return;
    }

    if (message?.type === 'collector:snapshot') {
      const payload = message.payload;
      if (!payload || state.settings.paused || shouldSkipUrl(payload.metadata?.url)) {
        sendResponse({ ok: false });
        return;
      }
      if (sender.tab?.id !== undefined) {
        payload.metadata.tabId = sender.tab.id;
        payload.metadata.windowId = sender.tab.windowId;
      }
      if (sender.frameId !== undefined) {
        payload.metadata.frameId = sender.frameId;
      }
      const nav =
        state.navigations.find((existing) => existing.navId === payload.metadata?.navId) ||
        latestNavForTab(payload.metadata.tabId, payload.metadata.frameId);

      if (nav) {
        nav.metadata = payload.metadata;
        nav.metrics = payload.metrics;
        nav.resources = payload.resources;
        nav.dom = payload.dom;
        nav.storage = payload.storage;
        nav.security = payload.security;
        nav.js = payload.js;
        nav.completedAt = payload.metrics?.navigationEnd ?? nav.completedAt;
      }
      await saveState('snapshot-updated', payload.metadata?.url ?? 'unknown');
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'collector:fetchCookies') {
      const url = message.payload?.url;
      if (!url) {
        sendResponse({ ok: false, cookies: [] });
        return;
      }
      const cookies = await chrome.cookies.getAll({ url });
      sendResponse({
        ok: true,
        cookies: cookies.map((cookie) => ({
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          expires: cookie.expirationDate,
          partitionKey: cookie.partitionKey?.topLevelSite,
        })),
      });
      return;
    }

    if (message?.type === 'collector:export') {
      const format = message.payload?.format;
      const records = state.navigations;
      if (format === 'json') {
        sendResponse({ ok: true, mime: 'application/json', content: JSON.stringify(records, null, 2) });
        return;
      }
      if (format === 'csv') {
        const rows = records.map((record) => ({
          timestamp: new Date(record.startedAt).toISOString(),
          url: record.url,
          title: record.metadata?.title ?? '',
          navType: record.navigationType,
          isSpa: record.isSpaNavigation,
          ttfbMs: record.metrics?.ttfbMs ?? 'n/a',
          lcpMs: record.metrics?.largestContentfulPaintMs ?? 'n/a',
          cls: record.metrics?.cumulativeLayoutShift ?? 'n/a',
          requests: record.network.length,
          findings: record.security?.findings.length ?? 0,
        }));
        sendResponse({ ok: true, mime: 'text/csv', content: toCsv(rows) });
        return;
      }
      sendResponse({ ok: true, mime: 'text/markdown', content: toMarkdown(records) });
      return;
    }

    if (message?.type === 'workbench:getSnippets') {
      sendResponse({ ok: true, snippets: state.snippets });
      return;
    }

    if (message?.type === 'workbench:saveSnippet') {
      const payload = message.payload as SavedSnippet;
      const exists = state.snippets.find((snippet) => snippet.id === payload.id);
      if (exists) {
        exists.name = payload.name;
        exists.code = payload.code;
        exists.updatedAt = Date.now();
      } else {
        state.snippets.unshift({ ...payload, updatedAt: Date.now() });
      }
      await saveState('snippet-saved', payload.name);
      sendResponse({ ok: true, snippets: state.snippets });
      return;
    }

    if (message?.type === 'workbench:deleteSnippet') {
      state.snippets = state.snippets.filter((snippet) => snippet.id !== message.payload?.id);
      await saveState('snippet-deleted', message.payload?.id ?? 'unknown');
      sendResponse({ ok: true, snippets: state.snippets });
      return;
    }

    if (message?.type === 'workbench:cancelRun') {
      const runId = message.payload?.runId;
      if (runId) {
        const runState = backgroundRuns.get(runId);
        if (runState) runState.cancelled = true;
      }
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'workbench:run') {
      const context = message.payload?.context as ExecutionContext;
      const code = String(message.payload?.code ?? '');
      const tabId = Number(message.payload?.tabId);
      const frameId = Number(message.payload?.frameId ?? 0);
      const timeoutMs = Math.max(500, Number(message.payload?.timeoutMs ?? 10000));
      const runId = uid();
      const base: WorkbenchRun = {
        runId,
        timestamp: Date.now(),
        context,
        tabId: Number.isNaN(tabId) ? undefined : tabId,
        frameId,
        code,
        status: 'success',
        logs: [],
      };

      if (context === 'background') {
        const result = await runBackgroundCode(runId, code, timeoutMs);
        const run: WorkbenchRun = {
          ...base,
          status: result.status,
          result: result.result,
          error: result.error,
          logs: result.logs,
        };
        state.workbenchHistory.unshift(run);
        await saveState('workbench-run', `background:${result.status}`);
        sendResponse({ ok: true, run });
        return;
      }

      if (Number.isNaN(tabId)) {
        sendResponse({ ok: false, error: 'A valid tab must be selected for page/isolated execution.' });
        return;
      }

      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          world: context === 'page' ? 'MAIN' : 'ISOLATED',
          args: [code],
          func: injectedRunner,
        });

        const payload = result?.result as { result?: string; error?: string; logs?: Array<{ level: string; args: string[] }> };
        const status: WorkbenchRun['status'] = payload?.error ? 'error' : 'success';
        const run: WorkbenchRun = {
          ...base,
          status,
          result: payload?.result,
          error: payload?.error,
          logs: payload?.logs ?? [],
        };
        state.workbenchHistory.unshift(run);
        await saveState('workbench-run', `${context}:${status}`);
        sendResponse({ ok: true, run });
      } catch (error) {
        const run: WorkbenchRun = {
          ...base,
          status: 'error',
          error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
          logs: [],
        };
        state.workbenchHistory.unshift(run);
        await saveState('workbench-run', `${context}:error`);
        sendResponse({ ok: true, run });
      }
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message type' });
  })();

  return true;
});
