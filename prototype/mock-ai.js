/* 赛博伙伴 · 模拟大模型：按关键词返回演示回复（原型专用，不联网） */
window.MockAI = (function () {
  'use strict';
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const pad = n => String(n).padStart(2, '0');
  const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

  function num(s) {
    if (s == null || s === '') return NaN;
    if (/^\d/.test(s)) return parseFloat(s);
    if (s === '半') return 0.5;
    if (s.includes('十')) { const [a, b] = s.split('十'); return (a ? CN[a] : 1) * 10 + (b ? CN[b] : 0); }
    return s.length === 1 && s in CN ? CN[s] : NaN;
  }

  const PART = '(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上)';
  const REL_RE = /(\d{1,3}(?:\.\d+)?|[一二两三四五六七八九十半]{1,3})\s*(个)?\s*(分钟|分|小时|钟头)\s*(后|之后|以后)/;
  const CLOCK_SRC = PART + '?\\s*(\\d{1,2}|[一二两三四五六七八九十]{1,3})\\s*(?:点|:|：|时)\\s*(半|一刻|三刻|\\d{1,2}|[一二三四五]?十[一二三四五六七八九]?)?\\s*(?:分)?';
  const CLOCK_RE = new RegExp(CLOCK_SRC);
  const TRIGGER = /提醒我|叫我|喊我/;

  function dayWord(d, now) {
    const a = new Date(now); a.setHours(0, 0, 0, 0);
    const b = new Date(d); b.setHours(0, 0, 0, 0);
    const diff = Math.round((b - a) / 86400000);
    return diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }

  function stripTime(s) {
    return s
      .replace(new RegExp(CLOCK_SRC, 'g'), '')
      .replace(new RegExp(REL_RE.source, 'g'), '')
      .replace(/(今天|明天|后天|每天|每个工作日|工作日|每(?:周|星期|个星期)[一二三四五六日天])/g, '')
      .replace(new RegExp(PART, 'g'), '')
      .replace(/^[\s，,：:]*(?:要|去|该)?/, '')
      .replace(/[。！!～~？?\s]+$/, '')
      .trim();
  }

  function parseReminder(text, now) {
    const [before, after = ''] = text.split(TRIGGER);
    const content = stripTime(after) || stripTime(before) || '你交代的事';
    const rel = text.match(REL_RE);
    if (rel) {
      const n = num(rel[1]);
      const mins = Math.round(n * (/小时|钟头/.test(rel[3]) ? 60 : 1));
      if (mins > 0) {
        const d = new Date(now.getTime() + mins * 60000);
        return { ok: true, when: `${dayWord(d, now)} ${hm(d)}`, repeat: '仅一次', content, at: d.getTime() };
      }
    }
    const wk = (text.match(/每(?:周|星期|个星期)([一二三四五六日天])/) || [])[1];
    const daily = /每天/.test(text), workday = /工作日/.test(text);
    const dayOff = /后天/.test(text) ? 2 : /明天/.test(text) ? 1 : /今天/.test(text) ? 0 : null;
    const clk = text.match(CLOCK_RE);
    const dayPart = (text.match(new RegExp(PART)) || [])[1];
    const prefix = wk ? `每周${wk}` : daily ? '每天' : workday ? '工作日' : dayOff === 2 ? '后天' : dayOff === 1 ? '明天' : dayOff === 0 ? '今天' : '';
    if (!clk) return { ok: false, content, dayPart, prefix };
    let h = num(clk[2]), mi = 0;
    if (clk[3]) mi = clk[3] === '半' ? 30 : clk[3] === '一刻' ? 15 : clk[3] === '三刻' ? 45 : num(clk[3]);
    const part = clk[1] || dayPart;
    if (!part && h >= 1 && h <= 6) return { ok: false, ambiguous: true, content, clock: clk[0].trim(), h, prefix };
    if (/下午|傍晚|晚上/.test(part || '') && h < 12) h += 12;
    if (part === '中午' && h < 6) h += 12;
    if (!(h >= 0 && h < 24 && mi >= 0 && mi < 60)) return { ok: false, content, dayPart, prefix };
    const time = `${pad(h)}:${pad(mi)}`;
    if (wk) { const w = wk === '天' ? '日' : wk; return { ok: true, when: `每周${w} ${time}`, repeat: `每周${w}`, content }; }
    if (daily) return { ok: true, when: `每天 ${time}`, repeat: '每天', content };
    if (workday) return { ok: true, when: `工作日 ${time}`, repeat: '每个工作日', content };
    const d = new Date(now); d.setHours(h, mi, 0, 0);
    let note = '';
    if (dayOff != null) d.setDate(d.getDate() + dayOff);
    else if (d <= now) { d.setDate(d.getDate() + 1); note = '这个时间今天已经过了，我先帮你定在明天。'; }
    return { ok: true, when: `${dayWord(d, now)} ${time}`, repeat: '仅一次', content, note, at: d.getTime() };
  }

  const PART_CHOICES = {
    凌晨: [5, 6], 早上: [8, 8.5, 9], 早晨: [8, 8.5, 9], 上午: [9, 10, 11], 中午: [12, 12.5],
    下午: [14, 15, 16], 傍晚: [17.5, 18], 晚上: [19, 20, 21],
  };
  const clockLabel = v => `${Math.floor(v)}:${v % 1 ? '30' : '00'}`;
  const clockSay = (part, v) => {
    let h = Math.floor(v);
    if (/下午|傍晚|晚上|中午/.test(part) && h > 12) h -= 12;
    return `${h} 点${v % 1 ? '半' : ''}`;
  };

  function colorName([r, g, b]) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 510, s = mx === mn ? 0 : (mx - mn) / (255 - Math.abs(mx + mn - 255));
    if (l < 0.18) return '深色';
    if (s < 0.15) return l > 0.8 ? '白色' : '灰色';
    let h = 0;
    if (mx === r) h = ((g - b) / (mx - mn)) % 6; else if (mx === g) h = (b - r) / (mx - mn) + 2; else h = (r - g) / (mx - mn) + 4;
    h = (h * 60 + 360) % 360;
    return h < 15 || h >= 340 ? '红色' : h < 40 ? '橙色' : h < 65 ? '黄色' : h < 160 ? '绿色' : h < 200 ? '青色' : h < 255 ? '蓝色' : h < 300 ? '紫色' : '粉色';
  }

  const SEARCH_NOTE = '\n\n> 原型演示：搜索结果和来源都是模拟数据。';

  function plan({ text, images = [], webOn, webAvailable, serious }) {
    const now = new Date();
    const lead = (cute, plain) => (serious ? plain : cute);
    const t = text.trim();
    const short = t.length > 18 ? t.slice(0, 18) + '…' : t;

    if (/别闹|正经点|正常点|严肃点/.test(t)) {
      return { text: '好的，接下来我用正常语气回答。', serious: true, expr: 'idle', notice: '已切换为正常语气，新对话后恢复默认人设' };
    }
    if (/可以闹了|恢复人设|调皮一点/.test(t)) {
      return { text: '嘿嘿，我又回来啦～', serious: false, expr: 'wink' };
    }

    if (images.length) {
      const lines = images.map((im, i) => {
        const o = im.ow > im.oh * 1.15 ? '横图' : im.oh > im.ow * 1.15 ? '竖图' : '接近方形';
        return `- 第 ${i + 1} 张：${im.ow} × ${im.oh}，${o}，整体偏${colorName(im.color)}调${im.compressed ? '（发送前已压缩到长边 2048 px）' : ''}`;
      });
      return {
        text: `${lead('我看到啦～', '已收到图片。')}${images.length > 1 ? `一共 ${images.length} 张：` : ''}\n\n${lines.join('\n')}\n\n${t ? `你问的是「${short}」。` : ''}原型里我还看不懂图片的内容。接入真正的看图模型以后，这里会是针对图片的具体回答。`,
        expr: 'happy',
      };
    }

    if (TRIGGER.test(t)) {
      const r = parseReminder(t, now);
      if (r.ok) {
        return {
          text: lead(`好嘞～ 我帮你记下啦：**${r.when}** 提醒你${r.content}。${r.note || ''}确认一下没问题吧？`, `好的，${r.when} 提醒你${r.content}。${r.note || ''}请确认：`),
          card: { type: 'reminder', when: r.when, repeat: r.repeat, content: r.content, at: r.at || null, state: 'pending' },
          expr: 'happy',
        };
      }
      if (r.ambiguous) {
        const mk = p => ({ label: `${p} ${r.h} 点`, send: t.replace(r.clock, `${p}${r.clock}`) });
        return {
          text: lead(`是下午 ${r.h} 点，还是凌晨 ${r.h} 点呀？我可不想半夜把你叫醒～`, `请问是下午 ${r.h} 点还是凌晨 ${r.h} 点？`),
          chips: [mk('下午'), mk('凌晨')], expr: 'confused',
        };
      }
      if (r.dayPart && PART_CHOICES[r.dayPart]) {
        return {
          text: lead(`${r.prefix}${r.dayPart}几点提醒你呀？我怕猜错时间，你挑一个嘛～`, `请问${r.prefix}${r.dayPart}几点提醒你？`),
          chips: PART_CHOICES[r.dayPart].map(v => ({ label: clockLabel(v), send: `${r.prefix}${r.dayPart}${clockSay(r.dayPart, v)}提醒我${r.content}` })),
          expr: 'confused',
        };
      }
      const base = r.prefix || '';
      const opts = base ? [`${base}上午 9 点`, `${base}下午 3 点`] : ['10 分钟后', '30 分钟后', '下午 3 点'];
      return {
        text: lead(`要我什么时候提醒你「${r.content}」呀？说个时间嘛～`, `请问什么时候提醒你「${r.content}」？`),
        chips: opts.map(o => ({ label: o, send: `${o}提醒我${r.content}` })), expr: 'confused',
      };
    }

    if (/记住|我不(喝|吃|喜欢)|我(喜欢|讨厌|爱吃)|我的生日/.test(t)) {
      const content = t.replace(/^(请|麻烦)?(你)?(帮我)?记住[：:，,\s]*/, '').replace(/[。！!～~]+$/, '');
      return {
        text: lead('这个我想记下来，以后就不会忘啦～ 可以吗？', '需要我记住这条信息吗？'),
        card: { type: 'memory', content, state: 'pending' }, expr: 'coy',
      };
    }

    if (/累|好烦|烦死|难过|压力|不开心|崩溃|焦虑|郁闷|想哭/.test(t)) {
      return { text: '抱抱你。今天辛苦了……\n\n要不要先停下来喝口水，深呼吸几次？想说的话可以慢慢跟我讲，我一直在这儿。', expr: 'coy' };
    }

    if (/查|搜|新闻|最新|最近|多少钱|是哪天|什么时候|天气/.test(t)) {
      const q = t.replace(/^(帮我|请|麻烦)?(查一下|查查|查|搜一下|搜搜|搜索|搜)/, '').replace(/[？?。！!]+$/, '').trim() || t;
      const isSolstice = /冬至/.test(q);
      if (!(webOn && webAvailable)) {
        const why = !webAvailable ? '还没配置搜索服务' : '这次对话没开联网';
        return {
          text: `我现在不能联网查哦（${why}），下面是我已有的知识，可能不是最新的：\n\n` + (isSolstice
            ? '冬至一般在每年公历 12 月 21 日或 22 日。按天文算法推算，2026 年的冬至应该是 **12 月 22 日**，你最好再用日历核对一下。'
            : `关于「${q}」，我知道的内容可能已经过时。打开输入框下面的「联网」开关，我就能帮你查最新的资料。`),
          expr: 'sad',
        };
      }
      if (isSolstice) {
        return {
          search: q,
          text: `${lead('我帮你查到啦～', '查询结果如下：')}\n\n**2026 年冬至是 12 月 22 日（周二）**，交节时间在北京时间凌晨 4 点 50 分前后 [1]。\n\n- 冬至是二十四节气中的第 22 个，这一天北半球白昼最短、黑夜最长 [2]\n- 北方习俗吃饺子，南方不少地方吃汤圆 [2]\n- 民间有“冬至大如年”的说法，这天也是“数九”的第一天 [3]\n\n${lead('到时候我会提前一天提醒你吃饺子哦！', '')}${SEARCH_NOTE}`,
          sources: [
            { title: '2026 年二十四节气时间表', site: 'example.com', url: 'https://example.com/jieqi-2026' },
            { title: '冬至的天文意义与民间习俗', site: 'example.org', url: 'https://example.org/dongzhi' },
            { title: '“数九”是怎么算的', site: 'example.net', url: 'https://example.net/shujiu' },
          ],
          expr: 'happy',
        };
      }
      return {
        search: q,
        text: `${lead('我帮你搜了一圈～ 整理成要点啦：', '以下是搜索结果的要点：')}\n\n- 关于「${q}」，几个来源的说法基本一致 [1][2]\n- 有一个来源给出了不同的观点，建议结合你的具体情况判断 [3]\n- 想看细节的话，可以点下面的来源看原文${SEARCH_NOTE}`,
        sources: [
          { title: `${q}：常见问题汇总`, site: 'example.com', url: 'https://example.com/a' },
          { title: `一文看懂${q}`, site: 'example.org', url: 'https://example.org/b' },
          { title: `关于${q}的另一种看法`, site: 'example.net', url: 'https://example.net/c' },
        ],
        expr: 'happy',
      };
    }

    if (/代码|函数|code|bug|报错|正则|python|javascript|\b(js|ts)\b|写个|写一个/i.test(t)) {
      if (/节流|throttle/i.test(t) && !/防抖|debounce/i.test(t)) {
        return {
          text: `${lead('节流来啦～ 它是「隔一段时间最多执行一次」：', '节流（throttle）的一个实现：')}\n\n\`\`\`js\nfunction throttle(fn, wait = 300) {\n  let last = 0;\n  return function (...args) {\n    const now = Date.now();\n    if (now - last >= wait) {\n      last = now;\n      fn.apply(this, args);\n    }\n  };\n}\n\`\`\`\n\n适合滚动监听、拖拽这类高频事件。`,
          expr: 'wink',
        };
      }
      return {
        text: `${lead('嘿嘿，这个我会～ 防抖就是「等你停下来再执行」：', '防抖（debounce）的一个实现：')}\n\n\`\`\`js\nfunction debounce(fn, wait = 300) {\n  let timer = null;\n  return function (...args) {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn.apply(this, args), wait);\n  };\n}\n\n// 用法：停止输入 300ms 后才发请求\ninput.addEventListener('input', debounce(search, 300));\n\`\`\`\n\n| 对比 | 防抖 debounce | 节流 throttle |\n| --- | --- | --- |\n| 触发时机 | 停止触发后执行一次 | 固定间隔最多执行一次 |\n| 典型场景 | 搜索联想、窗口 resize | 滚动监听、拖拽 |\n\n${lead('要不要我再写一个节流版本？', '需要的话可以再给出节流版本。')}`,
        chips: [{ label: '再写个节流', send: '再写一个节流函数' }], expr: 'wink',
      };
    }

    if (/吃什么|外卖|午饭|晚饭|饿/.test(t)) {
      return {
        text: `${lead('饿啦？我帮你想想～', '几个建议：')}\n\n1. **热汤面**：天冷了，来碗热乎的最舒服\n2. **盖浇饭**：出餐快，不容易踩雷\n3. **轻食沙拉**：下午还想保持清醒的话\n\n${lead('选好了告诉我，我帮你记着别点重复啦～', '')}`,
        expr: 'happy',
      };
    }
    if (/谢谢|感谢|thx|thanks/i.test(t)) return { text: lead('不客气呀～ 能帮上你我就很开心啦。', '不客气。'), expr: 'happy' };
    if (/^(你好|您好|hi|hello|嗨|在吗|在不在)/i.test(t)) return { text: lead('在呢在呢～ 今天想让我帮你做点什么呀？', '你好，有什么可以帮你？'), expr: 'happy' };
    if (/你是谁|叫什么|你的名字/.test(t)) {
      return { text: '我是住在你屏幕角落的小派（名字还没定，先这么叫）。会提醒你喝水、休息，也能陪你聊天、查资料、看图～', expr: 'wink' };
    }
    if (/笑话|无聊|陪我/.test(t)) {
      return { text: '那我讲个程序员笑话：为什么程序员分不清万圣节和圣诞节？\n\n因为 `Oct 31 == Dec 25`。嘿嘿～', expr: 'wink' };
    }
    return {
      text: `${lead(pick(['嗯嗯，我在听～', '收到收到！', '好问题～']), '')}你说的是「${short}」对吧？\n\n这是原型里的模拟回复。接上真正的大模型以后，我会认真回答你的问题。现在可以试试让我**定提醒**、**查资料**、**写代码**，或者**发张图片**给我看。`,
      expr: 'happy',
    };
  }

  return { plan, parseReminder };
})();
