# KBOT 品牌视觉

正式应用名：**KBOT**。深石墨、珍珠白陶瓷、冰蓝光眼；以少量轮廓和光影建立辨识度，图标不放文字，缩小后仍能识别。

- `kbot-icon-master.png`：图标高清母版，透明外角，用于生成 macOS `.icns` 和各尺寸 PNG。
- `kbot-cover.png`：横版品牌封面，保留 KBOT 字标和机器人主体。
- `archive/`：替换前的图标，保留为设计历史。

使用内置 **imagegen** 生成。图标为全新生成；横版封面以图标为视觉参考生成。未使用 CLI/API 回退方式。正式打包使用 `src-tauri/icons/` 的派生资源。

重新生成图标资源：

```sh
npm run tauri -- icon assets/branding/kbot-icon-master.png
```

## 最终图标提示词

```text
Use case: logo-brand / premium macOS application icon.
Create one finished, beautifully art-directed square app icon for KBOT, a quietly friendly desktop AI robot companion. This is the actual shippable icon asset, not a mockup, not a presentation sheet.
Composition: single large, iconic robot face centered on a precision rounded-square dark graphite tile; the tile occupies about 90% of the square canvas with clean transparent outside corners, macOS icon proportions. Bold, instantly legible at 32px. The robot head occupies about 70% of the tile width. A restrained, slightly three-dimensional sculptural object, nearly front-on with a subtle 8-degree three-quarter perspective. 
Design: original monolithic pearl-white ceramic robot head, softly chamfered generous corners, a beautifully inset nearly black smoked-glass face visor, two short icy-cyan vertical pill eyes with a focused inner white-blue glow. Friendly and confident, with a tiny quiet smile at most. One very short integrated antenna with a cyan point, balanced integrated side details, no separate body or pedestal. Refined industrial design and careful negative space; a memorable silhouette rather than a generic toy sticker. Smooth ceramic catching one broad soft studio highlight; controlled fine bevels and precise thin metallic edge; tactile material depth without excessive reflections. The dark tile has a subtle blue-black radial light falloff and a faint cyan light pool directly behind the head. Crisp silhouette and intentional asymmetry from perspective, beautiful optical balance. 
Mood: calm intelligence, approachable companion, premium creative software. Editorial product-design taste, highly finished, restrained glow.
Palette: graphite ink, warm pearl ceramic, a single ice-cyan accent. Excellent light-dark contrast.
Constraints: only ONE icon, centered, no text, no letters, no wordmark, no watermark, no surrounding UI, no multiple icons, no stars, no particles, no circuit decorations, no purple neon, no busy gradients, no detached body. The outside of the rounded-square tile must be true transparent alpha, not a checkerboard painted into the image. Render at high resolution, suitable as a 1024px or larger master icon.
```

## 最终封面提示词

```text
Use case: logo-brand.
Asset type: a finished premium widescreen application cover for KBOT, 16:9 landscape, around 1920x1080 or higher.
Reference image: the provided icon is the approved visual direction for the robot's identity, pearl-white ceramic shell, dark smoked-glass face, two cyan luminous pill eyes and tiny friendly smile. Preserve that recognizable design language and refined material quality.
Primary request: an elegant, expertly art-directed brand cover, with a single large sculptural robot head on the right half and the exact word "KBOT" on the left half in exceptionally beautiful large clean off-white geometric sans-serif typography, modern and confident, very carefully kerned. The word must be exactly K B O T as one word, no other text.
Visual direction: calm premium industrial design and Swiss editorial composition. Graphite-black background filling the frame, subtle midnight-teal light pool near the robot, very restrained blue reflected light, soft long studio shadows. Slightly warm white ceramic robot head, nearly front-facing with subtle perspective, clean metallic chamfer and smoked glass, a short cyan antenna point. The robot floats quietly without a body or pedestal. Use no rounded-square icon tile in this cover: extract the character concept naturally into the scene. Robot looks friendly, thoughtful, quietly capable. Distinctive lighting, tangible ceramic, controlled glass reflections; high-end rendered product photography rather than cartoon illustration. Large intentional negative space around the wordmark. Asymmetric balance, exact optical alignment, generous breathing room. At most one subtle broad abstract highlight in the background.
Constraints: one cohesive landscape cover, not a design board, not a mockup of a screen, not multiple variants. No tiny slogans, no extra words, no watermark, no UI, no stars, no particles, no circuit graphics, no hands, no detached robot body, no purple cyberpunk, no overexposed glows. The single word KBOT should be instantly readable and beautifully composed. Opaque background throughout the wide image.
```

