import React, { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View, ScrollView } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { colors as c, Icon } from './ui';

const CLOSED = ['done', 'cancelled', 'repeated'];

function taskDeadline(task) {
  return typeof task?.deadline === 'string' ? Date.parse(task.deadline) : NaN;
}

function formatDeadline(deadline) {
  return new Date(deadline).toLocaleString('ru-RU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function ProgressCircle({ progress, color = c.blue, label, children }) {
  const radius = 98;
  const length = 2 * Math.PI * radius;
  return (
    <View style={styles.progressArea} accessible accessibilityLabel={label}>
      <Svg width={234} height={234} viewBox="0 0 234 234">
        <Circle cx="117" cy="117" r={radius} stroke="#E7EDF6" strokeWidth="8" fill="#FFFFFF" />
        {progress > 0 && <Circle cx="117" cy="117" r={radius} stroke={color} strokeWidth="8" fill="none"
          strokeDasharray={`${length * progress} ${length}`} strokeLinecap="round" rotation="-90" origin="117,117" />}
      </Svg>
      <View style={styles.progressText}>{children}</View>
    </View>
  );
}

function timerText(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  if (days > 0) return `${days} д ${hours} ч`;
  return [hours, Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':');
}

function TaskCountdown({ task, deadline }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = setInterval(update, 1000);
    const foreground = AppState.addEventListener('change', state => { if (state === 'active') update(); });
    return () => {
      clearInterval(timer);
      foreground.remove();
    };
  }, []);

  const remaining = deadline - now;
  const overdue = remaining <= 0;
  const seconds = overdue ? Math.floor(-remaining / 1000) : Math.ceil(remaining / 1000);
  const time = timerText(seconds);
  const assignment = [...(task.history ?? [])].reverse().find(event => event.status === 'assigned');
  const duration = deadline - Date.parse(assignment?.createdAt);
  const progress = overdue ? 1 : duration > 0 ? Math.min(1, remaining / duration) : 0;
  const caption = overdue ? 'Время просрочки' : 'Осталось на задачу';
  const due = formatDeadline(deadline);

  return (
    <ProgressCircle progress={progress} color={overdue ? c.red : c.blue}
      label={`Заявка №${task.id}. ${caption} ${time}. Срок ${due}`}>
      <Text style={styles.timerTask}>Заявка №{task.id}</Text>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}
        style={[styles.timerValue, overdue && styles.timerOverdue]}>{time}</Text>
      <Text style={styles.progressCaption}>{caption}</Text>
      <Text style={styles.small}>Срок · {due}</Text>
    </ProgressCircle>
  );
}

export default function EmployeeDashboard({ tasks, name, onSelect }) {
  const active = tasks.filter(task => !CLOSED.includes(task.status) && task.status !== 'review');
  const completed = tasks.filter(task => task.status === 'done').length;
  const review = tasks.filter(task => task.status === 'review').length;
  const next = active.find(task => ['work', 'arrived', 'travel', 'rework'].includes(task.status)) ?? active[0];
  const otherTasks = active.filter(task => task.id !== next?.id).slice(0, 3);
  const deadline = taskDeadline(next);
  const hasDeadline = Number.isFinite(deadline);
  const progress = tasks.length ? completed / tasks.length : 0;
  const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' });
  const firstName = name?.trim().split(/\s+/)[0];
  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <Text accessibilityRole="header" style={styles.title}>{firstName ? `Здравствуйте, ${firstName}` : 'Мой рабочий день'}</Text>
      <View style={styles.dateCard}>
        <View style={styles.iconBox}><Icon name="calendar" size={25} /></View>
        <View style={styles.flex}>
          <Text style={styles.rowTitle}>Сегодня</Text>
          <Text style={styles.small}>{today}</Text>
          {hasDeadline && <Text style={styles.small}>Завершено {completed} из {tasks.length}</Text>}
        </View>
        {active.length > 0 ? (
          <View style={styles.dateBadge}><Text style={styles.badgeText}>{active.length} в работе</Text></View>
        ) : <Text style={styles.small}>Нет активных задач</Text>}
      </View>
      {hasDeadline ? <TaskCountdown key={next.id} task={next} deadline={deadline} /> : (
        <ProgressCircle progress={progress} label={`Завершено ${completed} из ${tasks.length} задач`}>
          <Text style={styles.progressValue}>{completed}<Text style={styles.progressDivider}> / {tasks.length}</Text></Text>
          <Text style={styles.progressCaption}>задач завершено</Text>
          {review > 0 && <Text style={styles.small}>{review} на проверке</Text>}
        </ProgressCircle>
      )}
      {next && (
        <View style={styles.current}>
          <Text style={styles.rowTitle}>{next.title}</Text>
          {next.object ? (
            <View style={styles.location}><Icon name="pin" size={15} color={c.muted} /><Text style={styles.small}>{next.object}</Text></View>
          ) : null}
          <Pressable accessibilityRole="button" onPress={() => onSelect(next.id)}
            style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
            <Icon name="play" color="#fff" size={21} />
            <Text style={styles.primaryText}>Открыть текущую задачу</Text>
            <Icon name="chevron-right" color="#fff" size={19} />
          </Pressable>
        </View>
      )}
      {otherTasks.length > 0 && (
        <View style={styles.otherTasks}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>Другие задачи</Text>
          {otherTasks.map(task => {
            const due = taskDeadline(task);
            const detail = Number.isFinite(due) ? `До ${formatDeadline(due)}` : task.object;
            return (
              <Pressable key={task.id} accessibilityRole="button" onPress={() => onSelect(task.id)}
                style={({ pressed }) => [styles.otherTask, pressed && styles.pressed]}>
                <View style={styles.iconBox}><Icon name="clipboard" size={21} /></View>
                <View style={styles.flex}>
                  <Text style={styles.rowTitle} numberOfLines={2}>{task.title}</Text>
                  {detail ? <Text style={styles.small}>{detail}</Text> : null}
                </View>
                <Icon name="chevron-right" size={18} color={c.muted} />
              </Pressable>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 9, paddingBottom: 22, gap: 11 },
  title: { fontSize: 26, fontWeight: '700', letterSpacing: -.7, color: c.ink, marginBottom: 3 },
  dateCard: { backgroundColor: '#fff', borderRadius: 14, padding: 12, flexDirection: 'row', gap: 10, alignItems: 'center' },
  iconBox: { width: 39, height: 39, borderRadius: 11, backgroundColor: '#F1F7FF', alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, gap: 3 },
  rowTitle: { fontSize: 14, fontWeight: '600', color: c.ink, lineHeight: 19 },
  small: { fontSize: 12, color: c.muted, lineHeight: 17 },
  dateBadge: { borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: c.tint },
  badgeText: { color: c.blue, fontSize: 11, fontWeight: '600' },
  progressArea: { alignItems: 'center', justifyContent: 'center', marginVertical: -4 },
  progressText: { position: 'absolute', width: 184, alignItems: 'center', gap: 5 },
  progressValue: { fontSize: 44, fontWeight: '600', letterSpacing: -2, color: c.ink, fontVariant: ['tabular-nums'] },
  progressDivider: { fontSize: 25, color: c.muted, fontWeight: '500', letterSpacing: -.5 },
  progressCaption: { color: '#7F91AE', fontSize: 13 },
  timerTask: { color: c.muted, fontSize: 12, fontWeight: '600' },
  timerValue: { color: c.ink, fontSize: 34, fontWeight: '700', letterSpacing: -1, fontVariant: ['tabular-nums'] },
  timerOverdue: { color: '#C53E54' },
  primary: { backgroundColor: c.blue, borderRadius: 12, minHeight: 50, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', gap: 9 },
  primaryText: { flex: 1, color: '#fff', fontWeight: '600', fontSize: 14 },
  pressed: { opacity: .65 },
  current: { backgroundColor: '#fff', borderRadius: 14, padding: 14, gap: 8 },
  location: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  otherTasks: { gap: 8, marginTop: 3 },
  sectionTitle: { fontSize: 16, color: c.ink, fontWeight: '700' },
  otherTask: { backgroundColor: '#fff', borderRadius: 14, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
});
