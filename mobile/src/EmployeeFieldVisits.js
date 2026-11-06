import React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { EmployeeTrips } from './FieldOperations';
import { colors, Icon } from './ui';

export default function EmployeeFieldVisits({ request, offline = false, tasks = [], onTask,
  initialView, initialTripId, initialRequestId, initialOfferId, onBackToShifts }) {
  const fromTrips = onBackToShifts || initialTripId || initialRequestId || initialOfferId;
  return <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
    automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>
    {onBackToShifts && <Pressable accessibilityRole="button" onPress={onBackToShifts} style={styles.back}>
      <Icon name="chevron-left" size={17} />
      <Text style={styles.link}>К рабочему времени</Text>
    </Pressable>}
    <View style={styles.heading}>
      <Text accessibilityRole="header" style={styles.title}>Выезды</Text>
      <Text style={styles.description}>Задания на объектах и командировки</Text>
    </View>
    <EmployeeTrips request={request} offline={offline} tasks={tasks} onTask={onTask}
      initialView={initialView ?? (fromTrips ? 'trips' : 'all')} initialTripId={initialTripId}
      initialOfferId={initialOfferId} initialRequestId={initialRequestId} />
  </ScrollView>;
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 26 },
  heading: { gap: 4 },
  title: { fontSize: 32, fontWeight: '800', color: colors.ink },
  description: { fontSize: 14, lineHeight: 20, color: '#53647E' },
  back: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, alignSelf: 'flex-start' },
  link: { color: '#075BB3', fontWeight: '600' },
});
