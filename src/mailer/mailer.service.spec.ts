import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import { RESEND_ENDPOINT } from '@/mailer/mailer.constants';
import { MailerService } from '@/mailer/mailer.service';

const MSG = {
  to: 'ada@example.com',
  subject: 's',
  html: '<p>h</p>',
  text: 't',
};

const NO_SMTP = { host: '', port: 587, secure: false, user: '', pass: '' };

function makeService(mail: Partial<AppConfig['mail']> = {}) {
  const config = {
    get: jest.fn().mockReturnValue({
      resendApiKey: 're_key',
      smtp: NO_SMTP,
      from: 'Cosmos <wallet@example.com>',
      timeoutMs: 1000,
      ...mail,
    }),
  } as unknown as ConfigService<AppConfig, true>;
  const transport = { sendMail: jest.fn().mockResolvedValue({}) };
  const factory = jest.fn().mockReturnValue(transport);
  return { service: new MailerService(config, factory), transport, factory };
}

describe('MailerService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is configured with a sender and either transport', () => {
    expect(makeService().service.configured).toBe(true);
    expect(
      makeService({
        resendApiKey: '',
        smtp: { ...NO_SMTP, host: 'smtp.example.com' },
      }).service.configured,
    ).toBe(true);
    expect(makeService({ resendApiKey: '' }).service.configured).toBe(false);
    expect(makeService({ from: '' }).service.configured).toBe(false);
  });

  it('sends through Resend with the configured sender', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    await makeService().service.send(MSG);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(RESEND_ENDPOINT);
    expect(init.headers.authorization).toBe('Bearer re_key');
    expect(JSON.parse(init.body)).toMatchObject({
      from: 'Cosmos <wallet@example.com>',
      to: ['ada@example.com'],
      subject: 's',
    });
  });

  it('prefers Resend when both transports are set', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const { service, factory } = makeService({
      smtp: { ...NO_SMTP, host: 'smtp.example.com' },
    });
    await service.send(MSG);
    expect(factory).not.toHaveBeenCalled();
  });

  it('sends through SMTP when there is no Resend key, reusing one transport', async () => {
    global.fetch = jest.fn();
    const smtp = {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'u',
      pass: 'p',
    };
    const { service, transport, factory } = makeService({
      resendApiKey: '',
      smtp,
    });

    await service.send(MSG);
    await service.send(MSG);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({ ...smtp, timeoutMs: 1000 });
    expect(transport.sendMail).toHaveBeenCalledWith({
      from: 'Cosmos <wallet@example.com>',
      ...MSG,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws a generic error, never the provider detail', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('domain example.com is not verified'),
    });
    await expect(makeService().service.send(MSG)).rejects.toThrow(
      /^The email could not be sent\.$/,
    );

    const { service, transport } = makeService({
      resendApiKey: '',
      smtp: { ...NO_SMTP, host: 'smtp.example.com' },
    });
    transport.sendMail.mockRejectedValue(new Error('535 auth failed for u'));
    await expect(service.send(MSG)).rejects.toThrow(
      /^The email could not be sent\.$/,
    );
  });

  it('refuses to send when unconfigured, without a network call', async () => {
    global.fetch = jest.fn();
    const { service, factory } = makeService({ resendApiKey: '' });
    await expect(service.send(MSG)).rejects.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });
});
