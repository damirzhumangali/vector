import { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { apiRequest } from './api';

const channel = 'qwork-incidents';
const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId
  ?? process.env.EXPO_PUBLIC_QWORK_EAS_PROJECT_ID;
const supported = (Platform.OS === 'ios' || Platform.OS === 'android') && Boolean(projectId)
  && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;

export function isIncidentNotification(data) {
  return data?.type === 'urgent_leave' || data?.type === 'emergency';
}

function canNotify(permission) {
  return permission.granted || permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

export function useIncidentNotifications(session, sessionRef, onOpen) {
  const [status, setStatus] = useState('');
  const enable = useRef(null);
  const open = useRef(onOpen);
  open.current = onOpen;

  useEffect(() => {
    setStatus('');
    if (!session || !supported) return;
    let closed = false;
    let running = false;
    let prompted = false;
    let opened;
    const current = () => !closed && sessionRef.current === session;

    async function register(prompt) {
      if (!current() || running) return;
      running = true;
      if (prompt) setStatus('Подключение…');
      try {
        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync(channel, {
            name: 'Срочные события qwork', importance: Notifications.AndroidImportance.HIGH,
          });
        }
        let permission = await Notifications.getPermissionsAsync();
        if (!canNotify(permission) && prompt && current()) {
          if (permission.canAskAgain && !prompted) {
            prompted = true;
            permission = await Notifications.requestPermissionsAsync();
          } else {
            await Linking.openSettings();
          }
        }
        if (!current()) return;
        if (!canNotify(permission)) {
          setStatus('Разрешите уведомления на телефоне');
          return;
        }
        const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
        if (!current()) return;
        await apiRequest('/notifications/device', { method: 'POST', body: { token }, token: session.token });
        if (current()) setStatus('Подключены на этом телефоне');
      } catch {
        if (current()) setStatus('Не удалось подключить. Нажмите, чтобы повторить');
      } finally {
        running = false;
      }
    }

    function handle(response) {
      const request = response?.notification.request;
      const data = request?.content.data;
      if (!current() || !isIncidentNotification(data) || data.userId !== String(session.user.id)
        || request.identifier === opened) return;
      opened = request.identifier;
      Notifications.clearLastNotificationResponse();
      open.current(session.user.role === 'employee' ? 'shifts' : 'operations');
    }

    enable.current = () => { void register(true); };
    const subscription = Notifications.addNotificationResponseReceivedListener(handle);
    const tokenListener = Notifications.addPushTokenListener(() => { void register(false); });
    const foreground = AppState.addEventListener('change', state => {
      if (state === 'active') void register(false);
    });
    handle(Notifications.getLastNotificationResponse());
    void register(false);
    return () => {
      closed = true;
      enable.current = null;
      subscription.remove();
      tokenListener.remove();
      foreground.remove();
    };
  }, [session, sessionRef]);

  return {
    status: supported ? status || 'Срочный уход и аварийные назначения' : 'Доступны в сборке qwork с push',
    enable: supported ? () => enable.current?.() : null,
  };
}
