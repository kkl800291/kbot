# KBOT · 实色图标 v3

日期：2026-11-13。

根据「不使用紫色，避免常见 AI 产品的视觉联想」的反馈制作。沿用简化 K 标记的方向，重绘一套可精确控制的矢量轮廓，采用两种实色配色。

**正式采用**：0.5.1 起使用 `neutral.svg`（暖白 / 墨黑）生成 APP 打包图标，派生资源位于 `src-tauri/icons/`。松绿版本作为备选方案保留。

## 交付文件

- `neutral.svg` / `neutral.png`：暖白 + 墨黑。
- `pine.svg` / `pine.png`：松绿 + 米白。
- `comparison.png`：两种配色在深浅背景、32 / 64 / 128px 下的实际显示对照。
- `preview.html`：可在浏览器打开的对照页。

| 方案 | 底色 | 标记颜色 |
| --- | --- | --- |
| 暖白 / 墨黑 | #F3F0E9 | #292825 |
| 松绿 / 米白 | #24483E | #F4F1E8 |

SVG 母版为 1024 × 1024 画板。PNG 由 SVG 导出，尺寸为 1024 × 1024，RGBA，外角透明，底座和标记均为不透明实色。两版使用相同几何轮廓。

制作方式：先用内置 **imagegen** 探索配色；随后重绘为显式 SVG 路径，以准确控制形状、实色和透明边界。最终交付文件为 SVG 及其 PNG 导出，不是生成图片的直接复制。未使用 imagegen CLI/API 回退。

## 配色探索提示词

以下记录内置 imagegen 阶段使用的完整提示词；最终矢量稿的几何与配色以 SVG 文件为准。

### 暖白 / 墨黑

```text
Use case: precise-object-edit.
Asset type: palette revision of the existing KBOT macOS app icon.
Input image 1 is the edit target. Preserve its exact icon tile shape, corner radius, scale, placement, padding and custom K silhouette, including the rounded stem, rounded diagonal arms and central curved join. Preserve the straight-on framing. Change the color palette and flatten the finish only.
New palette: warm paper white #F3F0E9 for the entire rounded-square tile, and very dark graphite ink #292825 for the entire K. This is a strict two-color design. All three parts of the K, including the lower arm and center overlap, must have exactly the same solid graphite fill. Keep the external K silhouette and the notch at its inner right join; the former internal color boundaries disappear into one continuous solid silhouette.
Finish: perfectly flat, matte, crisp vector-like graphic design, even solid fills and smooth clean contours. No gradients, no colored shading, no light effect, no glossy material, no grain or paper texture. The tile is a uniform warm off-white. Maintain true transparent alpha outside the rounded-square tile and clean all exterior corners. The symbol is comfortably inset, optically centered, readable at 32px.
Constraints: recolor only, no redesign, no added shapes, no changed letter, no extra text, no wordmark, no mockup, no presentation board. No violet, purple, lilac, blue, cyan, iridescence, glow, bloom, glass, bevels, rainbow or decorative effects. ONE completed square app icon only.
```

### 松绿 / 米白

```text
Use case: precise-object-edit.
Asset type: palette revision of the existing KBOT macOS app icon.
Input image 1 is the edit target. Preserve its exact icon tile shape, corner radius, scale, placement, padding and custom K silhouette, including the rounded stem, rounded diagonal arms and central curved join. Preserve the straight-on framing. Change the color palette and flatten the finish only.
New palette: deep subdued pine green #24483E for the entire rounded-square tile, and warm ivory #F4F1E8 for the entire K. This is a strict two-color design. All three parts of the K, including the lower arm and center overlap, must have exactly the same solid warm ivory fill. Keep the external K silhouette and the notch at its inner right join; the former internal color boundaries disappear into one continuous solid silhouette.
Finish: perfectly flat, matte, crisp vector-like graphic design. Uniform fill colors and smooth clean contours, calm and approachable. No gradient, no colored shading, no light effects, no glossy material, no texture. Pine green should feel botanical and grounded, not turquoise, electric green or technology neon. The tile is a uniform deep muted forest green. Maintain true transparent alpha outside the rounded-square tile and clean all exterior corners. The symbol is comfortably inset, optically centered, readable at 32px.
Constraints: recolor only, no redesign, no added shapes, no changed letter, no extra text, no wordmark, no mockup, no presentation board. No violet, purple, lilac, blue, cyan, mint glow, iridescence, bloom, glass, bevels, rainbow or decorative effects. ONE completed square app icon only.
```

