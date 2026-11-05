import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { isIncidentNotification } from './incidentNotifications';

const channel = 'qwork-shifts';
const prefix = 'qwork-shift-';
const leadTime = 30 * 60 * 1000;
const scheduleWindow = 7 * 24 * 60 * 60 * 1000;
let operations = Promise.resolve();
let permissionAsked = false;

Notifications.setNotificationHandler({
  handleNotification: async notification => ({
    shouldShowBanner: true, shouldShowList: true,
    shouldPlaySound: isIncidentNotification(notification.request.content.data), shouldSetBadge: false,
  }),
});

export function updateShiftReminders(shifts, isCurrent = () => true) {
  operations = operations.catch(() => {}).then(async () => {
    if (!isCurrent()) return;
    const now = Date.now();
    const desired = new Map();
    for (const shift of shifts) {
      const when = Date.parse(shift.endsAt) - leadTime;
      if (!shift.finishedAt && !shift.decision && when > now && when < now + scheduleWindow) {
        desired.set(prefix + shift.id + '-' + when, when);
      }
    }
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    if (!isCurrent()) return;
    const kept = new Set();
    for (const entry of scheduled) {
      if (!entry.identifier.startsWith(prefix)) continue;
      if (desired.has(entry.identifier)) kept.add(entry.identifier);
      else await Notifications.cancelScheduledNotificationAsync(entry.identifier);
    }
    if (![...desired.keys()].some(id => !kept.has(id)) || !isCurrent()) return;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(channel, {
        name: 'Смены qwork', importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain && !permissionAsked && isCurrent()) {
      permissionAsked = true;
      permission = await Notifications.requestPermissionsAsync();
    }
    if (!permission.granted) return;
    for (const [identifier, when] of desired) {
      if (!isCurrent()) return;
      if (kept.has(identifier) || when <= Date.now()) continue;
      await Notifications.scheduleNotificationAsync({
        identifier,
        content: {
          title: 'До конца смены 30 минут',
          body: 'Проверьте незавершённые заявки в qwork.',
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(when), channelId: channel },
      });
    }
  });
  return operations;
}
