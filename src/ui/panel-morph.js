/* 只负责光球与现有面板之间的过渡；结束后移除动画层，恢复原有样式。 */
export class PanelMorph {
  constructor({ panel, pet, robot, body, reduced, hidden, onChange }) {
    Object.assign(this, { panel, pet, robot, body, reduced, hidden, onChange });
    this.target = false;
    this.animations = [];
    this.master = null;
    this.image = null;
    this.duration = 0;
    this.media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.media?.addEventListener('change', () => { if (this.media.matches) this.finish(); });
  }

  isActive() { return this.master !== null; }

  snapshot() {
    // WebGL 的绘图缓冲区不保留：同一帧重新绘制再拷贝，2D 回退也走同一路径。
    this.robot.render();
    const source = this.robot.canvas, rect = source.getBoundingClientRect();
    const image = document.createElement('canvas');
    image.className = 'panel-morph-image';
    image.setAttribute('aria-hidden', 'true');
    image.width = source.width;
    image.height = source.height;
    image.getContext('2d').drawImage(source, 0, 0);
    Object.assign(image.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
    document.body.append(image);
    this.image = image;
    return rect;
  }

  set(show) {
    this.target = show;
    const { panel, pet } = this;
    panel.hidden = false;
    panel.classList.toggle('open', show);
    pet.classList.add('panel-docked');
    pet.inert = true;
    pet.setAttribute('aria-hidden', 'true');

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
      for (const animation of this.animations) {
        animation.playbackRate = show ? 1 : -1;
        animation.play();
      }
      return;
    }

    const minimal = this.reduced() || this.media?.matches;
    const duration = minimal ? 130 : 480;
    this.duration = duration;
    const timing = { duration, easing: 'cubic-bezier(0.38, 0, 0.2, 1)', fill: 'both' };
    const tracks = [];
    if (minimal) {
      tracks.push([panel, [{ opacity: 0 }, { opacity: 1 }]]);
      tracks.push([pet, [{ opacity: 1 }, { opacity: 0 }]]);
    } else {
      const b = this.body();
      // 留出少量光晕空间；最终面板的位置、大小和材质全部取自现有布局。
      const width = b.right - b.left, height = b.bottom - b.top;
      const bounds = { left: b.left - width * 0.08, top: b.top - height * 0.08, width: width * 1.16, height: height * 1.16 };
      const r = panel.getBoundingClientRect(), style = getComputedStyle(panel);
      const from = `translate(${bounds.left - r.left}px, ${bounds.top - r.top}px) scale(${bounds.width / r.width}, ${bounds.height / r.height})`;
      const source = this.snapshot(), avatarElement = panel.querySelector('.p-avatar'), avatar = avatarElement.getBoundingClientRect();
      const sx = avatar.width / width, sy = avatar.height / height;
      const toAvatar = `translate(${avatar.left - (b.left - source.left) * sx - source.left}px, ${avatar.top - (b.top - source.top) * sy - source.top}px) scale(${sx}, ${sy})`;
      tracks.push([panel, [
        { transform: from, borderRadius: '50%', backgroundColor: 'transparent', boxShadow: 'none' },
        { transform: 'none', borderRadius: style.borderRadius, backgroundColor: style.backgroundColor, boxShadow: style.boxShadow },
      ]]);
      tracks.push([this.image, [{ transform: 'none', opacity: 1 }, { opacity: 1, offset: 0.94 }, { transform: toAvatar, opacity: 0 }]]);
      tracks.push([avatarElement, [{ opacity: 0 }, { opacity: 0, offset: 0.94 }, { opacity: 1 }]]);
      tracks.push([pet, [{ opacity: 1 }, { opacity: 0, offset: 0.025 }, { opacity: 0 }]]);
      for (const content of panel.querySelectorAll(':scope > .p-head, :scope > .p-body, :scope > .p-composer')) {
        tracks.push([content, [{ opacity: 0 }, { opacity: 0, offset: 0.58 }, { opacity: 1 }]]);
      }
    }

    panel.classList.add('morphing');
    const start = document.timeline.currentTime;
    for (const [element, frames] of tracks) {
      const animation = element.animate(frames, timing);
      animation.pause();
      animation.currentTime = show ? 0 : duration;
      animation.playbackRate = show ? 1 : -1;
      animation.play();
      if (show) animation.startTime = start;
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
    panel.classList.toggle('open', target);
    panel.classList.remove('morphing');
    panel.hidden = !target;
    pet.classList.toggle('panel-docked', target);
    pet.inert = target || this.hidden();
    pet.setAttribute('aria-hidden', String(pet.inert));
    for (const animation of this.animations) {
      animation.onfinish = null;
      animation.cancel();
    }
    this.animations = [];
    this.image?.remove();
    this.image = null;
    if (wasActive) this.onChange(false);
  }
}
