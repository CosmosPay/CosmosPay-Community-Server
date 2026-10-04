import {
  minutesUntil,
  renderLoginCodeEmail,
  renderRecoveryCodeEmail,
} from '@/mailer/wallet-emails';

describe('wallet emails', () => {
  it('puts the code in the body and never in the subject', () => {
    const msg = renderLoginCodeEmail({
      name: 'Ada',
      code: '123456',
      minutes: 10,
    });
    expect(msg.subject).not.toContain('123456');
    expect(msg.html).toContain('123456');
    expect(msg.text).toContain('123456');
    expect(msg.text).toContain('10 minutes');
  });

  it('escapes the display name, which the person chose', () => {
    const msg = renderLoginCodeEmail({
      name: '<script>alert(1)</script>',
      code: '123456',
      minutes: 10,
    });
    expect(msg.html).not.toContain('<script>');
    expect(msg.html).toContain('&lt;script&gt;');
  });

  it('names which recovery server a code came from', () => {
    const a = renderRecoveryCodeEmail({
      role: 'a',
      code: '111111',
      minutes: 5,
    });
    const b = renderRecoveryCodeEmail({
      role: 'b',
      code: '222222',
      minutes: 5,
    });
    expect(a.subject).toContain('server A');
    expect(b.subject).toContain('server B');
    expect(a.subject).not.toContain('111111');
    expect(b.html).toContain('222222');
  });

  it('quotes at least one minute, rounded', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(minutesUntil(new Date(now + 10 * 60_000), now)).toBe(10);
    expect(minutesUntil(new Date(now - 60_000), now)).toBe(1);
    expect(minutesUntil(new Date(Number.NaN), now)).toBe(15);
  });
});
