FROM grafana/k6:latest AS k6

FROM node:22-alpine
RUN sed -i 's/https:/http:/' /etc/apk/repositories && apk add --no-cache ca-certificates
COPY --from=k6 /usr/bin/k6 /usr/bin/k6
WORKDIR /app
COPY runner/server.mjs /app/server.mjs
EXPOSE 8788
CMD ["node", "/app/server.mjs"]
