import { Inject } from '@nestjs/common';

/** Injection token for the application logger. */
export const LOGGER = Symbol('LOGGER');

export const InjectLogger = (): ParameterDecorator => Inject(LOGGER);
