export type ExecutionContext = 'page' | 'isolated' | 'background';

export interface PerformanceMetricSet {
  navigationStart?: number;
  navigationEnd?: number;
  dnsMs?: number | null;
  tcpMs?: number | null;
  tlsMs?: number | null;
  ttfbMs?: number | null;
  domInteractiveMs?: number | null;
  domContentLoadedMs?: number | null;
  loadEventStartMs?: number | null;
  loadEventEndMs?: number | null;
  firstPaintMs?: number | null;
  firstContentfulPaintMs?: number | null;
  largestContentfulPaintMs?: number | null;
  interactionToNextPaintMs?: number | null;
  cumulativeLayoutShift?: number | null;
  longTaskCount?: number;
  longTaskTotalMs?: number;
  memoryUsedBytes?: number | null;
  memoryLimitBytes?: number | null;
}

export interface ResourceMetric {
  name: string;
  initiatorType: string;
  startTime: number;
  duration: number;
  transferSize?: number;
  decodedBodySize?: number;
  protocol?: string;
  renderBlockingStatus?: string;
}

export interface DomInventory {
  totalElements: number;
  byTag: Record<string, number>;
  links: number;
  buttons: number;
  forms: number;
  inputsByType: Record<string, number>;
  hiddenElements: number;
  hiddenFields: number;
  iframes: Array<{ src: string; origin: string; sandbox: string | null }>;
  scripts: Array<{ src: string | null; type: string | null; inlineSize: number }>;
  stylesheets: string[];
  images: Array<{ src: string; width: number; height: number; loading: string | null }>;
  metaTags: Array<{ name: string; content: string }>;
  comments: number;
  shadowRoots: number;
  ariaCount: number;
  mutationSummary: {
    addedNodes: number;
    removedNodes: number;
  };
}

export interface StorageInventory {
  cookies: Array<{
    name: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite?: string;
    expires?: number;
    partitionKey?: string;
  }>;
  localStorageKeys: string[];
  sessionStorageKeys: string[];
  indexedDbDatabases: Array<{ name: string | null; version: number | null }>;
  cacheStorageKeys: string[];
  serviceWorkers: Array<{ scope: string; scriptURL: string }>;
  permissions: Record<string, string>;
  usageEstimate?: { usage: number; quota: number };
}

export interface SecurityObservation {
  https: boolean;
  mixedContentResources: string[];
  cspPresent: boolean;
  frameAncestorsPresent: boolean;
  sourceMapUrls: string[];
  thirdPartyScriptHosts: string[];
  insecureForms: string[];
  findings: Array<{
    id: string;
    severity: 'low' | 'medium' | 'high';
    confidence: 'low' | 'medium' | 'high';
    title: string;
    evidence: string;
    remediation: string;
    status: 'candidate' | 'confirmed' | 'false-positive';
  }>;
}

export interface JsObservation {
  frameworkHints: string[];
  exposedConfigKeys: string[];
  consoleErrors: Array<{ type: string; message: string; timestamp: number }>;
  unhandledRejections: Array<{ reason: string; timestamp: number }>;
}

export interface PageMetadata {
  tabId: number;
  frameId: number;
  windowId?: number;
  collectionSessionId: string;
  navId: string;
  timestamp: number;
  url: string;
  hostname: string;
  origin: string;
  protocol: string;
  port: string;
  path: string;
  query: string;
  fragment: string;
  title: string;
  description: string;
  canonicalUrl: string;
  language: string;
  charset: string;
  referrer: string;
  navigationType: string;
  redirectCount?: number;
  userAgent: string;
  platform: string;
  viewport: { width: number; height: number };
  screen: { width: number; height: number };
  devicePixelRatio: number;
  zoomApprox: number;
  visibilityState: string;
  hasFocus: boolean;
  online: boolean;
  blockedResources: string[];
  permissionFailures: string[];
  isSpaNavigation: boolean;
}

export interface NetworkEntry {
  requestId: string;
  tabId: number;
  frameId: number;
  navId?: string;
  method: string;
  url: string;
  statusCode?: number;
  type?: string;
  initiator?: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  fromCache?: boolean;
  error?: string;
  requestHeaders?: Array<{ name: string; value?: string }>;
  responseHeaders?: Array<{ name: string; value?: string }>;
}

export interface NavigationRecord {
  navId: string;
  tabId: number;
  frameId: number;
  windowId?: number;
  collectionSessionId: string;
  url: string;
  origin: string;
  startedAt: number;
  completedAt?: number;
  navigationType: string;
  isSpaNavigation: boolean;
  metrics?: PerformanceMetricSet;
  resources?: ResourceMetric[];
  metadata?: PageMetadata;
  dom?: DomInventory;
  storage?: StorageInventory;
  security?: SecurityObservation;
  js?: JsObservation;
  network: NetworkEntry[];
}

export interface WorkbenchRun {
  runId: string;
  timestamp: number;
  context: ExecutionContext;
  tabId?: number;
  frameId?: number;
  code: string;
  status: 'success' | 'error' | 'timeout' | 'cancelled';
  result?: string;
  error?: string;
  logs: Array<{ level: string; args: string[] }>;
}

export interface SavedSnippet {
  id: string;
  name: string;
  code: string;
  updatedAt: number;
}

export interface CollectorSettings {
  paused: boolean;
  excludedHosts: string[];
  retentionLimit: number;
  collectNetworkBodies: boolean;
  inspectStorageValues: boolean;
  activeTestingAllowlist: string[];
}

export interface CollectorState {
  settings: CollectorSettings;
  navigations: NavigationRecord[];
  workbenchHistory: WorkbenchRun[];
  snippets: SavedSnippet[];
  auditLog: Array<{ timestamp: number; action: string; details: string }>;
}
