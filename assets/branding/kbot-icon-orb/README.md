# KBOT 光之球图标

0.2.1 起的应用图标，与桌面角色共用 `src/ui/robot-orb.js` 着色器和 `src/ui/orb.jpg` 球体贴图。

- `kbot-icon-master.png`：1024 × 1024 RGBA 母版，透明背景，正面白色双眼。
- `render.html`：可重复导出的母版页面。固定种子 3、待机状态、时间 1.4 秒、正面视线；裁切范围为 122 个逻辑单位，去除地面阴影。
- `src-tauri/icons/`：由 Tauri CLI 从母版生成的正式打包图标。

重新导出：

1. 在仓库根目录运行 `npm run dev`。
2. 打开 <http://127.0.0.1:1420/assets/branding/kbot-icon-orb/render.html>，点击「下载 1024px 透明母版」，保存为本目录的 `kbot-icon-master.png`。
3. 在仓库根目录运行：

```sh
npm run tauri -- icon assets/branding/kbot-icon-orb/kbot-icon-master.png
```

菜单栏使用 `src-tauri/src/lib.rs` 中的圆形模板图标，双眼为透明镂空，随系统菜单栏外观着色。
