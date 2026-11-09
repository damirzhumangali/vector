package qwork;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

record TelegramReportCatalog(long reviewChatId, Map<Long, String> engineers, List<Site> sites,
                             Map<Long, String> reviewers) {
    private static final int MAX_CONFIG_BYTES = 4 * 1024 * 1024;
    private static final int MAX_ENGINEERS = 1_000;
    private static final int MAX_SITES = 5_000;
    private static final Pattern SITE_ID = Pattern.compile("[a-zA-Z0-9_-]{1,32}");

    record Site(String id, String name, String region) {
        String label() {
            return region.isEmpty() ? name : name + " — " + region;
        }
    }

    TelegramReportCatalog {
        engineers = Map.copyOf(engineers);
        sites = List.copyOf(sites);
        reviewers = Map.copyOf(reviewers);
    }

    TelegramReportCatalog(long reviewChatId, Map<Long, String> engineers, List<Site> sites) {
        this(reviewChatId, engineers, sites, Map.of());
    }

    static TelegramReportCatalog load(Path path) throws IOException {
        try (var input = Files.newInputStream(path)) {
            return parse(input.readNBytes(MAX_CONFIG_BYTES + 1));
        }
    }

    static TelegramReportCatalog parse(String json) {
        return parse(json.getBytes(StandardCharsets.UTF_8));
    }

    private static TelegramReportCatalog parse(byte[] content) {
        if (content.length > MAX_CONFIG_BYTES) {
            throw invalid("настройки должны быть не больше 4 МБ");
        }
        JsonNode config;
        try {
            config = Db.JSON.reader()
                .with(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
                .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                .readTree(content);
        } catch (IOException error) {
            throw invalid("ожидается корректный JSON без повторяющихся полей");
        }
        if (config == null || !config.isObject() || config.size() != (config.has("reviewers") ? 4 : 3)
                || !config.has("reviewChatId") || !config.has("engineers") || !config.has("sites")) {
            throw invalid("укажите reviewChatId, engineers и sites");
        }
        long reviewChatId = integer(config.path("reviewChatId"), "reviewChatId");
        if (reviewChatId >= 0) {
            throw invalid("reviewChatId должен быть отрицательным ID группы или канала Telegram");
        }

        var engineers = people(array(config.path("engineers"), "engineers", MAX_ENGINEERS), "engineers");
        Map<Long, String> reviewers = Map.of();
        if (config.has("reviewers")) {
            var reviewerRows = config.path("reviewers");
            if (!reviewerRows.isArray() || reviewerRows.size() > MAX_ENGINEERS) {
                throw invalid("reviewers должен быть списком до " + MAX_ENGINEERS + " записей");
            }
            reviewers = people(reviewerRows, "reviewers");
        }

        var sites = new ArrayList<Site>();
        var siteIds = new HashSet<String>();
        JsonNode siteRows = array(config.path("sites"), "sites", MAX_SITES);
        for (int i = 0; i < siteRows.size(); i++) {
            String field = "sites[" + (i + 1) + "]";
            JsonNode row = siteRows.get(i);
            if (!row.isObject() || row.size() != 3 || !row.has("id") || !row.has("name") || !row.has("region")) {
                throw invalid(field + " должен содержать id, name и region");
            }
            String id = row.path("id").textValue();
            if (id == null || !SITE_ID.matcher(id).matches() || !siteIds.add(id)) {
                throw invalid(field + ".id должен быть уникальным и состоять из 1–32 латинских букв, цифр, дефисов или подчёркиваний");
            }
            sites.add(new Site(id, string(row.path("name"), field + ".name", 140, false),
                string(row.path("region"), field + ".region", 80, true)));
        }
        return new TelegramReportCatalog(reviewChatId, engineers, sites, reviewers);
    }

    private static Map<Long, String> people(JsonNode rows, String key) {
        var people = new LinkedHashMap<Long, String>();
        for (int i = 0; i < rows.size(); i++) {
            String field = key + "[" + (i + 1) + "]";
            JsonNode row = rows.get(i);
            if (!row.isObject() || row.size() != 2 || !row.has("telegramId") || !row.has("name")) {
                throw invalid(field + " должен содержать telegramId и name");
            }
            long id = integer(row.path("telegramId"), field + ".telegramId");
            if (id <= 0 || people.containsKey(id)) {
                throw invalid(field + ".telegramId должен быть положительным и уникальным");
            }
            people.put(id, string(row.path("name"), field + ".name", 80, false));
        }
        return people;
    }

    Site site(String id) {
        return sites.stream().filter(site -> site.id().equals(id)).findFirst().orElse(null);
    }

    List<Site> search(String query) {
        if (query == null || query.isBlank()) return sites;
        String needle = normalize(query.strip());
        return sites.stream().filter(site -> normalize(site.label()).contains(needle)).toList();
    }

    private static String normalize(String value) {
        return Normalizer.normalize(value, Normalizer.Form.NFC).toLowerCase(Locale.ROOT).replace('ё', 'е');
    }

    private static JsonNode array(JsonNode node, String field, int max) {
        if (!node.isArray() || node.isEmpty() || node.size() > max) {
            throw invalid(field + " должен содержать от 1 до " + max + " записей");
        }
        return node;
    }

    private static long integer(JsonNode node, String field) {
        if (!node.isIntegralNumber() || !node.canConvertToLong()) {
            throw invalid(field + " должен быть целым числом");
        }
        return node.longValue();
    }

    private static String string(JsonNode node, String field, int max, boolean allowEmpty) {
        if (!node.isTextual()) throw invalid(field + " должен быть строкой");
        String value = node.textValue().strip();
        if ((!allowEmpty && value.isEmpty()) || value.codePointCount(0, value.length()) > max
                || value.codePoints().anyMatch(c -> Character.isISOControl(c) || c == 0x2028 || c == 0x2029)) {
            throw invalid(field + " должен содержать " + (allowEmpty ? "до " : "от 1 до ") + max + " символов в одной строке");
        }
        return value;
    }

    private static IllegalArgumentException invalid(String message) {
        return new IllegalArgumentException("Настройки бота Telegram: " + message + ".");
    }
}
