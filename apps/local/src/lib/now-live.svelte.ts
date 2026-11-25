import type { BoardState } from './snapshot-client.ts';
import type { NowSnapshot } from './now.ts';

// What the one Now stream last said. The root layout opens the stream once and writes here, the rail
// reads its count and slots, and the Now page reads the rest, so the rail's count and the page's count
// are always one number and the rail is live on every page.
class NowLive {
  state = $state.raw<BoardState<NowSnapshot>>({ snapshot: null, reconnecting: false, activity: {}, limits: {} });
}

export const nowLive = new NowLive();
