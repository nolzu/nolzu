import createDOMPurify from 'dompurify';
import { marked } from 'marked';

// What a card, a summary or a comment may contain. Anything not named here is removed, so a tag
// nobody thought about is refused rather than allowed by accident.
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'em', 'strong', 'del', 'code', 'pre', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'a', 'img',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

// No event handler is on this list, so onerror and its family go with everything else unnamed.
const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'align'];

type Purifier = ReturnType<typeof createDOMPurify>;

// An image loads the moment the page shows it, so one from any host tells that host when the person
// read a stranger's comment, and a path on this server would run its GET. Only the hosts where GitHub
// keeps uploaded images and repository files: not camo, GitHub's proxy that fetches any server, and
// not a release file on github.com, whose downloads its owner can count.
const IMAGE_HOSTS = new Set(['user-images.githubusercontent.com', 'private-user-images.githubusercontent.com', 'avatars.githubusercontent.com', 'raw.githubusercontent.com']);
// On github.com: an upload today, an upload in the older form under a repository, and a repository
// file. Never a release file.
const GITHUB_IMAGE = /^\/(?:user-attachments\/|[^/]+\/[^/]+\/(?:assets\/\d+\/[0-9a-f-]+$|raw\/))/i;
function imageAllowed(src: string): boolean {
  if (/^data:image\//i.test(src)) return true;
  try {
    const url = new URL(src);
    if (url.protocol !== 'https:') return false;
    return url.hostname === 'github.com' ? GITHUB_IMAGE.test(url.pathname) : IMAGE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

let purifier: Purifier | null = null;

// Built on first use and not at import time, because the server imports this module with no
// window at all. DOMPurify finds the window itself when given none.
function purify(): Purifier {
  if (purifier !== null) return purifier;

  const built = createDOMPurify();
  // With a DOM that is missing or only partly there, DOMPurify hands its input back unchanged
  // and says nothing. A loud failure is better than a page that looks cleaned and is not.
  if (!built.isSupported) throw new Error('sanitize() needs a DOM. Render markdown in the browser only.');

  built.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A') return;
    const href = node.getAttribute('href');
    // A link with a scheme leaves this page, and the page it opens can reach back through
    // window.opener without this. A relative link goes nowhere new, so it needs nothing.
    if (href !== null && /^[a-z][a-z0-9+.-]*:/i.test(href)) node.setAttribute('rel', 'noopener noreferrer');
  });
  purifier = built;
  return purifier;
}

// Markdown to HTML a browser may be handed. The cleaning happens after the rendering, because
// markdown carries raw HTML through untouched, so trusting the renderer alone would let a script
// tag straight onto the page.
// `headingsFrom` is the level a `#` heading becomes, for text shown under a heading the page already has.
export function sanitize(markdown: string, { headingsFrom = 1 }: { headingsFrom?: number } = {}): string {
  const rendered = marked.parse(markdown, { async: false, gfm: true, breaks: false });
  const clean = purify().sanitize(rendered, { ALLOWED_TAGS, ALLOWED_ATTR, RETURN_DOM_FRAGMENT: true });

  // Renamed as elements after the cleaning, so a raw <h1> moves as well as a `#`. A text rewrite
  // would also change `<h1` inside an attribute, which some browsers leave unescaped.
  const shift = headingsFrom - 1;
  for (const heading of clean.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const moved = heading.ownerDocument.createElement(`h${Math.min(6, Number(heading.tagName[1]) + shift)}`);
    for (const attribute of heading.attributes) moved.setAttribute(attribute.name, attribute.value);
    moved.append(...heading.childNodes);
    heading.replaceWith(moved);
  }
  // Any other image becomes its text, a link when it has an address of its own, so the person can
  // open it with a click.
  for (const image of clean.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? '';
    if (imageAllowed(src)) continue;
    const text = image.getAttribute('alt') || 'Image';
    // Inside a link, such as a CI badge, the text alone: a link in a link splits the outer one.
    if (/^https?:\/\//i.test(src) && image.closest('a') === null) {
      const link = image.ownerDocument.createElement('a');
      link.setAttribute('href', src);
      link.setAttribute('rel', 'noopener noreferrer');
      link.textContent = text;
      image.replaceWith(link);
    } else {
      image.replaceWith(image.ownerDocument.createTextNode(text));
    }
  }
  const box = clean.ownerDocument.createElement('div');
  box.append(clean);
  return box.innerHTML;
}
