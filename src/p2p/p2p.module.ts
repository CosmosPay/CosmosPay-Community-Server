import { Module } from '@nestjs/common';
import { AdminModule } from '@/admin/admin.module';
import { P2pAccountsController } from '@/p2p/p2p-accounts.controller';
import { P2pAccountsService } from '@/p2p/p2p-accounts.service';
import { P2pAdminController } from '@/p2p/p2p-admin.controller';
import { P2pAdminService } from '@/p2p/p2p-admin.service';
import { P2pChainClient } from '@/p2p/p2p-chain.client';
import { P2pChargesController } from '@/p2p/p2p-charges.controller';
import { P2pChargesService } from '@/p2p/p2p-charges.service';
import { P2pCheckoutController } from '@/p2p/p2p-checkout.controller';
import { P2pCheckoutService } from '@/p2p/p2p-checkout.service';
import { P2pDataCipher } from '@/p2p/p2p-data-cipher';
import { P2pExpiryService } from '@/p2p/p2p-expiry.service';
import { P2pIndexerService } from '@/p2p/p2p-indexer.service';
import { P2pMarketController } from '@/p2p/p2p-market.controller';
import { P2pMarketReader } from '@/p2p/p2p-market-reader.service';
import { P2pMarketService } from '@/p2p/p2p-market.service';
import { P2pMatcherFollowerService } from '@/p2p/p2p-matcher-follower.service';
import { P2pMatcherService } from '@/p2p/p2p-matcher.service';
import { P2pNetworksService } from '@/p2p/p2p-networks.service';
import { P2pOffersController } from '@/p2p/p2p-offers.controller';
import { P2pOffersService } from '@/p2p/p2p-offers.service';
import { P2pOrderOpener } from '@/p2p/p2p-order-opener.service';
import { P2pOrdersController } from '@/p2p/p2p-orders.controller';
import { P2pOrdersService } from '@/p2p/p2p-orders.service';
import { P2pPaymentMethodsService } from '@/p2p/p2p-payment-methods.service';
import { P2pPayoutsService } from '@/p2p/p2p-payouts.service';
import { P2pQuotesService } from '@/p2p/p2p-quotes.service';
import { P2pTransactionsService } from '@/p2p/p2p-transactions.service';
import { P2pTransferMatchesService } from '@/p2p/p2p-transfer-matches.service';
import { P2pWebhooks } from '@/p2p/p2p-webhooks.service';

/**
 * The P2P market: stablecoins traded for local money between people and
 * merchants, locked in Cosmos Pay's own `contracts/P2PMarket.sol` on the EVM
 * networks it is deployed on. The client's and the merchant's routes under
 * `/v1/p2p`, the payer's keyless ones under `/v1/p2p-checkout`, the platform's
 * under `/v1/admin/p2p`; three jobs follow the chain (indexer, expiry, matcher
 * follower). Off on a tier until `P2P_MARKET_CONTRACTS_*` names a deployment.
 *
 * `WebhookTerminalEmitter` and `ConsumerResolverService` come from the global
 * webhooks and common modules; `AdminModule` lends its guard, interceptor and
 * audit trail.
 */
@Module({
  imports: [AdminModule],
  controllers: [
    P2pMarketController,
    P2pAccountsController,
    P2pOffersController,
    P2pOrdersController,
    P2pChargesController,
    P2pCheckoutController,
    P2pAdminController,
  ],
  providers: [
    P2pNetworksService,
    P2pChainClient,
    P2pMarketReader,
    P2pDataCipher,
    P2pMatcherService,
    P2pWebhooks,
    P2pAccountsService,
    P2pPaymentMethodsService,
    P2pOffersService,
    P2pQuotesService,
    P2pOrderOpener,
    P2pOrdersService,
    P2pTransactionsService,
    P2pTransferMatchesService,
    P2pChargesService,
    P2pCheckoutService,
    P2pPayoutsService,
    P2pMarketService,
    P2pAdminService,
    P2pIndexerService,
    P2pExpiryService,
    P2pMatcherFollowerService,
  ],
})
export class P2pModule {}
