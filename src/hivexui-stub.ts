import type { Context } from 'hono';

/** The standalone web UI is retired; HiveXUI is the UI for the Hive:Magnus product line. */
export const PRODUCT = 'HiveSkills';

const STUB_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);

/** Validates HIVEXUI_URL; empty or unset means stub mode. Returns the normalized URL. */
export function parseHiveXuiUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('HIVEXUI_URL must be an absolute http(s) URL'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.hash) {
    throw new Error('HIVEXUI_URL must be an absolute http(s) URL');
  }
  return url.toString();
}

export function renderHiveXuiStub(product: string, url?: string): string {
  const sentence = url
    ? `<p><a href="${escapeHtml(url)}">Open HiveXUI</a> to manage ${product}.</p>`
    : `<p>Open HiveXUI to manage ${product}. Operators can set HIVEXUI_URL so this address redirects there.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${product} is managed in HiveXUI</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>
</head>
<body>
<main>
<h1>${product} is managed in HiveXUI</h1>
${sentence}
</main>
</body>
</html>
`;
}

/** Serves a retired UI path: 302 to HIVEXUI_URL when configured, otherwise the stub page. */
export function hiveXuiStubResponse(c: Context, url: string | undefined): Response {
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'no-store');
  c.header('Content-Security-Policy', STUB_CSP);
  c.header('X-Content-Type-Options', 'nosniff');
  if (url) {
    c.header('Location', url);
    return c.body(renderHiveXuiStub(PRODUCT, url), 302);
  }
  return c.body(renderHiveXuiStub(PRODUCT), 200);
}
