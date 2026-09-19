import { useMemo } from "react";

interface Props {
  /** 0 = bare dying earth, 1 = thriving. */
  health: number;
}

/** Small deterministic generator, so the field does not reshuffle on every render. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

type Rgb = [number, number, number];

function mix(from: Rgb, to: Rgb, amount: number): string {
  const t = Math.min(1, Math.max(0, amount));
  const channel = (i: number) => Math.round(from[i]! + (to[i]! - from[i]!) * t);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

const WIDTH = 800;
const HEIGHT = 380;
const HORIZON = 168;
const BLADES = 620;
/**
 * Blades are grouped into four depth layers, and only the layer sways — not
 * each blade. Four animated nodes instead of 460 keeps this smooth on the
 * six-year-old tablets this will actually run on.
 */
const LAYERS = 4;

/**
 * The result, drawn rather than tabulated.
 *
 * The people using this are not going to read a chart, and a letter grade
 * means nothing on its own. A lawn does: everyone already knows what healthy
 * grass and dying grass look like, so the picture lands before a single word
 * is read. Health drives colour, height, droop, density and how much bare
 * earth shows through — several signals at once, so the difference between a
 * good result and a poor one is obvious from across a room.
 */
export function GrassField({ health }: Props) {
  const h = Math.min(1, Math.max(0, health));

  const layers = useMemo(() => {
    const random = makeRandom(20260817);

    const green: Rgb = [58, 140, 58];
    const straw: Rgb = [196, 172, 78];
    const brown: Rgb = [124, 94, 56];

    // Dying grass thins out as well as browning, so fewer blades are drawn.
    const count = Math.round(BLADES * (0.4 + h * 0.6));

    const buckets: {
      depth: number;
      baseY: number;
      sway: number;
      duration: number;
      delay: number;
      blades: { path: string; colour: string }[];
    }[] = Array.from({ length: LAYERS }, (_, layer) => {
      const depth = (layer + 0.5) / LAYERS;
      return {
        depth,
        baseY: HORIZON + depth * (HEIGHT - HORIZON),
        // Front grass catches more wind; dead grass barely moves at all.
        sway: (0.7 + depth * 2.4) * (0.25 + h * 0.75),
        duration: 5.2 - depth * 1.4,
        delay: -layer * 0.8,
        blades: [],
      };
    });

    for (let i = 0; i < count; i++) {
      const jitter = random();
      const depth = random();
      const x = random() * WIDTH;

      const layerIndex = Math.min(LAYERS - 1, Math.floor(depth * LAYERS));
      const bucket = buckets[layerIndex]!;

      // Nearer blades sit lower, stand taller and read darker, which gives the
      // field depth without a second drawing pass.
      const baseY = HORIZON + depth * (HEIGHT - HORIZON) * 0.98;
      const scale = 0.4 + depth * 1.0;

      // Dry grass is shorter and flops over instead of standing up.
      const height = (40 + jitter * 52) * scale * (0.42 + h * 0.58);
      const lean = (jitter - 0.5) * 62 * (1 + (1 - h) * 2.4);
      const droop = (1 - h) * height * 0.6;
      const halfWidth = Math.max(0.9, 2.4 * scale);

      const variance = (jitter - 0.5) * 0.26;
      const shade = Math.min(1, Math.max(0, h + variance));
      const colour =
        shade > 0.5 ? mix(straw, green, (shade - 0.5) * 2) : mix(brown, straw, shade * 2);

      const tipX = x + lean;
      const tipY = baseY - height + droop;
      const controlX = x + lean * 0.28;
      const controlY = baseY - height * 0.7;

      // A tapered leaf, not a hairline stroke: wide at the root, a point at
      // the tip. This is most of the difference between "grass" and "bristles".
      bucket.blades.push({
        colour,
        path:
          `M ${(x - halfWidth).toFixed(1)} ${baseY.toFixed(1)} ` +
          `Q ${(controlX - halfWidth * 0.5).toFixed(1)} ${controlY.toFixed(1)} ` +
          `${tipX.toFixed(1)} ${tipY.toFixed(1)} ` +
          `Q ${(controlX + halfWidth * 0.5).toFixed(1)} ${controlY.toFixed(1)} ` +
          `${(x + halfWidth).toFixed(1)} ${baseY.toFixed(1)} Z`,
      });
    }

    return buckets;
  }, [h]);

  // Bare earth spreads only once the lawn is genuinely in trouble, so a merely
  // average household does not get a picture full of holes.
  const patches = useMemo(() => {
    const random = makeRandom(77712);
    const count = Math.round(Math.pow(1 - h, 2) * 11);
    return Array.from({ length: count }, () => ({
      cx: random() * WIDTH,
      cy: HORIZON + 46 + random() * (HEIGHT - HORIZON - 52),
      rx: 40 + random() * 80,
      ry: 8 + random() * 14,
    }));
  }, [h]);

  const skyTop = mix([196, 168, 122], [142, 194, 226], h);
  const skyLow = mix([226, 207, 170], [211, 233, 240], h);
  const soilTop = mix([154, 128, 90], [78, 108, 56], h);
  const soilLow = mix([118, 96, 68], [44, 72, 38], h);
  const sunGlow = mix([232, 148, 72], [255, 238, 176], h);

  return (
    <svg
      className="grass"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label={
        h > 0.66
          ? "A picture of thick, healthy green grass in sunshine."
          : h > 0.33
            ? "A picture of grass that is patchy and turning yellow."
            : "A picture of dry brown grass with bare earth showing through."
      }
    >
      <defs>
        <linearGradient id="grass-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={skyTop} />
          <stop offset="100%" stopColor={skyLow} />
        </linearGradient>
        <linearGradient id="grass-soil" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={soilTop} />
          <stop offset="100%" stopColor={soilLow} />
        </linearGradient>
        <radialGradient id="grass-sun">
          <stop offset="0%" stopColor={sunGlow} stopOpacity="0.9" />
          <stop offset="100%" stopColor={sunGlow} stopOpacity="0" />
        </radialGradient>
        <clipPath id="grass-ground">
          <rect y={HORIZON} width={WIDTH} height={HEIGHT - HORIZON} />
        </clipPath>
      </defs>

      <rect width={WIDTH} height={HORIZON + 2} fill="url(#grass-sky)" />
      <circle cx={642} cy={58} r={92} fill="url(#grass-sun)" />
      <circle cx={642} cy={58} r={25} fill={sunGlow} opacity={0.45 + h * 0.45} />

      <rect y={HORIZON} width={WIDTH} height={HEIGHT - HORIZON} fill="url(#grass-soil)" />

      <g clipPath="url(#grass-ground)">
        {patches.map((patch, index) => (
          <ellipse
            key={`patch-${index}`}
            cx={patch.cx}
            cy={patch.cy}
            rx={patch.rx}
            ry={patch.ry}
            fill="rgb(152, 126, 88)"
            opacity={0.5}
          />
        ))}

        {layers.map((layer, index) => (
          <g
            key={`layer-${index}`}
            className="grass__layer"
            style={
              {
                transformOrigin: `${WIDTH / 2}px ${layer.baseY}px`,
                animationDuration: `${layer.duration}s`,
                animationDelay: `${layer.delay}s`,
                "--sway": `${layer.sway}deg`,
              } as React.CSSProperties
            }
          >
            {layer.blades.map((blade, bladeIndex) => (
              <path key={bladeIndex} d={blade.path} fill={blade.colour} />
            ))}
          </g>
        ))}
      </g>
    </svg>
  );
}
