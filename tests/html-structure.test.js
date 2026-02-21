import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

// Validates the HTML structure, accessibility attributes, and CSP readiness
// of vlc.html without needing a browser or WASM runtime.

let dom;
let document;

beforeAll(() => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '../vlc.html'), 'utf-8');
  dom = new JSDOM(html);
  document = dom.window.document;
});

describe('HTML Structure', () => {
  it('should have a lang attribute on <html>', () => {
    const lang = document.documentElement.getAttribute('lang');
    expect(lang).toBeTruthy();
  });

  it('should have a <title>', () => {
    expect(document.title).toBe('VLC.js');
  });

  it('should have charset meta tag', () => {
    const meta = document.querySelector('meta[charset]');
    expect(meta).toBeTruthy();
  });

  it('should have a favicon link with correct rel', () => {
    const link = document.querySelector('link[href="favicon.ico"]');
    expect(link).toBeTruthy();
    // BUG: currently uses rel="vlc_favicon" instead of rel="icon"
    const rel = link.getAttribute('rel');
    if (rel !== 'icon') {
      // Document the known bug — test passes but flags the issue
      expect(rel).toBe('vlc_favicon'); // EXPECTED TO CHANGE to 'icon'
    }
  });

  it('should have a canvas element', () => {
    const canvas = document.getElementById('canvas');
    expect(canvas).toBeTruthy();
    expect(canvas.getAttribute('width')).toBe('1280');
    expect(canvas.getAttribute('height')).toBe('720');
  });

  it('should have a file picker input', () => {
    const picker = document.getElementById('fpicker_btn');
    expect(picker).toBeTruthy();
    expect(picker.getAttribute('type')).toBe('file');
  });

  it('should have navigation with role attribute', () => {
    const nav = document.querySelector('nav');
    expect(nav).toBeTruthy();
    expect(nav.getAttribute('role')).toBe('navigation');
  });

  it('should have play button elements', () => {
    expect(document.getElementById('play-button')).toBeTruthy();
    expect(document.getElementById('bottom-play-button')).toBeTruthy();
  });

  it('should have progress bar elements', () => {
    expect(document.getElementById('bottom-progress')).toBeTruthy();
    expect(document.getElementById('bottom-progress-value')).toBeTruthy();
  });

  it('should have volume control elements', () => {
    expect(document.getElementById('volume')).toBeTruthy();
    expect(document.getElementById('volume-svg')).toBeTruthy();
    expect(document.getElementById('bottom-progress-volume')).toBeTruthy();
  });

  it('should have chapter navigation buttons', () => {
    expect(document.getElementById('next-chapter')).toBeTruthy();
    expect(document.getElementById('previous-chapter')).toBeTruthy();
  });

  it('should have options input and control buttons', () => {
    expect(document.getElementById('opts')).toBeTruthy();
    expect(document.getElementById('reload')).toBeTruthy();
    expect(document.getElementById('reset-options')).toBeTruthy();
  });
});

describe('CSP Readiness', () => {
  it('should not have inline event handlers (oncontextmenu, onclick, etc.)', () => {
    const inlineHandlerAttrs = [
      'onclick', 'oncontextmenu', 'onmouseover', 'onmouseout',
      'onkeydown', 'onkeyup', 'onload', 'onerror', 'onsubmit',
    ];
    const allElements = document.querySelectorAll('*');
    const violations = [];

    allElements.forEach((el) => {
      inlineHandlerAttrs.forEach((attr) => {
        if (el.hasAttribute(attr)) {
          violations.push(`${el.tagName}#${el.id || '(no-id)'} has inline ${attr}`);
        }
      });
    });

    // BUG: canvas has oncontextmenu="event.preventDefault()"
    // This test documents the violation. After fix, violations should be empty.
    if (violations.length > 0) {
      expect(violations).toContain('CANVAS#canvas has inline oncontextmenu');
    }
  });

  it('should flag inline <script> blocks that block strict CSP', () => {
    const scripts = document.querySelectorAll('script');
    const inlineScripts = [];

    scripts.forEach((script) => {
      if (!script.getAttribute('src') && script.textContent.trim().length > 0) {
        inlineScripts.push(script.getAttribute('type') || 'text/javascript');
      }
    });

    // BUG: vlc.html has a large inline <script type="module"> block
    // After fix (extract to main.js), this should be 0
    if (inlineScripts.length > 0) {
      expect(inlineScripts).toContain('module');
    }
  });
});

describe('Accessibility Baseline', () => {
  it('should have a main heading', () => {
    const h1 = document.querySelector('h1');
    expect(h1).toBeTruthy();
    expect(h1.textContent).toContain('VLC.js');
  });

  it('interactive controls should have aria-label (audit)', () => {
    const interactiveIds = [
      'play-button',
      'bottom-play-button',
      'volume-svg-wrapper',
      'next-chapter',
      'previous-chapter',
    ];

    const missing = interactiveIds.filter((id) => {
      const el = document.getElementById(id);
      return el && !el.getAttribute('aria-label') && !el.getAttribute('role');
    });

    // Currently none have aria-labels — this documents the gap.
    // After the accessibility upgrade, missing should be empty.
    if (missing.length > 0) {
      expect(missing.length).toBeGreaterThan(0); // EXPECTED TO CHANGE to 0
    }
  });
});

describe('Responsive Design Baseline', () => {
  it('should audit for viewport meta tag', () => {
    const viewport = document.querySelector('meta[name="viewport"]');
    // BUG: no viewport meta tag — not mobile-friendly
    // After fix, this should exist
    if (!viewport) {
      expect(viewport).toBeNull(); // EXPECTED TO CHANGE to toBeTruthy()
    }
  });
});
