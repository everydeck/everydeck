/**
 * load times of every page view (Core Web Vitals), measured in the browser with Google's `web-vitals` code (6.2.3, Apache-2.0, vendored under
 * `vendor/web-vitals`, see THIRD-PARTY-NOTICES.md), the same measurement as Vercel Speed Insights, PostHog and Sentry. One event per page view
 * (`everydeck.web.vitals`) with LCP, INP, CLS, FCP and TTFB as far as the browser reported them, and the page only as its pattern (`screens`).
 * No person, no address, no identifiers. everydeck never counts it towards the month and keeps only daily values per page.
 *
 * Sent once when the page is hidden (or left), together with whatever else is pending, so a page view costs at most one extra batch: CLS and INP are
 * final only then, and the browser key has a small batch budget. A navigation is sent once per metric; a later value of a metric already sent (a second
 * hide) is dropped, a metric reported for the first time later is sent on its own (each metric counts once per page view).
 * With soft navigations (Chromium 151+, `reportSoftNavs`) every route change of a single-page app is a page view of its own; other browsers measure the
 * page that was loaded (like Chrome's CrUX).
 */
import { onCLS, onFCP, onINP, onLCP, onTTFB } from './vendor/web-vitals/index.js';

/** Same name as WEB_VITALS_EVENT in the contracts of everydeck (the SDK has no dependencies; a test checks they are equal) */
export const WEB_VITALS_EVENT = 'everydeck.web.vitals';
export const WEB_VITALS_OPERATION = 'everydeck.web:vitals';
export type VitalName = 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB';
/** The part of a web-vitals metric everydeck reads */
export interface VitalMetric { name: VitalName; value: number; navigationId?: number; navigationURL?: string; id?: string }
type On = (cb: (m: VitalMetric) => void, opts?: { reportSoftNavs?: boolean }) => void;
export interface VitalsSource { onLCP: On; onINP: On; onCLS: On; onFCP: On; onTTFB: On }
/** The measuring functions (web-vitals); tests replace them */
export const vitalsSource: VitalsSource = { onLCP: onLCP as unknown as On, onINP: onINP as unknown as On, onCLS: onCLS as unknown as On, onFCP: onFCP as unknown as On, onTTFB: onTTFB as unknown as On };

/** Field of each metric; milliseconds rounded up (a value just over a limit stays over it), CLS up to 4 decimals, the same way */
const FIELD: Record<VitalName, 'lcp' | 'inp' | 'cls' | 'fcp' | 'ttfb'> = { LCP: 'lcp', INP: 'inp', CLS: 'cls', FCP: 'fcp', TTFB: 'ttfb' };
export const VITAL_MS_MAX = 600_000;
export const VITAL_CLS_MAX = 100;
export function vitalValue(name: VitalName, v: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return name === 'CLS' ? Math.min(VITAL_CLS_MAX, Math.ceil(v * 10_000) / 10_000) : Math.min(VITAL_MS_MAX, Math.ceil(v));
}

const MAX_NAVIGATIONS = 50;
const MAX_EVENTS = 200;

/** Collects the metrics of each navigation of this page life until `drain` (page hidden) */
export class VitalsCollector {
  private readonly open = new Map<string, { screen: string; fields: Record<string, number> }>();
  /** metrics already sent per navigation */
  private readonly sent = new Map<string, Set<string>>();
  private events = 0;
  /** navigations not measured (over the limit), each counted once */
  private readonly skipped = new Set<string>();
  /** `lost`: measurements dropped at a limit of the page life (reported to everydeck as a gap) */
  constructor(private readonly screenOf: (url: string | undefined) => string, private readonly emit: (fields: Record<string, string | number>) => void,
    private readonly lost: (limit: 'sdk_vitals_navigations' | 'sdk_vitals_events', n: number) => void = () => {}) {}
  report = (m: VitalMetric): void => {
    try {
      const f = FIELD[m?.name]; if (!f) return;
      const v = vitalValue(m.name, m.value); if (v === null) return;
      const key = String(m.navigationId ?? 'page');
      if (this.sent.get(key)?.has(f)) return;
      let nav = this.open.get(key);
      if (!nav) { if (this.open.size >= MAX_NAVIGATIONS) { if (!this.sent.has(key) && !this.skipped.has(key)) { this.skipped.add(key); this.lost('sdk_vitals_navigations', 1); } return; } const screen = this.screenOf(m.navigationURL); if (!screen) return; nav = { screen, fields: {} }; this.open.set(key, nav); }
      nav.fields[f] = v;
    } catch { /* never disturb the page */ }
  };
  /** Hands every collected navigation over as one event each (called when the page is hidden, before sending) */
  drain(): void {
    let over = 0;
    for (const [key, nav] of this.open) {
      if (this.events >= MAX_EVENTS) { if (Object.keys(nav.fields).length) over++; continue; }
      if (!Object.keys(nav.fields).length) continue;
      const done = this.sent.get(key) ?? new Set<string>(); for (const k of Object.keys(nav.fields)) done.add(k);
      if (this.sent.size >= MAX_NAVIGATIONS * 2 && !this.sent.has(key)) this.sent.delete(this.sent.keys().next().value!);
      this.sent.set(key, done);
      this.events++;
      this.emit({ screen: nav.screen, ...nav.fields });
    }
    if (over) this.lost('sdk_vitals_events', over);
    this.open.clear();
  }
}

/** Starts the measurement (web-vitals registers its observers; nothing is measured before the browser reports) */
export function watchVitals(c: VitalsCollector, src: VitalsSource = vitalsSource): void {
  for (const on of [src.onTTFB, src.onFCP, src.onLCP, src.onCLS, src.onINP]) {
    try { on(c.report, { reportSoftNavs: true }); } catch { /* an old browser without PerformanceObserver types: no measurement */ }
  }
}
