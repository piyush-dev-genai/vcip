import { Inject } from '@nestjs/common';

/** Injection token for the application Redis client (D2 db 0). */
export const REDIS = Symbol('REDIS');

export const InjectRedis = (): ParameterDecorator => Inject(REDIS);
