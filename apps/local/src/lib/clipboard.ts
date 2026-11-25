// The browser's own clipboard, and the answer to whether it took the text. The two boxes that copy
// read this instead of calling the browser twice, and each writes its own sentence, because what to
// do instead differs: a standup is a box a person can select, a review block is one of six.
//
// A refusal is normal, not an error: a browser with no permission, an insecure origin and a headless
// test all land here, and a copy that failed silently would leave a person pasting the wrong thing.
export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};
