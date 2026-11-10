import React, { useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { tripBudgetDraft, tripBudgetPayload } from './TripBudget';
import { colors } from './ui';

const categories = [
  ['transport', 'Проезд'],
  ['lodging', 'Жильё'],
  ['meals', 'Питание'],
  ['other', 'Прочие расходы'],
];
const zeroExpenses = Object.fromEntries(categories.map(([key]) => [key, 0]));
const moneyFormat = new Intl.NumberFormat('ru-KZ', {
  style: 'currency', currency: 'KZT', maximumFractionDigits: 0,
});
const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });

function amount(value) {
  return value == null ? '—' : moneyFormat.format(value);
}

function plannedAmounts(budget, total) {
  if (!budget || total == null) return null;
  const amounts = categories.map(([key]) => [key, budget[key]]);
  if (amounts.some(([, value]) => !Number.isInteger(value) || value < 0 || value > 999999999)) return null;
  return amounts.reduce((sum, [, value]) => sum + value, 0) === total ? Object.fromEntries(amounts) : null;
}

function ExpenseComparison({ label, plan, actual }) {
  return <View style={styles.comparison}>
    <Text style={styles.label}>{label}</Text>
    <View style={styles.columns}>
      <View style={styles.column}>
        <Text style={styles.muted}>План</Text>
        <Text style={styles.amount}>{amount(plan)}</Text>
      </View>
      <View style={styles.column}>
        <Text style={styles.muted}>Факт</Text>
        <Text style={styles.amount}>{amount(actual)}</Text>
      </View>
    </View>
  </View>;
}

function Action({ children, onPress, disabled, primary }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, primary && styles.primary, (disabled || pressed) && styles.dim]}>
    <Text style={[styles.buttonText, primary && styles.primaryText]}>{children}</Text>
  </Pressable>;
}

export function TripActualExpenses({ value, plannedBudget, employee, canEdit, offline = false, busy = false, error, onSave }) {
  const [draft, setDraft] = useState(null);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  if (!value) return null;
  const editable = employee && canEdit && typeof onSave === 'function';
  const showForm = editable && draft !== null;
  const disabled = offline || busy || sending;
  const hasActual = value.expensesTotal != null;
  const plan = plannedAmounts(plannedBudget, value.plannedExpensesTotal);
  const delta = value.expenseDelta ?? value.totalDelta;
  const updated = value.updatedAt ? +new Date(value.updatedAt) : NaN;
  const budget = showForm ? tripBudgetPayload(draft.amounts) : null;
  const draftTotal = budget ? categories.reduce((sum, [key]) => sum + (budget[key] ?? 0), 0) : null;

  function startEdit() {
    const { dailyRate: _dailyRate, ...amounts } = tripBudgetDraft(hasActual ? value : plan);
    setDraft({ amounts, note: value.note ?? '', revision: value.revision, fromPlan: !hasActual && Boolean(plan) });
  }

  async function saveExpenses(fields, note, expectedRevision) {
    if (!editable || disabled || inFlight.current) return false;
    inFlight.current = true;
    setSending(true);
    Keyboard.dismiss();
    try {
      return await onSave({ ...fields, note, expectedRevision });
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  async function save() {
    if (!showForm || !budget) return;
    const fields = Object.fromEntries(categories.map(([key]) => [key, budget[key] ?? 0]));
    if (await saveExpenses(fields, draft.note.trim(), draft.revision)) setDraft(null);
  }

  function confirmExpenses(fields) {
    if (!hasActual && !showForm && fields) void saveExpenses(fields, '', value.revision);
  }

  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>Фактические расходы</Text>
    <ExpenseComparison label="Расходы за поездку" plan={value.plannedExpensesTotal} actual={value.expensesTotal} />
    {delta != null && <Text style={[styles.delta, delta > 0 && styles.over]}>
      {delta > 0 ? 'Перерасход · ' + amount(delta) : delta < 0 ? 'Экономия · ' + amount(-delta) : 'Расходы по плану'}
    </Text>}
    {value.workTotal != null ? <View style={styles.row}>
      <Text style={styles.muted}>Согласованная оплата</Text>
      <Text style={styles.amount}>{amount(value.workTotal)}</Text>
    </View> : null}
    <ExpenseComparison label="Итого по поездке" plan={value.plannedTotal} actual={value.actualTotal} />
    {!hasActual && !showForm && <Text style={styles.muted}>Фактические расходы ещё не внесены.</Text>}
    {hasActual && !showForm && <View style={styles.details}>
      {categories.map(([key, label]) => <View key={key} style={styles.row}>
        <Text style={styles.muted}>{label}</Text>
        <Text style={styles.amount}>{amount(value[key])}</Text>
      </View>)}
      {value.note ? <Text style={styles.note}>{value.note}</Text> : null}
      {Number.isFinite(updated) ? <Text style={styles.muted}>Обновлено · {dateFormat.format(updated)}</Text> : null}
    </View>}
    {showForm ? <View style={styles.details}>
      <Text style={styles.muted}>{draft.fromPlan
        ? 'Подставили плановые суммы. Измените те, которые отличаются от фактических. Пустое поле считается нулём.'
        : 'Укажите фактические суммы за всю поездку. Пустое поле считается нулём.'}</Text>
      {categories.map(([key, label]) => <View key={key} style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <View style={styles.inputRow}>
          <TextInput accessibilityLabel={label} keyboardType="number-pad" editable={!disabled}
            value={draft.amounts[key]} onChangeText={text => setDraft(previous => ({
              ...previous, amounts: { ...previous.amounts, [key]: text.replace(/\s/g, '') },
            }))} placeholder="0" placeholderTextColor={colors.muted} maxLength={14} style={styles.input} />
          <Text style={styles.amount}>₸</Text>
        </View>
      </View>)}
      <Text style={styles.label}>Комментарий · необязательно</Text>
      <TextInput accessibilityLabel="Комментарий к расходам" value={draft.note} maxLength={1000}
        multiline editable={!disabled} onChangeText={note => setDraft(previous => ({ ...previous, note }))}
        placeholder="Что повлияло на расходы" placeholderTextColor={colors.muted} style={styles.noteInput} />
      {budget ? <View style={styles.row}>
        <Text style={styles.label}>Фактические расходы к сохранению</Text>
        <Text style={styles.amount}>{amount(draftTotal)}</Text>
      </View> : <Text accessibilityRole="alert" style={styles.error}>Укажите целые суммы от 0 до 999 999 999 ₸.</Text>}
      <Action primary disabled={disabled || !budget} onPress={() => { void save(); }}>
        {sending ? 'Сохраняем…' : 'Сохранить фактические расходы'}
      </Action>
      <Action disabled={busy || sending} onPress={() => setDraft(null)}>Отмена</Action>
    </View> : editable ? <>
      {!hasActual && plan && <Action disabled={disabled} onPress={() => confirmExpenses(plan)}>
        Расходы по плану
      </Action>}
      {!hasActual && <Action disabled={disabled} onPress={() => confirmExpenses(zeroExpenses)}>
        Расходов не было
      </Action>}
      <Action disabled={disabled} onPress={startEdit}>
        {hasActual ? 'Изменить расходы' : plan ? 'Указать отличия от плана' : 'Указать фактические расходы'}
      </Action>
      {sending && <Text accessibilityLiveRegion="polite" style={styles.muted}>Сохраняем расходы…</Text>}
    </> : null}
    {editable && offline ? <Text style={styles.muted}>Для сохранения расходов нужен интернет.</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', borderColor: colors.border, borderWidth: 1, borderRadius: 14, padding: 14, gap: 9 },
  title: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  label: { flexShrink: 1, color: colors.ink, fontSize: 14, fontWeight: '700' },
  muted: { flexShrink: 1, color: '#536680', fontSize: 13, lineHeight: 18 },
  amount: { flexShrink: 1, color: colors.ink, fontSize: 14, fontWeight: '600' },
  comparison: { gap: 6 },
  columns: { flexDirection: 'row', gap: 8 },
  column: { flex: 1, minWidth: 0, backgroundColor: colors.canvas, borderRadius: 9, padding: 8, gap: 3 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  details: { gap: 8, borderTopWidth: 1, borderColor: colors.border, paddingTop: 8 },
  field: { gap: 4 },
  delta: { alignSelf: 'flex-start', color: '#176443', backgroundColor: '#EAF8F0',
    paddingHorizontal: 8, paddingVertical: 5, borderRadius: 7, fontSize: 13, fontWeight: '600' },
  over: { color: '#80550F', backgroundColor: '#FFF6E6' },
  note: { color: colors.ink, fontSize: 14, lineHeight: 19 },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.canvas,
    borderRadius: 9, paddingRight: 10 },
  input: { flex: 1, minHeight: 44, paddingHorizontal: 10, color: colors.ink, fontSize: 15 },
  noteInput: { minHeight: 70, padding: 9, color: colors.ink, textAlignVertical: 'top',
    borderWidth: 1, borderColor: colors.border, borderRadius: 9, backgroundColor: colors.canvas },
  button: { minHeight: 44, justifyContent: 'center', alignItems: 'center', padding: 8,
    borderRadius: 9, backgroundColor: colors.tint },
  primary: { backgroundColor: '#136BC9' },
  buttonText: { color: '#185DB0', fontWeight: '600', textAlign: 'center', fontSize: 14 },
  primaryText: { color: '#fff' },
  dim: { opacity: 0.55 },
  error: { color: '#9F2329', fontSize: 13, lineHeight: 18 },
});
