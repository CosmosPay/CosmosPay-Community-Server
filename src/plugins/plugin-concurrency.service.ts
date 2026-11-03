import { Injectable } from '@nestjs/common';
import { ConcurrencyLimiter } from '@/plugins/concurrency-limiter';
import {
  PLUGIN_MAX_CONCURRENT_INVOCATIONS,
  PLUGIN_MAX_CONCURRENT_INVOCATIONS_PER_CONSUMER,
} from '@/plugins/plugins.constants';

/** Gives a slot back. Calling it twice gives it back once. */
export type PluginSlotRelease = () => void;

/**
 * How many plugin invocations run at once, in this process.
 *
 * The per-minute budget on the action routes bounds how many calls a consumer
 * starts, not how many overlap: a plugin that takes its full 10 s turns 120 calls
 * a minute into 20 isolates at once, per tenant. Every invocation holds an
 * isolate (heap, thread), so overlap is what exhausts memory. An action takes a
 * slot of its consumer's and one of the process's, and is refused when either
 * is full; an event waits for a process slot instead, because nobody is there
 * to retry it.
 */
@Injectable()
export class PluginConcurrencyService {
  private readonly process = new ConcurrencyLimiter(
    PLUGIN_MAX_CONCURRENT_INVOCATIONS,
  );
  private readonly byConsumer = new Map<string, number>();

  /** A slot for one action of `consumer`, or null when none is free. */
  tryEnterAction(consumer: string): PluginSlotRelease | null {
    const held = this.byConsumer.get(consumer) ?? 0;
    if (held >= PLUGIN_MAX_CONCURRENT_INVOCATIONS_PER_CONSUMER) return null;
    if (!this.process.tryAcquire()) return null;
    this.byConsumer.set(consumer, held + 1);
    return once(() => {
      const left = (this.byConsumer.get(consumer) ?? 1) - 1;
      if (left > 0) this.byConsumer.set(consumer, left);
      else this.byConsumer.delete(consumer);
      this.process.release();
    });
  }

  /** A slot for one event delivery, waiting for one when all are taken. */
  async enterEvent(): Promise<PluginSlotRelease> {
    await this.process.acquire();
    return once(() => this.process.release());
  }

  /** Invocations holding a slot right now. */
  get inFlight(): number {
    return this.process.inFlight;
  }
}

function once(release: () => void): PluginSlotRelease {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
  };
}
