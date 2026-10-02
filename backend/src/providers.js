export class ProviderUnavailableError extends Error {
  constructor(channel) {
    super(`No ${channel} provider adapter is configured.`);
    this.name = 'ProviderUnavailableError';
    this.status = 503;
    this.code = 'PROVIDER_NOT_CONFIGURED';
  }
}

export class CommunicationRegistry {
  constructor(adapters = {}) {
    this.adapters = new Map(Object.entries(adapters));
  }

  register(providerName, adapter) {
    if (!adapter || typeof adapter.send !== 'function') throw new TypeError('Communication adapters must implement send().');
    this.adapters.set(providerName, adapter);
  }

  get(providerName) {
    return this.adapters.get(providerName) ?? null;
  }
}

export class CallingRegistry {
  constructor(adapters = {}) {
    this.adapters = new Map(Object.entries(adapters));
  }

  register(providerName, adapter) {
    if (!adapter || typeof adapter.startCall !== 'function') throw new TypeError('Calling adapters must implement startCall().');
    this.adapters.set(providerName, adapter);
  }

  get(providerName) {
    return this.adapters.get(providerName) ?? null;
  }
}

// Integrators inject concrete providers at startup. No provider account or subscription
// is assumed by Core, and the default registries intentionally contain no send-capable adapter.
export const communications = new CommunicationRegistry();
export const calling = new CallingRegistry();

