import React, { useRef, useState } from 'react';
import {
  KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Icon } from './ui';

const ACCESS_KEY = 'qwork.quick-access.v1';
const BIOMETRIC_KEY = 'qwork.biometric-session.v1';
const MAX_ATTEMPTS = 5;
const iosExpoGo = Platform.OS === 'ios' && (Constants.executionEnvironment === 'storeClient' || Constants.appOwnership === 'expo');
const storageOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const biometricOptions = {
  ...storageOptions,
  keychainService: 'qwork.biometric',
  requireAuthentication: true,
  authenticationPrompt: 'Подтвердите вход в qwork',
};

async function readRecord() {
  const value = await SecureStore.getItemAsync(ACCESS_KEY, storageOptions);
  return value ? JSON.parse(value) : null;
}

export async function readQuickAccess() {
  try {
    const record = await readRecord();
    if (record?.method === 'pin' && record.attempts < MAX_ATTEMPTS) return { method: 'pin' };
    if (record?.method === 'biometric') return { method: 'biometric' };
  } catch {
    // Fall back to server sign-in if this device cannot read secure storage.
  }
  return null;
}

export async function clearQuickAccess() {
  const previous = await readRecord();
  if (!previous) return;
  // On iOS, overwrite the session without invoking the Keychain's delete path.
  if (Platform.OS === 'ios') await saveRecord(null);
  else await SecureStore.deleteItemAsync(ACCESS_KEY, storageOptions);
  if (previous.method === 'biometric' && !iosExpoGo) {
    await SecureStore.deleteItemAsync(BIOMETRIC_KEY, biometricOptions);
  }
}

function saveRecord(record) {
  return SecureStore.setItemAsync(ACCESS_KEY, JSON.stringify(record), storageOptions);
}

function pinDigest(pin, salt) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${pin}`);
}

function quickAccessError(reason) {
  const message = reason instanceof Error ? reason.message : '';
  if (/entitlement|(?:get|set|delete)ValueWithKeyAsync/i.test(message)) {
    return 'Защищённое хранилище на этом устройстве недоступно. Можно продолжить с обычным входом.';
  }
  return message || 'Попробуйте ещё раз.';
}

function Action({ title, onPress, disabled, secondary }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondary,
        (disabled || pressed) && styles.pressed,
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{title}</Text>
    </Pressable>
  );
}

function PinField({ label, value, onChangeText, busy }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={text => onChangeText(text.replace(/\D/g, '').slice(0, 6))}
        editable={!busy}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={6}
        style={styles.input}
        placeholder="••••••"
        placeholderTextColor="#73809A"
      />
    </View>
  );
}

export default function QuickAccess({ session, saved, onComplete, onUnlock, onForget, onCancel }) {
  const [pin, setPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const setup = Boolean(session);
  const useBiometric = !setup && saved?.method === 'biometric';
  const biometricsAvailable = !iosExpoGo && SecureStore.canUseBiometricAuthentication();

  async function run(action) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      setError(quickAccessError(reason));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function updatePin(value) {
    setError('');
    setPin(value);
  }

  function updateConfirmation(value) {
    setError('');
    setConfirmation(value);
  }

  function savePin() {
    if (!/^\d{6}$/.test(pin)) {
      setError('Введите шесть цифр.');
      return;
    }
    if (pin !== confirmation) {
      setError('PIN не совпадает. Проверьте оба поля.');
      return;
    }
    void run(async () => {
      const salt = Crypto.randomUUID();
      const hash = await pinDigest(pin, salt);
      if (!iosExpoGo && (await readRecord())?.method === 'biometric') {
        await SecureStore.deleteItemAsync(BIOMETRIC_KEY, biometricOptions);
      }
      await saveRecord({ method: 'pin', salt, hash, attempts: 0, session });
      await onComplete(session);
    });
  }

  function enableBiometrics() {
    void run(async () => {
      if (!biometricsAvailable) throw new Error('Биометрический вход недоступен на этом устройстве.');
      await clearQuickAccess();
      await SecureStore.setItemAsync(BIOMETRIC_KEY, JSON.stringify(session), biometricOptions);
      try {
        await saveRecord({ method: 'biometric' });
      } catch (reason) {
        await SecureStore.deleteItemAsync(BIOMETRIC_KEY, biometricOptions).catch(() => {});
        throw reason;
      }
      await onComplete(session);
    });
  }

  function unlockPin() {
    if (!/^\d{6}$/.test(pin)) {
      setError('Введите шесть цифр.');
      return;
    }
    void run(async () => {
      const record = await readRecord();
      if (record?.method !== 'pin' || record.attempts >= MAX_ATTEMPTS) {
        throw new Error('Сохранённый вход недоступен. Войдите с паролем.');
      }
      const hash = await pinDigest(pin, record.salt);
      if (hash !== record.hash) {
        const attempts = record.attempts + 1;
        await saveRecord({ ...record, attempts });
        if (attempts === MAX_ATTEMPTS) {
          // The persisted attempt limit already disables the old PIN.
          await clearQuickAccess().catch(() => {});
          await onForget('Слишком много неверных попыток. Войдите с паролем.');
          return;
        }
        throw new Error(`Неверный PIN. Осталось попыток: ${MAX_ATTEMPTS - attempts}.`);
      }
      if (record.attempts) await saveRecord({ ...record, attempts: 0 });
      await onUnlock(record.session);
    });
  }

  function unlockBiometrics() {
    void run(async () => {
      if (!biometricsAvailable) {
        throw new Error('Биометрия недоступна. Войдите с паролем.');
      }
      const value = await SecureStore.getItemAsync(BIOMETRIC_KEY, biometricOptions);
      if (!value) throw new Error('Сохранённый вход недоступен. Войдите с паролем.');
      await onUnlock(JSON.parse(value));
    });
  }

  function usePassword() {
    void run(async () => {
      let message;
      try {
        await clearQuickAccess();
      } catch {
        message = 'Не удалось очистить быстрый вход на устройстве. Войдите с паролем.';
      }
      await onForget(message);
    });
  }

  const description = setup
    ? 'Задайте PIN для входа на этом телефоне.'
    : useBiometric
      ? 'Подтвердите вход с помощью биометрии телефона.'
      : 'Введите PIN, который задали на этом телефоне.';

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.brandMark}><Text style={styles.brandLetter}>q</Text></View>
            <Text style={styles.brand}>qwork</Text>
          </View>
          <View style={styles.securityIcon}><Icon name="shield" color="#087CFF" size={32} /></View>
          <Text accessibilityRole="header" style={styles.title}>{setup ? 'Быстрый вход' : 'Войти в qwork'}</Text>
          <Text style={styles.hint}>{description}</Text>
          {!useBiometric && <PinField label="PIN из шести цифр" value={pin} onChangeText={updatePin} busy={busy} />}
          {setup && <PinField label="Повторите PIN" value={confirmation} onChangeText={updateConfirmation} busy={busy} />}
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Action
            title={busy ? 'Подождите…' : setup ? 'Сохранить PIN' : useBiometric ? 'Войти по биометрии' : 'Войти по PIN'}
            disabled={busy}
            onPress={setup ? savePin : useBiometric ? unlockBiometrics : unlockPin}
          />
          {setup && biometricsAvailable && (
            <Action title="Включить Face ID или отпечаток" onPress={enableBiometrics} disabled={busy} secondary />
          )}
          {setup && iosExpoGo && <Text style={styles.hint}>На iPhone в Expo Go доступен PIN. Для Face ID нужна отдельная сборка qwork.</Text>}
          {setup && !iosExpoGo && !biometricsAvailable && <Text style={styles.hint}>Биометрия на этом телефоне пока недоступна.</Text>}
          <Action
            title={setup ? onCancel ? 'Отмена' : 'Продолжить без быстрого входа' : 'Войти с паролем'}
            onPress={setup ? onCancel ?? (() => onComplete(session)) : usePassword}
            disabled={busy}
            secondary
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F5F7FC' },
  content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 18, paddingVertical: 24, width: '100%', maxWidth: 480, alignSelf: 'center' },
  card: { backgroundColor: '#fff', borderRadius: 18, padding: 20, gap: 13 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 10 },
  brandMark: { height: 32, width: 32, backgroundColor: '#087CFF', borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  brandLetter: { color: '#fff', fontSize: 24, fontWeight: '800', lineHeight: 27 },
  brand: { color: '#142034', fontSize: 22, fontWeight: '800', letterSpacing: -0.8 },
  securityIcon: { height: 66, width: 66, borderRadius: 22, backgroundColor: '#EAF4FF', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  title: { color: '#142034', fontSize: 26, fontWeight: '700', letterSpacing: -0.6 },
  hint: { color: '#8493AA', fontSize: 13, lineHeight: 19 },
  field: { gap: 6 },
  label: { color: '#142034', fontSize: 13, fontWeight: '600' },
  input: { minHeight: 52, paddingHorizontal: 14, backgroundColor: '#F5F7FC', borderColor: '#E4EBF5', borderWidth: 1, borderRadius: 11, fontSize: 23, letterSpacing: 8, color: '#142034' },
  button: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#087CFF', borderRadius: 11 },
  secondary: { backgroundColor: '#EAF4FF' },
  buttonText: { fontWeight: '600', fontSize: 14, color: '#fff', textAlign: 'center' },
  secondaryText: { color: '#087CFF' },
  pressed: { opacity: 0.65 },
  error: { color: '#DD4A61', fontSize: 13, backgroundColor: '#FFF0F2', padding: 10, borderRadius: 10 },
});
