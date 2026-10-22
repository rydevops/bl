// Day/night cycle. dayTime in [0,1): 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight.
export const DAY_LENGTH = 1200; // seconds for a full cycle
export const START_TIME = 0.06;

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const DAY_SKY = [0.52, 0.76, 0.96];
const NIGHT_SKY = [0.025, 0.04, 0.1];
const DUSK = [0.98, 0.55, 0.3];

export function skyState(dayTime) {
  const a = dayTime * Math.PI * 2;
  const elev = Math.sin(a); // sun height: +1 noon, -1 midnight
  const sunDir = normalize([Math.cos(a), elev, 0.28]);
  const moonDir = [-sunDir[0], -sunDir[1], -sunDir[2]];
  const dayAmt = clamp01(elev * 3 + 0.5); // 0 night .. 1 day with a soft horizon blend
  const duskAmt = clamp01(1 - Math.abs(elev) * 4) * 0.85;
  let sky = mix(NIGHT_SKY, DAY_SKY, dayAmt);
  sky = mix(sky, DUSK, duskAmt * 0.6);
  const fog = mix(sky, [0.85, 0.9, 0.95], 0.18 * dayAmt);
  return {
    sunDir, moonDir,
    daylight: 0.3 + 0.7 * dayAmt, // brightness multiplier for terrain
    nightFactor: 1 - dayAmt,
    skyColor: sky,
    fogColor: fog,
    isNight: dayAmt < 0.35,
  };
}

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
