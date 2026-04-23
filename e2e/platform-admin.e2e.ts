import { test, expect } from './fixtures';

test.describe('Platform Admin API', () => {
  test('create platform → get → list → update → regenerate keys', async ({ api }) => {
    // 1. Create a new platform
    const createRes = await api.post('/admin/platforms', {
      data: {
        platformName: 'E2E Test Platform',
        redirectUrl: 'https://e2e.example.com/callback',
        contactName: 'E2E Admin',
        contactEmail: 'admin@e2e.example.com',
        webhookUrl: 'https://e2e.example.com/webhook',
        description: 'Created by Playwright E2E test',
      },
    });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json();
    expect(created.success).toBe(true);
    expect(created.data.platformId).toBeTruthy();
    expect(created.data.apiKey).toMatch(/^sw_/);
    expect(created.data.webhookSecret).toMatch(/^swsec_/);
    expect(created.data.status).toBe('ACTIVE');

    const platformId = created.data.platformId;
    const originalApiKey = created.data.apiKey;

    // 2. Get platform by ID
    const getRes = await api.get(`/admin/platforms/${platformId}`);
    expect(getRes.status()).toBe(200);
    const platform = await getRes.json();
    expect(platform.data.platformName).toBe('E2E Test Platform');
    expect(platform.data.apiKey).toBeUndefined(); // secrets not returned in GET

    // 3. List platforms
    const listRes = await api.get('/admin/platforms');
    expect(listRes.status()).toBe(200);
    const list = await listRes.json();
    expect(list.data.count).toBeGreaterThanOrEqual(1);
    expect(list.data.platforms.some((p: any) => p.platformId === platformId)).toBe(true);

    // 4. Update platform
    const updateRes = await api.patch(`/admin/platforms/${platformId}`, {
      data: {
        platformName: 'Updated E2E Platform',
        description: 'Updated by Playwright',
      },
    });
    expect(updateRes.status()).toBe(200);
    const updated = await updateRes.json();
    expect(updated.data.platformName).toBe('Updated E2E Platform');

    // 5. Regenerate API key
    const regenKeyRes = await api.post(`/admin/platforms/${platformId}/regenerate-key`);
    expect(regenKeyRes.status()).toBe(200);
    const regenKey = await regenKeyRes.json();
    expect(regenKey.data.apiKey).toMatch(/^sw_/);
    expect(regenKey.data.apiKey).not.toBe(originalApiKey);

    // 6. Regenerate webhook secret
    const regenSecretRes = await api.post(
      `/admin/platforms/${platformId}/regenerate-webhook-secret`
    );
    expect(regenSecretRes.status()).toBe(200);
    const regenSecret = await regenSecretRes.json();
    expect(regenSecret.data.webhookSecret).toMatch(/^swsec_/);
  });

  test('create platform with missing fields returns 400', async ({ api }) => {
    const res = await api.post('/admin/platforms', {
      data: { platformName: 'Incomplete' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Validation Error');
  });

  test('create platform with invalid email returns 400', async ({ api }) => {
    const res = await api.post('/admin/platforms', {
      data: {
        platformName: 'Bad Email Platform',
        redirectUrl: 'https://example.com',
        contactName: 'Test',
        contactEmail: 'not-an-email',
      },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toContain('email');
  });

  test('create platform with invalid URL returns 400', async ({ api }) => {
    const res = await api.post('/admin/platforms', {
      data: {
        platformName: 'Bad URL Platform',
        redirectUrl: 'not-a-url',
        contactName: 'Test',
        contactEmail: 'test@example.com',
      },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toContain('URL');
  });

  test('get non-existent platform returns 404', async ({ api }) => {
    const res = await api.get('/admin/platforms/does-not-exist');
    expect(res.status()).toBe(404);
  });

  test('update non-existent platform returns 404', async ({ api }) => {
    const res = await api.patch('/admin/platforms/does-not-exist', {
      data: { platformName: 'Ghost' },
    });
    expect(res.status()).toBe(404);
  });

  test('update with no fields returns 400', async ({ api }) => {
    const createRes = await api.post('/admin/platforms', {
      data: {
        platformName: 'Empty Update',
        redirectUrl: 'https://example.com',
        contactName: 'Test',
        contactEmail: 'test@example.com',
      },
    });
    const platformId = (await createRes.json()).data.platformId;

    const res = await api.patch(`/admin/platforms/${platformId}`, {
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('deactivate and reactivate platform', async ({ api }) => {
    const createRes = await api.post('/admin/platforms', {
      data: {
        platformName: 'Toggle Platform',
        redirectUrl: 'https://example.com',
        contactName: 'Test',
        contactEmail: 'test@example.com',
      },
    });
    const platformId = (await createRes.json()).data.platformId;

    // Deactivate
    const deactivate = await api.patch(`/admin/platforms/${platformId}`, {
      data: { status: 'INACTIVE' },
    });
    expect(deactivate.status()).toBe(200);
    expect((await deactivate.json()).data.status).toBe('INACTIVE');

    // Reactivate
    const reactivate = await api.patch(`/admin/platforms/${platformId}`, {
      data: { status: 'ACTIVE' },
    });
    expect(reactivate.status()).toBe(200);
    expect((await reactivate.json()).data.status).toBe('ACTIVE');
  });
});
