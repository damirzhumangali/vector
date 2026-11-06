import React, { useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import DeadlinePicker, { deadlineToIso } from './DeadlinePicker';
import { TripBudgetFields, TripBudgetSummary, tripBudgetDraft, tripBudgetPayload, tripBudgetTotals } from './TripBudget';
import { TripRouteEditor, TripRouteSummary, tripRouteTitle, validTripRoute } from './TripRoute';
import { colors, Icon } from './ui';

const statusLabels = {
  awaiting_employee: 'Нужно предложить условия',
  awaiting_confirmation: 'На согласовании',
  confirmed: 'Подтверждена',
  declined: 'Вы отказались',
};
const historyLabels = {
  proposal: 'Сотрудник предложил условия',
  revision_requested: 'Руководитель вернул условия на уточнение',
  declined: 'Сотрудник отказался',
  confirmed: 'Руководитель подтвердил поездку',
};
const dateAndTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });

export function useTripOfferAction(offer, request, onChanged) {
  const [latest, setLatest] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const current = latest?.id === offer.id && (offer.revision == null || latest.revision > offer.revision) ? latest : offer;

  async function submit(action, fields, expectedRevision = current.revision) {
    if (inFlight.current) return false;
    inFlight.current = true;
    Keyboard.dismiss();
    setBusy(true);
    setError('');
    try {
      const { offer: savedOffer } = await request('/trip-offers/' + encodeURIComponent(current.id) + '/' + action, {
        method: 'POST', body: { ...fields, ...(expectedRevision == null ? {} : { expectedRevision }) },
      });
      setLatest(savedOffer);
      onChanged(savedOffer);
      return true;
    } catch (failure) {
      setError(failure?.message || 'Не удалось сохранить изменение. Попробуйте ещё раз.');
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return { current, busy, error, submit, clearError: () => setError('') };
}

export function TripOfferAction({ children, onPress, disabled, primary }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [primary ? styles.primary : styles.secondary, (disabled || pressed) && styles.disabled]}>
    <Text style={primary ? styles.primaryText : styles.backText}>{children}</Text>
  </Pressable>;
}

export function TripOfferReasonForm({ title, hint, actionLabel, busy, offline, onCancel, onSubmit }) {
  const [reason, setReason] = useState('');
  const value = reason.trim();
  const disabled = busy || offline || !value;
  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    <Text style={styles.muted}>{hint}</Text>
    <TextInput accessibilityLabel="Причина" value={reason} onChangeText={setReason}
      maxLength={500} multiline editable={!busy && !offline} placeholder="Укажите причину"
      placeholderTextColor={colors.muted} style={styles.reasonInput} />
    <TripOfferAction primary disabled={disabled} onPress={() => { if (!disabled) void onSubmit(value); }}>
      {busy ? 'Отправляем…' : actionLabel}
    </TripOfferAction>
    <TripOfferAction disabled={busy} onPress={onCancel}>Отмена</TripOfferAction>
  </View>;
}

export function TripOfferTerms({ offer, title }) {
  if (!offer?.plannedStart || !offer.plannedEnd) return null;
  const budget = { ...offer.estimate, dailyRate: offer.estimate?.dailyRate ?? offer.dailyRate };
  const totals = tripBudgetTotals(budget, offer.plannedStart, offer.plannedEnd);
  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    <Text style={styles.description}>Начало поездки · {dateAndTime.format(new Date(offer.plannedStart))}</Text>
    <Text style={styles.description}>Окончание поездки · {dateAndTime.format(new Date(offer.plannedEnd))}</Text>
    <TripBudgetSummary value={{ ...budget, ...totals, ...offer.estimate }} />
  </View>;
}

export function TripOfferHistory({ history }) {
  const [expanded, setExpanded] = useState(false);
  if (!history?.length) return null;
  return <View style={styles.card}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
      onPress={() => setExpanded(value => !value)} style={styles.historyToggle}>
      <Text style={[styles.label, styles.headingText]}>История согласования · {history.length}</Text>
      <Icon name={expanded ? 'close' : 'chevron-right'} size={18} />
    </Pressable>
    {expanded && [...history].reverse().map((item, index) => <View key={index} style={styles.historyItem}>
      <Text style={styles.label}>{historyLabels[item.kind]}</Text>
      <Text style={styles.muted}>{dateAndTime.format(new Date(item.at))}</Text>
      {item.reason ? <Text style={styles.description}>{item.reason}</Text> : null}
    </View>)}
  </View>;
}

function draftFrom(proposal, key, stops) {
  return {
    key,
    start: proposal?.plannedStart ? new Date(proposal.plannedStart) : null,
    end: proposal?.plannedEnd ? new Date(proposal.plannedEnd) : null,
    budget: tripBudgetDraft(proposal?.estimate ?? proposal),
    route: stops.map(stop => ({ id: stop.id, plannedAt: stop.plannedAt })),
  };
}

export function TripOfferCard({ offer, request, employee, offline = false, onChanged, onTrip, onBack,
  approvalSettings, approvalSettingsError }) {
  const { current, busy, error, submit, clearError } = useTripOfferAction(offer, request, onChanged);
  const [savedDraft, setSavedDraft] = useState(null);
  const [editing, setEditing] = useState(null);
  const [declining, setDeclining] = useState(null);
  const stops = current.stops ?? [];
  const selfDraft = current.selfRequested && current.status === 'awaiting_employee';
  const returned = current.status === 'awaiting_employee' && current.revisionReason;
  const enhancedAgreement = selfDraft || Array.isArray(current.history);
  const canEdit = employee && current.status === 'awaiting_confirmation';
  const canRespond = employee && (current.status === 'awaiting_employee' || canEdit);
  const canDecline = !selfDraft && enhancedAgreement && canRespond;
  const showDecline = canDecline && declining !== null;
  const isEditing = canEdit && editing !== null;
  const showProposal = employee && !showDecline
    && (current.status === 'awaiting_employee' || isEditing);
  const draftKey = current.status === 'awaiting_employee'
    ? 'new-' + current.revision : 'edit-' + editing?.revision;
  const initialDraft = draftFrom(current.previousProposal, draftKey, stops);
  const draft = savedDraft?.key === draftKey ? savedDraft : initialDraft;
  const plannedStart = deadlineToIso(draft.start);
  const plannedEnd = deadlineToIso(draft.end);
  const invalidPeriod = plannedStart && plannedEnd && draft.end <= draft.start;
  const budget = tripBudgetPayload(enhancedAgreement ? draft.budget : { dailyRate: draft.budget.dailyRate });
  const routeReady = !stops.length || validTripRoute(draft.route, stops, plannedStart, plannedEnd);
  const canSend = showProposal && plannedStart && plannedEnd && !invalidPeriod
    && budget?.dailyRate != null && routeReady && !busy && !offline && (!selfDraft || approvalSettings?.configured);
  const approvalHint = selfDraft && !approvalSettings?.configured && !offline
    ? approvalSettingsError || (approvalSettings ? 'Попросите владельца компании настроить согласование.'
      : 'Загружаем маршрут согласования…') : '';

  function changeDraft(update) {
    setSavedDraft(previous => {
      const value = previous?.key === draftKey ? previous : initialDraft;
      return { ...value, ...update(value) };
    });
  }

  function editProposal() {
    setSavedDraft(draftFrom(current, 'edit-' + current.revision, stops));
    setEditing({ revision: current.revision });
    clearError();
  }

  function cancelEdit() {
    setEditing(null);
    clearError();
  }

  async function sendProposal() {
    if (!canSend) return;
    const revision = isEditing ? editing.revision : current.revision;
    const fields = { plannedStart, plannedEnd, ...budget, ...(stops.length ? { stops: draft.route } : {}) };
    if (await submit('proposal', fields, revision)) setEditing(null);
  }

  function openDecline() {
    setDeclining({ revision: current.revision });
    clearError();
  }

  function cancelDecline() {
    setDeclining(null);
    clearError();
  }

  async function decline(reason) {
    if (showDecline && !offline && await submit('decline', { reason }, declining.revision)) {
      setDeclining(null);
      setEditing(null);
    }
  }

  return (
    <View style={styles.content}>
      <Pressable accessibilityRole="button" onPress={onBack} style={styles.back}>
        <Icon name="chevron-left" size={16} />
        <Text style={styles.backText}>К выездам</Text>
      </Pressable>

      <View style={styles.card}>
        <View style={styles.heading}>
          <View style={styles.placeIcon}><Icon name="pin" /></View>
          <View style={styles.headingText}>
            <Text style={styles.muted}>{selfDraft ? 'Черновик из Excel' : 'Командировка от руководителя'}</Text>
            <Text accessibilityRole="header" style={styles.title}>
              {tripRouteTitle(stops) ?? stops[0]?.destination ?? current.destination}
            </Text>
            {current.address && current.address !== current.destination ? <Text style={styles.muted}>{current.address}</Text> : null}
          </View>
        </View>
        <Text accessibilityLiveRegion="polite" style={[styles.badge, current.status === 'confirmed' && styles.confirmedBadge]}>
          {selfDraft ? 'Черновик' : returned ? 'На уточнении' : statusLabels[current.status]}
        </Text>
        <Text style={styles.label}>Что нужно сделать</Text>
        <Text style={styles.description}>{current.purpose}</Text>
        {current.comment ? <>
          <Text style={styles.label}>{selfDraft ? 'Ваш комментарий' : 'Комментарий руководителя'}</Text>
          <Text style={styles.description}>{current.comment}</Text>
        </> : null}
        {returned ? <>
          <Text style={styles.label}>Что уточнить</Text>
          <Text style={styles.description}>{current.revisionReason}</Text>
        </> : null}
        {current.declineReason ? <>
          <Text style={styles.label}>Причина отказа</Text>
          <Text style={styles.description}>{current.declineReason}</Text>
        </> : null}
      </View>

      {showProposal ? (
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.title}>Ваши условия поездки</Text>
          <Text style={styles.muted}>{selfDraft ? 'Добавьте даты, время посещений и расходы, затем отправьте черновик на согласование.'
            : 'Руководитель получит ваш график и дневную ставку на согласование.'}</Text>
          <Text accessibilityRole="header" style={styles.label}>Период командировки</Text>
          <Text style={styles.muted}>Когда начинается и заканчивается вся поездка.</Text>
          <DeadlinePicker label="Начало поездки" value={draft.start}
            onChange={start => changeDraft(() => ({ start }))}
            disabled={busy || offline} required showQuick={false} showHelper={false} />
          <DeadlinePicker label="Окончание поездки" value={draft.end}
            onChange={end => changeDraft(() => ({ end }))}
            disabled={busy || offline} required showQuick={false} showHelper={false} />
          <Text style={styles.muted}>Время показывается в часовом поясе телефона.</Text>
          {invalidPeriod ? <Text accessibilityRole="alert" style={styles.error}>Окончание должно быть позже начала.</Text> : null}
          {stops.length > 0 && <TripRouteEditor stops={stops} value={draft.route}
            onChange={route => changeDraft(() => ({ route }))} start={plannedStart} end={plannedEnd} disabled={busy || offline} />}
          <TripBudgetFields key={draftKey} value={draft.budget} start={plannedStart} end={plannedEnd}
            onChange={update => changeDraft(value => ({ budget: update(value.budget) }))}
            disabled={busy || offline} collapseExpenses expensesAvailable={enhancedAgreement} />
          {approvalHint ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{approvalHint}</Text> : null}
          <TripOfferAction primary disabled={!canSend} onPress={sendProposal}>
            {busy ? 'Отправляем…' : 'Отправить на согласование'}
          </TripOfferAction>
          {isEditing ? <TripOfferAction disabled={busy} onPress={cancelEdit}>Отмена</TripOfferAction> : null}
        </View>
      ) : (
        <TripOfferTerms offer={current} title={current.status === 'confirmed' ? 'Согласованные условия' : 'Отправленные условия'} />
      )}
      {!showProposal && stops.length > 0 && <TripRouteSummary stops={stops} />}

      {showDecline ? <TripOfferReasonForm title="Отказаться от командировки"
        hint="Руководитель увидит причину отказа." actionLabel="Отправить отказ"
        busy={busy} offline={offline} onCancel={cancelDecline} onSubmit={decline} /> : null}
      {canEdit && !showProposal && !showDecline ? <>
        <Text style={styles.muted}>Руководитель получил ваши условия. Здесь появится подтверждение.</Text>
        <TripOfferAction primary disabled={offline || busy} onPress={editProposal}>Изменить условия</TripOfferAction>
      </> : null}
      {canDecline && !showDecline ? <TripOfferAction disabled={offline || busy} onPress={openDecline}>
        Отказаться от командировки
      </TripOfferAction> : null}
      {current.status === 'confirmed' && current.tripId ? <TripOfferAction primary onPress={() => onTrip(current.tripId)}>
        Открыть командировку
      </TripOfferAction> : null}
      {offline && canRespond ? <Text style={styles.muted}>Для отправки изменений нужен интернет.</Text> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <TripOfferHistory history={current.history} />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: 12 },
  card: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 14, gap: 9 },
  heading: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  headingText: { flex: 1, gap: 4 },
  placeIcon: { width: 40, height: 40, borderRadius: 11, backgroundColor: colors.tint,
    justifyContent: 'center', alignItems: 'center' },
  title: { color: colors.ink, fontWeight: '700', fontSize: 17 },
  label: { color: colors.ink, fontWeight: '700', fontSize: 14 },
  description: { color: colors.ink, fontSize: 14, lineHeight: 20 },
  muted: { color: '#536680', fontSize: 13, lineHeight: 18 },
  badge: { alignSelf: 'flex-start', backgroundColor: colors.tint, borderRadius: 8, color: '#185DB0',
    fontSize: 12, fontWeight: '700', paddingVertical: 6, paddingHorizontal: 9 },
  confirmedBadge: { backgroundColor: '#EAF8F0', color: '#176443' },
  reasonInput: { minHeight: 84, padding: 12, color: colors.ink, fontSize: 14, textAlignVertical: 'top',
    borderRadius: 10, backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.border },
  error: { color: '#9F2329', fontSize: 13, lineHeight: 18 },
  back: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44 },
  backText: { textAlign: 'center', color: colors.blue, fontSize: 14, fontWeight: '600' },
  primary: { minHeight: 46, justifyContent: 'center', alignItems: 'center', padding: 10,
    borderRadius: 10, backgroundColor: '#136BC9' },
  primaryText: { textAlign: 'center', color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  secondary: { minHeight: 44, justifyContent: 'center', alignItems: 'center', padding: 9 },
  disabled: { opacity: 0.55 },
  historyToggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 9 },
  historyItem: { borderTopWidth: 1, borderColor: colors.border, paddingTop: 9, gap: 4 },
});
