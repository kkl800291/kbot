import { describe, expect, it } from 'vitest';
import { normalizeExpression, VALID_EXPRESSIONS } from '../src/services/agent';
import { addressName, normalizePersona, personaHint, personaVoiceStyle } from '../src/services/persona';
import { speechPlan } from '../src/services/voice';

describe('butler persona', () => {
  it('keeps the four persona keys and folds the three legacy keys into them', () => {
    expect(['cute', 'gentle', 'lively', 'quiet'].map(normalizePersona)).toEqual(['cute', 'gentle', 'lively', 'quiet']);
    expect(normalizePersona('calm')).toBe('cute');
    expect(normalizePersona('witty')).toBe('lively');
    expect(normalizePersona('warm')).toBe('gentle');
    expect(normalizePersona(undefined)).toBe('cute');
    expect(normalizePersona('unknown')).toBe('cute');

    expect(personaHint('cute')).toMatch(/^从容/);
    expect(personaHint('gentle')).toMatch(/^温和/);
    expect(personaHint('lively')).toMatch(/^机敏/);
    expect(personaHint('quiet')).toMatch(/^简洁/);
    expect(personaHint('calm')).toBe(personaHint('cute'));
    expect(personaHint('witty')).toBe(personaHint('lively'));
    expect(personaHint('warm')).toBe(personaHint('gentle'));
  });

  it('reads replies in a butler tone that follows the persona', () => {
    const S = { persona: 'witty', voice: { enabled: true, hasKey: true, style: '' } };
    expect(speechPlan(S, '好的。').mimo?.style).toBe(personaVoiceStyle('lively'));
    expect(personaVoiceStyle('quiet')).toContain('管家');
  });

  it('addresses the user as 您 unless a nickname is set', () => {
    expect(addressName('')).toBe('');
    expect(addressName(undefined)).toBe('');
    expect(addressName('你')).toBe('');
    expect(addressName('您')).toBe('');
    expect(addressName(' 老板 ')).toBe('老板');
  });

  it('drops wink and coy from the tag list but still maps them to happy', () => {
    expect(VALID_EXPRESSIONS.has('wink')).toBe(false);
    expect(VALID_EXPRESSIONS.has('coy')).toBe(false);
    expect(normalizeExpression('WINK')).toBe('happy');
    expect(normalizeExpression('coy')).toBe('happy');
    expect(normalizeExpression('annoyed')).toBe('annoyed');
    expect(normalizeExpression('note')).toBeNull();
  });
});
