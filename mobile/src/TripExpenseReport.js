import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, Icon } from './ui';

const categories = [
  ['transport', 'Проезд'],
  ['lodging', 'Жильё'],
  ['meals', 'Питание'],
  ['other', 'Прочие расходы'],
];
const statuses = { planned: 'Запланирована', active: 'В поездке', finished: 'Завершена' };
const tenge = new Intl.NumberFormat('ru-KZ', {
  style: 'currency', currency: 'KZT', maximumFractionDigits: 0,
});
const tripDate = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Almaty',
});

function money(value) {
  return value == null ? '—' : tenge.format(value);
}

function difference(value) {
  return value > 0 ? '+' + money(value) : money(value);
}

function date(value) {
  if (!value) return '';
  const dateValue = new Date(value);
  return Number.isFinite(+dateValue) ? tripDate.format(dateValue) : '';
}

function tripPeriod(start, end) {
  const dates = [date(start), date(end)].filter(Boolean);
  return [...new Set(dates)].join(' — ');
}

function ExpensesSummary({ summary }) {
  const progress = summary.tripCount ? summary.actualCount / summary.tripCount : 0;
  return (
    <View style={styles.card}>
      <View style={styles.headingRow}>
        <View style={styles.flex}>
          <Text style={styles.muted}>План расходов по всем поездкам</Text>
          <Text style={styles.total}>{money(summary.plannedTotal)}</Text>
        </View>
        <View style={styles.iconBox}><Icon name="briefcase" size={21} /></View>
      </View>
      {summary.plannedCount < summary.tripCount && (
        <Text style={styles.muted}>План указан для {summary.plannedCount} из {summary.tripCount} поездок.</Text>
      )}
      <View style={styles.coverage}>
        <Text style={styles.label}>Факт внесён</Text>
        <Text style={styles.label}>{summary.actualCount} из {summary.tripCount}</Text>
      </View>
      <View
        style={styles.track}
        accessibilityRole="progressbar"
        accessibilityLabel="Поездки с внесёнными расходами"
        accessibilityValue={{
          min: 0, max: Math.max(1, summary.tripCount), now: summary.actualCount,
          text: `${summary.actualCount} из ${summary.tripCount}`,
        }}
      >
        <View style={[styles.progress, { width: `${progress * 100}%` }]} />
      </View>
      {summary.actualTotal != null && (
        <View style={styles.coverage}>
          <Text style={styles.muted}>Всего внесено расходов</Text>
          <Text style={styles.amount}>{money(summary.actualTotal)}</Text>
        </View>
      )}
      {summary.comparableCount > 0 ? (
        <View style={styles.comparison}>
          <Text style={styles.muted}>Поездки с планом и фактом · {summary.comparableCount}</Text>
          <View style={styles.amountRow}>
            <View style={styles.amountTile}><Text style={styles.muted}>План</Text>
              <Text style={styles.amount}>{money(summary.comparablePlannedTotal)}</Text></View>
            <View style={styles.amountTile}><Text style={styles.muted}>Факт</Text>
              <Text style={styles.amount}>{money(summary.comparableActualTotal)}</Text></View>
          </View>
          <View style={styles.coverage}>
            <Text style={styles.label}>
              {summary.delta > 0 ? 'Перерасход' : summary.delta < 0 ? 'Экономия' : 'Расходы по плану'}
            </Text>
            <Text style={[styles.amount, summary.delta > 0 ? styles.over : styles.under]}>
              {difference(summary.delta)}
            </Text>
          </View>
        </View>
      ) : (
        <Text style={styles.muted}>Сравнение появится, когда для одной поездки будут указаны план и факт.</Text>
      )}
    </View>
  );
}

function ExpenseRow({ label, plan, actual, total }) {
  return (
    <View style={styles.expenseRow}>
      <Text style={[styles.expenseName, total ? styles.label : styles.muted]}>{label}</Text>
      <Text style={[styles.expenseValue, total ? styles.label : styles.muted]}>{money(plan)}</Text>
      <Text style={[styles.expenseValue, total ? styles.label : styles.muted]}>{money(actual)}</Text>
    </View>
  );
}

function TripRow({ trip }) {
  const [expanded, setExpanded] = useState(false);
  const { plan, actual, delta } = trip;
  const period = tripPeriod(trip.plannedStart, trip.plannedEnd);
  const badge = !actual ? 'Факт не внесён' : delta == null ? 'План не задан'
    : delta === 0 ? 'По плану' : `${difference(delta)} к плану`;

  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button" accessibilityState={{ expanded }}
        onPress={() => setExpanded(value => !value)} style={styles.headingRow}
      >
        <View style={styles.iconBox}><Icon name="pin" size={20} /></View>
        <View style={styles.flex}>
          <Text style={styles.title}>{trip.destination}</Text>
          {period ? <Text style={styles.muted}>{period}</Text> : null}
          <Text style={styles.muted}>{trip.employeeName}</Text>
        </View>
        <View style={styles.tripAmount}>
          <Text style={styles.amount}>{money(actual?.expensesTotal ?? plan?.expensesTotal)}</Text>
          <Text style={[styles.badge, delta > 0 && styles.badgeOver, delta < 0 && styles.badgeUnder]}>{badge}</Text>
        </View>
        <Icon name="chevron-right" size={15} color={colors.muted}
          style={{ transform: [{ rotate: expanded ? '-90deg' : '90deg' }] }} />
      </Pressable>
      {expanded && (
        <View style={styles.details}>
          {trip.address && trip.address !== trip.destination ? <Text style={styles.muted}>{trip.address}</Text> : null}
          <Text style={styles.muted}>{[statuses[trip.status], trip.department].filter(Boolean).join(' · ')}</Text>
          <View style={styles.expenseRow}>
            <Text style={[styles.expenseName, styles.label]}>Статья</Text>
            <Text style={[styles.expenseValue, styles.label]}>План</Text>
            <Text style={[styles.expenseValue, styles.label]}>Факт</Text>
          </View>
          {categories.map(([key, label]) => (
            <ExpenseRow key={key} label={label} plan={plan?.[key]} actual={actual?.[key]} />
          ))}
          <ExpenseRow label="Расходы" plan={plan?.expensesTotal} actual={actual?.expensesTotal} total />
          {plan?.workTotal != null && (
            <Text style={styles.muted}>Согласованная оплата работы · {money(plan.workTotal)}</Text>
          )}
          {actual?.note ? <Text style={styles.muted}>Комментарий · {actual.note}</Text> : null}
        </View>
      )}
    </View>
  );
}

export default function TripExpenseReport({ report }) {
  if (!report.summary.tripCount) {
    return (
      <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.title}>Командировок за период нет</Text>
        <Text style={styles.muted}>Измените фильтры, чтобы посмотреть другие поездки.</Text>
      </View>
    );
  }
  return (
    <>
      <ExpensesSummary summary={report.summary} />
      <Text accessibilityRole="header" style={styles.listTitle}>Поездки за период · {report.summary.tripCount}</Text>
      {report.trips.map(trip => <TripRow key={trip.id} trip={trip} />)}
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  card: { padding: 14, gap: 10, backgroundColor: '#FFFFFF', borderRadius: 15 },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconBox: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.tint },
  title: { fontSize: 15, fontWeight: '700', color: colors.ink },
  listTitle: { fontSize: 16, fontWeight: '700', color: colors.ink, marginTop: 4 },
  label: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  muted: { color: '#526A84', fontSize: 12, lineHeight: 17 },
  total: { color: colors.ink, fontSize: 27, fontWeight: '700', fontVariant: ['tabular-nums'], marginTop: 3 },
  amount: { color: colors.ink, fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  coverage: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  track: { height: 7, borderRadius: 4, overflow: 'hidden', backgroundColor: '#E5ECF6' },
  progress: { height: 7, borderRadius: 4, backgroundColor: colors.blue },
  comparison: { gap: 9, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  amountRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  amountTile: { flex: 1, minWidth: 108, gap: 3, padding: 10, borderRadius: 9, backgroundColor: colors.canvas },
  tripAmount: { alignItems: 'flex-end', maxWidth: '40%', flexShrink: 1, gap: 4 },
  badge: { color: '#425C7A', backgroundColor: '#EDF3F9', borderRadius: 7, paddingHorizontal: 5,
    paddingVertical: 3, textAlign: 'right', fontSize: 10, fontWeight: '600' },
  badgeOver: { color: '#963C21', backgroundColor: '#FFF0E9' },
  badgeUnder: { color: '#187353', backgroundColor: '#E5F8F0' },
  over: { color: '#963C21' },
  under: { color: '#187353' },
  details: { gap: 7, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  expenseRow: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 31,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  expenseName: { flex: 1.15 },
  expenseValue: { flex: 1, textAlign: 'right', fontVariant: ['tabular-nums'] },
});
