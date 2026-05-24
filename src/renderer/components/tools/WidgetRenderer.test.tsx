// jsdom + RTL regression test for the generative-UI widget sandbox transport.
//
// Red line (desktop-only widget-blank bug): the widget iframe is served via
// `srcDoc` (document URL `about:srcdoc`), which the Rust on_navigation guard
// (src-tauri/src/lib.rs) explicitly allows. It must NOT switch to a `blob:` /
// `data:` `src` — those schemes are blocked by that guard (they're top-frame
// attack vectors) so the iframe would load an empty document and render blank
// in the macOS WKWebView. If the transport changes, the nav guard's allow-list
// (and its cargo test) must change in lockstep.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import WidgetRenderer from './WidgetRenderer';

afterEach(() => cleanup());

const CODE = '<style>.x{color:red}</style><div class="x">hi</div>';

describe('WidgetRenderer iframe transport', () => {
  it('serves the sandbox via srcDoc (about:srcdoc), not a blocked blob:/data: src', () => {
    const { container } = render(
      <WidgetRenderer widgetCode={CODE} isStreaming={false} title="t" />,
    );
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    // srcdoc carries the sandbox receiver document …
    const srcdoc = iframe!.getAttribute('srcdoc') || '';
    expect(srcdoc).toContain('widget:ready');
    expect(srcdoc).toContain('id="root"');
    // … and the iframe must NOT use a src= URL (blob:/data: are nav-guard-blocked).
    expect(iframe!.getAttribute('src')).toBeNull();
    // sandbox stays scripts-only (opaque origin, postMessage-only).
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts');
  });
});
