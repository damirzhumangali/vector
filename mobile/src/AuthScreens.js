import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { parseCompanyLink, parseEmployeeInvite } from './companyLink';
import { Icon } from './ui';

const colors = {
  canvas: '#F5F7FC',
  card: '#FFFFFF',
  ink: '#142034',
  muted: '#8493AA',
  blue: '#087CFF',
  tint: '#EAF4FF',
  border: '#E4EBF5',
  error: '#A32922',
};

const screens = {
  login: ['Вход в qwork', 'Войдите по рабочей почте или своему логину.'],
  invite: ['Приглашение в qwork', 'Откройте приглашение и введите логин и пароль из сообщения с доступом.'],
  company: ['Вход по ссылке компании', 'Укажите компанию, в которую хотите войти.'],
  register: ['Создайте компанию', 'Настройте рабочее пространство для выездных работ.'],
  recovery: ['Восстановление доступа', 'Укажите логин или подтверждённую почту. Ссылку для нового пароля отправим на почту аккаунта.'],
};

function Button({ label, onPress, tone = 'primary', disabled = false }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        tone === 'secondary' && styles.secondary,
        tone === 'plain' && styles.plain,
        (pressed || disabled) && styles.pressed,
      ]}
    >
      <Text style={[styles.buttonText, tone !== 'primary' && styles.secondaryText]}>
        {label}
      </Text>
    </Pressable>
  );
}

function Field({ label, icon = 'user', ...props }) {
  const [focused, setFocused] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const isPassword = props.secureTextEntry === true;
  const disabled = props.editable === false;
  const hasEdgeSpaces = isPassword && typeof props.value === 'string'
    && props.value !== props.value.trim();

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.inputRow, focused && styles.inputFocused]}>
        <Icon name={icon} color={focused ? colors.blue : '#94A5BE'} size={19} />
        <TextInput
          accessibilityLabel={label}
          placeholderTextColor={colors.muted}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={styles.input}
          {...props}
          {...(isPassword ? {
            autoCapitalize: 'none',
            autoCorrect: false,
            secureTextEntry: !passwordVisible,
          } : {})}
        />
        {isPassword && <Pressable
          accessibilityRole="button"
          accessibilityLabel={passwordVisible ? 'Скрыть пароль' : 'Показать пароль'}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => { if (!disabled) setPasswordVisible(current => !current); }}
          style={({ pressed }) => [styles.passwordToggle, (pressed || disabled) && styles.pressed]}
        >
          <Text style={styles.passwordToggleText}>{passwordVisible ? 'Скрыть' : 'Показать'}</Text>
        </Pressable>}
      </View>
      {hasEdgeSpaces && <View style={styles.passwordHint}>
        <Text style={styles.description}>В начале или конце пароля есть пробелы. Проверьте, входят ли они в пароль.</Text>
        {typeof props.onChangeText === 'function' && <Pressable
          accessibilityRole="button"
          accessibilityLabel="Убрать пробелы по краям пароля"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => { if (!disabled) props.onChangeText(props.value.trim()); }}
          style={({ pressed }) => [styles.passwordTrim, (pressed || disabled) && styles.pressed]}
        >
          <Text style={styles.passwordToggleText}>Убрать пробелы по краям</Text>
        </Pressable>}
      </View>}
    </View>
  );
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export default function AuthScreens({ onEnter, api, onDemo, invitationUrl = '', savedCompanyUrl = '' }) {
  const [screen, setScreen] = useState('login');
  const [fields, setFields] = useState({ invitation: invitationUrl });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [requiresPasswordChange, setRequiresPasswordChange] = useState(false);
  const [companyRequired, setCompanyRequired] = useState(false);
  const [recoverySent, setRecoverySent] = useState(false);
  const pendingRequest = useRef(null);

  useEffect(() => {
    if (!invitationUrl) return;
    pendingRequest.current = null;
    setBusy(false);
    setFields({ invitation: invitationUrl });
    setError('');
    setRequiresPasswordChange(false);
    setCompanyRequired(false);
    setRecoverySent(false);
    setScreen(parseEmployeeInvite(invitationUrl) ? 'invite' : 'company');
  }, [invitationUrl]);

  useEffect(() => () => { pendingRequest.current = null; }, []);

  function go(next) {
    if (pendingRequest.current) return;
    setFields(current => ({
      invitation: next === 'company' ? savedCompanyUrl : current.invitation,
      login: current.login,
    }));
    setRequiresPasswordChange(false);
    setCompanyRequired(false);
    setRecoverySent(false);
    setError('');
    setScreen(next);
  }

  function field(name) {
    return {
      value: fields[name] ?? '',
      editable: !busy,
      onChangeText: value => {
        setError('');
        if (['invitation', 'login', 'password'].includes(name)) setRequiresPasswordChange(false);
        setFields(current => ({ ...current, [name]: value }));
      },
    };
  }

  async function submit(path, body) {
    if (pendingRequest.current) return;
    const request = {};
    pendingRequest.current = request;
    setBusy(true);
    setError('');
    try {
      const result = await api(path, { method: 'POST', body });
      if (pendingRequest.current !== request) return;
      if (result.requiresPasswordChange && body.inviteToken) {
        setRequiresPasswordChange(true);
        return;
      }
      if (path === '/auth/password/request') {
        setRecoverySent(true);
        return;
      }
      if (!result.token || !result.user || !result.company) {
        throw new Error('Не удалось завершить вход. Повторите попытку.');
      }
      onEnter(result);
    } catch (reason) {
      if (pendingRequest.current === request) {
        setCompanyRequired(screen === 'login' && reason?.status === 409);
        setError(reason instanceof Error ? reason.message : 'Не удалось подключиться. Повторите попытку.');
      }
    } finally {
      if (pendingRequest.current === request) {
        pendingRequest.current = null;
        setBusy(false);
      }
    }
  }

  function login() {
    const login = fields.login?.trim();
    if (!login || !fields.password) {
      setError('Введите почту или логин и пароль.');
      return;
    }
    void submit('/auth/login', { login, password: fields.password });
  }

  function recover() {
    const login = fields.login?.trim();
    if (!login) {
      setError('Введите почту или логин.');
      return;
    }
    void submit('/auth/password/request', { login });
  }

  function acceptInvitation() {
    const link = fields.invitation?.trim() ?? '';
    const inviteToken = parseEmployeeInvite(link);
    const code = parseCompanyLink(link);
    const login = fields.login?.trim();
    if (!inviteToken && !code) {
      setError('Вставьте полную ссылку приглашения или компании.');
      return;
    }
    if (!login || !fields.password) {
      setError('Введите логин и временный пароль из приглашения.');
      return;
    }
    const body = { login, password: fields.password, ...(inviteToken ? { inviteToken } : { code }) };
    if (requiresPasswordChange && inviteToken) {
      const newPassword = fields.newPassword ?? '';
      if (Array.from(newPassword).length < 8) {
        setError('Новый пароль должен содержать не менее восьми символов.');
        return;
      }
      if (newPassword === fields.password) {
        setError('Придумайте личный пароль, отличный от временного.');
        return;
      }
      if (newPassword !== fields.confirmPassword) {
        setError('Новые пароли не совпадают.');
        return;
      }
      body.newPassword = newPassword;
    }
    void submit('/auth/login', body);
  }

  function register() {
    const company = fields.company?.trim();
    const owner = fields.owner?.trim();
    const email = fields.email?.trim() ?? '';
    const password = fields.password ?? '';
    if (!company || !owner || !looksLikeEmail(email)) {
      setError('Укажите компанию, имя диспетчера и рабочую почту.');
      return;
    }
    if (password.length < 8) {
      setError('Введите пароль длиной не менее восьми символов.');
      return;
    }
    void submit('/auth/register', { company, owner, email, password });
  }

  const [baseTitle, baseDescription] = screens[screen];
  const title = requiresPasswordChange ? 'Установите личный пароль' : baseTitle;
  const description = requiresPasswordChange
    ? 'При следующих входах используйте свой логин и этот пароль. Ссылка больше не понадобится.'
    : baseDescription;
  const linkedLogin = screen === 'invite' || screen === 'company';
  const main = screen === 'login' || screen === 'register';

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <View accessible={false} style={styles.brandMark}>
            <Text accessible={false} style={styles.brandMarkText}>q</Text>
          </View>
          <View style={styles.brandCopy}>
            <Text style={styles.brandName}>qwork</Text>
            <Text style={styles.brandCaption}>Команда. Задачи. Результат.</Text>
          </View>
        </View>
        <View style={styles.card}>
          {main && (
            <View style={styles.tabs}>
              {[
                ['login', 'Вход'],
                ['register', 'Регистрация'],
              ].map(([key, label]) => (
                <Pressable
                  accessibilityRole="tab"
                  accessibilityState={{ selected: screen === key, disabled: busy }}
                  disabled={busy}
                  key={key}
                  onPress={() => go(key)}
                  style={[styles.tab, screen === key && styles.tabActive]}
                >
                  <Text style={[styles.tabLabel, screen === key && styles.tabLabelActive]}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}

          <View style={styles.heading}>
            <View style={styles.headingIcon}><Icon name={screen === 'register' ? 'building' : 'shield'} color={colors.blue} size={25} /></View>
            <Text accessibilityRole="header" style={styles.title}>{title}</Text>
            <Text style={styles.description}>{description}</Text>
          </View>
          {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}

          {screen === 'login' && (
            <>
              <Field label="Почта или логин" autoCapitalize="none" autoCorrect={false}
                textContentType="username" {...field('login')} />
              <Field label="Пароль" icon="shield" secureTextEntry returnKeyType="go"
                textContentType="password" onSubmitEditing={login} {...field('password')} />
              <Button label={busy ? 'Входим…' : 'Войти'} onPress={login} disabled={busy} />
              <Button label="Забыли пароль?" tone="plain" disabled={busy} onPress={() => go('recovery')} />
              <Button label="У меня есть приглашение" tone="secondary" disabled={busy} onPress={() => go('invite')} />
              {companyRequired && <Button label="Войти по ссылке компании" tone="plain" disabled={busy} onPress={() => go('company')} />}
            </>
          )}
          {screen === 'recovery' && (
            recoverySent ? (
              <View style={styles.notice}>
                <Icon name="mail" size={22} color={colors.blue} />
                <Text style={styles.noticeText}>Если у аккаунта есть подтверждённая почта, на неё отправлена ссылка. Проверьте входящие письма и папку «Спам».</Text>
              </View>
            ) : (
              <>
                <Field label="Почта или логин" autoCapitalize="none" autoCorrect={false}
                  textContentType="username" returnKeyType="go" onSubmitEditing={recover} {...field('login')} />
                <Button label={busy ? 'Отправляем…' : 'Отправить ссылку'} onPress={recover} disabled={busy} />
                <Text style={styles.description}>Если подтверждённой почты нет, за новым временным паролем обратитесь к диспетчеру, создавшему компанию.</Text>
              </>
            )
          )}

          {linkedLogin && (
            <>
              {!requiresPasswordChange && <>
                <Field label={screen === 'company' ? 'Ссылка компании' : 'Персональная ссылка'}
                  icon="link" placeholder="Вставьте полную ссылку" keyboardType="url"
                  autoCapitalize="none" autoCorrect={false} {...field('invitation')} />
                <Field label={screen === 'invite' ? 'Логин из приглашения' : 'Почта или логин'} autoCapitalize="none" autoCorrect={false}
                  textContentType="username" {...field('login')} />
                <Field label="Пароль"
                  placeholder={screen === 'invite' ? 'Временный пароль из приглашения' : undefined}
                  icon="shield" secureTextEntry textContentType="password" returnKeyType="go"
                  onSubmitEditing={acceptInvitation} {...field('password')} />
                {screen === 'invite' && <Text style={styles.description}>Для первого входа нужен временный пароль, который qwork создал автоматически. Он указан в сообщении с приглашением. Если аккаунт уже активирован, введите свой личный пароль.</Text>}
              </>}
              {requiresPasswordChange && <>
                <View style={styles.notice}>
                  <Icon name="check" size={19} color={colors.blue} />
                  <Text style={styles.noticeText}>Данные подтверждены. Логин · {fields.login}</Text>
                </View>
                <Field label="Новый пароль" icon="shield" secureTextEntry textContentType="newPassword"
                  autoCapitalize="none" autoCorrect={false} {...field('newPassword')} />
                <Field label="Повторите новый пароль" icon="shield" secureTextEntry textContentType="newPassword"
                  returnKeyType="go" onSubmitEditing={acceptInvitation} {...field('confirmPassword')} />
                <Text style={styles.description}>Не менее 8 символов. Личный пароль должен отличаться от временного.</Text>
              </>}
              <Button label={busy ? 'Проверяем…' : requiresPasswordChange ? 'Сохранить пароль и войти' : screen === 'company' ? 'Войти' : 'Продолжить'}
                onPress={acceptInvitation} disabled={busy} />
            </>
          )}

          {screen === 'register' && (
            <>
              <Field label="Название компании" icon="building" {...field('company')} />
              <Field label="Имя диспетчера" autoCapitalize="words" {...field('owner')} />
              <Field
                label="Рабочая почта"
                icon="user"
                keyboardType="email-address"
                autoCapitalize="none"
                {...field('email')}
              />
              <Field
                label="Пароль"
                icon="shield"
                secureTextEntry
                returnKeyType="go"
                onSubmitEditing={register}
                {...field('password')}
              />
              <Button label={busy ? 'Создаём…' : 'Создать компанию'} onPress={register} disabled={busy} />
            </>
          )}

          {!main && <Button label="Вернуться ко входу" tone="plain" onPress={() => go('login')} />}
        </View>
        {screen === 'login' && onDemo && (
          <View style={styles.preview}>
            <View style={styles.previewIcon}><Icon name="clipboard" color={colors.blue} size={21} /></View>
            <View style={styles.previewCopy}>
              <Text style={styles.previewTitle}>Демо-режим</Text>
              <Text style={styles.description}>Посмотрите рабочий экран с локальными демоданными.</Text>
            </View>
            <Button label="Открыть демо" tone="secondary" disabled={busy} onPress={() => onDemo('employee')} />
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  content: { flexGrow: 1, paddingHorizontal: 18, paddingTop: 20, paddingBottom: 28, width: '100%', maxWidth: 500, alignSelf: 'center' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 24 },
  brandMark: { width: 42, height: 42, borderRadius: 13, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.blue },
  brandMarkText: { color: colors.card, fontSize: 29, fontWeight: '800', lineHeight: 34 },
  brandCopy: { flex: 1 },
  brandName: { color: colors.ink, fontSize: 24, fontWeight: '800', letterSpacing: -0.8 },
  brandCaption: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  card: { gap: 14, padding: 18, borderRadius: 18, backgroundColor: colors.card },
  heading: { gap: 6, marginTop: 3, marginBottom: 3 },
  headingIcon: { width: 48, height: 48, borderRadius: 15, backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center', marginBottom: 7 },
  title: { color: colors.ink, fontSize: 26, fontWeight: '700', letterSpacing: -0.7 },
  description: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  tabs: { flexDirection: 'row', padding: 3, gap: 3, borderRadius: 11, backgroundColor: colors.canvas },
  tab: { flex: 1, minHeight: 40, padding: 6, alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
  tabActive: { backgroundColor: colors.blue },
  tabLabel: { color: colors.muted, fontSize: 13, fontWeight: '600', textAlign: 'center' },
  tabLabelActive: { color: colors.card },
  field: { gap: 6 },
  fieldLabel: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  inputRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 10, borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.canvas },
  input: { flex: 1, minWidth: 0, paddingVertical: 12, color: colors.ink, fontSize: 15 },
  inputFocused: { borderColor: colors.blue, backgroundColor: colors.card },
  passwordToggle: { minWidth: 68, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  passwordToggleText: { color: colors.blue, fontSize: 12, fontWeight: '600' },
  passwordHint: { gap: 2 },
  passwordTrim: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 4 },
  button: { alignItems: 'center', justifyContent: 'center', minHeight: 48, borderRadius: 11, paddingHorizontal: 13, paddingVertical: 10, backgroundColor: colors.blue },
  secondary: { backgroundColor: colors.tint },
  plain: { minHeight: 40, backgroundColor: 'transparent' },
  pressed: { opacity: 0.75 },
  buttonText: { color: colors.card, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  secondaryText: { color: colors.blue },
  error: { color: colors.error, backgroundColor: '#FFF0F2', borderRadius: 10, padding: 10, fontSize: 13, lineHeight: 18 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 11, borderRadius: 10, backgroundColor: colors.tint },
  noticeText: { flex: 1, color: colors.blue, fontSize: 13, lineHeight: 18 },
  preview: { marginTop: 14, gap: 10, backgroundColor: colors.card, borderRadius: 16, padding: 14 },
  previewIcon: { width: 38, height: 38, borderRadius: 11, backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center' },
  previewCopy: { gap: 3 },
  previewTitle: { color: colors.ink, fontSize: 15, fontWeight: '600' },
});
