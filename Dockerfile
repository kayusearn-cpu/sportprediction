FROM node:18-slim

# Install Python + pip
RUN apt-get update && apt-get install -y python3 python3-pip curl unzip && \
    pip3 install --no-cache-dir -r requirements.txt

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
