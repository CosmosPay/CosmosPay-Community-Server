import { PluginEventBridge } from '@/plugins/plugin-event-bridge.service';
import { WebhookEventPayload } from '@/webhooks/webhook-events';

describe('PluginEventBridge', () => {
  function build() {
    const runtime = { dispatchEvent: jest.fn().mockResolvedValue(undefined) };
    return { bridge: new PluginEventBridge(runtime as any), runtime };
  }

  it('forwards the payment intent events plugins may subscribe to', async () => {
    const { bridge, runtime } = build();
    const data = { id: 'pi_1' };

    await bridge.handle(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_SUCCEEDED', data),
    );

    expect(runtime.dispatchEvent).toHaveBeenCalledWith(
      'cosmos_u1',
      'PAYMENT_INTENT_SUCCEEDED',
      data,
    );
  });

  it('never forwards an event outside the SDK list', async () => {
    const { bridge, runtime } = build();
    await bridge.handle(
      new WebhookEventPayload('cosmos_u1', 'RECEIVER_UPDATED', { kyc: 'x' }),
    );
    expect(runtime.dispatchEvent).not.toHaveBeenCalled();
  });

  it('does not let a failure escape onto the event bus', async () => {
    const { bridge, runtime } = build();
    runtime.dispatchEvent.mockRejectedValue(new Error('db down'));
    await expect(
      bridge.handle(
        new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {}),
      ),
    ).resolves.toBeUndefined();
  });
});
