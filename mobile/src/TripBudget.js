import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors } from './ui';

const rateField = ['dailyRate', 'Ставка за день'];
const expenseFields = [
  ['transport', 'Проезд'],
  ['lodging', 'Жильё'],
  ['meals', 'Питание'],
  ['other', 'Прочие расходы'],
];
const fields = [rateField, ...expenseFields];
const companyDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit',
});
const tenge = new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT', maximumFractionDigits: 0 });

export function tripBudgetDraft(value) {
  return Object.fromEntries(fields.map(([key]) => [key, value?.[key] == null ? '' : String(value[key])]));
}

export function tripBudgetPayload(draft) {
  const budget = {};
  for (const [key] of fields) {
    const raw = draft?.[key] ?? '';
    if (raw === '') continue;
    if (!/^\d{1,9}$/.test(raw)) return null;
    budget[key] = Number(raw);
  }
  return budget;
}

function dayNumber(value) {
  const parts = Object.fromEntries(companyDay.formatToParts(value).map(({ type, value: part }) => [type, Number(part)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000;
}

export function tripBudgetDays(start, end) {
  const first = start ? new Date(start) : null;
  const last = end ? new Date(end) : null;
  return first && last && Number.isFinite(+first) && Number.isFinite(+last) && last > first
    ? dayNumber(last) - dayNumber(first) + 1 : 0;
}

export function tripBudgetTotals(budget, start, end) {
  const days = tripBudgetDays(start, end);
  const dailyRate = budget?.dailyRate ?? 0;
  const workTotal = dailyRate * days;
  const expensesTotal = expenseFields.reduce((sum, [key]) => sum + (budget?.[key] ?? 0), 0);
  return { days, dailyRate, workTotal, expensesTotal, total: workTotal + expensesTotal };
}

function amount(value) {
  return tenge.format(value ?? 0);
}

function Totals({ days, dailyRate, workTotal, expensesTotal, total }) {
  return (
    <View style={styles.totals}>
      <View style={styles.amountRow}>
        <View style={styles.fill}>
          <Text style={styles.muted}>По дневной ставке</Text>
          <Text style={styles.muted}>{amount(dailyRate)} × {days} дн.</Text>
        </View>
        <Text style={styles.value}>{amount(workTotal)}</Text>
      </View>
      <View style={styles.amountRow}>
        <Text style={styles.muted}>Расходы за поездку</Text>
        <Text style={styles.value}>{amount(expensesTotal)}</Text>
      </View>
      <View style={styles.finalRow}>
        <View style={styles.fill}>
          <Text style={styles.label}>Итого</Text>
          <Text style={styles.muted}>Календарных дней по времени Алматы · {days}</Text>
        </View>
        <Text style={styles.total}>{amount(total)}</Text>
      </View>
    </View>
  );
}

function AmountField({ field, value, onChange, disabled, isRate = false }) {
  const [key, label] = field;
  return <View style={styles.entry}>
    <Text style={styles.label}>{label}</Text>
    <View style={styles.inputRow}>
      <TextInput accessibilityLabel={isRate ? 'Ставка за день в тенге' : label}
        keyboardType="number-pad" value={value[key]} editable={!disabled}
        placeholder={isRate ? 'Например, 15 000' : '0'} placeholderTextColor={colors.muted} maxLength={14}
        style={styles.input} onChangeText={text => onChange(previous => ({
          ...previous, [key]: text.replace(/\s/g, ''),
        }))} />
      <Text style={styles.value}>₸</Text>
    </View>
  </View>;
}

export function TripBudgetFields({ value, onChange, start, end, disabled = false, collapseExpenses = false,
  expensesAvailable = true }) {
  const [expanded, setExpanded] = useState(() => expenseFields.some(([key]) => Number(value[key]) > 0));
  const budget = tripBudgetPayload(expensesAvailable ? value : { dailyRate: value.dailyRate });
  const totals = tripBudgetTotals(budget, start, end);
  const showExpenses = expensesAvailable && (!collapseExpenses || expanded);
  const canCalculate = totals.days > 0 && (!collapseExpenses || budget?.dailyRate != null);
  return (
    <View style={styles.fields}>
      <AmountField field={rateField} value={value} onChange={onChange} disabled={disabled} isRate={collapseExpenses} />
      {collapseExpenses && expensesAvailable && <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
        onPress={() => setExpanded(previous => !previous)} style={styles.expensesToggle}>
        <Text style={styles.link}>{expanded ? 'Скрыть расходы' : 'Добавить расходы · необязательно'}</Text>
      </Pressable>}
      {showExpenses && <Text style={styles.muted}>Расходы укажите за всю поездку.</Text>}
      {showExpenses && expenseFields.map(field => (
        <AmountField key={field[0]} field={field} value={value} onChange={onChange} disabled={disabled} />
      ))}
      {!budget ? <Text accessibilityRole="alert" style={styles.error}>Укажите целые суммы от 0 до 999 999 999 ₸.</Text>
        : canCalculate ? <Totals {...totals} /> : <Text style={styles.muted}>
          {collapseExpenses ? 'Укажите даты поездки и дневную ставку для расчёта.' : 'Выберите даты и время поездки для расчёта.'}
        </Text>}
    </View>
  );
}

export function TripBudgetSummary({ title, value }) {
  if (!value) return null;
  return (
    <View style={styles.summary}>
      {title ? <Text accessibilityRole="header" style={styles.label}>{title}</Text> : null}
      {expenseFields.filter(([key]) => value[key] > 0).map(([key, label]) => (
        <View key={key} style={styles.amountRow}>
          <Text style={styles.muted}>{label}</Text>
          <Text style={styles.value}>{amount(value[key])}</Text>
        </View>
      ))}
      <Totals {...value} />
    </View>
  );
}

const styles = StyleSheet.create({
  fields: { gap: 8 },
  entry: { gap: 4 },
  fill: { flex: 1 },
  label: { color: colors.ink, fontWeight: '700', fontSize: 14 },
  muted: { color: '#536680', fontSize: 13, lineHeight: 18, flexShrink: 1 },
  value: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  amountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.canvas, borderRadius: 10, paddingRight: 12 },
  input: { flex: 1, minHeight: 44, paddingHorizontal: 12, color: colors.ink, fontSize: 15 },
  expensesToggle: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  link: { color: colors.blue, fontSize: 14, fontWeight: '600' },
  totals: { backgroundColor: colors.tint, padding: 10, borderRadius: 10, gap: 7 },
  finalRow: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#B9D3F3',
    paddingTop: 7, gap: 8 },
  total: { color: '#185DB0', fontSize: 19, fontWeight: '700' },
  summary: { gap: 7, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 11 },
  error: { color: '#9F2329', fontSize: 13, lineHeight: 18 },
});
