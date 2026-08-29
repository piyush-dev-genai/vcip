import { Inject } from '@nestjs/common';

/** Injection token for the Drizzle database handle. */
export const DATABASE = Symbol('DATABASE');

export const InjectDatabase = (): ParameterDecorator => Inject(DATABASE);
