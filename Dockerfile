FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data TRUST_PROXY=1 COOKIE_SECURE=1
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
