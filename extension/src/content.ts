/// <reference types="chrome" />

import type {
  DomInventory,
  JsObservation,
  PageMetadata,
  PerformanceMetricSet,
  ResourceMetric,
  SecurityObservation,
  StorageInventory,
} from './types';

declare global {
  interface Window {
    __collectorNavId?: string;
  }
}

const mutationState = { added: 0, removed: 0 };
const consoleErrors: Array<{ type: string; message: string; timestamp: number }> = [];
const unhandledRejections: Array<{ reason: string; timestamp: number }> = [];
const blockedResources = new Set<string>();
const permissionFailures = new Set<string>();
const layoutShiftEntries: PerformanceEntry[] = [];
const lcpEntries: PerformanceEntry[] = [];
const inpEntries: PerformanceEntry[] = [];
const longTasks: PerformanceEntry[] = [];
const collectionSessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

window.addEventListener('error', (event) => {
  const source = event.filename || '(inline)';
  consoleErrors.unshift({
    type: 'error',
    message: `${event.message} @ ${source}:${event.lineno ?? 0}`,
    timestamp: Date.now(),
  });
  if (event.target && event.target !== window) {
    const target = event.target as HTMLElement;
    if ((target as HTMLScriptElement).src) blockedResources.add((target as HTMLScriptElement).src);
    if ((target as HTMLLinkElement).href) blockedResources.add((target as HTMLLinkElement).href);
  }
  consoleErrors.splice(200);
}, true);

window.addEventListener('unhandledrejection', (event) => {
  unhandledRejections.unshift({ reason: String(event.reason), timestamp: Date.now() });
  unhandledRejections.splice(200);
});

const mutationObserver = new MutationObserver((records) => {
  for (const record of records) {
    mutationState.added += record.addedNodes.length;
    mutationState.removed += record.removedNodes.length;
  }
});
mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

if ('PerformanceObserver' in window) {
  try {
    new PerformanceObserver((list) => {
      layoutShiftEntries.push(...list.getEntries());
      layoutShiftEntries.splice(0, Math.max(0, layoutShiftEntries.length - 500));
    }).observe({ type: 'layout-shift', buffered: true } as PerformanceObserverInit);
  } catch {
    permissionFailures.add('layout-shift observer unavailable');
  }

  try {
    new PerformanceObserver((list) => {
      lcpEntries.push(...list.getEntries());
      lcpEntries.splice(0, Math.max(0, lcpEntries.length - 100));
    }).observe({ type: 'largest-contentful-paint', buffered: true } as PerformanceObserverInit);
  } catch {
    permissionFailures.add('largest-contentful-paint observer unavailable');
  }

  try {
    new PerformanceObserver((list) => {
      inpEntries.push(...list.getEntries());
      inpEntries.splice(0, Math.max(0, inpEntries.length - 100));
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  } catch {
    permissionFailures.add('interaction observer unavailable');
  }

  try {
    new PerformanceObserver((list) => {
      longTasks.push(...list.getEntries());
      longTasks.splice(0, Math.max(0, longTasks.length - 300));
    }).observe({ type: 'longtask', buffered: true } as PerformanceObserverInit);
  } catch {
    permissionFailures.add('longtask observer unavailable');
  }
}

function getNavigationId() {
  if (!window.__collectorNavId) {
    window.__collectorNavId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  return window.__collectorNavId;
}

function metricOrNull(value: number | undefined) {
  return Number.isFinite(value as number) ? (value as number) : null;
}

function collectPerformance() {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const paints = performance.getEntriesByType('paint');
  const fp = paints.find((entry) => entry.name === 'first-paint');
  const fcp = paints.find((entry) => entry.name === 'first-contentful-paint');
  const latestLcp = lcpEntries[lcpEntries.length - 1];
  const latestInp = inpEntries.sort((a, b) => b.duration - a.duration)[0];
  const cls = layoutShiftEntries
    .filter((entry) => !(entry as PerformanceEntry & { hadRecentInput?: boolean }).hadRecentInput)
    .reduce((sum, entry) => sum + ((entry as PerformanceEntry & { value?: number }).value ?? 0), 0);

  const longTaskTotalMs = longTasks.reduce((sum, entry) => sum + entry.duration, 0);

  const timing = performance.timing;
  const metricSet: PerformanceMetricSet = {
    navigationStart: nav ? performance.timeOrigin + nav.startTime : timing.navigationStart,
    navigationEnd: nav?.loadEventEnd ? performance.timeOrigin + nav.loadEventEnd : undefined,
    dnsMs: nav ? metricOrNull(nav.domainLookupEnd - nav.domainLookupStart) : null,
    tcpMs: nav ? metricOrNull(nav.connectEnd - nav.connectStart) : null,
    tlsMs: nav ? metricOrNull(nav.connectEnd - nav.secureConnectionStart) : null,
    ttfbMs: nav ? metricOrNull(nav.responseStart - nav.requestStart) : null,
    domInteractiveMs: nav ? metricOrNull(nav.domInteractive) : null,
    domContentLoadedMs: nav ? metricOrNull(nav.domContentLoadedEventEnd) : null,
    loadEventStartMs: nav ? metricOrNull(nav.loadEventStart) : null,
    loadEventEndMs: nav ? metricOrNull(nav.loadEventEnd) : null,
    firstPaintMs: metricOrNull(fp?.startTime),
    firstContentfulPaintMs: metricOrNull(fcp?.startTime),
    largestContentfulPaintMs: metricOrNull(latestLcp?.startTime),
    interactionToNextPaintMs: metricOrNull(latestInp?.duration),
    cumulativeLayoutShift: Number.isFinite(cls) ? cls : null,
    longTaskCount: longTasks.length,
    longTaskTotalMs,
    memoryUsedBytes: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
    memoryLimitBytes: (performance as Performance & { memory?: { jsHeapSizeLimit: number } }).memory?.jsHeapSizeLimit ?? null,
  };

  return metricSet;
}

function collectResources() {
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  return resources.slice(-800).map(
    (entry): ResourceMetric => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      startTime: entry.startTime,
      duration: entry.duration,
      transferSize: entry.transferSize,
      decodedBodySize: entry.decodedBodySize,
      protocol: entry.nextHopProtocol,
      renderBlockingStatus: (entry as PerformanceResourceTiming & { renderBlockingStatus?: string }).renderBlockingStatus,
    }),
  );
}

function collectDomInventory(): DomInventory {
  const allElements = Array.from(document.querySelectorAll('*'));
  const byTag: Record<string, number> = {};
  const inputsByType: Record<string, number> = {};
  let hiddenElements = 0;
  let ariaCount = 0;
  let shadowRoots = 0;

  for (const element of allElements) {
    const tag = element.tagName.toLowerCase();
    byTag[tag] = (byTag[tag] ?? 0) + 1;
    if (tag === 'input') {
      const inputType = (element as HTMLInputElement).type || 'text';
      inputsByType[inputType] = (inputsByType[inputType] ?? 0) + 1;
    }

    if (
      element.hasAttribute('hidden') ||
      getComputedStyle(element).display === 'none' ||
      getComputedStyle(element).visibility === 'hidden'
    ) {
      hiddenElements += 1;
    }

    if (element.shadowRoot) shadowRoots += 1;

    if (
      element.hasAttribute('aria-label') ||
      element.hasAttribute('aria-labelledby') ||
      element.hasAttribute('role')
    ) {
      ariaCount += 1;
    }
  }

  const comments = (() => {
    let count = 0;
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
    while (walker.nextNode()) count += 1;
    return count;
  })();

  return {
    totalElements: allElements.length,
    byTag,
    links: document.querySelectorAll('a[href]').length,
    buttons: document.querySelectorAll('button').length,
    forms: document.forms.length,
    inputsByType,
    hiddenElements,
    hiddenFields: document.querySelectorAll('input[type="hidden"]').length,
    iframes: Array.from(document.querySelectorAll('iframe')).map((iframe) => {
      const src = iframe.getAttribute('src') || '';
      const origin = src ? new URL(src, location.href).origin : '';
      return { src, origin, sandbox: iframe.getAttribute('sandbox') };
    }),
    scripts: Array.from(document.scripts).map((script) => ({
      src: script.src || null,
      type: script.type || null,
      inlineSize: script.src ? 0 : script.textContent?.length ?? 0,
    })),
    stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((link) =>
      link.getAttribute('href') || '',
    ),
    images: Array.from(document.images).map((img) => ({
      src: img.currentSrc || img.src,
      width: img.naturalWidth,
      height: img.naturalHeight,
      loading: img.loading || null,
    })),
    metaTags: Array.from(document.querySelectorAll('meta')).map((meta) => ({
      name: meta.getAttribute('name') || meta.getAttribute('property') || meta.getAttribute('http-equiv') || '',
      content: (meta.getAttribute('content') || '').slice(0, 400),
    })),
    comments,
    shadowRoots,
    ariaCount,
    mutationSummary: {
      addedNodes: mutationState.added,
      removedNodes: mutationState.removed,
    },
  };
}

async function collectStorageInventory(): Promise<StorageInventory> {
  const localStorageKeys = Object.keys(localStorage);
  const sessionStorageKeys = Object.keys(sessionStorage);
  const indexedDbDatabases =
    typeof indexedDB.databases === 'function'
      ? (await indexedDB.databases()).map((db) => ({
          name: db.name ?? null,
          version: db.version ?? null,
        }))
      : [];

  let cacheStorageKeys: string[] = [];
  try {
    cacheStorageKeys = await caches.keys();
  } catch {
    permissionFailures.add('cache storage is unavailable');
  }

  const serviceWorkers =
    'serviceWorker' in navigator
      ? (await navigator.serviceWorker.getRegistrations()).map((registration) => ({
          scope: registration.scope,
          scriptURL: registration.active?.scriptURL || registration.waiting?.scriptURL || registration.installing?.scriptURL || '',
        }))
      : [];

  const permissionNames = ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-write'] as const;
  const permissions: Record<string, string> = {};

  for (const name of permissionNames) {
    try {
      const permission = await navigator.permissions.query({ name: name as PermissionName });
      permissions[name] = permission.state;
    } catch {
      permissions[name] = 'unsupported';
    }
  }

  let usageEstimate: { usage: number; quota: number } | undefined;
  if (navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      if (typeof estimate.usage === 'number' && typeof estimate.quota === 'number') {
        usageEstimate = { usage: estimate.usage, quota: estimate.quota };
      }
    } catch {
      permissionFailures.add('storage estimate unavailable');
    }
  }

  return {
    cookies: [],
    localStorageKeys,
    sessionStorageKeys,
    indexedDbDatabases,
    cacheStorageKeys,
    serviceWorkers,
    permissions,
    usageEstimate,
  };
}

function collectSecurityObservation(resources: ResourceMetric[], scripts: Array<{ src: string | null; type: string | null; inlineSize: number }>): SecurityObservation {
  const isHttps = location.protocol === 'https:';
  const mixedContentResources = resources
    .map((resource) => resource.name)
    .filter((name) => isHttps && name.startsWith('http://'));

  const cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  const cspPresent = Boolean(cspMeta);
  const frameAncestorsPresent = Boolean(cspMeta?.getAttribute('content')?.includes('frame-ancestors'));

  const sourceMapUrls = scripts
    .filter((script) => !script.src && script.inlineSize > 0)
    .flatMap((script) => {
      const inline = document.querySelector(`script${script.type ? `[type='${script.type}']` : ''}`)?.textContent || '';
      const matches = inline.match(/sourceMappingURL=(.*)$/gm) || [];
      return matches.map((match) => match.replace('//# sourceMappingURL=', '').trim());
    });

  const thirdPartyScriptHosts = scripts
    .filter((script) => script.src)
    .map((script) => new URL(script.src as string, location.href).hostname)
    .filter((host) => host !== location.hostname)
    .filter((host, idx, arr) => arr.indexOf(host) === idx);

  const insecureForms = Array.from(document.forms)
    .map((form) => form.action || location.href)
    .filter((action) => action.startsWith('http://'));

  const findings: SecurityObservation['findings'] = [];

  if (!isHttps) {
    findings.push({
      id: 'http-transport',
      severity: 'high',
      confidence: 'high',
      title: 'Page delivered over HTTP',
      evidence: location.href,
      remediation: 'Serve pages over HTTPS and enforce HSTS.',
      status: 'candidate',
    });
  }

  if (mixedContentResources.length > 0) {
    findings.push({
      id: 'mixed-content',
      severity: 'high',
      confidence: 'high',
      title: 'Mixed content resources detected',
      evidence: mixedContentResources.slice(0, 5).join(', '),
      remediation: 'Load all subresources over HTTPS.',
      status: 'candidate',
    });
  }

  if (!cspPresent) {
    findings.push({
      id: 'missing-csp',
      severity: 'medium',
      confidence: 'medium',
      title: 'No Content Security Policy meta detected',
      evidence: 'No CSP meta tag in document head (header-level CSP may still exist).',
      remediation: 'Set a restrictive CSP header at server level.',
      status: 'candidate',
    });
  }

  if (insecureForms.length > 0) {
    findings.push({
      id: 'insecure-form-action',
      severity: 'medium',
      confidence: 'medium',
      title: 'Form posts to insecure HTTP endpoint',
      evidence: insecureForms.slice(0, 3).join(', '),
      remediation: 'Update form actions to HTTPS endpoints.',
      status: 'candidate',
    });
  }

  return {
    https: isHttps,
    mixedContentResources,
    cspPresent,
    frameAncestorsPresent,
    sourceMapUrls,
    thirdPartyScriptHosts,
    insecureForms,
    findings,
  };
}

function collectJsObservation(domScripts: Array<{ src: string | null; type: string | null; inlineSize: number }>): JsObservation {
  const frameworkDetectors: Array<[string, () => boolean]> = [
    ['React', () => Boolean((window as Window & { React?: unknown; __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).React || (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__)],
    ['Vue', () => Boolean((window as Window & { Vue?: unknown; __VUE_DEVTOOLS_GLOBAL_HOOK__?: unknown }).Vue || (window as Window & { __VUE_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__VUE_DEVTOOLS_GLOBAL_HOOK__)],
    ['Angular', () => Boolean((window as Window & { ng?: unknown }).ng)],
    ['Svelte', () => domScripts.some((script) => (script.src || '').includes('svelte'))],
    ['jQuery', () => Boolean((window as Window & { jQuery?: unknown; $?: unknown }).jQuery || (window as Window & { $?: unknown }).$)],
  ];

  const frameworkHints = frameworkDetectors
    .filter(([, detector]) => detector())
    .map(([name]) => name);

  const exposedConfigKeys = Object.keys(window)
    .filter((key) => /config|env|token|api|key/i.test(key))
    .slice(0, 100);

  return {
    frameworkHints,
    exposedConfigKeys,
    consoleErrors: [...consoleErrors],
    unhandledRejections: [...unhandledRejections],
  };
}

function getMetadata(navigationType: string, isSpaNavigation: boolean): PageMetadata {
  const url = new URL(location.href);
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
  const description = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
  const zoomApprox = Math.round((window.outerWidth / window.innerWidth) * 100) / 100;

  return {
    tabId: -1,
    frameId: 0,
    collectionSessionId,
    navId: getNavigationId(),
    timestamp: Date.now(),
    url: location.href,
    hostname: url.hostname,
    origin: url.origin,
    protocol: url.protocol,
    port: url.port,
    path: url.pathname,
    query: url.search,
    fragment: url.hash,
    title: document.title,
    description,
    canonicalUrl: canonical,
    language: document.documentElement.lang || '',
    charset: document.characterSet,
    referrer: document.referrer,
    navigationType,
    redirectCount: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.redirectCount,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    screen: { width: screen.width, height: screen.height },
    devicePixelRatio: window.devicePixelRatio,
    zoomApprox,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    online: navigator.onLine,
    blockedResources: Array.from(blockedResources),
    permissionFailures: Array.from(permissionFailures),
    isSpaNavigation,
  };
}

async function sendSnapshot(reason: string, isSpaNavigation = false) {
  if (!location.href.startsWith('http://') && !location.href.startsWith('https://')) return;

  const metrics = collectPerformance();
  const resources = collectResources();
  const dom = collectDomInventory();
  const storage = await collectStorageInventory();
  const security = collectSecurityObservation(resources, dom.scripts);
  const js = collectJsObservation(dom.scripts);

  const metadata = getMetadata(reason, isSpaNavigation);

  const cookieResult = await chrome.runtime.sendMessage({
    type: 'collector:fetchCookies',
    payload: { url: metadata.url },
  });

  storage.cookies = cookieResult?.cookies ?? [];

  await chrome.runtime.sendMessage({
    type: 'collector:snapshot',
    payload: {
      metadata,
      metrics,
      resources,
      dom,
      storage,
      security,
      js,
    },
  });
}

void sendSnapshot('initial-load', false);

window.addEventListener('load', () => {
  void sendSnapshot('window-load', false);
});

window.addEventListener('hashchange', () => {
  window.__collectorNavId = undefined;
  void sendSnapshot('hashchange', true);
});

window.addEventListener('popstate', () => {
  window.__collectorNavId = undefined;
  void sendSnapshot('popstate', true);
});

let pushStatePatched = false;
if (!pushStatePatched) {
  pushStatePatched = true;
  const originalPushState = history.pushState;
  history.pushState = function patchedPushState(...args) {
    const ret = originalPushState.apply(this, args);
    window.__collectorNavId = undefined;
    void sendSnapshot('pushState', true);
    return ret;
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function patchedReplaceState(...args) {
    const ret = originalReplaceState.apply(this, args);
    window.__collectorNavId = undefined;
    void sendSnapshot('replaceState', true);
    return ret;
  };
}

setInterval(() => {
  void sendSnapshot('periodic', false);
}, 15000);
