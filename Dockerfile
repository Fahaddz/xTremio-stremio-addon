# Lightweight production image
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=192

COPY package*.json ./

RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY index.js ./

USER node

EXPOSE 3000

CMD ["node", "index.js"]
