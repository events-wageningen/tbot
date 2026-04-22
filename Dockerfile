FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ ./src/
COPY tsconfig.json ./
CMD ["npx", "tsx", "src/index.ts"]
