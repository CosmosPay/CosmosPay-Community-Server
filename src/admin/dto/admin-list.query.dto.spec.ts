import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  ADMIN_DEFAULT_PAGE_SIZE,
  ADMIN_MAX_PAGE_SIZE,
} from '@/admin/admin.constants';
import {
  AdminChainSwapsQueryDto,
  AdminConsumerListQueryDto,
  AdminCrossChainSwapsQueryDto,
  AdminPageQueryDto,
  AdminPaymentIntentsQueryDto,
  AdminSwapsQueryDto,
} from '@/admin/dto/admin-list.query.dto';

/** The pipe `main.ts` installs globally; a query string arrives as strings. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const run = (metatype: any, value: Record<string, string | undefined>) =>
  pipe.transform(value, { type: 'query', metatype, data: '' });

describe('Admin list query DTOs', () => {
  it('defaults to the admin page when take/skip are absent', async () => {
    await expect(run(AdminPageQueryDto, {})).resolves.toEqual(
      expect.objectContaining({ take: ADMIN_DEFAULT_PAGE_SIZE, skip: 0 }),
    );
  });

  it('accepts the maximum page the console asks for', async () => {
    await expect(
      run(AdminConsumerListQueryDto, {
        take: String(ADMIN_MAX_PAGE_SIZE),
        skip: '40',
        consumer: 'c1',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        take: ADMIN_MAX_PAGE_SIZE,
        skip: 40,
        consumer: 'c1',
      }),
    );
  });

  it.each([
    { take: String(ADMIN_MAX_PAGE_SIZE + 1) },
    { take: '0' },
    { take: '-5' },
    { take: '1.5' },
    { take: 'ten' },
    { skip: '-1' },
    { skip: 'abc' },
  ])('refuses %j', async (query) => {
    await expect(run(AdminPageQueryDto, query)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each([
    ['payment intents', AdminPaymentIntentsQueryDto, 'SUBMITTED'],
    ['swaps', AdminSwapsQueryDto, 'PENDING'],
    ['chain swaps', AdminChainSwapsQueryDto, 'SUCCEEDED'],
    ['cross-chain swaps', AdminCrossChainSwapsQueryDto, 'AWAITING_DEPOSIT'],
  ] as const)('%s accept their own status %s', async (_name, dto, status) => {
    await expect(run(dto, { status })).resolves.toEqual(
      expect.objectContaining({ status }),
    );
  });

  it.each([
    ['payment intents', AdminPaymentIntentsQueryDto, 'BANANA'],
    ['swaps', AdminSwapsQueryDto, 'succeeded'],
    // Another resource's status is as foreign to a column as a typo.
    ['chain swaps', AdminChainSwapsQueryDto, 'AWAITING_DEPOSIT'],
    ['cross-chain swaps', AdminCrossChainSwapsQueryDto, 'CANCELLED'],
  ] as const)('%s refuse status %s', async (_name, dto, status) => {
    await expect(run(dto, { status })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
