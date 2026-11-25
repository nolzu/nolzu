// @vitest-environment jsdom
// DOMPurify needs a DOM, and this file is where one is set up for it. Every other project
// runs without it, which is why the environment is set per file and not in the shared config.
// The DOM is jsdom and not happy-dom, because DOMPurify reads a tag name through the
// Node.prototype getter, which happy-dom answers with an empty string, and happy-dom's node
// iterator ends its walk at the first node DOMPurify removes. Under happy-dom nothing after the
// first element was cleaned, and the input came back with its script tag in place.
import { expect, it } from 'vitest';
import { sanitize } from './markdown.ts';

const html = (markdown: string) => sanitize(markdown);

it('drops a script tag, and the text inside it', () => {
  const body = html('Hello\n\n<script>alert("x")</script>');

  expect(body).not.toContain('<script');
  // The text of a script is code, not content, so keeping it would put the payload on the page.
  expect(body).not.toContain('alert');
});

it('keeps a GitHub image and drops the handler on it', () => {
  const body = html('<img src="https://github.com/user-attachments/assets/1.png" onerror="alert(1)">');

  expect(body).toContain('<img');
  expect(body).not.toContain('onerror');
});

// A stranger's comment with an image from their own server learns when the person read it, and a path
// on Nolzu's own server would run its GET the moment the page shows it.
it('turns an image from any other host, or a path on this server, into text', () => {
  expect(html('![chart](https://tracker.example/pixel.png)').trim()).toBe('<p><a href="https://tracker.example/pixel.png" rel="noopener noreferrer">chart</a></p>');
  expect(html('![](/t/APP-1/overview/__data.json)').trim()).toBe('<p>Image</p>');
  expect(html('![shot](http://127.0.0.1:5000/x.png)')).not.toContain('<img');
  // GitHub's image proxy fetches any server, and a release file's downloads are counted.
  expect(html('![](https://camo.githubusercontent.com/abc/def)')).not.toContain('<img');
  expect(html('![](https://github.com/me/repo/releases/download/v1/x.png)')).not.toContain('<img');
  expect(html('![](https://user-images.githubusercontent.com/1/x.png)')).toContain('<img');
  // The older upload form under a repository, and a repository's own picture. A release file stays a link.
  expect(html('![](https://github.com/me/recipes/assets/12345/0a1b2c3d-4e5f-6789-abcd-ef0123456789)')).toContain('<img');
  expect(html('![](https://github.com/me/recipes/raw/main/docs/screen.png)')).toContain('<img');
  expect(html('![](https://github.com/me/recipes/releases/download/v1/x.png)')).not.toContain('<img');
  expect(html('![](https://github.com/me/recipes/assets/12345/x.png/../../releases)')).not.toContain('<img');
  expect(html('![](https://github.com/me/recipes/blob/main/docs/screen.png)')).not.toContain('<img');
});

// A CI badge is an image inside a link. Its text stays inside the one link, which keeps its target.
it('keeps a linked badge as the link with the badge text', () => {
  expect(html('[![CI](https://badge.example/ci.svg)](https://ci.example/build)').trim()).toBe('<p><a href="https://ci.example/build" rel="noopener noreferrer">CI</a></p>');
});

it('drops a javascript link and keeps what it said', () => {
  const body = html('[click me](javascript:alert(1))');

  expect(body).not.toContain('javascript:');
  expect(body).toContain('click me');
});

it('drops a data link and keeps what it said', () => {
  const body = html('[open](data:text/html;base64,PHNjcmlwdD4=)');

  expect(body).not.toContain('data:text/html');
  expect(body).toContain('open');
});

it('removes an iframe and an object', () => {
  const body = html('<iframe src="https://example.invalid"></iframe><object data="x"></object>');

  expect(body).not.toContain('<iframe');
  expect(body).not.toContain('<object');
});

it('shows the characters of a fenced code block, and makes nothing bold', () => {
  const body = html('```\n**not bold** <b>tag</b>\n```');

  // A code block that loses its pre becomes prose, and a diff or a command read as prose is
  // wrong even when every character is still there.
  expect(body).toMatch(/<pre><code[^>]*>/);
  expect(body).toContain('**not bold**');
  expect(body).not.toContain('<strong>');
  expect(body).not.toContain('<b>tag</b>');
});

it('keeps a heading and a relative link', () => {
  const body = html('# Title\n\n[docs](./docs/readme.md)');

  expect(body).toContain('<h1');
  expect(body).toContain('Title');
  expect(body).toContain('./docs/readme.md');
});

it('sends an external link away safely', () => {
  const body = html('[site](https://example.invalid/page)');

  // Without the rel, the opened page can reach back through window.opener.
  expect(body).toContain('rel="noopener noreferrer"');
  expect(body).toContain('https://example.invalid/page');
});

it('reads an empty document as nothing at all', () => {
  expect(html('').trim()).toBe('');
});

it('moves every heading down when the page already has the levels above', () => {
  const body = sanitize('# Top\n\n## Next\n\n<h2 title="kept">Raw</h2>', { headingsFrom: 3 });

  // Markdown headings and raw ones both move, so neither can put an h1 under the page's h2.
  expect(body).toMatch(/<h3[^>]*>Top<\/h3>/);
  expect(body).toMatch(/<h4[^>]*>Next<\/h4>/);
  expect(body).toContain('<h4 title="kept">Raw</h4>');
  expect(body).not.toMatch(/<h[12][\s>]/);
});

it('stops a moved heading at h6, the lowest level there is', () => {
  expect(sanitize('##### Five\n\n###### Six', { headingsFrom: 3 })).not.toMatch(/<h[78]/);
  expect(sanitize('##### Five', { headingsFrom: 3 })).toMatch(/<h6[^>]*>Five<\/h6>/);
});

it('leaves a heading written as text in a code block alone', () => {
  const body = sanitize('```\n<h1>code</h1>\n```', { headingsFrom: 3 });

  expect(body).toContain('&lt;h1&gt;code&lt;/h1&gt;');
});

it('moves heading tags only, and never text inside an attribute', () => {
  const body = sanitize('<a href="/x?q=<h1>" title="<h2">l</a> ![<h1>x](a.png)', { headingsFrom: 3 });

  // A browser that leaves < unescaped in an attribute would hand a text rewrite a link it then changes.
  expect(body).not.toMatch(/h[34]/);
  expect(body).toContain('<a');
});

// A long expression in inline code stays in the sentence it belongs to. The break inside it is
// the stylesheet's job, which `components.test.ts` reads off the component.
it('keeps inline code inside one paragraph', () => {
  const body = html('Call `invalidateTenants(cache.byRegion(region).entries())` before the handshake.');

  expect(body.match(/<p>/g)).toHaveLength(1);
  expect(body).toMatch(/<p>Call <code>invalidateTenants[^<]*<\/code> before the handshake\.<\/p>/);
});
