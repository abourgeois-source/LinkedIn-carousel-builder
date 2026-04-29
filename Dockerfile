FROM mcr.microsoft.com/playwright:v1.55.1-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:web

ENV NODE_ENV=production
EXPOSE 4173

CMD ["npm", "run", "start:web"]
