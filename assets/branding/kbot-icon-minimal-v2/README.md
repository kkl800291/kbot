# KBOT · 简化图标 v2

日期：2026-11-13。

根据「上一版 AI 味太浓，参考大厂设计」的反馈重做。以少量大形状、清楚的轮廓、充足留白和有限配色表达角色与品牌。

## 方案

- `orb.png`：浅底流动光球。用两块紫色曲面和一道留白概括光纹生命体。
- `monogram-k.png`：深底 K 标记。用圆润的 K 形建立 KBOT 的字母识别，中心的蓝紫转折呼应界面的流动感。
- `preview.html`：两版的深浅背景与 32 / 64 / 128px 预览。
- `comparison.png`：浏览器实际渲染的两版及小尺寸对照图。

两版均由内置 **imagegen** 生成，未使用 CLI/API 回退。PNG 母版均为 1254 × 1254 RGBA，保留透明通道，四个角的 alpha 均为 0。已在浏览器中检查 32 / 64 / 128px、深浅背景下的实际显示。属于独立设计稿。

## 实际查看的参考

- [Apple：App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons#Design)：提炼核心概念，使用少量形状，并考虑小尺寸辨认。
- [Microsoft Design：Fluid forms, vibrant colors](https://microsoft.design/articles/fluid-forms-vibrant-colors/)：观察简化形状、柔和转折和相邻色的处理。
- [Google Workspace：新版应用图标](https://workspaceupdates.googleblog.com/2026/05/introducing-fresh-visual-identity-for-Google-Workspace-app-icons.html)：观察各图标的主轮廓和大色块。

参考的是设计方法。两版均为 KBOT 的独立设计，未复用参考公司的图标形状。

## A · 光球提示词

```text
Use case: logo-brand.
Asset type: one finished macOS application icon for KBOT. Square artwork, 1536x1536 if possible.
Design task: make an original, deliberately drawn brand symbol for a calm desktop companion whose in-app character is a flowing ball of light. Distill that idea into a small set of bold, optically balanced filled shapes. Visual clarity at 32 pixels is the main quality test.
Style reference: the supplied Google application-icon overview is only a reference for the economy of large filled shapes and clear silhouette. DO NOT copy any depicted symbol, arrangement or color scheme. Create exactly one original KBOT icon.
Composition: flat near-white rounded-square tile, large clean macOS corner radius, 91% of canvas width, centered, straight on, true transparent corners outside. A tiny neutral contact shadow on the tile is acceptable. Pure white to very pale cool gray tile, quiet and untextured.
Symbol: one compact circular flowing mark, about 62% of the tile width. It consists of just TWO substantial, softly rounded interlocking curved shapes, a deeper periwinkle upper-left shape and lighter lilac-blue lower-right shape. Their outer contours together suggest a calm round living presence, with a single elegant curved channel of white negative space through the middle. The channel runs diagonally from lower-left to upper-right, not a yin-yang S. One arc is a little shorter, giving the flow a distinct direction and slight original asymmetry. Broad stable masses, generous negative space, very clean contour, no line art, no inner hatch marks. It should look like a memorable brand symbol that could be cut out of two sheets of colored paper.
Color palette: periwinkle indigo #625BDD, soft lilac #9B97EE, on off-white #F8F8FB. At most a very gentle adjacent-color shift within the shapes. The identity must work perfectly as one flat solid color.
Medium: crisp vector-like graphic design. Flat fill or near-flat subtle color blending, perfectly smooth edges. No rendered material on the central mark. Calm, approachable, thoughtful.
Output: exactly ONE actual icon, centered in a square, without presentation layout, labels or lettering. All artwork contained within the tile.
Avoid: photorealism, 3D sculpture, liquid glass, glass orb, transparent marble, filament lines, silk texture, fabric mesh, iridescence, glow, bloom, lens flare, glitter, starburst, four-point sparkle, rainbow colors, chrome bevels, fake gloss, floating ribbons, sci-fi scenery, faces, eyes, robot, tiny details. No existing-company logos, no OpenAI knot, no Gemini sparkle, no Copilot loop, no yin-yang motif, no flat generic infinity symbol. No text, no wordmark, no watermark. Let geometry do the work.
```

## B · K 标记提示词

```text
Use case: logo-brand.
Asset type: one finished macOS application icon for KBOT, square artwork, 1536x1536 if possible.
Design task: create a custom minimal K monogram that gives KBOT its own memorable identity, suitable for a polished everyday desktop application. It should be friendly, steady and clear.
Style reference: the supplied Google application-icon overview is only a reference for large simple shapes, balanced color masses and small-size legibility. Do not reproduce any depicted logo.
Composition: a very dark muted indigo rounded-square tile #29263D, occupying 91% of the image, smooth macOS-style large corners, straight-on. Tile color is almost uniform, with at most a very gentle 5% lightening toward the top. Real transparent alpha outside the rounded corners. No shiny tile bevel, no glare.
Symbol: an unmistakable original capital K drawn as a custom geometric symbol, centered optically, about 57% of the tile width and 61% of its height. Three generous, rounded strokes with a consistent substantial optical weight: an upright pill-like stem on the left, and two softly rounded diagonal arms opening toward the upper right and lower right. The arms curve gently as they meet the stem; this gives a small echo of KBOT's in-app flowing motion. A carefully drawn small negative-space notch at the central join keeps the symbol breathable and original. Simple sculpted typography, not a stock typeset K. Pearl-white stem and upper arm, soft lavender lower arm, with an understated periwinkle patch where the two arms meet. Maximum three flat color areas, no drawn outlines. The mark must also remain distinctive and clear in one flat color.
Medium: editorially precise, flat vector-like brand design, clean fill shapes, carefully tuned round joins and spacing. Crisp contours; absolutely no texture. High contrast and generous surrounding space.
Output: exactly ONE completed application icon on a square image, not a design board, no caption. The only letterform is the central K symbol. No KBOT text, no slogan, no other letters, no watermark.
Avoid: 3D rendering, glass, silk, light filaments, glowing orb, bloom, glossy highlights, bevelled chrome, liquid gradients, dramatic lighting, rainbow, neon, sparkles, robot face, chatbot bubble, circuitry, extra decoration. Do not copy a known K logo. Do not imitate any reference-company silhouette.
```

