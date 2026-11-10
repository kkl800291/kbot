import { expect, it } from 'vitest';
import { CompanionVoice } from '../src/services/companionship';

const QUIET = [
  '不用赶，我在。', '可以停一下，没关系。', '想说话的时候，点我就好。',
  '留一点时间给自己。', '慢慢来，这一刻不用着急。', '安静陪你一会儿。',
  '今天有什么值得记住的小事吗？', '不必一直绷着。',
];

it.each(['cute', 'gentle', 'lively', 'quiet'])('varies %s companionship without repeating consecutive lines', persona => {
  const voice = new CompanionVoice(), lines: string[] = [];
  for (let i = 0; i < 40; i++) {
    const { text } = voice.next(persona, 16, 'dev', () => 0);
    expect(text).toBeTruthy(); expect(text).not.toBe(lines.at(-1));
    lines.push(text);
  }
  expect(new Set(lines.slice(0, 6)).size).toBe(6);
});

it('draws night companionship from the quiet pool and otherwise prefers the requested length half', () => {
  const nightly = new CompanionVoice();
  expect(QUIET).toContain(nightly.next('lively', 23, undefined, () => 0.2, { quiet: true }).text);
  const plain = new CompanionVoice();
  const biased = new CompanionVoice();
  const full = plain.next('cute', 15, undefined, () => 0.99).text;
  const shortened = biased.next('cute', 15, undefined, () => 0.99, { length: 'short' }).text;
  expect(shortened.length).toBeLessThan(full.length);
});
