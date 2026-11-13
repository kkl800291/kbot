import { describe, expect, it } from 'vitest';
import {
  arrival, barTarget, captionOf, contentSize, createNoteQueue, energyMode, energyPlacement, gazeAt, hotkeyRoute, inHotzone, layout,
  plainText, settleState, shouldAutoClose, shouldWait, SPEECH_TTL, SUMMON, SUMMON_IDLE, talkMs, WIN,
} from '../src/ui/top-model.js';

describe('top layout', () => {
  it('sizes each state as in the design', () => {
    expect(contentSize('hidden')).toEqual([300, 0]);
    expect(contentSize('peek')).toEqual([340, 40]);
    expect(contentSize('compact', { act: { kind: 'talk' } })).toEqual([280, 40]);
    expect(contentSize('compact', { act: { kind: 'error' } })).toEqual([300, 40]);
    expect(contentSize('compact', { act: { kind: 'task' } })).toEqual([340, 52]);
    expect(contentSize('note')).toEqual([440, 116]);
    expect(contentSize('summon')).toEqual([1100, 506]);
    expect(contentSize('chat')).toEqual([540, 440]);
    expect(contentSize('chat', { expanded: true })).toEqual([760, 620]);
  });

  it('grows the standby content with its caption up to 646 tall', () => {
    expect(contentSize('summon', { caption: 52 })).toEqual([1100, 558]);
    expect(contentSize('summon', { caption: 139.6 })).toEqual([1100, 646]);
    expect(contentSize('summon', { caption: 400 })).toEqual([1100, 646]);
    expect(contentSize('summon', { caption: -5 })).toEqual([1100, 506]);
    // 字幕只影响召唤态
    expect(contentSize('chat', { caption: 80 })).toEqual([540, 440]);
  });

  it('centers the content below the top edge and lays the plate exactly under it', () => {
    const { content, halo, box } = layout('note', { safeTop: 32 });
    expect(content).toEqual({ x: 280, y: 42, w: 440, h: 116 });
    expect(halo).toEqual({ ...content, feather: 0, radius: 24 });
    expect(box).toEqual([294, 56, 88, 88]);
    expect(layout('hidden').halo.h).toBe(0);
  });

  it('makes the energy body the lead in summon and an avatar in the window', () => {
    const s = layout('summon', { caption: 60, safeTop: 32 });
    expect(s.content).toEqual({ x: 24, y: 59, w: 952, h: 566 });
    expect(s.box).toEqual([56, 58, 888, 360]);
    expect(s.energyOffset).toEqual({ x: 0, y: 17 });
    expect(s.band).toBeNull();
    expect(layout('chat').box).toEqual([240, 16, 40, 40]);
    expect(layout('chat', { expanded: true }).box).toEqual([130, 16, 40, 40]);
    expect(layout('peek').box).toEqual([340, 17, 26, 26]);
    expect(layout('compact', { act: { kind: 'talk' } }).box).toEqual([370, 17, 26, 26]);
  });

  it('moves the chat, backdrop and avatar target together, keeping other states anchored', () => {
    const chatOffset = { x: 300, y: 180 };
    for (const expanded of [false, true]) {
      const before = layout('chat', { expanded, safeTop: 32 });
      const moved = layout('chat', { expanded, safeTop: 32, chatOffset });
      expect(moved.content).toEqual({ ...before.content, x: before.content.x + 300, y: before.content.y + 180 });
      expect(moved.halo).toEqual({ ...before.halo, x: before.halo.x + 300, y: before.halo.y + 180 });
      expect(moved.box).toEqual(before.box);
      expect(moved.energyOffset).toEqual(chatOffset);
      expect(moved.box[0] + moved.energyOffset.x).toBe(moved.content.x + 10);
      expect(moved.box[1] + moved.energyOffset.y).toBe(moved.content.y + 6);
    }
    for (const state of ['hidden', 'peek', 'compact', 'note', 'summon']) {
      expect(layout(state, { chatOffset })).toEqual(layout(state));
    }
  });

  it('places a moved chat avatar in its header on the fixed viewport canvas', () => {
    for (const origin of [{ x: 524, y: 0 }, { x: -100, y: 12 }]) {
      for (const chatOffset of [{ x: 420, y: 360 }, { x: -600, y: 100 }]) {
        const L = layout('chat', { chatOffset });
        const placed = energyPlacement(L, origin);
        expect(placed.box).toEqual([origin.x + L.content.x + 10, origin.y + L.content.y + 6, 40, 40]);
        expect(placed.band).toBeNull();
      }
    }
  });

  it('centers the summoned body on the viewport and translates a task progress band into that same canvas', () => {
    const origin = { x: 524, y: 0 };
    const summoned = energyPlacement(layout('summon', { viewport: { x: -524, y: 0, w: 2048, h: 953 } }), origin);
    expect(summoned.box[0] + summoned.box[2] / 2).toBe(1024);
    const task = layout('compact', { act: { kind: 'task' } });
    expect(energyPlacement(task, origin).band).toEqual([900, 48, 274, 8]);
  });

  it('keeps a dragged or expanded chat inside the screen, including outside the fixed stage', () => {
    const bounds = { x: -212, y: 40, w: 1424, h: 852 };
    for (const expanded of [false, true]) {
      const base = layout('chat', { expanded, safeTop: 32 });
      const left = layout('chat', { expanded, safeTop: 32, chatOffset: { x: -9999, y: -9999 }, bounds });
      expect(left.content).toEqual({ ...base.content, x: bounds.x, y: bounds.y });
      const right = layout('chat', { expanded, safeTop: 32, chatOffset: { x: 9999, y: 9999 }, bounds });
      expect(right.content.x + right.content.w).toBe(bounds.x + bounds.w);
      expect(right.content.y + right.content.h).toBe(bounds.y + bounds.h);
      expect(right.box).toEqual(base.box);
      expect(right.halo).toMatchObject(right.content);
      for (const moved of [left, right]) {
        expect(moved.box[0] + moved.energyOffset.x).toBe(moved.content.x + 10);
        expect(moved.box[1] + moved.energyOffset.y).toBe(moved.content.y + 6);
      }
    }
    const small = layout('chat', { bounds: { x: 8, y: 8, w: 300, h: 300 }, chatOffset: { x: 500, y: 500 } });
    expect(small.content).toMatchObject({ x: 8, y: 8 });
  });

  it('returns the summoned body to its fixed position after showing a moved chat avatar', () => {
    const chatOffset = { x: -700, y: 600 };
    const chat = layout('chat', { chatOffset });
    expect(chat.energyOffset).toEqual(chatOffset);
    const summon = layout('summon', { chatOffset, safeTop: 32 });
    expect(summon.energyOffset).toEqual({ x: 0, y: 17 });
    expect(summon.box).toEqual([56, 58, 888, 360]);
    expect(summon).toEqual(layout('summon', { safeTop: 32 }));
  });

  it('centers standby on the actual screen and reports a full-screen glass backdrop', () => {
    for (const viewport of [{ x: -524, y: 0, w: 2048, h: 953 }, { x: 100, y: 0, w: 800, h: 600 }, { x: -780, y: 0, w: 2560, h: 1440 }]) {
      const result = layout('summon', { viewport, caption: 96 });
      expect(result.halo).toMatchObject({ ...viewport, radius: 0, feather: 0, standby: true });
      expect('focusX' in result.halo).toBe(true);
      if ('focusX' in result.halo && 'focusY' in result.halo) {
        expect(result.halo.focusX).toBe(500);
        expect(result.halo.focusY).toBe(result.box[1] + result.energyOffset.y + result.box[3] / 2);
      }
      expect(result.content.x + result.content.w / 2).toBe(500);
      expect(result.content.y).toBeGreaterThanOrEqual(8);
      expect(result.content.y + result.content.h).toBeLessThan(viewport.h);
      expect(result.box[1] + result.box[3]).toBeLessThan(740);
      expect(result.box[1] + result.energyOffset.y).toBeGreaterThan(result.content.y);
    }
  });

  it('keeps the input and energy body anchored when commands and captions change on short screens', () => {
    for (const height of [480, 600, 768, 1080]) {
      for (const safeTop of [0, 32, 74]) {
        const viewport = { x: -140, y: 0, w: 1280, h: height };
        const ready = layout('summon', { viewport, safeTop });
        for (const caption of [24, 67, 139, 140, 999, 0]) {
          const shown = layout('summon', { viewport, safeTop, caption });
          expect(shown.summon).toEqual(ready.summon);
          expect(shown.box).toEqual(ready.box);
          expect(shown.energyOffset).toEqual(ready.energyOffset);
          expect(shown.content.y).toBe(ready.content.y);
          expect(shown.content.y + shown.content.h).toBeLessThan(viewport.h);
        }
      }
    }
  });

  it('leaves enough room for the full caption instead of moving the field and clipping the reply', () => {
    const shown = layout('summon', { viewport: { x: -140, y: 0, w: 1280, h: 600 }, safeTop: 74, caption: 140 });
    const frame = shown.summon!;
    expect(frame.captionMax).toBe(140);
    expect(shown.content.h - frame.inputY - SUMMON.input - SUMMON.bottom).toBe(140);
    const inputTop = shown.content.y + frame.inputY;
    expect(shown.box[1] + shown.energyOffset.y + shown.box[3]).toBeLessThan(inputTop);
    expect(inputTop + SUMMON.input + 140).toBeLessThan(600);
  });

  it('keeps the body on the left of a task bar and runs the progress band along its bottom', () => {
    const t = layout('compact', { act: { kind: 'task' } });
    expect(t.box).toEqual([340, 17, 26, 26]);
    expect(t.band).toEqual([376, 48, 274, 8]);
    for (const st of ['hidden', 'peek', 'note', 'summon', 'chat']) expect(layout(st, { act: { kind: 'task' } }).band).toBeNull();
    expect(layout('compact', { act: { kind: 'talk' } }).band).toBeNull();
  });

  it('picks the energy mode from the state and what is going on', () => {
    expect(energyMode('chat', { chatMode: 'think' })).toBe('think');
    expect(energyMode('summon')).toBe('listen');
    expect(energyMode('summon', { chatMode: 'talk' })).toBe('talk');
    expect(energyMode('note', { note: { mode: 'remind' } })).toBe('remind');
    expect(energyMode('compact', { act: { kind: 'task' } })).toBe('progress');
    expect(energyMode('compact', { act: { kind: 'talk' } })).toBe('talk');
    expect(energyMode('peek')).toBe('idle');
  });

  it('lets a companion line talk for about 60ms per character, between 0.8 and 3 seconds', () => {
    expect(talkMs('好')).toBe(800);
    expect(talkMs('您已经忙了很久，歇一会儿吧，其余的交给我。')).toBe(21 * 60);
    expect(talkMs('长'.repeat(80))).toBe(3000);
    expect(talkMs(undefined)).toBe(800);
  });

  it('senses the cursor only in a thin strip at the top center', () => {
    expect(inHotzone(500, 3)).toBe(true);
    expect(inHotzone(649, 6)).toBe(true);
    expect(inHotzone(651, 3)).toBe(false);
    expect(inHotzone(500, 12)).toBe(false);
    expect(inHotzone(500, 30, 32)).toBe(true);
  });

  it('looks at the cursor only when it is near the body in summon, peek and note', () => {
    const box = layout('summon').box;
    expect(gazeAt('summon', box, 500, 300)).toEqual([500, 300]);
    expect(gazeAt('summon', box, 500 + 421, 88)).toBeNull();
    expect(gazeAt('peek', layout('peek').box, 700, 20)).toEqual([700, 20]);
    expect(gazeAt('note', layout('note').box, 900, 400)).toBeNull();
    for (const st of ['hidden', 'compact', 'chat']) expect(gazeAt(st, box, 500, 88)).toBeNull();
  });
});

describe('top summon and routing', () => {
  it('routes the hotkey: summon from anywhere, close when summoned or in the window', () => {
    for (const st of ['hidden', 'peek', 'compact', 'note']) expect(hotkeyRoute(st)).toBe('summon');
    expect(hotkeyRoute('summon')).toBe('close');
    expect(hotkeyRoute('chat')).toBe('close');
  });

  it('sends a click on the resident bar back to where the work came from', () => {
    expect(barTarget({ kind: 'think', source: 'agent', surface: 'chat' })).toBe('chat');
    expect(barTarget({ kind: 'think', source: 'agent', surface: 'summon' })).toBe('summon');
    expect(barTarget({ kind: 'talk', source: 'voice' })).toBe('summon');
    expect(barTarget({ kind: 'task' })).toBe('summon');
    expect(barTarget(null)).toBe('summon');
  });

  it('settles to the resident bar while something is going on, otherwise hides', () => {
    expect(settleState(null)).toBe('hidden');
    expect(settleState({ kind: 'talk' })).toBe('compact');
    expect(settleState({ kind: 'think', source: 'agent', surface: 'summon' })).toBe('compact');
  });

  it('auto-closes summon 30s after a reply only when nobody is hovering, typing or waiting', () => {
    const base = { idle: SUMMON_IDLE, hovering: false, empty: true, generating: false };
    expect(shouldAutoClose(base)).toBe(true);
    expect(shouldAutoClose({ ...base, idle: SUMMON_IDLE - 1 })).toBe(false);
    expect(shouldAutoClose({ ...base, hovering: true })).toBe(false);
    expect(shouldAutoClose({ ...base, empty: false })).toBe(false);
    expect(shouldAutoClose({ ...base, generating: true })).toBe(false);
  });
});

describe('summon captions', () => {
  it('turns markdown into one plain run of text', () => {
    expect(plainText('## 今天\n\n- **买菜**\n- 做饭[1]\n\n详见[官网](https://x.y)。')).toEqual({ text: '今天买菜做饭详见官网。', rich: false });
    expect(plainText('Use `npm i` then\nrun *it*.')).toEqual({ text: 'Use npm i then run it.', rich: false });
    expect(plainText('> 引用\n---\n1. 第一')).toEqual({ text: '引用第一', rich: false });
  });

  it('drops code, images and tables but marks them as rich, even mid-stream', () => {
    expect(plainText('看这段：\n```js\nlet a = 1;\n```\n就这样')).toEqual({ text: '看这段：就这样', rich: true });
    expect(plainText('先写：\n```py\nprint(1')).toEqual({ text: '先写：', rich: true });
    expect(plainText('图：![猫](a.png)')).toEqual({ text: '图：', rich: true });
    expect(plainText('对比\n| a | b |\n|---|---|\n| 1 | 2 |\n完')).toEqual({ text: '对比完', rich: true });
  });

  it('shows the text part of a reply and always links out for cards and errors', () => {
    expect(captionOf({ text: '好的，已为您设好。', status: 'done' })).toEqual({ text: '好的，已为您设好。', dim: '', rich: false });
    expect(captionOf({ text: '', status: 'thinking', steps: [{ kind: 'tool', t: '正在搜索网页', done: false }] }).dim).toBe('正在搜索网页');
    const q = captionOf({ text: '', status: 'done', card: { type: 'question', state: 'pending', questions: [{ question: '选哪天？' }] } });
    expect(q).toEqual({ text: '', dim: '想请教您：选哪天？', rich: true });
    expect(captionOf({ text: '要删除这些文件', status: 'thinking', card: { type: 'approval', state: 'pending', toolName: 'rm' } }))
      .toEqual({ text: '要删除这些文件', dim: '', rich: true });
    expect(captionOf({ text: '', status: 'error', error: '连接中断' })).toEqual({ text: '', dim: '连接中断', rich: true });
    expect(captionOf({ text: '', status: 'stopped' }).dim).toBe('已停止生成');
    expect(captionOf(null)).toEqual({ text: '', dim: '', rich: false });
  });
});

describe('top notifications', () => {
  it('lets reminders preempt companion lines but never the other way round', () => {
    expect(arrival(null, { kind: 'speech' })).toBe('show');
    expect(arrival({ kind: 'speech' }, { kind: 'remind' })).toBe('replace');
    expect(arrival({ kind: 'speech' }, { kind: 'speech' })).toBe('replace');
    expect(arrival({ kind: 'remind', pri: 'mid' }, { kind: 'speech' })).toBe('drop');
    expect(arrival({ kind: 'remind', pri: 'mid' }, { kind: 'remind', pri: 'mid' })).toBe('queue');
    expect(arrival({ kind: 'remind', pri: 'mid' }, { kind: 'remind', pri: 'high' })).toBe('replace');
  });

  it('waits while the user is typing or moving the mouse', () => {
    expect(shouldWait(0.5)).toBe(true);
    expect(shouldWait(2.4)).toBe(false);
    expect(shouldWait(undefined)).toBe(false);
  });

  it('queues one at a time, drops the oldest companion line past five, and expires stale ones', () => {
    const q = createNoteQueue();
    q.push({ kind: 'speech', text: 's1' }, 0);
    q.push({ kind: 'remind', text: 'r1' }, 0);
    for (let i = 2; i <= 5; i++) q.push({ kind: 'speech', text: 's' + i }, 0);
    expect(q.size).toBe(5);
    expect(q.next(0)?.text).toBe('r1');
    const late = createNoteQueue();
    late.push({ kind: 'speech', text: 'old' }, 0);
    late.push({ kind: 'remind', text: 'still due' }, 0);
    expect(late.next(SPEECH_TTL + 1)?.text).toBe('still due');
    expect(late.next(SPEECH_TTL + 1)).toBeNull();
    const reminders = createNoteQueue();
    for (let i = 0; i < 7; i++) reminders.push({ kind: 'remind', text: 'r' + i }, 0);
    expect(reminders.size).toBe(7);
  });
});
