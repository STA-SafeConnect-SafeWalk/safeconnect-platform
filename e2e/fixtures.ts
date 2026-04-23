import { test as base, APIRequestContext } from '@playwright/test';

interface WebhookCall {
  url: string;
  body: any;
  headers: Record<string, string>;
}

interface ServerControls {
  resetDB: () => Promise<void>;
  getWebhookCalls: () => Promise<WebhookCall[]>;
  clearWebhookCalls: () => Promise<void>;
}

type Fixtures = {
  api: APIRequestContext;
  server: ServerControls;
};

export const test = base.extend<Fixtures>({
  api: async ({ playwright }, use) => {
    const baseURL = process.env.E2E_BASE_URL;
    if (!baseURL) throw new Error('E2E_BASE_URL not set — is globalSetup running?');

    const ctx = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { 'Content-Type': 'application/json' },
    });
    await use(ctx);
    await ctx.dispose();
  },

  server: async ({ api }, use) => {
    // Reset before each test
    await api.post('/__reset');

    const controls: ServerControls = {
      resetDB: async () => { await api.post('/__reset'); },
      getWebhookCalls: async () => {
        const res = await api.get('/__webhooks');
        return await res.json();
      },
      clearWebhookCalls: async () => { await api.delete('/__webhooks'); },
    };

    await use(controls);
  },
});

export { expect } from '@playwright/test';
