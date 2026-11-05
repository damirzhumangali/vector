FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY pom.xml invite.js ./
COPY migrations/ migrations/
COPY src/ src/
RUN mvn -B -q package

FROM eclipse-temurin:21-jre-jammy
RUN apt-get update \
    && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core webp \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --user-group --no-create-home qwork \
    && mkdir -p /var/lib/qwork \
    && chown qwork:qwork /var/lib/qwork
WORKDIR /app
COPY --from=build /build/target/qwork-api.jar .
ENV QWORK_HOST=0.0.0.0 \
    QWORK_DB=/var/lib/qwork/qwork.sqlite3
USER qwork
EXPOSE 8787
CMD ["java", "-jar", "qwork-api.jar"]
