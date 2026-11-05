(() => {
  const reset = location.pathname.replace(/\/+$/, '') === '/reset-password';
  let token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const form = document.getElementById('form');
  const title = document.getElementById('title');
  const description = document.getElementById('description');
  const button = document.getElementById('submit');
  const error = document.getElementById('error');
  const success = document.getElementById('success');
  const password = document.getElementById('password');
  const confirmation = document.getElementById('confirmation');
  title.textContent = reset ? 'Установите новый пароль' : 'Подтвердите почту';
  description.textContent = reset
    ? 'После смены пароля войдите в приложение qwork с новым паролем.'
    : 'После подтверждения вы сможете входить по этой почте и восстанавливать доступ.';
  document.getElementById('passwordFields').hidden = !reset;
  button.textContent = reset ? 'Сохранить пароль' : 'Подтвердить почту';
  password.required = reset;
  confirmation.required = reset;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    error.textContent = 'Ссылка неполная. Запросите новое письмо в приложении qwork.';
    error.hidden = false;
    button.disabled = true;
  }
  let running = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (running || button.disabled) return;
    error.hidden = true;
    if (reset && (Array.from(password.value).length < 8 || password.value !== confirmation.value)) {
      error.textContent = password.value !== confirmation.value
        ? 'Пароли не совпадают.' : 'Пароль должен содержать не менее 8 символов.';
      error.hidden = false;
      return;
    }
    running = true;
    button.disabled = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(reset ? '/auth/password/reset' : '/auth/email/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ...(reset ? { password: password.value } : {}) }),
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Не удалось выполнить действие. Попробуйте снова.');
      form.hidden = true;
      token = '';
      password.value = '';
      confirmation.value = '';
      success.textContent = reset
        ? 'Пароль сохранён. Откройте qwork и войдите с новым паролем.'
        : 'Почта подтверждена. Вернитесь в qwork — теперь её можно использовать для входа.';
      success.hidden = false;
    } catch (failure) {
      error.textContent = failure.name === 'AbortError'
        ? 'Сервер не ответил. Попробуйте снова.'
        : failure.message;
      error.hidden = false;
      button.disabled = false;
    } finally {
      running = false;
      clearTimeout(timeout);
    }
  });
})();
