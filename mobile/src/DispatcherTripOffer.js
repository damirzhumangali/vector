import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  TripOfferAction, TripOfferHistory, TripOfferReasonForm, TripOfferTerms, useTripOfferAction,
} from './TripOfferCard';
import { colors, Icon } from './ui';
import { TripRouteSummary } from './TripRoute';

const statusLabels = {
  awaiting_employee: 'Ждём предложения сотрудника',
  awaiting_confirmation: 'Готова к подтверждению',
  confirmed: 'Подтверждена',
  declined: 'Сотрудник отказался',
};
const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

function ScheduleConflicts({ shifts, trips }) {
  if (!shifts.length && !trips.length) return null;
  return <View style={styles.warning}>
    <Text accessibilityRole="header" style={styles.warningTitle}>Пересечения в графике</Text>
    {shifts.map(shift => <Text key={'shift-' + shift.id} style={styles.warningText}>
      {shift.kind === 'duty' ? 'Дежурство' : 'Смена'} · {dateFormat.format(new Date(shift.startsAt))} — {dateFormat.format(new Date(shift.endsAt))}
    </Text>)}
    {trips.map(trip => <Text key={'trip-' + trip.id} style={styles.warningText}>
      {trip.destination} · {dateFormat.format(new Date(trip.plannedStart))} — {dateFormat.format(new Date(trip.plannedEnd))}
    </Text>)}
    <Text style={styles.warningText}>{trips.length
      ? 'У сотрудника уже есть командировка в этот период. Верните условия на уточнение.'
      : 'Учитывайте смены сотрудника при подтверждении поездки.'}</Text>
  </View>;
}

export default function DispatcherTripOffer({ offer, request, offline = false, canDispatch = true, onChanged, onTrip, onBack }) {
  const { current, busy, error, submit, clearError } = useTripOfferAction(offer, request, onChanged);
  const [revising, setRevising] = useState(null);
  const stops = current.stops ?? [];
  const waitingConfirmation = current.status === 'awaiting_confirmation';
  const enhancedAgreement = Array.isArray(current.history);
  const canDecide = canDispatch && waitingConfirmation;
  const canRevise = enhancedAgreement && canDecide;
  const returned = current.status === 'awaiting_employee' && current.revisionReason;
  const shifts = current.conflicts?.shifts ?? [];
  const trips = current.conflicts?.trips ?? [];
  const tripConflict = trips.length > 0;
  const showReason = canRevise && revising !== null;

  function confirm() {
    if (canDecide && !showReason && !tripConflict && !offline) return submit('confirm', {});
  }

  function openRevision() {
    setRevising({ revision: current.revision });
    clearError();
  }

  function cancelRevision() {
    setRevising(null);
    clearError();
  }

  async function revise(reason) {
    if (showReason && !offline && await submit('revise', { reason }, revising.revision)) {
      setRevising(null);
    }
  }

  return <View style={styles.screen}>
    <TripOfferAction disabled={busy} onPress={onBack}>‹ К выездам</TripOfferAction>
    <View style={styles.card}>
      <View style={styles.heading}>
        <Icon name="pin" size={21} />
        <Text accessibilityRole="header" style={styles.title}>
          {stops.length ? `Маршрут · ${stops.length} организаций` : current.destination}
        </Text>
      </View>
      {current.address && current.address !== current.destination ? <Text style={styles.muted}>{current.address}</Text> : null}
      <Text accessibilityLiveRegion="polite" style={[styles.badge, current.status === 'confirmed' && styles.confirmed]}>
        {returned ? 'На уточнении' : statusLabels[current.status]}
      </Text>
      <Text style={styles.label}>Сотрудник</Text>
      <Text style={styles.body}>{current.employeeName}</Text>
      <Text style={styles.label}>Что нужно сделать</Text>
      <Text style={styles.body}>{current.purpose}</Text>
      {current.comment ? <>
        <Text style={styles.label}>Комментарий диспетчера</Text>
        <Text style={styles.body}>{current.comment}</Text>
      </> : null}
      {returned ? <>
        <Text style={styles.label}>Что уточнить</Text>
        <Text style={styles.body}>{current.revisionReason}</Text>
      </> : null}
      {current.declineReason ? <>
        <Text style={styles.label}>Причина отказа</Text>
        <Text style={styles.body}>{current.declineReason}</Text>
      </> : null}
      {current.status === 'awaiting_employee' && <Text style={styles.hint}>
        {returned ? 'Сотрудник увидит причину и сможет отправить новые условия.'
          : enhancedAgreement ? 'Сотрудник предложит даты, дневную ставку и расходы.'
            : 'Сотрудник предложит даты поездки и дневную ставку.'}
      </Text>}
    </View>
    {returned
      ? <TripOfferTerms offer={current.previousProposal} title="Предыдущие условия" />
      : <TripOfferTerms offer={current} title={current.status === 'confirmed'
        ? 'Согласованные условия' : 'Предложение сотрудника'} />}
    {stops.length > 0 && <TripRouteSummary stops={stops} />}
    {waitingConfirmation && <ScheduleConflicts shifts={shifts} trips={trips} />}
    {canDecide && offline ? <Text style={styles.hint}>Для отправки изменений нужен интернет.</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {showReason ? <TripOfferReasonForm title="Вернуть на уточнение"
      hint="Объясните сотруднику, что нужно изменить в условиях поездки."
      actionLabel="Отправить на уточнение" busy={busy} offline={offline} onCancel={cancelRevision} onSubmit={revise} /> : null}
    {canDecide && !showReason ? <>
      {!tripConflict && <TripOfferAction primary disabled={busy || offline} onPress={confirm}>
        {busy ? 'Подтверждаем…' : 'Подтвердить командировку'}
      </TripOfferAction>}
      {canRevise && <TripOfferAction primary={tripConflict} disabled={busy || offline} onPress={openRevision}>
        Вернуть на уточнение
      </TripOfferAction>}
    </> : null}
    {current.status === 'confirmed' && current.tripId ? <TripOfferAction primary onPress={() => onTrip(current.tripId)}>
      Открыть командировку
    </TripOfferAction> : null}
    <TripOfferHistory history={current.history} />
  </View>;
}

const styles = StyleSheet.create({
  screen: { gap: 12 },
  card: { backgroundColor: '#fff', borderColor: colors.border, borderWidth: 1, borderRadius: 16, padding: 14, gap: 8 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flexShrink: 1, color: colors.ink, fontSize: 17, fontWeight: '700' },
  label: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  body: { color: colors.ink, fontSize: 14, lineHeight: 20 },
  muted: { color: '#536680', fontSize: 13, lineHeight: 18 },
  hint: { backgroundColor: '#F0F5FD', borderRadius: 9, padding: 10, color: '#536680', fontSize: 13, lineHeight: 18 },
  badge: { alignSelf: 'flex-start', backgroundColor: colors.tint, borderRadius: 7, paddingHorizontal: 8,
    paddingVertical: 5, color: '#195AA8', fontSize: 12, fontWeight: '700' },
  confirmed: { backgroundColor: '#E8F9F0', color: '#166A4B' },
  warning: { backgroundColor: '#FFF6E6', borderRadius: 12, padding: 12, gap: 5 },
  warningTitle: { color: '#80550F', fontSize: 14, fontWeight: '700' },
  warningText: { color: '#80550F', fontSize: 13, lineHeight: 18 },
  error: { color: '#AA262A', backgroundColor: '#FFF1F3', borderRadius: 8, padding: 9, fontSize: 13, lineHeight: 18 },
});
