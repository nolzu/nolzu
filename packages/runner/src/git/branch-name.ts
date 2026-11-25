// Git accepts far more than this in a ref name, unicode included. A branch name is typed, pasted
// into a URL and passed to a shell, so the slug stays ASCII, and a key that survives none of that
// keeps a short hash instead, because the key is the only thing that keeps two cards apart.
import { BRANCH_TYPES } from '@nolzu/protocol';

export const BRANCH_NAME_MAX = 60;

const PLACEHOLDERS = ['key', 'slug', 'type', 'desc'];

// What Refine wrote under the card's title: the kind of work and a few words that name it.
export interface BranchParts {
  type?: string | null;
  desc?: string | null;
}

// A {desc} with no Branch line from Refine. Four words read as a name; the whole title reads as a sentence.
const DESC_WORDS = 4;

// NFKD splits an accented letter into the plain one and a mark. Dropping the marks keeps the
// letter, so a title or a key with accents still reads as words and not as holes.
const fold = (text: string): string => text.normalize('NFKD').replace(/\p{M}+/gu, '');

// Deterministic and short. Two keys that clean to the same text keep different names through it.
function shortHash(text: string): string {
  let hash = 2166136261;
  for (const character of text) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function slugify(title: string): string {
  return fold(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The case stays, because a person recognises the key. When cleaning changed anything, a hash of
// the original goes on the end: without it APP.1 and APP-1, or ÉTEL-1 and TEL-1, become one branch.
function keyPart(key: string): string {
  const kept = fold(key)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    // The same collapse the whole name gets later. Without it here, APP--1 looked untouched and
    // then quietly became APP-1, which is a different card.
    .replace(/-{2,}/g, '-')
    // The same edges the finished name has trimmed. Trimming only the hyphen here left a key like
    // _1 looking untouched, so it took no hash and became the same branch as the key 1.
    .replace(/^[-_]+|[-_]+$/g, '');
  if (kept === key && kept !== '') return kept;
  return `${kept === '' ? 'card' : kept}-${shortHash(key)}`;
}

// Only the characters a ref name may hold, and the slash that separates its parts.
const cleanCharacters = (name: string): string => name.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/-{2,}/g, '-');

// Git's own rules, checked per part: no part starts with a dot, ends in .lock, or is empty.
function cleanParts(name: string): string {
  return name
    .split('/')
    .map((part) => {
      // Repeated until nothing changes: a part ending in ".lock." needs the dot trimmed before
      // the .lock shows up, and trimming can expose another one.
      let cleaned = part;
      for (let pass = 0; pass < 10; pass += 1) {
        const before = cleaned;
        cleaned = cleaned
          .replace(/\.{2,}/g, '.')
          .replace(/\.lock$/i, '')
          .replace(/^[-._]+|[-._]+$/g, '');
        if (cleaned === before) break;
      }
      return cleaned;
    })
    .filter((part) => part !== '')
    .join('/');
}

const tidy = (name: string): string => cleanParts(cleanCharacters(name));

// The rules git enforces, so nothing leaves here that git would refuse to create.
function usable(name: string): boolean {
  if (name === '' || name === 'HEAD' || name === '@') return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (/[\s~^:?*[\\]/.test(name)) return false;
  if (/^[-./]|[-./]$/.test(name)) return false;
  return name.split('/').every((part) => part !== '' && !part.startsWith('.') && !/\.lock$/i.test(part));
}

/**
 * Why a branch name a person typed cannot be the card's, or null when it can. The same characters a
 * generated name keeps, git's own ref rules, the cap, and the card key, which keeps two cards apart.
 */
export function branchNameProblem(name: string, key: string): string | null {
  const identity = keyPart(key);
  if (name.trim() === '') return 'Type a branch name.';
  if (/[^A-Za-z0-9._/-]/.test(name)) return 'A branch name takes letters, digits, dots, hyphens, underscores and slashes only.';
  if (!usable(name)) return `Git refuses ${name} as a branch name. No part may start with a dot or end in .lock, and the name may not start or end with a hyphen, dot or slash.`;
  // A key longer than the cap is kept whole by branchName too, so it may take a name over the cap.
  const max = Math.max(BRANCH_NAME_MAX, identity.length);
  if (name.length > max) return `The name is ${name.length} characters, and ${max} is the limit.`;
  // Whole, so APP-12-search does not pass for APP-1. keyPart leaves no character a pattern reads.
  if (!new RegExp(`(^|[^A-Za-z0-9])${identity}($|[^A-Za-z0-9])`).test(name)) return `The name must carry the card key ${identity}.`;
  return null;
}

function cutOnWord(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  // The cap landing exactly on a separator means the word before it fitted whole, so keep it.
  if (text[max] === '-') return cut.replace(/-+$/, '');
  const boundary = cut.lastIndexOf('-');
  // No boundary means one very long word. Half a word still beats a name nobody can read.
  return (boundary > 0 ? cut.slice(0, boundary) : cut).replace(/-+$/, '');
}

// Cuts `overflow` characters off a slug, on a word when it can.
function shorten(slug: string, overflow: number): string {
  const shorter = cutOnWord(slug, slug.length - overflow);
  return shorter === slug ? slug.slice(0, -1).replace(/-+$/, '') : shorter;
}

export function branchName(template: string, key: string, title: string, parts: BranchParts = {}): string {
  const named = [...template.matchAll(/\{([^}]*)\}/g)].map((match) => match[1] ?? '');
  const unknown = named.filter((name) => !PLACEHOLDERS.includes(name));
  if (unknown.length > 0) {
    const allowed = `${PLACEHOLDERS.slice(0, -1).map((name) => `{${name}}`).join(', ')} and {${PLACEHOLDERS.at(-1)}}`;
    throw new Error(`The branch template names ${unknown.map((name) => `{${name}}`).join(', ')}, which is not a placeholder. It takes ${allowed}.`);
  }
  if (!template.includes('{key}')) {
    throw new Error('The branch template must carry {key}, so the branch name carries the card key.');
  }

  const identity = keyPart(key);
  // The slug gives way to the cap and the key never does. Cutting the key would put two cards on
  // one branch, which is the one thing the key is there to prevent. A key longer than the cap on
  // its own is kept whole and the name goes over.
  //
  // Measured on the finished name rather than counted in advance: the template can hold text
  // after the slug, and it can hold the slug more than once, and a budget worked out up front is
  // wrong in both cases.
  // Three things can still take a name over the cap, and none can be shortened here: a key longer
  // than the cap on its own, a key carrying a hash, and a template whose own text is that long or
  // that holds neither {slug} nor {desc}.
  // {desc} gives way to the cap the same way {slug} does.
  const count = (placeholder: RegExp): number => (template.match(placeholder) ?? []).length;
  const copies = Math.max(1, count(/\{slug\}/g) + count(/\{desc\}/g));
  const type = BRANCH_TYPES.find((one) => one === parts.type) ?? 'feature';
  let slug = slugify(title);
  let desc = slugify(parts.desc ?? '') || slug.split('-').slice(0, DESC_WORDS).join('-');
  const fill = (): string =>
    tidy(template.replaceAll('{key}', identity).replaceAll('{slug}', slug).replaceAll('{type}', type).replaceAll('{desc}', desc));
  let name = fill();
  for (let pass = 0; pass < 12 && name.length > BRANCH_NAME_MAX && (slug !== '' || desc !== ''); pass += 1) {
    // Every character cut from the slug shortens the name once per copy of the placeholder, so
    // taking the whole overflow off one copy overshoots and throws away room that was there.
    const overflow = Math.ceil((name.length - BRANCH_NAME_MAX) / copies);
    if (template.includes('{slug}')) slug = shorten(slug, overflow);
    if (template.includes('{desc}')) desc = shorten(desc, overflow);
    const next = fill();
    // A template with no {slug} or {desc} cannot get shorter, so there is nothing to gain from trying again.
    if (next === name) break;
    name = next;
  }

  if (usable(name)) return name;
  // The template, or the key on its own, produced something git refuses. The hash keeps the name
  // both usable and unique to this card.
  const fallback = tidy(`${identity}-${shortHash(key)}`);
  return usable(fallback) ? fallback : `card-${shortHash(key)}`;
}
