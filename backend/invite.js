'use strict';

const token = window.location.hash.slice(1);
const statusMessage = document.getElementById('status');

if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
  const appLink = document.getElementById('open-app');
  appLink.href = 'qwork://join/' + token;
  appLink.hidden = false;

  const shareUrl = document.getElementById('invite-url');
  shareUrl.value = window.location.origin + '/join#' + token;
  document.getElementById('copy-controls').hidden = false;
  document.getElementById('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl.value);
      statusMessage.textContent = 'Ссылка скопирована.';
    } catch {
      shareUrl.focus();
      shareUrl.select();
      statusMessage.textContent = 'Скопируйте выделенную ссылку.';
    }
  });
} else {
  statusMessage.textContent = 'Ссылка неполная. Запросите новое приглашение у создателя компании.';
}
