import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TaskPhotoGallery } from './TaskPhotos';
import { colors, Icon } from './ui';

export const PRIORITY_LABELS = { 1: 'Низкий', 2: 'Обычный', 3: 'Высокий' };

export const CHECKLIST_OUTCOMES = {
  done: 'Выполнено',
  not_done: 'Не выполнено',
  problem: 'Выявлена проблема',
  follow_up: 'Требуется дополнительная работа',
};

export const RESULT_FIELDS = [
  ['work', 'Что сделано', 2000],
  ['findings', 'Что выявлено', 2000],
  ['measures', 'Какие меры приняты', 2000],
  ['materials', 'Материалы или оборудование', 1000],
];

export const DEFAULT_CHECKLIST_TITLES = [
  'Подтвердить безопасный доступ',
  'Осмотреть оборудование',
  'Выполнить работы по заданию',
  'Проверить результат',
  'Убрать рабочее место',
];

const EVENT_LABELS = {
  assigned: 'Заявка назначена',
  accepted: 'Сотрудник принял заявку',
  travel: 'Выезд',
  arrived: 'Прибытие',
  work: 'В работе',
  paused: 'Пауза',
  review: 'Отчёт отправлен',
  done: 'Работа принята',
  rework: 'Возвращена на доработку',
  unassigned: 'Возвращена в очередь',
  cancelled: 'Заявка отменена',
  repeated: 'Назначен повторный выезд',
  refused: 'Сотрудник отказался от заявки',
  reopened: 'Заявка переоткрыта',
};
const REPORT_KINDS = ['before', 'after', 'checklist'];

function dateTime(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU') : 'Нет отметки';
}

function Coordinates({ position }) {
  if (!Number.isFinite(position?.latitude) || !Number.isFinite(position?.longitude)) return null;
  return (
    <Text style={styles.muted}>
      {position.latitude.toFixed(5)}, {position.longitude.toFixed(5)}
      {Number.isFinite(position.accuracy) ? ` · точность ±${Math.round(position.accuracy)} м` : ''}
    </Text>
  );
}

export default function FieldReport({
  task, request, imageSource, revision, onClose, canReject, onRejected, children,
}) {
  const events = task.history ?? [];
  const currentVisit = events.slice(events.map(event => event.status).lastIndexOf('reopened') + 1);
  const start = currentVisit.find(event => event.status === 'work');
  const finish = currentVisit.filter(event => event.status === 'review').pop();
  const checklist = task.checklist ?? DEFAULT_CHECKLIST_TITLES.map((title, index) => ({
    id: String(index), title, status: task.checks?.[index] ? 'done' : null,
  }));
  const outcome = { ...task.outcome, work: task.outcome?.work || task.result || task.reportComment };
  const pairs = task.photoPairs?.length ? task.photoPairs : [{ key: 'main', label: 'Общий вид' }];

  return (
    <Modal animationType="slide" onRequestClose={onClose} visible>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <View style={styles.heading}>
            <Text accessibilityRole="header" style={styles.title}>Отчёт по выезду</Text>
            <Text style={styles.muted}>Заявка №{task.id} · {task.title}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Закрыть отчёт" onPress={onClose}
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
            <Icon name="close" size={21} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.label}>Объект и время</Text>
            <Text style={styles.body}>{task.object}{task.address && task.address !== task.object ? ` · ${task.address}` : ''}</Text>
            {task.assigneeName ? <Text style={styles.muted}>Исполнитель · {task.assigneeName}</Text> : null}
            {task.managerName ? <Text style={styles.muted}>Руководитель · {task.managerName}</Text> : null}
            {task.purpose ? <Text style={styles.body}>Цель · {task.purpose}</Text> : null}
            <Text style={styles.muted}>Начало работ · {dateTime(start?.createdAt)}</Text>
            <Text style={styles.muted}>Окончание работ · {dateTime(finish?.createdAt)}</Text>
            <Text style={styles.muted}>Статус · {EVENT_LABELS[task.status] ?? 'Заявка'}</Text>
          </View>
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.label}>Хронология выезда</Text>
            {events.length ? events.map((event, index) => (
              <View key={`${event.createdAt}-${index}`} style={styles.entry}>
                <Text style={styles.body}>{EVENT_LABELS[event.status] ?? event.status}</Text>
                <Text style={styles.muted}>{dateTime(event.createdAt)}{event.actorName ? ` · ${event.actorName}` : ''}</Text>
                <Coordinates position={event.position} />
                {event.reason ? <Text style={styles.body}>{event.reason}</Text> : null}
              </View>
            )) : <Text style={styles.muted}>Отметок пока нет.</Text>}
          </View>
          {request && imageSource && (
            <View style={styles.card}>
              <Text accessibilityRole="header" style={styles.label}>Сравнение «До / После»</Text>
              <TaskPhotoGallery taskId={task.id} request={request} imageSource={imageSource}
                kinds={REPORT_KINDS} photoPairs={pairs} compare location={task.address || task.object}
                checklist={checklist} revision={revision ?? task.revision}
                canReject={canReject} onRejected={onRejected} />
            </View>
          )}
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.label}>Чек-лист</Text>
            {checklist.map(item => (
              <View key={item.id} style={styles.entry}>
                <Text style={styles.body}>{item.title}</Text>
                <Text style={item.status && item.status !== 'done' ? styles.attention : styles.muted}>
                  {CHECKLIST_OUTCOMES[item.status] || 'Без отметки'}
                </Text>
                {item.comment ? <Text style={styles.muted}>{item.comment}</Text> : null}
              </View>
            ))}
          </View>
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.label}>Итог выезда</Text>
            {RESULT_FIELDS.some(([key]) => outcome[key]) ? RESULT_FIELDS.filter(([key]) => outcome[key]).map(([key, label]) => (
              <View key={key} style={styles.entry}>
                <Text style={styles.body}>{label}</Text>
                <Text style={styles.muted}>{outcome[key]}</Text>
              </View>
            )) : <Text style={styles.muted}>Сотрудник ещё не описал результат.</Text>}
          </View>
          {children}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 16 },
  heading: { flex: 1, gap: 4 },
  title: { fontSize: 23, fontWeight: '700', color: colors.ink },
  close: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.tint },
  pressed: { opacity: 0.75 },
  content: { paddingHorizontal: 16, paddingBottom: 24, gap: 12 },
  card: { padding: 14, gap: 9, borderRadius: 14, backgroundColor: '#FFFFFF' },
  label: { fontSize: 16, fontWeight: '600', color: colors.ink },
  body: { fontSize: 14, color: colors.ink, lineHeight: 20 },
  muted: { fontSize: 13, color: '#5E6F87', lineHeight: 19 },
  entry: { gap: 3, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  attention: { fontSize: 13, lineHeight: 19, color: '#A04F11' },
});
