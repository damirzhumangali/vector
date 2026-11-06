import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors as c, Icon } from './ui';

function Button({ children, onPress, disabled, secondary = false }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} onPress={onPress}
    disabled={disabled} style={[styles.button, secondary && styles.secondary, disabled && styles.dim]}>
    <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{children}</Text>
  </Pressable>;
}

export default function EmailSettings({ user, request }) {
  const [account, setAccount] = useState(user);
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(user.email ?? '');
  const [password, setPassword] = useState('');
  const [mailAvailable, setMailAvailable] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const inFlight = useRef(false);

  useEffect(() => {
    let closed = false;
    let refreshing = false;
    async function refresh() {
      if (closed || refreshing) return;
      refreshing = true;
      try {
        const result = await request('/auth/me');
        if (!closed) {
          setAccount(result.user);
          setMailAvailable(result.emailSendingAvailable);
        }
      } catch {
        // The main application displays connection and session errors.
      } finally {
        refreshing = false;
      }
    }
    void refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refresh();
    }, 15000);
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') void refresh();
    });
    return () => { closed = true; clearInterval(timer); listener.remove(); };
  }, [request]);

  async function run(action) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (failure) {
      setError(failure.message || 'Не удалось обновить почту.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function save() {
    run(async () => {
      const result = await request('/auth/email', { method: 'PATCH', body: { email: email.trim(), password } });
      setAccount(result.user);
      setPassword('');
      setEditing(false);
      if (!result.user.email) {
        setNotice('Дополнительная почта удалена.');
      } else if (mailAvailable === true) {
        setNotice('Почта сохранена. Нажмите «Отправить подтверждение», чтобы получить письмо.');
      } else {
        setNotice('Почта сохранена. Письмо не отправлено.');
      }
    });
  }

  function sendVerification() {
    run(async () => {
      const result = await request('/auth/email/request', { method: 'POST', body: {}, timeout: 20000 });
      if (result.verified) {
        setAccount(previous => ({ ...previous, emailVerified: true }));
        setNotice('Почта уже подтверждена. Её можно использовать для входа и восстановления доступа.');
      } else {
        setNotice('Письмо отправлено. Откройте ссылку в письме, затем вернитесь в qwork.');
      }
    });
  }

  return <View style={styles.card}>
    <View style={styles.heading}><View style={styles.icon}><Icon name="mail" size={21} /></View>
      <View style={styles.flex}><Text style={styles.title}>Дополнительная почта</Text><Text style={styles.caption}>Для входа и восстановления доступа</Text></View>
    </View>
    {editing ? <>
      <Text style={styles.label}>Почта (необязательно)</Text>
      <TextInput accessibilityLabel="Дополнительная почта" style={styles.input} value={email} onChangeText={setEmail}
        autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="emailAddress"
        maxLength={254} editable={!busy} placeholder="name@example.com" placeholderTextColor={c.muted} />
      <Text style={styles.caption}>Для каждого аккаунта нужна отдельная почта. Пустое поле удалит дополнительную почту. Ваш логин сохранится.</Text>
      <Text style={styles.label}>Текущий пароль</Text>
      <TextInput accessibilityLabel="Текущий пароль" style={styles.input} value={password} onChangeText={setPassword}
        secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="password" maxLength={128} editable={!busy} />
      <Button onPress={save} disabled={busy || !password || email.trim() === (account.email ?? '')}>Сохранить почту</Button>
      <Button onPress={() => { setEditing(false); setPassword(''); setError(''); }} disabled={busy} secondary>Отмена</Button>
    </> : <>
      <Text selectable style={styles.address}>{account.email || 'Почта не указана'}</Text>
      {account.email ? <View style={styles.statusRow}>
        <Icon name={account.emailVerified ? 'check' : 'clock'} size={16} color={account.emailVerified ? c.green : c.orange} />
        <Text style={[styles.caption, { color: account.emailVerified ? c.green : '#B87918' }]}>
          {account.emailVerified ? 'Подтверждена · можно использовать для входа' : 'Ожидает подтверждения'}
        </Text>
      </View> : <Text style={styles.caption}>Вход по логину работает без почты.</Text>}
      {account.email && !account.emailVerified && <Button onPress={sendVerification} disabled={busy || mailAvailable !== true} secondary>
        Отправить подтверждение
      </Button>}
      <Button onPress={() => { setEmail(account.email ?? ''); setPassword(''); setEditing(true); setError(''); setNotice(''); }} disabled={busy} secondary>
        {account.email ? 'Изменить почту' : 'Добавить почту'}
      </Button>
    </>}
    {mailAvailable === false && <Text style={styles.caption}>{account.isOwner
      ? 'Отправка писем пока недоступна. Для входа используйте почту или логин и текущий пароль.'
      : 'Отправка писем пока недоступна. Пользуйтесь логином, а за новым паролем обратитесь к создателю компании.'}</Text>}
    {notice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 15, gap: 10 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  icon: { width: 36, height: 36, borderRadius: 11, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, gap: 3 },
  title: { color: c.ink, fontSize: 15, fontWeight: '600' },
  caption: { color: c.muted, fontSize: 12, lineHeight: 18 },
  address: { color: c.ink, fontSize: 14, fontWeight: '500' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  label: { color: c.ink, fontSize: 13, fontWeight: '600', marginTop: 3 },
  input: { backgroundColor: c.canvas, borderWidth: 1, borderColor: c.border, borderRadius: 11, minHeight: 46, paddingHorizontal: 12, color: c.ink, fontSize: 14 },
  button: { backgroundColor: c.blue, minHeight: 43, padding: 11, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  secondary: { backgroundColor: c.tint },
  secondaryText: { color: c.blue },
  dim: { opacity: .5 },
  notice: { color: '#16825A', fontSize: 12, lineHeight: 18 },
  error: { color: '#B83D4E', fontSize: 12, lineHeight: 18 },
});
