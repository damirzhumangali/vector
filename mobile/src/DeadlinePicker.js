import React, { useState } from 'react';
import { Keyboard, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, colors } from './ui';

function validDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function startOfDay(value) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function sameDay(left, right) {
  return validDate(left) && validDate(right)
    && left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

export function defaultDeadline(now = new Date()) {
  const date = new Date(now.getTime());
  date.setHours(18, 0, 0, 0);
  if (date <= now) date.setHours(now.getHours() + 1, 0, 0, 0);
  return date;
}

export function mergeDeadline(base, selection, mode) {
  const date = new Date(base.getTime());
  if (mode === 'date') {
    date.setFullYear(selection.getFullYear(), selection.getMonth(), selection.getDate());
  } else {
    date.setHours(selection.getHours(), selection.getMinutes(), 0, 0);
  }
  return date;
}

export function quickDeadline(offset, current, now = new Date()) {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  if (validDate(current)) date.setHours(current.getHours(), current.getMinutes(), 0, 0);
  else date.setHours(18, 0, 0, 0);
  if (offset !== 0 || date > now) return date;
  const nextHour = defaultDeadline(now);
  if (sameDay(nextHour, now)) return nextHour;
  const nextMinute = new Date(now.getTime());
  nextMinute.setSeconds(0, 0);
  nextMinute.setMinutes(nextMinute.getMinutes() + 1);
  return sameDay(nextMinute, now) ? nextMinute : null;
}

export function deadlineToIso(value) {
  return validDate(value) ? value.toISOString() : null;
}

export default function DeadlinePicker({ value, onChange, disabled = false }) {
  const [editor, setEditor] = useState(null);
  const [draft, setDraft] = useState(null);
  const insets = useSafeAreaInsets();
  const selected = validDate(value) ? value : null;
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const todayAvailable = validDate(quickDeadline(0, selected, today));

  function open(mode) {
    if (disabled) return;
    Keyboard.dismiss();
    setDraft(selected ? new Date(selected.getTime()) : defaultDeadline());
    setEditor(mode);
  }

  function close() {
    setEditor(null);
    setDraft(null);
  }

  function commit() {
    if (disabled || !validDate(draft)) return;
    onChange(new Date(draft.getTime()));
    close();
  }

  function change(event, nextDate) {
    if (Platform.OS === 'android') {
      if (!disabled && event.type === 'set' && validDate(nextDate)) {
        onChange(mergeDeadline(draft, nextDate, editor));
      }
      close();
      return;
    }
    if (!disabled && event.type !== 'dismissed' && validDate(nextDate)) {
      setDraft(current => mergeDeadline(current, nextDate, editor));
    }
  }

  function chooseDay(offset) {
    if (disabled) return;
    const next = quickDeadline(offset, selected);
    if (validDate(next)) onChange(next);
  }

  const nativePicker = editor && validDate(draft) ? (
    <DateTimePicker
      value={draft}
      mode={editor}
      display={Platform.OS === 'ios' ? 'spinner' : 'default'}
      minimumDate={editor === 'date' ? startOfDay(today) : undefined}
      locale="ru-RU"
      is24Hour
      themeVariant="light"
      disabled={disabled}
      onChange={change}
      style={styles.nativePicker}
    />
  ) : null;

  return (
    <View style={styles.container}>
      <View style={styles.heading}>
        <Text style={styles.label}>Выполнить до</Text>
        {selected ? <Pressable accessibilityRole="button" accessibilityLabel="Убрать срок выполнения"
          accessibilityState={{ disabled }} disabled={disabled}
          onPress={() => { if (!disabled) onChange(null); }} style={styles.clear}>
          <Text style={styles.link}>Без срока</Text>
        </Pressable> : <Text style={styles.optional}>Необязательно</Text>}
      </View>
      <View style={styles.quickRow}>
        {[[0, 'Сегодня', today], [1, 'Завтра', tomorrow]].map(([offset, label, day]) => (
          <Pressable key={offset} accessibilityRole="button" accessibilityLabel={`Выполнить ${label.toLowerCase()}`}
            accessibilityState={{ disabled: disabled || (offset === 0 && !todayAvailable), selected: sameDay(selected, day) }}
            disabled={disabled || (offset === 0 && !todayAvailable)}
            onPress={() => chooseDay(offset)}
            style={({ pressed }) => [styles.quick, sameDay(selected, day) && styles.quickSelected,
              (pressed || disabled || (offset === 0 && !todayAvailable)) && styles.dimmed]}>
            <Text style={[styles.quickText, sameDay(selected, day) && styles.quickTextSelected]}>{label}</Text>
          </Pressable>
        ))}
        <Pressable accessibilityRole="button" accessibilityLabel="Выбрать дату выполнения"
          accessibilityState={{ disabled }} disabled={disabled} onPress={() => open('date')}
          style={({ pressed }) => [styles.quick, (pressed || disabled) && styles.dimmed]}>
          <Text style={styles.quickText}>Выбрать дату</Text>
        </Pressable>
      </View>
      <View style={styles.fields}>
        <Pressable accessibilityRole="button" accessibilityLabel={selected
          ? `Дата выполнения: ${selected.toLocaleDateString('ru-RU')}` : 'Выбрать дату выполнения'}
          accessibilityState={{ disabled }} disabled={disabled} onPress={() => open('date')}
          style={({ pressed }) => [styles.field, (pressed || disabled) && styles.dimmed]}>
          <Icon name="calendar" size={21} />
          <View style={styles.fieldContent}>
            <Text style={styles.caption}>Дата</Text>
            <Text style={styles.fieldValue}>{selected
              ? selected.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
              : 'Не выбрана'}</Text>
          </View>
          <Icon name="chevron-right" color={colors.muted} size={16} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={selected
          ? `Время выполнения: ${selected.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false })}`
          : 'Выбрать время выполнения'}
          accessibilityState={{ disabled }} disabled={disabled} onPress={() => open('time')}
          style={({ pressed }) => [styles.field, (pressed || disabled) && styles.dimmed]}>
          <Icon name="clock" size={21} />
          <View style={styles.fieldContent}>
            <Text style={styles.caption}>Время</Text>
            <Text style={styles.fieldValue}>{selected
              ? selected.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false })
              : 'Не выбрано'}</Text>
          </View>
          <Icon name="chevron-right" color={colors.muted} size={16} />
        </Pressable>
      </View>
      <Text style={styles.helper}>{selected
        ? 'Дата и время по часовому поясу вашего телефона.'
        : 'Можно создать заявку без срока или выбрать удобную дату и время.'}</Text>
      {Platform.OS === 'ios' ? (
        <Modal transparent animationType="slide" visible={Boolean(editor)} onRequestClose={close}>
          <View style={styles.modal}>
            <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button"
              accessibilityLabel="Отменить выбор срока" onPress={close} />
            <View accessibilityViewIsModal style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
              <View style={styles.handle} />
              <View style={styles.toolbar}>
                <Pressable accessibilityRole="button" onPress={close} style={styles.toolbarButton}>
                  <Text style={styles.link}>Отмена</Text>
                </Pressable>
                <Text accessibilityRole="header" style={styles.sheetTitle}>{editor === 'date' ? 'Дата выполнения' : 'Время выполнения'}</Text>
                <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
                  onPress={commit} style={[styles.toolbarButton, disabled && styles.dimmed]}>
                  <Text style={[styles.link, styles.done]}>Готово</Text>
                </Pressable>
              </View>
              {nativePicker}
            </View>
          </View>
        </Modal>
      ) : nativePicker}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 10, marginTop: 8 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  label: { fontSize: 15, fontWeight: '600', color: colors.ink },
  optional: { fontSize: 12, color: colors.muted },
  clear: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  link: { color: colors.blue, fontSize: 14 },
  quickRow: { flexDirection: 'row', gap: 7 },
  quick: { flex: 1, minHeight: 42, backgroundColor: colors.canvas, borderRadius: 10,
    justifyContent: 'center', alignItems: 'center', paddingHorizontal: 5 },
  quickSelected: { backgroundColor: colors.blue },
  quickText: { fontSize: 12, fontWeight: '600', color: colors.blue },
  quickTextSelected: { color: '#FFFFFF' },
  fields: { gap: 8 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 60, paddingHorizontal: 12,
    paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.canvas },
  fieldContent: { flex: 1, gap: 2 },
  caption: { fontSize: 11, color: colors.muted },
  fieldValue: { fontSize: 15, fontWeight: '500', color: colors.ink },
  helper: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  dimmed: { opacity: 0.6 },
  modal: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(20,32,52,0.35)' },
  sheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 10 },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 8 },
  toolbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 12, gap: 4 },
  toolbarButton: { minHeight: 44, minWidth: 66, justifyContent: 'center', alignItems: 'center' },
  sheetTitle: { color: colors.ink, fontSize: 15, fontWeight: '600', textAlign: 'center', flex: 1 },
  done: { fontWeight: '700' },
  nativePicker: { height: 216, alignSelf: 'stretch' },
});
