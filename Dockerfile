# workspace-status-mcp у контейнері: MCP-сервер по stdio (docker run -i). Потрібен
# каталогам MCP (m8ven, Glama тощо), які збирають образ і перевіряють,
# що сервер стартує й віддає список інструментів.
FROM node:22-bookworm-slim
# git + gh: інструменти читають стан репозиторіїв і GitHub Actions.
# Авторизація gh - через змінну GH_TOKEN при docker run.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git gh \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

ENTRYPOINT ["node", "src/server.js"]
