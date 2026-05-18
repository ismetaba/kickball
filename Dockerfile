FROM node:20-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --production
COPY server/ ./server/
COPY shared/ ./shared/
WORKDIR /app/server
EXPOSE 8080
CMD ["node", "server.js"]
