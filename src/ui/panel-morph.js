/* 光球与现有面板共用一条可逆时间线；只动画合成属性，不复制 WebGL 画布。 */
export class PanelMorph {
  constructor({ panel, pet, robot, body, reduced, hidden, onChange }) {
    Object.assign(this, { panel, pet, robot, body, reduced, hidden, onChange });
    this.target = false;
    this.animations = [];
    this.master = null;
    this.duration = 0;
    this.media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.media?.addEventListener('change', () => { if (this.media.matches) this.finish(); });
  }

  isActive() { return this.master !== null; }

  set(show) {
    this.target = show;
    const { panel, pet } = this;
    // 清掉上一次收起留下的强制隐藏层，避免新一轮展开先闪过透明状态。
    panel.classList.remove('morph-hidden');
    panel.hidden = false;
    panel.classList.toggle('open', show);
    pet.classList.add('panel-docked');
    pet.inert = true;
    pet.setAttribute('aria-hidden', 'true');
    // 冻结的原画布直接参与合成：不用同步 GPU 回读，也没有截图与新一帧的交接。
    this.robot.docked = true;

    if (this.hidden() || typeof panel.animate !== 'function') {
      this.finish();
      return;
    }
    if (this.master) {
      const time = this.master.currentTime;
      if ((show && time >= this.duration) || (!show && time <= 0)) {
        this.finish();
        return;
      }
      // 复用同一条时间线，中途反向不会跳回起点，也不会丢失后一次点击。
      const start = document.timeline.currentTime;
      for (const animation of this.animations) {
        animation.currentTime = time;
        animation.playbackRate = show ? 1 : -1;
        animation.play();
        animation.startTime = start - time / animation.playbackRate;
      }
      return;
    }

    const minimal = this.reduced() || this.media?.matches;
    const duration = minimal ? 130 : 360;
    this.duration = duration;
    const timing = { duration, easing: 'cubic-bezier(0.4, 0, 0.6, 1)', fill: 'both' };
    const tracks = [];
    if (minimal) {
      tracks.push([panel, [{ opacity: 0 }, { opacity: 1 }]]);
      tracks.push([pet, [{ opacity: 1 }, { opacity: 0 }]]);
    } else {
      const b = this.body();
      // 留出少量光晕空间；最终面板的位置、大小和材质全部取自现有布局。
      const width = b.right - b.left, height = b.bottom - b.top;
      const bounds = { left: b.left - width * 0.08, top: b.top - height * 0.08, width: width * 1.16, height: height * 1.16 };
      const r = panel.getBoundingClientRect();
      const from = `translate3d(${bounds.left - r.left}px, ${bounds.top - r.top}px, 0) scale(${bounds.width / r.width}, ${bounds.height / r.height})`;
      const source = this.robot.canvas.getBoundingClientRect(), avatarElement = panel.querySelector('.p-avatar'), avatar = avatarElement.getBoundingClientRect();
      const sx = avatar.width / width, sy = avatar.height / height;
      const toAvatar = `translate3d(${avatar.left - (b.left - source.left) * sx - source.left}px, ${avatar.top - (b.top - source.top) * sy - source.top}px, 0) scale(${sx}, ${sy})`;
      tracks.push([panel, [
        { transform: from, opacity: 0 },
        // 收起的最后一段只显示光球，给透明窗口的合成器留出清空面板的时间。
        { opacity: 0, offset: 0.3 },
        { opacity: 1, offset: 0.8 },
        { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
      ]]);
      tracks.push([this.robot.canvas, [{ transform: 'translate3d(0, 0, 0) scale(1)' }, { transform: toAvatar }]]);
      tracks.push([pet, [{ opacity: 1 }, { opacity: 1, offset: 0.88 }, { opacity: 0 }]]);
      tracks.push([avatarElement, [{ opacity: 0 }, { opacity: 0, offset: 0.88 }, { opacity: 1 }]]);
      for (const content of panel.querySelectorAll(':scope > .p-head, :scope > .p-body, :scope > .p-composer')) {
        tracks.push([content, [{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }]]);
      }
    }

    panel.classList.add('morphing');
    pet.parentElement.classList.add('panel-morphing');
    const start = document.timeline.currentTime;
    for (const [element, frames] of tracks) {
      const animation = element.animate(frames, timing);
      animation.pause();
      animation.currentTime = show ? 0 : duration;
      animation.playbackRate = show ? 1 : -1;
      animation.play();
      // 正放、倒放都显式共享开始时间，避免多个图层在 WebKit 中错开一帧。
      animation.startTime = start - animation.currentTime / animation.playbackRate;
      this.animations.push(animation);
    }
    const master = this.master = this.animations[0];
    master.onfinish = () => {
      if (this.master !== master) return;
      if (this.target ? master.currentTime < this.duration : master.currentTime > 0) return;
      this.finish();
    };
    this.onChange(true);
  }

  finish() {
    const { panel, pet, target } = this;
    const wasActive = this.isActive();
    this.master = null;
    this.duration = 0;
    // 先用独立的隐藏层退出合成，再撤销变换，避免回到原尺寸时闪出矩形背景。
    panel.classList.toggle('morph-hidden', !target);
    panel.hidden = !target;
    panel.classList.toggle('open', target);
    panel.classList.remove('morphing');
    pet.parentElement.classList.remove('panel-morphing');
    pet.classList.toggle('panel-docked', target);
    pet.inert = target || this.hidden();
    pet.setAttribute('aria-hidden', String(pet.inert));
    for (const animation of this.animations) {
      animation.onfinish = null;
      animation.cancel();
    }
    this.animations = [];
    this.robot.docked = target;
    if (wasActive) this.onChange(false);
  }
}
