// Explicit synthetic entry for an independently owned, hidden test composition.
// Ordinary configurations cannot admit test providers through their options.
import { constructDesktopPersistenceConfiguration } from './configuration.mjs';

export const createTestDesktopPersistenceConfiguration = (options, { fault } = {}) =>
  constructDesktopPersistenceConfiguration(options, { allowTestProvider: true, ...(fault === undefined ? {} : { fault }) });
