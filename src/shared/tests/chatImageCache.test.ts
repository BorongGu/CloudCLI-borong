import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('image bytes are reused within one login and isolated across logins', async () => {
  vi.stubEnv('VITE_IS_PLATFORM', 'false');
  vi.resetModules();
  const { api } = await import('@/shared/api');
  const fetchImage = vi.fn(() => Promise.resolve(new Response('image bytes', { headers: { 'Content-Type': 'image/png' } })));
  vi.stubGlobal('fetch', fetchImage);
  localStorage.setItem('auth-token', 'account-one');
  expect(await (await api.assets.image('shot.png')).text()).toBe('image bytes');
  expect(await (await api.assets.image('shot.png')).text()).toBe('image bytes');
  expect(fetchImage).toHaveBeenCalledTimes(1);

  localStorage.setItem('auth-token', 'account-two');
  await api.assets.image('shot.png');
  expect(fetchImage).toHaveBeenCalledTimes(2);
  localStorage.removeItem('auth-token');
  await api.assets.image('shot.png');
  expect(fetchImage).toHaveBeenCalledTimes(3);
});

test('uploaded image previews reuse local bytes and respect cancellation', async () => {
  vi.stubEnv('VITE_IS_PLATFORM', 'false');
  vi.resetModules();
  const { api } = await import('@/shared/api');
  const fetchImage = vi.fn();
  vi.stubGlobal('fetch', fetchImage);
  localStorage.setItem('auth-token', 'account-preview');
  api.assets.cacheImage('local.png', new Blob(['uploaded'], { type: 'image/png' }));
  const response = await api.assets.image('local.png');
  expect(response.headers.get('Content-Type')).toBe('image/png');
  expect(response.headers.get('X-Refreshed-Token')).toBeNull();
  expect(fetchImage).toHaveBeenCalledTimes(0);
  const controller = new AbortController();
  controller.abort();
  await expect(api.assets.image('local.png', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
});
