FROM node:20-bookworm-slim

WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev

COPY src /app/src
COPY public /app/public
COPY scripts /app/scripts
RUN chmod +x /app/scripts/*.sh

ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
