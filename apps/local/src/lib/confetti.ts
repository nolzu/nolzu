// The confetti of the "<name> is ready" screen: each piece's shape, colour and path out of the middle
// of the window. The page's CSS does the motion, so this only picks the numbers. Seeded, so every look
// and every test sees the same burst.

export interface ConfettiPiece {
  // Width and height in pixels: a long strip, a short strip or a square.
  w: number;
  h: number;
  colour: string;
  // Sideways travel, the height of the throw and the drop after it, in viewport units from the start.
  dx: number;
  up: number;
  fall: number;
  // A little more sideways drift while it falls, in viewport width.
  sway: number;
  // The turn in the plane and the flips through it that make it flutter, in degrees.
  spin: number;
  flip: number;
  delay: number;
}

const SHAPES = [
  { w: 4, h: 12 },
  { w: 3, h: 8 },
  { w: 7, h: 7 },
] as const;
const COLOURS = ['--green', '--blue', '--violet', '--accent'] as const;

// A small linear congruential generator: enough spread for confetti, the same numbers every time.
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

export function confettiPieces(count = 120, seed = 7): ConfettiPiece[] {
  const random = seeded(seed);
  const between = (low: number, high: number) => low + (high - low) * random();
  return Array.from({ length: count }, (_, at) => {
    // Up and out: anywhere from up and to the left to up and to the right, never down.
    const angle = (between(-155, -25) * Math.PI) / 180;
    const speed = between(0.45, 1);
    const shape = SHAPES[at % SHAPES.length] ?? SHAPES[0];
    return {
      ...shape,
      colour: COLOURS[at % COLOURS.length] ?? COLOURS[0],
      dx: Math.round(Math.cos(angle) * speed * 42 * 10) / 10,
      up: Math.round(-Math.sin(angle) * speed * 38 * 10) / 10,
      fall: Math.round(between(70, 110)),
      sway: Math.round(between(-6, 6) * 10) / 10,
      spin: Math.round(between(-900, 900)),
      flip: Math.round(between(540, 1440)),
      delay: Math.round(between(0, 160)),
    };
  });
}
