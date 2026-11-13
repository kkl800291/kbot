/* KBOT · 光纹生命体 · 配色
 * 身体始终是白、淡紫、青的光纱；配色只换结点上那几处暖光（以及沾了暖色的丝）。
 * 柔光（molten）就是原样的琥珀色，极光换成青绿，虹彩换成紫。
 */

const HUES = { molten: null, aurora: [0.32, 1.0, 0.84], iri: [0.8, 0.58, 1.0] };
export const PALETTES = Object.keys(HUES);

/** 一个颜色有多暖：红比蓝多出来的量。冷色和白色不动。 */
function recolor(c, hue) {
  const k = c[0] - c[2];
  if (k < 0.12) return c;
  const t = Math.min(1, k / 0.6) * 0.9;
  return c.map((v, i) => 1 - (1 - hue[i]) * t);
}

/** 按配色换过颜色的姿态。未知名字按柔光。 */
export function withPalette(pose, name) {
  const hue = HUES[name];
  if (!hue) return pose;
  return {
    ...pose,
    SHEETS: pose.SHEETS.map(S => ({ ...S, ca: recolor(S.ca, hue), cb: recolor(S.cb, hue), film: S.film && recolor(S.film, hue) })),
    LIGHTS: pose.LIGHTS.map(L => ({ ...L, color: recolor(L.color, hue) })),
  };
}
