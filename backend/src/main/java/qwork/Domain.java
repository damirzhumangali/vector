package qwork;

import java.util.Map;

final class Domain {
    static final class Failure extends RuntimeException {
        final int status;
        final String code;

        Failure(int status, String message, String code) {
            super(message);
            this.status = status;
            this.code = code;
        }
    }

    static Failure error(int status, String message) {
        return error(status, message, null);
    }

    static Failure error(int status, String message, String code) {
        return new Failure(status, message, code);
    }

    static String field(Map<String, Object> payload, String key, String label, int limit, boolean optional) {
        Object value = payload.getOrDefault(key, optional ? "" : null);
        if (!(value instanceof String raw) || raw.codePointCount(0, raw.length()) > limit || raw.indexOf(0) >= 0) {
            throw error(400, "Проверьте поле «" + label + "».");
        }
        String result = raw.strip();
        if (result.isEmpty() && !optional) {
            throw error(400, "Заполните поле «" + label + "».");
        }
        return result;
    }

    static long number(Map<String, Object> row, String field) {
        return ((Number) row.get(field)).longValue();
    }
}
