export const apiOrigin = (process.env.EXPO_PUBLIC_QWORK_API_URL ?? '').trim().replace(/\/+$/, '');

export function apiImageSource(path, token) {
  return { uri: apiOrigin + path, headers: { Authorization: `Bearer ${token}` }, cache: 'reload' };
}

export async function apiRequest(path, { method = 'GET', body, token, timeout = 10000 } = {}) {
  if (!apiOrigin) {
    throw new Error('Адрес сервера qwork не задан. Укажите EXPO_PUBLIC_QWORK_API_URL и перезапустите Expo.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const options = {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    };
    let response;
    try {
      response = await fetch(apiOrigin + path, options);
    } catch {
      // Native fetch may reject with Error rather than TypeError on iOS.
      const failure = new Error('Сервер qwork недоступен. Проверьте подключение к сети.');
      failure.network = true;
      throw failure;
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error || `Сервер ответил с ошибкой (${response.status}).`);
      error.status = response.status;
      error.code = payload?.code;
      throw error;
    }
    if (!payload) throw new Error('Сервер вернул неожиданный ответ.');
    return payload;
  } finally {
    clearTimeout(timer);
  }
}
