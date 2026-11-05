(() => {
  let token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const element = id => document.getElementById(id);
  const task = element('task');
  const form = element('review');
  const remark = element('remark');
  const reason = element('reason');
  const error = element('error');
  const success = element('success');
  const button = form.querySelector('button');
  const selected = () => form.querySelector('input[name=decision]:checked')?.value;

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  async function request(path, fields) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 75000);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
        body: JSON.stringify({ token, ...fields }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw new Error(data?.error || 'Сервер временно недоступен.');
      return data;
    } catch (failure) {
      if (failure.name === 'AbortError' || failure instanceof TypeError) {
        throw new Error('Не удалось связаться с сервером. Проверьте подключение и попробуйте снова.');
      }
      throw failure;
    } finally {
      clearTimeout(timeout);
    }
  }

  function readPhoto(file) {
    if (file.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png'].includes(file.type)) {
      throw new Error('Выберите фото JPEG или PNG размером до 5 МБ.');
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result).split(',', 2)[1]), { once: true });
      reader.addEventListener('error', () => reject(new Error('Не удалось прочитать фото.')), { once: true });
      reader.readAsDataURL(file);
    });
  }

  form.addEventListener('change', () => {
    const needsRemark = selected() === 'remark';
    remark.hidden = !needsRemark;
    reason.required = needsRemark;
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled || !token) return;
    error.hidden = true;
    button.disabled = true;
    try {
      const decision = selected();
      const fields = { decision, name: element('name').value };
      if (decision === 'remark') {
        fields.reason = reason.value;
        fields.comment = element('comment').value;
        const file = element('photo').files[0];
        if (file) fields.imageBase64 = await readPhoto(file);
      }
      await request('/representative/decision', fields);
      form.reset();
      form.hidden = true;
      token = '';
      success.textContent = decision === 'remark'
        ? 'Замечание передано руководителю.'
        : 'Подтверждение сохранено. Спасибо!';
      success.hidden = false;
    } catch (failure) {
      showError(failure.message);
      button.disabled = false;
    }
  });

  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    task.hidden = true;
    showError('Откройте полную ссылку на подтверждение выезда.');
    return;
  }
  request('/representative/preview', {})
    .then(data => {
      task.textContent = [data.company, data.title, data.object].filter(Boolean).join(' · ');
      form.hidden = false;
    })
    .catch(failure => {
      task.hidden = true;
      showError(failure.message);
    });
})();
