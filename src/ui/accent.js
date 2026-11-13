/* KBOT · 界面强调色。
 * 界面本身不带颜色：深色上是珍珠白，浅色上是石墨灰。三套配色（柔光、极光、虹彩）只换光球结点上的那点光，
 * 不再把按钮、链接染成对应的颜色——画面里唯一的颜色留给光球自己。 */

// 浅色版和白字、浅色面板都要过 WCAG AA（4.5:1）；深色版配深色字，和深色面板也过 AA
const NEUTRAL = { light: [44, 46, 54], dark: [236, 238, 244] };
export const UI_ACCENTS = { molten: NEUTRAL, aurora: NEUTRAL, iri: NEUTRAL };

/**
 * 界面强调色（RGB 三元组），写进 CSS 变量 --glow-rgb。
 * @param {string} palette
 * @param {boolean} dark
 */
export const uiAccent = (palette, dark) => (UI_ACCENTS[palette] || UI_ACCENTS.molten)[dark ? 'dark' : 'light'].slice();
