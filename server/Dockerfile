FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV DATA_DIR=/data

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "src/index.js"]
