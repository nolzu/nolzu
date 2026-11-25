// Limit: within this many pixels of the end counts as at the end, so a person who scrolled to the
// last line but not past its margin is still followed. A fixed figure, not a share of the window.
export const FOLLOW_SLACK = 80;

/**
 * Whether the page is at, or near, its end. The Discussion tab follows a new message only then: a
 * person who scrolled up to read is not pulled down.
 */
export const nearBottom = (scrollTop: number, viewHeight: number, scrollHeight: number, slack = FOLLOW_SLACK): boolean =>
  scrollHeight - (scrollTop + viewHeight) <= slack;
