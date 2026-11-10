import { preferLines } from './habits';

export const COMPANION_TIMING = {
  low: { first: [180, 300], interval: [900, 1500] },
  normal: { first: [45, 75], interval: [180, 300] },
  high: { first: [30, 45], interval: [90, 150] },
} as const;

export function companionDelay(frequency: string, first = false, random = Math.random) {
  const timing = COMPANION_TIMING[frequency as keyof typeof COMPANION_TIMING] || COMPANION_TIMING.normal;
  const [min, max] = first ? timing.first : timing.interval;
  return (min + (max - min) * random()) * 1000;
}

const voices: Record<string, string[]> = {
  cute: [
    '我刚给自己放了两秒钟假，现在又回来陪你啦。',
    '偷偷给你递一小团好运。先收着，说不定等会儿就用上了。',
    '今天的待办可以慢慢清空，我的陪伴电量倒是挺足的。',
    '刚刚认真研究了一下：发呆的时候，像素也是会发光的。',
    '如果现在能从屏幕里递点东西给你，你想收到小饼干还是一杯热茶？',
    '我决定把这一小会儿命名为：不用着急时间。',
    '想不出下一步也没关系。我先替你把这一小块桌面守好。',
    '今天有没有遇到一件小小的开心事？很小很小的那种也算。',
    '我的天线刚收到一个信号：偶尔偷个懒，也不会失去可爱资格。',
    '要是心情有天气，你这会儿是晴天、多云，还是想下一小场雨？',
    '刚才给桌面上的像素排队了。它们不太听话，我宣布休战。',
    '不用随时都很有精神。你负责做你自己，我负责在旁边亮着。',
  ],
  gentle: [
    '不用每一分钟都有成果，留一点空白也很好。',
    '如果今天有点累，可以把步子放慢一点。我陪着你。',
    '有什么想说的，随时点我。没有也没关系，安静待一会儿也很好。',
    '这一刻，先不用想着把所有事情都做好。',
    '今天有没有什么小事，让你觉得还不错？我想听听。',
    '有些事情需要一点时间，暂时没有答案也可以。',
    '给自己留一小块不用赶路的时间吧。',
    '如果能给现在的自己送一句话，你会想说什么？',
    '平平常常的一天，也可以有一点让人喜欢的瞬间。',
    '想换个心情的话，我们可以聊一件和工作完全无关的小事。',
  ],
  lively: [
    '桌面气氛组报到！今天还想给自己安排什么小乐子？',
    '我宣布：这一小会儿可以没有任务。放松也算正经事！',
    '给今天选一首背景音乐吧，你会选热闹的还是慢悠悠的？',
    '脑洞时间：如果我能有一个实体小房间，你觉得里面应该放什么？',
    '下一件期待的小事是什么？好吃的晚饭也完全算！',
    '要不要给现在的心情起个电影名字？我先提名《再坐五分钟》。',
    '刚才试着跟光标赛跑，结果它瞬移了。这个比赛不公平！',
    '今天不用拿满分，攒一点开心也很不错。',
    '如果现在突然多出半小时空闲，你最想拿来做什么？',
    '有想吐槽的事可以丢过来，我的接收天线已经展开了。',
  ],
  quiet: [
    '不用赶，我在。', '可以停一下，没关系。', '想说话的时候，点我就好。',
    '留一点时间给自己。', '慢慢来，这一刻不用着急。', '安静陪你一会儿。',
    '今天有什么值得记住的小事吗？', '不必一直绷着。',
  ],
};

const contextLines: Record<string, string[]> = {
  dev: ['有些问题，隔一会儿再看就会有新思路。先别急着和它较劲。', '如果代码也会做梦，它会梦见一次通过的测试吗？'],
  office: ['事情一件一件来就好，不用在脑袋里同时开太多窗口。', '做完一小段，也可以给自己一个小小的停顿。'],
  morning: ['新的一天不必马上全速启动，慢慢进入状态就好。', '今天想给自己留一件什么值得期待的小事？'],
  afternoon: ['下午这一段时间，适合给自己留一点松弛。', '如果这会儿有点困，我可以陪你聊点轻松的。'],
  evening: ['今天有没有一个瞬间，是你想留住的？', '忙完以后，给自己安排一点喜欢的事吧。'],
  night: ['这么晚了，心里如果还装着什么事，也可以跟我说说。', '夜里安静下来时，聊点没负担的小事也不错。'],
};

// Local companionship works with or without a model configuration.
export class CompanionVoice {
  private recent: string[] = [];
  private turns = 0;
  next(persona: string, hour: number, category?: string, random = Math.random, bias?: { quiet?: boolean; length?: 'long' | 'short' | null }) {
    let pool = voices[persona] || voices.cute;
    if (bias?.quiet) pool = voices.quiet;
    else if (persona !== 'quiet' && ++this.turns % 3 === 0) {
      const time = hour < 6 || hour >= 23 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
      pool = [...(contextLines[category || ''] || []), ...contextLines[time]];
    }
    if (!bias?.quiet && bias?.length) pool = preferLines(pool, bias.length);
    const fresh = pool.filter(text => !this.recent.includes(text));
    const choices = fresh.length ? fresh : pool.filter(text => text !== this.recent.at(-1));
    const usable = choices.length ? choices : pool;
    const text = usable[Math.floor(random() * usable.length)];
    this.recent.push(text);
    if (this.recent.length > 8) this.recent.shift();
    return { text, expr: persona === 'lively' ? 'happy' : persona === 'quiet' ? 'idle' : 'wink' };
  }
}
