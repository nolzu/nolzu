// The Files tab: the card folder, one group per subfolder. `share/` holds what is meant for other
// people, and the rest is the card's own working notes.
// `download` is a file the viewer cannot show: a kind it has no view for, or text over its cap.
// `html` is drawn in a sandboxed frame, with its source a switch away.
export type CardFileKind = 'markdown' | 'text' | 'html' | 'image' | 'download';

export interface CardFile {
  path: string;
  name: string;
  size: number;
  kind: CardFileKind;
  // The phase whose run wrote it, read off the card folder layout. Null for a file a person put there.
  phase: string | null;
  // When it last changed, in milliseconds since the epoch.
  modified: number;
  // That time in words, which the server writes in its own time zone. Absent where nobody wrote it.
  when?: string | null;
  // True for a `download` that the viewer would show if it were smaller, so the viewer says it is too
  // big rather than a kind it cannot show. Absent otherwise.
  tooBig?: true;
}

// A cache folder in the card folder, such as `node_modules` or an npm cache a run left there. Nobody
// reads it, so it is counted and not listed, and its files are not in `files`.
export interface CardCacheFolder {
  path: string;
  count: number;
}

export interface CardFileGroup {
  folder: string;
  share: boolean;
  files: CardFile[];
  // The cache folders under this group, a top level one under the card folder group. Absent when none.
  caches?: CardCacheFolder[];
}
