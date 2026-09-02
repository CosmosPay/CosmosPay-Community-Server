import { Injectable } from '@nestjs/common';
import {
  assertPublicWebhookUrl,
  DEFAULT_DNS_LOOKUP,
  DnsLookupFn,
  ValidatedWebhookDestination,
} from '@/webhooks/webhook-url.validator';

/**
 * Shared destination checks for webhook URL registration and outbound delivery.
 * DNS lookup is swappable so unit tests can simulate rebinding between register
 * and deliver without touching the network.
 */
@Injectable()
export class WebhookDestinationGuard {
  private lookup: DnsLookupFn = DEFAULT_DNS_LOOKUP;

  /** Test seam: replace the DNS resolver (e.g. public → private flip). */
  replaceDnsLookup(lookup: DnsLookupFn): void {
    this.lookup = lookup;
  }

  /**
   * Returns the validated destination. Delivery must connect to its `address`:
   * re-resolving the hostname reopens the rebinding window this check closes.
   */
  async assertSafe(url: string): Promise<ValidatedWebhookDestination> {
    return assertPublicWebhookUrl(url, this.lookup);
  }
}
