import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { ApiError } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { CreateCustomerDto } from '@/customers/dto/create-customer.dto';
import { QueryCustomersDto } from '@/customers/dto/query-customers.dto';
import { UpdateCustomerDto } from '@/customers/dto/update-customer.dto';
import { CustomersService } from '@/customers/customers.service';
import { QueryPaymentIntentsDto } from '@/payment-intents/dto/query-payment-intents.dto';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { PluginViolationError } from '@/plugins/plugin-errors';
import {
  PLUGIN_CORE_ID_RE,
  PLUGIN_MAX_PAGE_SIZE,
} from '@/plugins/plugins.constants';
import { CreateProductDto } from '@/products/dto/create-product.dto';
import { QueryProductsDto } from '@/products/dto/query-products.dto';
import { UpdateProductDto } from '@/products/dto/update-product.dto';
import { ProductsService } from '@/products/products.service';
import {
  PluginError,
  type PluginCapability,
  type PluginCoreApi,
  type PluginCustomer,
  type PluginPage,
  type PluginPaymentIntent,
  type PluginProduct,
} from '@/plugins/sdk';

/** The fields of a core row a plugin is shown. Anything not listed never leaves. */
const CUSTOMER_FIELDS = [
  'id',
  'name',
  'alias',
  'email',
  'account',
  'note',
  'reference',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof PluginCustomer)[];

const PRODUCT_FIELDS = [
  'id',
  'name',
  'description',
  'amount',
  'asset',
  'kind',
  'active',
  'reference',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof PluginProduct)[];

/**
 * No `xdr`, `uri`, `msg` or `callback`: a plugin reads what was paid, not the
 * artifacts a wallet signs.
 */
const PAYMENT_INTENT_FIELDS = [
  'id',
  'kind',
  'status',
  'source',
  'destination',
  'amount',
  'asset',
  'assetIssuer',
  'memo',
  'network',
  'txHash',
  'reference',
  'expiresAt',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof PluginPaymentIntent)[];

/**
 * The only way plugin code reaches the core's data.
 *
 * It holds no Prisma handle. Every method goes through the service that owns
 * the table — the same method the core's own controller calls, with the same
 * tenant filter (the calling consumer, which the plugin never supplies) and the
 * same DTO validation the HTTP pipe would apply. So a plugin can do nothing to a
 * customer that the tenant's own API key could not, and less: there is no
 * delete, no payment-intent write, nothing that signs or moves money.
 *
 * Reads come back as a fixed projection, round-tripped through JSON and frozen,
 * so a plugin holds a copy it cannot use to reach back into a Prisma object.
 */
@Injectable()
export class PluginCoreAccessService {
  constructor(
    private readonly customers: CustomersService,
    private readonly products: ProductsService,
    private readonly paymentIntents: PaymentIntentsService,
  ) {}

  forConsumer(
    consumer: GatewayConsumer,
    granted: ReadonlySet<PluginCapability>,
    slug: string,
  ): PluginCoreApi {
    const need = (capability: PluginCapability): void => {
      if (!granted.has(capability)) {
        throw new PluginViolationError(
          `Plugin ${slug} used "${capability}", which it was not granted`,
        );
      }
    };

    return {
      customers: {
        list: async (query) => {
          need('customers:read');
          const dto = await toDto(QueryCustomersDto, pageQuery(query));
          const page = await this.customers.findAll(consumer, dto);
          return toPage(page, CUSTOMER_FIELDS);
        },
        get: async (id) => {
          need('customers:read');
          assertId(id);
          return orNull(async () =>
            pick(await this.customers.findOne(consumer, id), CUSTOMER_FIELDS),
          );
        },
        create: async (input) => {
          need('customers:write');
          const dto = await toDto(CreateCustomerDto, input);
          return pick(
            await this.customers.create(consumer, dto),
            CUSTOMER_FIELDS,
          );
        },
        update: async (id, input) => {
          need('customers:write');
          assertId(id);
          const dto = await toDto(UpdateCustomerDto, input);
          return pick(
            await notFoundAsRejection(() =>
              this.customers.update(consumer, id, dto),
            ),
            CUSTOMER_FIELDS,
          );
        },
      },
      products: {
        list: async (query) => {
          need('products:read');
          const dto = await toDto(QueryProductsDto, pageQuery(query));
          const page = await this.products.findAll(consumer, dto);
          return toPage(page, PRODUCT_FIELDS);
        },
        get: async (id) => {
          need('products:read');
          assertId(id);
          return orNull(async () =>
            pick(await this.products.findOne(consumer, id), PRODUCT_FIELDS),
          );
        },
        create: async (input) => {
          need('products:write');
          const dto = await toDto(CreateProductDto, input);
          return pick(
            await this.products.create(consumer, dto),
            PRODUCT_FIELDS,
          );
        },
        update: async (id, input) => {
          need('products:write');
          assertId(id);
          const dto = await toDto(UpdateProductDto, input);
          return pick(
            await notFoundAsRejection(() =>
              this.products.update(consumer, id, dto),
            ),
            PRODUCT_FIELDS,
          );
        },
      },
      paymentIntents: {
        list: async (query) => {
          need('payment_intents:read');
          const dto = await toDto(QueryPaymentIntentsDto, {
            ...pageQuery(query),
            ...(query?.status !== undefined ? { status: query.status } : {}),
          });
          const page = await this.paymentIntents.findAll(consumer, dto);
          return toPage(page, PAYMENT_INTENT_FIELDS);
        },
        get: async (id) => {
          need('payment_intents:read');
          assertId(id);
          return orNull(async () =>
            pick(
              await this.paymentIntents.findOne(consumer, id),
              PAYMENT_INTENT_FIELDS,
            ),
          );
        },
      },
    };
  }
}

/**
 * The fields a plugin sees of a payment intent, from a row or an event payload.
 * Exported for the event bridge, which hands plugins the same shape `get` does.
 */
export function projectPaymentIntent(row: unknown): PluginPaymentIntent {
  return pick(row, PAYMENT_INTENT_FIELDS);
}

function pageQuery(query: { take?: number; skip?: number } | undefined): {
  take: number;
  skip: number;
} {
  return {
    take: query?.take ?? PLUGIN_MAX_PAGE_SIZE,
    skip: query?.skip ?? 0,
  };
}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !PLUGIN_CORE_ID_RE.test(id)) {
    throw new PluginError('id must be a core resource id');
  }
}

/**
 * The core's own DTO, validated the way the global `ValidationPipe` validates a
 * request body: unknown fields are refused, not dropped.
 */
async function toDto<T extends object>(
  cls: new () => T,
  input: unknown,
): Promise<T> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new PluginError('input must be an object');
  }
  const dto = plainToInstance(cls, JSON.parse(JSON.stringify(input)) as object);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (errors.length > 0) {
    throw new PluginError(flattenErrors(errors).join('; '));
  }
  return dto;
}

function flattenErrors(errors: ValidationError[]): string[] {
  return errors.flatMap((e) => [
    ...Object.values(e.constraints ?? {}),
    ...flattenErrors(e.children ?? []),
  ]);
}

/** A detached, frozen copy of only the listed fields. */
function pick<T, K extends readonly string[]>(row: unknown, fields: K): T {
  const source = JSON.parse(JSON.stringify(row ?? {})) as Record<
    string,
    unknown
  >;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    out[field] = source[field] ?? null;
  }
  return Object.freeze(out) as T;
}

function toPage<T>(
  page: { data: unknown[]; total: number; take: number; skip: number },
  fields: readonly string[],
): PluginPage<T> {
  return Object.freeze({
    data: Object.freeze(
      page.data.map((row) => pick<T, typeof fields>(row, fields)),
    ),
    total: page.total,
    take: page.take,
    skip: page.skip,
  }) as PluginPage<T>;
}

/** A 404 from the owning service is "not there" to a plugin, not a crash. */
async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof ApiError && err.getStatus() === 404) {
      return null;
    }
    throw err;
  }
}

/** Updating a row the tenant does not have is a refusal the caller can act on. */
async function notFoundAsRejection<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (err instanceof ApiError && err.getStatus() === 404) {
      throw new PluginError(err.message);
    }
    throw err;
  }
}
