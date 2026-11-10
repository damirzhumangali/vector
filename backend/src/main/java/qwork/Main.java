package qwork;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.webmvc.autoconfigure.error.ErrorMvcAutoConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

@SpringBootApplication(proxyBeanMethods = false, exclude = ErrorMvcAutoConfiguration.class)
@EnableScheduling
public class Main {
    public static void main(String[] args) throws Exception {
        if (args.length == 1 && args[0].equals("--health")) {
            int port = Integer.parseInt(env("QWORK_PORT", env("PORT", "8787")));
            try (var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build()) {
                var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/health"))
                    .timeout(Duration.ofSeconds(3)).build();
                if (client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode() != 200) {
                    System.exit(1);
                }
            }
            return;
        }
        if (!env("RENDER_SERVICE_ID", "").isBlank() && !Db.postgres()) {
            throw new IllegalStateException("Set QWORK_DATABASE_URL to PostgreSQL on Render.");
        }
        Db.initialize();
        SpringApplication.run(Main.class, args);
    }

    @Bean
    ThreadPoolTaskScheduler taskScheduler() {
        var scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(2);
        return scheduler;
    }

    @Scheduled(initialDelay = 5000, fixedDelay = 30000)
    void runPlanning() {
        try (var db = Db.connect(true)) {
            Planning.tick(db);
            db.commit();
        } catch (Exception error) {
            System.err.printf("qwork plan generation failure: %s%n", error.getClass().getSimpleName());
        }
        try {
            List<Long> companies;
            try (var db = Db.connect(false)) {
                companies = AutoAssignment.dueCompanies(db);
            }
            for (long company : companies) {
                try (var db = Db.connect(true)) {
                    AutoAssignment.runCompany(db, company);
                    db.commit();
                } catch (Exception error) {
                    System.err.printf("qwork automatic assignment failure: %s%n", error.getClass().getSimpleName());
                }
            }
        } catch (Exception error) {
            System.err.printf("qwork assignment scan failure: %s%n", error.getClass().getSimpleName());
        }
    }

    @Scheduled(initialDelay = 5000, fixedDelay = 15000)
    void runIncidentPush() {
        IncidentPush.run();
    }

    private static String env(String name, String fallback) {
        return System.getenv().getOrDefault(name, fallback);
    }
}
