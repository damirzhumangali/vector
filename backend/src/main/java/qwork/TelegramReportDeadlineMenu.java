package qwork;

import com.fasterxml.jackson.databind.JsonNode;

import java.io.IOException;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.YearMonth;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.function.IntFunction;
import java.util.function.Supplier;

import static qwork.TelegramReports.ZONE;
import static qwork.TelegramReports.button;
import static qwork.TelegramReports.formatDeadline;

final class TelegramReportDeadlineMenu {
    private static final int PAGE_SIZE = 7;
    private static final DateTimeFormatter DAY = DateTimeFormatter.ofPattern("dd.MM");
    private static final DateTimeFormatter MONTH = DateTimeFormatter.ofPattern("LLLL uuuu", Locale.forLanguageTag("ru"));
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm");

    private final TelegramReportCatalog catalog;
    private final TelegramReportApi api;
    private final Map<Long, ActivePage> active = new HashMap<>();

    TelegramReportDeadlineMenu(TelegramReportCatalog catalog, TelegramReportApi api) {
        this.catalog = catalog;
        this.api = api;
    }

    void open(long engineer, long operationId) throws IOException, InterruptedException {
        show(engineer, 0, operationId, sites(engineer, 0));
    }

    void handle(long engineer, JsonNode callback, TelegramReportStore store) throws Exception {
        var current = active.get(engineer);
        long messageId = callback.path("message").path("message_id").asLong();
        String action = callback.path("data").asText();
        var choice = current != null && current.messageId() == messageId ? current.choices().get(action) : null;
        if (choice == null) {
            TelegramReports.answer(api, callback, "Откройте «Задать срок сдачи» в меню, чтобы начать заново.");
            return;
        }
        TelegramReports.answer(api, callback, null);
        show(engineer, messageId, current.operationId(), choice.step().open(store, current.operationId()));
    }

    private void show(long engineer, long messageId, long operationId, Page page)
            throws IOException, InterruptedException {
        String prefix = "dl:" + UUID.randomUUID() + ":";
        var choices = new HashMap<String, Choice>();
        var keyboard = new ArrayList<List<Map<String, String>>>();
        for (var row : page.rows) {
            var keys = new ArrayList<Map<String, String>>();
            for (var choice : row) {
                String action = prefix + choices.size();
                choices.put(action, choice);
                keys.add(button(choice.label(), action));
            }
            keyboard.add(keys);
        }
        if (messageId == 0) messageId = api.send(engineer, page.text, keyboard);
        else api.edit(engineer, messageId, page.text, keyboard);
        if (choices.isEmpty()) active.remove(engineer);
        else active.put(engineer, new ActivePage(messageId, operationId, choices));
    }

    private Page sites(long engineer, int index) {
        var sites = catalog.search(engineer, "");
        if (sites.isEmpty()) return new Page("Вам пока не назначены объекты.");
        var page = new Page("Выберите объект для отчёта");
        sites.stream().skip(index).limit(PAGE_SIZE)
            .forEach(site -> page.add(next(site.label(), () -> dates(new Target(engineer, site), YearMonth.now(ZONE)))));
        paginate(page, index, sites.size(), i -> sites(engineer, i));
        return finish(page, null);
    }

    private Page dates(Target target, YearMonth month) {
        LocalDate today = LocalDate.now(ZONE);
        YearMonth current = YearMonth.from(today);
        if (month.isBefore(current)) month = current;
        YearMonth shown = month;
        var page = new Page("Выберите дату · " + MONTH.format(shown) + "\n" + targetLabel(target));
        page.rows.add(List.of(
            next("Сегодня", () -> times(target, LocalDate.now(ZONE))),
            next("Завтра", () -> times(target, LocalDate.now(ZONE).plusDays(1)))));
        int firstDay = shown.equals(current) ? today.getDayOfMonth() : 1;
        for (int first = firstDay; first <= shown.lengthOfMonth(); first += 7) {
            var row = new ArrayList<Choice>();
            for (int day = first; day < first + 7 && day <= shown.lengthOfMonth(); day++) {
                LocalDate date = shown.atDay(day);
                row.add(next(DAY.format(date), () -> times(target, date)));
            }
            page.rows.add(row);
        }
        var navigation = new ArrayList<Choice>();
        if (shown.isAfter(current)) navigation.add(next("‹ Месяц", () -> dates(target, shown.minusMonths(1))));
        navigation.add(next("Месяц ›", () -> dates(target, shown.plusMonths(1))));
        page.rows.add(navigation);
        return finish(page, next("‹ Назад", () -> sites(target.engineer(), 0)));
    }

    private Page times(Target target, LocalDate date) {
        if (date.isBefore(LocalDate.now(ZONE))) return dates(target, YearMonth.now(ZONE));
        long now = Instant.now().getEpochSecond();
        if (epoch(date, LocalTime.of(23, 59)) <= now) {
            var calendar = dates(target, YearMonth.from(date.plusDays(1)));
            return new Page("Эта дата заканчивается. Выберите другой день.\n\n" + calendar.text, calendar.rows);
        }
        var page = new Page("Выберите время · " + DAY.format(date) + "\nПо времени Казахстана");
        var quickTimes = new ArrayList<Choice>();
        for (int hour : new int[] {9, 12, 18, 20}) {
            LocalTime time = LocalTime.of(hour, 0);
            if (epoch(date, time) > now) quickTimes.add(next(TIME.format(time), () -> confirm(target, date, time)));
        }
        if (!quickTimes.isEmpty()) page.rows.add(quickTimes);
        page.add(next("Другое время", () -> hours(target, date)));
        return finish(page, next("‹ Назад", () -> dates(target, YearMonth.from(date))));
    }

    private Page hours(Target target, LocalDate date) {
        var page = new Page("Выберите час · " + DAY.format(date));
        var row = new ArrayList<Choice>();
        long now = Instant.now().getEpochSecond();
        for (int hour = 0; hour < 24; hour++) {
            int selected = hour;
            if (epoch(date, LocalTime.of(hour, 59)) <= now) continue;
            row.add(next(twoDigits(hour) + " ч", () -> minutes(target, date, selected, 0)));
            if (row.size() == 6) {
                page.rows.add(row);
                row = new ArrayList<>();
            }
        }
        if (!row.isEmpty()) page.rows.add(row);
        return finish(page, next("‹ Назад", () -> times(target, date)));
    }

    private Page minutes(Target target, LocalDate date, int hour, int first) {
        var page = new Page("Выберите минуты · " + DAY.format(date) + " в " + twoDigits(hour) + ":…");
        long now = Instant.now().getEpochSecond();
        var row = new ArrayList<Choice>();
        for (int minute = first; minute < first + 10; minute++) {
            LocalTime time = LocalTime.of(hour, minute);
            if (epoch(date, time) <= now) continue;
            row.add(next(TIME.format(time), () -> confirm(target, date, time)));
            if (row.size() == 5) {
                page.rows.add(row);
                row = new ArrayList<>();
            }
        }
        if (!row.isEmpty()) page.rows.add(row);

        var ranges = new ArrayList<Choice>();
        for (int start = 0; start < 60; start += 10) {
            int selected = start;
            if (start != first && epoch(date, LocalTime.of(hour, start + 9)) > now) {
                ranges.add(next(twoDigits(start) + "–" + twoDigits(start + 9),
                    () -> minutes(target, date, hour, selected)));
            }
        }
        if (!ranges.isEmpty()) {
            page.rows.add(ranges.subList(0, Math.min(3, ranges.size())));
            if (ranges.size() > 3) page.rows.add(ranges.subList(3, ranges.size()));
        }
        return finish(page, next("‹ Назад", () -> hours(target, date)));
    }

    private Page confirm(Target target, LocalDate date, LocalTime time) {
        long dueAt = epoch(date, time);
        if (dueAt <= Instant.now().getEpochSecond()) return times(target, date);
        var assignment = new TelegramReportStore.DeadlineAssignment(target.engineer(), target.site().id());
        String details = targetLabel(target) + "\nСрок · " + formatDeadline(dueAt) + " по времени Казахстана";
        var page = new Page("Проверьте срок сдачи\n\n" + details);
        page.add(new Choice("Подтвердить", (store, operationId) -> {
            long now = Instant.now().getEpochSecond();
            if (dueAt <= now) {
                var expired = times(target, date);
                return new Page("Выбранное время уже прошло.\n\n" + expired.text, expired.rows);
            }
            store.setDeadlines(operationId, List.of(assignment), now, dueAt);
            return new Page("Срок сдачи установлен\n\n" + details
                + "\n\nЕсли отчёт к этому времени ещё не сдан, бот напомнит о нём.");
        }));
        return finish(page, next("‹ Назад", () -> times(target, date)));
    }

    private String targetLabel(Target target) {
        return catalog.engineers().get(target.engineer()) + "\n" + target.site().label();
    }

    private static void paginate(Page page, int index, int total, IntFunction<Page> show) {
        var row = new ArrayList<Choice>();
        if (index > 0) row.add(next("‹ Предыдущие", () -> show.apply(index - PAGE_SIZE)));
        if (index + PAGE_SIZE < total) row.add(next("Следующие ›", () -> show.apply(index + PAGE_SIZE)));
        if (!row.isEmpty()) page.rows.add(row);
    }

    private static Page finish(Page page, Choice back) {
        var cancel = next("Отмена", () -> new Page("Настройка срока отменена."));
        page.rows.add(back == null ? List.of(cancel) : List.of(back, cancel));
        return page;
    }

    private static Choice next(String label, Supplier<Page> show) {
        return new Choice(label, (store, operationId) -> show.get());
    }

    private static long epoch(LocalDate date, LocalTime time) {
        return date.atTime(time).atZone(ZONE).toEpochSecond();
    }

    private static String twoDigits(int value) {
        return value < 10 ? "0" + value : Integer.toString(value);
    }

    @FunctionalInterface
    private interface Step {
        Page open(TelegramReportStore store, long operationId) throws IOException, SQLException;
    }

    private record Choice(String label, Step step) {}
    private record Target(long engineer, TelegramReportCatalog.Site site) {}
    private record ActivePage(long messageId, long operationId, Map<String, Choice> choices) {}

    private record Page(String text, List<List<Choice>> rows) {
        Page(String text) {
            this(text, new ArrayList<>());
        }

        void add(Choice choice) {
            rows.add(List.of(choice));
        }
    }
}
