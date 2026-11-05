package qwork;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

final class LosslessWebp {
    private static final int MAX_ENCODED_BYTES = 64 * 1024 * 1024;
    private static final int ENCODE_TIMEOUT_SECONDS = 15;

    private LosslessWebp() {}

    static byte[] encode(BufferedImage image) {
        Process encoder;
        try {
            encoder = new ProcessBuilder("cwebp", "-lossless", "-exact", "-z", "2", "-metadata", "none",
                "-quiet", "-o", "-", "--", "-").redirectError(ProcessBuilder.Redirect.DISCARD).start();
        } catch (IOException error) {
            throw unavailable();
        }

        var pipes = Executors.newVirtualThreadPerTaskExecutor();
        try {
            // Drain both pipes concurrently. Encoding streams one RGBA row at a time without temporary files.
            var input = pipes.submit(() -> {
                writePixels(encoder, image);
                return null;
            });
            var output = pipes.submit(() -> {
                try (var stream = encoder.getInputStream()) {
                    return stream.readNBytes(MAX_ENCODED_BYTES + 1);
                }
            });
            if (!encoder.waitFor(ENCODE_TIMEOUT_SECONDS, TimeUnit.SECONDS) || encoder.exitValue() != 0) {
                throw unavailable();
            }
            input.get(1, TimeUnit.SECONDS);
            byte[] encoded = output.get(1, TimeUnit.SECONDS);
            if (encoded.length > MAX_ENCODED_BYTES || !isWebp(encoded)) {
                throw unavailable();
            }
            return encoded;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw unavailable();
        } catch (ExecutionException | TimeoutException error) {
            throw unavailable();
        } finally {
            encoder.destroyForcibly();
            pipes.shutdownNow();
        }
    }

    private static void writePixels(Process encoder, BufferedImage image) throws IOException {
        int width = image.getWidth();
        int height = image.getHeight();
        String header = "P7\nWIDTH " + width + "\nHEIGHT " + height +
            "\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n";
        int[] pixels = new int[width];
        byte[] rgba = new byte[width * 4];
        try (var stream = encoder.getOutputStream()) {
            stream.write(header.getBytes(StandardCharsets.US_ASCII));
            for (int y = 0; y < height; y++) {
                image.getRGB(0, y, width, 1, pixels, 0, width);
                for (int x = 0; x < width; x++) {
                    int argb = pixels[x];
                    int offset = x * 4;
                    rgba[offset] = (byte) (argb >>> 16);
                    rgba[offset + 1] = (byte) (argb >>> 8);
                    rgba[offset + 2] = (byte) argb;
                    rgba[offset + 3] = (byte) (argb >>> 24);
                }
                stream.write(rgba);
            }
        }
    }

    static boolean isWebp(byte[] bytes) {
        return bytes.length >= 12 && bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F'
            && bytes[8] == 'W' && bytes[9] == 'E' && bytes[10] == 'B' && bytes[11] == 'P';
    }

    private static Domain.Failure unavailable() {
        return Domain.error(503, "Не удалось сохранить фото в WebP. Попробуйте ещё раз.");
    }
}
